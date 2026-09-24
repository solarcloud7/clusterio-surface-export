import { randomUUID } from "node:crypto";
import { unavailableEvidence } from "./lib/entity-evidence";
import { performance } from "node:perf_hooks";
import { timed, timedSync, timingContext } from "./lib/timing";
import fs from "fs/promises";
import path from "path";
import { BaseControllerPlugin } from "@clusterio/controller";
import type { Controller, InstanceRecord } from "@clusterio/controller";
import * as lib from "@clusterio/lib";
import { GatewayConfig } from "./lib/gateway-config";
import { PlatformTree, instanceAddress } from "./lib/platform-tree";
import { TransactionLogger } from "./lib/transaction-logger";
import { SubscriptionManager } from "./lib/subscription-manager";
import { enqueueWrite } from "./lib/persist-queue";
import { buildAuditRow } from "./lib/audit-ledger";
import { canonicalizeStoredExport, loadStoredExports, persistStoredExports } from "./lib/export-storage";
import { loadControllerAudit, migrateControllerAudit, recordControllerAuditRow } from "./lib/controller-audit";
import type { AuditRow } from "./lib/audit-ledger";
import { TransferOrchestrator, JobObservationStopped } from "./lib/transfer-orchestrator";
import { isInstanceRouteRejection } from "./lib/request-errors";
import { createOperationRecord as buildOperationRecord } from "./lib/operation-record";
import { recoveryMode, hasUnresolvedOwnership, protectedSourceIndexes, type PlatformSourceOfTruth } from "./shared/recovery";
import { importableSnapshot } from "./shared/snapshot";
import type {
	IControllerPlugin,
	ActiveTransfer,
	ExportData,
	OperationOptions,
	OperationType,
	SubscriptionState,
	StoredExport,
	TransactionLogEntryModel,
	PersistedTransactionLog,
} from "./messages";
import * as messages from "./messages";
import { normalizeExportMetrics, getErrorMessage, generateOperationId, STORAGE_FILENAME, buildImportMetrics, makeCanonicalTransferId } from "./helpers";

const PLUGIN_NAME = "surface_export";

export class ControllerPlugin extends BaseControllerPlugin {
	private get c(): Controller { return this.controller; }
	private cfg<T = unknown>(key: string): T {
		return (this.controller.config as { get(k: string): unknown }).get(key) as T;
	}

	platformStorage!: Map<string, StoredExport>;
	activeTransfers!: Map<string, ActiveTransfer>;
	platformDepartureTimes!: Map<string, number>;
	transactionLogs!: Map<string, TransactionLogEntryModel[]>;
	persistedTransactionLogs!: PersistedTransactionLog[];
	surfaceExportSubscriptions!: Map<{ send: (event: unknown) => void; user: { checkPermission: (permission: string) => void } }, SubscriptionState>;
	treeRevision!: number;
	transferRevision!: number;
	logRevision!: number;
	lastTreeForceName!: string;
	storagePath!: string;
	storageLoadError!: string | null;
	consecutiveStorageWriteFailures!: number;
	transactionLogPath!: string;
	auditLedgerPath!: string;
	auditIndex!: Map<string, AuditRow>;
	auditRevisions!: Map<string, number>;
	transactionLogLoadError!: string | null;
	platformTree!: PlatformTree;
	txLogger!: TransactionLogger;
	subscriptions!: SubscriptionManager;
	orchestrator!: TransferOrchestrator;
	pendingTransfers!: Map<string, messages.PendingTransferIntent>;
	pendingTransfersPath!: string;
	private recoveryTimer?: ReturnType<typeof setInterval>;
	pendingTransfersLoadError: string | null = null;
	recoveryReservations = new Map<number, { epoch: string; mode: PlatformSourceOfTruth; allowAdoption: boolean; protectedSourceIndexes: number[] }>();
	private snapshotRequests = new Map<string, {signature: string; result: Promise<messages.SimpleResponse>}>();
	private importCompletions = new Map<string, Promise<void>>();
	private playerLocations = new Map<string, number>();
	private playerLocationsPath?: string;

