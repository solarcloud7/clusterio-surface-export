-- Selection Lab v3 — copy/paste-scoped surface export/import + gate-meter audit (debug instrument).
--
-- Owner-specified semantics (v3):
--   COPY   (drag):            EntityScanner.serialize_entity per selected entity + bbox anchor.
--                             RAM only, PER-PLAYER (storage.selection_lab[player_index].export);
--                             never sent to the controller. Capture, audit baseline, and the
--                             undo/redo journals are all player-scoped; paste/force/redo are
--                             TRANSACTIONAL (any create/restore failure rolls back every created
--                             entity, resurrects force-destroyed blockers, journals nothing).
--   PASTE  (shift+drag):      ALL-OR-NOTHING. Every entity target must be unoccupied (same-name
--                             occupants included; ground item-entities and floor tiles never block).
--                             Any conflict: place NOTHING, red-box every conflict, cannot_build sound.
--                             Fully clear: create all + the REAL import restores + undo journal entry.
--   AUDIT  (ctrl+drag):       no mutation, ignores the capture. Runs the REAL transfer-gate meters
--                             (SurfaceCounter.count_entity_items / count_entity_fluids) over the
--                             dragged selection and prints entities/items/fluids totals — plus a
--                             DELTA section vs the previous audit (before/after workflow).
--   FORCE  (shift+right-drag): paste regardless — blockers are serialized (for undo), destroyed
--                             (guards: never characters, never a space-platform-hub, never another
--                             force's entities), then the paste proceeds; overlaps still red-boxed.
--   UNDO / REDO (Ctrl+Alt+Z / Ctrl+Alt+Y custom inputs): journal-based. Undo destroys what the paste
--                             created — resolved by stable unit_number (never name+position), so an
--                             unrelated same-name entity built there later is never touched — and
--                             resurrects force-destroyed blockers WITH contents and active state.
--                             Redo is MODE-FAITHFUL: a plain paste replays through the all-or-nothing
--                             plan (refuses with red boxes if the area is now occupied); a force paste
--                             replays through force_execute. Redo never exceeds the original action's
--                             destructiveness. Bindings are Ctrl+ALT (not Ctrl+Shift) so they do not
--                             collide with vanilla Undo (Ctrl+Z) / Redo (Ctrl+Y, Ctrl+Shift+Z).
--
-- Debug instrument rules: gated on debug_mode; verdicts print PHYSICAL counts (insert returns are
-- never evidence — tests/belt-lab/NOTEBOOK.md BELT-R8); no interaction with transfer jobs, locks,
-- or the controller. FluidRestoration runs only on ISOLATED pastes: if any pasted fluidbox connects
-- to an entity outside the pasted set, fluid restore is skipped (it writes SEGMENT totals and would
-- clobber a live network; Pitfall #22, activatable entities expose no own segment id — connection-
-- walking, not segment ids, is the detection). Known gaps: no circuit-wire reconnection, no rotation.
-- Cross-surface paste measured WORKING at 2.0.77 (2026-07-17, gallery migration): paste plans
-- against event.surface, so dragging on any surface pastes there. `active` is preserved via the
-- lab-only `lab_active` record field (the production serializer deliberately does not carry it).

local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local Deserializer = require("modules/surface_export/core/deserializer")
local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")
local EntityStateRestoration = require("modules/surface_export/import_phases/entity_state_restoration")
local FluidRestoration = require("modules/surface_export/import_phases/fluid_restoration")
local SurfaceCounter = require("modules/surface_export/validators/surface-counter")
local Util = require("modules/surface_export/utils/util")

local SelectionLab = {}

local HIGHLIGHT_TTL = 60 * 8
local UNDO_DEPTH = 10

local function debug_enabled()
	return storage.surface_export_config and storage.surface_export_config.debug_mode == true
end

local function physical_census(entities)
	local total = 0
	for _, e in pairs(entities) do
		if e.valid then
			-- intentional probe; failure expected on entity classes without item counts, no log
			local ok, n = pcall(function() return e.get_item_count() end)
			if ok and type(n) == "number" then total = total + n end
		end
	end
	return total
end

local function capture_item_total(records)
	local total = 0
	for _, rec in ipairs(records) do
		local sd = rec.specific_data
		if sd then
			for _, inv in ipairs(sd.inventories or {}) do
				for _, item in ipairs(inv.items or {}) do total = total + (item.count or 0) end
			end
			for _, line_data in ipairs(sd.items or {}) do
				for _, item in ipairs(line_data.items or {}) do total = total + (item.count or 0) end
			end
			-- Inserter held items (entity-handlers records specific_data.held_item = {name,count,quality});
			-- the paste path restores them (deserializer.lua), so the capture meter must count them too —
			-- otherwise the "capture holds N" headline undercounts vs the physical census on paste.
			if sd.held_item and sd.held_item.count then total = total + sd.held_item.count end
		end
	end
	return total
end

local function draw_box(surface, position, color, player_index)
	rendering.draw_rectangle({
		color = color, width = 3, filled = false,
		left_top = { position.x - 0.5, position.y - 0.5 },
		right_bottom = { position.x + 0.5, position.y + 0.5 },
		surface = surface, time_to_live = HIGHLIGHT_TTL, players = { player_index },
	})
end

-- ONE visual encoding for plan verdicts, shared by paste (refusal/success) and preview so the
-- preview can never render a verdict differently from the paste that follows it.
local CONFLICT_RED = { r = 1, g = 0.2, b = 0.2, a = 0.9 }
local PLACEABLE_GREEN = { r = 0.3, g = 1, b = 0.3, a = 0.6 }

local function draw_plan_boxes(surface, plan_list, color, player_index)
	for _, c in ipairs(plan_list) do
		draw_box(surface, c.rec.position, color, player_index)
	end
end

-- Tile-bounds blocker-search area from the record's prototype collision box, translated to the
-- target position. A fixed 1x1 center probe misses the edge tiles of a multi-tile footprint (e.g. a
-- 3x3 assembler), leaving edge blockers neither destroyed nor red-boxed. Falls back to 1x1 when the
-- prototype is unavailable (logged).
local function footprint_area(rec)
	local proto = prototypes.entity[rec.name]
	if proto and proto.collision_box then
		local cb = proto.collision_box
		return {
			{ math.floor(rec.position.x + cb.left_top.x), math.floor(rec.position.y + cb.left_top.y) },
			{ math.ceil(rec.position.x + cb.right_bottom.x), math.ceil(rec.position.y + cb.right_bottom.y) },
		}
	end
	log(string.format("[SelectionLab] no collision_box for %s — 1x1 blocker fallback", tostring(rec.name)))
	return {
		{ rec.position.x - 0.5, rec.position.y - 0.5 },
		{ rec.position.x + 0.5, rec.position.y + 0.5 },
	}
end

-- True if any pasted entity's fluidbox connects to an entity OUTSIDE the pasted set. FluidRestoration
-- writes SEGMENT totals, so a pasted pipe merging into a live network would clobber it. Detect via
-- connection-walking on the pasted entities' own fluidboxes (Pitfall #22, activatable entities expose
-- no own segment id, so segment ids are not a reliable signal here). Fails SAFE: a probe error returns
-- true (skip fluids) and surfaces via log.
local function paste_touches_live_fluid_network(entity_map)
	local pasted = {}
	for _, e in pairs(entity_map) do
		if e and e.valid and e.unit_number then pasted[e.unit_number] = true end
	end
	for _, e in pairs(entity_map) do
		if e and e.valid and e.fluidbox then
			for i = 1, #e.fluidbox do
				local ok, conns = pcall(function() return e.fluidbox.get_connections(i) end)
				if not ok then
					log("[SelectionLab] fluid connection probe failed: " .. tostring(conns))
					return true
				end
				for _, other_box in ipairs(conns or {}) do
					local owner = other_box.owner
					if owner and owner.valid and owner.unit_number and not pasted[owner.unit_number] then
						return true
					end
				end
			end
		end
	end
	return false
