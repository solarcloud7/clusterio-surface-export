export type PlatformSummary = {
	platformIndex: number;
	platformName: string;
	forceName?: string;
	surfaceIndex?: number | null;
	surfaceName?: string | null;
	entityCount?: number;
	isLocked?: boolean;
	hasSpaceHub?: boolean;
	spaceLocation?: string | null;
	currentTarget?: string | null;
	speed?: number;
	state?: string | null;
	departureTick?: number | null;
	estimatedDurationTicks?: number | null;
	departureDateMs?: number | null;
	transferId?: string | null;
	transferStatus?: string;
};

export type JsonObject = Record<string, unknown>;

export type LogEvent = {
	[key: string]: unknown;
	timestampMs?: number;
	eventType?: string;
	message?: string;
};

export type InstanceNode = {
	instanceId: number;
	instanceName: string;
	hostId?: number | null;
	status?: string;
	connected?: boolean;
	platforms: PlatformSummary[];
	platformError?: string | null;
};

export type HostNode = {
	hostId: number;
	hostName: string;
	connected: boolean;
	instances: InstanceNode[];
};

export type PlatformTreeState = {
	forceName: string;
	hosts: HostNode[];
	unassignedInstances: InstanceNode[];
	revision: number;
	generatedAt: number;
};

export type StoredExportSummary = {
	exportId: string;
	platformName: string;
	instanceId: number;
	timestamp: number;
	size: number;
};

export type TransferSummary = {
	transferId: string;
	operationType?: string;
	exportId?: string | null;
	artifactSizeBytes?: number | null;
	downloadable?: boolean;
	platformName?: string;
	sourceInstanceId?: number;
	sourceInstanceName?: string | null;
	targetInstanceId?: number;
	targetInstanceName?: string | null;
	status?: string;
	startedAt?: number;
	completedAt?: number | null;
	failedAt?: number | null;
	error?: string | null;
	lastEventAt?: number | null;
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
	exports: StoredExportSummary[];
	loadingExports: boolean;
	exportsError: string | null;
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
	listExports(): Promise<StoredExportSummary[]>;
	getStoredExport(exportId: string): Promise<JsonObject>;
	exportPlatformForDownload(payload: JsonObject): Promise<JsonObject>;
	importUploadedExport(payload: JsonObject): Promise<JsonObject>;
	startTransfer(payload: JsonObject): Promise<JsonObject>;
	loadTransactionLog(transferId: string): Promise<void>;
};
