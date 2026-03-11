export type JsonObject = Record<string, unknown>;
export interface TransferSummaryModel {
	transferId: string;
	operationType: "transfer" | "export" | "import";
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
export interface StoredExportSummaryModel {
	exportId: string;
	platformName: string;
	instanceId: number;
	timestamp: number;
	size: number;
}
export interface TransactionLogEntryModel {
	timestamp: string;
	timestampMs: number;
	elapsedMs: number;
	deltaMs: number;
	eventType: string;
	message: string;
	[key: string]: unknown;
}
export interface PlatformModel {
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
export interface InstanceNodeModel {
	instanceId: number;
	instanceName: string;
	hostId: number | null;
	status: string;
	connected: boolean;
	platforms: PlatformModel[];
	platformError: string | null;
}
export interface HostNodeModel {
	hostId: number;
	hostName: string;
	connected: boolean;
	instances: InstanceNodeModel[];
}