end

-- Belt-connectable types whose lane sides the copy captures for the side-scoped restore
-- (single implementation: BeltRestoration.capture_side_groups / restore_side_groups — the
-- production module; this tool is a diagnostic consumer of the SAME system).
local BELT_LINE_TYPES = {
	["transport-belt"] = true, ["underground-belt"] = true,
	["splitter"] = true, ["loader"] = true, ["loader-1x1"] = true,
}

-- Per-player state (review P1: capture/audit/undo/redo were global storage slots — a second
-- connected admin could overwrite another player's capture and then undo/force-redo their
-- mutations). Every state family is keyed by player_index. Pre-scoping legacy globals are
-- adopted once by the first player who interacts (logged), so existing captures/undo history
-- survive the upgrade.
local function pstate(player_index)
	storage.selection_lab = storage.selection_lab or {}
	local t = storage.selection_lab[player_index]
	if not t then
		t = { undo = {}, redo = {} }
		if storage.selection_export or storage.selection_lab_undo or storage.selection_lab_redo
			or storage.selection_lab_audit_prev then
			t.export = storage.selection_export
			t.undo = storage.selection_lab_undo or {}
			t.redo = storage.selection_lab_redo or {}
			t.audit_prev = storage.selection_lab_audit_prev
			storage.selection_export = nil
			storage.selection_lab_undo = nil
			storage.selection_lab_redo = nil
			storage.selection_lab_audit_prev = nil
			log("[SelectionLab] adopted legacy shared state into player_index " .. player_index)
		end
		storage.selection_lab[player_index] = t
	end
	return t
end

