import fs from "fs/promises";
import { safeOutputFile } from "@clusterio/lib";
import { enqueueWrite } from "./persist-queue";
import { buildAuditRow } from "./audit-ledger";
import { selectRetainedDetail, MIN_DETAIL_ENTRIES, MAX_DETAIL_ENTRIES } from "./detail-retention";
import type { IControllerPlugin, ActiveTransfer, StoredExport, PersistedTransactionLog, TransactionLogEntryModel } from "../messages";
import { TimingClock } from "./timing";
import { mergeTiming, type TimingRecord, type OperationTiming } from "../shared/timing";
import { getErrorMessage, PLUGIN_NAME } from "../helpers";

export class TransactionLogger {
	private plugin: IControllerPlugin;
	private clocks = new Map<string, TimingClock>();
	private spans = new Map<string, TimingRecord>();
	private pendingTiming = new Map<string, { record: TimingRecord; received: number }>();
	private timingWrites = new Map<string, ReturnType<typeof setTimeout>>();
	private isArtifactTiming(record: TimingRecord, stored: StoredExport): boolean {
		return (record.owner === "source-lua" && record.instanceId === stored.instanceId && record.exportId === stored.sourceExportId)
			|| (record.owner === "controller" && record.operationId === stored.exportId && record.stage.startsWith("Artifact "));
	}

	clock(id: string): TimingClock {
		let clock = this.clocks.get(id);
		if (!clock) {
			if (this.clocks.size >= 1000) {
				for (const key of this.clocks.keys()) {
					const active = this.plugin.activeTransfers.get(key);
					if (active && !["completed", "failed", "error", "cleanup_failed"].includes(active.status)) continue;
					this.clocks.delete(key);
					for (const spanKey of this.spans.keys()) if (spanKey.startsWith(`${key}:`)) this.spans.delete(spanKey);
					this.plugin.logger.warn(`Released retained timing clock ${key}; any later handler uses a new local clock`);
					break;
				}
			}
			clock = new TimingClock(id, "controller", record => this.acceptTiming(record));
			this.clocks.set(id, clock);
		}
		return clock;
	}

	beginObservation(id: string) {
		const previous = this.spans.get(`${id}:operation`);
		if (previous && previous.status !== "running") {
			this.clocks.delete(id);
			for (const key of this.spans.keys()) if (key.startsWith(`${id}:`)) this.spans.delete(key);
		}
		const clock = this.clock(id);
		if (!this.spans.has(`${id}:operation`)) this.spans.set(`${id}:operation`, clock.start("Observed operation", "inclusive"));
		return clock;
	}

	bindObservation(from: string, to: string) {
		const clock = this.clocks.get(from);
		if (!clock) return;
		this.clocks.delete(from);
		this.clocks.set(to, clock);
		const span = this.spans.get(`${from}:operation`);
		if (span) { this.spans.delete(`${from}:operation`); this.spans.set(`${to}:operation`, span); }
		clock.bind(to);
	}

	async rejectObservation(id: string, request: Record<string, unknown>, error: string) {
		const bound = [...this.clocks.values()].find(clock => clock.jobId === id);
		if (bound?.operationId && !this.clocks.has(id)) id = bound.operationId;
		if (this.plugin.activeTransfers.has(id)) return;
		const clock = this.clocks.get(id), root = this.spans.get(`${id}:operation`);
		if (!clock || !root) return;
		const kind = request.operationType === "import" || request.operationType === "export" ? request.operationType : "transfer";
		clock.stop(root, "failed");
		const timing: OperationTiming = { v: 1, records: [] };
		for (const [key, { record }] of this.pendingTiming) {
			if (record.operationId !== id && record.clockId !== clock.clockId) continue;
			timing.records.push(record); this.pendingTiming.delete(key);
		}
		// A rejected request may not identify any platform. It is evidence, never an executable transfer record.
		const info = {
			transferId: id, operationType: kind, platformName: `platform #${request.sourcePlatformIndex ?? "unknown"}`,
			sourceInstanceId: Number(request.sourceInstanceId) || -1,
			targetInstanceId: Number(request.targetInstanceId) || -1, status: "failed",
			error, startedAt: clock.startedAtUtc, failedAt: Date.now(),
			observedDurationMs: root.endMs! - root.startMs!,
		} satisfies PersistedTransactionLog["transferInfo"];
		const entry = { transferId: id, transferInfo: info,
			summary: { ...info, timing, totalDurationMs: info.observedDurationMs,
				timingBoundary: "Controller observation of a rejected request; no active operation record was created." },
			events: [], savedAt: Date.now() };
		this.plugin.persistedTransactionLogs = this.applyDetailRetention([...this.plugin.persistedTransactionLogs, entry]);
		await this.plugin.recordAuditRow(buildAuditRow({ transferId: id, rowKind: "terminal", savedAt: entry.savedAt,
			eventCount: 0, lastEventAt: info.failedAt, info }));
		if (!this.plugin.transactionLogLoadError) await enqueueWrite(this.plugin.transactionLogPath,
			() => safeOutputFile(this.plugin.transactionLogPath, JSON.stringify(this.plugin.persistedTransactionLogs, null, 2)));
	}

