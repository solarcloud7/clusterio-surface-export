
import fs from "fs/promises";
import { safeOutputFile } from "@clusterio/lib";
import { enqueueWrite } from "./persist-queue";
import { buildAuditRow } from "./audit-ledger";
import { selectRetainedDetail, MIN_DETAIL_ENTRIES, MAX_DETAIL_ENTRIES } from "./detail-retention";
import type { IControllerPlugin, ActiveTransfer, PersistedTransactionLog, TransactionLogEntryModel } from "../messages";
import { getErrorMessage, PLUGIN_NAME } from "../helpers";

/**
 * Transaction logging, phase timing, persistence, and transfer summary building.
 * Owns the transactionLogs Map and persistedTransactionLogs array on the plugin.
 */
export class TransactionLogger {
	private plugin: IControllerPlugin;

	constructor(plugin: IControllerPlugin) {
		this.plugin = plugin;
	}

	buildTransferInfo(transfer: ActiveTransfer) {
		return {
			transferId: transfer.transferId,
			operationType: transfer.operationType || "transfer",
			exportId: transfer.exportId,
			artifactSizeBytes: transfer.artifactSizeBytes ?? null,
			platformName: transfer.platformName,
			platformIndex: transfer.platformIndex,
			forceName: transfer.forceName,
			sourceInstanceId: transfer.sourceInstanceId,
			sourceInstanceName: transfer.sourceInstanceName || this.plugin.platformTree.resolveInstanceName(transfer.sourceInstanceId),
			targetInstanceId: transfer.targetInstanceId,
			targetInstanceName: transfer.targetInstanceName || this.plugin.platformTree.resolveInstanceName(transfer.targetInstanceId),
			status: transfer.status,
			startedAt: transfer.startedAt || null,
			completedAt: transfer.completedAt || null,
			failedAt: transfer.failedAt || null,
			error: transfer.error || null,
		};
	}

	getLastEventTimestamp(transferId: string) {
		const events = this.plugin.transactionLogs.get(transferId);
		if (!events || !events.length) {
			return null;
		}
		return events[events.length - 1].timestampMs || null;
	}

	buildTransferSummary(transferId: string, transfer: ActiveTransfer, lastEventAt: number | null = null) {
		const info = this.buildTransferInfo(transfer);
		const storedExport = info.exportId ? this.plugin.platformStorage.get(info.exportId) : null;
		// Artifact size fallback chain: transfer field → stored export → payload metrics estimate
		const artifactSizeBytes = info.artifactSizeBytes
			?? storedExport?.size
			?? (typeof transfer?.payloadMetrics?.payloadSizeKB === "number"
				? Math.round(transfer.payloadMetrics.payloadSizeKB * 1024)
				: null);
		const downloadable = Boolean(storedExport?.exportData);
		return {
			transferId,
			operationType: info.operationType,
			exportId: info.exportId || null,
			artifactSizeBytes,
			downloadable,
			platformName: info.platformName,
			sourceInstanceId: info.sourceInstanceId,
			sourceInstanceName: info.sourceInstanceName,
			targetInstanceId: info.targetInstanceId,
			targetInstanceName: info.targetInstanceName,
			status: info.status,
			startedAt: info.startedAt || Date.now(),
			completedAt: info.completedAt,
			failedAt: info.failedAt,
			error: info.error,
			lastEventAt,
		};
	}

	formatDuration(durationMs: number | null) {
		if (typeof durationMs !== "number" || Number.isNaN(durationMs)) {
			return null;
		}
		if (durationMs >= 1000) {
			return `${(durationMs / 1000).toFixed(1)}s`;
		}
		return `${Math.round(durationMs)}ms`;
	}

	resolveTransferResult(status: string) {
		if (status === "completed") {
			return "SUCCESS";
		}
		if (["failed", "error", "cleanup_failed"].includes(status)) {
			return "FAILED";
		}
		return "IN_PROGRESS";
	}

