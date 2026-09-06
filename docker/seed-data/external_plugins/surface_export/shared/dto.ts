export type JsonObject = Record<string, unknown>;

export const GATEWAY_PREFIX = "surfexp_gateway_";

export type GatewayMode = "one_gate" | "multi";
export const DEFAULT_GATEWAY_MODE: GatewayMode = "one_gate";

export const MULTI_GATEWAY_NAMES: string[] = Array.from(
	{ length: 4 },
	(_unused, i) => `${GATEWAY_PREFIX}${i + 1}`,
);

export const ONE_GATE_NAME = `${GATEWAY_PREFIX}hub`;
export const ONE_GATE_NAMES: string[] = [ONE_GATE_NAME];

export const ALL_GATEWAY_NAMES: string[] = [...MULTI_GATEWAY_NAMES, ...ONE_GATE_NAMES];

export function gatewayNamesFor(mode: GatewayMode): string[] {
	return mode === "multi" ? [...MULTI_GATEWAY_NAMES] : [...ONE_GATE_NAMES];
}

export function parseGatewayMode(value: unknown): { mode: GatewayMode; warning: string | null } {
	if (value === "one_gate" || value === "multi") {
		return { mode: value, warning: null };
	}
	return {
		mode: DEFAULT_GATEWAY_MODE,
		warning: `Unknown gateway_mode ${JSON.stringify(value)} — falling back to ${DEFAULT_GATEWAY_MODE}`,
	};
}

export function checkMultiModeLink(
	gatewayName: string,
	targets: readonly GatewayLink[],
	otherGateways: ReadonlyMap<string, readonly GatewayLink[]>,
): string | null {
	if (targets.length > 1) {
		return `In Multi Cluster mode each gateway carries one destination (${gatewayName} was given ${targets.length}).`;
	}
	const target = targets[0];
	if (!target) {
		return null;
	}
	for (const [otherName, otherTargets] of otherGateways) {
		if (otherName === gatewayName) {
			continue;
		}
		if (otherTargets.some(other => other.targetInstanceId === target.targetInstanceId)) {
			return `In Multi Cluster mode each destination gets one gateway (${otherName} already links to instance ${target.targetInstanceId}).`;
		}
	}
	return null;
}

export interface GatewayLink {
	targetInstanceId: number;
	targetGateway: string;
}

export interface ResolvedGatewayTarget {
	instanceId: number;
	instanceName: string;
	targetGateway: string;
	online: boolean;
}

export interface ResolvedGateway {
	gatewayName: string;
	targets: ResolvedGatewayTarget[];
}

export interface TransferSummaryModel {
	observedDurationMs?: number | null;
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
	registrySource?: "active" | "persisted";
}
export interface StoredExportSummaryModel {
	exportId: string;
	sourceExportId: string | null;
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
	gamePort: number | null;
	address: string;
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


export type AuditRowKind = "start" | "terminal";

export interface AuditRow {
	observedDurationMs?: number | null;
	v: number;
	transferId: string;
	rowKind: AuditRowKind;
	savedAt: number;
	operationType: string;
	platformName: string;
	platformIndex: number | null;
	sourceInstanceId: number;
	sourceInstanceName: string | null;
	targetInstanceId: number;
	targetInstanceName: string | null;
	exportId: string | null;
	artifactSizeBytes: number | null;
	status: string;
	startedAt: number | null;
	completedAt: number | null;
	failedAt: number | null;
	lastEventAt: number | null;
	eventCount: number;
	error: string | null;
	errorTruncated?: boolean;
}


export interface PhaseSpan {
	name: string;
	parent?: string;
	startOffsetMs: number;
	durationMs: number;
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
	total_ticks?: number;
	tiles_ms?: number;
	entities_ms?: number;
	fluids_ms?: number;
	belts_ms?: number;
	state_ms?: number;
	validation_ms?: number;
	total_ms?: number;
	tiles_placed: number;
	entities_created: number;
	entities_failed: number;
	entities_skipped?: number;
	entities_mapped?: number;
	fluids_restored: number;
	belt_items_restored: number;
	belt_state_applied?: number;
	belt_state_unmatched?: number;
	belt_state_failed?: number;
	belt_state_merge_discarded?: number;
	belt_state_declined?: number;
	inventory_state_applied?: number;
	inventory_state_declined?: number;
	inventory_state_failed?: number;
	circuits_connected: number;
	copper_pruned?: number;
	proxies_linked?: number;
	total_items: number;
	total_fluids: number;
	phaseSpans?: PhaseSpan[];
	phaseTicks?: Array<{ name: string; start_tick: number; end_tick: number; ticks_elapsed: number }>;
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
	success?: boolean;
	message?: string;
	failedStage?: 'items' | 'fluids' | 'belts' | 'test_hook' | null;
	testForcedFailure?: boolean;
	testForcedEntityFailure?: boolean;
	itemLossByType?: Record<string, { expected: number; actual: number; loss: number }>;
	totalItemLoss?: number;
	entityCount?: number;
	reportedEntityCount?: number;
	mismatchDetails?: string;
	expectedItemCounts?: Record<string, number>;
	actualItemCounts?: Record<string, number>;
	expectedFluidCounts?: Record<string, number>;
	actualFluidCounts?: Record<string, number>;
	entityTypeBreakdown?: Record<string, number>;
	failedEntityLosses?: {
		entity_count: number;
		total_items: number;
		total_fluids: number;
		items: Record<string, number>;
		fluids: Record<string, number>;
		entities: Array<{ name: string; type: string; position?: { x: number; y: number }; items: number; fluids: number }>;
	};
	highTempAggregates?: Record<string, { expectedEnergy: number; actualEnergy: number; reconciled: boolean }>;
	totalExpectedItems?: number;
	totalActualItems?: number;
	totalExpectedFluids?: number;
	totalActualFluids?: number;
	itemTypesExpected?: number;
	itemTypesActual?: number;
	fluidTypesExpected?: number;
	fluidTypesActual?: number;
	fluidReconciliation?: {
		highTempThreshold: number;
		rawFluidDelta: number;
		reconciledLoss: number;
		lowTempLoss: number;
		highTempReconciledLoss: number;
		fluidPreservedPct: number;
		highTempAggregates?: Record<string, { expected: number; actual: number; delta: number; reconciled: boolean; expectedEnergy: number; actualEnergy: number }>;
	};
	droppedFluids?: Record<string, number>;
	writeRejectedFluids?: Record<string, number>;
	postActivationReport?: {
		totalActualItems: number;
		actualItemCounts: Record<string, number>;
		totalActualFluids: number;
		actualFluidCounts: Record<string, number>;
		fluidReconciliation?: Record<string, unknown>;
	};
	failureBlackBox?: { file: string; tick: number };
	gatewayParked?: boolean;
	latchRearmScheduled?: number;
	cleanup_failed?: boolean;
	cleanup_error?: string;
	destinationPreserved?: boolean;
	inventoryOverflowLosses?: {
		total: number;
		items: Record<string, number>;
		entities: Array<{
			name?: string;
			position?: { x?: number; y?: number };
			item?: string;
			quality?: string;
			expected?: number;
			actual?: number;
			lost?: number;
		}>;
	};
	forceDataMismatches?: Array<{
		force?: string;
		property?: string;
		source?: number;
		destination?: number;
		synced_to?: number;
	}>;
}
