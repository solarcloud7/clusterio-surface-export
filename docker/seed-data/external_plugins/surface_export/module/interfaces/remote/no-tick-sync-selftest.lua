-- FactorioSurfaceExport - no-tick synchronous strict-gate self-test (remote)
-- PR-0B Phase-0 rung: prove the pre-validation held-item restore + strict count does not advance
-- the game tick, does not move crafting_progress, and does not let the restored inserter hand swing.

local ActiveStateRestoration = require("modules/surface_export/import_phases/active_state_restoration")
local TransferValidation = require("modules/surface_export/validators/transfer-validation")
local Util = require("modules/surface_export/utils/util")

local LAB_PREFIX = "no-tick-sync-lab-"

local function held_stack_row(entity)
	local stack = entity and entity.valid and entity.held_stack or nil
	if stack and stack.valid_for_read then
		return {
			name = stack.name,
			count = stack.count,
			quality = stack.quality and stack.quality.name or "normal",
		}
	end
	return nil
end

--- MEASURE-BAKED mode (owner-approved 2026-07-18, the no-tick-sync-frozen-pair card): run the SAME
--- held-restore measurement against an EXISTING baked pair — construct-free (the golden world
--- forbids construction; the bake gate exists because built-at-runtime and save-loaded worlds are
--- not automatically identical). Resolves the platform by name and the pair by exact positions.
--- Mutates ONLY the inserter hand (seats opts.held) — single-use per golden load; the pair reload
--- is the reset. Assertion set: tick unchanged, crafting_progress EXACTLY unchanged, input
--- unchanged, hand seats full, both entities stay inactive.
--- @param opts table: { platform, machine_pos={x,y}, inserter_pos={x,y}, held={name,count,quality} }
local function measure_baked_pair(opts)
	local surface
	for _, p in pairs(game.forces.player.platforms) do
		if p.valid and p.name == opts.platform then surface = p.surface end
	end
	if not surface then
		return { status = "error", reason = "platform not found: " .. tostring(opts.platform), tick = game.tick }
	end
	local function entity_at(name, pos)
		return surface.find_entities_filtered({ name = name,
			area = { { pos.x - 0.4, pos.y - 0.4 }, { pos.x + 0.4, pos.y + 0.4 } } })[1]
	end
	local machine = entity_at("assembling-machine-1", opts.machine_pos)
	local inserter = entity_at("inserter", opts.inserter_pos)
	if not (machine and machine.valid and inserter and inserter.valid) then
		return { status = "error", reason = "baked pair not found at the given positions", tick = game.tick }
	end

	local held = opts.held or { name = "iron-plate", count = 1, quality = "normal" }
	local entity_data = { entity_id = inserter.unit_number, specific_data = { held_item = held } }
	local entity_map = { [inserter.unit_number] = inserter }
	local input = machine.get_inventory(defines.inventory.crafter_input)

	local tick_before = game.tick
	local progress_before = machine.crafting_progress
	local input_before = input and input.get_item_count() or nil
	local held_before = held_stack_row(inserter)
	local restored, failed = ActiveStateRestoration.restore_held_items_only({ entity_data }, entity_map)
	local held_after = held_stack_row(inserter)

	return {
		status = "measured",
		mode = "measure_baked",
		platform = opts.platform,
		tick_before = tick_before,
		tick_after = game.tick,
		game_paused = game.tick_paused == true,
		crafting_progress_before = progress_before,
		crafting_progress_after = machine.crafting_progress,
		input_count_before = input_before,
		input_count_after = input and input.get_item_count() or nil,
		machine_active_after = machine.active,
		inserter_active_after = inserter.active,
		held_before = held_before,
		held_after = held_after,
		restored = restored,
		failed = failed,
		seated_full = held_after ~= nil and held_after.name == held.name and held_after.count == (held.count or 1)
			and restored == (held.count or 1) and failed == 0,
	}
end

local function no_tick_sync_selftest(opts)
	-- Construct-free baked-fixture measurement (opts-selected); the no-arg call keeps the
	-- legacy build-your-own-world rung below unchanged.
	if type(opts) == "table" and opts.mode == "measure_baked" then
		return measure_baked_pair(opts)
	end
	storage.no_tick_sync_lab = { started_tick = game.tick }

	local force = game.forces.player
	local surface_name = LAB_PREFIX .. tostring(game.tick)
	local surface = game.create_surface(surface_name, { width = 64, height = 64 })
	surface.request_to_generate_chunks({0, 0}, 2)
	surface.force_generate_chunk_requests()

	local tiles = {}
	for x = -8, 8 do
		for y = -8, 8 do
			tiles[#tiles + 1] = { name = "grass-1", position = { x, y } }
		end
	end
	surface.set_tiles(tiles, true, false, true, false)

	if force.recipes["iron-gear-wheel"] then
		force.recipes["iron-gear-wheel"].enabled = true
	end

	local machine = surface.create_entity({ name = "assembling-machine-1", position = { 0, 0 }, force = force })
	local inserter = surface.create_entity({ name = "inserter", position = { 2, 0 }, force = force, direction = defines.direction.east })
	if not (machine and machine.valid and inserter and inserter.valid) then
		return {
			status = "unconstructible",
			reason = "failed to create assembler/inserter specimen",
			tick = game.tick,
			surface = surface.name,
		}
	end

	machine.set_recipe("iron-gear-wheel")
	machine.crafting_progress = 0.42
	machine.active = false
	inserter.active = false

	local entity_data = {
		entity_id = inserter.unit_number,
		specific_data = {
			held_item = { name = "iron-plate", count = 1, quality = "normal" },
		},
	}
	local entity_map = {}
	entity_map[inserter.unit_number] = inserter

	local tick_before = game.tick
	local crafting_progress_before = machine.crafting_progress
	local held_before_restore = held_stack_row(inserter)
	local restored, failed = ActiveStateRestoration.restore_held_items_only({ entity_data }, entity_map)
	local held_item_after_restore = held_stack_row(inserter)
	local success, validation = TransferValidation.validate_import(
		surface,
		{
			item_counts = { [Util.make_quality_key("iron-plate", "normal")] = 1 },
			fluid_counts = {},
		},
		{ strict = true }
	)
	local tick_after = game.tick
	local crafting_progress_after = machine.crafting_progress
	local held_item_after_validation = held_stack_row(inserter)

	return {
		status = "passed",
		surface = surface.name,
		tick_before = tick_before,
		tick_after = tick_after,
		game_paused = game.tick_paused == true,
		machine_active_after = machine.active,
		inserter_active_after = inserter.active,
		crafting_progress_before = crafting_progress_before,
		crafting_progress_after = crafting_progress_after,
		held_before_restore = held_before_restore,
		held_item_after_restore = held_item_after_restore,
		held_item_after_validation = held_item_after_validation,
		held_item_intentional_restore = held_before_restore == nil
			and held_item_after_restore ~= nil
			and held_item_after_restore.name == "iron-plate"
			and held_item_after_restore.count == 1
			and restored == 1
			and failed == 0,
		restored = restored,
		failed = failed,
		validation_called = true,
		validation_success = success == true,
		validation_message = validation and (validation.mismatchDetails or validation.message) or nil,
		validation = validation,
	}
end

return no_tick_sync_selftest