	buildPhaseSummary(transfer: ActiveTransfer) {
		const phaseSummary: Record<string, number> = {};
		if (!transfer?.phases) {
			return phaseSummary;
		}
		for (const [name, phase] of Object.entries(transfer.phases)) {
			if ((phase as { durationMs?: number })?.durationMs !== undefined) {
				phaseSummary[`${name}Ms`] = (phase as { durationMs: number }).durationMs;
			}
		}
		return phaseSummary;
	}

	buildDetailedTransferSummary(transferId: string, transfer: ActiveTransfer, lastEventAt: number | null = null) {
		const info = this.buildTransferInfo(transfer);
		const endAt = info.completedAt || info.failedAt || lastEventAt || Date.now();
		const durationMs = info.startedAt ? Math.max(0, endAt - info.startedAt) : null;
		const validation = transfer.validationResult || null;
		// Fall back to validation expected counts if no explicit source verification was recorded
		let sourceVerification = transfer.sourceVerification || null;
		if (!sourceVerification && validation) {
			sourceVerification = {
				itemCounts: validation.expectedItemCounts || {},
				fluidCounts: validation.expectedFluidCounts || {},
			};
		}

		return {
			transferId,
			operationType: info.operationType,
			result: this.resolveTransferResult(info.status),
			status: info.status,
			totalDurationMs: durationMs,
			totalDurationStr: this.formatDuration(durationMs),
			phases: this.buildPhaseSummary(transfer),
			platform: {
				name: info.platformName,
				// Unique per-force index — disambiguates collidable platform names (e.g. two "test" surfaces)
				// in the Transfer Details. Names are display-only; the index is the identity.
				index: info.platformIndex ?? null,
				source: {
					instanceId: info.sourceInstanceId,
					instanceName: info.sourceInstanceName,
				},
				destination: {
					instanceId: info.targetInstanceId,
					instanceName: info.targetInstanceName,
				},
			},
			export: transfer.exportMetrics || null,
			payload: transfer.payloadMetrics || null,
			import: transfer.importMetrics || null,
			validation,
			sourceVerification,
			startedAt: info.startedAt,
			completedAt: info.completedAt,
			failedAt: info.failedAt,
			lastEventAt,
			error: info.error || null,
		};
	}