	getObservedDuration(transfer: ActiveTransfer): number | null {
		this.finishObservation(transfer);
		return transfer.observedDurationMs ?? null;
	}

	private finishObservation(transfer: ActiveTransfer) {
		if (transfer.timingPendingRecovery) return;
		if (transfer.observedDurationMs !== undefined) return;
		if (!["completed", "failed", "error", "cleanup_failed"].includes(transfer.status)) return;
		const clock = this.clocks.get(transfer.transferId);
		const span = this.spans.get(`${transfer.transferId}:operation`);
		if (clock && span?.status === "running") {
			clock.stop(span, transfer.status === "completed" ? "completed" : "failed");
			transfer.observedDurationMs = span.endMs! - span.startMs!;
			for (const [key, pending] of this.spans) {
				if (key.startsWith(`${transfer.transferId}:`) && pending.status === "running") clock.stop(pending, "interrupted");
			}
		}
	}

	acceptTiming(record: TimingRecord) {
		if (!record || record.v !== 1 || typeof record.clockId !== "string" || typeof record.id !== "string"
			|| !Number.isSafeInteger(record.revision) || record.revision < 1) {
			this.plugin.logger.warn("Discarded malformed timing record"); return;
		}
		if (record.stage === "runtime_started" && record.instanceId !== undefined) {
			const transfers = [...this.plugin.activeTransfers.values(), ...this.plugin.persistedTransactionLogs
				.filter(entry => !this.plugin.activeTransfers.has(entry.transferId))
				.map(entry => ({ transferId: entry.transferId, timing: entry.summary?.timing as OperationTiming | undefined }))];
			for (const transfer of transfers) {
				if (!transfer.timing) continue;
				let changed = false;
				transfer.timing.records = transfer.timing.records.map(previous => {
					if (previous.instanceId !== record.instanceId || previous.status !== "running") return previous;
					changed = true;
					return { ...previous, status: "interrupted", endMs: null, executionMs: null, error: "Instance restarted before the stage finished" };
				});
				if (changed) this.scheduleTimingWrite(transfer.transferId);
			}
			return;
		}
		const key = `${record.clockId}:${record.id}`;
		let storedMatch = false;
		for (const [id, stored] of this.plugin.platformStorage) {
			if (!this.isArtifactTiming(record, stored)) continue;
			const records = stored.timing?.records ?? [];
			const prior = records.find(value => value.clockId === record.clockId && value.id === record.id);
			if (!prior || prior.revision < record.revision) {
				stored.timing = { v: 1, records: mergeTiming(records, record) };
				this.scheduleTimingWrite(id);
			}
			storedMatch = true;
		}
		const previous = this.pendingTiming.get(key);
		if (!previous || previous.record.revision < record.revision) this.pendingTiming.set(key, { record, received: Date.now() });
		let discarded = 0;
		for (const [id, value] of this.pendingTiming) {
			if (Date.now() - value.received > 300000 || this.pendingTiming.size > 10000) {
				this.pendingTiming.delete(id);
				discarded++;
			}
		}
		if (discarded) this.plugin.logger.warn(`Discarded ${discarded} unmatched timing records (five-minute age or 10000-record limit)`);
		for (const [id, transfer] of this.plugin.activeTransfers) {
			if (this.collectTiming(transfer)) this.scheduleTimingWrite(id);
		}
		for (const entry of this.plugin.persistedTransactionLogs) {
			if (this.plugin.activeTransfers.has(entry.transferId)) continue;
			const transfer = { ...entry.transferInfo, transferId: entry.transferId,
				timing: entry.summary?.timing as OperationTiming | undefined } as ActiveTransfer;
			if (this.collectTiming(transfer)) {
				entry.summary = { ...entry.summary, timing: transfer.timing };
				this.scheduleTimingWrite(entry.transferId);
			}
		}
		if (storedMatch) this.pendingTiming.delete(key);
	}

