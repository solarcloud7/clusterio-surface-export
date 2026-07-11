/**
 * @file controller.ts
 * @description Controller plugin for Surface Export - runs on central controller.
 * Delegates to focused modules in lib/ for transfer orchestration, tree building,
 * transaction logging, and subscription management.
 * @see https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md
 */

import fs from "fs/promises";
import path from "path";
import { BaseControllerPlugin } from "@clusterio/controller";
import type { Controller } from "@clusterio/controller";
import * as lib from "@clusterio/lib";
import { PlatformTree } from "./lib/platform-tree";
import { TransactionLogger } from "./lib/transaction-logger";
import { SubscriptionManager } from "./lib/subscription-manager";
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
import { normalizeExportMetrics, getErrorMessage, generateOperationId, TICKS_TO_MS, STORAGE_FILENAME, buildPayloadMetrics, buildImportMetrics, makeCanonicalTransferId, parseCanonicalTransferId } from "./helpers";

const PLUGIN_NAME = "surface_export";
export const PENDING_TRANSFER_INTENT_RETENTION_MS = 15 * 60 * 1000;
export const SOURCE_COMMIT_MARKER_RETENTION_MS = PENDING_TRANSFER_INTENT_RETENTION_MS * 2;

export class ControllerPlugin extends BaseControllerPlugin {
	private get c(): Controller { return this.controller; }
	/**
	 * Read a config key that isn't in ControllerConfig's strict field union (our custom
	 * plugin keys). Bypasses the keyed Config.get typing.
	 */
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
	transactionLogPath!: string;
	platformTree!: PlatformTree;
	txLogger!: TransactionLogger;
	subscriptions!: SubscriptionManager;
	orchestrator!: TransferOrchestrator;
	/** Gateway → destination links (raw, the source of truth). Keyed by `${sourceInstanceId}:${gatewayName}`
	 * so each source instance owns its own gateway config. Persisted. */
	gatewayLinks!: Map<string, messages.GatewayLink[]>;
	gatewayConfigPath!: string;
	/** Transfers persisted while awaiting_validation for observability and future Phase 2 re-adoption. */
	pendingTransfers!: Map<string, messages.PendingTransferIntent>;
	pendingTransfersPath!: string;
	sourceCommitMarkers!: Map<string, messages.SourceCommitMarker>;
	sourceCommitMarkersPath!: string;

