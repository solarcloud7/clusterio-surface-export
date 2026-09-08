import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { timed, timedSync, timingContext } from "./lib/timing";
import fs from "fs/promises";
import path from "path";
import { BaseControllerPlugin } from "@clusterio/controller";
import type { Controller } from "@clusterio/controller";
import * as lib from "@clusterio/lib";
import { PlatformTree, instanceAddress } from "./lib/platform-tree";
import { TransactionLogger } from "./lib/transaction-logger";
import { SubscriptionManager } from "./lib/subscription-manager";
import { enqueueWrite } from "./lib/persist-queue";
import { buildAuditRow } from "./lib/audit-ledger";
import { canonicalizeStoredExport, loadStoredExports, persistStoredExports } from "./lib/export-storage";
import { loadControllerAudit, migrateControllerAudit, recordControllerAuditRow } from "./lib/controller-audit";
import type { AuditRow } from "./lib/audit-ledger";
import { TransferOrchestrator } from "./lib/transfer-orchestrator";
import { createOperationRecord as buildOperationRecord } from "./lib/operation-record";
import type {
	IControllerPlugin,
	ActiveTransfer,
	ExportData,
	OperationOptions,
	ExportVerification,
	ExportStats,
	OperationType,
	HostNodeModel,
	InstanceNodeModel,
	SubscriptionState,
	TransferSummaryModel,
	StoredExport,
	TransactionLogEntryModel,
	PersistedTransactionLog,
} from "./messages";
import * as messages from "./messages";
import { normalizeExportMetrics, getErrorMessage, generateOperationId, TICKS_TO_MS, STORAGE_FILENAME, buildPayloadMetrics, buildImportMetrics, makeCanonicalTransferId } from "./helpers";

const PLUGIN_NAME = "surface_export";
type GatewayLinkUpdate = {
	sourceInstanceId: number;
	gateways: Array<{ gatewayName: string; targets: messages.GatewayLink[] }>;
};
export const PENDING_TRANSFER_INTENT_RETENTION_MS = 15 * 60 * 1000;
export const SOURCE_COMMIT_MARKER_RETENTION_MS = PENDING_TRANSFER_INTENT_RETENTION_MS * 2;

export class ControllerPlugin extends BaseControllerPlugin {
	private get c(): Controller { return this.controller; }
	private cfg<T = unknown>(key: string): T {
		return (this.controller.config as { get(k: string): unknown }).get(key) as T;
	}

	private lastGatewayModeWarning?: string;
	gatewayMode(): messages.GatewayMode {
		const { mode, warning } = messages.parseGatewayMode(this.cfg("surface_export.gateway_mode"));
		if (warning && warning !== this.lastGatewayModeWarning) {
			this.lastGatewayModeWarning = warning;
			this.logger.warn(warning);
		}
		return mode;
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
	gatewayLinks!: Map<string, messages.GatewayLink[]>;
	gatewayConfigPath!: string;
	gatewayConfigLoadError: string | null = null;
	private gatewayConfigUpdate?: Promise<void>;
	pendingTransfers!: Map<string, messages.PendingTransferIntent>;
	pendingTransfersPath!: string;
	sourceCommitMarkers!: Map<string, messages.SourceCommitMarker>;
	sourceCommitMarkersPath!: string;

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
		this.gatewayLinks = new Map();
		this.gatewayConfigPath = path.resolve(
			String(this.c.config.get("controller.database_directory")),
			"surface_export_gateways.json",
		);
		this.pendingTransfers = new Map();
		this.sourceCommitMarkers = new Map();
		this.pendingTransfersPath = path.resolve(
			String(this.c.config.get("controller.database_directory")),
			"surface_export_pending_transfers.json",
		);
		this.sourceCommitMarkersPath = path.resolve(
			String(this.c.config.get("controller.database_directory")),
			"surface_export_source_commit_markers.json",
		);

		this.platformTree = new PlatformTree(this as unknown as IControllerPlugin, messages);
		this.txLogger = new TransactionLogger(this as unknown as IControllerPlugin);
		this.subscriptions = new SubscriptionManager(this as unknown as IControllerPlugin, lib, messages);
		this.orchestrator = new TransferOrchestrator(this as unknown as IControllerPlugin, messages);

		await this.loadStorage();
		await this.txLogger.loadTransactionLogs();
		await this.loadAuditIndex();
		await this.loadGatewayConfig();
		await this.loadPendingTransfers();
		await this.loadSourceCommitMarkers();

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
		this.c.handle(messages.GetGatewaysRequest, this.handleGetGatewaysRequest.bind(this));
		this.c.handle(messages.SetGatewayLinkRequest, this.handleSetGatewayLinkRequest.bind(this));
		this.c.handle(messages.GetGatewayConfigRequest, this.handleGetGatewayConfigRequest.bind(this));
		this.c.handle(messages.GetInstanceRosterRequest, this.handleGetInstanceRosterRequest.bind(this));

		this.logger.info("Surface Export controller plugin initialized");
	}