	/**
	 * Merge active (in-memory) and persisted (on-disk) transfers into one list, active taking priority.
	 *
	 * Each summary is stamped with `registrySource`, and that stamp is load-bearing: this merge is a
	 * strict SUPERSET of what the retry guard actually consults. `transferPlatform` refuses a
	 * same-ID retry based on `activeTransfers` ALONE (transfer-orchestrator.ts:89-118), while
	 * `persistedTransactionLogs` is reloaded from disk at every controller boot
	 * (loadTransactionLogs). So the advertised remedy for a colliding ID — restart the controller —
	 * clears the half that refuses and RELOADS the half that does not.
	 *
	 * Without the stamp the two branches emit identical key sets, so a caller asking "would this ID
	 * be refused?" cannot tell a live blocker from a historical record, and a preflight built on it
	 * would keep reporting a collision forever after the remedy was correctly applied. Optional on
	 * the model so an un-redeployed controller degrades to "provenance unknown" rather than lying.
	 */
	getTransferSummaries(limit = 50) {
		const byId = new Map();

		// Active transfers are inserted first so they win over persisted duplicates
		for (const [transferId, transfer] of this.plugin.activeTransfers) {
			byId.set(transferId, {
				...this.buildTransferSummary(
					transferId,
					transfer,
					this.getLastEventTimestamp(transferId),
				),
				// Stamped HERE, not inside buildTransferSummary: that helper also builds the payload for
				// SurfaceExportTransferUpdateEvent, where an entry is active by construction and the
				// field would be noise on the wire.
				registrySource: "active" as const,
			});
		}

		// Historical half comes from the AUDIT LEDGER, not the detail store. The two agree today, but
		// they are about to diverge on purpose: the detail store becomes a bounded window, while the
		// ledger keeps one row per transfer for good. Reading the list from the ledger is what makes
		// that bounding safe — trim the detail store and the transfer still appears here, which is the
		// whole point of "see every transfer".
		//
		// registrySource stays "persisted" rather than gaining a third value. Its definition — the
		// retry guard never reads it, so an ID appearing only here is history rather than a blocker —
		// is true of a ledger row in every clause. A new value would also be routed to a loud
		// POSSIBLE-COLLISION warning by the gallery preflight, which treats anything it does not
		// recognise as unknown provenance.
		for (const row of this.plugin.auditIndex.values()) {
			if (!byId.has(row.transferId)) {
				byId.set(row.transferId, {
					transferId: row.transferId,
					operationType: row.operationType ?? "transfer",
					exportId: row.exportId || null,
					artifactSizeBytes: row.artifactSizeBytes ?? null,
					downloadable: false,
					platformName: row.platformName || "Unknown",
					sourceInstanceId: row.sourceInstanceId ?? -1,
					sourceInstanceName: row.sourceInstanceName ?? null,
					targetInstanceId: row.targetInstanceId ?? -1,
					targetInstanceName: row.targetInstanceName ?? null,
					status: row.status || "unknown",
					startedAt: row.startedAt || row.savedAt || Date.now(),
					completedAt: row.completedAt || null,
					failedAt: row.failedAt || null,
					error: row.error || null,
					lastEventAt: row.lastEventAt ?? null,
					registrySource: "persisted" as const,
					/** How many distinct verdicts this transfer recorded; >1 means a late verdict landed. */
					// `?? 0`, not 1: countRevisions counts TERMINAL rows only, and a start-only row now
					// reaches this index. Defaulting to 1 claimed a verdict for a transfer that had
					// recorded none — which is exactly the interrupted case start rows exist to expose.
					revisions: this.plugin.auditRevisions.get(row.transferId) ?? 0,
				});
			}
		}

		// SAFETY NET, not a second source of truth. In a healthy cluster every detail entry has a ledger
		// row, so this pass adds nothing and costs one Map lookup per retained entry (bounded by
		// transaction_log_detail_entries, default 100).
		//
		// It earns its place on two failure paths that otherwise erase history the plugin still holds:
		//   - loadAuditIndex catching — most reachably migrateAuditLedger's WRITE failing, since
		//     loadAuditLedger already swallows ENOENT and per-line damage — leaves an EMPTY index, and
		//     without this pass the list showed nothing but in-flight transfers while a full detail
		//     store sat on disk.
		//   - recordAuditRow catching leaves one transfer with a detail entry and no row. That transfer
		//     vanished from the list the moment pruneOldTransfers dropped it from activeTransfers.
		//
		// Reading the detail store SECOND is what keeps #166's guarantee intact: the ledger still wins
		// every disagreement, and a transfer trimmed out of the detail window still appears from its row.
		for (const persistedLog of this.plugin.persistedTransactionLogs) {
			if (byId.has(persistedLog.transferId)) {
				continue;
			}
			const transferInfo = persistedLog.transferInfo || {};
			const events = Array.isArray(persistedLog.events) ? persistedLog.events : [];
			const lastEvent = events.length ? events[events.length - 1] : null;
			byId.set(persistedLog.transferId, {
				transferId: persistedLog.transferId,
				operationType: transferInfo.operationType ?? "transfer",
				exportId: transferInfo.exportId || null,
				artifactSizeBytes: transferInfo.artifactSizeBytes ?? null,
				downloadable: false,
				platformName: transferInfo.platformName || "Unknown",
				sourceInstanceId: transferInfo.sourceInstanceId ?? -1,
				sourceInstanceName: transferInfo.sourceInstanceName ?? null,
				targetInstanceId: transferInfo.targetInstanceId ?? -1,
				targetInstanceName: transferInfo.targetInstanceName ?? null,
				status: transferInfo.status || "unknown",
				startedAt: transferInfo.startedAt || persistedLog.savedAt || Date.now(),
				completedAt: transferInfo.completedAt || null,
				failedAt: transferInfo.failedAt || null,
				error: transferInfo.error || null,
				lastEventAt: lastEvent?.timestampMs || null,
				// Same value as the ledger half, for the same reason: the retry guard reads neither, so
				// an ID reaching the list only from here is history rather than a live blocker. A third
				// value would also trip the gallery preflight's unknown-provenance warning.
				registrySource: "persisted" as const,
				// No ledger row means no terminal row was ever counted. Claiming 1 here would assert a
				// verdict this transfer has no durable evidence of.
				revisions: this.plugin.auditRevisions.get(persistedLog.transferId) ?? 0,
			});
		}

		// Enrich all summaries with current platformStorage state (export may have been
		// uploaded or deleted since the summary was built or persisted)
		return Array.from(byId.values())
			.map(summary => {
				const storedExport = summary.exportId ? this.plugin.platformStorage.get(summary.exportId) : null;
				return {
					...summary,
					artifactSizeBytes: summary.artifactSizeBytes ?? storedExport?.size ?? null,
					downloadable: Boolean(storedExport?.exportData),
				};
			})
			.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
			.slice(0, limit);
	}

