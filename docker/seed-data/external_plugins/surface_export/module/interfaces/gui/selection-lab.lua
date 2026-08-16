local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local Deserializer = require("modules/surface_export/core/deserializer")
local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")
local EntityStateRestoration = require("modules/surface_export/import_phases/entity_state_restoration")
local ActiveStateRestoration = require("modules/surface_export/import_phases/active_state_restoration")
local FluidRestoration = require("modules/surface_export/import_phases/fluid_restoration")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local FluidRegistry = require("modules/surface_export/export_scanners/fluid-registry")
local SurfaceCounter = require("modules/surface_export/validators/surface-counter")
local Util = require("modules/surface_export/utils/util")

local SelectionLab = {}

local HIGHLIGHT_TTL = 60 * 8
local UNDO_DEPTH = 10

local quiet = false
function SelectionLab.set_quiet(value)
	quiet = value == true
end

local function say(player, message, color)
	if not quiet and player then player.print(message, color) end
end

local function event_player(event)
	local idx = event.player_index
	return (idx and idx >= 1) and game.get_player(idx) or nil
end

local LAB_PREFIX = "[color=yellow][font=default-bold][SelectionLab][/font][/color]"

local function icon_item(key, count)
	local name, quality = Util.parse_quality_key(key)
	if quality and quality ~= "normal" then
		return string.format("[img=item.%s][img=quality.%s]x%s", name, quality, count)
	end
	return string.format("[img=item.%s]x%s", name, count)
end

local function icon_entity(name, count)
	return string.format("[img=entity.%s]x%s", name, count)
end

local function icon_fluid(key, amount)
	local name = key:match("^([^@]+)") or key
	return string.format("[img=fluid.%s]x%.1f", name, amount)
end

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
		if rec.type == "item-on-ground" then total = total + (rec.count or 0) end
		local sd = rec.specific_data
		if sd then
			for _, inv in ipairs(sd.inventories or {}) do
				for _, item in ipairs(inv.items or {}) do total = total + (item.count or 0) end
			end
			for _, line_data in ipairs(sd.items or {}) do
				for _, item in ipairs(line_data.items or {}) do total = total + (item.count or 0) end
			end
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

local CONFLICT_RED = { r = 1, g = 0.2, b = 0.2, a = 0.9 }
local PLACEABLE_GREEN = { r = 0.3, g = 1, b = 0.3, a = 0.6 }

local function draw_plan_boxes(surface, plan_list, color, player_index)
	for _, c in ipairs(plan_list) do
		draw_box(surface, c.rec.position, color, player_index)
	end
end

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

local function paste_touches_live_fluid_network(entity_map)
	local pasted = {}
	for _, e in pairs(entity_map) do
		if e and e.valid and e.unit_number then pasted[e.unit_number] = true end
	end
	for _, e in pairs(entity_map) do
		if e and e.valid then
			local ok, per_box = pcall(function() return e.fluidbox_neighbours end)
			if not ok then
				log("[SelectionLab] fluid neighbour probe failed: " .. tostring(per_box))
				return true
			end
			for _, neighbours in ipairs(per_box or {}) do
				for _, owner in ipairs(neighbours or {}) do
					if owner and owner.valid and owner.unit_number and not pasted[owner.unit_number] then
						return true
					end
				end
			end
		end
	end
	return false
end

local BELT_LINE_TYPES = Util.BELT_ENTITY_TYPES

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

local function lab_result(mode, result)
	log("[SelectionLab][" .. string.upper(mode) .. "-JSON] " .. helpers.table_to_json(result))
	return result
end