	async loadPlayerLocations(file: string): Promise<void> {
		this.playerLocationsPath = file;
		this.playerLocations = new Map();
		try {
			const saved = JSON.parse(await fs.readFile(file, "utf8"));
			if (saved?.version !== 1 || !Array.isArray(saved.locations) || saved.locations.some((entry: unknown) =>
				!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !entry[0]
				|| !Number.isSafeInteger(entry[1]) || entry[1] < 0)) throw new Error("Invalid player location history");
			this.playerLocations = new Map(saved.locations.map(([name, id]: [string, number]) => [name.toLowerCase(), id]));
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				this.playerLocationsPath = undefined;
				this.logger.warn(`Player travel history unavailable: ${getErrorMessage(error)}`);
			}
		}
	}

	private async persistPlayerLocations(): Promise<void> {
		const file = this.playerLocationsPath;
		if (!file) return;
		const payload = JSON.stringify({version: 1, locations: [...this.playerLocations]});
		try { await enqueueWrite(file, () => lib.safeOutputFile(file, payload)); }
		catch (error: unknown) { this.logger.warn(`Player travel history could not be saved: ${getErrorMessage(error)}`); }
	}

	override async onPlayerEvent(instance: InstanceRecord, event: lib.PlayerEvent): Promise<void> {
		const playerKey = event.name.toLowerCase();
		const previousId = this.playerLocations.get(playerKey);
		if (event.type === "leave") {
			if (previousId === undefined) {
				this.playerLocations.set(playerKey, instance.id);
				await this.persistPlayerLocations();
			}
			return;
		}
		if (event.type !== "join") return;
		this.playerLocations.set(playerKey, instance.id);
		if (previousId !== instance.id) await this.persistPlayerLocations();
		if (previousId === undefined || previousId === instance.id) return;
		const previous = this.c.instances.get(previousId);
		if (!previous || previous.isDeleted || !instance.config.get("surface_export.load_plugin")) return;
		void Promise.resolve().then(() => this.c.sendTo({ instanceId: instance.id }, new messages.AnnouncePlayerTravelRequest(
				event.name, String(previous.config.get("instance.name")), String(instance.config.get("instance.name")),
			))).then(result => {
			if (!result.success) this.logger.warn(`Player travel announcement skipped: ${result.error}`);
		}).catch((error: unknown) => {
			this.logger.warn(`Player travel announcement unavailable: ${getErrorMessage(error)}`);
		});
	}

	override async init() {
		this.logger.info("Surface Export controller plugin initializing...");

		this.platformStorage = new Map();
		this.activeTransfers = new Map();
		this.platformDepartureTimes = new Map();
		this.transactionLogs = new Map();
		this.persistedTransactionLogs = [];
		this.surfaceExportSubscriptions = new Map();
		this.treeRevision = 0;
		this.transferRevision = 0;
		this.logRevision = 0;
		this.lastTreeForceName = "player";
		this.storageLoadError = null;
		this.consecutiveStorageWriteFailures = 0;

		this.storagePath = path.resolve(
			String(this.c.config.get("controller.database_directory")),
			STORAGE_FILENAME,
		);
		this.transactionLogPath = path.resolve(
			String(this.c.config.get("controller.database_directory")),
			"surface_export_transaction_logs.json",
		);
		this.auditLedgerPath = path.resolve(
			String(this.c.config.get("controller.database_directory")),
			"surface_export_transaction_audit.jsonl",
		);
		this.auditIndex = new Map();
		this.auditRevisions = new Map();
		this.transactionLogLoadError = null;
		this.pendingTransfers = new Map();
		this.pendingTransfersPath = path.resolve(
			String(this.c.config.get("controller.database_directory")),
			"surface_export_pending_transfers.json",
		);
		await this.loadPlayerLocations(path.join(path.dirname(this.pendingTransfersPath), "surface_export_player_locations.json"));

		this.platformTree = new PlatformTree(this as unknown as IControllerPlugin, messages);
		this.txLogger = new TransactionLogger(this as unknown as IControllerPlugin);
		this.subscriptions = new SubscriptionManager(this as unknown as IControllerPlugin, lib, messages);
		this.orchestrator = new TransferOrchestrator(this as unknown as IControllerPlugin, messages);

		await this.loadStorage();
		await this.txLogger.loadTransactionLogs();
		await this.loadAuditIndex();
		const gateways = new GatewayConfig(this.c, this.logger, {
			isInstanceOnline: id => this.isInstanceOnline(id),
			resolveInstanceName: id => this.platformTree.resolveInstanceName(id),
		});
		await gateways.loadGatewayConfig();
		await this.loadPendingTransfers();
		await this.orchestrator.requestQueue.init(path.join(path.dirname(this.transactionLogPath), "surface_export_transfer_queue.json"),
			[...this.platformStorage.keys(), ...this.auditIndex.keys(), ...this.pendingTransfers.keys(),
				...this.persistedTransactionLogs.map(log => log.transferId)]);
		this.orchestrator.restoreImportObservations();

		this.c.handle(messages.OperationTimingEvent, async (event: messages.OperationTimingEvent) => {
			this.txLogger.acceptTiming(event.record);
		});
		this.c.handle(messages.PlatformExportEvent, this.handlePlatformExport.bind(this));
		this.c.handle(messages.ListExportsRequest, this.handleListExportsRequest.bind(this));
		this.c.handle(messages.GetStoredExportRequest, this.handleGetStoredExportRequest.bind(this));
		this.c.handle(messages.ImportUploadedExportRequest, this.handleImportUploadedExportRequest.bind(this));
		this.c.handle(messages.ExportPlatformForDownloadRequest, this.handleExportPlatformForDownloadRequest.bind(this));
		this.c.handle(messages.TransferPlatformRequest, this.orchestrator.handleTransferPlatformRequest.bind(this.orchestrator));
		this.c.handle(messages.StartPlatformTransferRequest, this.orchestrator.handleStartPlatformTransferRequest.bind(this.orchestrator));
		this.c.handle(messages.TransferValidationEvent, this.orchestrator.handleTransferValidation.bind(this.orchestrator));
		this.c.handle(messages.ImportOperationCompleteEvent, this.handleImportOperationCompleteEvent.bind(this));
		this.c.handle(messages.GetPlatformTreeRequest, this.handleGetPlatformTreeRequest.bind(this));
		this.c.handle(messages.ListTransactionLogsRequest, this.handleListTransactionLogsRequest.bind(this));
		this.c.handle(messages.GetTransactionLogRequest, this.handleGetTransactionLog.bind(this));
		this.c.handle(messages.SetSurfaceExportSubscriptionRequest, this.subscriptions.handleSetSurfaceExportSubscriptionRequest.bind(this.subscriptions));
		this.c.handle(messages.PlatformStateChangedEvent, this.handlePlatformStateChanged.bind(this));
		this.c.handle(messages.GetGatewaysRequest, gateways.handleGetGatewaysRequest.bind(gateways));
		this.c.handle(messages.SetGatewayLinkRequest, gateways.handleSetGatewayLinkRequest.bind(gateways));
		this.c.handle(messages.GetGatewayConfigRequest, gateways.handleGetGatewayConfigRequest.bind(gateways));
		this.c.handle(messages.RecoveryPolicyRequest, this.handleRecoveryPolicyRequest.bind(this));
		this.c.handle(messages.GetInstanceRosterRequest, this.handleGetInstanceRosterRequest.bind(this));

		this.logger.info("Surface Export controller plugin initialized");
		this.startRecovery();
	}

	private startRecovery() {
		if (this.pendingTransfers.size > 0) {
			this.logger.warn(`${this.pendingTransfers.size} pending transfer(s); recovery requires a validated destination hold and matching source identity or deletion receipt.`);
		}
		let nextRecovery = 0;
		this.recoveryTimer = setInterval(() => {
			const recover = performance.now() >= nextRecovery;
			if (recover) nextRecovery = performance.now() + 30_000;
			void (recover ? this.orchestrator.recoverPendingTransfers() : this.orchestrator.observeJobs()).catch(error => {
				this.logger.error(`Transfer recovery failed: ${getErrorMessage(error)}`);
			});
		}, 5_000);
		this.recoveryTimer.unref();
	}

	async handleRecoveryPolicyRequest(request: messages.RecoveryPolicyRequest, source?: { id: number }) {
		if (!source || source.id !== request.instanceId) throw new Error("Recovery instance identity mismatch");
		if (!Number.isInteger(request.instanceId) || !this.c.instances.get(request.instanceId) || !request.epoch) {
			throw new Error("Invalid recovery instance or epoch");
		}
		if (this.pendingTransfersLoadError || this.transactionLogLoadError || this.orchestrator.requestQueue.admissionError) {
			throw new Error("Controller recovery state is unavailable");
		}
		if (request.action === "begin") {
			const existing = this.recoveryReservations.get(request.instanceId);
			if (existing?.epoch === request.epoch) return existing;
			const session = { epoch: request.epoch, mode: recoveryMode(this.cfg("surface_export.platform_source_of_truth")),
				allowAdoption: !hasUnresolvedOwnership(request.instanceId, this.pendingTransfers.values(), this.activeTransfers.values()),
				protectedSourceIndexes: protectedSourceIndexes(request.instanceId, this.pendingTransfers.values(), this.activeTransfers.values()) };
			this.recoveryReservations.set(request.instanceId, session);
			return session;
		}
		const session = this.recoveryReservations.get(request.instanceId);
		if (request.action !== "finish" || session?.epoch !== request.epoch) throw new Error("Recovery session changed; restart the instance");
		this.recoveryReservations.delete(request.instanceId);
		return session;
	}

	private requireRecoveryReady(instanceId: number) {
		if (this.recoveryReservations.has(instanceId)) throw new Error("Instance is reconciling its loaded save; retry after recovery completes");
	}

	override async onShutdown() {
		if (this.recoveryTimer) clearInterval(this.recoveryTimer);
		this.orchestrator.stop();
		this.subscriptions.treeBroadcastLimiter.cancel();
		this.logger.info(`Shutting down - ${this.platformStorage.size} platforms in storage`);
	}

	override onControlConnectionEvent(connection: unknown, event: string) {
		if (event === "close") {
			this.surfaceExportSubscriptions.delete(
				connection as { send: (event: unknown) => void; user: { checkPermission: (permission: string) => void } },
			);
		}
	}

	override onHostConnectionEvent() {
		this.subscriptions.queueTreeBroadcast(this.lastTreeForceName || "player");
	}

	override async onInstanceStatusChanged() {
		this.subscriptions.queueTreeBroadcast(this.lastTreeForceName || "player");
	}

	async handlePlatformExport(event: { exportId: string; platformName: string; platformIndex?: number | null; instanceId: number; exportData: ExportData; exportMetrics?: messages.ExportMetrics; timestamp: number }) {
		const id = makeCanonicalTransferId(event.instanceId, event.exportId);
		return timingContext.run(this.txLogger.clock(id), () => timed("Artifact receipt and storage", "inclusive", () => this.handlePlatformExportMeasured(event)));
	}

	async handlePlatformExportMeasured(event: { exportId: string; platformName: string; platformIndex?: number | null; instanceId: number; exportData: ExportData; exportMetrics?: messages.ExportMetrics; timestamp: number }) {
		const sourceExportId = event.exportId;
		const canonicalExportId = makeCanonicalTransferId(event.instanceId, sourceExportId);
		if (this.platformStorage.has(canonicalExportId)) return;
		this.logger.info(`Received platform export: ${canonicalExportId} (source ${sourceExportId}) from instance ${event.instanceId} (${event.platformName})`);

		try {
			const serializedSize = timedSync("Artifact serialization", () => Buffer.byteLength(JSON.stringify(event.exportData), "utf8"));
			this.platformStorage.set(canonicalExportId, {
				exportId: canonicalExportId,
				sourceExportId,
				platformName: event.platformName,
				platformIndex: event.platformIndex ?? null,
				instanceId: event.instanceId,
				exportData: event.exportData,
				exportMetrics: event.exportMetrics || null,
				timestamp: event.timestamp,
				size: serializedSize,
			});

			this.logger.info(`Stored platform export: ${canonicalExportId}`);
			this.txLogger.captureStoredTiming(this.platformStorage.get(canonicalExportId)!);

			const maxStorage = Number(this.cfg(`${PLUGIN_NAME}.max_storage_size`));
			if (Number.isFinite(maxStorage) && this.platformStorage.size > maxStorage) {
				this.cleanupOldExports(maxStorage);
			}
			await timed("Artifact storage write", "inclusive", () => this.persistStorage());
			this.subscriptions.queueTreeBroadcast("player");
		} catch (err: unknown) {
			this.logger.error(`Error handling platform export: ${getErrorMessage(err)}`);
		}
	}

	async handlePlatformStateChanged(event: { platformName?: string; forceName?: string }) {
		if (event.platformName) {
			this.platformDepartureTimes.set(event.platformName, Date.now());
		}
		this.subscriptions.queueTreeBroadcast(event.forceName || "player");
	}

	private async failOperation(operation: ActiveTransfer, eventType: string, message: string, extra: Record<string, unknown> = {}) {
		operation.status = "failed";
		operation.error = operation.error || "";
		operation.failedAt = Date.now();
		this.txLogger.logTransactionEvent(operation.transferId, eventType, message, extra);
		this.subscriptions.emitTransferUpdate(operation);
		await this.txLogger.persistTransactionLog(operation.transferId);
		this.orchestrator.pruneOldTransfers();
	}

	cleanupOldExports(maxStorage: number) {
		const entries = Array.from(this.platformStorage.entries());
		entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

		const toRemove = entries.length - maxStorage;
		if (toRemove <= 0) {
			return;
		}
		for (let i = 0; i < toRemove; i++) {
			const exportId = entries[i][0];
			this.platformStorage.delete(exportId);
			this.logger.verbose(`Removed old export: ${exportId}`);
		}

		this.logger.info(`Cleaned up ${toRemove} old exports, now at ${this.platformStorage.size}`);
		this.subscriptions.queueTreeBroadcast("player");
	}

	listStoredExports() {
		return Array.from(this.platformStorage.values()).map(data => ({
			exportId: data.exportId,
			sourceExportId: data.sourceExportId ?? null,
			platformName: data.platformName,
			instanceId: data.instanceId,
			timestamp: data.timestamp,
			size: data.size ?? Buffer.byteLength(JSON.stringify(data.exportData || {}), "utf8"),
		}));
	}

	async handleListExportsRequest() {
		return this.listStoredExports();
	}

	async handleGetStoredExportRequest(request: { exportId: string }) {
		const { exportId } = request;
		const stored = this.platformStorage.get(exportId);
		if (!stored) {
			return { success: false, error: `Export not found: ${exportId}` };
		}

		return {
			success: true,
			exportId: stored.exportId,
			platformName: stored.platformName,
			instanceId: stored.instanceId,
			timestamp: stored.timestamp,
			size: stored.size ?? Buffer.byteLength(JSON.stringify(stored.exportData || {}), "utf8"),
			sourceExportId: stored.sourceExportId ?? null,
			exportData: stored.exportData,
		};
	}

	async createOperationRecord(operationType: OperationType, options: OperationOptions = {}) {
		const operation = buildOperationRecord(operationType, {
			...options,
			resolveInstanceName: (instanceId: number) => this.platformTree.resolveInstanceName(instanceId),
		});
		await this.txLogger.archiveRecycledTransferId(operation.transferId, operation.startedAt);
		this.activeTransfers.set(operation.transferId, operation);
		const observation = timingContext.getStore();
		if (observation) this.txLogger.bindObservation(observation.jobId, operation.transferId);
		else this.txLogger.beginObservation(operation.transferId);
		await this.recordTransferStarted(operation);
		return operation;
	}

	async handleImportUploadedExportRequest(request: messages.ImportUploadedExportOptions) {
		if (!request.restoreExportId) return this.observeUploadedImport(request);
		if (!request.restoreRequestId || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(request.restoreRequestId)) {
			return { success: false, error: "Snapshot restoration requires a fresh request UUID" };
		}
		const id = `restore:${request.restoreRequestId}`;
		const signature = JSON.stringify([request.restoreExportId, request.targetInstanceId, request.forceName || "player", request.platformName || null, request.targetPlanet || null]);
		const pending = this.snapshotRequests.get(id);
		if (pending) return pending.signature === signature ? pending.result : {success: false, error: "This request already belongs to another import"};
		const prior = this.activeTransfers.get(id) || this.auditIndex.get(id)
			|| this.persistedTransactionLogs.find(log => log.transferId === id)?.transferInfo;
		if (prior) {
			if (prior.targetInstanceId !== request.targetInstanceId || prior.exportId !== request.restoreExportId) {
				return { success: false, error: "This restoration request already belongs to another import" };
			}
			return { success: !["failed", "error", "cleanup_failed"].includes(String(prior.status)), operationId: id,
				platformName: prior.platformName, targetInstanceId: prior.targetInstanceId,
				error: prior.error || undefined };
		}
		if (this.snapshotRequests.size >= 100) return { success: false, error: "Too many pending restorations" };
		const result = this.observeUploadedImport(request);
		this.snapshotRequests.set(id, {signature, result});
		try { return await result; } finally { this.snapshotRequests.delete(id); }
	}

	private async observeUploadedImport(request: messages.ImportUploadedExportOptions) {
		const clock = this.txLogger.beginObservation(`request:${randomUUID()}`);
		const result = await timingContext.run(clock, () => this.handleImportUploadedExportRequestMeasured(request));
		if (!result.success && !clock.operationId) {
			try { await this.txLogger.rejectObservation(clock.jobId, { ...request, operationType: "import" }, result.error || "Import request rejected"); }
			catch (error) { this.logger.warn(`Rejected-request profiling failed: ${getErrorMessage(error)}`); }
		}
		return result;
	}

	async handleImportUploadedExportRequestMeasured(request: messages.ImportUploadedExportOptions) {
		const { targetInstanceId, forceName, platformName, targetPlanet, restoreExportId } = request;
		try { this.requireRecoveryReady(targetInstanceId); }
		catch (error) { return {success: false, error: getErrorMessage(error)}; }
		const snapshot = restoreExportId ? this.platformStorage.get(restoreExportId) : undefined;
		if (restoreExportId && !snapshot) return { success: false, error: "This snapshot is no longer available. No platform was imported." };
		const suppliedData = snapshot ? snapshot.exportData : request.exportData;
		let extracted;
		try { extracted = importableSnapshot(suppliedData); }
		catch (error) { return { success: false, error: getErrorMessage(error) }; }
		const exportData = extracted.payload;

		if (!exportData || typeof exportData !== "object" || Array.isArray(exportData)) {
			return { success: false, error: "exportData must be a non-null object" };
		}

		const resolved = this.platformTree.resolveTargetInstance(targetInstanceId);
		const resolvedInstance = resolved?.instance as { isDeleted?: boolean } | null;
		if (!resolved || !resolvedInstance || resolvedInstance.isDeleted) {
			return { success: false, error: `Target instance not found: ${targetInstanceId}` };
		}
		const pausedTarget = await this.autoPauseRefusal(resolved.id, "destination");
		if (pausedTarget) return { success: false, error: `${pausedTarget} No platform was imported.` };

		const importData: ExportData = { ...exportData };
		const validateSnapshot = Boolean(snapshot || extracted.fromBlackBox || importData._transferId);
		delete importData._sourceInstanceId;
		delete importData._transferId;
		importData._standaloneImport = true;
		importData._restoreSnapshot = validateSnapshot;
		if (platformName && String(platformName).trim()) {
			importData.platform_name = String(platformName).trim();
		}
		const resolvedForceName = forceName || importData?.platform?.force || "player";
		const operation = await this.createOperationRecord("import", {
			operationId: restoreExportId ? `restore:${request.restoreRequestId}` : undefined,
			platformName: importData.platform_name || "Uploaded platform",
			forceName: resolvedForceName,
			sourceInstanceId: -1,
			sourceInstanceName: snapshot ? "Restored snapshot" : "Uploaded JSON",
			exportId: restoreExportId || undefined,
			targetInstanceId: resolved.id,
		});
		(importData as Record<string, unknown>)._operationId = operation.transferId;
		const uploadExportId = generateOperationId("uploaded");
		const completedReply = () => ["completed", "failed", "error", "cleanup_failed"].includes(operation.status) ? {
			success: operation.status === "completed", operationId: operation.transferId,
			platformName: operation.platformName, targetInstanceId: resolved.id, error: operation.error || undefined,
		} : null;

		let dispatchAttempted = false;
		try {
			const payloadSizeBytes = timedSync("Payload serialization", () => Buffer.byteLength(JSON.stringify(importData), "utf8"));
			operation.artifactSizeBytes = payloadSizeBytes;
			this.txLogger.logTransactionEvent(operation.transferId, "import_requested",
				`Upload import requested for ${operation.platformName}`, {targetInstanceId: resolved.id,
					payloadSizeBytes, restoredFromExportId: restoreExportId || null});
			this.subscriptions.emitTransferUpdate(operation);
			if (!this.isInstanceOnline(resolved.id)) {
				operation.error = `Destination instance ${resolved.id} is offline, unassigned, or unavailable`;
				await this.failOperation(operation, "import_failed", operation.error);
				return {success: false, operationId: operation.transferId, error: operation.error};
			}
			dispatchAttempted = true;
			const response = await timed("Clusterio request round trip", "round-trip", () => this.c.sendTo(
				{ instanceId: resolved.id },
				new messages.ImportPlatformRequest({
					exportId: uploadExportId,
					exportData: importData,
					forceName: resolvedForceName,
					targetPlanet: targetPlanet ?? null,
				}),
			)) as messages.ImportResult & { platformName?: string; targetInstanceId?: number };
			const terminalReply = completedReply();
			if (terminalReply) return terminalReply;
			if (!response?.success && !response?.admissionUncertain) {
				const error = response?.error || "Import failed on target instance";
				operation.error = error;
				await this.failOperation(operation, "import_failed", `Import request failed: ${error}`, { error });
				return {
					success: false,
					operationId: operation.transferId,
					error,
					targetInstanceId: resolved.id,
				};
			}
			operation.status = "awaiting_completion";
			operation.destinationJobId = response.jobId;
			operation.jobEpoch = response.epoch;
			operation.platformName = response.platformName || importData.platform_name || operation.platformName;
			this.txLogger.logTransactionEvent(operation.transferId, "import_queued",
				`Import accepted by instance ${resolved.id}; awaiting completion callback`, {
					targetInstanceId: resolved.id,
					uploadExportId,
				});
			this.subscriptions.emitTransferUpdate(operation);
			await this.txLogger.persistTransactionLog(operation.transferId);

			return {
				success: true,
				operationId: operation.transferId,
				platformName: response.platformName || importData.platform_name || "Unknown",
				targetInstanceId: resolved.id,
			};
		} catch (err: unknown) {
			const terminalReply = completedReply();
			if (terminalReply) return terminalReply;
			const errMsg = getErrorMessage(err);
			if (!dispatchAttempted || isInstanceRouteRejection(err)) {
				operation.error = errMsg;
				await this.failOperation(operation, "import_failed", `Import request rejected before dispatch: ${errMsg}`, {error: errMsg});
				return {success: false, operationId: operation.transferId, error: errMsg};
			}
			operation.status = "awaiting_completion";
			operation.jobObservation = {state: "unavailable", message: "Status unavailable", reason: errMsg};
			this.subscriptions.emitTransferUpdate(operation);
			await this.txLogger.persistTransactionLog(operation.transferId);
			return {success: true, operationId: operation.transferId, message: "Import status unavailable; awaiting confirmation"};
		}
	}

	async handleExportPlatformForDownloadRequest(request: { sourceInstanceId: number; sourcePlatformIndex: number; sourcePlatformUid?: string; forceName?: string }) {
		const clock = this.txLogger.beginObservation(`request:${randomUUID()}`);
		const result = await timingContext.run(clock, () => this.handleExportPlatformForDownloadRequestMeasured(request));
		if (!result.success && !clock.operationId) {
			try { await this.txLogger.rejectObservation(clock.jobId, { ...request, operationType: "export" }, result.error || "Export request rejected"); }
			catch (error) { this.logger.warn(`Rejected-request profiling failed: ${getErrorMessage(error)}`); }
		}
		return result;
	}

	async handleExportPlatformForDownloadRequestMeasured(request: { sourceInstanceId: number; sourcePlatformIndex: number; sourcePlatformUid?: string; forceName?: string }) {
		const sourceInstanceId = Number(request.sourceInstanceId);
		this.requireRecoveryReady(sourceInstanceId);
		const sourcePlatformIndex = Number(request.sourcePlatformIndex);
		const forceName = request.forceName || "player";

		if (!Number.isInteger(sourceInstanceId)) {
			return { success: false, error: `Invalid source instance: ${request.sourceInstanceId}` };
		}
		if (!Number.isInteger(sourcePlatformIndex) || sourcePlatformIndex < 1) {
			return { success: false, error: `Invalid platform index: ${request.sourcePlatformIndex}` };
		}

		const sourceInstance = this.c.instances.get(sourceInstanceId);
		if (!sourceInstance || sourceInstance.isDeleted) {
			return { success: false, error: `Unknown source instance ${sourceInstanceId}` };
		}
		const pausedSource = await this.autoPauseRefusal(sourceInstanceId, "source");
		if (pausedSource) return { success: false, error: `${pausedSource} Nothing was locked or exported.` };
		const platformUid = await this.platformTree.resolvePlatformUid(sourceInstanceId, sourcePlatformIndex, forceName, request.sourcePlatformUid);
		const operation = await this.createOperationRecord("export", {
			platformUid,
			platformName: `platform #${sourcePlatformIndex}`,
			platformIndex: sourcePlatformIndex,
			forceName,
			sourceInstanceId,
			targetInstanceId: -1,
			targetInstanceName: "Browser download",
		});
		this.txLogger.logTransactionEvent(operation.transferId, "export_requested",
			`Export requested from instance ${sourceInstanceId}, platform index ${sourcePlatformIndex}`, {
				sourceInstanceId,
				sourcePlatformIndex,
			});
		this.subscriptions.emitTransferUpdate(operation);

		let exportReplyReceived = false;
		try {
			const exportRequestStartMs = performance.now();
			const exportResponse = await timed("Clusterio request round trip", "round-trip", () => this.c.sendTo(
				{ instanceId: sourceInstanceId },
				new messages.ExportPlatformRequest({
					operationId: operation.transferId,
					platformIndex: sourcePlatformIndex,
					platformUid,
					forceName,
					targetInstanceId: null,
				}),
			)) as messages.SimpleResponse & { exportId?: string; error?: string; admissionUncertain?: boolean };
			exportReplyReceived = true;
			const exportRequestMs = performance.now() - exportRequestStartMs;
			if (exportResponse?.admissionUncertain || !exportResponse || (exportResponse.success && !exportResponse.exportId)) {
				const error = exportResponse?.error || "Export admission is unconfirmed";
				await this.orchestrator.observeUnconfirmedExport(operation, error);
				return {success: false, operationId: operation.transferId, error};
			}
			if (!exportResponse?.success || !exportResponse.exportId) {
				const error = exportResponse?.error || "Export failed";
				operation.error = error;
				await this.failOperation(operation, "export_failed", `Export request failed: ${error}`, { error, exportRequestMs });
				return { success: false, error };
			}
			const waitForStoreStartMs = performance.now();

			const canonicalExportId = makeCanonicalTransferId(sourceInstanceId, exportResponse.exportId);
			operation.exportId = canonicalExportId;
			operation.sourceExportId = exportResponse.exportId;
			const stored = await timed("Await artifact storage", "wait", () => this.orchestrator.waitForStoredExport(canonicalExportId));
			const waitForStoredMs = performance.now() - waitForStoreStartMs;
			operation.exportMetrics = normalizeExportMetrics({
				...(stored.exportMetrics || {}),
				requestExportAndLockMs: exportRequestMs,
				waitForControllerStoreMs: waitForStoredMs,
				controllerExportPrepTotalMs: exportRequestMs + waitForStoredMs,
			});
			await this.orchestrator.completeStoredExport(operation, stored);
			return {
				success: true,
				operationId: operation.transferId,
				exportId: stored.exportId,
				platformName: stored.platformName,
				instanceId: stored.instanceId,
				timestamp: stored.timestamp,
				size: stored.size ?? Buffer.byteLength(JSON.stringify(stored.exportData || {}), "utf8"),
				exportData: stored.exportData,
			};
		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			if (err instanceof JobObservationStopped || (!exportReplyReceived && !isInstanceRouteRejection(err))) {
				await this.orchestrator.observeUnconfirmedExport(operation, errMsg);
				return {success: false, operationId: operation.transferId, error: errMsg};
			}
			operation.error = errMsg;
			await this.failOperation(operation, "export_failed", `Export failed: ${errMsg}`, { error: errMsg });
			return { success: false, error: errMsg };
		}
	}

	async handleImportOperationCompleteEvent(event: messages.ImportOperationCompleteEvent): Promise<void> {
		const operationId = event.operationId.trim();
		if (!operationId) return;
		this.importCompletions ??= new Map();
		const inFlight = this.importCompletions.get(operationId);
		if (inFlight) { await inFlight; return this.handleImportOperationCompleteEvent(event); }
		const settling = Promise.resolve().then(() => this.handleImportOperationCompleteMeasured(event, operationId));
		this.importCompletions.set(operationId, settling);
		try { await settling; } finally { this.importCompletions.delete(operationId); }
	}

	private async handleImportOperationCompleteMeasured(event: messages.ImportOperationCompleteEvent, operationId: string) {
		let operation = this.activeTransfers.get(operationId);
		const retained = this.persistedTransactionLogs?.find(log => log.transferId === operationId);
		if (operation && (operation.operationType !== "import" || operation.targetInstanceId !== event.instanceId)) {
			this.logger.warn(`Ignoring mismatched import completion for ${operationId}`);
			return;
		}
		if (["completed", "failed", "error", "cleanup_failed"].includes(operation?.status || retained?.transferInfo.status || "")) return;
		if (!operation) {
			operation = await this.createOperationRecord("import", {
				operationId,
				platformName: event.platformName || "Imported platform",
				sourceInstanceId: -1,
				sourceInstanceName: "Uploaded JSON",
				targetInstanceId: Number.isInteger(Number(event.instanceId)) ? Number(event.instanceId) : -1,
			});
			this.txLogger.logTransactionEvent(operation.transferId, "import_recovered",
				"Recovered import operation record from completion callback", {});
		}

		delete operation.jobObservation;
		operation.platformName = event.platformName || operation.platformName;
		if (Number.isInteger(Number(event.instanceId)) && Number(event.instanceId) > 0) {
			operation.targetInstanceId = Number(event.instanceId);
			operation.targetInstanceName = this.platformTree.resolveInstanceName(operation.targetInstanceId);
		}
		const importMetrics = buildImportMetrics(event.metrics, event.durationTicks ?? null);
		if (importMetrics && Number.isInteger(Number(event.entityCount)) && Number(event.entityCount) >= 0) {
			importMetrics.entities_created = Number(event.entityCount);
		}
		operation.importMetrics = (importMetrics || null) as messages.ImportMetrics | null;
		if (event.validation) {
			operation.validationResult = event.validation;
		}

		if (event.success) {
			operation.status = "completed";
			operation.completedAt = Date.now();
			const durationMs = this.txLogger.getObservedDuration(operation);
			this.txLogger.logTransactionEvent(operation.transferId, "import_completed",
				`Import completed on instance ${operation.targetInstanceId}`, {
					durationMs,
					importMetrics: operation.importMetrics,
				});
		} else {
			const error = event.error || "Import failed";
			operation.status = event.cleanupFailed ? "cleanup_failed" : "failed";
			operation.error = error;
			operation.failedAt = Date.now();
			if (event.failedStage === "items" || event.failedStage === "fluids"
				|| event.failedStage === "belts" || event.failedStage === "test_hook"
				|| event.failedStage === "entities" || event.failedStage === "cargo_integrity"
				|| event.failedStage === "destination_hold") {
				operation.failedStage = event.failedStage;
			}
			this.txLogger.logTransactionEvent(operation.transferId, "import_failed",
				`Import failed: ${error}`, {
					error,
					importMetrics: operation.importMetrics,
				});
		}

		this.subscriptions.emitTransferUpdate(operation);
		this.subscriptions.queueTreeBroadcast(operation.forceName || "player");
		await this.txLogger.persistTransactionLog(operation.transferId);
		this.orchestrator.pruneOldTransfers();
	}

	async handleGetPlatformTreeRequest(request: { forceName?: string }) {
		const forceName = request.forceName || "player";
		this.lastTreeForceName = forceName;
		const tree = await this.platformTree.buildPlatformTree(forceName);
		this.treeRevision += 1;
		return {
			revision: this.treeRevision,
			generatedAt: Date.now(),
			forceName,
			hosts: tree.hosts,
			unassignedInstances: tree.unassignedInstances,
		};
	}

	async handleListTransactionLogsRequest(request: { limit?: number } | undefined) {
		return this.txLogger.getTransferSummaries(request?.limit || 50);
	}

	async handleGetTransactionLog(request: { transferId?: string }) {
		const detail = await this.readTransactionLog(request);
		const summary = detail.summary;
		const validation = summary?.validation;
		if (!validation || typeof validation !== "object") return detail;
		const reference = (validation as Record<string, unknown>).failureBlackBox as { file?: unknown; tick?: unknown } | undefined;
		const instanceId = detail.transferInfo?.targetInstanceId;
		if (typeof reference?.file !== "string" || typeof reference.tick !== "number" || !Number.isInteger(reference.tick)
			|| !detail.transferId || !Number.isInteger(instanceId)) return detail;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const entityEvidence = await Promise.race([
				this.c.sendTo({ instanceId: instanceId as number }, new messages.ReadEntityEvidenceRequest(detail.transferId, reference.file, reference.tick)),
				new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Diagnostic request timed out")), 3000); }),
			]);
			return { ...detail, summary: { ...summary, validation: { ...validation, entityEvidence } } };
		} catch (error) {
			return { ...detail, summary: { ...summary, validation: { ...validation,
				entityEvidence: unavailableEvidence(reference.file, `Destination diagnostic is unavailable: ${getErrorMessage(error)}. Reopen this operation to retry.`),
			} } };
		} finally { if (timer) clearTimeout(timer); }
	}

	async readTransactionLog(request: { transferId?: string }) {
		const { transferId } = request;

		if (!transferId || transferId === "latest") {
			if (this.persistedTransactionLogs.length === 0) {
				return { success: false, error: "No transaction logs available" };
			}
			const latestLog = this.persistedTransactionLogs[this.persistedTransactionLogs.length - 1];
			return {
				success: true,
				transferId: latestLog.transferId,
				events: latestLog.events,
				transferInfo: latestLog.transferInfo,
				summary: latestLog.summary || null,
			};
		}

		if (this.transactionLogs.has(transferId)) {
			const events = this.transactionLogs.get(transferId);
			const transfer = this.activeTransfers.get(transferId);

			return {
				success: true,
				transferId,
				events,
				transferInfo: transfer ? this.txLogger.buildTransferInfo(transfer) : null,
				summary: transfer
					? this.txLogger.buildDetailedTransferSummary(transferId, transfer, this.txLogger.getLastEventTimestamp(transferId))
					: null,
			};
		}

		const persistedLog = this.persistedTransactionLogs.find(log => log.transferId === transferId);
		if (persistedLog) {
			return {
				success: true,
				transferId: persistedLog.transferId,
				events: persistedLog.events,
				transferInfo: persistedLog.transferInfo,
				summary: persistedLog.summary || null,
			};
		}

		const auditRow = this.auditIndex.get(transferId);
		if (auditRow) {
			return {
				success: true,
				transferId,
				events: [],
				detailRetained: false,
				transferInfo: {
					transferId: auditRow.transferId,
					operationType: auditRow.operationType,
					exportId: auditRow.exportId,
					artifactSizeBytes: auditRow.artifactSizeBytes,
					platformName: auditRow.platformName,
					platformIndex: auditRow.platformIndex,
					sourceInstanceId: auditRow.sourceInstanceId,
					sourceInstanceName: auditRow.sourceInstanceName,
					targetInstanceId: auditRow.targetInstanceId,
					targetInstanceName: auditRow.targetInstanceName,
					status: auditRow.status,
					startedAt: auditRow.startedAt,
					completedAt: auditRow.completedAt,
					failedAt: auditRow.failedAt,
					error: auditRow.error,
				},
				summary: null,
			};
		}

		return { success: false, error: `Transaction log not found for transfer: ${transferId}` };
	}

	canonicalizeStoredExport(entry: StoredExport): StoredExport {
		return canonicalizeStoredExport(this, entry);
	}

	async loadStorage() {
		return loadStoredExports(this);
	}

	async persistStorage() {
		return persistStoredExports(this);
	}

	async loadAuditIndex() {
		return loadControllerAudit(this);
	}

	async migrateAuditLedger(): Promise<AuditRow[]> {
		return migrateControllerAudit(this);
	}

	async recordAuditRow(row: AuditRow) {
		return recordControllerAuditRow(this, row);
	}

	async recordTransferStarted(transfer: ActiveTransfer) {
		await this.recordAuditRow(buildAuditRow({
			transferId: transfer.transferId,
			rowKind: "start",
			savedAt: Date.now(),
			eventCount: this.transactionLogs.get(transfer.transferId)?.length ?? 0,
			lastEventAt: this.txLogger.getLastEventTimestamp(transfer.transferId),
			info: this.txLogger.buildTransferInfo(transfer),
		}));
	}

	async loadPendingTransfers() {
		try {
			const content = await fs.readFile(this.pendingTransfersPath, "utf8");
			const entries = JSON.parse(content);
			if (!Array.isArray(entries) || entries.some(e => !e || typeof e.transferId !== "string"
				|| !Number.isInteger(e.sourceInstanceId) || !Number.isInteger(e.targetInstanceId))) throw new Error("Invalid pending transfer records");
			if (Array.isArray(entries)) {
				for (const e of entries) {
					if (e && typeof e.transferId === "string") {
						this.pendingTransfers.set(e.transferId, e as messages.PendingTransferIntent);
					}
				}
			}
			if (this.pendingTransfers.size > 0) {
				this.logger.info(`Loaded ${this.pendingTransfers.size} pending transfer intent(s) from disk`);
			}
		} catch (err: unknown) {
			const code = (err as { code?: string }).code;
			if (code === "ENOENT") {
				return;
			}
			this.logger.error(`Failed to load pending transfers: ${getErrorMessage(err)}`);
			this.pendingTransfersLoadError = getErrorMessage(err);
		}
	}

	async persistPendingTransfers(requiredTransferId?: string) {
		try {
			if (requiredTransferId && !this.pendingTransfers.has(requiredTransferId)) {
				throw new Error(`Recovery intent unavailable for ${requiredTransferId}`);
			}
			const payload = JSON.stringify(Array.from(this.pendingTransfers.values()), null, 2);
			await enqueueWrite(this.pendingTransfersPath, () => lib.safeOutputFile(this.pendingTransfersPath, payload));
		} catch (err: unknown) {
			this.logger.error(`Failed to persist pending transfers: ${getErrorMessage(err)}`);
			if (requiredTransferId) throw err;
		}
	}

	persistPendingTransfer(intent: messages.PendingTransferIntent): void {
		// Unresolved recovery authority is not log retention. Only explicit resolution removes it.
		this.pendingTransfers.set(intent.transferId, intent);
		void this.persistPendingTransfers();
	}

	removePendingTransfer(transferId: string): void {
		if (this.pendingTransfers.delete(transferId)) {
			void this.persistPendingTransfers();
		}
	}

	async autoPauseRefusal(instanceId: number, role: "source" | "destination"): Promise<string | null> {
		const { autoPause, error } = await this.platformTree.requestInstancePlatforms(instanceId);
		if (!error && autoPause === false) return null;
		const name = this.platformTree.resolveInstanceName(instanceId);
		if (error || autoPause !== true) {
			return `The ${role} instance ${name ? `"${name}" ` : ""}(${instanceId}) has unavailable auto-pause status. `
				+ "Work was not admitted; retry after the instance confirms auto_pause is off."
				+ (error ? ` Status request failed: ${error}` : " Check the instance settings and restart it if needed.");
		}
		return `The ${role} instance ${name ? `"${name}" ` : ""}(${instanceId}) has auto-pause on, so it stops running while no players are online. `
			+ "Platform transfers, imports and exports are refused there; turn off auto_pause in its factorio.settings and restart it.";
	}

	isInstanceOnline(instanceId: number): boolean {
		if (this.recoveryReservations.has(instanceId)) return false;
		const inst = this.c.instances.get(instanceId);
		if (!inst || inst.isDeleted) {
			return false;
		}
		const assignedHost = inst.config.get("instance.assigned_host");
		if (assignedHost === null || assignedHost === undefined) return false;
		const hostId = Number(assignedHost);
		const host = Number.isInteger(hostId) ? this.c.hosts.get(hostId) : null;
		return Boolean(host?.connected) && String(inst.status) === "running";
	}

	async handleGetInstanceRosterRequest(request: { instanceId: number }) {
		const requesterId = Number(request.instanceId);
		const instances: messages.RosterInstance[] = [];
		for (const inst of this.c.instances.values()) {
			if (inst.isDeleted) {
				continue;
			}
			const hostId = Number(inst.config.get("instance.assigned_host"));
			const host = Number.isInteger(hostId) ? this.c.hosts.get(hostId) : null;
			instances.push({
				instanceId: inst.id,
				name: String(inst.config.get("instance.name") ?? inst.id),
				address: instanceAddress(host?.publicAddress, inst.gamePort ?? null),
				online: this.isInstanceOnline(inst.id),
				self: inst.id === requesterId,
			});
		}
		return { instances };
	}
}