	logTransactionEvent(transferId: string, eventType: string, message: string, data: Record<string, unknown> = {}) {
		if (!this.plugin.transactionLogs.has(transferId)) {
			this.plugin.transactionLogs.set(transferId, []);
		}

		const now = Date.now();
		const events = this.plugin.transactionLogs.get(transferId) || [];
		if (!this.plugin.transactionLogs.has(transferId)) {
			this.plugin.transactionLogs.set(transferId, events);
		}
		const transfer = this.plugin.activeTransfers.get(transferId);

		const elapsedMs = transfer?.startedAt ? now - transfer.startedAt : 0;
		const lastEvent = events.length > 0 ? events[events.length - 1] : null;
		const deltaMs = lastEvent?.timestampMs ? now - lastEvent.timestampMs : 0;

		const event = {
			timestamp: new Date(now).toISOString(),
			timestampMs: now,
			elapsedMs,
			deltaMs,
			eventType,
			message,
			...data,
		};

		events.push(event);
		this.plugin.logger.info(`[Transaction ${transferId}] +${elapsedMs}ms ${eventType}: ${message}`);
		this.plugin.subscriptions.emitLogUpdate(transferId, event);
	}

	startPhase(transferId: string, phaseName: string) {
		const transfer = this.plugin.activeTransfers.get(transferId);
		if (transfer) {
			if (!transfer.phases) transfer.phases = {};
			transfer.phases[phaseName] = { startMs: Date.now() };
		}
	}

	endPhase(transferId: string, phaseName: string) {
		const transfer = this.plugin.activeTransfers.get(transferId);
		if (transfer?.phases?.[phaseName]) {
			const phase = transfer.phases[phaseName];
			phase.endMs = Date.now();
			phase.durationMs = phase.endMs - phase.startMs;
			return phase.durationMs;
		}
		return 0;
	}

