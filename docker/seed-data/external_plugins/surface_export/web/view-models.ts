import type {
	JsonObject,
	HostNodeModel,
	InstanceNodeModel,
	TransferSummaryModel,
} from "../shared/dto";

export type { JsonObject, HostNodeModel, InstanceNodeModel };
export type { PlatformModel } from "../shared/dto";
// Transaction payload types — let the UI read export/import/validation payloads with field types
// instead of stringly-typed getProp() access.
export type { ExportMetrics, ImportMetrics, PayloadMetrics, ValidationResult } from "../shared/dto";

export type LogEvent = {
	[key: string]: unknown;
	timestampMs?: number;
	eventType?: string;
	message?: string;
};

export type PlatformTreeState = {
	forceName: string;
	hosts: HostNodeModel[];
	unassignedInstances: InstanceNodeModel[];
	revision: number;
	generatedAt: number;
};

export type TransferSummary = Partial<TransferSummaryModel> & {
	transferId: string;
};

export type LogDetail = {
	transferInfo?: JsonObject | null;
	summary?: JsonObject | null;
	events: Array<LogEvent>;
};

export type SurfaceExportState = {
	tree: PlatformTreeState | null;
	loadingTree: boolean;
	treeError: string | null;
	transferSummaries: TransferSummary[];
	logDetails: Record<string, LogDetail>;
	lastTreeRevision: number;
	lastTransferRevision: number;
	lastLogRevision: number;
	canViewLogs: boolean;
	pluginVersion: string | null;
};

export type SurfaceExportPlugin = {
	getState(): SurfaceExportState;
	onUpdate(callback: () => void): void;
	offUpdate(callback: () => void): void;
	getStoredExport(exportId: string): Promise<JsonObject>;
	exportPlatformForDownload(payload: JsonObject): Promise<JsonObject>;
	importUploadedExport(payload: JsonObject): Promise<JsonObject>;
	startTransfer(payload: JsonObject): Promise<JsonObject>;
	loadTransactionLog(transferId: string): Promise<void>;
};
