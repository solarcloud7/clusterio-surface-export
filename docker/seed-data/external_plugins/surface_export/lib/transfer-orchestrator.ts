import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { timed, timedSync, timingContext } from "./timing";
import { wait } from "@clusterio/lib";
import { normalizeExportMetrics, getErrorMessage, isSessionLostError, isBenignUnlockError, coercePlatformIndex, DEFAULT_VALIDATION_TIMEOUT_SECONDS, MIN_VALIDATION_TIMEOUT_SECONDS, MAX_VALIDATION_TIMEOUT_SECONDS, buildPayloadMetrics, buildImportMetrics, makeCanonicalTransferId, parseCanonicalTransferId } from "../helpers";
import { createOperationRecord } from "./operation-record";
import { TransferRequestQueue, type QueueEntry, type QueuedTransferRequest } from "./transfer-request-queue";
import { hasRecordedOutcome, isAdmissionSettled, isSourceJobPending, isDestinationJobPending, isJobObservationPending } from "../shared/operation-lifecycle";
import { JobObserver } from "./job-observer";
import { isInstanceRouteRejection } from "./request-errors";
import type { JobStatusBatch } from "../shared/job-status";
import type { TimingRecord } from "../shared/timing";
import type { IControllerPlugin, ActiveTransfer, SimpleResponse, TransferValidationEvent, ValidationResult, ExportMetrics, StoredExport, PassengerManifestEntry } from "../messages";

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
	private restoredExports = new Set<string>();
	private interruptedSources = new Set<string>();
	private exportReads = new Map<string, {epoch: string; error?: string}>();
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
		this.observer = new JobObserver(async (instanceId, jobs) => {
			if (!this.plugin.isInstanceOnline(instanceId)) return {version: 1, epoch: "", observedTick: 0,
				jobs: jobs.map(ref => ({...ref, state: "unavailable" as const, error: "Instance is offline or unknown"}))};
			return this.plugin.controller.sendTo({instanceId}, new this.messages.JobsStatusRequest(jobs));
		});
		this.requestQueue = new TransferRequestQueue({
			run: entry => this.runQueuedRequest(entry),
			interrupted: async entry => {
				const retained = this.plugin.persistedTransactionLogs.find(log => log.transferId === entry.operation.transferId);
				if (retained && isAdmissionSettled(retained.transferInfo)) return;
				const untouched = entry.operation.status === "queued";
				if (!untouched) {
					const operation = entry.operation;
					this.requestQueue.entries.set(entry.id, entry);
					if (operation.transferId === entry.id && operation.status === "cleanup_failed" && operation.timingPendingRecovery) operation.status = "preparing";
					if (operation.status === "transporting") operation.status = this.requestQueue.handoffs.has(operation.transferId) ? "awaiting_validation" : "preparing";
					operation.awaitingLateVerdict = !operation.validationResult;
					operation.timingPendingRecovery = true;
					operation.jobObservation = {state: "unavailable", message: "Status unavailable", reason: "Controller restarted during admission; work will not be replayed"};
					delete operation.completedAt;
					delete operation.observedDurationMs;
					this.plugin.activeTransfers.set(operation.transferId, operation);
					if (operation.status === "preparing") this.interruptedSources.add(operation.transferId);
					await this.txLogger.persistTransactionLog(operation.transferId);
					return;
				}
				entry.operation.error = "Queue interrupted by controller restart; no export was started. Submit again to transfer.";
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
					&& !isAdmissionSettled(operation))
					.flatMap(operation => [operation.sourceInstanceId, operation.targetInstanceId]);
				for (const [id, pending] of this.plugin.pendingTransfers?.entries() || []) {
					const operation = this.plugin.activeTransfers.get(id);
					if (!operation || !owned.has(operation) || operation.timingPendingRecovery
						|| pending.sourceInstanceId !== operation.sourceInstanceId || pending.targetInstanceId !== operation.targetInstanceId
						|| hasRecordedOutcome(operation.status)) {
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

	async observeUnconfirmedExport(operation: ActiveTransfer, reason: string) {
		if (operation.status !== "in_progress") return;
		this.restoredExports.add(operation.transferId);
		operation.jobObservation = {state: "unavailable", message: "Status unavailable", reason};
		this.updateTransfer(operation);
		await this.txLogger.persistTransactionLog(operation.transferId);
	}

	restoreImportObservations() {
		for (const record of this.plugin.persistedTransactionLogs) {
			const info = record.transferInfo;
			if ((!isJobObservationPending(info.status) && info.status !== "transporting")
				|| this.plugin.activeTransfers.has(record.transferId)) continue;
			const kind = info.operationType || "transfer";
			const operation = createOperationRecord(kind, {operationId: record.transferId,
				status: kind === "import" ? "awaiting_completion" : info.status === "transporting" ? "awaiting_validation" : info.status,
				platformName: info.platformName ?? undefined, forceName: info.forceName ?? undefined,
				platformUid: info.platformUid ?? undefined,
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
			if (kind === "export") this.restoredExports.add(record.transferId);
			if (kind === "transfer" && info.status === "preparing") this.interruptedSources.add(record.transferId);
		}
	}

	async completeStoredExport(operation: ActiveTransfer, stored: StoredExport, recovered = false): Promise<void> {
		operation.platformName = stored.platformName || operation.platformName;
		operation.exportId = stored.exportId;
		operation.sourceInstanceId = stored.instanceId;
		operation.sourceInstanceName = this.plugin.platformTree.resolveInstanceName(stored.instanceId);
		operation.exportMetrics = mergeExportMetrics(stored.exportMetrics, {...operation.exportMetrics});
		operation.payloadMetrics = buildPayloadMetrics(stored.exportData || {}).payloadMetrics;
		operation.artifactSizeBytes = stored.size ?? operation.artifactSizeBytes ?? null;
		operation.status = "completed";
		operation.completedAt = Date.now();
		delete operation.jobObservation;
		if (recovered) delete operation.observedDurationMs;
		this.txLogger.logTransactionEvent(operation.transferId, "export_completed",
			recovered ? `Stored export confirmed after interrupted observation: ${stored.exportId}` : `Export ready for download: ${stored.exportId}`, {
				exportId: stored.exportId, durationMs: recovered ? null : this.txLogger.getObservedDuration(operation),
				exportMetrics: operation.exportMetrics, payloadMetrics: operation.payloadMetrics,
			});
		this.updateTransfer(operation);
		await this.txLogger.persistTransactionLog(operation.transferId);
		this.restoredExports.delete(operation.transferId);
		this.pruneOldTransfers();
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

	private async recoverExportArtifact(transfer: ActiveTransfer, epoch: string) {
		if (!transfer.sourceExportId || !epoch || !this.plugin.isInstanceOnline(transfer.sourceInstanceId)) return;
		const exportId = makeCanonicalTransferId(transfer.sourceInstanceId, transfer.sourceExportId);
		if (this.plugin.platformStorage.has(exportId)) return;
		let read = this.exportReads.get(transfer.transferId);
		const current = () => !this.stopped && this.exportReads.get(transfer.transferId) === read
			&& this.plugin.activeTransfers.get(transfer.transferId) === transfer
			&& isSourceJobPending(transfer.status)
			&& this.plugin.isInstanceOnline(transfer.sourceInstanceId)
			&& (!transfer.jobObservation?.epoch || transfer.jobObservation.epoch === epoch);
		if (read?.epoch !== epoch) {
			read = {epoch};
			this.exportReads.set(transfer.transferId, read);
			try {
				const response = await timed("Retained export retrieval round trip", "round-trip", () =>
					this.plugin.controller.sendTo({instanceId: transfer.sourceInstanceId},
						new this.messages.ReadExportRequest(transfer.sourceExportId!, epoch)));
				if (!current()) return;
				if (!response.success || response.exportId !== transfer.sourceExportId || response.epoch !== epoch || !response.exportData) {
					throw new Error(response.error || "Retained export response identity is unavailable or mismatched");
				}
				await this.plugin.handlePlatformExport(new this.messages.PlatformExportEvent({
					exportId: transfer.sourceExportId, instanceId: transfer.sourceInstanceId,
					platformIndex: transfer.platformIndex,
					platformName: response.exportData.platform_name || transfer.platformName,
					exportData: response.exportData, timestamp: Date.now(),
				}));
			} catch (error) {
				if (!current()) return;
				read.error = getErrorMessage(error);
				this.logger.warn(`Retained export ${exportId} could not be recovered: ${read.error}`);
			}
		}
		if (current() && read?.error && transfer.jobObservation && !this.plugin.platformStorage.has(exportId)) {
			transfer.jobObservation.message = "Export completed; payload unavailable";
			transfer.jobObservation.reason = read.error;
			this.updateTransfer(transfer);
		}
	}

	async waitForStoredExport(exportId: string) {
		const identity = parseCanonicalTransferId(exportId);
		for (;;) {
			if (this.stopped) throw new JobObservationStopped("Controller stopped observing; source ownership remains unresolved");
			const stored = this.plugin.platformStorage.get(exportId);
			if (stored) return stored;
			await this.observeJobs();
			const source = [...this.plugin.activeTransfers.values()].find(t => t.exportId === exportId
				|| (identity && t.sourceInstanceId === identity.sourceInstanceId && t.sourceExportId === identity.sourceJobId));
			if (source?.jobObservation?.state === "failed") throw new Error(source.jobObservation.reason || "Source export job failed");
			await wait(500);
		}
	}

	async broadcastTransferAbort(transfer: ActiveTransfer, reason: string) {
		const msg = new this.messages.TransferStatusUpdate({
			transferId: transfer.transferId,
			platformName: transfer.platformName,
			message: `Platform '${transfer.platformName}' aborted transfer: ${reason}`,
			color: "red",
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
		transfer.sourceRollback = "attempted";
		this.txLogger.logTransactionEvent(transferId, "rollback_attempt", "Unlocking source platform", {});
		let err;
		const sourceJobId = transfer.sourceExportId || parseCanonicalTransferId(transferId)?.sourceJobId;
		try {
			err = await timed("Rollback unlock round trip", "round-trip", () => this.sendUnlockRequest(
				transfer.sourceInstanceId, transfer.platformIndex, transfer.forceName || "player", sourceJobId ? undefined : transfer.platformName,
				sourceJobId,
			));
		} catch (error) {
			transfer.sourceRollback = "failed";
			throw error;
		}
		if (!err) {
			transfer.sourceRollback = "succeeded";
			this.txLogger.logTransactionEvent(transferId, "rollback_success", "Source platform unlocked", {});
			return null;
		}
		transfer.sourceRollback = "failed";
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
		const sourceExportId = exportData.sourceExportId || parseCanonicalTransferId(transferId)?.sourceJobId || transferId;
		const existingTransfer = this.plugin.activeTransfers.get(transferId);
		if (existingTransfer) {
			const live = existingTransfer.status === "transporting"
				|| existingTransfer.status === "awaiting_validation"
				|| existingTransfer.status === "awaiting_completion"
				|| existingTransfer.status === "in_progress";
			if (live) {
				if (existingTransfer.targetInstanceId !== targetInstanceId
					|| (this.requestQueue.handoffs.has(transferId) && this.requestQueue.handoffs.get(transferId)?.destination !== targetInstanceId)) {
					return { success: false, safeToUnlockSource: false,
						error: `Transfer ${transferId} is already active for destination ${existingTransfer.targetInstanceId}` };
				}
				return { success: true, transferId, message: `Transfer already active: ${transferId}` };
			}
		}
		if (existingTransfer || this.requestQueue.handoffs.has(transferId) || this.plugin.pendingTransfers?.has(transferId)
			|| this.plugin.auditIndex?.has(transferId)
			|| this.plugin.persistedTransactionLogs?.some(log => log.transferId === transferId)) {
			return {success: false, safeToUnlockSource: false,
				error: `Export ${transferId} already belongs to a handoff.${existingTransfer?.validationResult?.destinationPreserved ? " Its destination was PRESERVED." : ""} Create a NEW export, or use Restore from snapshot for deliberate recovery.`};
		}
		if ([exportData.instanceId, targetInstanceId].some(id => this.plugin.recoveryReservations?.has(id))) {
			return { success: false, error: "Instance is reconciling its loaded save; retry after recovery completes",
				safeToUnlockSource: !this.plugin.recoveryReservations?.has(exportData.instanceId) };
		}
		if (!this.plugin.isInstanceOnline(targetInstanceId)) {
			const name = this.plugin.platformTree.resolveInstanceName(targetInstanceId);
			return { success: false, safeToUnlockSource: true, error:
				`Destination instance ${name ? `"${name}" ` : ""}(${targetInstanceId}) is offline — `
				+ "transfer refused before starting. The source platform is unchanged; retry when the "
				+ "destination is running." };
		}
		for (const [instanceId, role] of [[exportData.instanceId, "source"], [targetInstanceId, "destination"]] as const) {
			const refusal = await this.plugin.autoPauseRefusal(instanceId, role);
			if (refusal) return { success: false, safeToUnlockSource: true, error: `${refusal} The source platform is unchanged.` };
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
			platformUid: typeof exportData.exportData.platform_uid === "string" ? exportData.exportData.platform_uid : undefined,
			platformIndex: sourcePlatformIndex,
			forceName: String(innerData.force_name || platformInfo.force || "player"),
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
		await this.txLogger.archiveRecycledTransferId(transferId, operation.startedAt);
		if (queued) {
			operation.queuedRequestId = queued.id;
			operation.startedAt = queued.operation.startedAt;
			if (queued.operation.timing) operation.timing = { v: 1, records: queued.operation.timing.records.map(record => ({
				...record, operationId: record.operationId === queued.id ? transferId : record.operationId,
			})) };
			const previous = queued.operation;
			queued.operation = operation;
			try { await this.requestQueue.persist(); }
			catch (error) { queued.operation = previous; throw error; }
			this.plugin.activeTransfers.delete(queued.id);
			this.plugin.transactionLogs.delete(queued.id);
			this.plugin.persistedTransactionLogs = this.plugin.persistedTransactionLogs.filter(log => log.transferId !== queued.id);
		}
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
		let dispatchAttempted = false;
		try {
			await this.requestQueue.claimHandoff(transferId, targetInstanceId);
			this.txLogger.startPhase(transferId, "transmission");
			dispatchAttempted = true;
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
			if (this.requestQueue.admissionError) {
				transfer.timingPendingRecovery = true;
				return {success: false, safeToUnlockSource: false, error: this.requestQueue.admissionError};
			}
			if (dispatchAttempted && !isInstanceRouteRejection(err)) {
				const transmissionMs = this.txLogger.endPhase(transferId, "transmission");
				this.enterAwaitingValidation(transfer, transferId);
				this.txLogger.logTransactionEvent(transferId, "import_delivery_uncertain",
					`Import delivery unconfirmed (${errMsg}); source protection retained pending validation`,
					{ error: errMsg, transmissionMs });
				return { success: true, transferId, message: `Transfer initiated (delivery unconfirmed; awaiting validation): ${transferId}` };
			}
			return this.handleImportFailure(transferId, errMsg, this.txLogger.endPhase(transferId, "transmission"));
		}
	}

	async handleImportFailure(transferId: string, error: string, transmissionMs: number) {
		const pending = this.settlingTransfers.get(transferId);
		if (pending) { await pending; return {success: false, error}; }
		const work = Promise.resolve().then(() => this.handleImportFailureMeasured(transferId, error, transmissionMs));
		this.settlingTransfers.set(transferId, work);
		try { await work; } finally { this.settlingTransfers.delete(transferId); }
		return {success: false, error};
	}

	private async handleImportFailureMeasured(transferId: string, error: string, transmissionMs: number) {
		const transfer = this.plugin.activeTransfers.get(transferId);
		if (!transfer) return;

		transfer.timingPendingRecovery = true;
		transfer.status = "preparing";
		transfer.error = error || "Import failed";
		transfer.sourceExportId ||= parseCanonicalTransferId(transferId)?.sourceJobId || transferId;
		this.interruptedSources.add(transferId);
		this.txLogger.logTransactionEvent(transferId, "import_failed",
			`Import failed: ${error}`, { error, transmissionMs });
		await this.requestQueue.cancelHandoff(makeCanonicalTransferId(transfer.sourceInstanceId, transfer.sourceExportId), transfer.targetInstanceId, transferId);
		await this.reconcileInterruptedSourceMeasured(transfer);
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

	async observeJobs(): Promise<void> {
		for (const id of this.exportReads.keys()) {
			const transfer = this.plugin.activeTransfers.get(id);
			if (!transfer || !isSourceJobPending(transfer.status)) this.exportReads.delete(id);
		}
		if (this.stopped) return;
		const groups = new Map<number, ActiveTransfer[]>();
		for (const transfer of this.plugin.activeTransfers.values()) {
			if (this.restoredExports.has(transfer.transferId) && transfer.sourceExportId
				&& isSourceJobPending(transfer.status)) {
				const id = makeCanonicalTransferId(transfer.sourceInstanceId, transfer.sourceExportId);
				const stored = this.plugin.platformStorage.get(id);
				if (stored?.exportId === id && stored.instanceId === transfer.sourceInstanceId
					&& stored.sourceExportId === transfer.sourceExportId) {
					await this.completeStoredExport(transfer, stored, true);
				}
			}
			const observingSource = isSourceJobPending(transfer.status);
			if (!observingSource && !isDestinationJobPending(transfer.status)) {
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
				const response = await this.observer.poll(instanceId, transfers.map(t => isSourceJobPending(t.status)
					? (t.sourceExportId ? {jobId: t.sourceExportId} : {operationId: t.transferId})
					: {operationId: t.transferId, jobId: t.destinationJobId}));
				if (!response) return;
				batch = response;
				requested = response.requested;
			} catch (error) {
				batch = {version: 1, epoch: "", observedTick: 0, jobs: transfers.map(t => ({jobId: t.sourceExportId || undefined, operationId: t.transferId, state: "unavailable", error: getErrorMessage(error)}))};
			}
			for (const transfer of transfers) {
				if (requested && !requested.some(ref => ref.operationId === transfer.transferId
					|| (ref.jobId && ref.jobId === transfer.sourceExportId))) continue;
				if (this.plugin.activeTransfers.get(transfer.transferId) !== transfer || !isJobObservationPending(transfer.status)) continue;
				const status = batch.jobs.find(job => isSourceJobPending(transfer.status)
					? (transfer.sourceExportId ? job.jobId === transfer.sourceExportId : job.operationId === transfer.transferId)
					: job.operationId === transfer.transferId) || {state: "unavailable" as const};
				if (isSourceJobPending(transfer.status) && !transfer.sourceExportId
					&& status.jobId && status.operationId === transfer.transferId && status.state !== "unavailable") {
					transfer.sourceExportId = status.jobId;
					await this.txLogger.persistTransactionLog(transfer.transferId);
				}
				if (this.interruptedSources.has(transfer.transferId) && transfer.sourceExportId
					&& ["completed", "failed"].includes(status.state)) {
					await this.reconcileInterruptedSource(transfer);
					continue;
				}
				const observation = this.observer.observe(transfer.transferId, {...status, epoch: batch.epoch}, this.getValidationTimeoutMs());
				if (JSON.stringify(transfer.jobObservation) !== JSON.stringify(observation)) {
					transfer.jobObservation = observation;
					this.updateTransfer(transfer);
				}
				const result = status.completion;
				if (isSourceJobPending(transfer.status) && transfer.sourceExportId && status.state === "completed") {
					await this.recoverExportArtifact(transfer, batch.epoch);
				}
				if (this.restoredExports.has(transfer.transferId) && status.state === "failed") {
					transfer.status = "failed";
					transfer.failedAt = Date.now();
					transfer.error = status.error || "Source export job failed";
					this.txLogger.logTransactionEvent(transfer.transferId, "export_failed", "Source export failure confirmed after controller restart", {error: transfer.error});
					this.updateTransfer(transfer);
					await this.txLogger.persistTransactionLog(transfer.transferId);
					this.restoredExports.delete(transfer.transferId);
				} else if (transfer.operationType === "transfer" && result?.transfer_id === transfer.transferId
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

	private async reconcileInterruptedSource(transfer: ActiveTransfer): Promise<void> {
		const pending = this.settlingTransfers.get(transfer.transferId);
		if (pending) return pending;
		const work = this.reconcileInterruptedSourceMeasured(transfer);
		this.settlingTransfers.set(transfer.transferId, work);
		try { await work; } finally { this.settlingTransfers.delete(transfer.transferId); }
	}

	private async reconcileInterruptedSourceMeasured(transfer: ActiveTransfer) {
		if (this.requestQueue.admissionError) return;
		const canonical = makeCanonicalTransferId(transfer.sourceInstanceId, transfer.sourceExportId!);
		const binding = this.requestQueue.handoffs.get(canonical);
		if (this.startingTransfers.has(canonical) && binding?.cancelledBy !== transfer.transferId) return;
		if (binding && binding.cancelledBy !== transfer.transferId) {
			const tracked = this.plugin.activeTransfers.get(canonical);
			if (!tracked || tracked === transfer) return;
			transfer.error = `Admission continued as ${canonical}; inspect that transfer for its outcome`;
		} else {
			if (!binding) await this.requestQueue.claimHandoff(canonical, transfer.targetInstanceId, transfer.transferId);
			const error = await this.tryUnlockSource(transfer.transferId, transfer);
			if (error) {
				transfer.jobObservation = {state: "unavailable", message: "Source cleanup needs attention", reason: error};
				this.updateTransfer(transfer);
				await this.txLogger.persistTransactionLog(transfer.transferId);
				return;
			}
			transfer.error = "Transfer stopped before import admission. Source export resolved and unlocked; submit a new transfer.";
		}
		transfer.status = "failed";
		transfer.failedAt = Date.now();
		transfer.timingPendingRecovery = false;
		transfer.awaitingLateVerdict = false;
		delete transfer.jobObservation;
		this.interruptedSources.delete(transfer.transferId);
		this.txLogger.logTransactionEvent(transfer.transferId, "admission_reconciled", transfer.error, {canonicalTransferId: canonical});
		this.updateTransfer(transfer);
		await this.txLogger.persistTransactionLog(transfer.transferId);
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
		}
	}

	async handleValidationSuccess(transferId: string, transfer: ActiveTransfer) {
		this.txLogger.startPhase(transferId, "cleanup");
		const gate = (action: "verify" | "go_live", passengers?: PassengerManifestEntry[]) => timed("Destination transfer gate round trip", "round-trip", () =>
			this.plugin.controller.sendTo({ instanceId: transfer.targetInstanceId },
				new this.messages.DestinationTransferGateRequest({ transferId, action, passengers })));
		const failed = async (error: string) => {
			this.txLogger.endPhase(transferId, "cleanup");
			if (transfer.status === "cleanup_failed" && transfer.error === error) return { sourceResolved: false };
			transfer.status = "cleanup_failed";
			transfer.error = error;
			transfer.completedAt = Date.now();
			this.txLogger.logTransactionEvent(transferId, "cleanup_failed", error);
			this.updateTransfer(transfer);
			await this.txLogger.persistTransactionLog(transferId);
			return { sourceResolved: false };
		};
		try {
			await this.plugin.persistPendingTransfers(transferId);
			const held = await gate("verify");
			if (!held.success && transfer.awaitingLateVerdict) {
				this.txLogger.endPhase(transferId, "cleanup");
				return {sourceResolved: false};
			}
			if (!held.success) return failed(`Destination hold not confirmed: ${held.error}`);
			transfer.awaitingLateVerdict = false;

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
				const replayed = (deleteResponse as { passengers?: unknown }).passengers;
				if (Array.isArray(replayed)) transfer.passengers = replayed as PassengerManifestEntry[];
				const activated = await gate("go_live", transfer.passengers);
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
				await this.txLogger.persistTransactionLog(transferId);
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

		const rollbackError = await this.tryUnlockSource(transferId, transfer);
		if (!rollbackError && !destinationCleanupError) transfer.timingPendingRecovery = false;

		transfer.status = destinationCleanupError ? "cleanup_failed" : "failed";
		transfer.error = [errorMsg, rollbackError, destinationCleanupError].filter(Boolean).join("; ");
		await this.broadcastTransferAbort(transfer, transfer.error);
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
		const sorted = [...this.plugin.activeTransfers.entries()].filter(([id, transfer]) =>
			["completed", "failed", "error"].includes(transfer.status) && !transfer.timingPendingRecovery
			&& !transfer.awaitingLateVerdict && !this.plugin.pendingTransfers?.has(id)
			&& !transfer.validationResult?.destinationPreserved && !transfer.validationResult?.cleanup_failed);
		sorted.sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0));
		for (let i = 100; i < sorted.length; i++) {
			this.plugin.activeTransfers.delete(sorted[i][0]);
			this.observationDue.delete(sorted[i][0]);
			this.observer.forget(sorted[i][0]);
		}
	}


	async handleStartPlatformTransferRequest(request: QueuedTransferRequest): Promise<TransferStartResult> {
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
		for (const [instanceId, role] of [[source.id, "source"], [target.id, "destination"]] as const) {
			const refusal = await this.plugin.autoPauseRefusal(instanceId, role);
			if (refusal) return reject(`${refusal} Nothing was locked or exported.`);
		}
		const existing = this.requestQueue.find(request);
		if (existing) {
			if (request.sourcePlatformUid && existing.request.sourcePlatformUid !== request.sourcePlatformUid) {
				return reject("Source platform identity changed; refresh before transferring");
			}
			if (existing.request.targetInstanceId !== request.targetInstanceId || (existing.request.targetPlanet ?? null) !== (request.targetPlanet ?? null)) {
				return reject("This platform is already queued or transferring to another destination");
			}
			try { await this.queueAdmissions.get(existing.id); }
			catch (error) { return { success: false, error: getErrorMessage(error) }; }
			return { success: true, transferId: existing.operation.transferId, message: "Transfer already queued or active" };
		}
		if ([...this.plugin.activeTransfers.values()].some(operation => operation.sourceInstanceId === source.id
			&& operation.platformIndex === request.sourcePlatformIndex && operation.forceName === (request.forceName || "player")
			&& !hasRecordedOutcome(operation.status))) {
			return reject("This platform already has an active transfer");
		}
		const observationId = `request:${randomUUID()}`;
		try {
			request = { ...request, sourcePlatformUid: await this.plugin.platformTree.resolvePlatformUid(source.id,
				request.sourcePlatformIndex, request.forceName || "player", request.sourcePlatformUid) };
		} catch (error) { return reject(getErrorMessage(error)); }
		if (this.requestQueue.find(request)) return this.handleStartPlatformTransferRequest(request);
		this.txLogger.beginObservation(observationId);
		const operation = createOperationRecord("transfer", { operationId: observationId, status: "queued",
			platformName: request.platformName || `Platform #${request.sourcePlatformIndex}`, platformIndex: request.sourcePlatformIndex,
			platformUid: request.sourcePlatformUid,
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
			if (!result.success && !hasRecordedOutcome(entry.operation.status)) {
				// A canonical operation with no terminal result may already have reached the destination.
				// Keep its reservation until recovery is resolved; an exception is not a cleanup acknowledgement.
				if (entry.operation.transferId !== entry.id) entry.operation.timingPendingRecovery = true;
				entry.operation.status = entry.operation.timingPendingRecovery
					? (this.interruptedSources.has(entry.operation.transferId) ? "preparing" : "cleanup_failed") : "failed";
				entry.operation.error = result.error || "Transfer request failed";
				if (!entry.operation.timingPendingRecovery) entry.operation.failedAt = Date.now();
				this.txLogger.logTransactionEvent(entry.operation.transferId, "transfer_failed", entry.operation.error, {});
				this.updateTransfer(entry.operation);
				await this.txLogger.persistTransactionLog(entry.operation.transferId);
			}
		} catch (error) {
			if (entry.operation.transferId !== entry.id) entry.operation.timingPendingRecovery = true;
			entry.operation.status = this.interruptedSources.has(entry.operation.transferId) ? "preparing" : "error";
			entry.operation.error = getErrorMessage(error);
			if (!entry.operation.timingPendingRecovery) entry.operation.failedAt = Date.now();
			this.txLogger.logTransactionEvent(entry.operation.transferId, "queue_error", entry.operation.error, {});
			this.updateTransfer(entry.operation);
			await this.txLogger.persistTransactionLog(entry.operation.transferId);
		}
		await this.requestQueue.persist();
	}

	async handleStartPlatformTransferRequestMeasured(request: QueuedTransferRequest, observationId: string) {
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
		for (const [instanceId, role] of [[sourceInstanceId, "source"], [resolvedTarget.id, "destination"]] as const) {
			const refusal = await this.plugin.autoPauseRefusal(instanceId, role);
			if (refusal) return { success: false, error: `${refusal} Nothing was locked or exported.` };
		}

		let sourceJobId: string | undefined;
		let exportReplyReceived = false;
		try {
			const t0 = Date.now();
			const exportStart = performance.now();
			const exportResponse = await timed("Clusterio request round trip", "round-trip", () => this.plugin.controller.sendTo(
				{ instanceId: sourceInstanceId },
				new this.messages.ExportPlatformRequest({
					operationId: observationId,
					platformIndex: sourcePlatformIndex,
					platformUid: request.sourcePlatformUid,
					forceName,
					targetInstanceId: resolvedTarget.id,
				}),
			)) as SimpleResponse & { exportId?: string; admissionUncertain?: boolean };
			exportReplyReceived = true;
			const exportRequestMs = performance.now() - exportStart;
			if (!exportResponse || exportResponse.admissionUncertain || (exportResponse.success && !exportResponse.exportId)) {
				this.interruptedSources.add(observationId);
				const operation = this.plugin.activeTransfers.get(observationId);
				if (operation) {
					operation.timingPendingRecovery = true;
					operation.jobObservation = {state: "unavailable", message: "Status unavailable", reason: exportResponse?.error};
					await this.txLogger.persistTransactionLog(observationId);
				}
				return {success: true, message: "Source admission is unconfirmed; awaiting job status"};
			}
			if (!exportResponse?.success || !exportResponse.exportId) {
				return { success: false, error: exportResponse?.error || "Export failed" };
			}

			const t1 = performance.now();
			sourceJobId = exportResponse.exportId;
			const canonicalExportId = makeCanonicalTransferId(sourceInstanceId, exportResponse.exportId);
			const queued = this.plugin.activeTransfers.get(observationId);
			if (queued) {
				queued.sourceExportId = exportResponse.exportId;
				await this.txLogger.persistTransactionLog(observationId);
				await this.requestQueue.persist();
			}
			this.txLogger.bindObservation(observationId, canonicalExportId);
			await timed("Await artifact storage", "wait", () => this.waitForStoredExport(canonicalExportId));
			const waitForStoredMs = performance.now() - t1;

			const result = await this.transferPlatform(canonicalExportId, resolvedTarget.id, {
				requestExportAndLockMs: exportRequestMs,
				waitForControllerStoreMs: waitForStoredMs,
				controllerExportPrepTotalMs: exportRequestMs + waitForStoredMs,
			}, t0, request.targetPlanet ?? null);
			if (!result.success && result.safeToUnlockSource) {
				await this.requestQueue.claimHandoff(canonicalExportId, resolvedTarget.id, observationId);
				const rollbackError = await timed("Rollback unlock round trip", "round-trip", () => this.sendUnlockRequest(sourceInstanceId, sourcePlatformIndex, forceName, undefined, sourceJobId));
				if (rollbackError) {
					if (queued) { queued.timingPendingRecovery = true; this.interruptedSources.add(observationId); }
					this.logger.error(`Unlock after refused transfer of #${sourcePlatformIndex} failed: ${rollbackError}`);
					return { ...result, error: `${result.error}; rollback failed: ${rollbackError}`,
						exportId: canonicalExportId, sourceExportId: exportResponse.exportId };
				}
			}
			return { ...result, exportId: canonicalExportId, sourceExportId: exportResponse.exportId };
		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Error starting transfer (source instance ${sourceInstanceId}, platform #${sourcePlatformIndex}): ${errMsg}`);
			if (sourceJobId || err instanceof JobObservationStopped || isSessionLostError(err) || (!exportReplyReceived && !isInstanceRouteRejection(err))) {
				const operation = this.plugin.activeTransfers.get(observationId)
					|| (sourceJobId ? this.plugin.activeTransfers.get(makeCanonicalTransferId(sourceInstanceId, sourceJobId)) : undefined);
				if (operation) {
					if (operation.transferId === observationId || !sourceJobId || !this.requestQueue.handoffs.has(makeCanonicalTransferId(sourceInstanceId, sourceJobId))) {
						operation.status = "preparing";
						this.interruptedSources.add(operation.transferId);
					}
					operation.jobObservation = {state: "unavailable", message: "Status unavailable", reason: errMsg};
					operation.timingPendingRecovery = true;
					this.updateTransfer(operation);
					await this.txLogger.persistTransactionLog(operation.transferId);
				}
				return {success: true, message: "Source status unavailable; protections retained"};
			}
			return { success: false, error: errMsg };
		}
	}

	private async sendUnlockRequest(sourceInstanceId: number, platformIndex: number, forceName: string, platformName?: string, sourceJobId?: string): Promise<string | null> {
		if (coercePlatformIndex(platformIndex) === null) return `invalid platformIndex: ${String(platformIndex)}`;
		try {
			const resp = await timed("Clusterio request round trip", "round-trip", () => this.plugin.controller.sendTo(
				{ instanceId: sourceInstanceId },
				new this.messages.UnlockSourcePlatformRequest({ platformIndex, platformName: platformName ?? null, forceName,
					operationId: sourceJobId ? makeCanonicalTransferId(sourceInstanceId, sourceJobId)
						: timingContext.getStore()?.operationId ?? timingContext.getStore()?.jobId }),
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
				const rollbackError = await timed("Rollback unlock round trip", "round-trip", () => this.sendUnlockRequest(stored.instanceId, stored.platformIndex as number, force, undefined,
					stored.sourceExportId || parseCanonicalTransferId(stored.exportId)?.sourceJobId));
				if (rollbackError) {
					this.logger.error(`Rollback unlock of source #${stored.platformIndex} ('${stored.platformName}') failed: ${rollbackError}`);
				}
			}
			return { success: false, error: errMsg };
		}
	}
}