	/**
	 * Rotate a finished operation's record out of a transferId that a NEW operation is about to
	 * reuse. Save resets restart the source's export counter, so recycled ids are routine on the
	 * dev cluster; left alone, the new operation appends events onto the old operation's in-memory
	 * array and its persist overwrites the old detail entry in place — history silently rewritten,
	 * and `latest` ordering lies. The old entry keeps its history under `<transferId>@<savedAt>`;
	 * the live id starts clean and always means the current operation.
	 * Call before registering the new operation in activeTransfers.
	 */
	async archiveRecycledTransferId(transferId: string, startedAt: number | null | undefined) {
		const existing = this.plugin.persistedTransactionLogs.find(
			(log: PersistedTransactionLog) => log.transferId === transferId,
		);
		// Same operation re-registering keeps its record. A falsy startedAt cannot distinguish
		// same-op from recycled, and self-archiving a LIVE operation (renaming its record and
		// truncating its event stream) is worse than a rare merge — so missing startedAt refuses
		// to archive.
		if (existing && (!startedAt
			|| (existing.transferInfo && existing.transferInfo.startedAt === startedAt))) {
			return;
		}
		if (existing) {
			const archivalId = `${transferId}@${existing.savedAt || Date.now()}`;
			existing.transferId = archivalId;
			if (existing.transferInfo) {
				existing.transferInfo.transferId = archivalId;
			}
			if (existing.summary) {
				existing.summary.transferId = archivalId;
			}
			// The archived record needs a ledger row under its new id: without one, retention's
			// isPinned treats it as "only surviving evidence" and keeps it FOREVER (crowding real
			// timelines out of the bounded window), and the list shows revisions:0 — "no verdict
			// evidence" — for an operation that recorded one.
			await this.plugin.recordAuditRow(buildAuditRow({
				transferId: archivalId,
				rowKind: "terminal",
				savedAt: existing.savedAt || Date.now(),
				eventCount: (existing.events || []).length,
				lastEventAt: null,
				info: existing.transferInfo,
			}));
			this.plugin.logger.info(
				`[Transaction ${transferId}] id recycled by a new operation — prior record archived as ${archivalId}`,
			);
		}
		// Stale in-memory events under this id would otherwise MERGE into the new operation's
		// stream (logTransactionEvent reuses an existing array).
		this.plugin.transactionLogs.delete(transferId);
	}

	async persistTransactionLog(transferId: string) {
		try {
			const events = this.plugin.transactionLogs.get(transferId);
			const transfer = this.plugin.activeTransfers.get(transferId);

			if (!events || !transfer) return;

			// The boot load is the gate now, not a re-read on every write.
			//
			// This used to read + parse the ENTIRE file before every write purely to detect corruption
			// — 7.62 MB and 17 ms to add ~9 KB, and the in-memory array it then discarded was already
			// authoritative. The protection it bought is preserved by refusing when the BOOT load
			// failed; what it gives up is detecting corruption introduced by something outside this
			// process mid-session. That trade is only acceptable because the audit ledger now exists:
			// every transfer keeps a row there, so a damaged detail store is a loss of timelines, not
			// a loss of history.
			if (this.plugin.transactionLogLoadError) {
				this.plugin.logger.error(
					`Refusing to write ${this.plugin.transactionLogPath}: the startup load failed `
					+ `(${this.plugin.transactionLogLoadError}) and the file is being preserved as-is. `
					+ "Transfers are still recorded in the audit ledger, so no transfer is being lost — "
					+ "only its detail. Repair or move the file aside and restart the controller.",
				);
				return;
			}

			const transferInfo = this.buildTransferInfo(transfer);
			const summary = this.buildDetailedTransferSummary(transferId, transfer, this.getLastEventTimestamp(transferId));
			const entry = {
				transferId,
				transferInfo,
				summary,
				// A SNAPSHOT, not the live array. `events` is the same array the transactionLogs Map
				// holds and logTransactionEvent keeps pushing to, so storing it by reference let the
				// already-persisted entry keep growing in memory — the in-memory history then disagreed
				// with the bytes on disk for the same transfer.
				events: [...events],
				savedAt: Date.now(),
			};

			// ── SYNCHRONOUS SECTION: read, upsert, retain and PUBLISH with no await in between ──
			//
			// Every statement from here to the assignment must stay synchronous. Two transfers can
			// resolve at once, and an await anywhere in this window lets both snapshot the same
			// pre-state: each then writes a payload missing the other's entry, the later write wins,
			// and one transfer's detail is silently absent from the file. pruneTransactionLogsMap
			// below would then delete that transfer's in-memory events too — because it is neither
			// active nor retained — while the ledger carries a terminal row claiming a verdict for it.
			//
			// This is not theoretical: the ledger append below is an awaited fs.appendFile chained
			// behind a shared write queue, so it is a guaranteed yield point. It used to sit ABOVE
			// this snapshot.
			const allLogs = [...this.plugin.persistedTransactionLogs];
			const existingIndex = allLogs.findIndex((log: PersistedTransactionLog) => log.transferId === transferId);
			if (existingIndex !== -1) {
				allLogs.splice(existingIndex, 1, entry);
			} else {
				allLogs.push(entry);
			}
			const retained = this.applyDetailRetention(allLogs);
			this.plugin.persistedTransactionLogs = retained;
			this.pruneTransactionLogsMap(retained);
			// ── end synchronous section ──

			// LEDGER FIRST, detail file second. Retention can delete a detail entry, and the ledger row
			// is what survives — so a detail entry must never reach disk without its row. Ordered this
			// way a crash between the two loses a timeline; reversed, it would lose the record that the
			// transfer happened at all.
			await this.plugin.recordAuditRow(buildAuditRow({
				transferId,
				rowKind: "terminal",
				savedAt: entry.savedAt,
				eventCount: entry.events.length,
				lastEventAt: this.getLastEventTimestamp(transferId),
				info: transferInfo,
			}));

			await enqueueWrite(this.plugin.transactionLogPath,
				() => safeOutputFile(this.plugin.transactionLogPath, JSON.stringify(retained, null, 2)));
		} catch (err: unknown) {
			this.plugin.logger.error(`Failed to persist transaction log: ${getErrorMessage(err)}`);
		}
	}

