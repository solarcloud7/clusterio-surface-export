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
	/**
	 * Which registry this summary came out of — stamped only by `getTransferSummaries`, which merges
	 * two stores that are NOT equivalent:
	 *
	 *   "active"     the controller's in-memory `activeTransfers`. This is the ONLY store the retry
	 *                guard consults (transfer-orchestrator.ts:89-118), so a settled entry here WILL
	 *                refuse a same-ID retry. Cleared by a controller restart. Pruned above 100
	 *                entries, so its absence proves nothing.
	 *   "persisted"  the on-disk transaction log, reloaded at every controller boot. The retry guard
	 *                never reads it, so an ID appearing only here is history, not a blocker — and a
	 *                controller restart will NOT make it go away.
	 *
	 * Optional because an un-redeployed controller omits it: treat `undefined` as "provenance
	 * unknown", never as either value. Absent from `buildTransferSummary`, so it does not ride on
	 * SurfaceExportTransferUpdateEvent where every entry is active by construction.
	 */
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
	/** MEASURED placement failures (the batch tally), not total-minus-something. */
	entities_failed: number;
	/**
	 * Entities the create loop did not attempt. TWO causes share this counter, and only one is benign:
	 * space-platform-hub (pre-created with the platform, inventories restored in platform_hub_mapping),
	 * and a NIL HOLE in entities_to_create, which means the payload lost an element. The hole case is
	 * logged loudly in entity_creation.lua — do not read a non-zero value here as "by design" without
	 * checking the log. Optional: absent on logs written before these were split out of entities_failed.
	 */
	entities_skipped?: number;
	/** Entities indexed in entity_map, i.e. addressable for later state/inventory restoration. NOT a success count — ground items are placed without being mapped. */
	entities_mapped?: number;
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
	failedStage?: 'items' | 'fluids' | 'test_hook' | null;
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
	// Frozen-gate totals. Post-activation telemetry lives under postActivationReport.
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
	/**
	 * How many self-feedback deciders were SCHEDULED for post-activation latch re-arm
	 * (import-completion.lua:733). Non-gating: set after the verdict, never an input to it.
	 *
	 * This is the count queued, NOT the result. The re-arm pass runs over later ticks and finalises
	 * into `storage.latch_rearm_results` (latch_rearm.lua:228) without emitting anything, so the
	 * per-decider rearmed/cleared/failed outcome never reaches the controller — by the time it
	 * exists, this transfer's log has already been persisted and marked terminal.
	 */
	latchRearmScheduled?: number;
	cleanup_failed?: boolean;
	cleanup_error?: string;
	/**
	 * Items the engine's `set_stack` API refused to place because the destination stack was already
	 * at its cap. Attached only when `total > 0` (import-completion.lua:605). These are SUBTRACTED
	 * from expected counts before the gate (`import-completion.lua:429-442`), so they are not a gate
	 * failure — the UI surfaces them as an info alert so an excluded item is never silent.
	 * `entities` records where each loss happened; `items` is keyed by item name.
	 */
	inventoryOverflowLosses?: {
		total: number;
		items: Record<string, number>;
		entities: Array<{
			name?: string;
			position?: { x?: number; y?: number };
			item?: string;
			expected?: number;
			actual?: number;
			lost?: number;
		}>;
	};
	/**
	 * Non-fatal notice: the destination force was under-researched relative to the source, so its
	 * inserter-capacity bonuses were RAISED on import to preserve held items
	 * (import-pipeline.lua:468-471). Raise-only — lowering would eject items from OTHER platforms'
	 * inserters on the same force. Attached only when at least one property was raised
	 * (import-completion.lua:612). Does NOT affect the verdict.
	 *
	 * `synced_to` is snake_case because it is a Lua-native key that survives the wire unchanged.
	 */
	forceDataMismatches?: Array<{
		force?: string;
		property?: string;
		source?: number;
		destination?: number;
		synced_to?: number;
	}>;
	// NO index signature. `[key: string]: unknown` used to live here, and it is how
	// `latchRearmScheduled` rode untyped and unrendered: a producer could attach any field and
	// nothing — not the compiler, not a reviewer reading this interface — would notice it existed.
	// The two fields above were in exactly that state, live in production data and rendered by the
	// UI while invisible here. If Lua starts sending something new, declare it.
}
