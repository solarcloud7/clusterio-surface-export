-- Selection Lab v2 — COPY/PASTE-scoped surface export/import (debug instrument).
--
-- Copy a chunk at spot A, paste it at spot B on the SAME surface — entities + ALL contents (belt
-- items with positions, inventories, fluids, state, quality) — so a human can stand between the
-- original and the copy and visually diff them. That is a transfer simulation: A = export,
-- B = import, run through the REAL production pipeline both ways:
--   COPY   (select):        EntityScanner.serialize_entity per selected entity + a bbox anchor.
--                           RAM only (storage.selection_export); never sent to the controller.
--   PASTE  (alt):           translate records by the integer tile offset (drag box min-corner −
--                           capture anchor), create entities, then the real import restores.
--                           Conflicts are SKIPPED + red-highlighted — never destroyed.
--   PREVIEW (reverse):      no mutation; red boxes where a paste at the drag target would conflict.
--   FORCE  (alt-reverse):   the override — destroys conflicting entities (guarded: never characters,
--                           never another force's entities, never a space-platform-hub), then pastes.
-- Paste over the ORIGINAL footprint (offset 0) restores in place — the v1 lab loop still exists.
--
-- Debug instrument rules: every handler gated on debug_mode; verdicts print PHYSICAL counts
-- (insert/return values are never evidence — tests/belt-lab/NOTEBOOK.md BELT-R8); nothing here
-- touches transfer jobs, locks, or the controller. v2 known gaps (by design): no circuit-wire
-- reconnection on the copy, no rotation/flip, no cross-surface paste.

local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local Deserializer = require("modules/surface_export/core/deserializer")
local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")
local FluidRestoration = require("modules/surface_export/import_phases/fluid_restoration")

local SelectionLab = {}

local HIGHLIGHT_TTL = 60 * 8

local function debug_enabled()
	return storage.surface_export_config and storage.surface_export_config.debug_mode == true
end

-- Physical item census over a set of live entities (the same complete meter the gate trusts).
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
		"[SelectionLab] COPIED %d entities (%d items in capture). Shift-drag a target area to paste; Ctrl-drag to preview.",
		#records, capture_item_total(records)), { r = 0.4, g = 0.9, b = 1 })
end

-- === shared paste planning =================================================================

-- Integer tile offset from the capture anchor to the drag box's min corner.
local function paste_offset(cap, event)
	local lt = event.area and event.area.left_top or nil
	if not lt then return { x = 0, y = 0 } end
	return { x = math.floor(lt.x) - cap.anchor.x, y = math.floor(lt.y) - cap.anchor.y }
end

-- Shallow-copy a record with a translated position. specific_data is SHARED (restores only read
-- it); position must be a fresh table so repeat pastes never mutate the stored capture.
local function translate(rec, offset)
	local copy = {}
	for k, v in pairs(rec) do copy[k] = v end
	copy.position = { x = rec.position.x + offset.x, y = rec.position.y + offset.y }
	return copy
end

-- Classify each translated record's landing spot:
--   match    — same-name entity already there (restore into it; offset-0 in-place loop)
--   clear    — placeable
--   conflict — something else in the way (blockers listed for highlight/force)
local function plan_paste(surface, cap, offset, player)
	local plan = { match = {}, clear = {}, conflict = {} }
	for _, rec in ipairs(cap.records) do
		local t = translate(rec, offset)
		local same = nil
		for _, e in ipairs(surface.find_entities_filtered({ position = t.position, radius = 0.4 })) do
			if e.valid and e.name == t.name then same = e break end
		end
		if same then
			plan.match[#plan.match + 1] = { rec = t, entity = same }
		else
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
					if e.valid and e.unit_number and e.name ~= t.name then blockers[#blockers + 1] = e end
				end
				plan.conflict[#plan.conflict + 1] = { rec = t, blockers = blockers }
			end
		end
	end
	return plan
end

local function highlight_plan(surface, plan, player_index, with_clear)
	for _, c in ipairs(plan.conflict) do
		draw_box(surface, c.rec.position, { r = 1, g = 0.2, b = 0.2, a = 0.9 }, player_index)
	end
	if with_clear then
		for _, c in ipairs(plan.clear) do
			draw_box(surface, c.rec.position, { r = 0.3, g = 1, b = 0.3, a = 0.5 }, player_index)
		end
	end
end

-- Create + restore the plan's clear/match sets through the REAL import pipeline.
-- Returns records, entity_map, created, create_failed.
local function execute_paste(surface, plan, player)
	local records, entity_map = {}, {}
	local created, create_failed = 0, 0
	for _, m in ipairs(plan.match) do
		records[#records + 1] = m.rec
		entity_map[m.rec.entity_id] = m.entity
	end
	for _, m in ipairs(plan.clear) do
		local spec = {
			name = m.rec.name, position = m.rec.position, direction = m.rec.direction,
			force = m.rec.force or player.force, quality = m.rec.quality, raise_built = false,
		}
		-- Underground belts need their input/output half at creation time.
		if m.rec.specific_data and m.rec.specific_data.belt_to_ground_type then
			spec.type = m.rec.specific_data.belt_to_ground_type
		end
		local ok, entity = pcall(function() return surface.create_entity(spec) end)
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

	-- The real import restores, production phase order: belts -> state -> inventories -> fluids.
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
	return records, entity_map, created, create_failed
end

local function paste_common(event, force_mode)
	local player = game.get_player(event.player_index)
	local cap = storage.selection_export
	if not (cap and cap.records and #cap.records > 0) then
		player.print("[SelectionLab] nothing copied — plain-drag a source selection first", { r = 1, g = 0.4, b = 0.4 })
		return
	end
	local surface = event.surface
	local offset = paste_offset(cap, event)
	local plan = plan_paste(surface, cap, offset, player)

	local destroyed = 0
	if force_mode and #plan.conflict > 0 then
		-- The override: clear the blockers, then re-plan those spots as placeable.
		for _, c in ipairs(plan.conflict) do
			local blocked = false
			for _, blocker in ipairs(c.blockers) do
				if blocker.valid then
					-- Guards: never characters, never another force's entities, never a platform hub.
					if blocker.type == "character" or blocker.name == "space-platform-hub"
						or blocker.force ~= player.force then
						blocked = true
					else
						blocker.destroy()
						destroyed = destroyed + 1
					end
				end
			end
			if not blocked then plan.clear[#plan.clear + 1] = { rec = c.rec } end
		end
		plan.conflict = {}
		plan = plan -- conflicts either cleared into clear[] or dropped with a guard note
	end

	highlight_plan(surface, plan, player.index, false)
	local records, entity_map, created, create_failed = execute_paste(surface, plan, player)
	local pasted_physical = physical_census(entity_map)
	local expected = capture_item_total(cap.records)

	rendering.draw_text({
		text = string.format("pasted %d entities / %d items", #records, pasted_physical),
		surface = surface, target = { cap.anchor.x + offset.x, cap.anchor.y + offset.y - 1 },
		color = { r = 0.5, g = 1, b = 0.5 }, scale = 1.4, time_to_live = HIGHLIGHT_TTL,
		players = { player.index },
	})
	player.print(string.format(
		"[SelectionLab] %s at offset (%d,%d): %d records (%d in place, %d created, %d create-failed, %d conflicts%s%s). Physical items on paste: %d (capture holds %d).",
		force_mode and "FORCE-PASTED" or "PASTED", offset.x, offset.y,
		#records, #plan.match, created, create_failed, #plan.conflict,
		#plan.conflict > 0 and " skipped+highlighted" or "",
		destroyed > 0 and (", " .. destroyed .. " blockers destroyed") or "",
		pasted_physical, expected),
		{ r = 0.4, g = 1, b = 0.4 })
end

-- === mode handlers =========================================================================

function SelectionLab.paste(event) paste_common(event, false) end
function SelectionLab.force(event) paste_common(event, true) end

function SelectionLab.preview(event)
	local player = game.get_player(event.player_index)
	local cap = storage.selection_export
	if not (cap and cap.records and #cap.records > 0) then
		player.print("[SelectionLab] nothing copied — plain-drag a source selection first", { r = 1, g = 0.4, b = 0.4 })
		return
	end
	local offset = paste_offset(cap, event)
	local plan = plan_paste(event.surface, cap, offset, player)
	highlight_plan(event.surface, plan, player.index, true)
	player.print(string.format(
		"[SelectionLab] PREVIEW at offset (%d,%d): %d would restore in place, %d would be created (green), %d CONFLICTS (red). Shift-drag pastes; Ctrl+Shift-drag forces.",
		offset.x, offset.y, #plan.match, #plan.clear, #plan.conflict),
		#plan.conflict > 0 and { r = 1, g = 0.7, b = 0.3 } or { r = 0.4, g = 1, b = 0.4 })
end

-- === event router ==========================================================================

function SelectionLab.handle(event, mode)
	if event.item ~= "selection-lab-tool" then return end
	if not debug_enabled() then
		local player = game.get_player(event.player_index)
		if player then player.print("[SelectionLab] debug_mode is off — tool disabled", { r = 1, g = 0.4, b = 0.4 }) end
		return
	end
	if mode == "copy" then SelectionLab.copy(event)
	elseif mode == "paste" then SelectionLab.paste(event)
	elseif mode == "preview" then SelectionLab.preview(event)
	elseif mode == "force" then SelectionLab.force(event)
	else
		log("[SelectionLab] unknown mode: " .. tostring(mode))
	end
end

return SelectionLab
