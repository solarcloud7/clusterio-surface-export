import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { timed, timedSync, timingContext } from "./timing";
import { wait } from "@clusterio/lib";
import { normalizeExportMetrics, getErrorMessage, isSessionLostError, isBenignUnlockError, coercePlatformIndex, DEFAULT_VALIDATION_TIMEOUT_SECONDS, MIN_VALIDATION_TIMEOUT_SECONDS, MAX_VALIDATION_TIMEOUT_SECONDS, buildPayloadMetrics, buildImportMetrics, makeCanonicalTransferId, parseCanonicalTransferId } from "../helpers";
import { createOperationRecord } from "./operation-record";
import { TransferRequestQueue, type QueueEntry, type QueuedTransferRequest } from "./transfer-request-queue";
import { JobObserver } from "./job-observer";
import type { JobStatusBatch } from "../shared/job-status";
import type { TimingRecord } from "../shared/timing";
import type { IControllerPlugin, ActiveTransfer, SimpleResponse, TransferValidationEvent, ValidationResult, ExportMetrics } from "../messages";

type TransferStartResult = {
	success: boolean; error?: string; transferId?: string; message?: string;
	safeToUnlockSource?: boolean;
};

export class JobObservationStopped extends Error {}

function mergeExportMetrics(storedMetrics: ExportMetrics | null | undefined, runtimeMetrics: Record<string, unknown> | null | undefined) {
	const merged = {
		...normalizeExportMetrics((storedMetrics || null) as Record<string, unknown> | null),
		...normalizeExportMetrics(runtimeMetrics || null),
	};
	return Object.keys(merged).length ? merged : null;
}

export class TransferOrchestrator {
	private plugin: IControllerPlugin;
	private messages: typeof import("../messages");
	private settlingTransfers = new Map<string, Promise<void>>();
	private startingTransfers = new Map<string, { targetInstanceId: number; result: Promise<TransferStartResult> }>();
	readonly requestQueue: TransferRequestQueue;
	private queueWaits = new Map<string, TimingRecord>();
	private queueAdmissions = new Map<string, Promise<void>>();
	private recoveryRunning = false;
	private readonly observer: JobObserver;
	private observationDue = new Map<string, number>();
	private stopped = false;

	stop() {
		this.stopped = true;
		this.requestQueue.stop();
		for (const transfer of this.plugin.activeTransfers.values()) {
			if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
		}
	}

	constructor(plugin: IControllerPlugin, messages: typeof import("../messages")) {
		this.plugin = plugin;
		this.messages = messages;
		this.observer = new JobObserver((instanceId, jobs) => this.plugin.controller.sendTo(
			{instanceId}, new this.messages.JobsStatusRequest(jobs)));
		this.requestQueue = new TransferRequestQueue({
			run: entry => this.runQueuedRequest(entry),
			interrupted: async entry => {
				const retained = this.plugin.persistedTransactionLogs.find(log => log.transferId === entry.operation.transferId);
				if (retained && ["completed", "failed", "error", "cleanup_failed"].includes(retained.transferInfo.status)) return;
				const untouched = entry.operation.status === "queued";
				if (!untouched) {
					// An interrupted admission may already own a Lua job. Preserve that
					// observation and its endpoint reservation instead of manufacturing failure.
					const operation = entry.operation;
					if (operation.status === "transporting") operation.status = "awaiting_validation";
					operation.awaitingLateVerdict = !operation.validationResult;
					operation.timingPendingRecovery = true;
					operation.jobObservation = {state: "unavailable", message: "Status unavailable", reason: "Controller restarted during admission; work will not be replayed"};
					delete operation.completedAt;
					delete operation.observedDurationMs;
					this.plugin.activeTransfers.set(operation.transferId, operation);
					await this.txLogger.persistTransactionLog(operation.transferId);
					return;
				}
				entry.operation.error = untouched ? "Queue interrupted by controller restart; no export was started. Submit again to transfer."
					: "Controller restarted during transfer admission; outcome unknown. Inspect source and destination before retrying.";
				entry.operation.status = "error";
				entry.operation.failedAt = Date.now();
				this.plugin.activeTransfers.set(entry.operation.transferId, entry.operation);
				this.txLogger.logTransactionEvent(entry.operation.transferId, "queue_interrupted", entry.operation.error, {});
				await this.txLogger.persistTransactionLog(entry.operation.transferId);
			},
			capacity: () => {
				const raw = this.plugin.controller?.config?.get("surface_export.max_inflight_transfers_per_instance");
				return typeof raw === "number" ? raw : 1;
			},
			busyInstances: () => {
				const owned = new Set([...this.requestQueue.entries.values()].map(entry => entry.operation));
				const busy = [...this.plugin.activeTransfers.values()].filter(operation => operation.status !== "queued" && (!owned.has(operation) || operation.timingPendingRecovery)
					&& (!["completed", "failed", "error", "cleanup_failed"].includes(operation.status) || operation.timingPendingRecovery))
					.flatMap(operation => [operation.sourceInstanceId, operation.targetInstanceId]);
				for (const [id, pending] of this.plugin.pendingTransfers?.entries() || []) {
					const operation = this.plugin.activeTransfers.get(id);
					if (!operation || !owned.has(operation) || operation.timingPendingRecovery
						|| pending.sourceInstanceId !== operation.sourceInstanceId || pending.targetInstanceId !== operation.targetInstanceId
						|| ["completed", "failed", "error", "cleanup_failed"].includes(operation.status)) {
						busy.push(pending.sourceInstanceId, pending.targetInstanceId);
					}
				}
				busy.push(...(this.plugin.recoveryReservations?.keys() || []));
				return busy;
			},
			error: error => this.logger.error(`Transfer queue: ${getErrorMessage(error)}`),
		});
	}

	get logger() { return this.plugin.logger; }
	get txLogger() { return this.plugin.txLogger; }
	get subscriptions() { return this.plugin.subscriptions; }

	restoreImportObservations() {
		// Startup only: resume observation of retained nonterminal operations.
		// This never resubmits their payload or reconstructs an elapsed-time origin.
		for (const record of this.plugin.persistedTransactionLogs) {
			const info = record.transferInfo;
			if (!["in_progress", "preparing", "transporting", "awaiting_validation", "awaiting_completion"].includes(info.status)
				|| this.plugin.activeTransfers.has(record.transferId)) continue;
			const kind = info.operationType || "transfer";
			const operation = createOperationRecord(kind, {operationId: record.transferId,
				status: kind === "import" ? "awaiting_completion" : info.status === "transporting" ? "awaiting_validation" : info.status,
				platformName: info.platformName ?? undefined, forceName: info.forceName ?? undefined,
				platformIndex: info.platformIndex ?? undefined, sourceExportId: info.sourceExportId ?? undefined,
				sourceInstanceId: info.sourceInstanceId ?? -1, targetInstanceId: info.targetInstanceId ?? -1,
				exportId: info.exportId, startedAt: info.startedAt ?? undefined});
			operation.awaitingLateVerdict = kind === "transfer" && !record.summary?.validation;
			operation.timingPendingRecovery = kind === "transfer";
			operation.validationResult = record.summary?.validation as ValidationResult | undefined;
			operation.destinationJobId = info.destinationJobId ?? undefined;
			operation.jobEpoch = info.jobEpoch ?? undefined;
			operation.jobObservation = {state: "unavailable", message: "Status unavailable", reason: "Controller restarted; awaiting current job status"};
			this.plugin.activeTransfers.set(record.transferId, operation);
		}
	}