	private collectTiming(transfer: ActiveTransfer): boolean {
		let changed = false;
		const stored = transfer.exportId ? this.plugin.platformStorage.get(transfer.exportId) : undefined;
		for (const record of stored?.timing?.records ?? []) {
			const prior = transfer.timing?.records.find(value => value.clockId === record.clockId && value.id === record.id);
			if (!prior || prior.revision < record.revision) {
				transfer.timing = { v: 1, records: mergeTiming(transfer.timing?.records ?? [], record) }; changed = true;
			}
		}
		for (const [key, { record }] of this.pendingTiming) {
			const direct = record.operationId === transfer.transferId;
			const sharedArtifact = stored && this.isArtifactTiming(record, stored);
			if (!direct && !sharedArtifact && record.operationId
				&& (this.plugin.activeTransfers.has(record.operationId) || this.plugin.platformStorage.has(record.operationId))) continue;
			const exportMatch = record.exportId && record.instanceId === transfer.sourceInstanceId
				&& (record.exportId === transfer.sourceExportId || `${record.instanceId}:${record.exportId}` === transfer.exportId);
			const clockMatch = transfer.timing?.records.some(existing => existing.clockId === record.clockId);
			// A retry starts a new controller clock before replacing the settled operation.
			// Keep its early records pending; late records on the old clock still belong to the old attempt.
			if (record.owner === "controller" && !clockMatch && transfer.observedDurationMs !== undefined
				&& this.clocks.get(transfer.transferId)?.clockId === record.clockId) continue;
			if (!direct && !exportMatch && !clockMatch) continue;
			const prior = transfer.timing?.records.find(value => value.clockId === record.clockId && value.id === record.id);
			if (!prior || prior.revision < record.revision) {
				transfer.timing = { v: 1, records: mergeTiming(transfer.timing?.records ?? [], record) }; changed = true;
			}
			this.pendingTiming.delete(key);
		}
		return changed;
	}

	captureStoredTiming(stored: StoredExport) {
		// A standalone export can consume source measurements before its artifact arrives.
		for (const transfer of this.plugin.activeTransfers.values()) {
			for (const record of transfer.timing?.records ?? []) {
				if (this.isArtifactTiming(record, stored)) stored.timing = { v: 1, records: mergeTiming(stored.timing?.records ?? [], record) };
			}
		}
		for (const [key, { record }] of this.pendingTiming) {
			if (!this.isArtifactTiming(record, stored)) continue;
			stored.timing = { v: 1, records: mergeTiming(stored.timing?.records ?? [], record) };
			this.pendingTiming.delete(key);
		}
	}

	private scheduleTimingWrite(id: string) {
		if (this.timingWrites.has(id)) return;
		this.timingWrites.set(id, setTimeout(() => {
			this.timingWrites.delete(id);
			void this.flushTiming(id).catch(error => this.plugin.logger.warn(`Timing persistence failed: ${getErrorMessage(error)}`));
		}, 250));
	}

	private async flushTiming(id: string) {
		if (this.plugin.platformStorage.has(id)) await this.plugin.persistStorage();
		const active = this.plugin.activeTransfers.get(id);
		if (active) await this.persistTransactionLog(id, false);
		else if (!this.plugin.transactionLogLoadError) {
			await enqueueWrite(this.plugin.transactionLogPath,
				() => safeOutputFile(this.plugin.transactionLogPath, JSON.stringify(this.plugin.persistedTransactionLogs, null, 2)));
		}
		const summary = active ? this.buildDetailedTransferSummary(id, active)
			: this.plugin.persistedTransactionLogs.find(entry => entry.transferId === id)?.summary;
		if (summary) this.plugin.subscriptions.emitLogUpdate(id, {
			timestamp: new Date().toISOString(), timestampMs: Date.now(), elapsedMs: 0, deltaMs: 0,
			eventType: "timing_updated", message: "Profiling measurements updated", timing: summary.timing,
		});
	}

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
			observedDurationMs: transfer.observedDurationMs ?? null,
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
		this.finishObservation(transfer);
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
			observedDurationMs: info.observedDurationMs,
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
		this.collectTiming(transfer);
		const info = this.buildTransferInfo(transfer);
		const endAt = info.completedAt || info.failedAt || lastEventAt || Date.now();
		const durationMs = transfer.observedDurationMs ?? (transfer.timing?.v === 1 ? null : info.startedAt ? Math.max(0, endAt - info.startedAt) : null);
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
			timing: transfer.timing ?? null,
			timingBoundary: transfer.operationType === "transfer" && transfer.exportMetrics?.requestExportAndLockMs == null
				? "Controller observation begins after the source export was stored. Earlier source Lua work is measured separately."
				: "Observed request through terminal result and required cleanup acknowledgement. Audit persistence is shown separately.",
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
					...(row.observedDurationMs !== undefined ? { observedDurationMs: row.observedDurationMs } : {}),
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
				...(transferInfo.observedDurationMs !== undefined ? { observedDurationMs: transferInfo.observedDurationMs } : {}),
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

