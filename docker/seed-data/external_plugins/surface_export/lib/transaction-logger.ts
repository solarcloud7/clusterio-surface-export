
import fs from "fs/promises";
import { safeOutputFile } from "@clusterio/lib";
import type { IControllerPlugin, ActiveTransfer, PersistedTransactionLog, TransactionLogEntryModel } from "../messages";
import { getErrorMessage } from "../helpers";

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

	/** Merge active (in-memory) and persisted (on-disk) transfers into one list, active taking priority. */
	getTransferSummaries(limit = 50) {
		const byId = new Map();

		// Active transfers are inserted first so they win over persisted duplicates
		for (const [transferId, transfer] of this.plugin.activeTransfers) {
			byId.set(transferId, this.buildTransferSummary(
				transferId,
				transfer,
				this.getLastEventTimestamp(transferId),
			));
		}

		for (const persistedLog of this.plugin.persistedTransactionLogs) {
			const transferInfo = persistedLog.transferInfo || {};
			const events = Array.isArray(persistedLog.events) ? persistedLog.events : [];
			const lastEvent = events.length ? events[events.length - 1] : null;
			if (!byId.has(persistedLog.transferId)) {
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
				});
			}
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

	async persistTransactionLog(transferId: string) {
		try {
			const events = this.plugin.transactionLogs.get(transferId);
			const transfer = this.plugin.activeTransfers.get(transferId);

			if (!events || !transfer) return;

			let allLogs = [];
			try {
				const content = await fs.readFile(this.plugin.transactionLogPath, "utf8");
				allLogs = JSON.parse(content);
			} catch (_err) {
				allLogs = [];
			}

			const transferInfo = this.buildTransferInfo(transfer);
			const summary = this.buildDetailedTransferSummary(transferId, transfer, this.getLastEventTimestamp(transferId));
			const entry = {
				transferId,
				transferInfo,
				summary,
				events,
				savedAt: Date.now(),
			};

			// Upsert: replace existing entry for this transfer, or append if new
			const existingIndex = allLogs.findIndex((log: PersistedTransactionLog) => log.transferId === transferId);
			if (existingIndex !== -1) {
				allLogs.splice(existingIndex, 1, entry);
			} else {
				allLogs.push(entry);
			}

			await safeOutputFile(this.plugin.transactionLogPath, JSON.stringify(allLogs, null, 2));
			this.plugin.persistedTransactionLogs = allLogs;
		} catch (err: unknown) {
			this.plugin.logger.error(`Failed to persist transaction log: ${getErrorMessage(err)}`);
		}
	}

	async loadTransactionLogs() {
		try {
			const content = await fs.readFile(this.plugin.transactionLogPath, "utf8");
			const logs = JSON.parse(content);
			this.plugin.persistedTransactionLogs = Array.isArray(logs) ? logs : [];
			this.plugin.logger.info(`Loaded ${this.plugin.persistedTransactionLogs.length} transaction logs`);
		} catch (_err) {
			this.plugin.persistedTransactionLogs = [];
		}
	}
}