	async recoverPendingTransfers() {
		void this.observeJobs().catch(error => this.logger.error(`Job observation failed: ${getErrorMessage(error)}`));
		if (this.recoveryRunning) return;
		this.recoveryRunning = true;
		try {
			for (const intent of this.plugin.pendingTransfers?.values() || []) {
				const id = parseCanonicalTransferId(intent.transferId);
				if (!id || id.sourceInstanceId !== intent.sourceInstanceId
					|| !this.plugin.isInstanceOnline(intent.sourceInstanceId)
					|| !this.plugin.isInstanceOnline(intent.targetInstanceId)
					|| this.settlingTransfers.has(intent.transferId)) continue;
				let transfer = this.plugin.activeTransfers.get(intent.transferId);
				if (transfer && !transfer.awaitingLateVerdict && !transfer.timingPendingRecovery
					&& !["cleanup_failed", "error"].includes(transfer.status)) continue;
				// Never re-import. Only a validated hold or a saved release receipt can pass verify.
				if (!transfer) {
					const prior = this.plugin.persistedTransactionLogs?.find(entry => entry.transferId === intent.transferId);
					if (prior && (prior.transferInfo.sourceInstanceId !== intent.sourceInstanceId
						|| prior.transferInfo.targetInstanceId !== intent.targetInstanceId
						|| prior.transferInfo.platformIndex !== intent.sourcePlatformIndex)) continue;
					transfer = createOperationRecord("transfer", {
						operationId: intent.transferId, sourceInstanceId: intent.sourceInstanceId,
						targetInstanceId: intent.targetInstanceId, platformIndex: intent.sourcePlatformIndex,
						platformName: intent.sourcePlatformName, forceName: intent.forceName,
						exportId: intent.exportId, sourceExportId: intent.sourceExportId || id.sourceJobId,
						startedAt: intent.startedAt, status: prior?.transferInfo.status === "cleanup_failed" ? "cleanup_failed" : "awaiting_validation",
					});
					transfer.awaitingLateVerdict = !prior?.summary?.validation;
					if (prior?.summary) Object.assign(transfer, {
						validationResult: prior.summary.validation, sourceVerification: prior.summary.sourceVerification,
						exportMetrics: prior.summary.export, importMetrics: prior.summary.import,
						payloadMetrics: prior.summary.payload, timing: prior.summary.timing,
					});
					this.plugin.activeTransfers.set(intent.transferId, transfer);
					this.observationDue.set(intent.transferId, performance.now() + this.getValidationTimeoutMs());
				}
				// The original terminal interval and this recovery are separate observations.
				// A restart provides no continuous monotonic origin for their combined duration.
				delete transfer.observedDurationMs;
				const current = transfer;
				const recovery = (async () => {
					const { sourceResolved } = await this.handleValidationSuccess(intent.transferId, current);
					if (sourceResolved) this.plugin.removePendingTransfer(intent.transferId);
				})();
				this.settlingTransfers.set(intent.transferId, recovery);
				try { await recovery; } finally { this.settlingTransfers.delete(intent.transferId); }
			}
		} finally { this.recoveryRunning = false; }
	}

	async waitForStoredExport(exportId: string) {
		// Storage delivery and the source Lua queue can outlast any observation threshold.
		// Only explicit failure evidence can end this wait; elapsed time cannot release the source.
		for (;;) {
			if (this.stopped) throw new JobObservationStopped("Controller stopped observing; source ownership remains unresolved");
			const stored = this.plugin.platformStorage.get(exportId);
			if (stored) return stored;
			await this.observeJobs();
			const source = [...this.plugin.activeTransfers.values()].find(t => t.exportId === exportId
				|| makeCanonicalTransferId(t.sourceInstanceId, t.sourceExportId || "") === exportId);
			if (source?.jobObservation?.state === "failed") throw new Error(source.jobObservation.reason || "Source export job failed");
			await wait(500);
		}
	}

	async broadcastTransferStatus(transfer: ActiveTransfer, status: string, color: string | null = null) {
		const msg = new this.messages.TransferStatusUpdate({
			transferId: transfer.transferId,
			platformName: transfer.platformName,
			message: `[Transfer: ${transfer.platformName}] ${status}`,
			color,
		});
		for (const instanceId of [transfer.sourceInstanceId, transfer.targetInstanceId]) {
			try { await timed("Clusterio request round trip", "round-trip", () => this.plugin.controller.sendTo({ instanceId }, msg)); }
			catch (err: unknown) {
				this.logger.warn(`Failed to broadcast transfer status to instance ${instanceId}: ${getErrorMessage(err)}`);
			}
		}
	}

	updateTransfer(transfer: ActiveTransfer) {
		this.subscriptions.emitTransferUpdate(transfer);
		this.subscriptions.queueTreeBroadcast(transfer.forceName || "player");
	}

	async tryUnlockSource(transferId: string, transfer: ActiveTransfer) {
		this.txLogger.logTransactionEvent(transferId, "rollback_attempt", "Unlocking source platform", {});
		const err = await timed("Rollback unlock round trip", "round-trip", () => this.sendUnlockRequest(transfer.sourceInstanceId, transfer.platformIndex, transfer.forceName || "player", transfer.platformName));
		if (!err) {
			this.txLogger.logTransactionEvent(transferId, "rollback_success", "Source platform unlocked", {});
			return null;
		}
		this.txLogger.logTransactionEvent(transferId, "rollback_failed", `Unlock failed: ${err}`, { error: err });
		return err;
	}



	async transferPlatform(exportId: string, targetInstanceId: number, exportMetrics: Record<string, unknown> | null = null, transferStartedAt: number | null = null, targetPlanet: string | null = null): Promise<TransferStartResult> {
		// Automatic gateway requests reach this path without browser queue admission.
		// An unreadable journal cannot prove that an earlier delivery never happened.
		if (this.requestQueue.admissionError) {
			return {success: false, safeToUnlockSource: false, error: this.requestQueue.admissionError};
		}
		const transferId = this.plugin.platformStorage.get(exportId)?.exportId || exportId;
		const starting = this.startingTransfers.get(transferId);
		if (starting) {
			if (starting.targetInstanceId !== targetInstanceId) {
				return { success: false, safeToUnlockSource: false,
					error: `Transfer ${transferId} is already starting for destination ${starting.targetInstanceId}` };
			}
			return starting.result;
		}
		const result = Promise.resolve().then(() => timingContext.run(this.txLogger.clock(transferId), () =>
			this.startTransfer(exportId, targetInstanceId, exportMetrics, transferStartedAt, targetPlanet)));
		this.startingTransfers.set(transferId, { targetInstanceId, result });
		try {
			return await result;
		} finally {
			this.startingTransfers.delete(transferId);
		}
	}

