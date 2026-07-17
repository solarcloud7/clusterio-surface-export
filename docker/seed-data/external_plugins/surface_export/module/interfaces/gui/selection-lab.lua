-- Selection Lab v3 — copy/paste-scoped surface export/import + gate-meter audit (debug instrument).
--
-- Owner-specified semantics (v3):
--   COPY   (drag):            EntityScanner.serialize_entity per selected entity + bbox anchor.
--                             RAM only (storage.selection_export); never sent to the controller.
--   PASTE  (shift+drag):      ALL-OR-NOTHING. Every entity target must be unoccupied (same-name
--                             occupants included; ground item-entities and floor tiles never block).
--                             Any conflict: place NOTHING, red-box every conflict, cannot_build sound.
--                             Fully clear: create all + the REAL import restores + undo journal entry.
--   AUDIT  (ctrl+drag):       no mutation, ignores the capture. Runs the REAL transfer-gate meters
--                             (SurfaceCounter.count_entity_items / count_entity_fluids) over the
--                             dragged selection and prints entities/items/fluids totals — plus a
--                             DELTA section vs the previous audit (before/after workflow).
--   FORCE  (ctrl+shift+drag): paste regardless — blockers are serialized (for undo), destroyed
--                             (guards: never characters, never a space-platform-hub, never another
--                             force's entities), then the paste proceeds; overlaps still red-boxed.
--   UNDO / REDO (Ctrl+Shift+Z / Ctrl+Shift+Y custom inputs): journal-based; undo destroys what the
--                             paste created and resurrects force-destroyed blockers WITH contents.
--
-- Debug instrument rules: gated on debug_mode; verdicts print PHYSICAL counts (insert returns are
-- never evidence — tests/belt-lab/NOTEBOOK.md BELT-R8); no interaction with transfer jobs, locks,
-- or the controller. Known gaps: no circuit-wire reconnection on the copy, no rotation/flip.
-- Cross-surface paste measured WORKING at 2.0.77 (2026-07-17, gallery migration): paste plans
-- against event.surface, so dragging on any surface pastes there. `active` is preserved via the
-- lab-only `lab_active` record field (the production serializer deliberately does not carry it).

local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local Deserializer = require("modules/surface_export/core/deserializer")
local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")
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

-- === COPY ==================================================================================

function SelectionLab.copy(event)
	local player = game.get_player(event.player_index)
	local records = {}
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
				minx = math.min(minx, entity_data.position.x)
				miny = math.min(miny, entity_data.position.y)
			end
		end
	end
	if #records == 0 then
		player.print("[SelectionLab] nothing exportable in the selection", { r = 1, g = 0.6, b = 0.3 })
		return
	end
	storage.selection_export = {
		records = records,
		anchor = { x = math.floor(minx), y = math.floor(miny) },
		surface = event.surface.name,
		tick = game.tick,
	}
	player.print(string.format(
		"[SelectionLab] COPIED %d entities (%d items). Shift-drag = paste (all-or-nothing); Ctrl+Shift-drag = force.",
		#records, capture_item_total(records)), { r = 0.4, g = 0.9, b = 1 })
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

-- v3 plan: every target either placeable or conflicted. Same-name occupants ARE conflicts;
-- ground item-entities and tiles never block (can_place_entity ignores loose items).
local function plan_paste(surface, cap, offset, player)
	local plan = { clear = {}, conflict = {} }
	for _, rec in ipairs(cap.records) do
		local t = translate(rec, offset)
		local placeable = surface.can_place_entity({
			name = t.name, position = t.position, direction = t.direction,
			force = t.force or (player and player.force) or "player",
		})
		if placeable then
			plan.clear[#plan.clear + 1] = { rec = t }
		else
			local blockers = {}
			for _, e in ipairs(surface.find_entities_filtered({
				area = { { t.position.x - 0.5, t.position.y - 0.5 }, { t.position.x + 0.5, t.position.y + 0.5 } },
			})) do
				if e.valid and e.unit_number and e.type ~= "item-entity" then blockers[#blockers + 1] = e end
			end
			plan.conflict[#plan.conflict + 1] = { rec = t, blockers = blockers }
		end
	end
	return plan
end

-- Create all records + run the REAL import restores (production phase order).
-- Returns records, entity_map, created, create_failed.
local function execute_create_and_restore(surface, recs, player)
	local records, entity_map = {}, {}
	local created, create_failed = 0, 0
	for _, rec in ipairs(recs) do
		local spec = {
			name = rec.name, position = rec.position, direction = rec.direction,
			force = rec.force or player.force, quality = rec.quality, raise_built = false,
		}
		if rec.specific_data and rec.specific_data.belt_to_ground_type then
			spec.type = rec.specific_data.belt_to_ground_type
		end
		local ok, entity = pcall(function() return surface.create_entity(spec) end)
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
	BeltRestoration.restore(records, entity_map)
	for _, rec in ipairs(records) do
		local entity = entity_map[rec.entity_id]
		if entity and entity.valid then
			Deserializer.restore_entity_state(entity, rec)
			Deserializer.restore_inventories(entity, rec)
		end
	end
	local fluids_ok, fluids_err = pcall(function() FluidRestoration.restore(records, entity_map) end)
	if not fluids_ok then
		log("[SelectionLab] fluid restore failed: " .. tostring(fluids_err))
		player.print("[SelectionLab] fluid restore skipped: " .. tostring(fluids_err), { r = 1, g = 0.7, b = 0.3 })
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
	return records, entity_map, created, create_failed
end

local function push_undo(entry)
	storage.selection_lab_undo = storage.selection_lab_undo or {}
	local stack = storage.selection_lab_undo
	stack[#stack + 1] = entry
	while #stack > UNDO_DEPTH do table.remove(stack, 1) end
	storage.selection_lab_redo = {}
end

local function journal_created(records)
	local created = {}
	for _, rec in ipairs(records) do
		created[#created + 1] = { name = rec.name, position = { x = rec.position.x, y = rec.position.y } }
	end
	return created
end

-- === PASTE (all-or-nothing) ================================================================

function SelectionLab.paste(event)
	local player = game.get_player(event.player_index)
	local cap = storage.selection_export
	if not (cap and cap.records and #cap.records > 0) then
		player.print("[SelectionLab] nothing copied — plain-drag a source selection first", { r = 1, g = 0.4, b = 0.4 })
		return
	end
	local surface = event.surface
	local offset = paste_offset(cap, event)
	local plan = plan_paste(surface, cap, offset, player)

	if #plan.conflict > 0 then
		for _, c in ipairs(plan.conflict) do
			draw_box(surface, c.rec.position, { r = 1, g = 0.2, b = 0.2, a = 0.9 }, player.index)
		end
		player.play_sound({ path = "utility/cannot_build" })
		player.print(string.format(
			"[SelectionLab] PASTE REFUSED: %d of %d targets occupied (red). Nothing was placed. Ctrl+Shift-drag forces.",
			#plan.conflict, #cap.records), { r = 1, g = 0.4, b = 0.4 })
		return
	end

	local recs = {}
	for _, c in ipairs(plan.clear) do recs[#recs + 1] = c.rec end
	local records, entity_map, created, create_failed = execute_create_and_restore(surface, recs, player)
	for _, rec in ipairs(records) do
		draw_box(surface, rec.position, { r = 0.3, g = 1, b = 0.3, a = 0.6 }, player.index)
	end
	push_undo({ surface = surface.name, created = journal_created(records), destroyed_records = {}, plan_records = recs })
	player.print(string.format(
		"[SelectionLab] PASTED %d entities (%d create-failed) at offset (%d,%d). Physical items on paste: %d (capture holds %d). Ctrl+Shift+Z undoes.",
		created, create_failed, offset.x, offset.y, physical_census(entity_map), capture_item_total(cap.records)),
		{ r = 0.4, g = 1, b = 0.4 })
end

-- === FORCE PASTE ===========================================================================

-- Shared by force and redo. destroyed_records are serialized BEFORE destruction so undo can
-- resurrect blockers with contents.
local function force_execute(surface, recs, player)
	local destroyed_records, guarded = {}, 0
	for _, rec in ipairs(recs) do
		if not surface.can_place_entity({
			name = rec.name, position = rec.position, direction = rec.direction,
			force = rec.force or player.force,
		}) then
			for _, e in ipairs(surface.find_entities_filtered({
				area = { { rec.position.x - 0.5, rec.position.y - 0.5 }, { rec.position.x + 0.5, rec.position.y + 0.5 } },
			})) do
				if e.valid and e.unit_number and e.type ~= "item-entity" then
					if e.type == "character" or e.name == "space-platform-hub" or e.force ~= player.force then
						guarded = guarded + 1
					else
						draw_box(surface, rec.position, { r = 1, g = 0.2, b = 0.2, a = 0.9 }, player.index)
						local snapshot = EntityScanner.serialize_entity(e)
						if snapshot then destroyed_records[#destroyed_records + 1] = snapshot end
						e.destroy()
					end
				end
			end
		end
	end
	local records, entity_map, created, create_failed = execute_create_and_restore(surface, recs, player)
	return records, entity_map, created, create_failed, destroyed_records, guarded
end

function SelectionLab.force(event)
	local player = game.get_player(event.player_index)
	local cap = storage.selection_export
	if not (cap and cap.records and #cap.records > 0) then
		player.print("[SelectionLab] nothing copied — plain-drag a source selection first", { r = 1, g = 0.4, b = 0.4 })
		return
	end
	local surface = event.surface
	local offset = paste_offset(cap, event)
	local recs = {}
	for _, rec in ipairs(cap.records) do recs[#recs + 1] = translate(rec, offset) end
	local records, entity_map, created, create_failed, destroyed_records, guarded =
		force_execute(surface, recs, player)
	push_undo({ surface = surface.name, created = journal_created(records),
		destroyed_records = destroyed_records, plan_records = recs })
	player.print(string.format(
		"[SelectionLab] FORCE-PASTED %d entities (%d create-failed, %d blockers replaced%s) at offset (%d,%d). Physical items: %d. Ctrl+Shift+Z undoes (blockers come back with contents).",
		created, create_failed, #destroyed_records,
		guarded > 0 and (", " .. guarded .. " protected blockers kept") or "",
		offset.x, offset.y, physical_census(entity_map)), { r = 0.4, g = 1, b = 0.4 })
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

	-- DELTA vs the previous audit (the before/after workflow).
	local prev = storage.selection_lab_audit_prev
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
	storage.selection_lab_audit_prev = { items = item_totals, fluids = fluid_totals, tick = game.tick }
end

-- === UNDO / REDO ===========================================================================

function SelectionLab.undo(event)
	local player = game.get_player(event.player_index)
	if not debug_enabled() then return end
	local stack = storage.selection_lab_undo or {}
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
		for _, e in ipairs(surface.find_entities_filtered({ position = c.position, radius = 0.4, name = c.name })) do
			if e.valid then hit = e break end
		end
		if hit then hit.destroy() removed = removed + 1 else missed = missed + 1 end
	end
	local resurrected = 0
	if #entry.destroyed_records > 0 then
		local records = execute_create_and_restore(surface, entry.destroyed_records, player)
		resurrected = #records
	end
	storage.selection_lab_redo = storage.selection_lab_redo or {}
	table.insert(storage.selection_lab_redo, entry)
	player.print(string.format(
		"[SelectionLab] UNDO: removed %d pasted entities (%d already gone), resurrected %d replaced blockers with contents. Ctrl+Shift+Y redoes.",
		removed, missed, resurrected), { r = 0.4, g = 0.9, b = 1 })
end

function SelectionLab.redo(event)
	local player = game.get_player(event.player_index)
	if not debug_enabled() then return end
	local stack = storage.selection_lab_redo or {}
	local entry = table.remove(stack)
	if not entry then
		player.print("[SelectionLab] nothing to redo", { r = 1, g = 0.6, b = 0.3 })
		return
	end
	local surface = game.surfaces[entry.surface]
	if not surface then player.print("[SelectionLab] redo surface gone", { r = 1, g = 0.4, b = 0.4 }) return end
	local records, entity_map, created, create_failed, destroyed_records, guarded =
		force_execute(surface, entry.plan_records, player)
	entry.created = journal_created(records)
	entry.destroyed_records = destroyed_records
	storage.selection_lab_undo = storage.selection_lab_undo or {}
	table.insert(storage.selection_lab_undo, entry)
	player.print(string.format(
		"[SelectionLab] REDO: re-pasted %d entities (%d blockers replaced%s).",
		created, #destroyed_records, guarded > 0 and (", " .. guarded .. " protected kept") or ""),
		{ r = 0.4, g = 0.9, b = 1 })
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
	if mode == "copy" then SelectionLab.copy(event)
	elseif mode == "paste" then SelectionLab.paste(event)
	elseif mode == "audit" then SelectionLab.audit(event)
	elseif mode == "force" then SelectionLab.force(event)
	else
		log("[SelectionLab] unknown mode: " .. tostring(mode))
	end
end

return SelectionLab