	/**
	 * Apply the retained-detail window. Split out so the policy is testable on its own and so the
	 * config read has exactly one home.
	 */
	applyDetailRetention(entries: PersistedTransactionLog[]): PersistedTransactionLog[] {
		const raw = this.plugin.controller.config?.get(`${PLUGIN_NAME}.transaction_log_detail_entries`);
		// An ABSENT field (un-migrated controller) keeps everything: deleting detail because a lookup
		// returned undefined is the worst available reading of a missing setting.
		//
		// A PRESENT but out-of-range number is CLAMPED and logged, rather than reinterpreted. Zero used
		// to fall into the "absent" branch, so an operator typing 0 to mean "keep no detail" silently
		// got "keep everything, unbounded" — the exact problem this cap exists to fix, re-armed by a
		// plausible input with no warning. The sibling timeout field clamps its range the same way.
		const configured = Number(raw);
		if (raw === undefined || raw === null || !Number.isFinite(configured)) {
			return selectRetainedDetail(entries, { cap: 0, isPinned: () => false });
		}
		const cap = Math.min(MAX_DETAIL_ENTRIES, Math.max(MIN_DETAIL_ENTRIES, Math.floor(configured)));
		if (cap !== configured) {
			this.plugin.logger.warn(
				`${PLUGIN_NAME}.transaction_log_detail_entries is ${configured}; using ${cap} `
				+ `(allowed range ${MIN_DETAIL_ENTRIES}-${MAX_DETAIL_ENTRIES}).`,
			);
		}
		return selectRetainedDetail(entries, {
			cap,
			isPinned: entry => {
				// An entry with NO ledger row is the only surviving evidence that transfer happened —
				// recordAuditRow logs its failures and returns, so the detail file can outlive its row.
				// Evicting it destroys the record rather than a timeline, which is the one thing the
				// ledger was built to make impossible.
				//
				// Deliberately a preference inside its class, NOT a class of its own: a sustained ledger
				// outage would mark every entry, and a class that can cover the whole window is exactly
				// the failure `selectRetainedDetail` documents at the pinned-tiebreak comment. So this
				// buys ordering, never a guarantee — the durable fix for a broken ledger is to fix the
				// ledger, and recordAuditRow says so at error level.
				if (!this.plugin.auditIndex.has(entry.transferId)) {
					return true;
				}
				return Boolean(
					entry.transferInfo?.exportId
					&& this.plugin.platformStorage.get(entry.transferInfo.exportId)?.exportData,
				);
			},
		});
	}

