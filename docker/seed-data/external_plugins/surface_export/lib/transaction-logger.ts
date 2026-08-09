import fs from "fs/promises";
import { safeOutputFile } from "@clusterio/lib";
import { enqueueWrite } from "./persist-queue";
import { buildAuditRow } from "./audit-ledger";
import { selectRetainedDetail, MIN_DETAIL_ENTRIES, MAX_DETAIL_ENTRIES } from "./detail-retention";
import type { IControllerPlugin, ActiveTransfer, PersistedTransactionLog, TransactionLogEntryModel } from "../messages";
import { getErrorMessage, PLUGIN_NAME } from "../helpers";

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

	getTransferSummaries(limit = 50) {
		const byId = new Map();

		for (const [transferId, transfer] of this.plugin.activeTransfers) {
			byId.set(transferId, {
				...this.buildTransferSummary(
					transferId,
					transfer,
					this.getLastEventTimestamp(transferId),
				),
				registrySource: "active" as const,
			});
		}

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
					revisions: this.plugin.auditRevisions.get(row.transferId) ?? 0,
				});
			}
		}

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
				registrySource: "persisted" as const,
				revisions: this.plugin.auditRevisions.get(persistedLog.transferId) ?? 0,
			});
		}

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

	async archiveRecycledTransferId(transferId: string, startedAt: number | null | undefined) {
		const existing = this.plugin.persistedTransactionLogs.find(
			(log: PersistedTransactionLog) => log.transferId === transferId,
		);
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
		this.plugin.transactionLogs.delete(transferId);
	}

	async persistTransactionLog(transferId: string) {
		try {
			const events = this.plugin.transactionLogs.get(transferId);
			const transfer = this.plugin.activeTransfers.get(transferId);

			if (!events || !transfer) return;

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
				events: [...events],
				savedAt: Date.now(),
			};

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

	applyDetailRetention(entries: PersistedTransactionLog[]): PersistedTransactionLog[] {
		const raw = this.plugin.controller.config?.get(`${PLUGIN_NAME}.transaction_log_detail_entries`);
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

	pruneTransactionLogsMap(retained: PersistedTransactionLog[]) {
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
			this.plugin.transactionLogLoadError = getErrorMessage(err);
			this.plugin.logger.error(
				`Failed to load transaction history from ${this.plugin.transactionLogPath}: ${getErrorMessage(err)}. `
				+ "The file was left untouched; the Transaction Logs tab will appear empty this session. "
				+ "Restore from a backup, or repair or move the file aside, then restart the controller to recover the history.",
			);
		}
	}
}