	logTransactionEvent(transferId: string, eventType: string, message: string, data: Record<string, unknown> = {}, atMs: number | null = null) {
		const observed = this.plugin.activeTransfers.get(transferId);
		if (observed) this.finishObservation(observed);
		if (!this.plugin.transactionLogs.has(transferId)) {
			this.plugin.transactionLogs.set(transferId, []);
		}

		const now = atMs ?? Date.now();
		const events = this.plugin.transactionLogs.get(transferId) || [];
		if (!this.plugin.transactionLogs.has(transferId)) {
			this.plugin.transactionLogs.set(transferId, events);
		}
		const transfer = this.plugin.activeTransfers.get(transferId);

		const elapsedMs = atMs === null && this.clocks.has(transferId) ? this.clock(transferId).offset() : transfer?.startedAt ? now - transfer.startedAt : 0;
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
		const labels: Record<string, string> = { transmission: "Import request round trip", validation: "Await destination completion", cleanup: "Source cleanup round trip" };
		const kind = phaseName === "validation" ? "wait" : "round-trip";
		this.spans.set(`${transferId}:${phaseName}`, this.clock(transferId).start(labels[phaseName] ?? phaseName, kind));
		const transfer = this.plugin.activeTransfers.get(transferId);
		if (transfer) {
			if (!transfer.phases) transfer.phases = {};
			transfer.phases[phaseName] = { startMs: Date.now() };
		}
	}

	endPhase(transferId: string, phaseName: string) {
		const span = this.spans.get(`${transferId}:${phaseName}`);
		if (span) this.clock(transferId).stop(span);
		const transfer = this.plugin.activeTransfers.get(transferId);
		if (transfer?.phases?.[phaseName]) {
			const phase = transfer.phases[phaseName];
			phase.endMs = Date.now();
			phase.durationMs = span?.endMs !== null && span?.endMs !== undefined ? span.endMs - span.startMs! : phase.endMs - phase.startMs;
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

	async persistTransactionLog(transferId: string, profile = true) {
		let persistence: TimingRecord | undefined;
		let failed = false;
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

			this.finishObservation(transfer);
			if (profile && this.clocks.has(transferId)) persistence = this.clock(transferId).start("Audit persistence", "inclusive");
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

			if (profile) {
				await this.plugin.recordAuditRow(buildAuditRow({
					transferId,
					rowKind: "terminal",
					savedAt: entry.savedAt,
					eventCount: entry.events.length,
					lastEventAt: this.getLastEventTimestamp(transferId),
					info: transferInfo,
				}));
			}

			await enqueueWrite(this.plugin.transactionLogPath,
				() => safeOutputFile(this.plugin.transactionLogPath, JSON.stringify(retained, null, 2)));
		} catch (err: unknown) {
			failed = true;
			this.plugin.logger.error(`Failed to persist transaction log: ${getErrorMessage(err)}`);
		} finally {
			if (persistence) this.clock(transferId).stop(persistence, failed ? "failed" : "completed");
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
   for (const entry of logs) {
    if (entry.summary?.timing?.v !== 1) continue;
    entry.summary.timing.records = entry.summary.timing.records.map((record: TimingRecord) => record.status === "running"
     ? { ...record, status: "interrupted", endMs: null, executionMs: null, error: "Controller restarted before a finish was recorded" }
     : record);
   }
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
