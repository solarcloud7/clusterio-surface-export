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
import { PlatformTree, instanceAddress } from "./lib/platform-tree";
import { TransactionLogger } from "./lib/transaction-logger";
import { SubscriptionManager } from "./lib/subscription-manager";
import { enqueueWrite } from "./lib/persist-queue";
import { appendAuditRow, buildAuditRow, foldAuditRows, countRevisions, loadAuditLedger } from "./lib/audit-ledger";
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

	/**
	 * Which gateway layout this cluster runs.
	 *
	 * Clusterio has no enum field type, so the setting arrives as free text and a typo would
	 * otherwise mean "no gateways at all" rather than an error. Warns ONCE per distinct bad value
	 * rather than on every read: this is called per request, and a misconfigured cluster would
	 * otherwise fill the log with the same line.
	 */
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
	/** Consecutive failed persistStorage writes; reset on success. Drives escalation only. */
	consecutiveStorageWriteFailures!: number;
	transactionLogPath!: string;
	auditLedgerPath!: string;
	/** Folded ledger, one row per transfer. The source for the transfer LIST. */
	auditIndex!: Map<string, AuditRow>;
	auditRevisions!: Map<string, number>;
	/** Latched at boot: refuses detail writes when the store could not be read. */
	transactionLogLoadError!: string | null;
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

		// Instantiate modules (order matters: txLogger before subscriptions,
		// platformTree before orchestrator)
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
		// Deliberately does NOT persist. The sole caller (handlePlatformExport) awaits persistStorage
		// on the line after this returns, UNCONDITIONALLY — outside the size check that gated the call
		// to here — so this method's own fire-and-forget persist wrote the same snapshot a moment
		// before that one, and the two raced on safeOutputFile's shared temp path. That collision was
		// deterministic rather than occasional: with max_storage_size at 20 and the store sitting at
		// its cap, eviction fires on essentially every export, so it produced roughly one
		// "ENOENT ... rename 'surface_export_storage.tmp.json'" per export (143 of them since
		// 2026-07-26). If a future caller invokes cleanup WITHOUT persisting after, it must persist
		// itself — do not restore a write here.
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

	/**
	 * The single place an operation record is born — import, export and transfer all pass through it.
	 *
	 * The audit START row is recorded HERE rather than at each caller. Recorded per-caller it covered
	 * transfers only, so an upload-import whose destination died before the completion callback, or a
	 * controller restart mid-import, still left zero rows in the ledger — the exact failure start rows
	 * were introduced to close, for two of the three operation types.
	 */
	async createOperationRecord(operationType: OperationType, options: OperationOptions = {}) {
		const operation = buildOperationRecord(operationType, {
			...options,
			resolveInstanceName: (instanceId: number) => this.platformTree.resolveInstanceName(instanceId),
		});
		this.txLogger.archiveRecycledTransferId(operation.transferId, operation.startedAt);
		this.activeTransfers.set(operation.transferId, operation);
		await this.recordTransferStarted(operation);
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
		const operation = await this.createOperationRecord("import", {
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

		// The detail was evicted by retention, but the transfer itself is not gone — the ledger still
		// has it, and it is still listed in the UI. Returning success:false here made the web client
		// throw and show a red error toast (web/index.tsx rejects on !success), which flatly
		// contradicted the shipped config text promising that lowering the cap "never hides a
		// transfer, it only means older ones open without a timeline". After the measured migration
		// that was 353 of 453 rows: every one of them an error on click.
		//
		// `events: []` rather than null is required, not stylistic: the response schema declares
		// events as a non-nullable array, and the web client only replaces its cached events when it
		// receives an array — null would silently leave the PREVIOUS transfer's timeline on screen.
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
			await enqueueWrite(this.storagePath, () => lib.safeOutputFile(this.storagePath, payload));
			this.consecutiveStorageWriteFailures = 0;
		} catch (err: unknown) {
			// A WRITE failure is not latched the way a READ failure is: the read path sets
			// storageLoadError and refuses forever to protect a file it could not understand, but a
			// write failure may be transient (a full disk that gets cleared, a transient EBUSY), and
			// latching would throw away exports we could still have saved.
			//
			// The cost of that choice is silence: before this counter, a permanently failing write
			// logged one identical line per export and never escalated, so a controller that had
			// stopped persisting entirely looked exactly like one that hiccuped once. Count the run
			// and say so, which is the part that was missing.
			// `?? 0` rather than a bare increment: tests construct the plugin with
			// Object.create(ControllerPlugin.prototype) and never run init(), so the field can be
			// undefined here — and `undefined + 1` is NaN, which would silently disable the
			// escalation instead of failing loudly.
			this.consecutiveStorageWriteFailures = (this.consecutiveStorageWriteFailures ?? 0) + 1;
			const run = this.consecutiveStorageWriteFailures;
			const suffix = run > 1
				? ` This is failure #${run} in a row — stored exports have not reached disk since the last `
					+ "success, so nothing created in that window will survive a controller restart. "
					+ "Check free space and permissions on the database directory."
				: "";
			this.logger.error(`Failed to persist Surface Export storage: ${getErrorMessage(err)}.${suffix}`);
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

	/**
	 * Load the audit ledger into the in-memory index, migrating from the detail store on first run.
	 *
	 * Runs AFTER loadTransactionLogs because the migration derives its rows from the detail entries
	 * that call just loaded — on an existing cluster that is the only place the history exists.
	 */
	async loadAuditIndex() {
		try {
			let { rows, skipped } = await loadAuditLedger(this.auditLedgerPath);
			if (!rows.length && this.persistedTransactionLogs.length) {
				rows = await this.migrateAuditLedger();
			}
			for (const drop of skipped) {
				// Named precisely enough to find by hand. A torn final line is the expected shape
				// after power loss and costs exactly that line, rather than the whole history.
				this.logger.warn(
					`Audit ledger: skipped unreadable line ${drop.lineNumber} at byte ${drop.byteOffset} `
					+ `(${drop.reason}). Every other row was loaded.`,
				);
			}
			this.auditIndex = foldAuditRows(rows);
			this.auditRevisions = countRevisions(rows);
			this.logger.info(
				`Audit ledger: ${this.auditIndex.size} transfer(s) from ${rows.length} row(s)`
				+ (skipped.length ? `, ${skipped.length} unreadable line(s) skipped` : ""),
			);
		} catch (err: unknown) {
			// Deliberately NOT fatal and deliberately not latching: the ledger is an observability
			// record, and a controller that refuses to start because it cannot read its history would
			// be a worse failure than one that starts with an empty index and says so. New rows still
			// append, so the ledger repairs itself going forward.
			this.auditIndex = new Map();
			this.auditRevisions = new Map();
			this.logger.error(
				`Audit ledger at ${this.auditLedgerPath} could not be read (${getErrorMessage(err)}). `
				+ "The LIST falls back to the detail store, so history is limited to the retention window "
				+ "(transaction_log_detail_entries) instead of every transfer ever run, until this is fixed "
				+ "and the controller restarts. New transfers are still recorded. NOTE: the most likely "
				+ "cause is not a read at all — migrateAuditLedger WRITES inside this same block, and "
				+ "loadAuditLedger already tolerates a missing file and damaged lines on its own.",
			);
		}
	}

	/**
	 * First-run migration: derive one terminal row per existing detail entry.
	 *
	 * Written with a single atomic replace rather than appended row by row, so the ledger either
	 * exists complete or does not exist at all. That is what makes re-running safe: a crash partway
	 * through leaves no ledger, and the next boot re-derives from the detail store, which this
	 * migration never modifies.
	 */
	async migrateAuditLedger(): Promise<AuditRow[]> {
		const rows = [...this.persistedTransactionLogs]
			.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))
			.map(entry => {
				const events = Array.isArray(entry.events) ? entry.events : [];
				const lastEvent = events.length ? events[events.length - 1] : null;
				return buildAuditRow({
					transferId: entry.transferId,
					rowKind: "terminal",
					savedAt: entry.savedAt || 0,
					eventCount: events.length,
					lastEventAt: lastEvent?.timestampMs ?? null,
					info: entry.transferInfo || {},
				});
			});
		const payload = rows.map(row => `${JSON.stringify(row)}
`).join("");
		await enqueueWrite(this.auditLedgerPath, () => lib.safeOutputFile(this.auditLedgerPath, payload));
		this.logger.info(
			`Audit ledger: migrated ${rows.length} transfer(s) from the detail store into `
			+ `${this.auditLedgerPath}. The detail store was not modified. NOTE: that store is a BOUNDED `
			+ "window (transaction_log_detail_entries), so this migration recovers only the transfers "
			+ "still inside it. Any older than the window are not represented — this is the full set the "
			+ "controller still holds, not necessarily the full set that ever ran.",
		);
		return rows;
	}

	/**
	 * Record one transfer in the ledger and update the in-memory index.
	 *
	 * Failure is logged, never thrown: this is called from the persist path at terminal resolution,
	 * and a ledger write must not be able to fail a transfer that has already succeeded.
	 */
	async recordAuditRow(row: AuditRow) {
		try {
			await appendAuditRow(this.auditLedgerPath, row);
			const existing = this.auditIndex.get(row.transferId);
			if (!(existing && existing.rowKind === "terminal" && row.rowKind === "start")) {
				this.auditIndex.set(row.transferId, row);
			}
			if (row.rowKind === "terminal") {
				this.auditRevisions.set(row.transferId, (this.auditRevisions.get(row.transferId) ?? 0) + 1);
			}
		} catch (err: unknown) {
			// This message used to end "its detail entry still carries the full record" — true at this
			// instant and false once retention runs, with nothing reconciling the two. The detail entry
			// is a WINDOW; the row was the permanent record, and it is the one that just failed.
			//
			// Two mitigations now hold the line, and neither is a substitute for fixing the write:
			// getTransferSummaries falls back to the detail store so the transfer stays listed, and
			// applyDetailRetention prefers row-less entries when it trims. Both are bounded.
			this.logger.error(
				`Audit ledger: failed to record ${row.rowKind} row for ${row.transferId} `
				+ `(${getErrorMessage(err)}). The transfer itself is unaffected and its detail entry is `
				+ "intact, but this transfer now has NO permanent audit row — it will disappear from the "
				+ `history when its detail entry ages out of the retention window. Check that `
				+ `${this.auditLedgerPath} is writable.`,
			);
		}
	}

	/**
	 * Record that a transfer STARTED. Owns the row shape so the orchestrator does not have to, which
	 * also keeps the plugin surface the orchestrator depends on to one method rather than four.
	 */
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
						// New per-instance composite key. Validated against EVERY known gateway name, NOT the
						// active mode’s: a one-gate cluster still holds its multi-mode links on disk, and
						// dropping them here would make switching modes a destructive, un-undoable side effect
						// of a display setting. Names belonging to no set at all (a hand-edited file, or a
						// gateway this build genuinely no longer has) are still dropped — they would be pushed
						// to Lua yet be unreachable in an editor that only renders the active set.
						if (!(messages.ALL_GATEWAY_NAMES as readonly string[]).includes(parsed.gatewayName)) {
							this.logger.warn(`Dropping unknown gateway link '${key}'`);
							continue;
						}
						this.gatewayLinks.set(key, links);
					} else if ((messages.ALL_GATEWAY_NAMES as readonly string[]).includes(key)) {
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

	/**
	 * Write the gateway config. Returns the failure reason, or null when it really was written.
	 *
	 * It used to log and return normally, which made the caller's "Saved" a claim nobody had checked:
	 * a full disk or a permission error left the new link in the in-memory map — so the UI and every
	 * later read agreed with each other — and the edit vanished at the next controller restart with
	 * nothing user-visible ever having said so. `enqueueWrite` resolves THIS write's own promise
	 * (lib/persist-queue.ts), so the failure was always observable; it simply was not observed.
	 */
	async persistGatewayConfig(): Promise<string | null> {
		try {
			const payload = JSON.stringify(Array.from(this.gatewayLinks.entries()), null, 2);
			await enqueueWrite(this.gatewayConfigPath, () => lib.safeOutputFile(this.gatewayConfigPath, payload));
			return null;
		} catch (err: unknown) {
			const reason = getErrorMessage(err);
			this.logger.error(`Failed to persist gateway config: ${reason}`);
			return reason;
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
			await enqueueWrite(this.pendingTransfersPath, () => lib.safeOutputFile(this.pendingTransfersPath, payload));
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
			await enqueueWrite(this.sourceCommitMarkersPath, () => lib.safeOutputFile(this.sourceCommitMarkersPath, payload));
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
	 * Public (IControllerPlugin) since 2026-08-02: the transfer preflight refuses an offline
	 * destination up front with this same definition — a second implementation would drift.
	 */
	isInstanceOnline(instanceId: number): boolean {
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
	/**
	 * Push ONE source instance its own resolved gateway config.
	 *
	 * Returns the failure REASON instead of swallowing it. The push can fail for a reason the
	 * operator must act on — most sharply, `configureGateways` throws above 7000 bytes of assembled
	 * /sc command, which one-gate mode makes reachable because every destination concentrates onto a
	 * single key. This used to be caught into a `logger.warn`, so the config was persisted, the UI
	 * said “saved”, and the instance quietly kept running the PREVIOUS gateway config with the only
	 * trace in a host log nobody was reading. Saved-but-not-applied is exactly the state that has to
	 * be visible.
	 *
	 * An OFFLINE instance is not a failure: it pulls its config on start (GetGatewayConfigRequest).
	 */
	private async pushGatewayConfigToInstance(sourceInstanceId: number): Promise<string | null> {
		if (!this.isInstanceOnline(sourceInstanceId)) {
			return null;
		}
		try {
			const gateways = this.resolveGateways(sourceInstanceId);
			// THE RESPONSE IS THE FAILURE CHANNEL, and ignoring it made this whole function inert for
			// the one case it was written for. `handlePushGatewayConfig` (instance.ts) catches its own
			// errors and RESOLVES with `{ success: false, error }` — so an RCON-size refusal, or any
			// other Lua-side failure, arrives as a perfectly successful `sendTo`. Awaiting and
			// discarding it meant the catch below only ever fired on transport failure, and the
			// operator was told "Saved" while the instance kept running the previous config: exactly
			// the silent-stale-config bug this was supposed to end. Every other `sendTo` in this
			// plugin already reads `.success` (see handleImportUploadedExportRequest and
			// lib/transfer-orchestrator.ts) — this one was the outlier.
			const response = await this.c.sendTo(
				{ instanceId: sourceInstanceId },
				new messages.PushGatewayConfigRequest({
					gateways,
					activeGatewayNames: messages.gatewayNamesFor(this.gatewayMode()),
				}),
			) as { success?: boolean; error?: string } | undefined;
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

	/** control → controller: raw links (each tagged with its source instance) + the pinned gateway-name
	 * list (for the web editor, which groups by source instance). */
	/**
	 * The gateway config AS THE ACTIVE MODE SEES IT.
	 *
	 * Links are filtered to the active gateway set. The disk keeps both modes' links — that is what
	 * makes a mode switch lossless, and it is deliberate — but handing the inactive ones to the editor
	 * made them undeletable phantoms: `buildEdges` drew a full line for a link whose handles do not
	 * exist on the node in this mode, and deleting it staged a key that `handleSetGatewayLinkRequest`
	 * then refused as "Unknown gateway for one_gate mode". The board stayed permanently dirty and
	 * every later save re-sent and re-failed that key, dragging legitimate edits into a failure banner
	 * with no way out but a reload.
	 *
	 * Filtering here rather than in the canvas keeps one answer to "what may be edited": the same
	 * active set the write path validates against.
	 */
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

	/** control → controller: replace the entire target list for one (source instance, gateway), persist,
	 * push the affected instance its own updated config. */
	/**
	 * Apply every changed gateway on ONE instance as a single unit.
	 *
	 * ATOMIC BY DESIGN. Multi mode's second rule — no two gates on an instance aimed at the same
	 * destination — is a statement about the instance's whole layout, so it is checked against the
	 * PROPOSED layout (persisted, overlaid with everything in this request) rather than against
	 * whatever happens to be on disk part-way through a batch. Validating key-by-key judged states the
	 * operator never asked for: moving a destination from gate 2 to gate 1 was rejected on gate 1
	 * (gate 2 still held it) and then applied on gate 2, deleting the link; swapping two gates'
	 * destinations was rejected on both halves on every retry, making a legal layout unreachable.
	 *
	 * Nothing is written until every gateway in the request passes, so a rejected batch leaves the
	 * config exactly as it was.
	 */
	async handleSetGatewayLinkRequest(request: {
		sourceInstanceId: number;
		gateways: Array<{ gatewayName: string; targets: messages.GatewayLink[] }>;
	}) {
		const sourceInstanceId = Number(request.sourceInstanceId);
		const mode = this.gatewayMode();
		const activeNames = messages.gatewayNamesFor(mode);
		const submitted = request.gateways || [];
		if (!submitted.length) {
			return { success: false, error: "No gateways in the request" };
		}
		// A non-integer/NaN id yields undefined from instances.get() (caught by !sourceInstance).
		const sourceInstance = this.c.instances.get(sourceInstanceId);
		if (!sourceInstance || sourceInstance.isDeleted) {
			return { success: false, error: `Unknown source instance: ${request.sourceInstanceId}` };
		}

		// Normalize first, reject second, write third. Normalize: keep only links with a valid integer
		// instance id that is NOT the source itself (an instance can't gateway-transfer to its own
		// instance — enforced here, not just in the web dropdown, so a hand-edited config or future
		// import path can't persist a self-referential target); default a blank target gateway to the
		// source gateway name (the 1:1 default).
		const normalized = new Map<string, messages.GatewayLink[]>();
		for (const entry of submitted) {
			const gatewayName = entry?.gatewayName;
			// The ACTIVE set, unlike the load path's union: an operator can only edit gateways their
			// mode actually exposes, even though the other mode's links remain safely on disk.
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
			// Multi Cluster's two rules, enforced HERE and not only in the canvas: the web UI is one
			// caller, and a hand-edited config or a future import path must not be able to persist a
			// layout the mode does not permit. Rejected with a reason rather than truncated — silently
			// dropping the surplus is how a gateway ends up pointing somewhere nobody chose.
			//
			// `proposed` is the END state: what is on disk for the gateways this request does NOT touch,
			// plus what the request asks for. That is what makes a swap legal and a move safe.
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

		for (const [gatewayName, targets] of normalized) {
			const key = this.gatewayKey(sourceInstanceId, gatewayName);
			if (targets.length > 0) {
				this.gatewayLinks.set(key, targets);
			} else {
				this.gatewayLinks.delete(key);
			}
		}
		// A write failure is a REAL failure, not a warning: the in-memory map already holds the new
		// link, so the UI and every later read agree with each other and the operator has no way to
		// tell the edit will be gone at the next controller restart.
		const persistError = await this.persistGatewayConfig();
		if (persistError) {
			return { success: false, error: `Gateway config could not be written to disk: ${persistError}` };
		}
		const pushError = await this.pushGatewayConfigToInstance(sourceInstanceId);
		this.logger.info(
			`Instance ${sourceInstanceId} gateways set: `
			+ [...normalized].map(([name, targets]) => `${name}=${targets.length}`).join(", "),
		);
		if (pushError) {
			// The config IS saved — reporting failure here would invite a retry that changes nothing.
			// What the operator needs to know is that the running instance has not picked it up.
			return {
				success: true,
				error: `Saved, but instance ${sourceInstanceId} is still running the previous gateway config: ${pushError}`,
			};
		}
		return { success: true };
	}

	/** instance → controller: pull the requesting instance's own resolved gateway config on instance start. */
	async handleGetGatewayConfigRequest(request: { instanceId: number }) {
		return {
			gateways: this.resolveGateways(Number(request.instanceId)),
			activeGatewayNames: messages.gatewayNamesFor(this.gatewayMode()),
		};
	}

	/**
	 * The /teleport roster: every live instance with its client-routable address
	 * (`host.publicAddress:instance.gamePort`, the join the Layer-2 spike mapped). The address is
	 * built by `instanceAddress`, shared with the platform tree — see that function for the
	 * publicAddress and port-remapping caveats. Empty means no assigned game port, i.e. not
	 * running; the GUI refuses to connect to those.
	 */
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

