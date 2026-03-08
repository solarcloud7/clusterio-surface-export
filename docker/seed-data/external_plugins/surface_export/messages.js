"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlatformStateChangedEvent = exports.GetTransactionLogRequest = exports.TransferStatusUpdate = exports.UnlockSourcePlatformRequest = exports.DeleteSourcePlatformRequest = exports.ImportOperationCompleteEvent = exports.TransferValidationEvent = exports.ImportPlatformFromFileRequest = exports.InstanceListPlatformsRequest = exports.StartPlatformTransferRequest = exports.TransferPlatformRequest = exports.ListExportsRequest = exports.ImportPlatformRequest = exports.PlatformExportEvent = exports.SurfaceExportLogUpdateEvent = exports.SurfaceExportTransferUpdateEvent = exports.SurfaceExportTreeUpdateEvent = exports.SetSurfaceExportSubscriptionRequest = exports.ListTransactionLogsRequest = exports.GetPlatformTreeRequest = exports.ExportPlatformForDownloadRequest = exports.ImportUploadedExportRequest = exports.GetStoredExportRequest = exports.ExportPlatformRequest = exports.PERMISSIONS = void 0;
const PLUGIN_NAME = "surface_export";
exports.PERMISSIONS = {
    LIST_EXPORTS: `${PLUGIN_NAME}.exports.list`,
    TRANSFER_EXPORTS: `${PLUGIN_NAME}.exports.transfer`,
    UI_VIEW: `${PLUGIN_NAME}.ui.view`,
    VIEW_LOGS: `${PLUGIN_NAME}.logs.view`,
};
// ── Request / Event classes ─────────────────────────────────────────────────
class ExportPlatformRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = ["controller", "instance"];
    static dst = "instance";
    static jsonSchema = {
        type: "object",
        properties: {
            platformIndex: { type: "integer" },
            forceName: { type: "string", default: "player" },
            targetInstanceId: { type: ["integer", "null"], default: null },
        },
        required: ["platformIndex"],
        additionalProperties: false,
    };
    platformIndex;
    forceName;
    targetInstanceId;
    constructor(json) {
        this.platformIndex = json.platformIndex;
        this.forceName = json.forceName || "player";
        this.targetInstanceId = json.targetInstanceId ?? null;
    }
    static fromJSON(json) {
        return new ExportPlatformRequest(json);
    }
    toJSON() {
        return { platformIndex: this.platformIndex, forceName: this.forceName, targetInstanceId: this.targetInstanceId };
    }
    static Response = {
        jsonSchema: {
            type: "object",
            properties: {
                success: { type: "boolean" },
                exportId: { type: "string" },
                error: { type: "string" },
            },
            required: ["success"],
        },
        fromJSON(json) { return json; },
    };
}
exports.ExportPlatformRequest = ExportPlatformRequest;
class GetStoredExportRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "control";
    static dst = "controller";
    static permission = exports.PERMISSIONS.LIST_EXPORTS;
    static jsonSchema = {
        type: "object",
        properties: { exportId: { type: "string" } },
        required: ["exportId"],
        additionalProperties: false,
    };
    exportId;
    constructor(json) {
        this.exportId = json.exportId;
    }
    static fromJSON(json) { return new GetStoredExportRequest(json); }
    toJSON() { return { exportId: this.exportId }; }
    static Response = {
        jsonSchema: {
            type: "object",
            properties: {
                success: { type: "boolean" },
                error: { type: "string" },
                exportId: { type: "string" },
                platformName: { type: "string" },
                instanceId: { type: "integer" },
                timestamp: { type: "number" },
                size: { type: "integer" },
                exportData: { type: "object" },
            },
            required: ["success"],
        },
        fromJSON(json) {
            return json;
        },
    };
}
exports.GetStoredExportRequest = GetStoredExportRequest;
class ImportUploadedExportRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "control";
    static dst = "controller";
    static permission = exports.PERMISSIONS.TRANSFER_EXPORTS;
    static jsonSchema = {
        type: "object",
        properties: {
            targetInstanceId: { type: "integer" },
            exportData: { type: "object" },
            forceName: { type: "string", default: "player" },
            platformName: { type: ["string", "null"], default: null },
        },
        required: ["targetInstanceId", "exportData"],
        additionalProperties: false,
    };
    targetInstanceId;
    exportData;
    forceName;
    platformName;
    constructor(json) {
        this.targetInstanceId = json.targetInstanceId;
        this.exportData = json.exportData;
        this.forceName = json.forceName || "player";
        this.platformName = json.platformName ?? null;
    }
    static fromJSON(json) {
        return new ImportUploadedExportRequest(json);
    }
    toJSON() {
        return { targetInstanceId: this.targetInstanceId, exportData: this.exportData, forceName: this.forceName, platformName: this.platformName };
    }
    static Response = {
        jsonSchema: {
            type: "object",
            properties: {
                success: { type: "boolean" },
                error: { type: "string" },
                platformName: { type: "string" },
                targetInstanceId: { type: "integer" },
            },
            required: ["success"],
        },
        fromJSON(json) { return json; },
    };
}
exports.ImportUploadedExportRequest = ImportUploadedExportRequest;
class ExportPlatformForDownloadRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "control";
    static dst = "controller";
    static permission = exports.PERMISSIONS.TRANSFER_EXPORTS;
    static jsonSchema = {
        type: "object",
        properties: {
            sourceInstanceId: { type: "integer" },
            sourcePlatformIndex: { type: "integer" },
            forceName: { type: "string", default: "player" },
        },
        required: ["sourceInstanceId", "sourcePlatformIndex"],
        additionalProperties: false,
    };
    sourceInstanceId;
    sourcePlatformIndex;
    forceName;
    constructor(json) {
        this.sourceInstanceId = json.sourceInstanceId;
        this.sourcePlatformIndex = json.sourcePlatformIndex;
        this.forceName = json.forceName || "player";
    }
    static fromJSON(json) {
        return new ExportPlatformForDownloadRequest(json);
    }
    toJSON() {
        return { sourceInstanceId: this.sourceInstanceId, sourcePlatformIndex: this.sourcePlatformIndex, forceName: this.forceName };
    }
    static Response = {
        jsonSchema: {
            type: "object",
            properties: {
                success: { type: "boolean" },
                error: { type: "string" },
                exportId: { type: "string" },
                platformName: { type: "string" },
                instanceId: { type: "integer" },
                timestamp: { type: "number" },
                size: { type: "integer" },
                exportData: { type: "object" },
            },
            required: ["success"],
        },
        fromJSON(json) {
            return json;
        },
    };
}
exports.ExportPlatformForDownloadRequest = ExportPlatformForDownloadRequest;
class GetPlatformTreeRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "control";
    static dst = "controller";
    static permission = exports.PERMISSIONS.UI_VIEW;
    static jsonSchema = {
        type: "object",
        properties: { forceName: { type: "string", default: "player" } },
        additionalProperties: false,
    };
    forceName;
    constructor(json = {}) {
        this.forceName = json.forceName || "player";
    }
    static fromJSON(json) { return new GetPlatformTreeRequest(json); }
    toJSON() { return { forceName: this.forceName }; }
    static Response = {
        jsonSchema: {
            type: "object",
            properties: {
                revision: { type: "integer" },
                generatedAt: { type: "number" },
                forceName: { type: "string" },
                hosts: { type: "array", items: { type: "object" } },
                unassignedInstances: { type: "array", items: { type: "object" } },
            },
            required: ["revision", "generatedAt", "forceName", "hosts", "unassignedInstances"],
        },
        fromJSON(json) {
            return json;
        },
    };
}
exports.GetPlatformTreeRequest = GetPlatformTreeRequest;
class ListTransactionLogsRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "control";
    static dst = "controller";
    static permission = exports.PERMISSIONS.VIEW_LOGS;
    static jsonSchema = {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 500, default: 50 } },
        additionalProperties: false,
    };
    limit;
    constructor(json = {}) {
        this.limit = json.limit || 50;
    }
    static fromJSON(json) { return new ListTransactionLogsRequest(json); }
    toJSON() { return { limit: this.limit }; }
    static Response = {
        jsonSchema: { type: "array", items: { type: "object" } },
        fromJSON(json) { return json; },
    };
}
exports.ListTransactionLogsRequest = ListTransactionLogsRequest;
class SetSurfaceExportSubscriptionRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "control";
    static dst = "controller";
    static permission = exports.PERMISSIONS.UI_VIEW;
    static jsonSchema = {
        type: "object",
        properties: {
            tree: { type: "boolean", default: false },
            transfers: { type: "boolean", default: false },
            logs: { type: "boolean", default: false },
            transferId: { type: ["string", "null"], default: null },
        },
        additionalProperties: false,
    };
    tree;
    transfers;
    logs;
    transferId;
    constructor(json = {}) {
        this.tree = json.tree || false;
        this.transfers = json.transfers || false;
        this.logs = json.logs || false;
        this.transferId = json.transferId || null;
    }
    static fromJSON(json) {
        return new SetSurfaceExportSubscriptionRequest(json);
    }
    toJSON() {
        return { tree: this.tree, transfers: this.transfers, logs: this.logs, transferId: this.transferId };
    }
}
exports.SetSurfaceExportSubscriptionRequest = SetSurfaceExportSubscriptionRequest;
class SurfaceExportTreeUpdateEvent {
    static plugin = PLUGIN_NAME;
    static type = "event";
    static src = "controller";
    static dst = "control";
    static jsonSchema = {
        type: "object",
        properties: {
            revision: { type: "integer" },
            generatedAt: { type: "number" },
            forceName: { type: "string" },
            tree: { type: "object" },
        },
        required: ["revision", "generatedAt", "forceName", "tree"],
        additionalProperties: false,
    };
    revision;
    generatedAt;
    forceName;
    tree;
    constructor(json) {
        this.revision = json.revision;
        this.generatedAt = json.generatedAt;
        this.forceName = json.forceName;
        this.tree = json.tree;
    }
    static fromJSON(json) {
        return new SurfaceExportTreeUpdateEvent(json);
    }
    toJSON() {
        return { revision: this.revision, generatedAt: this.generatedAt, forceName: this.forceName, tree: this.tree };
    }
}
exports.SurfaceExportTreeUpdateEvent = SurfaceExportTreeUpdateEvent;
class SurfaceExportTransferUpdateEvent {
    static plugin = PLUGIN_NAME;
    static type = "event";
    static src = "controller";
    static dst = "control";
    static jsonSchema = {
        type: "object",
        properties: {
            revision: { type: "integer" },
            generatedAt: { type: "number" },
            transfer: { type: "object" },
        },
        required: ["revision", "generatedAt", "transfer"],
        additionalProperties: false,
    };
    revision;
    generatedAt;
    transfer;
    constructor(json) {
        this.revision = json.revision;
        this.generatedAt = json.generatedAt;
        this.transfer = json.transfer;
    }
    static fromJSON(json) {
        return new SurfaceExportTransferUpdateEvent(json);
    }
    toJSON() {
        return { revision: this.revision, generatedAt: this.generatedAt, transfer: this.transfer };
    }
}
exports.SurfaceExportTransferUpdateEvent = SurfaceExportTransferUpdateEvent;
class SurfaceExportLogUpdateEvent {
    static plugin = PLUGIN_NAME;
    static type = "event";
    static src = "controller";
    static dst = "control";
    static jsonSchema = {
        type: "object",
        properties: {
            revision: { type: "integer" },
            generatedAt: { type: "number" },
            transferId: { type: "string" },
            event: { type: "object" },
            transferInfo: { type: ["object", "null"] },
            summary: { type: ["object", "null"] },
        },
        required: ["revision", "generatedAt", "transferId", "event", "transferInfo", "summary"],
        additionalProperties: false,
    };
    revision;
    generatedAt;
    transferId;
    event;
    transferInfo;
    summary;
    constructor(json) {
        this.revision = json.revision;
        this.generatedAt = json.generatedAt;
        this.transferId = json.transferId;
        this.event = json.event;
        this.transferInfo = json.transferInfo;
        this.summary = json.summary;
    }
    static fromJSON(json) {
        return new SurfaceExportLogUpdateEvent(json);
    }
    toJSON() {
        return {
            revision: this.revision, generatedAt: this.generatedAt, transferId: this.transferId,
            event: this.event, transferInfo: this.transferInfo, summary: this.summary,
        };
    }
}
exports.SurfaceExportLogUpdateEvent = SurfaceExportLogUpdateEvent;
class PlatformExportEvent {
    static plugin = PLUGIN_NAME;
    static type = "event";
    static src = "instance";
    static dst = "controller";
    static jsonSchema = {
        type: "object",
        properties: {
            exportId: { type: "string" },
            platformName: { type: "string" },
            instanceId: { type: "integer" },
            exportData: { type: "object" },
            timestamp: { type: "number" },
            exportMetrics: { type: ["object", "null"] },
        },
        required: ["exportId", "platformName", "instanceId", "exportData", "timestamp"],
        additionalProperties: false,
    };
    exportId;
    platformName;
    instanceId;
    exportData;
    timestamp;
    exportMetrics;
    constructor(json) {
        this.exportId = json.exportId;
        this.platformName = json.platformName;
        this.instanceId = json.instanceId;
        this.exportData = json.exportData;
        this.timestamp = json.timestamp;
        this.exportMetrics = json.exportMetrics || null;
    }
    static fromJSON(json) {
        return new PlatformExportEvent(json);
    }
    toJSON() {
        return {
            exportId: this.exportId, platformName: this.platformName, instanceId: this.instanceId,
            exportData: this.exportData, timestamp: this.timestamp, exportMetrics: this.exportMetrics,
        };
    }
}
exports.PlatformExportEvent = PlatformExportEvent;
class ImportPlatformRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = ["controller", "instance"];
    static dst = "instance";
    static jsonSchema = {
        type: "object",
        properties: {
            exportId: { type: "string" },
            exportData: { type: "object" },
            forceName: { type: "string", default: "player" },
        },
        required: ["exportId", "exportData"],
        additionalProperties: false,
    };
    exportId;
    exportData;
    forceName;
    constructor(json) {
        this.exportId = json.exportId;
        this.exportData = json.exportData;
        this.forceName = json.forceName || "player";
    }
    static fromJSON(json) {
        return new ImportPlatformRequest(json);
    }
    toJSON() { return { exportId: this.exportId, exportData: this.exportData, forceName: this.forceName }; }
    static Response = {
        jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } }, required: ["success"] },
        fromJSON(json) { return json; },
    };
}
exports.ImportPlatformRequest = ImportPlatformRequest;
class ListExportsRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "control";
    static dst = "controller";
    static permission = exports.PERMISSIONS.LIST_EXPORTS;
    static jsonSchema = { type: "object", properties: {}, additionalProperties: false };
    constructor() { }
    static fromJSON() { return new ListExportsRequest(); }
    toJSON() { return {}; }
    static Response = {
        jsonSchema: { type: "array", items: { type: "object" } },
        fromJSON(json) { return json; },
    };
}
exports.ListExportsRequest = ListExportsRequest;
class TransferPlatformRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = ["control", "instance"];
    static dst = "controller";
    static permission = exports.PERMISSIONS.TRANSFER_EXPORTS;
    static jsonSchema = {
        type: "object",
        properties: {
            exportId: { type: "string" },
            targetInstanceId: { type: "integer" },
        },
        required: ["exportId", "targetInstanceId"],
        additionalProperties: false,
    };
    exportId;
    targetInstanceId;
    constructor(json) {
        this.exportId = json.exportId;
        this.targetInstanceId = json.targetInstanceId;
    }
    static fromJSON(json) { return new TransferPlatformRequest(json); }
    toJSON() { return { exportId: this.exportId, targetInstanceId: this.targetInstanceId }; }
    static Response = {
        jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" }, transferId: { type: "string" }, message: { type: "string" } }, required: ["success"] },
        fromJSON(json) { return json; },
    };
}
exports.TransferPlatformRequest = TransferPlatformRequest;
class StartPlatformTransferRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "control";
    static dst = "controller";
    static permission = exports.PERMISSIONS.TRANSFER_EXPORTS;
    static jsonSchema = {
        type: "object",
        properties: {
            sourceInstanceId: { type: "integer" },
            sourcePlatformIndex: { type: "integer" },
            targetInstanceId: { type: "integer" },
            forceName: { type: "string", default: "player" },
        },
        required: ["sourceInstanceId", "sourcePlatformIndex", "targetInstanceId"],
        additionalProperties: false,
    };
    sourceInstanceId;
    sourcePlatformIndex;
    targetInstanceId;
    forceName;
    constructor(json) {
        this.sourceInstanceId = json.sourceInstanceId;
        this.sourcePlatformIndex = json.sourcePlatformIndex;
        this.targetInstanceId = json.targetInstanceId;
        this.forceName = json.forceName || "player";
    }
    static fromJSON(json) {
        return new StartPlatformTransferRequest(json);
    }
    toJSON() {
        return { sourceInstanceId: this.sourceInstanceId, sourcePlatformIndex: this.sourcePlatformIndex, targetInstanceId: this.targetInstanceId, forceName: this.forceName };
    }
    static Response = {
        jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" }, transferId: { type: "string" }, exportId: { type: "string" }, message: { type: "string" } }, required: ["success"] },
        fromJSON(json) { return json; },
    };
}
exports.StartPlatformTransferRequest = StartPlatformTransferRequest;
class InstanceListPlatformsRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "controller";
    static dst = "instance";
    static jsonSchema = {
        type: "object",
        properties: { forceName: { type: "string", default: "player" } },
        additionalProperties: false,
    };
    forceName;
    constructor(json = {}) {
        this.forceName = json.forceName || "player";
    }
    static fromJSON(json) { return new InstanceListPlatformsRequest(json); }
    toJSON() { return { forceName: this.forceName }; }
    static Response = {
        jsonSchema: { type: "object", properties: { instanceId: { type: "integer" }, instanceName: { type: "string" }, forceName: { type: "string" }, platforms: { type: "array" } }, required: ["instanceId", "instanceName", "forceName", "platforms"] },
        fromJSON(json) { return json; },
    };
}
exports.InstanceListPlatformsRequest = InstanceListPlatformsRequest;
class ImportPlatformFromFileRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = ["controller", "instance"];
    static dst = "instance";
    static jsonSchema = {
        type: "object",
        properties: {
            filename: { type: "string" },
            platformName: { type: ["string", "null"], default: null },
            forceName: { type: "string", default: "player" },
        },
        required: ["filename"],
        additionalProperties: false,
    };
    filename;
    platformName;
    forceName;
    constructor(json) {
        this.filename = json.filename;
        this.platformName = json.platformName ?? null;
        this.forceName = json.forceName || "player";
    }
    static fromJSON(json) {
        return new ImportPlatformFromFileRequest(json);
    }
    toJSON() { return { filename: this.filename, platformName: this.platformName, forceName: this.forceName }; }
    static Response = {
        jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } }, required: ["success"] },
        fromJSON(json) { return json; },
    };
}
exports.ImportPlatformFromFileRequest = ImportPlatformFromFileRequest;
class TransferValidationEvent {
    static plugin = PLUGIN_NAME;
    static type = "event";
    static src = "instance";
    static dst = "controller";
    static jsonSchema = {
        type: "object",
        properties: {
            transferId: { type: "string" },
            platformName: { type: "string" },
            sourceInstanceId: { type: "integer" },
            success: { type: "boolean" },
            validation: { type: "object" },
            metrics: { type: "object" },
        },
        required: ["transferId", "platformName", "sourceInstanceId", "success"],
        additionalProperties: false,
    };
    transferId;
    platformName;
    sourceInstanceId;
    success;
    validation;
    metrics;
    constructor(json) {
        this.transferId = json.transferId;
        this.platformName = json.platformName;
        this.sourceInstanceId = json.sourceInstanceId;
        this.success = json.success;
        this.validation = json.validation;
        this.metrics = json.metrics;
    }
    static fromJSON(json) {
        return new TransferValidationEvent(json);
    }
    toJSON() {
        return { transferId: this.transferId, platformName: this.platformName, sourceInstanceId: this.sourceInstanceId, success: this.success, validation: this.validation, metrics: this.metrics };
    }
}
exports.TransferValidationEvent = TransferValidationEvent;
class ImportOperationCompleteEvent {
    static plugin = PLUGIN_NAME;
    static type = "event";
    static src = "instance";
    static dst = "controller";
    static jsonSchema = {
        type: "object",
        properties: {
            operationId: { type: "string" },
            platformName: { type: "string" },
            instanceId: { type: "integer" },
            success: { type: "boolean" },
            error: { type: ["string", "null"] },
            durationTicks: { type: ["integer", "null"] },
            entityCount: { type: ["integer", "null"] },
            metrics: { type: ["object", "null"] },
        },
        required: ["operationId", "platformName", "instanceId", "success"],
        additionalProperties: false,
    };
    operationId;
    platformName;
    instanceId;
    success;
    error;
    durationTicks;
    entityCount;
    metrics;
    constructor(json) {
        this.operationId = json.operationId;
        this.platformName = json.platformName;
        this.instanceId = json.instanceId;
        this.success = json.success;
        this.error = json.error ?? null;
        this.durationTicks = json.durationTicks ?? null;
        this.entityCount = json.entityCount ?? null;
        this.metrics = json.metrics ?? null;
    }
    static fromJSON(json) {
        return new ImportOperationCompleteEvent(json);
    }
    toJSON() {
        return { operationId: this.operationId, platformName: this.platformName, instanceId: this.instanceId, success: this.success, error: this.error, durationTicks: this.durationTicks, entityCount: this.entityCount, metrics: this.metrics };
    }
}
exports.ImportOperationCompleteEvent = ImportOperationCompleteEvent;
class DeleteSourcePlatformRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "controller";
    static dst = "instance";
    static jsonSchema = {
        type: "object",
        properties: {
            platformIndex: { type: "integer" },
            platformName: { type: "string" },
            forceName: { type: "string", default: "player" },
        },
        required: ["platformIndex", "platformName"],
        additionalProperties: false,
    };
    platformIndex;
    platformName;
    forceName;
    constructor(json) {
        this.platformIndex = json.platformIndex;
        this.platformName = json.platformName;
        this.forceName = json.forceName || "player";
    }
    static fromJSON(json) { return new DeleteSourcePlatformRequest(json); }
    toJSON() { return { platformIndex: this.platformIndex, platformName: this.platformName, forceName: this.forceName }; }
    static Response = {
        jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } }, required: ["success"] },
        fromJSON(json) { return json; },
    };
}
exports.DeleteSourcePlatformRequest = DeleteSourcePlatformRequest;
class UnlockSourcePlatformRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "controller";
    static dst = "instance";
    static jsonSchema = {
        type: "object",
        properties: {
            platformName: { type: "string" },
            forceName: { type: "string", default: "player" },
        },
        required: ["platformName"],
        additionalProperties: false,
    };
    platformName;
    forceName;
    constructor(json) {
        this.platformName = json.platformName;
        this.forceName = json.forceName || "player";
    }
    static fromJSON(json) { return new UnlockSourcePlatformRequest(json); }
    toJSON() { return { platformName: this.platformName, forceName: this.forceName }; }
    static Response = {
        jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } }, required: ["success"] },
        fromJSON(json) { return json; },
    };
}
exports.UnlockSourcePlatformRequest = UnlockSourcePlatformRequest;
class TransferStatusUpdate {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "controller";
    static dst = "instance";
    static jsonSchema = {
        type: "object",
        properties: {
            transferId: { type: "string" },
            platformName: { type: "string" },
            message: { type: "string" },
            color: { type: ["string", "null"] },
        },
        required: ["transferId", "platformName", "message"],
        additionalProperties: false,
    };
    transferId;
    platformName;
    message;
    color;
    constructor(json) {
        this.transferId = json.transferId;
        this.platformName = json.platformName;
        this.message = json.message;
        this.color = json.color || null;
    }
    static fromJSON(json) {
        return new TransferStatusUpdate(json);
    }
    toJSON() { return { transferId: this.transferId, platformName: this.platformName, message: this.message, color: this.color }; }
    static Response = {
        jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } }, required: ["success"] },
        fromJSON(json) { return json; },
    };
}
exports.TransferStatusUpdate = TransferStatusUpdate;
class GetTransactionLogRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = ["controller", "instance", "control"];
    static dst = "controller";
    static permission = exports.PERMISSIONS.VIEW_LOGS;
    static jsonSchema = {
        type: "object",
        properties: { transferId: { type: "string" } },
        required: ["transferId"],
        additionalProperties: false,
    };
    transferId;
    constructor(json) {
        this.transferId = json.transferId;
    }
    static fromJSON(json) { return new GetTransactionLogRequest(json); }
    toJSON() { return { transferId: this.transferId }; }
    static Response = {
        jsonSchema: { type: "object", properties: { success: { type: "boolean" }, transferId: { type: "string" }, events: { type: "array" }, transferInfo: { type: ["object", "null"] }, summary: { type: ["object", "null"] }, error: { type: "string" } }, required: ["success"] },
        fromJSON(json) {
            return json;
        },
    };
}
exports.GetTransactionLogRequest = GetTransactionLogRequest;
class PlatformStateChangedEvent {
    static plugin = PLUGIN_NAME;
    static type = "event";
    static src = "instance";
    static dst = "controller";
    static jsonSchema = {
        type: "object",
        properties: {
            instanceId: { type: "integer" },
            platformName: { type: "string" },
            forceName: { type: "string" },
        },
        required: ["instanceId", "platformName", "forceName"],
        additionalProperties: false,
    };
    instanceId;
    platformName;
    forceName;
    constructor(json) {
        this.instanceId = json.instanceId;
        this.platformName = json.platformName;
        this.forceName = json.forceName;
    }
    static fromJSON(json) {
        return new PlatformStateChangedEvent(json);
    }
    toJSON() { return { instanceId: this.instanceId, platformName: this.platformName, forceName: this.forceName }; }
}
exports.PlatformStateChangedEvent = PlatformStateChangedEvent;
//# sourceMappingURL=messages.js.map