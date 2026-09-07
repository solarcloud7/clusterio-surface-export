import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { timed, timedSync, timingContext } from "./timing";
import { wait } from "@clusterio/lib";
import { normalizeExportMetrics, getErrorMessage, isSessionLostError, isBenignUnlockError, coercePlatformIndex, DEFAULT_VALIDATION_TIMEOUT_SECONDS, MIN_VALIDATION_TIMEOUT_SECONDS, MAX_VALIDATION_TIMEOUT_SECONDS, buildPayloadMetrics, buildImportMetrics, makeCanonicalTransferId, parseCanonicalTransferId } from "../helpers";
import { createOperationRecord } from "./operation-record";
import { TransferRequestQueue, type QueueEntry, type QueuedTransferRequest } from "./transfer-request-queue";
import type { TimingRecord } from "../shared/timing";
import type { IControllerPlugin, ActiveTransfer, SimpleResponse, TransferValidationEvent, StoredExport, ValidationResult, ImportMetrics, ExportMetrics } from "../messages";

type TransferStartResult = {
	success: boolean; error?: string; transferId?: string; message?: string;
	safeToUnlockSource?: boolean;
};

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
	private startingTransfers = new Map<string, { targetInstanceId: number; result: Promise<TransferStartResult> }>();
	readonly requestQueue: TransferRequestQueue;
	private queueWaits = new Map<string, TimingRecord>();
	private queueAdmissions = new Map<string, Promise<void>>();

	constructor(plugin: IControllerPlugin, messages: typeof import("../messages")) {
		this.plugin = plugin;
		this.messages = messages;
		this.requestQueue = new TransferRequestQueue({
			run: entry => this.runQueuedRequest(entry),
			interrupted: async entry => {
				const retained = this.plugin.persistedTransactionLogs.find(log => log.transferId === entry.operation.transferId);
				if (retained && ["completed", "failed", "error", "cleanup_failed"].includes(retained.transferInfo.status)) return;
				const untouched = entry.operation.status === "queued";
				entry.operation.error = untouched ? "Queue interrupted by controller restart; no export was started. Submit again to transfer."
					: "Controller restarted during transfer admission; outcome unknown. Inspect source and destination before retrying.";
				entry.operation.status = "error";
				entry.operation.failedAt = Date.now();
				this.plugin.activeTransfers.set(entry.operation.transferId, entry.operation);
				this.txLogger.logTransactionEvent(entry.operation.transferId, "queue_interrupted", entry.operation.error, {});
				await this.txLogger.persistTransactionLog(entry.operation.transferId);
			},
			busyInstances: () => {
				const busy = [...this.plugin.activeTransfers.values()].filter(operation => operation.status !== "queued"
					&& (!["completed", "failed", "error", "cleanup_failed"].includes(operation.status) || operation.timingPendingRecovery))
					.flatMap(operation => [operation.sourceInstanceId, operation.targetInstanceId]);
				for (const pending of this.plugin.pendingTransfers?.values() || []) busy.push(pending.sourceInstanceId, pending.targetInstanceId);
				return busy;
			},
			error: error => this.logger.error(`Transfer queue: ${getErrorMessage(error)}`),
		});
	}

	get logger() { return this.plugin.logger; }
	get txLogger() { return this.plugin.txLogger; }
	get subscriptions() { return this.plugin.subscriptions; }

	async waitForStoredExport(exportId: string, timeoutMs = 10000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const stored = this.plugin.platformStorage.get(exportId);
			if (stored) return stored;
			await wait(100);
		}
		throw new Error(`Timed out waiting for export ${exportId} to be stored on controller`);
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

			if (!response.success) {
				return await this.handleImportFailure(transferId, response.error || "Import failed", transmissionMs);
			}

			importAccepted = true;
			this.enterAwaitingValidation(transfer, transferId);
			this.txLogger.logTransactionEvent(transferId, "import_started",
				`Awaiting validation (timeout: ${(transfer.armedValidationTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_SECONDS * 1000) / 1000}s)`, { transmissionMs });

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
				+ `[${MIN_VALIDATION_TIMEOUT_SECONDS}, ${MAX_VALIDATION_TIMEOUT_SECONDS}] — using ${clamped}s `
				+ "(the ceiling is the validation share budgeted by the source-lock TTL floor)");
		}
		return clamped * 1000;
	}

	scheduleValidationTimeout(transferId: string) {
		const transfer = this.plugin.activeTransfers.get(transferId);
		if (!transfer) return;
		const timeoutMs = this.getValidationTimeoutMs();
		transfer.armedValidationTimeoutMs = timeoutMs;

		transfer.validationTimeout = setTimeout(async () => {
			const current = this.plugin.activeTransfers.get(transferId);
			if (!current || current.status !== "awaiting_validation") return;

			this.txLogger.logTransactionEvent(transferId, "validation_timeout",
				`No validation response within ${timeoutMs / 1000}s `
				+ "(setting: surface_export.transfer_validation_timeout_seconds)", { timeoutMs });
			await this.handleTransferValidation(new this.messages.TransferValidationEvent({
				transferId,
				success: false,
				platformName: current.platformName,
				sourceInstanceId: current.sourceInstanceId,
				validation: {
					itemCountMatch: false,
					fluidCountMatch: false,
					mismatchDetails: `Validation timeout - no response received within ${timeoutMs / 1000}s`,
				},
			}));
		}, timeoutMs);
	}


	async handleTransferValidation(event: TransferValidationEvent) {
		return timingContext.run(this.txLogger.clock(event.transferId), () =>
			timed("Destination verdict handling", "inclusive", () => this.handleTransferValidationMeasured(event)));
	}

	private async handleTransferValidationMeasured(event: TransferValidationEvent) {
		const settled = this.plugin.activeTransfers.get(event.transferId);
		if (settled && settled.status !== "awaiting_validation") {
			const verdict = event.success ? "SUCCESS" : "FAILURE";
			const priorStatus = settled.status;
			let disposition = "Record unchanged.";
			if (event.success && priorStatus === "failed") {
				settled.status = "cleanup_failed";
				settled.error = [settled.error, "late import SUCCESS after rollback: the destination holds a live copy — delete one copy before retrying"]
					.filter(Boolean).join("; ");
				this.updateTransfer(settled);
				disposition = "The destination holds a LIVE copy of a platform whose source was already "
					+ "returned to the player; the transfer is re-marked cleanup_failed so retries are "
					+ "refused — resolve manually (delete one copy).";
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
		await this.broadcastTransferStatus(transfer, "Validation passed ✓ — deleting source...", "green");

		const deleteResponse = await timed("Clusterio request round trip", "round-trip", () => this.plugin.controller.sendTo(
			{ instanceId: transfer.sourceInstanceId },
			new this.messages.DeleteSourcePlatformRequest({
				platformIndex: transfer.platformIndex,
				platformName: transfer.platformName,
				forceName: transfer.forceName,
				exportId: transfer.sourceExportId ?? transfer.exportId ?? null,
			}),
		));
		const cleanupMs = this.txLogger.endPhase(transferId, "cleanup");

		if (deleteResponse.success) {
			transfer.status = "completed";
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
			if (transfer.exportId) {
				this.plugin.platformStorage.delete(transfer.exportId);
			}
			await this.plugin.persistStorage();
			this.subscriptions.queueTreeBroadcast(transfer.forceName || "player");
			return { sourceResolved: true };
		}
		this.logger.error(`Failed to delete source platform: ${deleteResponse.error}`);
		transfer.status = "cleanup_failed";
		transfer.error = deleteResponse.error;
		this.updateTransfer(transfer);
		await this.broadcastTransferStatus(transfer, `⚠ Cleanup failed: ${deleteResponse.error}`, "yellow");
		return { sourceResolved: false };
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
				entry.operation.status = "failed";
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
