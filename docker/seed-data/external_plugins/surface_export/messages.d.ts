export declare const PERMISSIONS: {
    readonly LIST_EXPORTS: "surface_export.exports.list";
    readonly TRANSFER_EXPORTS: "surface_export.exports.transfer";
    readonly UI_VIEW: "surface_export.ui.view";
    readonly VIEW_LOGS: "surface_export.logs.view";
};
type JsonSchema = Record<string, unknown>;
export interface SimpleResponse {
    success: boolean;
    error?: string;
}
export declare class ExportPlatformRequest {
    ["constructor"]: typeof ExportPlatformRequest;
    static plugin: string;
    static type: "request";
    static src: readonly ["controller", "instance"];
    static dst: "instance";
    static jsonSchema: JsonSchema;
    platformIndex: number;
    forceName: string;
    targetInstanceId: number | null;
    constructor(json: {
        platformIndex: number;
        forceName?: string;
        targetInstanceId?: number | null;
    });
    static fromJSON(json: {
        platformIndex: number;
        forceName?: string;
        targetInstanceId?: number | null;
    }): ExportPlatformRequest;
    toJSON(): {
        platformIndex: number;
        forceName: string;
        targetInstanceId: number | null;
    };
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): SimpleResponse & {
            exportId?: string;
        };
    };
}
export declare class GetStoredExportRequest {
    ["constructor"]: typeof GetStoredExportRequest;
    static plugin: string;
    static type: "request";
    static src: "control";
    static dst: "controller";
    static permission: "surface_export.exports.list";
    static jsonSchema: JsonSchema;
    exportId: string;
    constructor(json: {
        exportId: string;
    });
    static fromJSON(json: {
        exportId: string;
    }): GetStoredExportRequest;
    toJSON(): {
        exportId: string;
    };
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): SimpleResponse & {
            exportId?: string;
            platformName?: string;
            instanceId?: number;
            timestamp?: number;
            size?: number;
            exportData?: Record<string, unknown>;
        };
    };
}
export declare class ImportUploadedExportRequest {
    ["constructor"]: typeof ImportUploadedExportRequest;
    static plugin: string;
    static type: "request";
    static src: "control";
    static dst: "controller";
    static permission: "surface_export.exports.transfer";
    static jsonSchema: JsonSchema;
    targetInstanceId: number;
    exportData: Record<string, unknown>;
    forceName: string;
    platformName: string | null;
    constructor(json: {
        targetInstanceId: number;
        exportData: Record<string, unknown>;
        forceName?: string;
        platformName?: string | null;
    });
    static fromJSON(json: {
        targetInstanceId: number;
        exportData: Record<string, unknown>;
        forceName?: string;
        platformName?: string | null;
    }): ImportUploadedExportRequest;
    toJSON(): {
        targetInstanceId: number;
        exportData: Record<string, unknown>;
        forceName: string;
        platformName: string | null;
    };
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): SimpleResponse & {
            platformName?: string;
            targetInstanceId?: number;
        };
    };
}
export declare class ExportPlatformForDownloadRequest {
    ["constructor"]: typeof ExportPlatformForDownloadRequest;
    static plugin: string;
    static type: "request";
    static src: "control";
    static dst: "controller";
    static permission: "surface_export.exports.transfer";
    static jsonSchema: JsonSchema;
    sourceInstanceId: number;
    sourcePlatformIndex: number;
    forceName: string;
    constructor(json: {
        sourceInstanceId: number;
        sourcePlatformIndex: number;
        forceName?: string;
    });
    static fromJSON(json: {
        sourceInstanceId: number;
        sourcePlatformIndex: number;
        forceName?: string;
    }): ExportPlatformForDownloadRequest;
    toJSON(): {
        sourceInstanceId: number;
        sourcePlatformIndex: number;
        forceName: string;
    };
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): SimpleResponse & {
            exportId?: string;
            platformName?: string;
            instanceId?: number;
            timestamp?: number;
            size?: number;
            exportData?: Record<string, unknown>;
        };
    };
}
export declare class GetPlatformTreeRequest {
    ["constructor"]: typeof GetPlatformTreeRequest;
    static plugin: string;
    static type: "request";
    static src: "control";
    static dst: "controller";
    static permission: "surface_export.ui.view";
    static jsonSchema: JsonSchema;
    forceName: string;
    constructor(json?: {
        forceName?: string;
    });
    static fromJSON(json: {
        forceName?: string;
    }): GetPlatformTreeRequest;
    toJSON(): {
        forceName: string;
    };
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): {
            revision: number;
            generatedAt: number;
            forceName: string;
            hosts: unknown[];
            unassignedInstances: unknown[];
        };
    };
}
export declare class ListTransactionLogsRequest {
    ["constructor"]: typeof ListTransactionLogsRequest;
    static plugin: string;
    static type: "request";
    static src: "control";
    static dst: "controller";
    static permission: "surface_export.logs.view";
    static jsonSchema: JsonSchema;
    limit: number;
    constructor(json?: {
        limit?: number;
    });
    static fromJSON(json: {
        limit?: number;
    }): ListTransactionLogsRequest;
    toJSON(): {
        limit: number;
    };
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): TransferSummary[];
    };
}
export declare class SetSurfaceExportSubscriptionRequest {
    ["constructor"]: typeof SetSurfaceExportSubscriptionRequest;
    static plugin: string;
    static type: "request";
    static src: "control";
    static dst: "controller";
    static permission: "surface_export.ui.view";
    static jsonSchema: JsonSchema;
    tree: boolean;
    transfers: boolean;
    logs: boolean;
    transferId: string | null;
    constructor(json?: {
        tree?: boolean;
        transfers?: boolean;
        logs?: boolean;
        transferId?: string | null;
    });
    static fromJSON(json: {
        tree?: boolean;
        transfers?: boolean;
        logs?: boolean;
        transferId?: string | null;
    }): SetSurfaceExportSubscriptionRequest;
    toJSON(): {
        tree: boolean;
        transfers: boolean;
        logs: boolean;
        transferId: string | null;
    };
}
export declare class SurfaceExportTreeUpdateEvent {
    ["constructor"]: typeof SurfaceExportTreeUpdateEvent;
    static plugin: string;
    static type: "event";
    static src: "controller";
    static dst: "control";
    static jsonSchema: JsonSchema;
    revision: number;
    generatedAt: number;
    forceName: string;
    tree: Record<string, unknown>;
    constructor(json: {
        revision: number;
        generatedAt: number;
        forceName: string;
        tree: Record<string, unknown>;
    });
    static fromJSON(json: {
        revision: number;
        generatedAt: number;
        forceName: string;
        tree: Record<string, unknown>;
    }): SurfaceExportTreeUpdateEvent;
    toJSON(): {
        revision: number;
        generatedAt: number;
        forceName: string;
        tree: Record<string, unknown>;
    };
}
export declare class SurfaceExportTransferUpdateEvent {
    ["constructor"]: typeof SurfaceExportTransferUpdateEvent;
    static plugin: string;
    static type: "event";
    static src: "controller";
    static dst: "control";
    static jsonSchema: JsonSchema;
    revision: number;
    generatedAt: number;
    transfer: TransferSummary;
    constructor(json: {
        revision: number;
        generatedAt: number;
        transfer: TransferSummary;
    });
    static fromJSON(json: {
        revision: number;
        generatedAt: number;
        transfer: TransferSummary;
    }): SurfaceExportTransferUpdateEvent;
    toJSON(): {
        revision: number;
        generatedAt: number;
        transfer: TransferSummary;
    };
}
export declare class SurfaceExportLogUpdateEvent {
    ["constructor"]: typeof SurfaceExportLogUpdateEvent;
    static plugin: string;
    static type: "event";
    static src: "controller";
    static dst: "control";
    static jsonSchema: JsonSchema;
    revision: number;
    generatedAt: number;
    transferId: string;
    event: TransactionLogEntry;
    transferInfo: Record<string, unknown> | null;
    summary: Record<string, unknown> | null;
    constructor(json: {
        revision: number;
        generatedAt: number;
        transferId: string;
        event: TransactionLogEntry;
        transferInfo: Record<string, unknown> | null;
        summary: Record<string, unknown> | null;
    });
    static fromJSON(json: {
        revision: number;
        generatedAt: number;
        transferId: string;
        event: TransactionLogEntry;
        transferInfo: Record<string, unknown> | null;
        summary: Record<string, unknown> | null;
    }): SurfaceExportLogUpdateEvent;
    toJSON(): {
        revision: number;
        generatedAt: number;
        transferId: string;
        event: TransactionLogEntry;
        transferInfo: Record<string, unknown> | null;
        summary: Record<string, unknown> | null;
    };
}
export declare class PlatformExportEvent {
    ["constructor"]: typeof PlatformExportEvent;
    static plugin: string;
    static type: "event";
    static src: "instance";
    static dst: "controller";
    static jsonSchema: JsonSchema;
    exportId: string;
    platformName: string;
    instanceId: number;
    exportData: Record<string, unknown>;
    timestamp: number;
    exportMetrics: ExportMetrics | null;
    constructor(json: {
        exportId: string;
        platformName: string;
        instanceId: number;
        exportData: Record<string, unknown>;
        timestamp: number;
        exportMetrics?: ExportMetrics | null;
    });
    static fromJSON(json: {
        exportId: string;
        platformName: string;
        instanceId: number;
        exportData: Record<string, unknown>;
        timestamp: number;
        exportMetrics?: ExportMetrics | null;
    }): PlatformExportEvent;
    toJSON(): {
        exportId: string;
        platformName: string;
        instanceId: number;
        exportData: Record<string, unknown>;
        timestamp: number;
        exportMetrics: ExportMetrics | null;
    };
}
export declare class ImportPlatformRequest {
    ["constructor"]: typeof ImportPlatformRequest;
    static plugin: string;
    static type: "request";
    static src: readonly ["controller", "instance"];
    static dst: "instance";
    static jsonSchema: JsonSchema;
    exportId: string;
    exportData: Record<string, unknown>;
    forceName: string;
    constructor(json: {
        exportId: string;
        exportData: Record<string, unknown>;
        forceName?: string;
    });
    static fromJSON(json: {
        exportId: string;
        exportData: Record<string, unknown>;
        forceName?: string;
    }): ImportPlatformRequest;
    toJSON(): {
        exportId: string;
        exportData: Record<string, unknown>;
        forceName: string;
    };
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): SimpleResponse & {
            platformName?: string;
        };
    };
}
export declare class ListExportsRequest {
    ["constructor"]: typeof ListExportsRequest;
    static plugin: string;
    static type: "request";
    static src: "control";
    static dst: "controller";
    static permission: "surface_export.exports.list";
    static jsonSchema: JsonSchema;
    constructor();
    static fromJSON(): ListExportsRequest;
    toJSON(): {};
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): StoredExportSummary[];
    };
}
export declare class TransferPlatformRequest {
    ["constructor"]: typeof TransferPlatformRequest;
    static plugin: string;
    static type: "request";
    static src: readonly ["control", "instance"];
    static dst: "controller";
    static permission: "surface_export.exports.transfer";
    static jsonSchema: JsonSchema;
    exportId: string;
    targetInstanceId: number;
    constructor(json: {
        exportId: string;
        targetInstanceId: number;
    });
    static fromJSON(json: {
        exportId: string;
        targetInstanceId: number;
    }): TransferPlatformRequest;
    toJSON(): {
        exportId: string;
        targetInstanceId: number;
    };
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): SimpleResponse & {
            transferId?: string;
            message?: string;
        };
    };
}
export declare class StartPlatformTransferRequest {
    ["constructor"]: typeof StartPlatformTransferRequest;
    static plugin: string;
    static type: "request";
    static src: "control";
    static dst: "controller";
    static permission: "surface_export.exports.transfer";
    static jsonSchema: JsonSchema;
    sourceInstanceId: number;
    sourcePlatformIndex: number;
    targetInstanceId: number;
    forceName: string;
    constructor(json: {
        sourceInstanceId: number;
        sourcePlatformIndex: number;
        targetInstanceId: number;
        forceName?: string;
    });
    static fromJSON(json: {
        sourceInstanceId: number;
        sourcePlatformIndex: number;
        targetInstanceId: number;
        forceName?: string;
    }): StartPlatformTransferRequest;
    toJSON(): {
        sourceInstanceId: number;
        sourcePlatformIndex: number;
        targetInstanceId: number;
        forceName: string;
    };
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): SimpleResponse & {
            transferId?: string;
            exportId?: string;
            message?: string;
        };
    };
}
export declare class InstanceListPlatformsRequest {
    ["constructor"]: typeof InstanceListPlatformsRequest;
    static plugin: string;
    static type: "request";
    static src: "controller";
    static dst: "instance";
    static jsonSchema: JsonSchema;
    forceName: string;
    constructor(json?: {
        forceName?: string;
    });
    static fromJSON(json: {
        forceName?: string;
    }): InstanceListPlatformsRequest;
    toJSON(): {
        forceName: string;
    };
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): {
            instanceId: number;
            instanceName: string;
            forceName: string;
            platforms: PlatformInfo[];
        };
    };
}
export declare class ImportPlatformFromFileRequest {
    ["constructor"]: typeof ImportPlatformFromFileRequest;
    static plugin: string;
    static type: "request";
    static src: readonly ["controller", "instance"];
    static dst: "instance";
    static jsonSchema: JsonSchema;
    filename: string;
    platformName: string | null;
    forceName: string;
    constructor(json: {
        filename: string;
        platformName?: string | null;
        forceName?: string;
    });
    static fromJSON(json: {
        filename: string;
        platformName?: string | null;
        forceName?: string;
    }): ImportPlatformFromFileRequest;
    toJSON(): {
        filename: string;
        platformName: string | null;
        forceName: string;
    };
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): SimpleResponse;
    };
}
export declare class TransferValidationEvent {
    ["constructor"]: typeof TransferValidationEvent;
    static plugin: string;
    static type: "event";
    static src: "instance";
    static dst: "controller";
    static jsonSchema: JsonSchema;
    transferId: string;
    platformName: string;
    sourceInstanceId: number;
    success: boolean;
    validation?: ValidationResult;
    metrics?: Record<string, number>;
    constructor(json: {
        transferId: string;
        platformName: string;
        sourceInstanceId: number;
        success: boolean;
        validation?: ValidationResult;
        metrics?: Record<string, number>;
    });
    static fromJSON(json: {
        transferId: string;
        platformName: string;
        sourceInstanceId: number;
        success: boolean;
        validation?: ValidationResult;
        metrics?: Record<string, number>;
    }): TransferValidationEvent;
    toJSON(): {
        transferId: string;
        platformName: string;
        sourceInstanceId: number;
        success: boolean;
        validation: ValidationResult | undefined;
        metrics: Record<string, number> | undefined;
    };
}
export declare class ImportOperationCompleteEvent {
    ["constructor"]: typeof ImportOperationCompleteEvent;
    static plugin: string;
    static type: "event";
    static src: "instance";
    static dst: "controller";
    static jsonSchema: JsonSchema;
    operationId: string;
    platformName: string;
    instanceId: number;
    success: boolean;
    error: string | null;
    durationTicks: number | null;
    entityCount: number | null;
    metrics: Record<string, number> | null;
    constructor(json: {
        operationId: string;
        platformName: string;
        instanceId: number;
        success: boolean;
        error?: string | null;
        durationTicks?: number | null;
        entityCount?: number | null;
        metrics?: Record<string, number> | null;
    });
    static fromJSON(json: {
        operationId: string;
        platformName: string;
        instanceId: number;
        success: boolean;
        error?: string | null;
        durationTicks?: number | null;
        entityCount?: number | null;
        metrics?: Record<string, number> | null;
    }): ImportOperationCompleteEvent;
    toJSON(): {
        operationId: string;
        platformName: string;
        instanceId: number;
        success: boolean;
        error: string | null;
        durationTicks: number | null;
        entityCount: number | null;
        metrics: Record<string, number> | null;
    };
}
export declare class DeleteSourcePlatformRequest {
    ["constructor"]: typeof DeleteSourcePlatformRequest;
    static plugin: string;
    static type: "request";
    static src: "controller";
    static dst: "instance";
    static jsonSchema: JsonSchema;
    platformIndex: number;
    platformName: string;
    forceName: string;
    constructor(json: {
        platformIndex: number;
        platformName: string;
        forceName?: string;
    });
    static fromJSON(json: {
        platformIndex: number;
        platformName: string;
        forceName?: string;
    }): DeleteSourcePlatformRequest;
    toJSON(): {
        platformIndex: number;
        platformName: string;
        forceName: string;
    };
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): SimpleResponse;
    };
}
export declare class UnlockSourcePlatformRequest {
    ["constructor"]: typeof UnlockSourcePlatformRequest;
    static plugin: string;
    static type: "request";
    static src: "controller";
    static dst: "instance";
    static jsonSchema: JsonSchema;
    platformName: string;
    forceName: string;
    constructor(json: {
        platformName: string;
        forceName?: string;
    });
    static fromJSON(json: {
        platformName: string;
        forceName?: string;
    }): UnlockSourcePlatformRequest;
    toJSON(): {
        platformName: string;
        forceName: string;
    };
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): SimpleResponse;
    };
}
export declare class TransferStatusUpdate {
    ["constructor"]: typeof TransferStatusUpdate;
    static plugin: string;
    static type: "request";
    static src: "controller";
    static dst: "instance";
    static jsonSchema: JsonSchema;
    transferId: string;
    platformName: string;
    message: string;
    color: string | null;
    constructor(json: {
        transferId: string;
        platformName: string;
        message: string;
        color?: string | null;
    });
    static fromJSON(json: {
        transferId: string;
        platformName: string;
        message: string;
        color?: string | null;
    }): TransferStatusUpdate;
    toJSON(): {
        transferId: string;
        platformName: string;
        message: string;
        color: string | null;
    };
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): SimpleResponse;
    };
}
export declare class GetTransactionLogRequest {
    ["constructor"]: typeof GetTransactionLogRequest;
    static plugin: string;
    static type: "request";
    static src: readonly ["controller", "instance", "control"];
    static dst: "controller";
    static permission: "surface_export.logs.view";
    static jsonSchema: JsonSchema;
    transferId: string;
    constructor(json: {
        transferId: string;
    });
    static fromJSON(json: {
        transferId: string;
    }): GetTransactionLogRequest;
    toJSON(): {
        transferId: string;
    };
    static Response: {
        jsonSchema: JsonSchema;
        fromJSON(json: unknown): SimpleResponse & {
            transferId?: string;
            events?: TransactionLogEntry[];
            transferInfo?: Record<string, unknown> | null;
            summary?: Record<string, unknown> | null;
        };
    };
}
export declare class PlatformStateChangedEvent {
    ["constructor"]: typeof PlatformStateChangedEvent;
    static plugin: string;
    static type: "event";
    static src: "instance";
    static dst: "controller";
    static jsonSchema: JsonSchema;
    instanceId: number;
    platformName: string;
    forceName: string;
    constructor(json: {
        instanceId: number;
        platformName: string;
        forceName: string;
    });
    static fromJSON(json: {
        instanceId: number;
        platformName: string;
        forceName: string;
    }): PlatformStateChangedEvent;
    toJSON(): {
        instanceId: number;
        platformName: string;
        forceName: string;
    };
}
export interface ExportMetrics {
    requestExportAndLockMs?: number;
    waitForControllerStoreMs?: number;
    controllerExportPrepTotalMs?: number;
    instanceAsyncExportTicks?: number;
    instanceAsyncExportMs?: number;
    instanceAsyncExportSeconds?: number;
    exportedEntityCount?: number;
    exportedTileCount?: number;
    atomicBeltEntitiesScanned?: number;
    atomicBeltItemStacksCaptured?: number;
    uncompressedPayloadBytes?: number;
    compressedPayloadBytes?: number;
    compressionReductionPct?: number;
    scheduleRecordCount?: number;
    scheduleInterruptCount?: number;
}
export interface ImportMetrics {
    total_ticks: number;
    tiles_ms: number;
    entities_ms: number;
    fluids_ms: number;
    belts_ms: number;
    state_ms: number;
    validation_ms: number;
    total_ms: number;
    tiles_placed: number;
    entities_created: number;
    entities_failed: number;
    fluids_restored: number;
    belt_items_restored: number;
    circuits_connected: number;
    total_items: number;
    total_fluids: number;
    [key: string]: number;
}
export interface PayloadMetrics {
    isCompressed: boolean;
    compressionType: string;
    payloadSizeKB: number | null;
    entityCount: number;
    tileCount: number;
    uniqueItemTypes: number;
    totalItemCount: number;
    uniqueFluidTypes: number;
    totalFluidVolume: number;
}
export interface ValidationResult {
    itemCountMatch: boolean;
    fluidCountMatch: boolean;
    entityCount?: number;
    mismatchDetails?: string;
    expectedItemCounts?: Record<string, number>;
    actualItemCounts?: Record<string, number>;
    expectedFluidCounts?: Record<string, number>;
    actualFluidCounts?: Record<string, number>;
    failedEntityLosses?: {
        items: Record<string, number>;
        fluids: Record<string, number>;
    };
    highTempAggregates?: Record<string, {
        expectedEnergy: number;
        actualEnergy: number;
        reconciled: boolean;
    }>;
}
export type OperationType = "transfer" | "export" | "import";
export type TransferStatus = "transporting" | "in_progress" | "awaiting_validation" | "awaiting_completion" | "completed" | "failed" | "cleanup_failed" | "error" | "unknown";
export interface PhaseRecord {
    startMs: number;
    endMs?: number;
    durationMs?: number;
}
export interface ActiveTransfer {
    transferId: string;
    operationType: OperationType;
    exportId: string | null;
    artifactSizeBytes: number | null;
    platformName: string;
    platformIndex: number;
    forceName: string;
    sourceInstanceId: number;
    sourceInstanceName: string | null;
    targetInstanceId: number;
    targetInstanceName: string | null;
    startedAt: number;
    status: TransferStatus;
    completedAt?: number | null;
    failedAt?: number | null;
    error?: string | null;
    payloadMetrics?: PayloadMetrics;
    exportMetrics?: ExportMetrics | null;
    importMetrics?: ImportMetrics | null;
    validationResult?: ValidationResult | null;
    sourceVerification?: {
        itemCounts: Record<string, number>;
        fluidCounts: Record<string, number>;
    };
    validationTimeout?: ReturnType<typeof setTimeout> | null;
    phases?: Record<string, PhaseRecord>;
}
export interface TransferSummary {
    transferId: string;
    operationType: OperationType;
    exportId: string | null;
    artifactSizeBytes: number | null;
    downloadable: boolean;
    platformName: string;
    sourceInstanceId: number;
    sourceInstanceName: string | null;
    targetInstanceId: number;
    targetInstanceName: string | null;
    status: string;
    startedAt: number;
    completedAt: number | null;
    failedAt: number | null;
    error: string | null;
    lastEventAt: number | null;
}
export interface StoredExport {
    exportId: string;
    platformName: string;
    instanceId: number;
    exportData: Record<string, unknown>;
    exportMetrics: ExportMetrics | null;
    timestamp: number;
    size: number;
}
export interface StoredExportSummary {
    exportId: string;
    platformName: string;
    instanceId: number;
    timestamp: number;
    size: number;
}
export interface TransactionLogEntry {
    timestamp: string;
    timestampMs: number;
    elapsedMs: number;
    deltaMs: number;
    eventType: string;
    message: string;
    [key: string]: unknown;
}
export interface PersistedTransactionLog {
    transferId: string;
    transferInfo: Partial<ActiveTransfer> & {
        status: string;
    };
    summary: Record<string, unknown>;
    events: TransactionLogEntry[];
    savedAt: number;
}
export interface PlatformInfo {
    platformIndex: number;
    platformName: string;
    forceName: string;
    surfaceIndex: number | null;
    surfaceName: string | null;
    entityCount: number;
    isLocked: boolean;
    hasSpaceHub: boolean;
    spaceLocation?: string | null;
    currentTarget?: string | null;
    speed?: number;
    state?: string | null;
    departureTick?: number | null;
    estimatedDurationTicks?: number | null;
    departureDateMs?: number | null;
    transferId?: string | null;
    transferStatus?: string;
}
export interface PlatformInstanceNode {
    instanceId: number;
    instanceName: string;
    hostId: number | null;
    status: string;
    connected: boolean;
    platforms: PlatformInfo[];
    platformError: string | null;
}
export interface PlatformHostNode {
    hostId: number;
    hostName: string;
    connected: boolean;
    instances: PlatformInstanceNode[];
}
export interface SubscriptionState {
    tree: boolean;
    transfers: boolean;
    logs: boolean;
    transferId: string | null;
}
export {};
//# sourceMappingURL=messages.d.ts.map