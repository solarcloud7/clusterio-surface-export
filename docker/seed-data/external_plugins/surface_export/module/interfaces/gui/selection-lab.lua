-- Selection Lab — selection-scoped surface export/import (debug instrument).
--
-- The full transfer pipeline, scoped to a drag selection instead of a whole surface:
--   CAPTURE (select):  EntityScanner.serialize_entity per selected entity — the REAL export path
--                      (handlers, inventories, fluids, common state; belt lanes inline — one Lua
--                      execution, so the selection snapshot is atomic like the production belt scan).
--                      Stored in storage.selection_export (RAM only; never sent to the controller).
--   APPLY (alt):       the REAL import restores, in place, same surface/instance: match each record
--                      by position+name; create missing entities; then BeltRestoration.restore +
--                      Deserializer.restore_entity_state + restore_inventories + FluidRestoration
--                      over the matched set. A DIFFERENT entity on a captured tile is never
--                      destroyed — it is skipped and highlighted red.
--   PREVIEW (reverse): no mutation; highlights ONLY the blocks an apply would conflict with.
--   CLEAR (alt-rev):   wipes the selected belts' transport lanes (the practice-loop reset).
--
-- Debug instrument rules: every handler is gated on debug_mode; verdicts print PHYSICAL
-- before/after counts (insert/return values are never evidence — tests/belt-lab/NOTEBOOK.md BELT-R8);
-- nothing here touches transfer jobs, locks, or the controller.

local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local Deserializer = require("modules/surface_export/core/deserializer")
local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")
local FluidRestoration = require("modules/surface_export/import_phases/fluid_restoration")

local SelectionLab = {}

local function debug_enabled()
	return storage.surface_export_config and storage.surface_export_config.debug_mode == true
end

local function pos_key(name, position)
	return string.format("%s@%.2f,%.2f", name, position.x, position.y)
end

-- Whole-selection physical item census (entities' get_item_count over every contained item —
-- the same complete physical meter the transfer gate trusts).
local function physical_census(entities)
	local total = 0
	for _, e in ipairs(entities) do
		if e.valid then
			-- intentional probe; failure expected on entity classes without item counts, no log
			local ok, contents = pcall(function() return e.get_item_count() end)
			if ok and type(contents) == "number" then total = total + contents end
		end
	end
	return total
end

