/**
 * @file index.ts
 * @description Clusterio plugin for exporting and importing Factorio space platforms
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = void 0;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require("@clusterio/lib");
const messages = __importStar(require("./messages"));
const { PERMISSIONS } = messages;
const PLUGIN_NAME = "surface_export";
lib.definePermission({
    name: PERMISSIONS.LIST_EXPORTS,
    title: "List Surface Exports",
    description: "Allows listing stored Surface Export platform snapshots on the controller.",
});
lib.definePermission({
    name: PERMISSIONS.TRANSFER_EXPORTS,
    title: "Transfer Surface Exports",
    description: "Allows pushing a stored Surface Export snapshot onto a target instance.",
});
lib.definePermission({
    name: PERMISSIONS.UI_VIEW,
    title: "View Surface Export UI",
    description: "Allows viewing Surface Export web UI pages and platform tree data.",
});
lib.definePermission({
    name: PERMISSIONS.VIEW_LOGS,
    title: "View Surface Export Transaction Logs",
    description: "Allows viewing transaction log summaries and details for Surface Export transfers.",
});
exports.plugin = {
    name: PLUGIN_NAME,
    title: "Surface Export",
    description: "Export and import Factorio space platforms between Clusterio instances",
    instanceEntrypoint: "instance",
    controllerEntrypoint: "controller",
    webEntrypoint: "./web",
    routes: ["/surface-export"],
    instanceConfigFields: {
        [`${PLUGIN_NAME}.max_export_cache_size`]: {
            description: "Maximum number of platform exports to cache per instance",
            type: "number",
            initialValue: 10,
        },
        [`${PLUGIN_NAME}.batch_size`]: {
            description: "Number of entities to process per tick during async operations",
            type: "number",
            initialValue: 50,
            optional: true,
        },
        [`${PLUGIN_NAME}.max_concurrent_jobs`]: {
            description: "Maximum number of concurrent async import/export jobs",
            type: "number",
            initialValue: 3,
            optional: true,
        },
        [`${PLUGIN_NAME}.show_progress`]: {
            description: "Show progress notifications for async operations",
            type: "boolean",
            initialValue: true,
            optional: true,
        },
        [`${PLUGIN_NAME}.debug_mode`]: {
            description: "Enable debug mode - exports JSON comparison files for transfer validation",
            type: "boolean",
            initialValue: true,
            optional: true,
        },
    },
    controllerConfigFields: {
        [`${PLUGIN_NAME}.max_storage_size`]: {
            description: "Maximum number of platform exports to store on controller",
            type: "number",
            initialValue: 20,
        },
    },
    messages: [
        messages.ExportPlatformRequest,
        messages.PlatformExportEvent,
        messages.ImportPlatformRequest,
        messages.ImportPlatformFromFileRequest,
        messages.ListExportsRequest,
        messages.GetStoredExportRequest,
        messages.ImportUploadedExportRequest,
        messages.ExportPlatformForDownloadRequest,
        messages.TransferPlatformRequest,
        messages.StartPlatformTransferRequest,
        messages.InstanceListPlatformsRequest,
        messages.TransferValidationEvent,
        messages.ImportOperationCompleteEvent,
        messages.DeleteSourcePlatformRequest,
        messages.UnlockSourcePlatformRequest,
        messages.TransferStatusUpdate,
        messages.GetPlatformTreeRequest,
        messages.ListTransactionLogsRequest,
        messages.GetTransactionLogRequest,
        messages.SetSurfaceExportSubscriptionRequest,
        messages.SurfaceExportTreeUpdateEvent,
        messages.SurfaceExportTransferUpdateEvent,
        messages.SurfaceExportLogUpdateEvent,
        messages.PlatformStateChangedEvent,
    ],
    ctlEntrypoint: "control",
};
//# sourceMappingURL=index.js.map