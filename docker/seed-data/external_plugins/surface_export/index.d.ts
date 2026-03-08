/**
 * @file index.ts
 * @description Clusterio plugin for exporting and importing Factorio space platforms
 * @see https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md
 */
import * as messages from "./messages";
export declare const plugin: {
    name: string;
    title: string;
    description: string;
    instanceEntrypoint: string;
    controllerEntrypoint: string;
    webEntrypoint: string;
    routes: string[];
    instanceConfigFields: {
        "surface_export.max_export_cache_size": {
            description: string;
            type: string;
            initialValue: number;
        };
        "surface_export.batch_size": {
            description: string;
            type: string;
            initialValue: number;
            optional: boolean;
        };
        "surface_export.max_concurrent_jobs": {
            description: string;
            type: string;
            initialValue: number;
            optional: boolean;
        };
        "surface_export.show_progress": {
            description: string;
            type: string;
            initialValue: boolean;
            optional: boolean;
        };
        "surface_export.debug_mode": {
            description: string;
            type: string;
            initialValue: boolean;
            optional: boolean;
        };
    };
    controllerConfigFields: {
        "surface_export.max_storage_size": {
            description: string;
            type: string;
            initialValue: number;
        };
    };
    messages: (typeof messages.ExportPlatformRequest | typeof messages.GetStoredExportRequest | typeof messages.ImportUploadedExportRequest | typeof messages.ExportPlatformForDownloadRequest | typeof messages.GetPlatformTreeRequest | typeof messages.ListTransactionLogsRequest | typeof messages.SetSurfaceExportSubscriptionRequest | typeof messages.SurfaceExportTreeUpdateEvent | typeof messages.SurfaceExportTransferUpdateEvent | typeof messages.SurfaceExportLogUpdateEvent | typeof messages.PlatformExportEvent | typeof messages.ImportPlatformRequest | typeof messages.ListExportsRequest | typeof messages.TransferPlatformRequest | typeof messages.StartPlatformTransferRequest | typeof messages.InstanceListPlatformsRequest | typeof messages.ImportPlatformFromFileRequest | typeof messages.TransferValidationEvent | typeof messages.ImportOperationCompleteEvent | typeof messages.UnlockSourcePlatformRequest | typeof messages.TransferStatusUpdate | typeof messages.GetTransactionLogRequest | typeof messages.PlatformStateChangedEvent)[];
    ctlEntrypoint: string;
};
//# sourceMappingURL=index.d.ts.map