function SelectionLab.copy(event)
	local player = event_player(event)
	local records = {}
	local belt_pairs = {}
	local minx, miny = math.huge, math.huge
	local fluid_registry = FluidRegistry.new()
	InventoryScanner.fluid_registry = fluid_registry
	local copy_ok, copy_err = pcall(function()
	for _, entity in ipairs(event.entities) do
		if entity.valid and entity.type == "item-entity" and entity.stack and entity.stack.valid_for_read then
			local stack = entity.stack
			records[#records + 1] = {
				type = "item-on-ground",
				entity_id = "ground-" .. (#records + 1),
				name = stack.name,
				count = stack.count,
				position = { x = entity.position.x, y = entity.position.y },
				quality = stack.quality and stack.quality.name or Util.QUALITY_NORMAL,
			}
			minx = math.min(minx, entity.position.x)
			miny = math.min(miny, entity.position.y)
		elseif entity.valid and EntityScanner.is_exportable_entity(entity) then
			local entity_data = EntityScanner.serialize_entity(entity)
			if entity_data then
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
	end)
	InventoryScanner.fluid_registry = nil
	if not copy_ok then error(copy_err) end
	if #records == 0 then
		say(player, "[color=yellow][font=default-bold][SelectionLab][/font][/color] nothing exportable in the selection", { r = 1, g = 0.6, b = 0.3 })
		return lab_result("copy", { outcome = "nothing_exportable", selected = #event.entities })
	end
	local side_groups = BeltRestoration.capture_side_groups(belt_pairs)
	local lt = event.area and event.area.left_top or nil
	local anchor = lt and { x = math.floor(lt.x), y = math.floor(lt.y) }
		or { x = math.floor(minx), y = math.floor(miny) }
	local st = pstate(event.player_index)
	st.export = {
		records = records,
		side_groups = side_groups,
		fluid_segments = FluidRegistry.list(fluid_registry),
		anchor = anchor,
		surface = event.surface.name,
		tick = game.tick,
	}
	if st.copy_box then
		local prior = rendering.get_object_by_id(st.copy_box)
		if prior and prior.valid then prior.destroy() end
		st.copy_box = nil
	end
	if event.area and player then
		st.copy_box = rendering.draw_rectangle({
			color = { r = 0.3, g = 0.6, b = 1, a = 0.8 }, width = 2, filled = false,
			left_top = event.area.left_top, right_bottom = event.area.right_bottom,
			surface = event.surface, players = { event.player_index },
		}).id
	end
	local item_total = capture_item_total(records)
	say(player, string.format(
		"[color=yellow][font=default-bold][SelectionLab][/font][/color] COPIED %d entities (%d items%s). Shift-drag = paste (all-or-nothing); Shift+Right-drag = force.",
		#records, item_total,
		side_groups and (", " .. #side_groups .. " belt sides") or ""), { r = 0.4, g = 0.9, b = 1 })
	return lab_result("copy", {
		outcome = "copied", records = #records, item_total = item_total,
		belt_sides = side_groups and #side_groups or 0, anchor = anchor, surface = event.surface.name,
	})
end


local function paste_offset(cap, event)
	local lt = event.area and event.area.left_top or nil
	if not lt then return { x = 0, y = 0 } end
	return { x = math.floor(lt.x) - cap.anchor.x, y = math.floor(lt.y) - cap.anchor.y }
end

local function translate(rec, offset)
	local copy = {}
	for k, v in pairs(rec) do copy[k] = v end
	copy.position = { x = rec.position.x + offset.x, y = rec.position.y + offset.y }
	local sd = rec.specific_data
	if sd and sd.target_position then
		copy.specific_data = {}
		for k, v in pairs(sd) do copy.specific_data[k] = v end
		copy.specific_data.target_position = {
			x = sd.target_position.x + offset.x,
			y = sd.target_position.y + offset.y,
		}
	end
	return copy
end

local UNBLOCKABLE_RECORD_TYPES = { ["item-request-proxy"] = true, ["item-on-ground"] = true }

local function blocking_entities(surface, rec)
	if UNBLOCKABLE_RECORD_TYPES[rec.type] then return {} end
	local blockers = {}
	for _, e in ipairs(surface.find_entities_filtered({ area = footprint_area(rec) })) do
		if e.valid and e.unit_number and e.type ~= "item-entity" then blockers[#blockers + 1] = e end
	end
	return blockers
end

local function plan_targets(surface, targets)
	local plan = { clear = {}, conflict = {} }
	for _, t in ipairs(targets) do
		local blockers = blocking_entities(surface, t)
		if #blockers == 0 then
			plan.clear[#plan.clear + 1] = { rec = t }
		else
			plan.conflict[#plan.conflict + 1] = { rec = t, blockers = blockers }
		end
	end
	return plan
end

local function plan_paste(surface, cap, offset)
	local targets = {}
	for _, rec in ipairs(cap.records) do targets[#targets + 1] = translate(rec, offset) end
	return plan_targets(surface, targets)
end

local function apply_paste_activation(records, entity_map)
	for _, rec in ipairs(records) do
		local entity = entity_map[rec.entity_id]
		if entity and entity.valid then
			local ok, err = pcall(function()
				entity.disabled_by_script = (rec.lab_active == false)
			end)
			if not ok then
				log(string.format("[SelectionLab] activation write failed for %s at (%.1f,%.1f): %s",
					rec.name, rec.position.x, rec.position.y, tostring(err)))
			end
			if entity.type == "mining-drill" and rec.specific_data
				and rec.specific_data.mining_progress then
				ActiveStateRestoration.queue_mining_progress(entity, rec.specific_data)
			end
		end
	end
end

local function proxy_last(recs)
	local ordered = {}
	for _, rec in ipairs(recs) do
		if rec.type ~= "item-request-proxy" then ordered[#ordered + 1] = rec end
	end
	for _, rec in ipairs(recs) do
		if rec.type == "item-request-proxy" then ordered[#ordered + 1] = rec end
	end
	return ordered
end

local function execute_create_and_restore(surface, recs, player, side_groups, fluid_segments, transactional)
	local records, entity_map = {}, {}
	local created, create_failed = 0, 0
	for _, rec in ipairs(proxy_last(recs)) do
		local ok, entity
		if rec.type == "item-on-ground" then
			ok, entity = pcall(function() return Deserializer.create_ground_item(surface, rec) end)
		else
			ok, entity = pcall(function() return Deserializer.create_entity(surface, rec) end)
		end
		if ok and entity then
			created = created + 1
			records[#records + 1] = rec
			entity_map[rec.entity_id] = entity
			if entity.type ~= "beacon" and entity.type ~= "radar"
				and entity.type ~= "item-request-proxy" then
				local frozen_ok, frozen_err = pcall(function()
					if entity.active then entity.disabled_by_script = true end
				end)
				if not frozen_ok then
					log(string.format("[SelectionLab] failed to freeze %s at (%.1f,%.1f): %s",
						rec.name, rec.position.x, rec.position.y, tostring(frozen_err)))
				end
			end
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
	local failures = {}
	local function rec_label(rec)
		return string.format("%s at (%.1f,%.1f)", tostring(rec.name), rec.position.x, rec.position.y)
	end
	local function step(label, fn)
		local ok, err = pcall(fn)
		if not ok then
			failures[#failures + 1] = label .. ": " .. tostring(err)
			log(string.format("[SelectionLab] restore step FAILED (%s): %s", label, tostring(err)))
		end
	end
	if side_groups then
		step("belt side-restore", function()
			local placed, unplaced, anomalies = BeltRestoration.restore_side_groups(side_groups, entity_map)
			if unplaced > 0 or anomalies > 0 then
				error(string.format("%d placed, %d UNPLACED, %d anomalies (no fallback)",
					placed, unplaced, anomalies), 0)
			end
		end)
	else
		for _, rec in ipairs(records) do
			if rec.type and BELT_LINE_TYPES[rec.type] and rec.specific_data and rec.specific_data.items then
				local message = rec_label(rec)
					.. ": belt items present but NO side partition was captured — refusing the deleted legacy consolidation restore"
				failures[#failures + 1] = message
				log("[SelectionLab] " .. message)
			end
		end
	end
	for _, rec in ipairs(records) do
		local entity = entity_map[rec.entity_id]
		if entity and entity.valid then
			step(rec_label(rec) .. " entity state", function() Deserializer.restore_entity_state(entity, rec) end)
		end
	end
	step("entity-state batch", function() EntityStateRestoration.restore_all(records, entity_map) end)
	for _, rec in ipairs(records) do
		local entity = entity_map[rec.entity_id]
		if entity and entity.valid and rec.type == "beacon" then
			step(rec_label(rec) .. " inventories", function() Deserializer.restore_inventories(entity, rec) end)
		end
	end
	for _, rec in ipairs(records) do
		local entity = entity_map[rec.entity_id]
		if entity and entity.valid and rec.type ~= "beacon" then
			step(rec_label(rec) .. " inventories", function() Deserializer.restore_inventories(entity, rec) end)
		end
	end
	step("held items", function() ActiveStateRestoration.restore_held_items_only(records, entity_map) end)
	if paste_touches_live_fluid_network(entity_map) then
		say(player, "[color=yellow][font=default-bold][SelectionLab][/font][/color] fluids skipped: pasted fluid system connects to live network — fluid restore only runs on isolated pastes",
			{ r = 1, g = 0.7, b = 0.3 })
	else
		step("fluid restore", function() FluidRestoration.restore(records, entity_map, fluid_segments) end)
	end
	apply_paste_activation(records, entity_map)
	if #failures > 0 then
		local summary = string.format("%d restore step(s) failed across %d record(s): %s",
			#failures, #records, table.concat(failures, " | "))
		if transactional then error(summary, 0) end
		say(player, "[color=yellow][font=default-bold][SelectionLab][/font][/color] PARTIAL RESTORE — " .. summary,
			{ r = 1, g = 0.6, b = 0.3 })
	end
	end
	local restore_ok, restore_err = xpcall(run_restores, debug.traceback)
	if not restore_ok then
		log("[SelectionLab] restore error: " .. tostring(restore_err))
		if transactional then
			return rollback("restore error: " .. tostring(restore_err))
		end
		apply_paste_activation(records, entity_map)
		if player then
			say(player, "[color=yellow][font=default-bold][SelectionLab][/font][/color] restore error (best-effort path): " .. tostring(restore_err),
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


function SelectionLab.paste(event)
	local player = event_player(event)
	local st = pstate(event.player_index)
	local cap = st.export
	if not (cap and cap.records and #cap.records > 0) then
		say(player, "[color=yellow][font=default-bold][SelectionLab][/font][/color] nothing copied — plain-drag a source selection first", { r = 1, g = 0.4, b = 0.4 })
		return lab_result("paste", { outcome = "no_capture" })
	end
	local surface = event.surface
	local offset = paste_offset(cap, event)
	local plan = plan_paste(surface, cap, offset)

	if #plan.conflict > 0 then
		if player then
			draw_plan_boxes(surface, plan.conflict, CONFLICT_RED, player.index)
			player.play_sound({ path = "utility/cannot_build" })
		end
		say(player, string.format(
			"[color=yellow][font=default-bold][SelectionLab][/font][/color] PASTE REFUSED: %d of %d targets occupied (red). Nothing was placed. Shift+Right-drag forces.",
			#plan.conflict, #cap.records), { r = 1, g = 0.4, b = 0.4 })
		local conflict_details = {}
		for i, c in ipairs(plan.conflict) do
			if i > 5 then
				conflict_details[#conflict_details + 1] = "+" .. (#plan.conflict - 5) .. " more"
				break
			end
			conflict_details[#conflict_details + 1] = string.format("%s at (%s,%s) blocked by %s",
				c.rec.name, c.rec.position.x, c.rec.position.y, c.blockers[1].name)
		end
		return lab_result("paste", { outcome = "refused", conflicts = #plan.conflict, targets = #cap.records,
			offset = offset, conflict_details = conflict_details })
	end

	local recs = {}
	for _, c in ipairs(plan.clear) do recs[#recs + 1] = c.rec end
	local records, entity_map, created, create_failed, exec_ok, exec_err =
		execute_create_and_restore(surface, recs, player, cap.side_groups, cap.fluid_segments, true)
	if not exec_ok then
		if player then player.play_sound({ path = "utility/cannot_build" }) end
		say(player, "[color=yellow][font=default-bold][SelectionLab][/font][/color] PASTE ROLLED BACK (" .. tostring(exec_err) ..
			") — every created entity was removed; nothing journaled.", { r = 1, g = 0.4, b = 0.4 })
		return lab_result("paste", { outcome = "rolled_back", error = tostring(exec_err), offset = offset })
	end
	if player then
		for _, rec in ipairs(records) do
			draw_box(surface, rec.position, PLACEABLE_GREEN, player.index)
		end
	end
	push_undo(st, { mode = "paste", surface = surface.name, created = journal_created(records, entity_map),
		destroyed_records = {}, plan_records = recs, side_groups = cap.side_groups, fluid_segments = cap.fluid_segments })
	local physical_items = physical_census(entity_map)
	local capture_items = capture_item_total(cap.records)
	say(player, string.format(
		"[color=yellow][font=default-bold][SelectionLab][/font][/color] PASTED %d entities (%d create-failed) at offset (%d,%d). Physical items on paste: %d (capture holds %d). Ctrl+Alt+Z undoes.",
		created, create_failed, offset.x, offset.y, physical_items, capture_items),
		{ r = 0.4, g = 1, b = 0.4 })
	return lab_result("paste", {
		outcome = "pasted", created = created, create_failed = create_failed, offset = offset,
		physical_items = physical_items, capture_items = capture_items,
	})
end


function SelectionLab.preview(event)
	local player = event_player(event)
	local st = pstate(event.player_index)
	local cap = st.export
	if not (cap and cap.records and #cap.records > 0) then
		say(player, "[color=yellow][font=default-bold][SelectionLab][/font][/color] nothing copied — plain-drag a source selection first", { r = 1, g = 0.4, b = 0.4 })
		return lab_result("preview", { outcome = "no_capture" })
	end
	local surface = event.surface
	local offset = paste_offset(cap, event)
	local plan = plan_paste(surface, cap, offset)
	draw_plan_boxes(surface, plan.clear, PLACEABLE_GREEN, player.index)
	draw_plan_boxes(surface, plan.conflict, CONFLICT_RED, player.index)
	say(player, string.format(
		"[color=yellow][font=default-bold][SelectionLab][/font][/color] PREVIEW: %d placeable (green), %d conflicted (red) at offset (%d,%d). Nothing was placed.",
		#plan.clear, #plan.conflict, offset.x, offset.y), { r = 0.6, g = 0.9, b = 1 })
	return lab_result("preview", {
		outcome = "previewed", clear = #plan.clear, conflicts = #plan.conflict, offset = offset,
	})
end


local function blocker_guard_reason(entity, player)
	if entity.type == "character" then return "character" end
	if entity.name == "space-platform-hub" then return "platform hub" end
	if entity.force ~= player.force then return "force " .. entity.force.name end
	return nil
end

local function partition_force_targets(surface, recs, player)
	local placeable, refused, guarded_units = {}, {}, {}
	for _, rec in ipairs(recs) do
		local guards = {}
		for _, e in ipairs(blocking_entities(surface, rec)) do
			local reason = blocker_guard_reason(e, player)
			if reason then
				guards[#guards + 1] = string.format("%s (%s)", e.name, reason)
				guarded_units[e.unit_number] = true
			end
		end
		if #guards > 0 then
			refused[#refused + 1] = string.format("%s at (%.1f,%.1f) held by %s",
				tostring(rec.name), rec.position.x, rec.position.y, table.concat(guards, ", "))
		else
			placeable[#placeable + 1] = rec
		end
	end
	local guarded = 0
	for _ in pairs(guarded_units) do guarded = guarded + 1 end
	return placeable, refused, guarded
end

local function snapshot_blockers(surface, recs, player)
	local victims, seen = {}, {}
	for _, rec in ipairs(recs) do
		for _, e in ipairs(blocking_entities(surface, rec)) do
			if not seen[e.unit_number] then
				seen[e.unit_number] = true
				victims[#victims + 1] = { entity = e, name = e.name,
					position = { x = e.position.x, y = e.position.y } }
				if player then draw_box(surface, e.position, CONFLICT_RED, player.index) end
			end
		end
	end
	local belt_pairs = {}
	local registry = FluidRegistry.new()
	InventoryScanner.fluid_registry = registry
	local snapshot_ok, snapshot_err = pcall(function()
		for _, v in ipairs(victims) do
			local snapshot = EntityScanner.serialize_entity(v.entity)
			if snapshot then
				snapshot.lab_active = v.entity.active
				v.record = snapshot
				if BELT_LINE_TYPES[v.entity.type] then
					belt_pairs[#belt_pairs + 1] = { entity = v.entity, id = snapshot.entity_id }
				end
			else
				log(string.format(
					"[SelectionLab] blocker %s at (%.1f,%.1f) was invalid at snapshot time — skipped, not journaled",
					v.name, v.position.x, v.position.y))
			end
		end
	end)
	local side_ok, side_groups = true, nil
	if snapshot_ok then
		side_ok, side_groups = pcall(BeltRestoration.capture_side_groups, belt_pairs)
	end
	InventoryScanner.fluid_registry = nil
	if not snapshot_ok then error(snapshot_err, 0) end
	if not side_ok then error(side_groups, 0) end
	return victims, side_groups, FluidRegistry.list(registry)
end

local function destroy_blockers(victims)
	for _, v in ipairs(victims) do
		if v.record and v.entity.valid then
			local ok, err = pcall(function() v.entity.destroy() end)
			if not ok then
				log(string.format("[SelectionLab] destroy raised for blocker %s at (%.1f,%.1f): %s",
					v.name, v.position.x, v.position.y, tostring(err)))
			end
		end
	end
	local destroyed_records, survivors = {}, {}
	for _, v in ipairs(victims) do
		if v.entity.valid then
			survivors[#survivors + 1] = string.format("%s at (%.1f,%.1f)", v.name, v.position.x, v.position.y)
		elseif v.record then
			destroyed_records[#destroyed_records + 1] = v.record
		end
	end
	return destroyed_records, survivors
end

local function force_execute(surface, recs, player, side_groups, fluid_segments)
	local placeable, refused, guarded = partition_force_targets(surface, recs, player)
	local result = { ok = false, created = 0, create_failed = 0, resurrected = 0,
		destroyed_records = {}, refused = refused, guarded = guarded }
	if #placeable == 0 then
		result.refused_all = true
		return result
	end
	local victims, blocker_side_groups, blocker_fluid_segments = snapshot_blockers(surface, placeable, player)
	local destroyed_records, survivors = destroy_blockers(victims)
	result.destroyed_records = destroyed_records
	result.destroyed_side_groups = blocker_side_groups
	result.destroyed_fluid_segments = blocker_fluid_segments
	local function resurrect()
		if #destroyed_records == 0 then return 0 end
		local rrecords = execute_create_and_restore(surface, destroyed_records, player,
			blocker_side_groups, blocker_fluid_segments, false)
		return rrecords and #rrecords or 0
	end
	if #survivors > 0 then
		result.err = string.format("%d blocker(s) survived the destroy pass: %s",
			#survivors, table.concat(survivors, ", "))
		result.resurrected = resurrect()
		return result
	end
	local records, entity_map, created, create_failed, exec_ok, exec_err =
		execute_create_and_restore(surface, placeable, player, side_groups, fluid_segments, true)
	result.created = created
	result.create_failed = create_failed
	if not exec_ok then
		result.err = exec_err
		result.resurrected = resurrect()
		return result
	end
	result.records = records
	result.entity_map = entity_map
	result.ok = true
	return result
end

function SelectionLab.force(event)
	local player = event_player(event)
	local st = pstate(event.player_index)
	local cap = st.export
	if not (cap and cap.records and #cap.records > 0) then
		say(player, "[color=yellow][font=default-bold][SelectionLab][/font][/color] nothing copied — plain-drag a source selection first", { r = 1, g = 0.4, b = 0.4 })
		return lab_result("force", { outcome = "no_capture" })
	end
	local surface = event.surface
	local offset = paste_offset(cap, event)
	local recs = {}
	for _, rec in ipairs(cap.records) do recs[#recs + 1] = translate(rec, offset) end
	local outcome = force_execute(surface, recs, player, cap.side_groups, cap.fluid_segments)
	if outcome.refused_all then
		player.play_sound({ path = "utility/cannot_build" })
		say(player, string.format(
			"[color=yellow][font=default-bold][SelectionLab][/font][/color] FORCE REFUSED: all %d targets are held by protected blockers (%s). Nothing was destroyed, nothing was placed.",
			#recs, table.concat(outcome.refused, "; ")), { r = 1, g = 0.4, b = 0.4 })
		return lab_result("force", {
			outcome = "refused", records_refused = #outcome.refused, targets = #recs,
			blockers_guarded = outcome.guarded, refused_details = outcome.refused, offset = offset,
		})
	end
	if not outcome.ok then
		player.play_sound({ path = "utility/cannot_build" })
		say(player, string.format(
			"[color=yellow][font=default-bold][SelectionLab][/font][/color] FORCE ROLLED BACK (%s) — created entities removed, %d/%d replaced blockers resurrected. Nothing journaled.",
			tostring(outcome.err), outcome.resurrected, #outcome.destroyed_records), { r = 1, g = 0.4, b = 0.4 })
		return lab_result("force", {
			outcome = "rolled_back", error = tostring(outcome.err),
			blockers_destroyed = #outcome.destroyed_records, blockers_resurrected = outcome.resurrected,
			records_refused = #outcome.refused, blockers_guarded = outcome.guarded, offset = offset,
		})
	end
	local records, entity_map = outcome.records, outcome.entity_map
	local created, create_failed = outcome.created, outcome.create_failed
	local destroyed_records, guarded = outcome.destroyed_records, outcome.guarded
	push_undo(st, { mode = "force", surface = surface.name, created = journal_created(records, entity_map),
		destroyed_records = destroyed_records, destroyed_side_groups = outcome.destroyed_side_groups,
		destroyed_fluid_segments = outcome.destroyed_fluid_segments,
		plan_records = recs, side_groups = cap.side_groups, fluid_segments = cap.fluid_segments })
	local physical_items = physical_census(entity_map)
	say(player, string.format(
		"[color=yellow][font=default-bold][SelectionLab][/font][/color] FORCE-PASTED %d entities (%d create-failed, %d blockers replaced%s) at offset (%d,%d). Physical items: %d. Ctrl+Alt+Z undoes: replaced blockers come back with their inventories and their belt cargo, and with their fluids unless the resurrected fluid system rejoins a live network.",
		created, create_failed, #destroyed_records,
		#outcome.refused > 0 and string.format(", %d record(s) REFUSED over %d protected blocker(s): %s",
			#outcome.refused, guarded, table.concat(outcome.refused, "; ")) or "",
		offset.x, offset.y, physical_items), { r = 0.4, g = 1, b = 0.4 })
	return lab_result("force", {
		outcome = "force_pasted", created = created, create_failed = create_failed,
		blockers_replaced = #destroyed_records, blockers_guarded = guarded,
		records_refused = #outcome.refused, refused_details = outcome.refused,
		offset = offset, physical_items = physical_items,
	})
end


local function fresh_fluid_state()
	return { counted_segments = {}, seg_temps = {} }
end

function SelectionLab.audit(event)
	local player = event_player(event)
	local entity_counts, item_totals, fluid_totals = {}, {}, {}
	local entity_n, item_n, fluid_n = 0, 0, 0
	local fluid_state = fresh_fluid_state()
	for _, e in ipairs(event.entities) do
		if e.valid then
			entity_counts[e.name] = (entity_counts[e.name] or 0) + 1
			entity_n = entity_n + 1
			if e.type == "item-entity" then
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
				for key, amount in pairs(SurfaceCounter.count_entity_fluids(e, fluid_state)) do
					local name = Util.parse_fluid_temp_key(key)
					fluid_totals[name] = (fluid_totals[name] or 0) + amount
					fluid_n = fluid_n + amount
				end
			end
		end
	end

	local dims = "?"
	if event.area then
		local w = math.ceil(event.area.right_bottom.x) - math.floor(event.area.left_top.x)
		local h = math.ceil(event.area.right_bottom.y) - math.floor(event.area.left_top.y)
		dims = w .. " x " .. h
	end
	say(player, string.format("%s Observing (%s)", LAB_PREFIX, dims))
	local function category_line(label, totals, render)
		if not next(totals) then return end
		local lines = {}
		for key, n in pairs(totals) do lines[#lines + 1] = render(key, n) end
		table.sort(lines)
		say(player, "[font=default-bold][color=cyan]" .. label .. ":[/color][/font] " .. table.concat(lines, "  "))
	end
	category_line("Entities", entity_counts, icon_entity)
	category_line("Items", item_totals, icon_item)
	category_line("Fluids", fluid_totals, icon_fluid)


	local report = {
		tick = game.tick,
		entity_count = entity_n, item_count = item_n, fluid_total = fluid_n,
		entities = entity_counts, items = item_totals, fluids = fluid_totals,
	}
	log("[SelectionLab][AUDIT-JSON] " .. helpers.table_to_json(report))
	return report
end


function SelectionLab.undo(event)
	local player = event_player(event)
	if not debug_enabled() then return end
	local st = pstate(event.player_index)
	local stack = st.undo
	local entry = table.remove(stack)
	if not entry then
		say(player, "[color=yellow][font=default-bold][SelectionLab][/font][/color] nothing to undo", { r = 1, g = 0.6, b = 0.3 })
		return
	end
	local surface = game.surfaces[entry.surface]
	if not surface then say(player, "[color=yellow][font=default-bold][SelectionLab][/font][/color] undo surface gone", { r = 1, g = 0.4, b = 0.4 }) return end
	local removed, missed = 0, 0
	for _, c in ipairs(entry.created) do
		local hit = nil
		if c.unit_number then
			hit = game.get_entity_by_unit_number(c.unit_number)
			if not (hit and hit.valid) then
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
		local records = execute_create_and_restore(surface, entry.destroyed_records, player,
			entry.destroyed_side_groups, entry.destroyed_fluid_segments, false)
		resurrected = records and #records or 0
	end
	table.insert(st.redo, entry)
	say(player, string.format(
		"[color=yellow][font=default-bold][SelectionLab][/font][/color] UNDO: removed %d pasted entities (%d already gone), resurrected %d replaced blockers with their inventories and their belt cargo, and with their fluids unless the resurrected fluid system rejoins a live network. Ctrl+Alt+Y redoes.",
		removed, missed, resurrected), { r = 0.4, g = 0.9, b = 1 })
end

function SelectionLab.redo(event)
	local player = event_player(event)
	if not debug_enabled() then return end
	local st = pstate(event.player_index)
	local stack = st.redo
	local entry = table.remove(stack)
	if not entry then
		say(player, "[color=yellow][font=default-bold][SelectionLab][/font][/color] nothing to redo", { r = 1, g = 0.6, b = 0.3 })
		return
	end
	local surface = game.surfaces[entry.surface]
	if not surface then say(player, "[color=yellow][font=default-bold][SelectionLab][/font][/color] redo surface gone", { r = 1, g = 0.4, b = 0.4 }) return end
	local mode = entry.mode
		or ((entry.destroyed_records and #entry.destroyed_records > 0) and "force" or "paste")

	if mode == "paste" then
		local plan = plan_targets(surface, entry.plan_records)
		if #plan.conflict > 0 then
			for _, c in ipairs(plan.conflict) do
				draw_box(surface, c.rec.position, CONFLICT_RED, player.index)
			end
			player.play_sound({ path = "utility/cannot_build" })
			say(player, string.format(
				"[color=yellow][font=default-bold][SelectionLab][/font][/color] REDO REFUSED: %d of %d targets now occupied (red). Nothing re-pasted; still redoable.",
				#plan.conflict, #entry.plan_records), { r = 1, g = 0.4, b = 0.4 })
			table.insert(stack, entry)
			return
		end
		local recs = {}
		for _, c in ipairs(plan.clear) do recs[#recs + 1] = c.rec end
		local records, entity_map, created, _cf, exec_ok, exec_err =
			execute_create_and_restore(surface, recs, player, entry.side_groups, entry.fluid_segments, true)
		if not exec_ok then
			player.play_sound({ path = "utility/cannot_build" })
			say(player, "[color=yellow][font=default-bold][SelectionLab][/font][/color] REDO ROLLED BACK (" .. tostring(exec_err) .. ") — still redoable.",
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
		say(player, string.format("[color=yellow][font=default-bold][SelectionLab][/font][/color] REDO: re-pasted %d entities (all-or-nothing).", created),
			{ r = 0.4, g = 0.9, b = 1 })
	else
		local outcome = force_execute(surface, entry.plan_records, player, entry.side_groups, entry.fluid_segments)
		if outcome.refused_all then
			player.play_sound({ path = "utility/cannot_build" })
			say(player, string.format(
				"[color=yellow][font=default-bold][SelectionLab][/font][/color] REDO REFUSED: all %d targets are held by protected blockers (%s). Nothing was destroyed; still redoable.",
				#entry.plan_records, table.concat(outcome.refused, "; ")), { r = 1, g = 0.4, b = 0.4 })
			table.insert(stack, entry)
			return
		end
		if not outcome.ok then
			player.play_sound({ path = "utility/cannot_build" })
			say(player, string.format(
				"[color=yellow][font=default-bold][SelectionLab][/font][/color] REDO ROLLED BACK (%s) — %d/%d replaced blockers resurrected; still redoable.",
				tostring(outcome.err), outcome.resurrected, #outcome.destroyed_records), { r = 1, g = 0.4, b = 0.4 })
			table.insert(stack, entry)
			return
		end
		entry.created = journal_created(outcome.records, outcome.entity_map)
		entry.destroyed_records = outcome.destroyed_records
		entry.destroyed_side_groups = outcome.destroyed_side_groups
		entry.destroyed_fluid_segments = outcome.destroyed_fluid_segments
		table.insert(st.undo, entry)
		say(player, string.format(
			"[color=yellow][font=default-bold][SelectionLab][/font][/color] REDO: force re-pasted %d entities (%d blockers replaced%s).",
			outcome.created, #outcome.destroyed_records,
			#outcome.refused > 0 and string.format(", %d record(s) REFUSED over %d protected blocker(s)",
				#outcome.refused, outcome.guarded) or ""),
			{ r = 0.4, g = 0.9, b = 1 })
	end
end


function SelectionLab.handle(event, mode)
	log(string.format("[SelectionLab] event mode=%s item=%s entities=%d", tostring(mode),
		tostring(event.item), event.entities and #event.entities or -1))
	if event.item ~= "selection-lab-tool" then return end
	if not debug_enabled() then
		local player = event_player(event)
		if player then say(player, "[color=yellow][font=default-bold][SelectionLab][/font][/color] debug_mode is off — tool disabled", { r = 1, g = 0.4, b = 0.4 }) end
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
