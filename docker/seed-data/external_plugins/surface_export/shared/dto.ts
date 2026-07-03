export type JsonObject = Record<string, unknown>;

// ── Gateway link config (WS2) ───────────────────────────────────────────────
// Gateways are surfaceless `space-location`s added by the surfexp_gateways data mod. The controller is
// Node and CANNOT read Factorio prototypes, so the gateway-name list is pinned here, DERIVED from the
// prefix + count (mirror surfexp_gateways/data.lua's GATEWAY_COUNT and module/core/gateway.lua's
// Gateway.PREFIX — keep GATEWAY_COUNT below in sync with data.lua).
export const GATEWAY_PREFIX = "surfexp_gateway_";
export const GATEWAY_COUNT = 4;
export const GATEWAY_NAMES: string[] = Array.from(
	{ length: GATEWAY_COUNT },
	(_unused, i) => `${GATEWAY_PREFIX}${i + 1}`,
);

/** A raw gateway→destination link (controller source of truth; persisted). */
export interface GatewayLink {
	targetInstanceId: number;
	/** The gateway to park at on the destination (defaults to the source gateway name). */
	targetGateway: string;
}

/** A link resolved with live instance display info — built at push time, never persisted. */
export interface ResolvedGatewayTarget {
	instanceId: number;
	instanceName: string;
	targetGateway: string;
	online: boolean;
}

/** A gateway plus its resolved destination targets (the push/pull wire + Lua storage shape). */
export interface ResolvedGateway {
	gatewayName: string;
	targets: ResolvedGatewayTarget[];
}

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

// ── Transaction payload types (shared by the node controller/instance and the web UI) ───────────
// These describe the export/import/validation payloads carried on the wire and rendered in the
// transaction-log UI. They live here (not in messages.ts) so the browser bundle can import them
// without pulling in node-only code — see web/view-models.ts.

/**
 * One phase of a transfer/import pipeline as a trace span. Offsets are SEGMENT-relative
 * (measured from the Lua import job's t0 = job.started_tick); the web stitches them onto the
 * global transfer timeline using the controller "import_started" anchor. Powers the waterfall
 * Transfer-Flow chart. Lua emits these in snake_case (start_offset_ms/duration_ms);
 * helpers.buildImportMetrics maps them to this camelCase shape.
 */
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
	/** Waterfall trace: per-phase start offsets + durations (segment-relative). Optional — absent on legacy logs. */
	phaseSpans?: PhaseSpan[];
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
	// Informational (display-only): the SOURCE payload's entity total. `entityCount` above is the live
	// destination count (from validate_import). These legitimately differ (failed-to-place / serialization-
	// filtered / belt-overflow surplus), so neither is a loss signal — the item/fluid gate is authoritative.
	reportedEntityCount?: number;
	mismatchDetails?: string;
	expectedItemCounts?: Record<string, number>;
	actualItemCounts?: Record<string, number>;
	expectedFluidCounts?: Record<string, number>;
	actualFluidCounts?: Record<string, number>;
	entityTypeBreakdown?: Record<string, number>;
	failedEntityLosses?: { items: Record<string, number>; fluids: Record<string, number> };
	highTempAggregates?: Record<string, { expectedEnergy: number; actualEnergy: number; reconciled: boolean }>;
	// Post-LossAnalysis fields
	postActivation?: boolean;
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
		reconciledFluidLoss: number;
		lowTempLoss: number;
		highTempReconciledLoss: number;
		fluidPreservedPct: number;
		highTempAggregates?: Record<string, { expected: number; actual: number; delta: number; reconciled: boolean; expectedEnergy: number; actualEnergy: number }>;
	};
	[key: string]: unknown;
}