	/**
	 * Drop in-memory event arrays nothing can still reach.
	 *
	 * `transactionLogs` was never pruned — one entry per transfer for the life of the process, each
	 * holding every event, aliased into the persisted array. Keep only what is still reachable: live
	 * transfers, and transfers whose detail is retained on disk. Both are capped, so the Map is now
	 * bounded too.
	 */
	pruneTransactionLogsMap(retained: PersistedTransactionLog[]) {
		// Absence from activeTransfers does NOT mean finished: pruneOldTransfers evicts by startedAt
		// past 100 entries with no in-flight check. A transfer still awaiting validation can therefore
		// be missing from activeTransfers AND have no detail entry yet (persist runs only at terminal
		// resolution) — dropping its events mid-flight would silently truncate the timeline it is still
		// writing. A ledger row that is still `start` is the durable "has not resolved" signal.
		const unresolved = [...this.plugin.auditIndex.values()]
			.filter(row => row.rowKind === "start")
			.map(row => row.transferId);
		const reachable = new Set<string>([
			...this.plugin.activeTransfers.keys(),
			...retained.map(entry => entry.transferId),
			...unresolved,
		]);
		for (const transferId of [...this.plugin.transactionLogs.keys()]) {
			if (!reachable.has(transferId)) {
				this.plugin.transactionLogs.delete(transferId);
			}
		}
	}

	async loadTransactionLogs() {
		try {
			const content = await fs.readFile(this.plugin.transactionLogPath, "utf8");
			const logs = JSON.parse(content);
			if (!Array.isArray(logs)) {
				// Parsing successfully is NOT the same as being usable. A file holding an object (a
				// partial hand-edit, or a tool writing the wrong shape) used to be coerced to [] with no
				// latch, which left the write gate open so the next transfer overwrote the original
				// contents entirely. The removed pre-write re-read used to catch this by throwing on
				// `.findIndex`; the gate has to catch it now.
				this.plugin.persistedTransactionLogs = [];
				this.plugin.transactionLogLoadError = `expected a JSON array, found ${typeof logs}`;
				this.plugin.logger.error(
					`Transaction history at ${this.plugin.transactionLogPath} is valid JSON but is not an array `
					+ `(found ${typeof logs}). The file is being preserved as-is and detail writes are disabled `
					+ "for this session; transfers are still recorded in the audit ledger. Repair or move the "
					+ "file aside and restart the controller.",
				);
				return;
			}
			this.plugin.persistedTransactionLogs = logs;
			this.plugin.transactionLogLoadError = null;
			this.plugin.logger.info(`Loaded ${this.plugin.persistedTransactionLogs.length} transaction logs`);
		} catch (err: unknown) {
			if ((err as { code?: string }).code === "ENOENT") {
				this.plugin.persistedTransactionLogs = [];
				this.plugin.transactionLogLoadError = null;
				return;
			}
			// Latched for the session: persistTransactionLog reads this instead of re-reading the file
			// before every write.
			this.plugin.transactionLogLoadError = getErrorMessage(err);
			this.plugin.logger.error(
				`Failed to load transaction history from ${this.plugin.transactionLogPath}: ${getErrorMessage(err)}. `
				+ "The file was left untouched; the Transaction Logs tab will appear empty this session. "
				+ "Restore from a backup, or repair or move the file aside, then restart the controller to recover the history.",
			);
		}
	}
}
