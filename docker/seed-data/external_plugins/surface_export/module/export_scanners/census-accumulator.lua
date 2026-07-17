-- FactorioSurfaceExport - Census Accumulator (paired-reads source census)
--
-- For each entity, in the SAME Lua execution it is serialized in, the export walk hands us BOTH
-- reads of that one entity: the PHYSICAL read (the Task-2 per-entity SurfaceCounter meters) and the
-- SERIALIZED read (Verification's serialized-data counting rules over the entity_data we captured).
-- record() folds both into running totals and appends an entity-attributed mismatch row whenever the
-- two disagree. verdict() then applies the SAME exact contract the frozen transfer gate applies:
-- item keys exact, fluid names within 1e-6 (Pitfall #16, atomic belt scan — a per-entity paired read
-- in the serialization tick makes a rolling source snapshot impossible to hide).
--
-- Direction convention (documented so rows read consistently): the PHYSICAL read is ground truth, so
--   expected = physical, actual = serialized, delta = actual - expected.
-- A faithful export gives delta 0; a nonzero delta is serialization drift for that entity.
--
-- STORAGE-SAFE: the accumulator holds plain data ONLY — it lives in storage.async_jobs[job_id].census
-- across the multi-tick walk, so no functions, userdata, LuaEntity handles, or metatables are stored.
-- Rows store scalars plus a COPIED position (never the entity or its position userdata), matching the
-- belt-attribution row shape in import_phases/belt_restoration.lua.
--
-- BELT ITEMS TIMING: do not call record() on belt entities before belt items are serialized into
-- entity_data — during async export, skip_belt_items defers them to the atomic pass (Pitfall #16).
--
-- FLUID AGGREGATION CHOICE: both the physical meter (count_entity_fluids) and the serialized meter
-- (count_all_fluids) return TEMPERATURE-keyed maps. The verdict compares fluids aggregate-BY-NAME at
-- EXACT_EPSILON, so we re-aggregate temp keys to per-name totals via Util.parse_fluid_temp_key. This
-- mirrors TransferValidation's file-local aggregate_fluid_counts_by_name (transfer-validation.lua) and
-- its EXACT_EPSILON = 1e-6 — the gate's rule is aggregate-by-name, so the source census uses the same
-- rule rather than re-deriving one. We replicate (not export) that ~6-line helper to keep the DI-gate
-- file's blast radius zero.
--
-- ENGINE-OWNED FLUIDS: Verification.count_all_fluids drops fluid.engine_owned unconditionally, so the
-- physical read passes exclude_engine_owned = true to stay COMMENSURATE — otherwise a fusion-reactor
-- output box (engine-managed, Pitfall #21) throws a phantom census delta. The on-the-fly
-- FluidOwnership.is_engine_owned_box check only covers the ISOLATED (seg=nil) path; measured live
-- 2026-07-17 [empirical, 2.0.77]: on a realistic reactor→generator layout the reactor's plasma OUTPUT
-- boxes expose REAL segment IDs (shared with the generators' inputs, which read seg=nil — refining
-- Pitfall #22, activatable entities expose no own segment ID; see the api-notes fusion entry),
-- so the segment path consults fluid_state.engine_owned_segments and an EMPTY set silently disables the
-- exclusion (the phantom fusion-plasma -20 that aborted the first post-merge transfer). new() therefore
-- REQUIRES the caller's pre-passed engine-owned segment set — the SAME set the serializer excludes by
-- (ExportPipeline.queue's FluidOwnership.collect_engine_owned_segments) — one ownership source of truth.
-- The cross-entity fluid dedup `state` (segment set + temp fallbacks) is caller-owned and threaded so a
-- segment spanning entities is counted once across the walk; it defaults to acc.fluid_state.

local SurfaceCounter = require("modules/surface_export/validators/surface-counter")
local Verification = require("modules/surface_export/validators/verification")
local Util = require("modules/surface_export/utils/util")

local CensusAccumulator = {}

-- Fluid names compare at aggregate-by-name within this epsilon (mirrors TransferValidation).
local EXACT_EPSILON = 1e-6

--- Fresh cross-entity fluid fold state (plain data — storage-safe).
--- Mirrors the shape SurfaceCounter.count_fluids builds so per-entity dedup keeps working.
--- engine_owned_segments: the caller's pre-passed seg_id set, SHARED by reference (not copied) so the
--- census and the serializer read one table — literally one ownership source of truth; the segment-path
--- exclusion in count_entity_fluids is a no-op without it (see header note). Both references live in
--- the same storage.async_jobs record; Factorio's storage serializer preserves shared-table identity.
local function new_fluid_state(engine_owned_segments)
    return {
        counted_segments = {},      -- seg_id set already counted (segment dedup memory)
        known_fluid_temps = {},     -- fluid_name -> temp fallback
        seg_temps = {},             -- seg_id -> {fluid, temp} authoritative
        engine_owned_segments = engine_owned_segments, -- seg_id set skipped when exclude_engine_owned is set
    }
end

--- Fold a per-entity count contribution into a running totals map.
local function add_into(totals, contribution)
    for key, amount in pairs(contribution or {}) do
        totals[key] = (totals[key] or 0) + amount
    end
end

--- Exact per-key delta (integer items): delta[key] = actual - expected, omitting zeros.
local function item_key_delta(expected, actual)
    local delta, keys = {}, {}
    for key in pairs(expected) do keys[key] = true end
    for key in pairs(actual) do keys[key] = true end
    for key in pairs(keys) do
        local value = (actual[key] or 0) - (expected[key] or 0)
        if value ~= 0 then delta[key] = value end
    end
    return delta
end

--- Re-aggregate a temperature-keyed fluid map to per-fluid-name totals.
--- Mirrors TransferValidation.aggregate_fluid_counts_by_name (file-local there): the transfer gate
--- compares fluids aggregate-by-name, so the source census aggregates the same way.
local function aggregate_fluids_by_name(fluid_counts)
    local by_name = {}
    for fluid_key, volume in pairs(fluid_counts or {}) do
        local name = Util.parse_fluid_temp_key(fluid_key)
        by_name[name] = (by_name[name] or 0) + (volume or 0)
    end
    return by_name
end

--- Per-name fluid delta within EXACT_EPSILON: delta[name] = actual - expected, omitting near-zeros.
local function fluid_name_delta(expected_by_name, actual_by_name)
    local delta, names = {}, {}
    for name in pairs(expected_by_name) do names[name] = true end
    for name in pairs(actual_by_name) do names[name] = true end
    for name in pairs(names) do
        local value = (actual_by_name[name] or 0) - (expected_by_name[name] or 0)
        if math.abs(value) > EXACT_EPSILON then delta[name] = value end
    end
    return delta
end

--- Build a storage-safe, entity-attributed ITEM mismatch row (scalars + copied position only).
--- expected = physical ground truth, actual = serialized capture, delta = actual - expected.
--- Rows are ITEM-attributed only. Items are self-contained per entity, so a per-entity physical-vs-
--- serialized comparison is commensurate. Fluids are NOT row-attributed: count_entity_fluids dedups
--- a fluid segment across the entities it spans (the first entity in a pipe run counts the whole
--- segment, later ones read 0 — Pitfall #22, pipes/tanks are the segment-bearing entities), while the
--- serialized side attributes each entity its own share. A per-entity fluid comparison would therefore
--- be non-commensurate and fire a spurious row on every multi-entity segment even when the aggregate is
--- exact. Fluids are checked aggregate-by-name in verdict() instead, the only commensurate granularity.
local function build_row(entity, entity_data, phys_items, ser_items, item_delta)
    return {
        unit_number = entity.unit_number,
        entity_id = entity_data.entity_id,
        entity_name = entity.name,
        entity_type = entity.type,
        position = { x = entity.position.x, y = entity.position.y },
        -- items (per quality_key)
        expected = phys_items,
        actual = ser_items,
        delta = item_delta,
    }
end

--- Create a fresh, storage-safe accumulator.
--- @param engine_owned_segments table: pre-passed engine-owned seg_id set — the SAME table the
---        serializer excludes by (ExportPipeline.queue). REQUIRED (fail-loud): a nil set would
---        silently disable the segment-path exclusion and resurrect the phantom-plasma abort.
--- @return table: plain-data accumulator suitable for storage.async_jobs[job_id].census
function CensusAccumulator.new(engine_owned_segments)
    if not engine_owned_segments then
        error("CensusAccumulator.new requires the pre-passed engine-owned segment set " ..
            "(FluidOwnership.collect_engine_owned_segments) — see the ENGINE-OWNED FLUIDS header note")
    end
    return {
        physical_items = {},    -- quality_key -> count (running total)
        serialized_items = {},  -- quality_key -> count
        physical_fluids = {},   -- fluid_temp_key -> amount
        serialized_fluids = {}, -- fluid_temp_key -> amount
        mismatches = {},        -- entity-attributed rows
        entity_count = 0,
        -- cross-entity segment dedup, persists across the walk
        fluid_state = new_fluid_state(engine_owned_segments),
    }
end

--- Record the paired reads for ONE entity, in the caller's current Lua execution.
--- Physical via the Task-2 SurfaceCounter meters; serialized via Verification's counting rules.
--- @param acc table: accumulator from new()
--- @param entity LuaEntity: the live source entity (physical read)
--- @param entity_data table: the serialized form of the SAME entity (serialized read)
--- @param fluid_state table|nil: caller-owned cross-entity fluid dedup state; defaults to acc.fluid_state
function CensusAccumulator.record(acc, entity, entity_data, fluid_state)
    fluid_state = fluid_state or acc.fluid_state
    acc.entity_count = acc.entity_count + 1

    -- Physical side: the shared per-entity meters (no shadow counting — call the Task-2 meters).
    -- exclude_engine_owned = true keeps the physical read commensurate with the serializer, which
    -- drops engine_owned fluids (fusion outputs) unconditionally.
    local phys_items = SurfaceCounter.count_entity_items(entity)
    local phys_fluids = SurfaceCounter.count_entity_fluids(entity, true, fluid_state)

    -- Serialized side: reuse Verification's serialized-data counting rules via a single-element fold
    -- (Verification.count_all_* iterate an entity array; a 1-element array counts this one entity).
    local one = { entity_data }
    local ser_items = Verification.count_all_items(one)
    local ser_fluids = Verification.count_all_fluids(one)

    -- Fold into running totals. Fluids are accumulated for the aggregate-by-name verdict check only
    -- (the per-entity physical fluid read is segment-deduped, so it is not row-attributable — see
    -- build_row). The running physical fluid total still equals the true surface total because each
    -- segment is counted exactly once across the walk.
    add_into(acc.physical_items, phys_items)
    add_into(acc.serialized_items, ser_items)
    add_into(acc.physical_fluids, phys_fluids)
    add_into(acc.serialized_fluids, ser_fluids)

    -- Per-entity attribution is ITEMS ONLY (commensurate); fluids are verdict-level aggregate-by-name.
    local item_delta = item_key_delta(phys_items, ser_items)
    if next(item_delta) ~= nil then
        acc.mismatches[#acc.mismatches + 1] =
            build_row(entity, entity_data, phys_items, ser_items, item_delta)
    end
end

--- Produce the census verdict from the accumulated totals.
--- ok iff: zero mismatch rows AND aggregate item keys exact AND fluid names within EXACT_EPSILON.
--- @param acc table: accumulator from new()
--- @return table: { ok = boolean, mismatches = rows, totals = {...} }
function CensusAccumulator.verdict(acc)
    local item_delta = item_key_delta(acc.physical_items, acc.serialized_items)
    local phys_fluids_by_name = aggregate_fluids_by_name(acc.physical_fluids)
    local ser_fluids_by_name = aggregate_fluids_by_name(acc.serialized_fluids)
    local fluid_delta = fluid_name_delta(phys_fluids_by_name, ser_fluids_by_name)

    local items_exact = next(item_delta) == nil
    local fluids_exact = next(fluid_delta) == nil
    local ok = (#acc.mismatches == 0) and items_exact and fluids_exact

    return {
        ok = ok,
        mismatches = acc.mismatches,
        totals = {
            entity_count = acc.entity_count,
            physical_items = acc.physical_items,
            serialized_items = acc.serialized_items,
            physical_fluids_by_name = phys_fluids_by_name,
            serialized_fluids_by_name = ser_fluids_by_name,
            item_delta = item_delta,
            fluid_delta = fluid_delta,
            items_exact = items_exact,
            fluids_exact = fluids_exact,
        },
    }
end

return CensusAccumulator