	private async startTransfer(exportId: string, targetInstanceId: number, exportMetrics: Record<string, unknown> | null, transferStartedAt: number | null, targetPlanet: string | null): Promise<TransferStartResult> {
		const exportData = this.plugin.platformStorage.get(exportId);
		if (!exportData) {
			return { success: false, error: `Export not found: ${exportId}`, safeToUnlockSource: true };
		}

		const transferId = exportData.exportId || exportId;
		if ([exportData.instanceId, targetInstanceId].some(id => this.plugin.recoveryReservations?.has(id))) {
			return { success: false, error: "Instance is reconciling its loaded save; retry after recovery completes", safeToUnlockSource: false };
		}
		const sourceExportId = exportData.sourceExportId || parseCanonicalTransferId(transferId)?.sourceJobId || transferId;
		const existingTransfer = this.plugin.activeTransfers.get(transferId);
		if (existingTransfer) {
			const live = existingTransfer.status === "transporting"
				|| existingTransfer.status === "awaiting_validation"
				|| existingTransfer.status === "awaiting_completion"
				|| existingTransfer.status === "in_progress";
			if (live) {
				if (existingTransfer.targetInstanceId !== targetInstanceId) {
					return { success: false, safeToUnlockSource: false,
						error: `Transfer ${transferId} is already active for destination ${existingTransfer.targetInstanceId}` };
				}
				return { success: true, transferId, message: `Transfer already active: ${transferId}` };
			}
			if (existingTransfer.status !== "failed") {
				return { success: false, safeToUnlockSource: true, error:
					`Refusing retry of settled transfer ${transferId} (status=${existingTransfer.status}): `
					+ "the destination may hold a committed copy; create a NEW export to transfer again" };
			}
			if (existingTransfer.validationResult?.destinationPreserved === true) {
				return { success: false, safeToUnlockSource: true, error:
					`Refusing retry of failed transfer ${transferId}: its destination was deliberately `
					+ "PRESERVED by the debug preserve_failed_destination flag, so a re-run would "
					+ "duplicate beside it. Remove the preserved platform (or restart the controller "
					+ "to clear the record), then create a NEW export." };
			}
			this.plugin.logger.info(
				`Replacing failed (destination-discarded) transfer record for retried export ${transferId}`);
		}
		if (!this.plugin.isInstanceOnline(targetInstanceId)) {
			const name = this.plugin.platformTree.resolveInstanceName(targetInstanceId);
			return { success: false, safeToUnlockSource: true, error:
				`Destination instance ${name ? `"${name}" ` : ""}(${targetInstanceId}) is offline — `
				+ "transfer refused before starting. The source platform is unchanged; retry when the "
				+ "destination is running." };
		}
		const innerData = exportData.exportData;
		timingContext.enterWith(this.txLogger.beginObservation(transferId));
		const { payloadMetrics, itemCounts, fluidCounts } = timedSync("Payload preparation", () => buildPayloadMetrics(innerData));
		const platformInfo = (innerData?.platform && typeof innerData.platform === "object"
			? innerData.platform
			: {}) as { force?: string };
		const mergedExportMetrics = mergeExportMetrics(exportData.exportMetrics, exportMetrics);

		const topLevelIndex = exportData.platformIndex;
		const sourcePlatformIndex = Number.isInteger(topLevelIndex) ? (topLevelIndex as number) : null;
		if (sourcePlatformIndex === null || sourcePlatformIndex < 1) {
			return { success: false, safeToUnlockSource: true, error: `Transfer aborted: source platform index unavailable (top-level=${String(topLevelIndex)})` };
		}

		const operation = createOperationRecord("transfer", {
			operationId: transferId,
			exportId,
			sourceExportId,
			artifactSizeBytes: exportData.size ?? null,
			platformName: exportData.platformName || "Unknown",
			platformIndex: sourcePlatformIndex,
			forceName: String(platformInfo.force || "player"),
			sourceInstanceId: exportData.instanceId,
			sourceInstanceName: this.plugin.platformTree.resolveInstanceName(exportData.instanceId),
			targetInstanceId,
			targetInstanceName: this.plugin.platformTree.resolveInstanceName(targetInstanceId),
			startedAt: transferStartedAt ?? Date.now(),
			status: "transporting",
		});
		operation.payloadMetrics = payloadMetrics;
		operation.exportMetrics = mergedExportMetrics;

		const finiteMs = (value: unknown): value is number =>
			typeof value === "number" && Number.isFinite(value) && value >= 0;
		const prepMs = mergedExportMetrics?.controllerExportPrepTotalMs;
		const exportPhase = finiteMs(prepMs) ? { name: "export", ms: prepMs } : null;
		if (exportPhase) {
			const exportEndMs = Date.now();
			operation.phases = {
				...(operation.phases ?? {}),
				[exportPhase.name]: {
					startMs: exportEndMs - exportPhase.ms,
					endMs: exportEndMs,
					durationMs: exportPhase.ms,
				},
			};
		}
		operation.sourceVerification = { itemCounts, fluidCounts };
		const queuedRequestId = timingContext.getStore()?.jobId;
		const queued = queuedRequestId ? this.requestQueue.entries.get(queuedRequestId) : undefined;
		const queuedEvents = queued ? this.plugin.transactionLogs.get(queued.id) : undefined;
		if (queued) {
			operation.queuedRequestId = queued.id;
			operation.startedAt = queued.operation.startedAt;
			if (queued.operation.timing) operation.timing = { v: 1, records: queued.operation.timing.records.map(record => ({
				...record, operationId: record.operationId === queued.id ? transferId : record.operationId,
			})) };
			this.plugin.activeTransfers.delete(queued.id);
			this.plugin.transactionLogs.delete(queued.id);
			this.plugin.persistedTransactionLogs = this.plugin.persistedTransactionLogs.filter(log => log.transferId !== queued.id);
			queued.operation = operation;
			await this.requestQueue.persist();
		}
		await this.txLogger.archiveRecycledTransferId(transferId, operation.startedAt);
		this.plugin.activeTransfers.set(transferId, operation);
		if (queuedEvents) this.plugin.transactionLogs.set(transferId, queuedEvents);

		const transfer = this.plugin.activeTransfers.get(transferId);
		if (!transfer) {
			return { success: false, safeToUnlockSource: true, error: "Failed to initialize transfer state" };
		}
		const requestMs = mergedExportMetrics?.requestExportAndLockMs;
		if (finiteMs(requestMs)) {
			const requestedAt = transferStartedAt ?? transfer.startedAt;
			this.txLogger.logTransactionEvent(transferId, "export_requested",
				`Export requested from ${transfer.sourceInstanceName || transfer.sourceInstanceId}`, {}, requestedAt);
			this.txLogger.logTransactionEvent(transferId, "export_returned",
				`Source returned export ${sourceExportId} after ${requestMs} ms`,
				{ requestExportAndLockMs: requestMs }, requestedAt + requestMs);
		}
		this.txLogger.logTransactionEvent(transferId, "transfer_created",
			`${transfer.platformName}: ${transfer.sourceInstanceName || transfer.sourceInstanceId} → ${transfer.targetInstanceName || targetInstanceId}`, {
				exportMetrics: mergedExportMetrics,
				payloadMetrics,
			});

		await this.plugin.recordTransferStarted(transfer);

		this.updateTransfer(transfer);

		let importAccepted = false;
		try {
			this.txLogger.startPhase(transferId, "transmission");
			const response = await timed("Clusterio request round trip", "round-trip", () => this.plugin.controller.sendTo(
				{ instanceId: targetInstanceId },
				new this.messages.ImportPlatformRequest({
					exportId,
					exportData: { ...innerData, _transferId: transferId, _sourceInstanceId: exportData.instanceId },
					forceName: "player",
					targetPlanet,
				}),
			));
			const transmissionMs = this.txLogger.endPhase(transferId, "transmission");

			if (!response.success && !response.admissionUncertain) {
				return await this.handleImportFailure(transferId, response.error || "Import failed", transmissionMs);
			}

			importAccepted = true;
			transfer.destinationJobId = response.jobId;
			transfer.jobEpoch = response.epoch;
			this.enterAwaitingValidation(transfer, transferId);
			this.txLogger.logTransactionEvent(transferId, "import_started",
				`Awaiting validation; verify job status after ${(transfer.armedValidationTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_SECONDS * 1000) / 1000}s`, { transmissionMs });

			return { success: true, transferId, message: `Transfer initiated: ${transferId}` };

		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Error transferring platform: ${errMsg}`);
			if (importAccepted) {
				return { success: false, safeToUnlockSource: false, error: errMsg };
			}
			if (isSessionLostError(err)) {
				const transmissionMs = this.txLogger.endPhase(transferId, "transmission");
				this.enterAwaitingValidation(transfer, transferId);
				this.txLogger.logTransactionEvent(transferId, "import_delivery_uncertain",
					`Import send interrupted by session loss (${errMsg}); NOT unlocking source — awaiting validation`,
					{ error: errMsg, transmissionMs });
				return { success: true, transferId, message: `Transfer initiated (delivery unconfirmed after a session interruption; awaiting validation): ${transferId}` };
			}
			const rollbackError = await this.tryUnlockSource(transferId, transfer);
			if (rollbackError) {
				return { success: false, error: `${errMsg}; rollback failed: ${rollbackError}` };
			}
			return { success: false, error: errMsg };
		}
	}

	async handleImportFailure(transferId: string, error: string, transmissionMs: number) {
		const transfer = this.plugin.activeTransfers.get(transferId);
		if (!transfer) return { success: false, error };

		transfer.timingPendingRecovery = true;
		transfer.status = "failed";
		transfer.error = error || "Import failed";
		transfer.failedAt = Date.now();
		this.txLogger.logTransactionEvent(transferId, "import_failed",
			`Import failed: ${error}`, { error, transmissionMs });

		let rollbackError: string | null;
		try { rollbackError = await this.tryUnlockSource(transferId, transfer); }
		finally { transfer.timingPendingRecovery = false; }
		if (rollbackError) transfer.error = `${transfer.error}; rollback failed: ${rollbackError}`;

		this.updateTransfer(transfer);
		await this.txLogger.persistTransactionLog(transferId);
		return { success: false, error };
	}

	enterAwaitingValidation(transfer: ActiveTransfer, transferId: string) {
		this.txLogger.startPhase(transferId, "validation");
		transfer.status = "awaiting_validation";
		this.scheduleValidationTimeout(transferId);
		this.updateTransfer(transfer);
		this.plugin.persistPendingTransfer({
			transferId,
			sourceExportId: transfer.sourceExportId,
			sourceInstanceId: transfer.sourceInstanceId,
			sourcePlatformIndex: transfer.platformIndex,
			sourcePlatformName: transfer.platformName,
			forceName: transfer.forceName || "player",
			targetInstanceId: Number(transfer.targetInstanceId),
			startedAt: transfer.startedAt,
			exportId: transfer.exportId ?? null,
		});
	}

	getValidationTimeoutMs(): number {
		let raw: unknown;
		try {
			raw = this.plugin.controller.config?.get("surface_export.transfer_validation_timeout_seconds");
		} catch (err: unknown) {
			this.logger.error(
				`Reading surface_export.transfer_validation_timeout_seconds threw (${getErrorMessage(err)}) — `
				+ `using the default ${DEFAULT_VALIDATION_TIMEOUT_SECONDS}s`);
			return DEFAULT_VALIDATION_TIMEOUT_SECONDS * 1000;
		}
		const seconds = Number(raw);
		if (!Number.isFinite(seconds) || seconds <= 0) {
			if (raw !== undefined && raw !== null) {
				this.logger.warn(
					`surface_export.transfer_validation_timeout_seconds=${String(raw)} is not a positive `
					+ `number — using the default ${DEFAULT_VALIDATION_TIMEOUT_SECONDS}s`);
			}
			return DEFAULT_VALIDATION_TIMEOUT_SECONDS * 1000;
		}
		const floored = Math.floor(seconds);
		const clamped = Math.min(MAX_VALIDATION_TIMEOUT_SECONDS, Math.max(MIN_VALIDATION_TIMEOUT_SECONDS, floored));
		if (clamped !== floored) {
			this.logger.warn(
				`surface_export.transfer_validation_timeout_seconds=${String(raw)} is outside `
				+ `[${MIN_VALIDATION_TIMEOUT_SECONDS}, ${MAX_VALIDATION_TIMEOUT_SECONDS}] — using ${clamped}s for status observation`);
		}
		return clamped * 1000;
	}

	scheduleValidationTimeout(transferId: string) {
		const transfer = this.plugin.activeTransfers.get(transferId);
		if (!transfer) return;
		const timeoutMs = this.getValidationTimeoutMs();
		transfer.armedValidationTimeoutMs = timeoutMs;
		this.observationDue.set(transferId, performance.now() + timeoutMs);

		transfer.validationTimeout = setTimeout(async () => {
			const current = this.plugin.activeTransfers.get(transferId);
			if (!current || current.status !== "awaiting_validation") return;

			current.validationTimeout = null;
				this.observationDue.set(transferId, performance.now());
			try { await this.observeJobs(); }
			catch (error) { this.logger.error(`Job observation failed: ${getErrorMessage(error)}`); }
		}, timeoutMs);
		transfer.validationTimeout.unref?.();
	}

	/** Shared with the existing recovery heartbeat; never starts or cancels a Lua job. */
	async observeJobs(): Promise<void> {
		if (this.stopped) return;
		const groups = new Map<number, ActiveTransfer[]>();
		for (const transfer of this.plugin.activeTransfers.values()) {
			const observingSource = Boolean(transfer.sourceExportId) && ["in_progress", "preparing"].includes(transfer.status);
			if (!observingSource && !["awaiting_validation", "awaiting_completion"].includes(transfer.status)) {
				this.observationDue.delete(transfer.transferId);
				this.observer.forget(transfer.transferId);
				continue;
			}
			if (!this.observationDue.has(transfer.transferId)) this.observationDue.set(transfer.transferId, performance.now() + this.getValidationTimeoutMs());
			if (performance.now() < this.observationDue.get(transfer.transferId)!) continue;
			const instanceId = observingSource ? transfer.sourceInstanceId : transfer.targetInstanceId;
			const group = groups.get(instanceId) || [];
			group.push(transfer);
			groups.set(instanceId, group);
		}
		await Promise.all([...groups].map(async ([instanceId, transfers]) => {
			let batch: JobStatusBatch;
			let requested: import("../shared/job-status").JobReference[] | undefined;
			try {
				const response = await this.observer.poll(instanceId, transfers.map(t => ["in_progress", "preparing"].includes(t.status)
					? {jobId: t.sourceExportId!} : {operationId: t.transferId, jobId: t.destinationJobId}));
				if (!response) return;
				batch = response;
				requested = response.requested;
			} catch (error) {
				batch = {version: 1, epoch: "", observedTick: 0, jobs: transfers.map(t => ({jobId: t.sourceExportId || undefined, operationId: t.transferId, state: "unavailable", error: getErrorMessage(error)}))};
			}
			for (const transfer of transfers) {
				if (requested && !requested.some(ref => ref.operationId === transfer.transferId
					|| (ref.jobId && ref.jobId === transfer.sourceExportId))) continue;
				if (this.plugin.activeTransfers.get(transfer.transferId) !== transfer || !["in_progress", "preparing", "awaiting_validation", "awaiting_completion"].includes(transfer.status)) continue;
				const status = batch.jobs.find(job => ["in_progress", "preparing"].includes(transfer.status)
					? job.jobId === transfer.sourceExportId : job.operationId === transfer.transferId) || {state: "unavailable" as const};
				const observation = this.observer.observe(transfer.transferId, {...status, epoch: batch.epoch}, this.getValidationTimeoutMs());
				if (JSON.stringify(transfer.jobObservation) !== JSON.stringify(observation)) {
					transfer.jobObservation = observation;
					this.updateTransfer(transfer);
				}
				// Only the original composite verdict can enter the existing transfer success/failure path.
				const result = status.completion;
				if (transfer.operationType === "transfer" && result?.transfer_id === transfer.transferId
					&& result.source_instance_id === transfer.sourceInstanceId && typeof result.success === "boolean"
					&& result.validation && typeof result.validation === "object") {
					await this.handleTransferValidation(new this.messages.TransferValidationEvent({transferId: transfer.transferId,
						platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
						success: result.success, validation: result.validation as ValidationResult}));
				} else if (transfer.operationType === "import" && result?.operation_id === transfer.transferId
					&& typeof result.success === "boolean" && result.validation && typeof result.validation === "object") {
					await this.plugin.handleImportOperationCompleteEvent(new this.messages.ImportOperationCompleteEvent({
						operationId: transfer.transferId, instanceId, platformName: transfer.platformName,
						success: result.success, error: typeof result.error === "string" ? result.error : null,
						failedStage: typeof result.failed_stage === "string" ? result.failed_stage : null,
						cleanupFailed: result.cleanup_failed === true, destinationPreserved: result.destination_preserved === true,
						validation: result.validation as ValidationResult,
					}));
				}
			}
		}));
	}


	async handleTransferValidation(event: TransferValidationEvent): Promise<void> {
		const inFlight = this.settlingTransfers.get(event.transferId);
		if (inFlight) {
			await inFlight;
			if (this.plugin.activeTransfers.get(event.transferId)?.awaitingLateVerdict) return this.handleTransferValidation(event);
			return;
		}
		const settling = timingContext.run(this.txLogger.clock(event.transferId), () =>
			timed("Destination verdict handling", "inclusive", () => this.handleTransferValidationMeasured(event)));
		this.settlingTransfers.set(event.transferId, settling);
		try { await settling; }
		finally { this.settlingTransfers.delete(event.transferId); }
	}

	private async handleTransferValidationMeasured(event: TransferValidationEvent) {
		const settled = this.plugin.activeTransfers.get(event.transferId);
		if (settled?.awaitingLateVerdict) {
			settled.awaitingLateVerdict = false;
			settled.status = "awaiting_validation";
		}
		if (settled && settled.status !== "awaiting_validation") {
			const verdict = event.success ? "SUCCESS" : "FAILURE";
			const priorStatus = settled.status;
			let disposition = "Record unchanged.";
			if (event.success && priorStatus === "failed") {
				settled.status = "cleanup_failed";
				settled.error = [settled.error, "late import SUCCESS after rollback: verify destination cleanup before retrying"]
					.filter(Boolean).join("; ");
				this.updateTransfer(settled);
				disposition = "Source rollback was already acknowledged. The destination may retain a copy; "
					+ "cleanup_failed prevents another import until its identity and cleanup are verified.";
			} else if (!event.success && priorStatus === "failed" && event.validation?.cleanup_failed) {
				settled.status = "cleanup_failed";
				settled.validationResult = event.validation;
				settled.error = [settled.error,
					`late FAILURE reported the destination discard itself failed (${String(event.validation.cleanup_error || "no reason given")}) — an orphan copy remains on the target; remove it before retrying`]
					.filter(Boolean).join("; ");
				this.updateTransfer(settled);
				disposition = "The destination's own discard FAILED — an orphan copy remains on the "
					+ "target; the transfer is re-marked cleanup_failed so retries are refused until it "
					+ "is removed.";
			} else if (!event.success && priorStatus === "failed" && event.validation?.destinationPreserved === true) {
				settled.validationResult = event.validation;
				this.updateTransfer(settled);
				disposition = "Adopted the genuine verdict onto the record (it carries "
					+ "destinationPreserved, which the retry guard reads); status unchanged.";
			}
			this.txLogger.logTransactionEvent(event.transferId, "validation_after_settle",
				`Late validation ${verdict} arrived after this transfer settled as '${priorStatus}' — `
				+ `no source delete, no rollback. ${disposition}`,
				{ lateVerdictSuccess: event.success, settledStatus: priorStatus, newStatus: settled.status, validation: event.validation ?? null });
			this.logger.warn(
				`Late validation ${verdict} for settled transfer ${event.transferId} `
				+ `(status=${priorStatus}${settled.status !== priorStatus ? ` → ${settled.status}` : ""}) — refused by the status guard`);
			await this.txLogger.persistTransactionLog(event.transferId);
			return;
		}

		const validationMs = this.txLogger.endPhase(event.transferId, "validation");
		const importMetrics = buildImportMetrics(event.metrics);

		this.txLogger.logTransactionEvent(event.transferId, "validation_received",
			`Validation: ${event.success ? "SUCCESS" : "FAILED"}`, {
				success: event.success, validation: event.validation, validationMs, importMetrics,
			});

		const transfer = this.plugin.activeTransfers.get(event.transferId);
		if (!transfer) {
			this.logger.warn(`Validation for unknown transfer: ${event.transferId}`);
			return;
		}
		delete transfer.jobObservation;

		if (importMetrics) transfer.importMetrics = importMetrics;
		transfer.validationResult = event.validation || null;
		transfer.failedStage = event.validation?.failedStage ?? null;

		if (transfer.validationTimeout) {
			clearTimeout(transfer.validationTimeout);
			transfer.validationTimeout = null;
		}

		try {
			let sourceResolved;
			if (event.success) {
				({ sourceResolved } = await this.handleValidationSuccess(event.transferId, transfer));
			} else {
				({ sourceResolved } = await this.handleValidationFailure(event.transferId, transfer, event.validation));
			}
			if (sourceResolved) {
				this.plugin.removePendingTransfer(event.transferId);
			}
			this.pruneOldTransfers();
		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Error handling validation: ${errMsg}`);
			transfer.status = "error";
			transfer.error = errMsg;
			this.updateTransfer(transfer);
			await this.broadcastTransferStatus(transfer, `Error: ${errMsg}`, "red");
		}
	}

	async handleValidationSuccess(transferId: string, transfer: ActiveTransfer) {
		this.txLogger.startPhase(transferId, "cleanup");
		const gate = (action: "verify" | "go_live") => timed("Destination transfer gate round trip", "round-trip", () =>
			this.plugin.controller.sendTo({ instanceId: transfer.targetInstanceId },
				new this.messages.DestinationTransferGateRequest({ transferId, action })));
		const failed = async (error: string) => {
			this.txLogger.endPhase(transferId, "cleanup");
			if (transfer.status === "cleanup_failed" && transfer.error === error) return { sourceResolved: false };
			transfer.status = "cleanup_failed";
			transfer.error = error;
			transfer.completedAt = Date.now();
			this.txLogger.logTransactionEvent(transferId, "cleanup_failed", error);
			this.updateTransfer(transfer);
			await this.broadcastTransferStatus(transfer, `Cleanup incomplete: ${error}`, "yellow");
			await this.txLogger.persistTransactionLog(transferId);
			return { sourceResolved: false };
		};
		try {
			await this.plugin.persistPendingTransfers(transferId);
			const held = await gate("verify");
			if (!held.success && transfer.awaitingLateVerdict) {
				this.txLogger.endPhase(transferId, "cleanup");
				// A restart can precede import admission or queued Lua work. Missing hold evidence
				// cannot manufacture a terminal result; the job observer supplies its current state.
				return {sourceResolved: false};
			}
			if (!held.success) return failed(`Destination hold not confirmed: ${held.error}`);
			transfer.awaitingLateVerdict = false;
			await this.broadcastTransferStatus(transfer, "Validation passed — destination held; deleting source...", "green");

			const deleteResponse = await timed("Clusterio request round trip", "round-trip", () => this.plugin.controller.sendTo(
				{ instanceId: transfer.sourceInstanceId },
				new this.messages.DeleteSourcePlatformRequest({
					platformIndex: transfer.platformIndex,
					platformName: transfer.platformName,
					forceName: transfer.forceName,
					exportId: transfer.sourceExportId ?? transfer.exportId ?? null,
				}),
			));

			if (deleteResponse.success) {
				const activated = await gate("go_live");
				if (!activated.success) return failed(`Source deleted; destination activation not confirmed: ${activated.error}`);
				const cleanupMs = this.txLogger.endPhase(transferId, "cleanup");
				transfer.status = "completed";
				transfer.timingPendingRecovery = false;
				transfer.awaitingLateVerdict = false;
				transfer.error = null;
				transfer.completedAt = Date.now();
				const durationMs = this.txLogger.getObservedDuration(transfer);
				this.txLogger.logTransactionEvent(transferId, "transfer_completed",
					"Transfer completed", {
						durationMs, cleanupMs,
						phases: this.txLogger.buildPhaseSummary(transfer),
					});
				this.updateTransfer(transfer);
				await this.broadcastTransferStatus(transfer, "Transfer complete! ✓", "green");
				await this.txLogger.persistTransactionLog(transferId);
				// Retain the snapshot under max_storage_size for explicit recovery imports.
				// Terminal transfer identity still rejects replay; retaining bytes is not deletion authority.
				await this.plugin.persistStorage();
				this.subscriptions.queueTreeBroadcast(transfer.forceName || "player");
				return { sourceResolved: true };
			}
			return failed(`Source deletion not confirmed; destination remains held: ${deleteResponse.error}`);
		} catch (error) {
			if (transfer.awaitingLateVerdict) {
				this.txLogger.endPhase(transferId, "cleanup");
				transfer.jobObservation = {state: "unavailable", message: "Status unavailable", reason: getErrorMessage(error)};
				this.updateTransfer(transfer);
				return {sourceResolved: false};
			}
			// A lost reply cannot authorize destination activation or destructive rollback.
			return failed(`Transfer gate response unavailable: ${getErrorMessage(error)}`);
		}
	}

	async handleValidationFailure(transferId: string, transfer: ActiveTransfer, validation: ValidationResult | undefined) {
		const errorMsg = validation?.mismatchDetails || "Unknown error";
		const destinationCleanupError = validation?.cleanup_failed
			? String(validation.cleanup_error || "destination discard failed")
			: null;
		this.txLogger.logTransactionEvent(transferId, "validation_failed",
			`Validation failed: ${errorMsg}`, { validation });

		await this.broadcastTransferStatus(transfer, "Validation failed ✗ — rolling back...", "red");

		const rollbackError = await this.tryUnlockSource(transferId, transfer);
		if (!rollbackError && !destinationCleanupError) transfer.timingPendingRecovery = false;
		if (rollbackError) {
			await this.broadcastTransferStatus(transfer, `⚠ Rollback failed: ${rollbackError}`, "red");
		} else {
			await this.broadcastTransferStatus(transfer, `Rolled back. Error: ${errorMsg}`, "red");
		}

		transfer.status = destinationCleanupError ? "cleanup_failed" : "failed";
		transfer.error = [errorMsg, rollbackError, destinationCleanupError].filter(Boolean).join("; ");
		transfer.completedAt = Date.now();
		this.txLogger.logTransactionEvent(transferId, "transfer_failed",
			"Transfer failed", {
				durationMs: this.txLogger.getObservedDuration(transfer),
				error: transfer.error,
				destinationCleanupError,
			});
		this.updateTransfer(transfer);
		await this.txLogger.persistTransactionLog(transferId);
		return { sourceResolved: !rollbackError };
	}

	pruneOldTransfers() {
		if (this.plugin.activeTransfers.size <= 100) return;
		const sorted = Array.from(this.plugin.activeTransfers.entries()) as Array<[string, ActiveTransfer]>;
		sorted.sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0));
		for (let i = 100; i < sorted.length; i++) {
			this.plugin.activeTransfers.delete(sorted[i][0]);
		}
	}


	async handleStartPlatformTransferRequest(request: QueuedTransferRequest) {
		const reject = async (error: string) => {
			const id = `request:${randomUUID()}`;
			try {
				this.txLogger.beginObservation(id);
				await this.txLogger.rejectObservation(id, { ...request }, error);
			} catch (timingError) {
				this.logger.warn(`Rejected-request profiling failed: ${getErrorMessage(timingError)}`);
			}
			return { success: false, error };
		};
		const source = this.plugin.controller.instances.get(request.sourceInstanceId);
		const target = this.plugin.controller.instances.get(request.targetInstanceId);
		if (!source || source.isDeleted || !target || target.isDeleted || source.id === target.id
			|| coercePlatformIndex(request.sourcePlatformIndex) === null) return reject("Invalid source, destination or platform");
		if (!this.plugin.isInstanceOnline(source.id) || !this.plugin.isInstanceOnline(target.id)) return reject("Both instances must be online to queue a transfer");
		const existing = this.requestQueue.find(request);
		if (existing) {
			if (existing.request.targetInstanceId !== request.targetInstanceId || (existing.request.targetPlanet ?? null) !== (request.targetPlanet ?? null)) {
				return reject("This platform is already queued or transferring to another destination");
			}
			try { await this.queueAdmissions.get(existing.id); }
			catch (error) { return { success: false, error: getErrorMessage(error) }; }
			return { success: true, transferId: existing.operation.transferId, message: "Transfer already queued or active" };
		}
		if ([...this.plugin.activeTransfers.values()].some(operation => operation.sourceInstanceId === source.id
			&& operation.platformIndex === request.sourcePlatformIndex && !["completed", "failed", "error", "cleanup_failed"].includes(operation.status))) {
			return reject("This platform already has an active transfer");
		}
		const observationId = `request:${randomUUID()}`;
		this.txLogger.beginObservation(observationId);
		const operation = createOperationRecord("transfer", { operationId: observationId, status: "queued",
			platformName: request.platformName || `Platform #${request.sourcePlatformIndex}`, platformIndex: request.sourcePlatformIndex,
			sourceInstanceId: source.id, targetInstanceId: target.id, forceName: request.forceName || "player",
			resolveInstanceName: id => this.plugin.platformTree.resolveInstanceName(id) });
		this.plugin.activeTransfers.set(observationId, operation);
		this.queueWaits.set(observationId, this.txLogger.clock(observationId).start("Transfer queue wait", "wait"));
		this.txLogger.logTransactionEvent(observationId, "transfer_queued", "Waiting for source and destination instances", {});
		try {
			const admission = this.requestQueue.add({ id: observationId, request: { ...request }, operation });
			this.queueAdmissions.set(observationId, admission);
			await admission;
			this.updateTransfer(operation);
			return { success: true, transferId: observationId, message: "Transfer queued" };
		} catch (error) {
			const span = this.queueWaits.get(observationId);
			if (span) this.txLogger.clock(observationId).stop(span, "failed");
			this.queueWaits.delete(observationId);
			operation.status = "failed"; operation.error = getErrorMessage(error); operation.failedAt = Date.now();
			this.updateTransfer(operation);
			await this.txLogger.persistTransactionLog(observationId);
			return { success: false, error: operation.error };
		} finally {
			this.queueAdmissions.delete(observationId);
		}
	}

	private async runQueuedRequest(entry: QueueEntry) {
		const clock = this.txLogger.clock(entry.id);
		const span = this.queueWaits.get(entry.id);
		if (span) clock.stop(span);
		this.queueWaits.delete(entry.id);
		// The root began at admission. Queue wait uses the same monotonic clock, independent of game ticks.
		this.txLogger.logTransactionEvent(entry.id, "queue_released", "Source and destination reserved; preparing export", {});
		this.updateTransfer(entry.operation);
		try {
			const result = await timingContext.run(clock, () => this.handleStartPlatformTransferRequestMeasured(entry.request, entry.id));
			if (!result.success && !["completed", "failed", "error", "cleanup_failed"].includes(entry.operation.status)) {
				// A canonical operation with no terminal result may already have reached the destination.
				// Keep its reservation until recovery is resolved; an exception is not a cleanup acknowledgement.
				if (entry.operation.transferId !== entry.id) entry.operation.timingPendingRecovery = true;
				entry.operation.status = entry.operation.timingPendingRecovery ? "cleanup_failed" : "failed";
				entry.operation.error = result.error || "Transfer request failed";
				entry.operation.failedAt = Date.now();
				this.txLogger.logTransactionEvent(entry.operation.transferId, "transfer_failed", entry.operation.error, {});
				this.updateTransfer(entry.operation);
				await this.txLogger.persistTransactionLog(entry.operation.transferId);
			}
		} catch (error) {
			if (entry.operation.transferId !== entry.id) entry.operation.timingPendingRecovery = true;
			entry.operation.status = "error"; entry.operation.error = getErrorMessage(error); entry.operation.failedAt = Date.now();
			this.txLogger.logTransactionEvent(entry.operation.transferId, "queue_error", entry.operation.error, {});
			this.updateTransfer(entry.operation);
			await this.txLogger.persistTransactionLog(entry.operation.transferId);
		}
		await this.requestQueue.persist();
	}

	async handleStartPlatformTransferRequestMeasured(request: { sourceInstanceId: number; sourcePlatformIndex: number; targetInstanceId: number; forceName?: string; targetPlanet?: string | null }, observationId: string) {
		const sourceInstanceId = Number(request.sourceInstanceId);
		if (!Number.isInteger(sourceInstanceId)) {
			return { success: false, error: `Invalid source instance: ${request.sourceInstanceId}` };
		}
		const sourceInstance = this.plugin.controller.instances.get(sourceInstanceId);
		if (!sourceInstance || sourceInstance.isDeleted) {
			return { success: false, error: `Unknown source instance ${sourceInstanceId}` };
		}
		const resolvedTarget = this.plugin.platformTree.resolveTargetInstance(request.targetInstanceId);
		if (!resolvedTarget) {
			return { success: false, error: `Unknown target instance ${request.targetInstanceId}` };
		}
		if (resolvedTarget.id === sourceInstanceId) {
			return { success: false, error: "Source and destination instances must be different" };
		}
		const forceName = request.forceName || "player";
		const sourcePlatformIndex = Number(request.sourcePlatformIndex);
		if (!Number.isInteger(sourcePlatformIndex) || sourcePlatformIndex < 1) {
			return { success: false, error: `Invalid platform index ${request.sourcePlatformIndex}` };
		}

		if (!this.plugin.isInstanceOnline(resolvedTarget.id)) {
			const name = this.plugin.platformTree.resolveInstanceName(resolvedTarget.id);
			return { success: false, error:
				`Destination instance ${name ? `"${name}" ` : ""}(${resolvedTarget.id}) is offline — `
				+ "transfer refused before starting. Nothing was locked or exported; retry when the "
				+ "destination is running." };
		}

		try {
			const t0 = Date.now();
			const exportStart = performance.now();
			const exportResponse = await timed("Clusterio request round trip", "round-trip", () => this.plugin.controller.sendTo(
				{ instanceId: sourceInstanceId },
				new this.messages.ExportPlatformRequest({
					operationId: timingContext.getStore()?.operationId ?? timingContext.getStore()?.jobId,
					platformIndex: sourcePlatformIndex,
					forceName,
					targetInstanceId: resolvedTarget.id,
				}),
			)) as SimpleResponse & { exportId?: string };
			const exportRequestMs = performance.now() - exportStart;
			if (!exportResponse?.success || !exportResponse.exportId) {
				return { success: false, error: exportResponse?.error || "Export failed" };
			}

			const t1 = performance.now();
			const canonicalExportId = makeCanonicalTransferId(sourceInstanceId, exportResponse.exportId);
			const queued = this.plugin.activeTransfers.get(observationId);
			if (queued) queued.sourceExportId = exportResponse.exportId;
			this.txLogger.bindObservation(observationId, canonicalExportId);
			await timed("Await artifact storage", "wait", () => this.waitForStoredExport(canonicalExportId));
			const waitForStoredMs = performance.now() - t1;

			const result = await this.transferPlatform(canonicalExportId, resolvedTarget.id, {
				requestExportAndLockMs: exportRequestMs,
				waitForControllerStoreMs: waitForStoredMs,
				controllerExportPrepTotalMs: exportRequestMs + waitForStoredMs,
			}, t0, request.targetPlanet ?? null);
			if (!result.success && result.safeToUnlockSource) {
				const rollbackError = await timed("Rollback unlock round trip", "round-trip", () => this.sendUnlockRequest(sourceInstanceId, sourcePlatformIndex, forceName));
				if (rollbackError) {
					this.logger.error(`Unlock after refused transfer of #${sourcePlatformIndex} failed: ${rollbackError}`);
					return { ...result, error: `${result.error}; rollback failed: ${rollbackError}`,
						exportId: canonicalExportId, sourceExportId: exportResponse.exportId };
				}
			}
			return { ...result, exportId: canonicalExportId, sourceExportId: exportResponse.exportId };
		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Error starting transfer (source instance ${sourceInstanceId}, platform #${sourcePlatformIndex}): ${errMsg}`);
			if (err instanceof JobObservationStopped || isSessionLostError(err)) {
				const operation = this.plugin.activeTransfers.get(observationId);
				if (operation) {
					operation.jobObservation = {state: "unavailable", message: "Status unavailable", reason: errMsg};
					operation.timingPendingRecovery = true;
					this.updateTransfer(operation);
				}
				return {success: true, message: "Source status unavailable; protections retained"};
			}
			const rollbackError = await timed("Rollback unlock round trip", "round-trip", () => this.sendUnlockRequest(sourceInstanceId, sourcePlatformIndex, forceName));
			if (rollbackError) {
				this.logger.error(`Rollback unlock of source #${sourcePlatformIndex} failed: ${rollbackError}`);
				return { success: false, error: `${errMsg}; rollback failed: ${rollbackError}` };
			}
			return { success: false, error: errMsg };
		}
	}

	private async sendUnlockRequest(sourceInstanceId: number, platformIndex: number, forceName: string, platformName?: string): Promise<string | null> {
		if (coercePlatformIndex(platformIndex) === null) return `invalid platformIndex: ${String(platformIndex)}`;
		try {
			const resp = await timed("Clusterio request round trip", "round-trip", () => this.plugin.controller.sendTo(
				{ instanceId: sourceInstanceId },
				new this.messages.UnlockSourcePlatformRequest({ platformIndex, platformName: platformName ?? null, forceName,
					operationId: timingContext.getStore()?.operationId ?? timingContext.getStore()?.jobId }),
			));
			if (resp?.success) return null;
			const err = resp?.error || "Unknown unlock error";
			if (isBenignUnlockError(err)) return null;
			return err;
		} catch (err: unknown) {
			return getErrorMessage(err);
		}
	}

	async handleTransferPlatformRequest(request: { exportId: string; targetInstanceId: number; sourceInstanceId?: number | null; sourceExportId?: string | null }) {
		const resolved = this.plugin.platformTree.resolveTargetInstance(request.targetInstanceId);
		if (!resolved) {
			return { success: false, safeToUnlockSource: true, error: `Unknown instance ${request.targetInstanceId}` };
		}
		try {
			const exportId = this.plugin.platformStorage.get(request.exportId)
				? request.exportId
				: (request.sourceInstanceId && request.sourceExportId
					? makeCanonicalTransferId(Number(request.sourceInstanceId), request.sourceExportId)
					: request.exportId);
			return await this.transferPlatform(exportId, resolved.id);
		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Error transferring export ${request.exportId}: ${errMsg}`);
			const fallbackExportId = request.sourceInstanceId && request.sourceExportId
				? makeCanonicalTransferId(Number(request.sourceInstanceId), request.sourceExportId)
				: request.exportId;
			const stored = this.plugin.platformStorage.get(request.exportId) || this.plugin.platformStorage.get(fallbackExportId);
			const force = String((stored?.exportData as { platform?: { force?: string } } | undefined)?.platform?.force || "player");
			if (stored && Number.isInteger(stored.platformIndex)) {
				const rollbackError = await timed("Rollback unlock round trip", "round-trip", () => this.sendUnlockRequest(stored.instanceId, stored.platformIndex as number, force));
				if (rollbackError) {
					this.logger.error(`Rollback unlock of source #${stored.platformIndex} ('${stored.platformName}') failed: ${rollbackError}`);
				}
			}
			return { success: false, error: errMsg };
		}
	}
}
