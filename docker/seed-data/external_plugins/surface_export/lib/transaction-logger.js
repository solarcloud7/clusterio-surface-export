"use strict";
const fs = require("fs/promises");

/**
 * Transaction logging, phase timing, persistence, and transfer summary building.
 * Owns the transactionLogs Map and persistedTransactionLogs array on the plugin.
 */
class TransactionLogger {
	constructor(plugin) {
		this.plugin = plugin;
	}

	normalizeTransferStatus(status) {
		if (status === "importing") {
			return "transporting";
		}
		return status;
	}

	buildTransferInfo(transfer) {
		return {
			transferId: transfer.transferId,
			exportId: transfer.exportId,
			platformName: transfer.platformName,
			platformIndex: transfer.platformIndex,
			forceName: transfer.forceName,
			sourceInstanceId: transfer.sourceInstanceId,
			sourceInstanceName: transfer.sourceInstanceName || this.plugin.platformTree.resolveInstanceName(transfer.sourceInstanceId),
			targetInstanceId: transfer.targetInstanceId,
			targetInstanceName: transfer.targetInstanceName || this.plugin.platformTree.resolveInstanceName(transfer.targetInstanceId),
			status: this.normalizeTransferStatus(transfer.status),
			startedAt: transfer.startedAt || null,
			completedAt: transfer.completedAt || null,
			failedAt: transfer.failedAt || null,
			error: transfer.error || null,
		};
	}

	getLastEventTimestamp(transferId) {
		const events = this.plugin.transactionLogs.get(transferId);
		if (!events || !events.length) {
			return null;
		}
		return events[events.length - 1].timestampMs || null;
	}

	buildTransferSummary(transferId, transfer, lastEventAt = null) {
		const info = this.buildTransferInfo(transfer);
		return {
			transferId,
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

	formatDuration(durationMs) {
		if (typeof durationMs !== "number" || Number.isNaN(durationMs)) {
			return null;
		}
		if (durationMs >= 1000) {
			return `${(durationMs / 1000).toFixed(1)}s`;
		}
		return `${Math.round(durationMs)}ms`;
	}

	resolveTransferResult(status) {
		if (status === "completed") {
			return "SUCCESS";
		}
		if (["failed", "error", "cleanup_failed"].includes(status)) {
			return "FAILED";
		}
		return "IN_PROGRESS";
	}

	buildPhaseSummary(transfer) {
		const phaseSummary = {};
		if (!transfer?.phases) {
			return phaseSummary;
		}
		for (const [name, phase] of Object.entries(transfer.phases)) {
			if (phase?.durationMs !== undefined) {
				phaseSummary[`${name}Ms`] = phase.durationMs;
			}
		}
		return phaseSummary;
	}

	buildDetailedTransferSummary(transferId, transfer, lastEventAt = null) {
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

	getTransferSummaries(limit = 50) {
		const byId = new Map();

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
					platformName: transferInfo.platformName || "Unknown",
					sourceInstanceId: transferInfo.sourceInstanceId ?? -1,
					sourceInstanceName: transferInfo.sourceInstanceName ?? null,
					targetInstanceId: transferInfo.targetInstanceId ?? -1,
					targetInstanceName: transferInfo.targetInstanceName ?? null,
					status: this.normalizeTransferStatus(transferInfo.status || "unknown"),
					startedAt: transferInfo.startedAt || persistedLog.savedAt || Date.now(),
					completedAt: transferInfo.completedAt || null,
					failedAt: transferInfo.failedAt || null,
					error: transferInfo.error || null,
					lastEventAt: lastEvent?.timestampMs || null,
				});
			}
		}

		return Array.from(byId.values())
			.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
			.slice(0, limit);
	}

	logTransactionEvent(transferId, eventType, message, data = {}) {
		if (!this.plugin.transactionLogs.has(transferId)) {
			this.plugin.transactionLogs.set(transferId, []);
		}

		const now = Date.now();
		const events = this.plugin.transactionLogs.get(transferId);
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

	startPhase(transferId, phaseName) {
		const transfer = this.plugin.activeTransfers.get(transferId);
		if (transfer) {
			if (!transfer.phases) transfer.phases = {};
			transfer.phases[phaseName] = { startMs: Date.now() };
		}
	}

	endPhase(transferId, phaseName) {
		const transfer = this.plugin.activeTransfers.get(transferId);
		if (transfer?.phases?.[phaseName]) {
			const phase = transfer.phases[phaseName];
			phase.endMs = Date.now();
			phase.durationMs = phase.endMs - phase.startMs;
			return phase.durationMs;
		}
		return 0;
	}

	async persistTransactionLog(transferId) {
		try {
			const events = this.plugin.transactionLogs.get(transferId);
			const transfer = this.plugin.activeTransfers.get(transferId);

			if (!events || !transfer) return;

			let allLogs = [];
			try {
				const content = await fs.readFile(this.plugin.transactionLogPath, "utf8");
				allLogs = JSON.parse(content);
			} catch (err) {
				// File doesn't exist yet
			}

			const summary = this.buildDetailedTransferSummary(
				transferId,
				transfer,
				events.length ? events[events.length - 1].timestampMs : null,
			);

			const logEntry = {
				transferId,
				transferInfo: {
					exportId: transfer.exportId,
					platformName: transfer.platformName,
					sourceInstanceId: transfer.sourceInstanceId,
					sourceInstanceName: transfer.sourceInstanceName || this.plugin.platformTree.resolveInstanceName(transfer.sourceInstanceId),
					targetInstanceId: transfer.targetInstanceId,
					targetInstanceName: transfer.targetInstanceName || this.plugin.platformTree.resolveInstanceName(transfer.targetInstanceId),
					status: this.normalizeTransferStatus(transfer.status),
					startedAt: transfer.startedAt,
					completedAt: transfer.completedAt,
					failedAt: transfer.failedAt,
					error: transfer.error,
				},
				summary,
				events,
				savedAt: Date.now(),
			};
			const existingIndex = allLogs.findIndex(log => log.transferId === transferId);
			if (existingIndex === -1) {
				allLogs.push(logEntry);
			} else {
				allLogs[existingIndex] = logEntry;
			}

			if (allLogs.length > 10) {
				allLogs = allLogs.slice(-10);
			}

			await fs.writeFile(this.plugin.transactionLogPath, JSON.stringify(allLogs, null, 2));
			this.plugin.persistedTransactionLogs = allLogs;
			this.plugin.logger.info(`Transaction log persisted: ${transferId}`);
		} catch (err) {
			this.plugin.logger.error(`Failed to persist transaction log ${transferId}: ${err.message}`);
		}
	}

	async loadTransactionLogs() {
		try {
			const content = await fs.readFile(this.plugin.transactionLogPath, "utf8");
			const allLogs = JSON.parse(content);
			if (!Array.isArray(allLogs)) {
				throw new Error("Transaction log file must contain an array");
			}
			this.plugin.logger.info(`Loaded ${allLogs.length} transaction logs from disk`);
			this.plugin.persistedTransactionLogs = allLogs;
		} catch (err) {
			if (err.code === "ENOENT") {
				this.plugin.logger.info("No transaction logs file found, starting fresh");
				this.plugin.persistedTransactionLogs = [];
			} else {
				this.plugin.logger.error(`Error loading transaction logs: ${err.message}`);
				this.plugin.persistedTransactionLogs = [];
			}
		}
	}
}

module.exports = TransactionLogger;