	async onStart() {
		this.logger.info("Controller started - Surface Export plugin ready");
		this.logger.info(`Current storage: ${this.platformStorage.size} platforms`);
		await this.prunePendingTransfers();
		await this.pruneSourceCommitMarkers();
		if (this.pendingTransfers.size > 0) {
			this.logger.warn(`${this.pendingTransfers.size} transfer(s) were awaiting validation at shutdown. Phase 1 recovery is source-side TTL unlock; controller will not auto-delete or auto-unlock on boot.`);
		}
	}

	override async onShutdown() {
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

	async handleImportUploadedExportRequest(request: { targetInstanceId: number; exportData: ExportData; forceName?: string; platformName?: string | null; targetPlanet?: string | null }) {
		const clock = this.txLogger.beginObservation(`request:${randomUUID()}`);
		const result = await timingContext.run(clock, () => this.handleImportUploadedExportRequestMeasured(request));
		if (!result.success && !clock.operationId) {
			try { await this.txLogger.rejectObservation(clock.jobId, { ...request, operationType: "import" }, result.error || "Import request rejected"); }
			catch (error) { this.logger.warn(`Rejected-request profiling failed: ${getErrorMessage(error)}`); }
		}
		return result;
	}

	async handleImportUploadedExportRequestMeasured(request: { targetInstanceId: number; exportData: ExportData; forceName?: string; platformName?: string | null; targetPlanet?: string | null }) {
		const { targetInstanceId, exportData, forceName, platformName, targetPlanet } = request;

		if (!exportData || typeof exportData !== "object" || Array.isArray(exportData)) {
			return { success: false, error: "exportData must be a non-null object" };
		}

		const resolved = this.platformTree.resolveTargetInstance(targetInstanceId);
		const resolvedInstance = resolved?.instance as { isDeleted?: boolean } | null;
		if (!resolved || !resolvedInstance || resolvedInstance.isDeleted) {
			return { success: false, error: `Target instance not found: ${targetInstanceId}` };
		}

		const importData: ExportData = { ...exportData };
		if (platformName && String(platformName).trim()) {
			importData.platform_name = String(platformName).trim();
		}
		const resolvedForceName = forceName || importData?.platform?.force || "player";
		const operation = await this.createOperationRecord("import", {
			platformName: importData.platform_name || "Uploaded platform",
			forceName: resolvedForceName,
			sourceInstanceId: -1,
			sourceInstanceName: "Uploaded JSON",
			targetInstanceId: resolved.id,
		});
		(importData as Record<string, unknown>)._operationId = operation.transferId;
		const payloadSizeBytes = timedSync("Payload serialization", () => Buffer.byteLength(JSON.stringify(importData), "utf8"));
		operation.artifactSizeBytes = payloadSizeBytes;
		this.txLogger.logTransactionEvent(operation.transferId, "import_requested",
			`Upload import requested for ${operation.platformName}`, {
				targetInstanceId: resolved.id,
				payloadSizeBytes,
			});
		this.subscriptions.emitTransferUpdate(operation);
		const uploadExportId = generateOperationId("uploaded");

		try {
			const response = await timed("Clusterio request round trip", "round-trip", () => this.c.sendTo(
				{ instanceId: resolved.id },
				new messages.ImportPlatformRequest({
					exportId: uploadExportId,
					exportData: importData,
					forceName: resolvedForceName,
					targetPlanet: targetPlanet ?? null,
				}),
			)) as messages.SimpleResponse & { platformName?: string; targetInstanceId?: number };
			if (!response?.success) {
				const error = response?.error || "Import failed on target instance";
				operation.error = error;
				await this.failOperation(operation, "import_failed", `Import request failed: ${error}`, { error });
				return {
					success: false,
					error,
					targetInstanceId: resolved.id,
				};
			}
			operation.status = "awaiting_completion";
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
			const errMsg = getErrorMessage(err);
			operation.error = errMsg;
			await this.failOperation(operation, "import_failed", `Import request failed: ${errMsg}`, { error: errMsg });
			this.logger.error(`Upload import failed: ${errMsg}`);
			return { success: false, error: errMsg };
		}
	}

	async handleExportPlatformForDownloadRequest(request: { sourceInstanceId: number; sourcePlatformIndex: number; forceName?: string }) {
		const clock = this.txLogger.beginObservation(`request:${randomUUID()}`);
		const result = await timingContext.run(clock, () => this.handleExportPlatformForDownloadRequestMeasured(request));
		if (!result.success && !clock.operationId) {
			try { await this.txLogger.rejectObservation(clock.jobId, { ...request, operationType: "export" }, result.error || "Export request rejected"); }
			catch (error) { this.logger.warn(`Rejected-request profiling failed: ${getErrorMessage(error)}`); }
		}
		return result;
	}

	async handleExportPlatformForDownloadRequestMeasured(request: { sourceInstanceId: number; sourcePlatformIndex: number; forceName?: string }) {
		const sourceInstanceId = Number(request.sourceInstanceId);
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
		const operation = await this.createOperationRecord("export", {
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

		try {
			const exportRequestStartMs = performance.now();
			const exportResponse = await timed("Clusterio request round trip", "round-trip", () => this.c.sendTo(
				{ instanceId: sourceInstanceId },
				new messages.ExportPlatformRequest({
					operationId: timingContext.getStore()?.operationId ?? timingContext.getStore()?.jobId,
					platformIndex: sourcePlatformIndex,
					forceName,
					targetInstanceId: null,
				}),
			)) as messages.SimpleResponse & { exportId?: string; error?: string };
			const exportRequestMs = performance.now() - exportRequestStartMs;
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
			const stored = await timed("Await artifact storage", "wait", () => this.orchestrator.waitForStoredExport(canonicalExportId, 60000));
			const waitForStoredMs = performance.now() - waitForStoreStartMs;
			operation.platformName = stored.platformName || operation.platformName;
			operation.sourceInstanceId = stored.instanceId;
			operation.sourceInstanceName = this.platformTree.resolveInstanceName(stored.instanceId);
			operation.exportMetrics = normalizeExportMetrics({
				...(stored.exportMetrics || {}),
				requestExportAndLockMs: exportRequestMs,
				waitForControllerStoreMs: waitForStoredMs,
				controllerExportPrepTotalMs: exportRequestMs + waitForStoredMs,
			});
			operation.payloadMetrics = buildPayloadMetrics(stored.exportData || {}).payloadMetrics;
			operation.artifactSizeBytes = stored.size ?? operation.artifactSizeBytes ?? null;
			operation.status = "completed";
			operation.completedAt = Date.now();
			const durationMs = this.txLogger.getObservedDuration(operation);
			this.txLogger.logTransactionEvent(operation.transferId, "export_completed",
				`Export ready for download: ${stored.exportId}`, {
					exportId: stored.exportId,
					durationMs,
					exportMetrics: operation.exportMetrics,
					payloadMetrics: operation.payloadMetrics,
				});
			this.subscriptions.emitTransferUpdate(operation);
			await this.txLogger.persistTransactionLog(operation.transferId);
			this.orchestrator.pruneOldTransfers();
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
			operation.error = errMsg;
			await this.failOperation(operation, "export_failed", `Export failed: ${errMsg}`, { error: errMsg });
			return { success: false, error: errMsg };
		}
	}

	async handleImportOperationCompleteEvent(event: messages.ImportOperationCompleteEvent) {
		const operationId = event.operationId.trim();
		if (!operationId) {
			return;
		}

		let operation = this.activeTransfers.get(operationId);
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
				|| event.failedStage === "belts" || event.failedStage === "test_hook") {
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

	private gatewayKey(sourceInstanceId: number, gatewayName: string): string {
		return `${sourceInstanceId}:${gatewayName}`;
	}

	private parseGatewayKey(key: string): { sourceInstanceId: number; gatewayName: string } | null {
		const idx = key.indexOf(":");
		if (idx <= 0) {
			return null;
		}
		const sourceInstanceId = Number(key.slice(0, idx));
		const gatewayName = key.slice(idx + 1);
		if (!Number.isInteger(sourceInstanceId) || !gatewayName) {
			return null;
		}
		return { sourceInstanceId, gatewayName };
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

	async loadGatewayConfig() {
		try {
			const content = await fs.readFile(this.gatewayConfigPath, "utf8");
			const entries: unknown = JSON.parse(content);
			if (!Array.isArray(entries)) {
				throw new Error("Expected an array of gateway entries");
			}
			const loaded = new Map<string, messages.GatewayLink[]>();
			const liveInstances = [...this.c.instances.values()].filter(inst => !inst.isDeleted);
			let migratedLegacy = 0;
			for (const entry of entries) {
				if (!(Array.isArray(entry) && entry.length === 2
					&& typeof entry[0] === "string" && Array.isArray(entry[1]))) {
					throw new Error("Invalid gateway entry");
				}
				const key = entry[0] as string;
				if (!entry[1].every(link => link && Number.isInteger(link.targetInstanceId)
					&& typeof link.targetGateway === "string" && link.targetGateway.length > 0)) {
					throw new Error(`Invalid targets for gateway '${key}'`);
				}
				const links = entry[1] as messages.GatewayLink[];
				const parsed = this.parseGatewayKey(key);
				if (parsed) {
					if (!(messages.ALL_GATEWAY_NAMES as readonly string[]).includes(parsed.gatewayName)) {
						this.logger.warn(`Dropping unknown gateway link '${key}'`);
						continue;
					}
					loaded.set(key, links);
				} else if ((messages.ALL_GATEWAY_NAMES as readonly string[]).includes(key)) {
					if (liveInstances.length === 0) {
						loaded.set(key, links);
						this.logger.warn(`Legacy gateway link '${key}' kept for migration on a later boot (no instances known yet)`);
						continue;
					}
					for (const inst of liveInstances) {
						const perInstance = links.filter(l => l.targetInstanceId !== inst.id);
						if (perInstance.length > 0) {
							loaded.set(this.gatewayKey(inst.id, key), perInstance);
						}
					}
					migratedLegacy += 1;
				} else {
					this.logger.warn(`Dropping unknown gateway link '${key}'`);
				}
			}
			this.gatewayLinks = loaded;
			this.gatewayConfigLoadError = null;
			if (migratedLegacy > 0) {
				const persistError = await this.persistGatewayConfig();
				if (persistError) {
					this.logger.warn(`Gateway migration is active in memory but could not be saved: ${persistError}`);
				} else {
					this.logger.warn(`Migrated ${migratedLegacy} legacy cluster-wide gateway link(s) to per-instance keys`);
				}
			}
			this.logger.info(`Loaded ${this.gatewayLinks.size} gateway link(s) from disk`);
		} catch (err: unknown) {
			const code = (err as { code?: string }).code;
			if (code === "ENOENT") {
				this.gatewayConfigLoadError = null;
				this.logger.verbose("No existing gateway config found; starting fresh");
				return;
			}
			this.gatewayConfigLoadError = getErrorMessage(err);
			this.logger.error(`Failed to load gateway config; writes disabled to preserve the file: ${this.gatewayConfigLoadError}`);
		}
	}

	async persistGatewayConfig(links = this.gatewayLinks): Promise<string | null> {
		try {
			if (this.gatewayConfigLoadError) {
				throw new Error(`Existing gateway config could not be loaded; repair the file and restart the controller: ${this.gatewayConfigLoadError}`);
			}
			const payload = JSON.stringify(Array.from(links.entries()), null, 2);
			await enqueueWrite(this.gatewayConfigPath, () => lib.safeOutputFile(this.gatewayConfigPath, payload));
			return null;
		} catch (err: unknown) {
			const reason = getErrorMessage(err);
			this.logger.error(`Failed to persist gateway config: ${reason}`);
			return reason;
		}
	}


	async loadPendingTransfers() {
		try {
			const content = await fs.readFile(this.pendingTransfersPath, "utf8");
			const entries = JSON.parse(content);
			if (Array.isArray(entries)) {
				for (const e of entries) {
					if (e && typeof e.transferId === "string") {
						this.pendingTransfers.set(e.transferId, e as messages.PendingTransferIntent);
					}
				}
			}
			await this.prunePendingTransfers();
			if (this.pendingTransfers.size > 0) {
				this.logger.info(`Loaded ${this.pendingTransfers.size} pending transfer intent(s) from disk`);
			}
		} catch (err: unknown) {
			const code = (err as { code?: string }).code;
			if (code === "ENOENT") {
				return;
			}
			this.logger.error(`Failed to load pending transfers: ${getErrorMessage(err)}`);
		}
	}

	async persistPendingTransfers() {
		try {
			const payload = JSON.stringify(Array.from(this.pendingTransfers.values()), null, 2);
			await enqueueWrite(this.pendingTransfersPath, () => lib.safeOutputFile(this.pendingTransfersPath, payload));
		} catch (err: unknown) {
			this.logger.error(`Failed to persist pending transfers: ${getErrorMessage(err)}`);
		}
	}

	persistPendingTransfer(intent: messages.PendingTransferIntent): void {
		this.prunePendingTransfersInMemory();
		this.pendingTransfers.set(intent.transferId, intent);
		void this.persistPendingTransfers();
	}

	async prunePendingTransfers(now = Date.now()): Promise<number> {
		const pruned = this.prunePendingTransfersInMemory(now);
		if (pruned > 0) {
			this.logger.info(`Pruned ${pruned} stale pending transfer intent(s); Phase 1 recovery is source-side TTL unlock`);
			await this.persistPendingTransfers();
		}
		return pruned;
	}

	private prunePendingTransfersInMemory(now = Date.now()): number {
		let pruned = 0;
		for (const [transferId, intent] of this.pendingTransfers) {
			const startedAt = Number(intent.startedAt);
			if (!Number.isFinite(startedAt) || now - startedAt > PENDING_TRANSFER_INTENT_RETENTION_MS) {
				this.pendingTransfers.delete(transferId);
				pruned++;
			}
		}
		return pruned;
	}

	removePendingTransfer(transferId: string): void {
		if (this.pendingTransfers.delete(transferId)) {
			void this.persistPendingTransfers();
		}
	}

	async loadSourceCommitMarkers() {
		try {
			const content = await fs.readFile(this.sourceCommitMarkersPath, "utf8");
			const entries = JSON.parse(content);
			if (Array.isArray(entries)) {
				for (const e of entries) {
					if (e && typeof e.transferId === "string") {
						this.sourceCommitMarkers.set(e.transferId, e as messages.SourceCommitMarker);
					}
				}
			}
			await this.pruneSourceCommitMarkers();
		} catch (err: unknown) {
			const code = (err as { code?: string }).code;
			if (code === "ENOENT") {
				return;
			}
			this.logger.error(`Failed to load source COMMIT markers: ${getErrorMessage(err)}`);
		}
	}

	async persistSourceCommitMarkers() {
		try {
			const payload = JSON.stringify(Array.from(this.sourceCommitMarkers.values()), null, 2);
			await enqueueWrite(this.sourceCommitMarkersPath, () => lib.safeOutputFile(this.sourceCommitMarkersPath, payload));
		} catch (err: unknown) {
			this.logger.error(`Failed to persist source COMMIT markers: ${getErrorMessage(err)}`);
		}
	}

	recordCommitTransmitted(marker: messages.SourceCommitMarker): void {
		this.pruneSourceCommitMarkersInMemory();
		this.sourceCommitMarkers.set(marker.transferId, marker);
		void this.persistSourceCommitMarkers();
	}

	async pruneSourceCommitMarkers(now = Date.now()): Promise<number> {
		const pruned = this.pruneSourceCommitMarkersInMemory(now);
		if (pruned > 0) {
			this.logger.info(`Pruned ${pruned} stale source COMMIT marker(s)`);
			await this.persistSourceCommitMarkers();
		}
		return pruned;
	}

	private pruneSourceCommitMarkersInMemory(now = Date.now()): number {
		let pruned = 0;
		for (const [transferId, marker] of this.sourceCommitMarkers) {
			const committedAt = Number(marker.committedAt);
			if (!Number.isFinite(committedAt) || now - committedAt > SOURCE_COMMIT_MARKER_RETENTION_MS) {
				this.sourceCommitMarkers.delete(transferId);
				pruned++;
			}
		}
		return pruned;
	}
	isInstanceOnline(instanceId: number): boolean {
		const inst = this.c.instances.get(instanceId);
		if (!inst || inst.isDeleted) {
			return false;
		}
		const hostId = Number(inst.config.get("instance.assigned_host"));
		const host = Number.isInteger(hostId) ? this.c.hosts.get(hostId) : null;
		return Boolean(host?.connected) && String(inst.status) === "running";
	}

	private resolveGateways(sourceInstanceId: number): messages.ResolvedGateway[] {
		const out: messages.ResolvedGateway[] = [];
		for (const [key, links] of this.gatewayLinks.entries()) {
			const parsed = this.parseGatewayKey(key);
			if (!parsed || parsed.sourceInstanceId !== sourceInstanceId) {
				continue;
			}
			const targets = (links || []).map(link => ({
				instanceId: link.targetInstanceId,
				instanceName: this.platformTree.resolveInstanceName(link.targetInstanceId) ?? "(unknown)",
				targetGateway: link.targetGateway,
				online: this.isInstanceOnline(link.targetInstanceId),
			}));
			out.push({ gatewayName: parsed.gatewayName, targets });
		}
		return out;
	}

	private async pushGatewayConfigToInstance(sourceInstanceId: number): Promise<string | null> {
		if (!this.isInstanceOnline(sourceInstanceId)) {
			return null;
		}
		try {
			const gateways = this.resolveGateways(sourceInstanceId);
			const response = await timed("Clusterio request round trip", "round-trip", () => this.c.sendTo(
				{ instanceId: sourceInstanceId },
				new messages.PushGatewayConfigRequest({
					gateways,
					activeGatewayNames: messages.gatewayNamesFor(this.gatewayMode()),
				}),
			)) as { success?: boolean; error?: string } | undefined;
			if (!response?.success) {
				const reason = response?.error || "the instance rejected the gateway config";
				this.logger.error(`Instance ${sourceInstanceId} did not apply the gateway config: ${reason}`);
				return reason;
			}
			return null;
		} catch (err: unknown) {
			const reason = getErrorMessage(err);
			this.logger.error(`Failed to push gateway config to instance ${sourceInstanceId}: ${reason}`);
			return reason;
		}
	}

	async handleGetGatewaysRequest(_request: Record<string, never>) {
		const activeNames = messages.gatewayNamesFor(this.gatewayMode());
		const links = Array.from(this.gatewayLinks.entries()).flatMap(([key, targets]) => {
			const parsed = this.parseGatewayKey(key);
			if (!parsed || !activeNames.includes(parsed.gatewayName)) {
				return [];
			}
			return [{ sourceInstanceId: parsed.sourceInstanceId, gatewayName: parsed.gatewayName, targets }];
		});
		return {
			gatewayMode: this.gatewayMode(),
			gatewayNames: activeNames,
			links,
		};
	}

	handleSetGatewayLinkRequest(request: GatewayLinkUpdate) {
		const previous = this.gatewayConfigUpdate ?? Promise.resolve();
		const update = previous.then(() => this.applyGatewayLinkRequest(request));
		this.gatewayConfigUpdate = update.then(() => undefined, () => undefined);
		return update;
	}

	private async applyGatewayLinkRequest(request: GatewayLinkUpdate) {
		const sourceInstanceId = Number(request.sourceInstanceId);
		const mode = this.gatewayMode();
		const activeNames = messages.gatewayNamesFor(mode);
		const submitted = request.gateways || [];
		if (!submitted.length) {
			return { success: false, error: "No gateways in the request" };
		}
		const sourceInstance = this.c.instances.get(sourceInstanceId);
		if (!sourceInstance || sourceInstance.isDeleted) {
			return { success: false, error: `Unknown source instance: ${request.sourceInstanceId}` };
		}

		const normalized = new Map<string, messages.GatewayLink[]>();
		for (const entry of submitted) {
			const gatewayName = entry?.gatewayName;
			if (!gatewayName || !activeNames.includes(gatewayName)) {
				return { success: false, error: `Unknown gateway for ${mode} mode: ${gatewayName}` };
			}
			if (normalized.has(gatewayName)) {
				return { success: false, error: `Gateway '${gatewayName}' appears twice in one request` };
			}
			normalized.set(gatewayName, (entry.targets || [])
				.filter(t => Number.isInteger(Number(t.targetInstanceId)) && Number(t.targetInstanceId) !== sourceInstanceId)
				.map(t => ({ targetInstanceId: Number(t.targetInstanceId), targetGateway: t.targetGateway || gatewayName })));
		}

		if (mode === "multi") {
			const proposed = new Map<string, messages.GatewayLink[]>();
			for (const name of messages.MULTI_GATEWAY_NAMES) {
				const next = normalized.has(name)
					? normalized.get(name)
					: this.gatewayLinks.get(this.gatewayKey(sourceInstanceId, name));
				if (next?.length) {
					proposed.set(name, next);
				}
			}
			for (const [gatewayName, targets] of normalized) {
				const others = new Map(proposed);
				others.delete(gatewayName);
				const violation = messages.checkMultiModeLink(gatewayName, targets, others);
				if (violation) {
					return { success: false, error: violation };
				}
			}
		}

		const updated = new Map(this.gatewayLinks);
		for (const [gatewayName, targets] of normalized) {
			const key = this.gatewayKey(sourceInstanceId, gatewayName);
			if (targets.length > 0) {
				updated.set(key, targets);
			} else {
				updated.delete(key);
			}
		}
		const persistError = await this.persistGatewayConfig(updated);
		if (persistError) {
			return { success: false, error: `Gateway config could not be written to disk: ${persistError}` };
		}
		this.gatewayLinks = updated;
		const pushError = await this.pushGatewayConfigToInstance(sourceInstanceId);
		this.logger.info(
			`Instance ${sourceInstanceId} gateways set: `
			+ [...normalized].map(([name, targets]) => `${name}=${targets.length}`).join(", "),
		);
		if (pushError) {
			return {
				success: true,
				error: `Saved, but instance ${sourceInstanceId} is still running the previous gateway config: ${pushError}`,
			};
		}
		return { success: true };
	}

	async handleGetGatewayConfigRequest(request: { instanceId: number }) {
		return {
			gateways: this.resolveGateways(Number(request.instanceId)),
			activeGatewayNames: messages.gatewayNamesFor(this.gatewayMode()),
		};
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
