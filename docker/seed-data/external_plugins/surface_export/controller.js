/**
 * @file controller.ts
 * @description Controller plugin for Surface Export - runs on central controller.
 * Delegates to focused modules in lib/ for transfer orchestration, tree building,
 * transaction logging, and subscription management.
 * @see https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md
 */
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
function requireClusterioModule(moduleName) {
    if (require.main && typeof require.main.require === "function") {
        try {
            return require.main.require(moduleName);
        }
        catch (_err) {
            // Fallback to local resolution below.
        }
    }
    return require(moduleName);
}
const { BaseControllerPlugin } = requireClusterioModule("@clusterio/controller");
const lib = requireClusterioModule("@clusterio/lib");
const info = require("./index");
const messages = __importStar(require("./messages"));
const helpers_1 = require("./helpers");
const PlatformTree = require("./lib/platform-tree");
const TransactionLogger = require("./lib/transaction-logger");
const SubscriptionManager = require("./lib/subscription-manager");
const TransferOrchestrator = require("./lib/transfer-orchestrator");
const PLUGIN_NAME = info.plugin.name;
const STORAGE_FILENAME = "surface_export_storage.json";
const TICKS_TO_MS = 16.67;
function buildPayloadMetrics(exportData) {
    const verification = (exportData?.verification || {});
    const itemCounts = (verification.item_counts || {});
    const fluidCounts = (verification.fluid_counts || {});
    return {
        isCompressed: Boolean(exportData?.compressed),
        compressionType: exportData?.compression || "none",
        payloadSizeKB: exportData?.payload ? Math.round((exportData.payload.length / 1024) * 10) / 10 : null,
        entityCount: exportData?.stats?.entity_count || 0,
        tileCount: exportData?.stats?.tile_count || 0,
        uniqueItemTypes: Object.keys(itemCounts).length,
        totalItemCount: Object.values(itemCounts).reduce((sum, count) => sum + count, 0),
        uniqueFluidTypes: Object.keys(fluidCounts).length,
        totalFluidVolume: Math.round(Object.values(fluidCounts).reduce((sum, count) => sum + count, 0) * 10) / 10,
    };
}
function buildImportMetrics(raw, durationTicks = null) {
    if (!raw && durationTicks === null) {
        return null;
    }
    const input = raw && typeof raw === "object" ? raw : {};
    const tickFields = ["tiles", "entities", "fluids", "belts", "state", "validation", "total"];
    const countFields = ["tiles_placed", "entities_created", "entities_failed", "fluids_restored",
        "belt_items_restored", "circuits_connected", "total_items", "total_fluids"];
    const result = { total_ticks: Number(input.total_ticks || durationTicks || 0) };
    for (const field of tickFields) {
        const ticks = Number(input[`${field}_ticks`] || (field === "total" ? durationTicks || 0 : 0));
        result[`${field}_ticks`] = ticks;
        result[`${field}_ms`] = Math.round(ticks * TICKS_TO_MS);
    }
    for (const field of countFields) {
        result[field] = Number(input[field] || 0);
    }
    return result;
}
class ControllerPlugin extends BaseControllerPlugin {
    platformStorage;
    activeTransfers;
    platformDepartureTimes;
    transactionLogs;
    persistedTransactionLogs;
    surfaceExportSubscriptions;
    treeRevision;
    transferRevision;
    logRevision;
    lastTreeForceName;
    storagePath;
    transactionLogPath;
    platformTree;
    txLogger;
    subscriptions;
    orchestrator;
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
        this.storagePath = path_1.default.resolve(String(this.controller.config.get("controller.database_directory")), STORAGE_FILENAME);
        this.transactionLogPath = path_1.default.resolve(String(this.controller.config.get("controller.database_directory")), "surface_export_transaction_logs.json");
        // Instantiate modules (order matters: txLogger before subscriptions,
        // platformTree before orchestrator)
        this.platformTree = new PlatformTree(this, messages);
        this.txLogger = new TransactionLogger(this);
        this.subscriptions = new SubscriptionManager(this, lib, messages);
        this.orchestrator = new TransferOrchestrator(this, messages);
        await this.loadStorage();
        await this.txLogger.loadTransactionLogs();
        // Register message handlers
        this.controller.handle(messages.PlatformExportEvent, this.handlePlatformExport.bind(this));
        this.controller.handle(messages.ListExportsRequest, this.handleListExportsRequest.bind(this));
        this.controller.handle(messages.GetStoredExportRequest, this.handleGetStoredExportRequest.bind(this));
        this.controller.handle(messages.ImportUploadedExportRequest, this.handleImportUploadedExportRequest.bind(this));
        this.controller.handle(messages.ExportPlatformForDownloadRequest, this.handleExportPlatformForDownloadRequest.bind(this));
        this.controller.handle(messages.TransferPlatformRequest, this.orchestrator.handleTransferPlatformRequest.bind(this.orchestrator));
        this.controller.handle(messages.StartPlatformTransferRequest, this.orchestrator.handleStartPlatformTransferRequest.bind(this.orchestrator));
        this.controller.handle(messages.TransferValidationEvent, this.orchestrator.handleTransferValidation.bind(this.orchestrator));
        this.controller.handle(messages.ImportOperationCompleteEvent, this.handleImportOperationCompleteEvent.bind(this));
        this.controller.handle(messages.GetPlatformTreeRequest, this.handleGetPlatformTreeRequest.bind(this));
        this.controller.handle(messages.ListTransactionLogsRequest, this.handleListTransactionLogsRequest.bind(this));
        this.controller.handle(messages.GetTransactionLogRequest, this.handleGetTransactionLog.bind(this));
        this.controller.handle(messages.SetSurfaceExportSubscriptionRequest, this.subscriptions.handleSetSurfaceExportSubscriptionRequest.bind(this.subscriptions));
        this.controller.handle(messages.PlatformStateChangedEvent, this.handlePlatformStateChanged.bind(this));
        this.logger.info("Surface Export controller plugin initialized");
    }
    async onStart() {
        this.logger.info("Controller started - Surface Export plugin ready");
        this.logger.info(`Current storage: ${this.platformStorage.size} platforms`);
    }
    async onShutdown() {
        this.subscriptions.treeBroadcastLimiter.cancel();
        this.logger.info(`Shutting down - ${this.platformStorage.size} platforms in storage`);
    }
    onControlConnectionEvent(connection, event) {
        if (event === "close") {
            this.surfaceExportSubscriptions.delete(connection);
        }
    }
    async handlePlatformExport(event) {
        this.logger.info(`Received platform export: ${event.exportId} from instance ${event.instanceId} ` +
            `(${event.platformName})`);
        try {
            const serializedSize = Buffer.byteLength(JSON.stringify(event.exportData), "utf8");
            this.platformStorage.set(event.exportId, {
                exportId: event.exportId,
                platformName: event.platformName,
                instanceId: event.instanceId,
                exportData: event.exportData,
                exportMetrics: event.exportMetrics || null,
                timestamp: event.timestamp,
                size: serializedSize,
            });
            this.logger.info(`Stored platform export: ${event.exportId}`);
            const maxStorage = Number(this.controller.config.get(`${PLUGIN_NAME}.max_storage_size`));
            if (Number.isFinite(maxStorage) && this.platformStorage.size > maxStorage) {
                this.cleanupOldExports(maxStorage);
            }
            await this.persistStorage();
            this.subscriptions.queueTreeBroadcast("player");
        }
        catch (err) {
            this.logger.error(`Error handling platform export: ${(0, helpers_1.getErrorMessage)(err)}`);
        }
    }
    /**
     * Handle platform state change event from an instance.
     * Records wall-clock departure time and triggers a tree broadcast.
     */
    async handlePlatformStateChanged(event) {
        if (event.platformName) {
            this.platformDepartureTimes.set(event.platformName, Date.now());
        }
        this.subscriptions.queueTreeBroadcast(event.forceName || "player");
    }
    cleanupOldExports(maxStorage) {
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
        this.persistStorage().catch((err) => {
            this.logger.error(`Failed to persist after cleanup: ${(0, helpers_1.getErrorMessage)(err)}`);
        });
        this.subscriptions.queueTreeBroadcast("player");
    }
    listStoredExports() {
        return Array.from(this.platformStorage.values()).map(data => ({
            exportId: data.exportId,
            platformName: data.platformName,
            instanceId: data.instanceId,
            timestamp: data.timestamp,
            size: data.size ?? Buffer.byteLength(JSON.stringify(data.exportData || {}), "utf8"),
        }));
    }
    async handleListExportsRequest() {
        return this.listStoredExports();
    }
    async handleGetStoredExportRequest(request) {
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
            exportData: stored.exportData,
        };
    }
    createOperationRecord(operationType, options = {}) {
        const sourceInstanceId = Number.isInteger(Number(options.sourceInstanceId))
            ? Number(options.sourceInstanceId)
            : -1;
        const targetInstanceId = Number.isInteger(Number(options.targetInstanceId))
            ? Number(options.targetInstanceId)
            : -1;
        const operationId = String(options.operationId || `${operationType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        const sourceInstanceName = options.sourceInstanceName
            ?? (sourceInstanceId > 0 ? this.platformTree.resolveInstanceName(sourceInstanceId) : null);
        const targetInstanceName = options.targetInstanceName
            ?? (targetInstanceId > 0 ? this.platformTree.resolveInstanceName(targetInstanceId) : null);
        const operation = {
            transferId: operationId,
            operationType,
            exportId: options.exportId || null,
            artifactSizeBytes: options.artifactSizeBytes ?? null,
            platformName: options.platformName || "Unknown",
            platformIndex: Number.isInteger(Number(options.platformIndex)) ? Number(options.platformIndex) : 1,
            forceName: options.forceName || "player",
            sourceInstanceId,
            sourceInstanceName,
            targetInstanceId,
            targetInstanceName,
            status: options.status || "in_progress",
            startedAt: options.startedAt || Date.now(),
            completedAt: options.completedAt || null,
            failedAt: options.failedAt || null,
            error: options.error || null,
        };
        this.activeTransfers.set(operationId, operation);
        return operation;
    }
    async handleImportUploadedExportRequest(request) {
        const { targetInstanceId, exportData, forceName, platformName } = request;
        if (!exportData || typeof exportData !== "object" || Array.isArray(exportData)) {
            return { success: false, error: "exportData must be a non-null object" };
        }
        const resolved = this.platformTree.resolveTargetInstance(targetInstanceId);
        const resolvedInstance = resolved?.instance;
        if (!resolved || !resolvedInstance || resolvedInstance.isDeleted) {
            return { success: false, error: `Target instance not found: ${targetInstanceId}` };
        }
        const importData = { ...exportData };
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
        importData._operationId = operation.transferId;
        const payloadSizeBytes = Buffer.byteLength(JSON.stringify(importData), "utf8");
        operation.artifactSizeBytes = payloadSizeBytes;
        this.txLogger.logTransactionEvent(operation.transferId, "import_requested", `Upload import requested for ${operation.platformName}`, {
            targetInstanceId: resolved.id,
            payloadSizeBytes,
        });
        this.subscriptions.emitTransferUpdate(operation);
        const uploadExportId = `uploaded_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try {
            const response = await this.controller.sendTo({ instanceId: resolved.id }, new messages.ImportPlatformRequest({
                exportId: uploadExportId,
                exportData: importData,
                forceName: resolvedForceName,
            }));
            if (!response?.success) {
                const error = response?.error || "Import failed on target instance";
                operation.status = "failed";
                operation.error = error;
                operation.failedAt = Date.now();
                this.txLogger.logTransactionEvent(operation.transferId, "import_failed", `Import request failed: ${error}`, { error });
                this.subscriptions.emitTransferUpdate(operation);
                await this.txLogger.persistTransactionLog(operation.transferId);
                this.orchestrator.pruneOldTransfers();
                return {
                    success: false,
                    error,
                    targetInstanceId: resolved.id,
                };
            }
            operation.status = "awaiting_completion";
            operation.platformName = response.platformName || importData.platform_name || operation.platformName;
            this.txLogger.logTransactionEvent(operation.transferId, "import_queued", `Import accepted by instance ${resolved.id}; awaiting completion callback`, {
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
        }
        catch (err) {
            operation.status = "failed";
            operation.error = (0, helpers_1.getErrorMessage)(err);
            operation.failedAt = Date.now();
            this.txLogger.logTransactionEvent(operation.transferId, "import_failed", `Import request failed: ${(0, helpers_1.getErrorMessage)(err)}`, { error: (0, helpers_1.getErrorMessage)(err) });
            this.subscriptions.emitTransferUpdate(operation);
            await this.txLogger.persistTransactionLog(operation.transferId);
            this.orchestrator.pruneOldTransfers();
            this.logger.error(`Upload import failed: ${(0, helpers_1.getErrorMessage)(err)}`);
            return { success: false, error: (0, helpers_1.getErrorMessage)(err) };
        }
    }
    async handleExportPlatformForDownloadRequest(request) {
        const sourceInstanceId = Number(request.sourceInstanceId);
        const sourcePlatformIndex = Number(request.sourcePlatformIndex);
        const forceName = request.forceName || "player";
        if (!Number.isInteger(sourceInstanceId)) {
            return { success: false, error: `Invalid source instance: ${request.sourceInstanceId}` };
        }
        if (!Number.isInteger(sourcePlatformIndex) || sourcePlatformIndex < 1) {
            return { success: false, error: `Invalid platform index: ${request.sourcePlatformIndex}` };
        }
        const sourceInstance = this.controller.instances.get(sourceInstanceId);
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
        this.txLogger.logTransactionEvent(operation.transferId, "export_requested", `Export requested from instance ${sourceInstanceId}, platform index ${sourcePlatformIndex}`, {
            sourceInstanceId,
            sourcePlatformIndex,
        });
        this.subscriptions.emitTransferUpdate(operation);
        try {
            const exportRequestStartMs = Date.now();
            const exportResponse = await this.controller.sendTo({ instanceId: sourceInstanceId }, new messages.ExportPlatformRequest({
                platformIndex: sourcePlatformIndex,
                forceName,
                targetInstanceId: null,
            }));
            const exportRequestMs = Date.now() - exportRequestStartMs;
            if (!exportResponse?.success || !exportResponse.exportId) {
                const error = exportResponse?.error || "Export failed";
                operation.status = "failed";
                operation.error = error;
                operation.failedAt = Date.now();
                this.txLogger.logTransactionEvent(operation.transferId, "export_failed", `Export request failed: ${error}`, { error, exportRequestMs });
                this.subscriptions.emitTransferUpdate(operation);
                await this.txLogger.persistTransactionLog(operation.transferId);
                this.orchestrator.pruneOldTransfers();
                return { success: false, error };
            }
            const waitForStoreStartMs = Date.now();
            const stored = await this.orchestrator.waitForStoredExport(exportResponse.exportId, 60000);
            const waitForStoredMs = Date.now() - waitForStoreStartMs;
            operation.platformName = stored.platformName || operation.platformName;
            operation.sourceInstanceId = stored.instanceId;
            operation.sourceInstanceName = this.platformTree.resolveInstanceName(stored.instanceId);
            operation.exportMetrics = (0, helpers_1.normalizeExportMetrics)({
                ...(stored.exportMetrics || {}),
                requestExportAndLockMs: exportRequestMs,
                waitForControllerStoreMs: waitForStoredMs,
                controllerExportPrepTotalMs: exportRequestMs + waitForStoredMs,
            });
            operation.payloadMetrics = buildPayloadMetrics(stored.exportData || {});
            operation.artifactSizeBytes = stored.size ?? operation.artifactSizeBytes ?? null;
            operation.status = "completed";
            operation.completedAt = Date.now();
            const durationMs = operation.completedAt - operation.startedAt;
            this.txLogger.logTransactionEvent(operation.transferId, "export_completed", `Export ready for download: ${stored.exportId}`, {
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
        }
        catch (err) {
            operation.status = "failed";
            operation.error = (0, helpers_1.getErrorMessage)(err);
            operation.failedAt = Date.now();
            this.txLogger.logTransactionEvent(operation.transferId, "export_failed", `Export failed: ${(0, helpers_1.getErrorMessage)(err)}`, { error: (0, helpers_1.getErrorMessage)(err) });
            this.subscriptions.emitTransferUpdate(operation);
            await this.txLogger.persistTransactionLog(operation.transferId);
            this.orchestrator.pruneOldTransfers();
            return { success: false, error: (0, helpers_1.getErrorMessage)(err) };
        }
    }
    async handleImportOperationCompleteEvent(event) {
        const operationId = String(event.operationId || "").trim();
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
            this.txLogger.logTransactionEvent(operation.transferId, "import_recovered", "Recovered import operation record from completion callback", {});
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
        operation.importMetrics = (importMetrics || null);
        if (event.success) {
            operation.status = "completed";
            operation.completedAt = Date.now();
            const durationMs = operation.completedAt - operation.startedAt;
            this.txLogger.logTransactionEvent(operation.transferId, "import_completed", `Import completed on instance ${operation.targetInstanceId}`, {
                durationMs,
                importMetrics: operation.importMetrics,
            });
        }
        else {
            const error = event.error || "Import failed";
            operation.status = "failed";
            operation.error = error;
            operation.failedAt = Date.now();
            this.txLogger.logTransactionEvent(operation.transferId, "import_failed", `Import failed: ${error}`, {
                error,
                importMetrics: operation.importMetrics,
            });
        }
        this.subscriptions.emitTransferUpdate(operation);
        this.subscriptions.queueTreeBroadcast(operation.forceName || "player");
        await this.txLogger.persistTransactionLog(operation.transferId);
        this.orchestrator.pruneOldTransfers();
    }
    async handleGetPlatformTreeRequest(request) {
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
    async handleListTransactionLogsRequest(request) {
        return this.txLogger.getTransferSummaries(request?.limit || 50);
    }
    async handleGetTransactionLog(request) {
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
    async loadStorage() {
        try {
            const content = await promises_1.default.readFile(this.storagePath, "utf8");
            const entries = JSON.parse(content);
            if (Array.isArray(entries)) {
                for (const entry of entries) {
                    if (entry && entry.exportId) {
                        if (!entry.size && entry.exportData) {
                            entry.size = Buffer.byteLength(JSON.stringify(entry.exportData), "utf8");
                        }
                        this.platformStorage.set(entry.exportId, entry);
                    }
                }
            }
            this.logger.info(`Loaded ${this.platformStorage.size} stored platforms from disk`);
        }
        catch (err) {
            const code = err.code;
            if (code === "ENOENT") {
                this.logger.verbose("No existing Surface Export storage found; starting fresh");
                return;
            }
            this.logger.error(`Failed to load Surface Export storage: ${(0, helpers_1.getErrorMessage)(err)}`);
        }
    }
    async persistStorage() {
        try {
            const payload = JSON.stringify(Array.from(this.platformStorage.values()), null, 2);
            await promises_1.default.mkdir(path_1.default.dirname(this.storagePath), { recursive: true });
            await promises_1.default.writeFile(this.storagePath, payload, "utf8");
        }
        catch (err) {
            this.logger.error(`Failed to persist Surface Export storage: ${(0, helpers_1.getErrorMessage)(err)}`);
        }
    }
}
module.exports = ControllerPlugin;
module.exports.ControllerPlugin = ControllerPlugin;
//# sourceMappingURL=controller.js.map