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

local function no_tick_sync_selftest()
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