-- Machine-readable outcome: every copy/paste exit returns a typed result table AND logs it as
-- one JSON line, so a headless driver (selection_lab_drive) and the log both carry the verdict —
-- chat is a courtesy, never the only evidence (owner rule 2026-07-18: "fix this tool so you can
-- see the results of it").
local function lab_result(mode, result)
	log("[SelectionLab][" .. string.upper(mode) .. "-JSON] " .. helpers.table_to_json(result))
	return result
end

-- === COPY ==================================================================================

function SelectionLab.copy(event)
	local player = game.get_player(event.player_index)
	local records = {}
	local belt_pairs = {}
	local minx, miny = math.huge, math.huge
	for _, entity in ipairs(event.entities) do
		if entity.valid and EntityScanner.is_exportable_entity(entity) then
			local entity_data = EntityScanner.serialize_entity(entity)
			if entity_data then
				-- Lab-only field: the production serializer deliberately does not carry `active`
				-- (activation is the transfer pipeline's phase); the paste path must, or frozen
				-- fixtures (mid-craft machines) wake up and run on paste.
				entity_data.lab_active = entity.active
				records[#records + 1] = entity_data
				if BELT_LINE_TYPES[entity.type] then
					belt_pairs[#belt_pairs + 1] = { entity = entity, id = entity_data.entity_id }
				end
				minx = math.min(minx, entity_data.position.x)
				miny = math.min(miny, entity_data.position.y)
			end
		end
	end
	if #records == 0 then
		player.print("[SelectionLab] nothing exportable in the selection", { r = 1, g = 0.6, b = 0.3 })
		return lab_result("copy", { outcome = "nothing_exportable", selected = #event.entities })
	end
	local side_groups = BeltRestoration.capture_side_groups(belt_pairs)
	-- WYSIWYG anchor (owner request 2026-07-18): anchor to the DRAG RECTANGLE's corner, not the
	-- entity-bounding min — pasted entities keep their offset from where the selection box started,
	-- so a paste drag lands exactly where the box is drawn (the old entity-min anchor produced the
	-- surprise (+14,-1) landing). Fallback to entity-min for area-less events.
	local lt = event.area and event.area.left_top or nil
	local anchor = lt and { x = math.floor(lt.x), y = math.floor(lt.y) }
		or { x = math.floor(minx), y = math.floor(miny) }
	pstate(event.player_index).export = {
		records = records,
		side_groups = side_groups,
		anchor = anchor,
		surface = event.surface.name,
		tick = game.tick,
	}
	-- Single compute, used by BOTH chat and the logged result — they must never diverge.
	local item_total = capture_item_total(records)
	player.print(string.format(
		"[SelectionLab] COPIED %d entities (%d items%s). Shift-drag = paste (all-or-nothing); Shift+Right-drag = force.",
		#records, item_total,
		side_groups and (", " .. #side_groups .. " belt sides") or ""), { r = 0.4, g = 0.9, b = 1 })
	return lab_result("copy", {
		outcome = "copied", records = #records, item_total = item_total,
		belt_sides = side_groups and #side_groups or 0, anchor = anchor, surface = event.surface.name,
	})
end

-- === paste planning ========================================================================

local function paste_offset(cap, event)
	local lt = event.area and event.area.left_top or nil
	if not lt then return { x = 0, y = 0 } end
	return { x = math.floor(lt.x) - cap.anchor.x, y = math.floor(lt.y) - cap.anchor.y }
end

-- Shallow record copy with translated position (specific_data shared — restores only read it).
local function translate(rec, offset)
	local copy = {}
	for k, v in pairs(rec) do copy[k] = v end
	copy.position = { x = rec.position.x + offset.x, y = rec.position.y + offset.y }
	return copy
end

-- Placement-check spec for a record. Ghost records (entity-ghost / tile-ghost) REQUIRE
-- inner_name — can_place_entity/create_entity reject a bare ghost name ("Unknown entity name:" /
-- "Key inner_name not found"; measured 2026-07-17 via the drive battery).
local function place_spec(rec, player)
	local spec = {
		name = rec.name, position = rec.position, direction = rec.direction,
		force = rec.force or (player and player.force) or "player",
	}
	if rec.specific_data and rec.specific_data.ghost_name then
		spec.inner_name = rec.specific_data.ghost_name
	end
	return spec
end

-- v3 plan over already-translated target records: every target either placeable or conflicted.
-- Same-name occupants ARE conflicts; ground item-entities and tiles never block (can_place_entity
-- ignores loose items). Blocker sweep uses the full footprint, not a 1x1 center probe.
local function plan_targets(surface, targets, player)
	local plan = { clear = {}, conflict = {} }
	for _, t in ipairs(targets) do
		local placeable = surface.can_place_entity(place_spec(t, player))
		if placeable then
			plan.clear[#plan.clear + 1] = { rec = t }
		else
			local blockers = {}
			for _, e in ipairs(surface.find_entities_filtered({ area = footprint_area(t) })) do
				if e.valid and e.unit_number and e.type ~= "item-entity" then blockers[#blockers + 1] = e end
			end
			plan.conflict[#plan.conflict + 1] = { rec = t, blockers = blockers }
		end
	end
	return plan
end

local function plan_paste(surface, cap, offset, player)
	local targets = {}
	for _, rec in ipairs(cap.records) do targets[#targets + 1] = translate(rec, offset) end
	return plan_targets(surface, targets, player)
end

-- Create all records + run the REAL import restores (production phase order).
-- side_groups (optional): captured lane sides — belt items then restore via the side-scoped
-- BELT-R11/R12 path instead of the legacy captured-position path. Legacy captures / undo
-- resurrections pass nil and take the old path.
-- transactional (review P1 — "ALL-OR-NOTHING ends at preflight"): when true, ANY create failure
-- or restore error destroys every entity this call created and reports failure — the caller must
-- not journal or report partial success. Undo resurrection passes false (best-effort, misses
-- reported, never destroys what it managed to bring back).
-- Returns records, entity_map, created, create_failed, ok, err.
local function execute_create_and_restore(surface, recs, player, side_groups, transactional)
	local records, entity_map = {}, {}
	local created, create_failed = 0, 0
	-- Creation goes through the PRODUCTION Deserializer.create_entity — the same function the
	-- transfer import uses (ghost inner_name handling, underground type, recipe-at-create for
	-- fluid port alignment). The tool must never hand-roll its own create spec (same-system rule;
	-- the hand-rolled spec broke on ghosts).
	for _, rec in ipairs(recs) do
		local ok, entity = pcall(function() return Deserializer.create_entity(surface, rec) end)
		if ok and entity then
			created = created + 1
			records[#records + 1] = rec
			entity_map[rec.entity_id] = entity
		else
			create_failed = create_failed + 1
			log(string.format("[SelectionLab] create_entity failed for %s at (%.1f,%.1f): %s",
				rec.name, rec.position.x, rec.position.y, ok and "returned nil" or tostring(entity)))
		end
	end
	local function rollback(reason)
		local destroyed = 0
		for _, e in pairs(entity_map) do
			if e and e.valid then e.destroy() destroyed = destroyed + 1 end
		end
		log(string.format("[SelectionLab] TRANSACTION ROLLBACK (%s): destroyed %d created entities", reason, destroyed))
		return nil, nil, created, create_failed, false, reason
	end
	if transactional and create_failed > 0 then
		return rollback(create_failed .. " creation failure(s)")
	end
	local function run_restores()
	if side_groups then
		local placed, unplaced, leaks_undone, anomalies = BeltRestoration.restore_side_groups(side_groups, entity_map)
		if unplaced > 0 or anomalies > 0 then
			local message = string.format(
				"[SelectionLab] belt side-restore: %d placed, %d UNPLACED, %d anomalies (no fallback — canonical belt laws in api-notes)",
				placed, unplaced, anomalies)
			if transactional then error(message) end
			player.print(message, { r = 1, g = 0.6, b = 0.3 })
		elseif leaks_undone > 0 then
			player.print(string.format(
				"[SelectionLab] belt side-restore: %d placed; %d cross-side leaks detected and undone",
				placed, leaks_undone), { r = 1, g = 0.8, b = 0.4 })
		end
	else
		BeltRestoration.restore(records, entity_map)
	end
	-- Entity state: same two production steps, same order — the per-entity property restore
	-- (creation-adjacent) then the FULL production phase (control behavior, entity filters —
	-- splitter/loader/inserter/slot —, logistic requests, circuit + power connections).
	-- Calling the phase module keeps the tool identical to the transfer pipeline; cherry-picking
	-- Deserializer functions here is how paste silently lost loader/splitter filters.
	for _, rec in ipairs(records) do
		local entity = entity_map[rec.entity_id]
		if entity and entity.valid then
			Deserializer.restore_entity_state(entity, rec)
		end
	end
	EntityStateRestoration.restore_all(records, entity_map)
	-- Inventories in two passes: beacons FIRST so their beacon_modules populate and the boosted
	-- crafting_speed sets the correct set_stack cap before crafter inputs restore (production Phase 2
	-- ordering; CLAUDE.md Import Phase Ordering). A single record-order pass clamps overloaded inputs
	-- when a crafter's record precedes its beacon's.
	for _, rec in ipairs(records) do
		local entity = entity_map[rec.entity_id]
		if entity and entity.valid and rec.type == "beacon" then
			Deserializer.restore_inventories(entity, rec)
		end
	end
	for _, rec in ipairs(records) do
		local entity = entity_map[rec.entity_id]
		if entity and entity.valid and rec.type ~= "beacon" then
			Deserializer.restore_inventories(entity, rec)
		end
	end
	-- FluidRestoration writes SEGMENT totals: a pasted pipe merging into a live network would set the
	-- whole segment to the captured amount, silently clobbering pre-existing fluid. Only restore when
	-- the pasted fluid system is ISOLATED (no fluidbox connects to an entity outside the paste).
	if paste_touches_live_fluid_network(entity_map) then
		player.print("[SelectionLab] fluids skipped: pasted fluid system connects to live network — fluid restore only runs on isolated pastes",
			{ r = 1, g = 0.7, b = 0.3 })
	else
		local fluids_ok, fluids_err = pcall(function() FluidRestoration.restore(records, entity_map) end)
		if not fluids_ok then
			log("[SelectionLab] fluid restore failed: " .. tostring(fluids_err))
			if transactional then error("fluid restore failed: " .. tostring(fluids_err)) end
			player.print("[SelectionLab] fluid restore skipped: " .. tostring(fluids_err), { r = 1, g = 0.7, b = 0.3 })
		end
	end
	-- Applied LAST (after all restores) so restoration always sees the same entity state.
	-- The paste keeps whatever active/inactive state the capture recorded — both directions
	-- (owner ruling 2026-07-17). nil = pre-lab_active capture; leave the engine default.
	for _, rec in ipairs(records) do
		local entity = entity_map[rec.entity_id]
		if entity and entity.valid and rec.lab_active ~= nil then
			entity.active = rec.lab_active
		end
	end
	end
	local restore_ok, restore_err = xpcall(run_restores, debug.traceback)
	if not restore_ok then
		log("[SelectionLab] restore error: " .. tostring(restore_err))
		if transactional then
			return rollback("restore error: " .. tostring(restore_err))
		end
		if player then
			player.print("[SelectionLab] restore error (best-effort path): " .. tostring(restore_err),
				{ r = 1, g = 0.4, b = 0.4 })
		end
	end
	return records, entity_map, created, create_failed, true, nil
end

local function push_undo(st, entry)
	local stack = st.undo
	stack[#stack + 1] = entry
	while #stack > UNDO_DEPTH do table.remove(stack, 1) end
	st.redo = {}
end

-- Journal each created entity by its STABLE unit_number (undo resolves identity by it, never by
-- name+position — which could destroy an unrelated same-name entity built there later). Position is
-- kept only as a fallback search key, matched by unit_number, never as sole identity.
local function journal_created(records, entity_map)
	local created = {}
	for _, rec in ipairs(records) do
		local e = entity_map and entity_map[rec.entity_id]
		created[#created + 1] = {
			name = rec.name,
			unit_number = (e and e.valid and e.unit_number) or nil,
			position = { x = rec.position.x, y = rec.position.y },
		}
	end
	return created
end

-- === PASTE (all-or-nothing) ================================================================

function SelectionLab.paste(event)
	local player = game.get_player(event.player_index)
	local st = pstate(event.player_index)
	local cap = st.export
	if not (cap and cap.records and #cap.records > 0) then
		player.print("[SelectionLab] nothing copied — plain-drag a source selection first", { r = 1, g = 0.4, b = 0.4 })
		return lab_result("paste", { outcome = "no_capture" })
	end
	local surface = event.surface
	local offset = paste_offset(cap, event)
	local plan = plan_paste(surface, cap, offset, player)

	if #plan.conflict > 0 then
		draw_plan_boxes(surface, plan.conflict, CONFLICT_RED, player.index)
		player.play_sound({ path = "utility/cannot_build" })
		player.print(string.format(
			"[SelectionLab] PASTE REFUSED: %d of %d targets occupied (red). Nothing was placed. Shift+Right-drag forces.",
			#plan.conflict, #cap.records), { r = 1, g = 0.4, b = 0.4 })
		return lab_result("paste", { outcome = "refused", conflicts = #plan.conflict, targets = #cap.records, offset = offset })
	end

	local recs = {}
	for _, c in ipairs(plan.clear) do recs[#recs + 1] = c.rec end
	local records, entity_map, created, create_failed, exec_ok, exec_err =
		execute_create_and_restore(surface, recs, player, cap.side_groups, true)
	if not exec_ok then
		player.play_sound({ path = "utility/cannot_build" })
		player.print("[SelectionLab] PASTE ROLLED BACK (" .. tostring(exec_err) ..
			") — every created entity was removed; nothing journaled.", { r = 1, g = 0.4, b = 0.4 })
		return lab_result("paste", { outcome = "rolled_back", error = tostring(exec_err), offset = offset })
	end
	for _, rec in ipairs(records) do
		draw_box(surface, rec.position, PLACEABLE_GREEN, player.index)
	end
	push_undo(st, { mode = "paste", surface = surface.name, created = journal_created(records, entity_map),
		destroyed_records = {}, plan_records = recs, side_groups = cap.side_groups })
	-- Single compute, used by BOTH chat and the logged result — they must never diverge.
	local physical_items = physical_census(entity_map)
	local capture_items = capture_item_total(cap.records)
	player.print(string.format(
		"[SelectionLab] PASTED %d entities (%d create-failed) at offset (%d,%d). Physical items on paste: %d (capture holds %d). Ctrl+Alt+Z undoes.",
		created, create_failed, offset.x, offset.y, physical_items, capture_items),
		{ r = 0.4, g = 1, b = 0.4 })
	return lab_result("paste", {
		outcome = "pasted", created = created, create_failed = create_failed, offset = offset,
		physical_items = physical_items, capture_items = capture_items,
	})
end

-- === PREVIEW (dry-run paste) ===============================================================

-- Renders where the capture WOULD land for this drag — green placeable, red conflicted — and
-- creates nothing (owner request 2026-07-18: "a hint of where it would be at"). Uses the same
-- planner as the real paste, so the preview can never disagree with the paste's own verdict.
function SelectionLab.preview(event)
	local player = game.get_player(event.player_index)
	local st = pstate(event.player_index)
	local cap = st.export
	if not (cap and cap.records and #cap.records > 0) then
		player.print("[SelectionLab] nothing copied — plain-drag a source selection first", { r = 1, g = 0.4, b = 0.4 })
		return lab_result("preview", { outcome = "no_capture" })
	end
	local surface = event.surface
	local offset = paste_offset(cap, event)
	local plan = plan_paste(surface, cap, offset, player)
	draw_plan_boxes(surface, plan.clear, PLACEABLE_GREEN, player.index)
	draw_plan_boxes(surface, plan.conflict, CONFLICT_RED, player.index)
	player.print(string.format(
		"[SelectionLab] PREVIEW: %d placeable (green), %d conflicted (red) at offset (%d,%d). Nothing was placed.",
		#plan.clear, #plan.conflict, offset.x, offset.y), { r = 0.6, g = 0.9, b = 1 })
	return lab_result("preview", {
		outcome = "previewed", clear = #plan.clear, conflicts = #plan.conflict, offset = offset,
	})
end

-- === FORCE PASTE ===========================================================================

-- Shared by force and redo. destroyed_records are serialized BEFORE destruction so undo can
-- resurrect blockers with contents. Transactional (review P1): if the create+restore fails,
-- the created entities are rolled back AND the already-destroyed blockers are resurrected
-- best-effort; callers must not journal on failure.
-- Returns records, entity_map, created, create_failed, destroyed_records, guarded, ok, err, resurrected_on_fail.
local function force_execute(surface, recs, player, side_groups)
	local destroyed_records, guarded = {}, 0
	for _, rec in ipairs(recs) do
		if not surface.can_place_entity(place_spec(rec, player)) then
			for _, e in ipairs(surface.find_entities_filtered({ area = footprint_area(rec) })) do
				if e.valid and e.unit_number and e.type ~= "item-entity" then
					if e.type == "character" or e.name == "space-platform-hub" or e.force ~= player.force then
						guarded = guarded + 1
					else
						draw_box(surface, rec.position, CONFLICT_RED, player.index)
						local snapshot = EntityScanner.serialize_entity(e)
						if snapshot then
							-- Lab-only field (like copy()): resurrection must restore the blocker's active
							-- state, or a frozen fixture comes back active and corrupts the measured scene.
							snapshot.lab_active = e.active
							destroyed_records[#destroyed_records + 1] = snapshot
						end
						e.destroy()
					end
				end
			end
		end
	end
	local records, entity_map, created, create_failed, exec_ok, exec_err =
		execute_create_and_restore(surface, recs, player, side_groups, true)
	if not exec_ok then
		local resurrected = 0
		if #destroyed_records > 0 then
			local rrecords = execute_create_and_restore(surface, destroyed_records, player, nil, false)
			resurrected = rrecords and #rrecords or 0
		end
		return nil, nil, created, create_failed, destroyed_records, guarded, false, exec_err, resurrected
	end
	return records, entity_map, created, create_failed, destroyed_records, guarded, true, nil, 0
end

function SelectionLab.force(event)
	local player = game.get_player(event.player_index)
	local st = pstate(event.player_index)
	local cap = st.export
	if not (cap and cap.records and #cap.records > 0) then
		player.print("[SelectionLab] nothing copied — plain-drag a source selection first", { r = 1, g = 0.4, b = 0.4 })
		return lab_result("force", { outcome = "no_capture" })
	end
	local surface = event.surface
	local offset = paste_offset(cap, event)
	local recs = {}
	for _, rec in ipairs(cap.records) do recs[#recs + 1] = translate(rec, offset) end
	local records, entity_map, created, create_failed, destroyed_records, guarded, exec_ok, exec_err, resurrected =
		force_execute(surface, recs, player, cap.side_groups)
	if not exec_ok then
		player.play_sound({ path = "utility/cannot_build" })
		player.print(string.format(
			"[SelectionLab] FORCE ROLLED BACK (%s) — created entities removed, %d/%d replaced blockers resurrected. Nothing journaled.",
			tostring(exec_err), resurrected, #destroyed_records), { r = 1, g = 0.4, b = 0.4 })
		return lab_result("force", {
			outcome = "rolled_back", error = tostring(exec_err),
			blockers_destroyed = #destroyed_records, blockers_resurrected = resurrected, offset = offset,
		})
	end
	push_undo(st, { mode = "force", surface = surface.name, created = journal_created(records, entity_map),
		destroyed_records = destroyed_records, plan_records = recs, side_groups = cap.side_groups })
	local physical_items = physical_census(entity_map)
	player.print(string.format(
		"[SelectionLab] FORCE-PASTED %d entities (%d create-failed, %d blockers replaced%s) at offset (%d,%d). Physical items: %d. Ctrl+Alt+Z undoes (blockers come back with contents).",
		created, create_failed, #destroyed_records,
		guarded > 0 and (", " .. guarded .. " protected blockers kept") or "",
		offset.x, offset.y, physical_items), { r = 0.4, g = 1, b = 0.4 })
	return lab_result("force", {
		outcome = "force_pasted", created = created, create_failed = create_failed,
		blockers_replaced = #destroyed_records, blockers_guarded = guarded,
		offset = offset, physical_items = physical_items,
	})
end

-- === AUDIT (the gate meters, made visible) =================================================

local function fresh_fluid_state()
	return { counted_segments = {}, known_fluid_temps = {}, seg_temps = {}, engine_owned_segments = {} }
end

function SelectionLab.audit(event)
	local player = game.get_player(event.player_index)
	local entity_counts, item_totals, fluid_totals = {}, {}, {}
	local entity_n, item_n, fluid_n = 0, 0, 0
	local fluid_state = fresh_fluid_state()
	for _, e in ipairs(event.entities) do
		if e.valid then
			entity_counts[e.name] = (entity_counts[e.name] or 0) + 1
			entity_n = entity_n + 1
			if e.type == "item-entity" then
				-- Ground items: the same dedicated pass the gate's count_items uses.
				if e.stack and e.stack.valid_for_read then
					local key = Util.make_quality_key(e.stack.name,
						(e.stack.quality and e.stack.quality.name) or Util.QUALITY_NORMAL)
					item_totals[key] = (item_totals[key] or 0) + e.stack.count
					item_n = item_n + e.stack.count
				end
			else
				for key, count in pairs(SurfaceCounter.count_entity_items(e)) do
					item_totals[key] = (item_totals[key] or 0) + count
					item_n = item_n + count
				end
				for key, amount in pairs(SurfaceCounter.count_entity_fluids(e, true, fluid_state)) do
					local name = Util.parse_fluid_temp_key(key)
					fluid_totals[name] = (fluid_totals[name] or 0) + amount
					fluid_n = fluid_n + amount
				end
			end
		end
	end

	player.print(string.format("[SelectionLab] === AUDIT (the transfer gate's own meters) — %d entities, %d items, %.1f fluids ===",
		entity_n, item_n, fluid_n), { r = 1, g = 0.9, b = 0.4 })
	local lines = {}
	for name, n in pairs(entity_counts) do lines[#lines + 1] = n .. "x " .. name end
	table.sort(lines)
	player.print("  entities: " .. (next(entity_counts) and table.concat(lines, ", ") or "none"))
	lines = {}
	for key, n in pairs(item_totals) do lines[#lines + 1] = key .. "=" .. n end
	table.sort(lines)
	player.print("  items: " .. (next(item_totals) and table.concat(lines, ", ") or "none"))
	lines = {}
	for name, amount in pairs(fluid_totals) do lines[#lines + 1] = string.format("%s=%.1f", name, amount) end
	table.sort(lines)
	player.print("  fluids: " .. (next(fluid_totals) and table.concat(lines, ", ") or "none"))

	-- DELTA vs the previous audit (the before/after workflow). Player-scoped.
	local ast = pstate(event.player_index)
	local prev = ast.audit_prev
	if prev then
		local deltas = {}
		local keys = {}
		for k in pairs(prev.items or {}) do keys[k] = true end
		for k in pairs(item_totals) do keys[k] = true end
		for k in pairs(keys) do
			local d = (item_totals[k] or 0) - ((prev.items or {})[k] or 0)
			if d ~= 0 then deltas[#deltas + 1] = string.format("%s %+d", k, d) end
		end
		keys = {}
		for k in pairs(prev.fluids or {}) do keys[k] = true end
		for k in pairs(fluid_totals) do keys[k] = true end
		for k in pairs(keys) do
			local d = (fluid_totals[k] or 0) - ((prev.fluids or {})[k] or 0)
			if math.abs(d) > 1e-6 then deltas[#deltas + 1] = string.format("%s %+.1f", k, d) end
		end
		table.sort(deltas)
		player.print(#deltas > 0
			and ("  DELTA vs previous audit: " .. table.concat(deltas, ", "))
			or "  DELTA vs previous audit: EXACT MATCH (zero drift on every key)",
			#deltas > 0 and { r = 1, g = 0.7, b = 0.3 } or { r = 0.4, g = 1, b = 0.4 })
	end
	ast.audit_prev = { items = item_totals, fluids = fluid_totals, tick = game.tick }

	-- Machine-readable evidence: the audit is an INSTRUMENT (the gate's own meters) — its readings
	-- must land in the log and be returnable to a headless driver, not live only in player chat
	-- (owner gap 2026-07-18: an agent-driven audit had no way to read the result).
	local report = {
		tick = game.tick,
		entity_count = entity_n, item_count = item_n, fluid_total = fluid_n,
		entities = entity_counts, items = item_totals, fluids = fluid_totals,
	}
	log("[SelectionLab][AUDIT-JSON] " .. helpers.table_to_json(report))
	return report
end

-- === UNDO / REDO ===========================================================================

function SelectionLab.undo(event)
	local player = game.get_player(event.player_index)
	if not debug_enabled() then return end
	local st = pstate(event.player_index)
	local stack = st.undo
	local entry = table.remove(stack)
	if not entry then
		player.print("[SelectionLab] nothing to undo", { r = 1, g = 0.6, b = 0.3 })
		return
	end
	local surface = game.surfaces[entry.surface]
	if not surface then player.print("[SelectionLab] undo surface gone", { r = 1, g = 0.4, b = 0.4 }) return end
	local removed, missed = 0, 0
	for _, c in ipairs(entry.created) do
		local hit = nil
		if c.unit_number then
			hit = game.get_entity_by_unit_number(c.unit_number)
			if not (hit and hit.valid) then
				-- fallback: search near the recorded position, match by unit_number ONLY (never by
				-- name+position — that could destroy an unrelated entity placed here after the paste).
				hit = nil
				for _, e in ipairs(surface.find_entities_filtered({ position = c.position, radius = 0.4 })) do
					if e.valid and e.unit_number == c.unit_number then hit = e break end
				end
			end
		end
		if hit and hit.valid then hit.destroy() removed = removed + 1 else missed = missed + 1 end
	end
	local resurrected = 0
	if #entry.destroyed_records > 0 then
		-- best-effort (non-transactional): a resurrection miss must never destroy what DID come back
		local records = execute_create_and_restore(surface, entry.destroyed_records, player, nil, false)
		resurrected = records and #records or 0
	end
	table.insert(st.redo, entry)
	player.print(string.format(
		"[SelectionLab] UNDO: removed %d pasted entities (%d already gone), resurrected %d replaced blockers with contents. Ctrl+Alt+Y redoes.",
		removed, missed, resurrected), { r = 0.4, g = 0.9, b = 1 })
end

function SelectionLab.redo(event)
	local player = game.get_player(event.player_index)
	if not debug_enabled() then return end
	local st = pstate(event.player_index)
	local stack = st.redo
	local entry = table.remove(stack)
	if not entry then
		player.print("[SelectionLab] nothing to redo", { r = 1, g = 0.6, b = 0.3 })
		return
	end
	local surface = game.surfaces[entry.surface]
	if not surface then player.print("[SelectionLab] redo surface gone", { r = 1, g = 0.4, b = 0.4 }) return end
	-- Mode-faithful replay: a plain paste must NEVER escalate to destructive force on redo. Legacy
	-- journal entries (pre-mode) infer their mode from whether they destroyed blockers.
	local mode = entry.mode
		or ((entry.destroyed_records and #entry.destroyed_records > 0) and "force" or "paste")

	if mode == "paste" then
		local plan = plan_targets(surface, entry.plan_records, player)
		if #plan.conflict > 0 then
			for _, c in ipairs(plan.conflict) do
				draw_box(surface, c.rec.position, CONFLICT_RED, player.index)
			end
			player.play_sound({ path = "utility/cannot_build" })
			player.print(string.format(
				"[SelectionLab] REDO REFUSED: %d of %d targets now occupied (red). Nothing re-pasted; still redoable.",
				#plan.conflict, #entry.plan_records), { r = 1, g = 0.4, b = 0.4 })
			table.insert(stack, entry) -- action did not happen → leave on the redo stack
			return
		end
		local recs = {}
		for _, c in ipairs(plan.clear) do recs[#recs + 1] = c.rec end
		local records, entity_map, created, _cf, exec_ok, exec_err =
			execute_create_and_restore(surface, recs, player, entry.side_groups, true)
		if not exec_ok then
			player.play_sound({ path = "utility/cannot_build" })
			player.print("[SelectionLab] REDO ROLLED BACK (" .. tostring(exec_err) .. ") — still redoable.",
				{ r = 1, g = 0.4, b = 0.4 })
			table.insert(stack, entry)
			return
		end
		for _, rec in ipairs(records) do
			draw_box(surface, rec.position, { r = 0.3, g = 1, b = 0.3, a = 0.6 }, player.index)
		end
		entry.created = journal_created(records, entity_map)
		entry.destroyed_records = {}
		table.insert(st.undo, entry)
		player.print(string.format("[SelectionLab] REDO: re-pasted %d entities (all-or-nothing).", created),
			{ r = 0.4, g = 0.9, b = 1 })
	else
		local records, entity_map, created, _create_failed, destroyed_records, guarded, exec_ok, exec_err, resurrected =
			force_execute(surface, entry.plan_records, player, entry.side_groups)
		if not exec_ok then
			player.play_sound({ path = "utility/cannot_build" })
			player.print(string.format(
				"[SelectionLab] REDO ROLLED BACK (%s) — %d/%d replaced blockers resurrected; still redoable.",
				tostring(exec_err), resurrected, #destroyed_records), { r = 1, g = 0.4, b = 0.4 })
			table.insert(stack, entry)
			return
		end
		entry.created = journal_created(records, entity_map)
		entry.destroyed_records = destroyed_records
		table.insert(st.undo, entry)
		player.print(string.format(
			"[SelectionLab] REDO: force re-pasted %d entities (%d blockers replaced%s).",
			created, #destroyed_records, guarded > 0 and (", " .. guarded .. " protected kept") or ""),
			{ r = 0.4, g = 0.9, b = 1 })
	end
end

-- === event router ==========================================================================

function SelectionLab.handle(event, mode)
	-- Diagnostic (owner bug 1: a drag mode arriving silent): log EVERY selection event's routing.
	log(string.format("[SelectionLab] event mode=%s item=%s entities=%d", tostring(mode),
		tostring(event.item), event.entities and #event.entities or -1))
	if event.item ~= "selection-lab-tool" then return end
	if not debug_enabled() then
		local player = game.get_player(event.player_index)
		if player then player.print("[SelectionLab] debug_mode is off — tool disabled", { r = 1, g = 0.4, b = 0.4 }) end
		return
	end
	if mode == "copy" then return SelectionLab.copy(event)
	elseif mode == "paste" then return SelectionLab.paste(event)
	elseif mode == "audit" then return SelectionLab.audit(event)
	elseif mode == "preview" then return SelectionLab.preview(event)
	elseif mode == "force" then return SelectionLab.force(event)
	else
		log("[SelectionLab] unknown mode: " .. tostring(mode))
	end
end

return SelectionLab