	async init() {
		this.logger.info("Surface Export controller plugin initializing...");

		// Shared state
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

		this.storagePath = path.resolve(
			String(this.c.config.get("controller.database_directory")),
			STORAGE_FILENAME,
		);
		this.transactionLogPath = path.resolve(
			String(this.c.config.get("controller.database_directory")),
			"surface_export_transaction_logs.json",
		);
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

		// Instantiate modules (order matters: txLogger before subscriptions,
		// platformTree before orchestrator)
		this.platformTree = new PlatformTree(this as unknown as IControllerPlugin, messages);
		this.txLogger = new TransactionLogger(this as unknown as IControllerPlugin);
		this.subscriptions = new SubscriptionManager(this as unknown as IControllerPlugin, lib, messages);
		this.orchestrator = new TransferOrchestrator(this as unknown as IControllerPlugin, messages);

		await this.loadStorage();
		await this.txLogger.loadTransactionLogs();
		await this.loadGatewayConfig();
		await this.loadPendingTransfers();
		await this.loadSourceCommitMarkers();

		// Register message handlers
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

	async onShutdown() {
		this.subscriptions.treeBroadcastLimiter.cancel();
		this.logger.info(`Shutting down - ${this.platformStorage.size} platforms in storage`);
	}

	onControlConnectionEvent(connection: unknown, event: string) {
		if (event === "close") {
			this.surfaceExportSubscriptions.delete(
				connection as { send: (event: unknown) => void; user: { checkPermission: (permission: string) => void } },
			);
		}
	}

	async handlePlatformExport(event: { exportId: string; platformName: string; platformIndex?: number | null; instanceId: number; exportData: ExportData; exportMetrics?: messages.ExportMetrics; timestamp: number }) {
		const sourceExportId = event.exportId;
		const canonicalExportId = makeCanonicalTransferId(event.instanceId, sourceExportId);
		this.logger.info(`Received platform export: ${canonicalExportId} (source ${sourceExportId}) from instance ${event.instanceId} (${event.platformName})`);

		try {
			const serializedSize = Buffer.byteLength(JSON.stringify(event.exportData), "utf8");
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

			const maxStorage = Number(this.cfg(`${PLUGIN_NAME}.max_storage_size`));
			if (Number.isFinite(maxStorage) && this.platformStorage.size > maxStorage) {
				this.cleanupOldExports(maxStorage);
			}
			await this.persistStorage();
			this.subscriptions.queueTreeBroadcast("player");
		} catch (err: unknown) {
			this.logger.error(`Error handling platform export: ${getErrorMessage(err)}`);
		}
	}

	/**
	 * Handle platform state change event from an instance.
	 * Records wall-clock departure time and triggers a tree broadcast.
	 */
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
		this.persistStorage().catch((err: unknown) => {
			this.logger.error(`Failed to persist after cleanup: ${getErrorMessage(err)}`);
		});
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

	createOperationRecord(operationType: OperationType, options: OperationOptions = {}) {
		const operation = buildOperationRecord(operationType, {
			...options,
			resolveInstanceName: (instanceId: number) => this.platformTree.resolveInstanceName(instanceId),
		});
		this.activeTransfers.set(operation.transferId, operation);
		return operation;
	}

	async handleImportUploadedExportRequest(request: { targetInstanceId: number; exportData: ExportData; forceName?: string; platformName?: string | null; targetPlanet?: string | null }) {
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
		const operation = this.createOperationRecord("import", {
			platformName: importData.platform_name || "Uploaded platform",
			forceName: resolvedForceName,
			sourceInstanceId: -1,
			sourceInstanceName: "Uploaded JSON",
			targetInstanceId: resolved.id,
		});
		(importData as Record<string, unknown>)._operationId = operation.transferId;
		const payloadSizeBytes = Buffer.byteLength(JSON.stringify(importData), "utf8");
		operation.artifactSizeBytes = payloadSizeBytes;
		this.txLogger.logTransactionEvent(operation.transferId, "import_requested",
			`Upload import requested for ${operation.platformName}`, {
				targetInstanceId: resolved.id,
				payloadSizeBytes,
			});
		this.subscriptions.emitTransferUpdate(operation);
		const uploadExportId = generateOperationId("uploaded");

		try {
			const response = await this.c.sendTo(
				{ instanceId: resolved.id },
				new messages.ImportPlatformRequest({
					exportId: uploadExportId,
					exportData: importData,
					forceName: resolvedForceName,
					targetPlanet: targetPlanet ?? null,
				}),
			) as messages.SimpleResponse & { platformName?: string; targetInstanceId?: number };
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
		const operation = this.createOperationRecord("export", {
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
			const exportRequestStartMs = Date.now();
			const exportResponse = await this.c.sendTo(
				{ instanceId: sourceInstanceId },
				new messages.ExportPlatformRequest({
					platformIndex: sourcePlatformIndex,
					forceName,
					targetInstanceId: null,
				}),
			) as messages.SimpleResponse & { exportId?: string; error?: string };
			const exportRequestMs = Date.now() - exportRequestStartMs;
			if (!exportResponse?.success || !exportResponse.exportId) {
				const error = exportResponse?.error || "Export failed";
				operation.error = error;
				await this.failOperation(operation, "export_failed", `Export request failed: ${error}`, { error, exportRequestMs });
				return { success: false, error };
			}
			const waitForStoreStartMs = Date.now();

			const canonicalExportId = makeCanonicalTransferId(sourceInstanceId, exportResponse.exportId);
			const stored = await this.orchestrator.waitForStoredExport(canonicalExportId, 60000);
			const waitForStoredMs = Date.now() - waitForStoreStartMs;
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
			const durationMs = operation.completedAt - operation.startedAt;
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
			operation = this.createOperationRecord("import", {
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

		if (event.success) {
			operation.status = "completed";
			operation.completedAt = Date.now();
			const durationMs = operation.completedAt - operation.startedAt;
			this.txLogger.logTransactionEvent(operation.transferId, "import_completed",
				`Import completed on instance ${operation.targetInstanceId}`, {
					durationMs,
					importMetrics: operation.importMetrics,
				});
		} else {
			const error = event.error || "Import failed";
			operation.status = "failed";
			operation.error = error;
			operation.failedAt = Date.now();
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

		return { success: false, error: `Transaction log not found for transfer: ${transferId}` };
	}

	canonicalizeStoredExport(entry: StoredExport): StoredExport {
		const parsed = parseCanonicalTransferId(entry.exportId);
		if (parsed) {
			return { ...entry, exportId: entry.exportId, sourceExportId: entry.sourceExportId || parsed.sourceJobId };
		}
		if (Number.isInteger(Number(entry.instanceId)) && Number(entry.instanceId) > 0) {
			const sourceExportId = entry.sourceExportId || entry.exportId;
			return { ...entry, exportId: makeCanonicalTransferId(Number(entry.instanceId), sourceExportId), sourceExportId };
		}
		this.logger.warn(`Cannot canonicalize stored export ${entry.exportId}: missing numeric instanceId; preserving legacy key`);
		return { ...entry, sourceExportId: entry.sourceExportId || entry.exportId };
	}

	async loadStorage() {
		try {
			const content = await fs.readFile(this.storagePath, "utf8");
			const entries = JSON.parse(content);
			if (Array.isArray(entries)) {
				for (const rawEntry of entries) {
					if (rawEntry && rawEntry.exportId) {
						const entry = rawEntry as StoredExport;
						if (!entry.size && entry.exportData) {
							entry.size = Buffer.byteLength(JSON.stringify(entry.exportData), "utf8");
						}
						const stored = this.canonicalizeStoredExport(entry);
						this.platformStorage.set(stored.exportId, stored);
					}
				}
			}
			this.storageLoadError = null;
			this.logger.info(`Loaded ${this.platformStorage.size} stored platforms from disk`);
		} catch (err: unknown) {
			const code = (err as { code?: string }).code;
			if (code === "ENOENT") {
				this.storageLoadError = null;
				this.logger.verbose("No existing Surface Export storage found; starting fresh");
				return;
			}
			this.storageLoadError = getErrorMessage(err);
			this.logger.error(
				`Stored exports could not be loaded from ${this.storagePath}: ${this.storageLoadError}. `
				+ "Persistence is DISABLED for this session to protect the existing file. To recover: stop the controller, "
				+ `back up ${this.storagePath}, repair or move the file aside, then restart. Stored exports from before this `
				+ "error will reappear after a successful load; exports created while degraded will NOT survive a restart.",
			);
		}
	}

	async persistStorage() {
		if (this.storageLoadError !== null) {
			this.logger.error(
				`Refusing to persist stored exports to ${this.storagePath}: the startup load failed (${this.storageLoadError}) `
				+ "and the file is being preserved as-is. This session's changes will not survive restart. "
				+ "Repair or move the file and restart the controller to re-enable persistence.",
			);
			return;
		}
		try {
			const payload = JSON.stringify(Array.from(this.platformStorage.values()), null, 2);
			await lib.safeOutputFile(this.storagePath, payload);
		} catch (err: unknown) {
			this.logger.error(`Failed to persist Surface Export storage: ${getErrorMessage(err)}`);
		}
	}

	// ── Gateway link config (WS2) ───────────────────────────────────────────
	// The controller persists RAW links ({targetInstanceId, targetGateway}) keyed by
	// `${sourceInstanceId}:${gatewayName}`; live instance_name/online are resolved only at read/push time
	// so they never go stale on disk. Gateway names never contain a colon, so the FIRST ":" splits the key.

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

	async loadGatewayConfig() {
		try {
			const content = await fs.readFile(this.gatewayConfigPath, "utf8");
			const entries = JSON.parse(content);
			// Snapshot of live instances, for migrating legacy cluster-wide links (below). Taken once.
			const liveInstances = [...this.c.instances.values()].filter(inst => !inst.isDeleted);
			let migratedLegacy = 0;
			if (Array.isArray(entries)) {
				for (const entry of entries) {
					if (!(Array.isArray(entry) && typeof entry[0] === "string" && Array.isArray(entry[1]))) {
						continue;
					}
					const key = entry[0] as string;
					const links = entry[1] as messages.GatewayLink[];
					const parsed = this.parseGatewayKey(key);
					if (parsed) {
						// New per-instance composite key. Drop links for gateway names this build doesn't know
						// (GATEWAY_COUNT shrank, or a hand-edited file) — they'd be pushed yet be invisible and
						// unremovable in the web editor, which only renders GATEWAY_NAMES per instance.
						if (!(messages.GATEWAY_NAMES as readonly string[]).includes(parsed.gatewayName)) {
							this.logger.warn(`Dropping unknown gateway link '${key}'`);
							continue;
						}
						this.gatewayLinks.set(key, links);
					} else if ((messages.GATEWAY_NAMES as readonly string[]).includes(key)) {
						// LEGACY bare-name key from the pre-per-instance format. The old model pushed this SAME
						// config to every instance, so faithfully migrate by replicating it to each known
						// instance as source — dropping self-targets, which the per-instance model forbids.
						if (liveInstances.length === 0) {
							// No instances known yet at load: KEEP the bare key in memory (invisible to the
							// per-instance editor, never resolved/pushed since parseGatewayKey returns null) so it
							// survives on disk and is migrated on a later boot — never silently destroyed.
							this.gatewayLinks.set(key, links);
							this.logger.warn(`Legacy gateway link '${key}' kept for migration on a later boot (no instances known yet)`);
							continue;
						}
						for (const inst of liveInstances) {
							const perInstance = links.filter(l => l.targetInstanceId !== inst.id);
							if (perInstance.length > 0) {
								this.gatewayLinks.set(this.gatewayKey(inst.id, key), perInstance);
							}
						}
						migratedLegacy += 1;
					} else {
						this.logger.warn(`Dropping unknown gateway link '${key}'`);
					}
				}
			}
			if (migratedLegacy > 0) {
				// Rewrite the file in the new per-instance format so the one-time migration is durable.
				await this.persistGatewayConfig();
				this.logger.warn(`Migrated ${migratedLegacy} legacy cluster-wide gateway link(s) to per-instance keys`);
			}
			this.logger.info(`Loaded ${this.gatewayLinks.size} gateway link(s) from disk`);
		} catch (err: unknown) {
			const code = (err as { code?: string }).code;
			if (code === "ENOENT") {
				this.logger.verbose("No existing gateway config found; starting fresh");
				return;
			}
			this.logger.error(`Failed to load gateway config: ${getErrorMessage(err)}`);
		}
	}

	async persistGatewayConfig() {
		try {
			const payload = JSON.stringify(Array.from(this.gatewayLinks.entries()), null, 2);
			await lib.safeOutputFile(this.gatewayConfigPath, payload);
		} catch (err: unknown) {
			this.logger.error(`Failed to persist gateway config: ${getErrorMessage(err)}`);
		}
	}

	// ── #106 Phase-1 restart observability ──────────────────────────────────
	// A transfer awaiting validation lives only in memory (activeTransfers + the validation timeout), so a
	// controller restart used to strand its source platform locked-and-hidden. Phase 1 moves recovery into the
	// source save: transfer locks expire by game tick and auto-UNLOCK there. The controller keeps pending intents
	// only as bounded observability/future Phase-2 re-adoption state; it never auto-deletes or auto-unlocks on boot.

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
			await lib.safeOutputFile(this.pendingTransfersPath, payload);
		} catch (err: unknown) {
			this.logger.error(`Failed to persist pending transfers: ${getErrorMessage(err)}`);
		}
	}

	/** Orchestrator hook — a transfer entered awaiting_validation; persist for observability and future Phase 2
	 *  re-adoption. Phase 1 recovery is source-side TTL unlock; the controller never auto-acts on boot. */
	persistPendingTransfer(intent: messages.PendingTransferIntent): void {
		this.prunePendingTransfersInMemory();
		this.pendingTransfers.set(intent.transferId, intent);
		void this.persistPendingTransfers();
	}

	/** Bound the observability-only pending intent store. Phase 1 source recovery is authoritative in Lua. */
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

	/** Drop an intent from the persisted set after normal terminal resolution. */
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
			await lib.safeOutputFile(this.sourceCommitMarkersPath, payload);
		} catch (err: unknown) {
			this.logger.error(`Failed to persist source COMMIT markers: ${getErrorMessage(err)}`);
		}
	}

	/**
	 * Write-ahead hygiene only: this records that this controller attempted to transmit COMMIT.
	 * The source-phase query is authoritative for destructive compensation; never the flag alone.
	 */
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
	/**
	 * Is the instance reachable for a transfer — present, on a connected host, AND running? This is the
	 * single definition of "online"; the web Gateways editor's "(offline)" label MUST use the same
	 * (connected && status==="running"), or the editor and the pushed config disagree.
	 */
	private isInstanceOnline(instanceId: number): boolean {
		const inst = this.c.instances.get(instanceId);
		if (!inst || inst.isDeleted) {
			return false;
		}
		const hostId = Number(inst.config.get("instance.assigned_host"));
		const host = Number.isInteger(hostId) ? this.c.hosts.get(hostId) : null;
		return Boolean(host?.connected) && String(inst.status) === "running";
	}

	/**
	 * Resolve ONE source instance's raw links into the wire shape with live instance_name + online.
	 * NOTE: `online` is a SNAPSHOT taken at resolve (push/pull) time — @clusterio's BaseControllerPlugin
	 * exposes no instance-status hook to re-push on, so it is refreshed only on a config edit and on each
	 * instance's own startup. The in-game chooser (WS3) therefore treats `online` as an advisory hint, not
	 * a hard gate; the transfer itself is gated by live controller routing.
	 */
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

	/** Push ONE source instance its own resolved gateway config (best-effort; no-op if offline). */
	private async pushGatewayConfigToInstance(sourceInstanceId: number): Promise<void> {
		if (!this.isInstanceOnline(sourceInstanceId)) {
			return;
		}
		try {
			const gateways = this.resolveGateways(sourceInstanceId);
			await this.c.sendTo({ instanceId: sourceInstanceId }, new messages.PushGatewayConfigRequest({ gateways }));
		} catch (err: unknown) {
			this.logger.warn(`Failed to push gateway config to instance ${sourceInstanceId}: ${getErrorMessage(err)}`);
		}
	}

	/** control → controller: raw links (each tagged with its source instance) + the pinned gateway-name
	 * list (for the web editor, which groups by source instance). */
	async handleGetGatewaysRequest(_request: Record<string, never>) {
		const links = Array.from(this.gatewayLinks.entries()).flatMap(([key, targets]) => {
			const parsed = this.parseGatewayKey(key);
			return parsed ? [{ sourceInstanceId: parsed.sourceInstanceId, gatewayName: parsed.gatewayName, targets }] : [];
		});
		return {
			gatewayNames: [...messages.GATEWAY_NAMES],
			links,
		};
	}

	/** control → controller: replace the entire target list for one (source instance, gateway), persist,
	 * push the affected instance its own updated config. */
	async handleSetGatewayLinkRequest(request: { sourceInstanceId: number; gatewayName: string; targets: messages.GatewayLink[] }) {
		const { gatewayName } = request;
		const sourceInstanceId = Number(request.sourceInstanceId);
		if (!(messages.GATEWAY_NAMES as readonly string[]).includes(gatewayName)) {
			return { success: false, error: `Unknown gateway: ${gatewayName}` };
		}
		// A non-integer/NaN id yields undefined from instances.get() (caught by !sourceInstance).
		const sourceInstance = this.c.instances.get(sourceInstanceId);
		if (!sourceInstance || sourceInstance.isDeleted) {
			return { success: false, error: `Unknown source instance: ${request.sourceInstanceId}` };
		}
		const key = this.gatewayKey(sourceInstanceId, gatewayName);
		// Normalize: keep only links with a valid integer instance id that is NOT the source itself (an
		// instance can't gateway-transfer to its own instance — enforced here, not just in the web dropdown,
		// so a hand-edited config or future import path can't persist a self-referential target); default a
		// blank target gateway to the source gateway name (the 1:1 default).
		const targets: messages.GatewayLink[] = (request.targets || [])
			.filter(t => Number.isInteger(Number(t.targetInstanceId)) && Number(t.targetInstanceId) !== sourceInstanceId)
			.map(t => ({ targetInstanceId: Number(t.targetInstanceId), targetGateway: t.targetGateway || gatewayName }));
		if (targets.length > 0) {
			this.gatewayLinks.set(key, targets);
		} else {
			this.gatewayLinks.delete(key);
		}
		await this.persistGatewayConfig();
		await this.pushGatewayConfigToInstance(sourceInstanceId);
		this.logger.info(`Gateway '${gatewayName}' on instance ${sourceInstanceId} links set: ${targets.length} target(s)`);
		return { success: true };
	}

	/** instance → controller: pull the requesting instance's own resolved gateway config on instance start. */
	async handleGetGatewayConfigRequest(request: { instanceId: number }) {
		return { gateways: this.resolveGateways(Number(request.instanceId)) };
	}
}

