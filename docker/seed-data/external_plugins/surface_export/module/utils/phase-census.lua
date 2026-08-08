-- FactorioSurfaceExport - Phase Census (per-phase, subject-scoped item accounting)
--
-- WHY THIS EXISTS: until now the import produced exactly ONE item measurement — the exact gate,
-- platform-wide, at the very end. When it disagreed with the payload the only thing you knew was
-- "the import lost/gained N of X somewhere across nine phases". Attributing that to a phase took a
-- banked black box and hours of forensics (the 2026-08-08 belt +4 investigation is the worked
-- example: the answer was "the belts phase", and nothing in the pipeline could say so).
--
-- WHAT IT DOES: each phase brackets its OWN SUBJECT with a before/after count, so the import
-- reports a per-phase delta instead of one end-state number.
--
-- WHY IT IS CHEAP (the design question that shaped this — owner, 2026-08-08): a full census is a
-- whole-surface, all-subjects sweep (SurfaceCounter.count_items does find_entities_filtered({})).
-- Running that per phase would be ~6x. But the phases already partition the work BY SUBJECT, and
-- each subject is owned by exactly ONE phase, so a phase only needs to count the subject it owns:
--   hub         -> hub entity inventories   (one entity)
--   belts       -> belt transport lines     (already measured by the restore's own bracket — free)
--   state       -> no item subject          (skipped entirely)
--   inventories -> entity inventories       (the only genuinely expensive one)
--   held_items  -> inserter held stacks     (inserters only)
-- Total added work is therefore ~2 inventory-only sweeps — about ONE full census equivalent for
-- the whole import, not one per phase.
--
-- REPORT-ONLY (deliberate): nothing here can fail a transfer. The verdict remains the exact gate's
-- alone. Wiring a census into the verdict would make this a data-integrity gate change (/di-change)
-- and a much larger review; this pass is an instrument, and instruments observe.
--
-- NOT BUILT ON SurfaceCounter BY DESIGN: SurfaceCounter.count_entity_items is the destination
-- gate's counting function and its contract says its readings must not change. This module calls
-- the SAME underlying InventoryScanner primitives instead, so the gate's path is untouched. The
-- agreement property (per-subject counts must sum to count_entity_items over the same entities) is
-- pinned by test/phase-census.test.cjs rather than by sharing code.
--
-- STORAGE-SAFE: plain data only (string keys, numbers). Snapshots live on the job across the
-- multi-tick walk, so no LuaEntity handles, userdata, functions, or metatables are ever stored.

local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local GameUtils = require("modules/surface_export/utils/game-utils")
local Util = require("modules/surface_export/utils/util")

local PhaseCensus = {}

--- The subjects a phase can own. A phase with no item subject records nothing.
PhaseCensus.SUBJECT_INVENTORIES = "inventories"
PhaseCensus.SUBJECT_BELTS = "belts"
PhaseCensus.SUBJECT_HELD = "held"

--- Fold one contribution map into a running total map.
local function add_into(totals, contribution)
	for key, count in pairs(contribution) do
		totals[key] = (totals[key] or 0) + count
	end
end

--- Count ONE entity's items for ONE subject.
--- Mirrors SurfaceCounter.count_entity_items' per-subject blocks exactly (same primitives, same
--- quality-key rule, same pcall-with-logged-error pattern the pcall-logging lint guard requires) —
--- but each block is individually addressable. An entity that does not carry the subject
--- contributes nothing (a chest has no belt lines; a belt has no held stack).
--- @param entity LuaEntity
--- @param subject string: one of the PhaseCensus.SUBJECT_* constants
--- @return table: quality_key -> count for this entity and subject (empty if inapplicable)
function PhaseCensus.count_entity_subject(entity, subject)
	local totals = {}
	if not entity or not entity.valid then
		return totals
	end

	if subject == PhaseCensus.SUBJECT_INVENTORIES then
		local ok, err = pcall(function()
			local inventories = InventoryScanner.extract_all_inventories(entity)
			add_into(totals, InventoryScanner.count_all_items(inventories))
		end)
		if not ok then
			log(string.format("[PhaseCensus] Error counting inventories for entity %s: %s", entity.name, err))
		end

	elseif subject == PhaseCensus.SUBJECT_BELTS then
		if GameUtils.BELT_ENTITY_TYPES[entity.type] then
			local ok, err = pcall(function()
				for _, line_data in ipairs(InventoryScanner.extract_belt_items(entity)) do
					for _, item in ipairs(line_data.items or {}) do
						local key = Util.make_quality_key(item.name, item.quality or Util.QUALITY_NORMAL)
						totals[key] = (totals[key] or 0) + item.count
					end
				end
			end)
			if not ok then
				log(string.format("[PhaseCensus] Error counting belt items for entity %s: %s", entity.name, err))
			end
		end

	elseif subject == PhaseCensus.SUBJECT_HELD then
		if entity.type == "inserter" then
			local ok, err = pcall(function()
				local held = InventoryScanner.extract_inserter_held_item(entity)
				if held then
					local key = Util.make_quality_key(held.name, held.quality or Util.QUALITY_NORMAL)
					totals[key] = (totals[key] or 0) + held.count
				end
			end)
			if not ok then
				log(string.format("[PhaseCensus] Error counting held item for entity %s: %s", entity.name, err))
			end
		end
	end

	return totals