-- entity_map variant of the census (apply's targets are keyed, not listed).
local function physical_census_map(entity_map)
	local total = 0
	for _, e in pairs(entity_map) do
		if e.valid then
			-- intentional probe; failure expected on entity classes without item counts, no log
			local ok, n = pcall(function() return e.get_item_count() end)
			if ok and type(n) == "number" then total = total + n end
		end
	end
	return total
end

-- === CAPTURE ===============================================================================

function SelectionLab.capture(event)
	local player = game.get_player(event.player_index)
	local records = {}
	for _, entity in ipairs(event.entities) do
		if entity.valid and EntityScanner.is_exportable_entity(entity) then
			local entity_data = EntityScanner.serialize_entity(entity)
			if entity_data then
				records[#records + 1] = entity_data
			end
		end
	end
	storage.selection_export = {
		records = records,
		surface = event.surface.name,
		tick = game.tick,
	}
	local phys = physical_census(event.entities)
	player.print(string.format(
		"[SelectionLab] CAPTURED %d entities (physical census: %d items) at tick %d — RAM only. Alt-drag applies; Ctrl-drag previews conflicts.",
		#records, phys, game.tick), { r = 0.4, g = 0.9, b = 1 })
end

-- === conflict scan (shared by PREVIEW and APPLY) ===========================================

-- For each captured record: 'match' (same-name entity on its tile), 'empty', or 'conflict'
-- (a DIFFERENT entity occupies the spot). Ghosts/item-entities never count as conflicts.
local function classify(surface, records)
	local out = { match = {}, empty = {}, conflict = {} }
	for _, rec in ipairs(records) do
		local found = surface.find_entities_filtered({
			position = rec.position, radius = 0.4,
		})
		local same, other = nil, nil
		for _, e in ipairs(found) do
			if e.valid and e.unit_number then
				if e.name == rec.name then same = e
				elseif e.type ~= "entity-ghost" and e.type ~= "item-entity" then other = e end
			end
		end
		if same then out.match[#out.match + 1] = { rec = rec, entity = same }
		elseif other then out.conflict[#out.conflict + 1] = { rec = rec, entity = other }
		else out.empty[#out.empty + 1] = { rec = rec } end
	end
	return out
end

local function highlight_conflicts(surface, conflicts, player)
	for _, c in ipairs(conflicts) do
		rendering.draw_rectangle({
			color = { r = 1, g = 0.2, b = 0.2, a = 0.9 },
			width = 3,
			filled = false,
			left_top = { c.rec.position.x - 0.5, c.rec.position.y - 0.5 },
			right_bottom = { c.rec.position.x + 0.5, c.rec.position.y + 0.5 },
			surface = surface,
			time_to_live = 60 * 10,
			players = { player.index },
		})
	end
end

-- === PREVIEW ===============================================================================

function SelectionLab.preview(event)
	local player = game.get_player(event.player_index)
	local cap = storage.selection_export
	if not (cap and cap.records and #cap.records > 0) then
		player.print("[SelectionLab] nothing captured — plain-drag a selection first", { r = 1, g = 0.4, b = 0.4 })
		return
	end
	local classes = classify(event.surface, cap.records)
	highlight_conflicts(event.surface, classes.conflict, player)
	player.print(string.format(
		"[SelectionLab] PREVIEW: %d in-place matches, %d empty tiles (would create), %d CONFLICTS (highlighted red — an apply skips these, never destroys)",
		#classes.match, #classes.empty, #classes.conflict),
		#classes.conflict > 0 and { r = 1, g = 0.7, b = 0.3 } or { r = 0.4, g = 1, b = 0.4 })
end

-- === APPLY =================================================================================

function SelectionLab.apply(event)
	local player = game.get_player(event.player_index)
	local cap = storage.selection_export
	if not (cap and cap.records and #cap.records > 0) then
		player.print("[SelectionLab] nothing captured — plain-drag a selection first", { r = 1, g = 0.4, b = 0.4 })
		return
	end
	local surface = event.surface
	local classes = classify(surface, cap.records)
	highlight_conflicts(surface, classes.conflict, player)

	-- Build the (records, entity_map) pair the real import phases consume.
	local records, entity_map = {}, {}
	local created, create_failed = 0, 0
	for _, m in ipairs(classes.match) do
		records[#records + 1] = m.rec
		entity_map[m.rec.entity_id] = m.entity
	end
	for _, m in ipairs(classes.empty) do
		local ok, entity = pcall(function()
			return surface.create_entity({
				name = m.rec.name,
				position = m.rec.position,
				direction = m.rec.direction,
				force = m.rec.force or "player",
				quality = m.rec.quality,
				raise_built = false,
			})
		end)
		if ok and entity then
			created = created + 1
			records[#records + 1] = m.rec
			entity_map[m.rec.entity_id] = entity
		else
			create_failed = create_failed + 1
			log(string.format("[SelectionLab] create_entity failed for %s at (%.1f,%.1f): %s",
				m.rec.name, m.rec.position.x, m.rec.position.y, ok and "returned nil" or tostring(entity)))
		end
	end

	-- Expected = what the capture physically counted for these records (serialized-side census).
	-- The REAL import restores, in the production phase order: belts -> state -> inventories -> fluids.
	local before = physical_census_map(entity_map)
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
	local after = physical_census_map(entity_map)

	player.print(string.format(
		"[SelectionLab] APPLIED %d records (%d matched in place, %d created, %d create-failed, %d conflicts skipped). Physical items across targets: %d -> %d.",
		#records, #classes.match, created, create_failed, #classes.conflict, before, after),
		{ r = 0.4, g = 1, b = 0.4 })
	if #classes.conflict > 0 then
		player.print("[SelectionLab] conflicts were highlighted red and left untouched", { r = 1, g = 0.5, b = 0.5 })
	end
end

-- === CLEAR (belt lanes) ====================================================================

function SelectionLab.clear_lanes(event)
	local player = game.get_player(event.player_index)
	local n = 0
	for _, b in ipairs(event.entities) do
		if b.valid and b.get_transport_line then
			for li = 1, b.get_max_transport_line_index() do
				local line = b.get_transport_line(li)
				n = n + line.get_item_count()
				line.clear()
			end
		end
	end
	player.print("[SelectionLab] CLEARED " .. n .. " items from selected belt lanes", { r = 1, g = 0.6, b = 0.3 })
end

-- === event router ==========================================================================

--- Route a selection event to its handler iff it is our tool and debug_mode is on.
function SelectionLab.handle(event, mode)
	if event.item ~= "selection-lab-tool" then return end
	if not debug_enabled() then
		local player = game.get_player(event.player_index)
		if player then player.print("[SelectionLab] debug_mode is off — tool disabled", { r = 1, g = 0.4, b = 0.4 }) end
		return
	end
	if mode == "capture" then SelectionLab.capture(event)
	elseif mode == "apply" then SelectionLab.apply(event)
	elseif mode == "preview" then SelectionLab.preview(event)
	elseif mode == "clear" then SelectionLab.clear_lanes(event) end
end

return SelectionLab
