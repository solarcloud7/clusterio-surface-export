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
	 *                guard consults (transfer-orchestrator.ts:89-118). Cleared by a controller
	 *                restart. Pruned above 100 entries, so its absence proves nothing.
	 *
	 *                "active" means the guard can SEE the record — NOT that it will refuse it. The
	 *                guard makes a THREE-way decision on `status` (:104-118): a LIVE status
	 *                (transporting / awaiting_validation / awaiting_completion / in_progress) dedupes
	 *                to idempotent success, "failed" is explicitly REPLACED because its rollback
	 *                discarded the destination, and only everything else refuses. A caller deciding
	 *                whether a retry is blocked must read `status` too — reading `registrySource`
	 *                alone reports a false blocker on the failed record every gallery-suite run
	 *                manufactures (caught in review).
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
	/**
	 * The game port the instance is actually listening on, or null when unassigned (the instance
	 * has never started, so no port has been allocated). Distinguishes otherwise same-looking
	 * instances in the UI.
	 *
	 * NOT read from the `factorio.game_port` CONFIG: on this cluster the base image auto-derives
	 * ports at start, leaving that config value null while the instance really is serving on 34100.
	 * The assigned port lives on the controller's runtime InstanceRecord.
	 */
	gamePort: number | null;
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

// ── Transfer audit ledger row ───────────────────────────────────────────────
// Lives HERE, not beside its implementation in lib/audit-ledger.ts, because messages.ts references
// it and messages.ts is compiled into the BROWSER bundle (tsconfig.browser.json includes messages.ts
// and shared/** but deliberately not lib/**, which is node-only and reaches for fs). Putting the
// type in lib would drag the whole node-only subtree into the web build.

/** `start` when a transfer begins, `terminal` when it reaches a verdict. */
export type AuditRowKind = "start" | "terminal";

/**
 * One row of the append-only transfer audit ledger. Scalars only — deliberately no item/fluid count
 * maps, which are what make a detail entry ~9.3 KB and would make keeping every transfer forever
 * unaffordable. See lib/audit-ledger.ts for the read/write rules.
 */
export interface AuditRow {
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
	/** The Lua verdict's own success flag (transfer-validation.lua:336 / import-completion.lua's
	 * forced-failure hooks). The wire event's top-level `success` mirrors it; declared here because
	 * the object physically carries it. */
	success?: boolean;
	/** Set by the test-hook path only (import-completion.lua:555). */
	message?: string;
	/** 'belts' is set when the belt side-census refuses (import-completion.lua:577,811) — it was
	 * emitted for months while this union omitted it: declared-but-wrong is worse than undeclared
	 * (a reader narrowing on the union silently drops the belts case). Enumerated at the emitter. */
	failedStage?: 'items' | 'fluids' | 'belts' | 'test_hook' | null;
	/** The one-shot test hooks' self-identification (import-completion.lua:556,565). */
	testForcedFailure?: boolean;
	testForcedEntityFailure?: boolean;
	/** Per-item-name loss detail + the total (transfer-validation.lua:322-331). The gallery
	 * manifest asserts on totalItemLoss as a live contract — these were the two fields the first
	 * "enumerated at the emitter" pass MISSED (review finding on PR #157), and the first
	 * declaration of THIS one had the wrong value type (Record<string, number> for what the
	 * emitter builds as {expected, actual, loss} records — the delta pass caught the fix layer
	 * repeating the exact incident the inventoryOverflowLosses comment below memorializes). */
	itemLossByType?: Record<string, { expected: number; actual: number; loss: number }>;
	totalItemLoss?: number;
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
	/** Losses from entities that failed to PLACE (entity_creation.lua:57,209-215): quality-keyed
	 * item/fluid tallies plus totals, and a detail SAMPLE capped at 50 entries (`entities` is
	 * diagnostic, never a complete list — the totals are the accounting). The manifest asserts on
	 * total_items as a live contract; this was under-declared by four fields until the PR #157
	 * delta pass (the emitter-enumeration sweep had stopped at the top level). snake_case: Lua-
	 * native keys that survive the wire unchanged. */
	failedEntityLosses?: {
		entity_count: number;
		total_items: number;
		total_fluids: number;
		items: Record<string, number>;
		fluids: Record<string, number>;
		entities: Array<{ name: string; type: string; position?: { x: number; y: number }; items: number; fluids: number }>;
	};
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
	 * Gateway transfers only: whether the completion-side re-pause + location verify found the
	 * platform parked at its gateway_target (import-completion.lua). NON-GATING observability —
	 * set after the verdict, never an input to it; false means the creation-park failed (the
	 * instance log carries the cause). Absent on non-gateway operations AND on failed/invalid
	 * gateway transfers (the emitter sits in the success branch) — undefined does not mean
	 * "not a gateway op".
	 */
	gatewayParked?: boolean;
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
	/**
	 * A platform was LEFT BEHIND that automation could not remove — on the failure path, the failed
	 * destination's own delete was refused by the engine, so an orphan exists on the target instance
	 * (import-completion.lua). This is the ONLY meaning; it is deliberately NOT set for a failed
	 * source unlock (TTL self-heals, nothing is left behind — owner ruling 2026-08-02), and a
	 * forensics/black-box write failure never sets it (observability never gates the contract).
	 * snake_case: Lua-native keys that survive the wire unchanged.
	 */
	cleanup_failed?: boolean;
	cleanup_error?: string;
	/**
	 * The failed destination was KEPT — paused — by the deliberate one-shot, debug-gated
	 * `preserve_failed_destination` flag (consumed on use; configure.lua). The only preservation
	 * path: the accidental ones (bank-failure, evacuation-guard-failure) were removed 2026-08-02.
	 * An operator who armed the flag owes the cleanup of this surface.
	 */
	destinationPreserved?: boolean;
	/**
	 * Items the engine's `set_stack` API refused to place because the destination stack was already
	 * at its cap. Attached only when `total > 0` (import-completion.lua:605). These are SUBTRACTED
	 * from expected counts before the gate (`import-completion.lua:429-442`), so they are not a gate
	 * failure — the UI surfaces them as an info alert so an excluded item is never silent.
	 *
	 * `items` is keyed by QUALITY KEY, not by item name: `Util.make_quality_key` (game-utils.lua)
	 * returns the bare `item_name` at normal quality and `"<item_name>:<quality_name>"` otherwise.
	 * A consumer looking up `items["electronic-circuit"]` therefore misses every non-normal loss and
	 * reports zero, while the gate's own subtraction used the quality key and did not. The first
	 * version of this declaration said "keyed by item name" — a declared shape that is WRONG is worse
	 * than none, which is the argument this whole change rests on. Caught in review.
	 * (`failedEntityLosses` above is quality-keyed the same way.)
	 */
	inventoryOverflowLosses?: {
		/** The authoritative loss count. Use this, not `entities.length` — see below. */
		total: number;
		items: Record<string, number>;
		/** CAPPED AT 50 by the producer (deserializer.lua:782). A sample of where losses happened, not a count. */
		entities: Array<{
			name?: string;
			position?: { x?: number; y?: number };
			item?: string;
			/** Present on the wire (deserializer.lua) — omitted by the web UI's local type, not by Lua. */
			quality?: string;
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
