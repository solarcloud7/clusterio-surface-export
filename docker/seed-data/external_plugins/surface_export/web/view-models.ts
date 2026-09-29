import type {
	JsonObject,
	HostNodeModel,
	InstanceNodeModel,
	TransferSummaryModel,
} from "../shared/dto";

export type { JsonObject, HostNodeModel, InstanceNodeModel };
export type { PlatformModel } from "../shared/dto";
export type { ExportMetrics, ImportMetrics, PayloadMetrics, PhaseSpan, ValidationResult } from "../shared/dto";

export type LogEvent = {
	[key: string]: unknown;
	timestampMs?: number;
	eventType?: string;
	message?: string;
};

export type { SpanKind, TimelineRow, TimelineAttribution } from "../shared/transfer-timeline";
import type { TimelineRow } from "../shared/transfer-timeline";

export type GanttRowInput = TimelineRow;

export interface GanttRow extends GanttRowInput {
	ganttStartPct: number;
	ganttWidthPct: number;
	ganttMarkerPct: number;
}

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
	detailRetained?: boolean;
};

export type LiveStatus = "live" | "reconnecting" | "offline" | "degraded";

export type QuarantineListing = {
	conflicts: import("../shared/lineage-resolution").ConflictEntry[];
	unavailable: Array<{ instanceId: number; reason: string }>;
	error: string | null;
};

export type SurfaceExportState = {
	quarantine: QuarantineListing | null;
	tree: PlatformTreeState | null;
	loadingTree: boolean;
	treeError: string | null;
	transferSummaries: TransferSummary[];
	logDetails: Record<string, LogDetail>;
	lastTreeRevision: number;
	lastTransferRevision: number;
	lastLogRevision: number;
	canViewLogs: boolean;
	liveStatus: LiveStatus;
	liveError: string | null;
};

export type SurfaceExportPlugin = {
	getState(): SurfaceExportState;
	onUpdate(callback: () => void): void;
	offUpdate(callback: () => void): void;
	getStoredExport(exportId: string): Promise<JsonObject>;
	exportPlatformForDownload(payload: JsonObject): Promise<JsonObject>;
	importUploadedExport(payload: import("../messages").ImportUploadedExportOptions): Promise<JsonObject>;
	startTransfer(payload: JsonObject): Promise<JsonObject>;
	loadTransactionLog(transferId: string): Promise<void>;
	refreshSnapshots?(): Promise<void>;
	getPortals?(): Promise<import("../shared/dto").PortalListingResponse>;
	listLineageConflicts?(): Promise<ReturnType<typeof import("../messages").ListLineageConflictsRequest.Response.fromJSON>>;
	refreshQuarantine?(): Promise<void>;
	watchQuarantine?(callback: () => void): () => void;
	resolvePlatformLineage?(payload: { instanceId: number; platformIndex: number; platformUid: string;
		action: import("../shared/lineage-resolution").ResolutionAction; requestId: string }): Promise<ReturnType<typeof import("../messages").ResolvePlatformLineageRequest.Response.fromJSON>>;
	abandonPlatformResolution?(requestId: string): Promise<ReturnType<typeof import("../messages").AbandonPlatformResolutionRequest.Response.fromJSON>>;
};