end

--- Count a SET of entities for one subject.
--- The caller supplies the entity set (a phase already holds its own entity_map), which is what
--- keeps this off the whole-surface sweep.
--- @param entities table: array or map whose VALUES are LuaEntity
--- @param subject string
--- @return table, number: quality_key -> count, grand total
function PhaseCensus.count_subject(entities, subject)
	local totals = {}
	local total = 0
	for _, entity in pairs(entities or {}) do
		for key, count in pairs(PhaseCensus.count_entity_subject(entity, subject)) do
			totals[key] = (totals[key] or 0) + count
			total = total + count
		end
	end
	return totals, total
end

--- Key-for-key delta of two count maps, keeping ONLY non-zero entries.
--- Absences count: a key present in `before` and gone from `after` yields a negative entry, which
--- is how a phase that DESTROYED items is distinguished from one that never touched them.
--- @return table: quality_key -> signed delta (empty table == the phase moved nothing)
function PhaseCensus.diff(before, after)
	local delta = {}
	local keys = {}
	for key in pairs(before or {}) do keys[key] = true end
	for key in pairs(after or {}) do keys[key] = true end
	for key in pairs(keys) do
		local d = ((after or {})[key] or 0) - ((before or {})[key] or 0)
		if d ~= 0 then
			delta[key] = d
		end
	end
	return delta
end

--- Open a phase's subject bracket: snapshot the subject BEFORE the phase runs.
--- No-op (and no cost) when the job carries no census table — the caller decides whether the
--- instrument is armed.
--- @param job table
--- @param phase string: the PhaseRecorder phase name this bracket belongs to
--- @param subject string
--- @param entities table: the entity set this phase owns
function PhaseCensus.open(job, phase, subject, entities)
	if not job or not job.phase_census then return end
	local counts = PhaseCensus.count_subject(entities, subject)
	job.phase_census[phase] = { subject = subject, before = counts }
end

--- Close a phase's subject bracket: snapshot AFTER, store the signed delta, drop the raw
--- before/after maps (the delta is the product; the snapshots would just bloat storage).
--- @return table: the delta map (also stored on the job)
function PhaseCensus.close(job, phase, subject, entities)
	if not job or not job.phase_census then return {} end
	local record = job.phase_census[phase]
	if not record or record.before == nil then
		-- close() without a matching open() cannot produce a delta. Record the phase as
		-- unmeasured rather than inventing a zero — an unmeasured phase and a phase that moved
		-- nothing are different facts, and reporting them the same way is how a blind spot hides.
		job.phase_census[phase] = { subject = subject, unmeasured = true }
		return {}
	end
	local after = PhaseCensus.count_subject(entities, subject)
	local delta = PhaseCensus.diff(record.before, after)
	job.phase_census[phase] = { subject = subject, delta = delta }
	return delta
end

--- Record a phase's delta that was measured elsewhere (the belts phase: the side-restore already
--- brackets every line it writes, in the SAME execution as the writes, which is the only correct
--- way to measure a subject that never freezes). Re-counting belts here would be both wasteful and
--- WRONG — belts move between any two instants, so a second bracket would report engine movement
--- as a phase effect.
--- @param line_set string: which belt lines the delta covers, carried through to the report so the
---   reconciliation residual is never compared against a different line-set than it was measured on
function PhaseCensus.record_external(job, phase, subject, delta, line_set)
	if not job or not job.phase_census then return end
	job.phase_census[phase] = { subject = subject, delta = delta or {}, line_set = line_set }
end

--- Sum every recorded phase delta into one map.
--- @return table, boolean: combined delta, and whether ANY phase was unmeasured (an unmeasured
---   phase makes the sum a lower bound, so the reconciliation must not be read as exact)
function PhaseCensus.total(job)
	local combined = {}
	local complete = true
	for _, record in pairs((job or {}).phase_census or {}) do
		if record.unmeasured then
			complete = false
		else
			add_into(combined, record.delta or {})
		end
	end
	for key, value in pairs(combined) do
		if value == 0 then combined[key] = nil end
	end
	return combined, complete
end

--- Human-readable one-line summary, phase by phase. This is the line that turns "the import
--- gained 4 explosive-rocket somewhere" into "the belts phase gained 4 explosive-rocket".
function PhaseCensus.format(job)
	local parts = {}
	for phase, record in pairs((job or {}).phase_census or {}) do
		if record.unmeasured then
			parts[#parts + 1] = phase .. " UNMEASURED"
		else
			local entries = {}
			for key, delta in pairs(record.delta or {}) do
				entries[#entries + 1] = string.format("%s %+d", key, delta)
			end
			table.sort(entries)
			parts[#parts + 1] = phase .. " " .. (#entries > 0 and table.concat(entries, ", ") or "0")
		end
	end
	table.sort(parts)
	return table.concat(parts, " | ")
end

return PhaseCensus
