-- FactorioSurfaceExport - Import Completion
-- Handles post-entity-creation phases: hub inventories, belts, state, inventories,
-- validation, activation, fluid restoration, loss analysis, and notifications.
--
-- Phase ordering (CRITICAL — do not reorder):
--   Phase 1 (run_phase1): hub inventories → belts → entity state → schedule phase 2
--   Phase 2 (run_phase2): inventories (beacons first) → deactivate → fluids → exact gate
--                         → activate → reporting → notify

local Deserializer = require("modules/surface_export/core/deserializer")
local FluidRestoration = require("modules/surface_export/import_phases/fluid_restoration")
local EntityStateRestoration = require("modules/surface_export/import_phases/entity_state_restoration")
local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")
local ActiveStateRestoration = require("modules/surface_export/import_phases/active_state_restoration")
local PlatformHubMapping = require("modules/surface_export/import_phases/platform_hub_mapping")
local TransferValidation = require("modules/surface_export/validators/transfer-validation")
local LossAnalysis = require("modules/surface_export/validators/loss-analysis")
local SurfaceCounter = require("modules/surface_export/validators/surface-counter")
local DebugExport = require("modules/surface_export/utils/debug-export")
local PlatformSchedule = require("modules/surface_export/utils/platform-schedule")
local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local GameUtils = require("modules/surface_export/utils/game-utils")
local Gateway = require("modules/surface_export/core/gateway")
local Util = require("modules/surface_export/utils/util")
local clusterio_api = require("modules/clusterio/api")
local PhaseProfiler = require("modules/surface_export/utils/phase-profiler")
local TransactionHistory = require("modules/surface_export/utils/transaction-history")
local JobResults = require("modules/surface_export/core/job-results")

local ImportCompletion = {}

local function aggregate_fluid_counts_by_name(counts)
	local totals = {}
	for key, amount in pairs(counts or {}) do
		local name, _ = Util.parse_fluid_temp_key(key)
		totals[name] = (totals[name] or 0) + amount
	end
	return totals
end

local function copy_counts(counts)
	local copy = {}
	for key, amount in pairs(counts or {}) do copy[key] = amount end
	return copy
end

local function capture_p2_plasma(surface, platform_name)
	local holders = {}
	for _, entity in ipairs(surface.find_entities_filtered({})) do
		if entity.valid and entity.fluidbox
			and (entity.name == "fusion-reactor" or entity.name == "pipe" or entity.name == "storage-tank") then
			for i = 1, #entity.fluidbox do
				local direct = entity.fluidbox[i]
				local segment_id = entity.fluidbox.get_fluid_segment_id(i)
				local segment_contents = segment_id and entity.fluidbox.get_fluid_segment_contents(i) or nil
				local prototype = entity.prototype.fluidbox_prototypes
					and entity.prototype.fluidbox_prototypes[i] or nil
				holders[#holders + 1] = {
					entity = entity.name,
					unit_number = entity.unit_number,
					position = { x = entity.position.x, y = entity.position.y },
					box = i,
					production_type = prototype and prototype.production_type or nil,
					active = entity.active,
					segment_id = segment_id,
					direct = direct and {
						name = direct.name,
						amount = direct.amount,
						temperature = direct.temperature,
					} or nil,
					segment_contents = segment_contents,
				}
			end
		end
	end
	return {
		platform_name = platform_name,
		tick = game.tick,
		game_paused = game.tick_paused == true,
		platform_paused = surface.platform and surface.platform.paused or nil,
		holders = holders,
	}
end

local function subtract_fluids_by_name(counts, subtractions)
	local adjusted = copy_counts(counts)
	for fluid_name, amount in pairs(subtractions or {}) do
		local remaining = amount
		for key, current in pairs(adjusted) do
			if remaining <= 0 then break end
			local name = Util.parse_fluid_temp_key(key)
			if name == fluid_name and current > 0 then
				local subtract = math.min(current, remaining)
				adjusted[key] = current - subtract
				remaining = remaining - subtract
			end
		end
	end
	return adjusted
end

--- Build a waterfall phase span {name, start_offset_ms, duration_ms} from two game.tick marks,
--- relative to the import job's t0 (job.started_tick). Returns nil if either boundary is missing
--- (e.g. validation on non-transfer imports) so the phase is simply omitted from the trace.
--- This is pure arithmetic over already-recorded tick reads — it adds no game state and never
--- gates the freeze/count/populate logic.
local function build_phase_span(name, started_tick, completed_tick, t0)
	if not started_tick or not completed_tick then return nil end
	return {
		name = name,
		start_offset_ms = math.max(0, math.floor((started_tick - t0) * 16.67)),
		duration_ms = math.max(0, math.floor((completed_tick - started_tick) * 16.67)),
	}
end

local function emit_debug_import_result(job, validation_result, duration_seconds)
	if not job.transfer_id then return end
	local ok, err = pcall(function()
		DebugExport.export_import_result({
			platform_name = job.platform_name,
			transfer_id = job.transfer_id,
			validation_success = validation_result and validation_result.success == true,
			validation_result = validation_result,
			total_entities = job.total_entities,
			duration_seconds = duration_seconds
		}, job.platform_name)
	end)
	if not ok then
		log(string.format("[DebugExport] ERROR: Failed to export import result: %s", tostring(err)))
	end
end

local function build_count_diff(expected, actual)
	local keys, rows = {}, {}
	for key in pairs(expected or {}) do keys[key] = true end
	for key in pairs(actual or {}) do keys[key] = true end
	for key in pairs(keys) do
		local exp = (expected or {})[key] or 0
		local act = (actual or {})[key] or 0
		if math.abs(act - exp) > 1e-6 then
			rows[key] = { expected = exp, actual = act, delta = act - exp }
		end
	end
	return rows
end

local function bank_failure_black_box(job, result)
	local force_names = { [job.force_name or "player"] = true }
	for _, entity_data in ipairs(job.entities_to_create or {}) do
		force_names[entity_data.force or job.force_name or "player"] = true
	end
	local force_state = {}
	for force_name in pairs(force_names) do
		local force = game.forces[force_name]
		if force then
			local values = {}
			for _, prop in ipairs(GameUtils.FORCE_SYNC_PROPS or {}) do values[prop] = force[prop] end
			force_state[force_name] = values
		end
	end
	local mods = {}
	for name, version in pairs(script.active_mods or {}) do mods[name] = version end
	local safe_name = string.gsub(job.platform_name or "unknown", "[^%w_-]", "_")
	local filename = string.format("%s_%d.json", safe_name, game.tick)
	local bundle = {
		transfer_id = job.transfer_id,
		platform_name = job.platform_name,
		gate_tick = game.tick,
		started_tick = job.started_tick,
		engine_version = script.active_mods and script.active_mods.base or nil,
		mods = mods,
		force_state = force_state,
		expected = { items = result.expectedItemCounts, fluids = aggregate_fluid_counts_by_name(result.expectedFluidCounts) },
		actual = { items = result.actualItemCounts, fluids = aggregate_fluid_counts_by_name(result.actualFluidCounts) },
		diff = {
			items = build_count_diff(result.expectedItemCounts, result.actualItemCounts),
			fluids = build_count_diff(
				aggregate_fluid_counts_by_name(result.expectedFluidCounts),
				aggregate_fluid_counts_by_name(result.actualFluidCounts)
			),
		},
		physical_entities = EntityScanner.scan_surface(job.target_surface),
		belt_lines = BeltRestoration.attribute_lines(job.entities_to_create or {}, job.entity_map or {}),
		restore_time_belt_lines = job.belt_attribution,
		replay_payload = job.platform_data,
	}
	local written = DebugExport.write_failure_black_box(filename, bundle)
	result.failureBlackBox = { file = written, tick = game.tick }
	return written ~= nil
end

--- Phase 1: Restore hub inventories, belt items, and entity state.
--- Schedules Phase 2 for the next tick via job.pending_beacon_tick.
--- @param job table: Job data
function ImportCompletion.run_phase1(job)
	local entity_map = job.entity_map or {}
	local entities_to_create = job.entities_to_create or {}

	log("[Import] Phase 1 post-processing: hub inventories, belts, entity state...")

	-- Step 0: Restore hub inventories (DEFERRED from platform_hub_mapping)
	-- The hub's inventory size scales with cargo bays, which are now placed.
	PhaseProfiler.start(job.job_id, "hub_restore")
	PlatformHubMapping.restore_hub_inventories(job)
	PhaseProfiler.stop(job.job_id, "hub_restore")

	-- Step 0a: Restore belt items synchronously
	-- CRITICAL: Belts are always active and cannot be deactivated.
	-- Must restore all belt items in a single tick to prevent partial restoration
	job.metrics.belts_started_tick = game.tick
	PhaseProfiler.start(job.job_id, "belts")
	local belts_result = BeltRestoration.restore(entities_to_create, entity_map)
	PhaseProfiler.stop(job.job_id, "belts")
	job.metrics.belts_completed_tick = game.tick
	job.metrics.belt_items_restored = belts_result and belts_result.items_restored or 0
	job.belt_attribution = belts_result and belts_result.attribution or nil

	-- Steps 1-5: Restore localized entity state (Control Behavior, Filters, Connections)
	job.metrics.state_started_tick = game.tick
	PhaseProfiler.start(job.job_id, "state")
	local state_result = EntityStateRestoration.restore_all(entities_to_create, entity_map)
	PhaseProfiler.stop(job.job_id, "state")
	job.metrics.state_completed_tick = game.tick
	job.metrics.circuits_connected = state_result and state_result.circuits_connected or 0

	-- Phase 1 complete. Schedule Phase 2 (inventory restoration) for the next tick.
	-- Beacon modules are restored first in Phase 2 (Pass 1 of inventory loop), which
	-- immediately updates crafting_speed on nearby machines — no pre-activation needed.
	-- The platform stays paused throughout to prevent thrusters from consuming/generating fluids.
	job.pending_beacon_tick = game.tick + 1
	log(string.format("[Import] Phase 1 complete (tick %d). Inventory restore scheduled for tick %d", game.tick, job.pending_beacon_tick))
end

--- Phase 2: Restore inventories, validate, activate entities, restore fluids, run loss analysis,
--- store result, and send Clusterio notification. Removes job from storage on completion.
--- @param job table: Job data
function ImportCompletion.run_phase2(job)
	local duration_ticks = game.tick - job.started_tick
	local duration_seconds = duration_ticks / 60
	job.metrics = job.metrics or {}
	local entity_map = job.entity_map or {}
	local entities_to_create = job.entities_to_create or {}
	local validation_result_id = job.transfer_id or job.job_id

	-- Step 6: Restore inventories.
	-- CRITICAL ORDER: beacons FIRST, then everything else.
	-- Beacon modules (speed-module-3) must be placed before crafting machine input inventories
	-- are restored. The set_stack() cap on crafting machine inputs = ingredient_count × crafting_speed.
	-- crafting_speed only reflects beacon bonuses AFTER the beacon's module inventory is populated.
	-- If we restore crusher inputs before beacon modules, set_stack() uses the un-boosted cs=2.5
	-- cap (slots 7) instead of the beacon-boosted cs=17.375 cap (slots 12).

	if not job.inventory_overflow_losses then
		job.inventory_overflow_losses = { total = 0, items = {}, entities = {} }
	end
	job.metrics.inventories_started_tick = game.tick
	PhaseProfiler.start(job.job_id, "inventories")
	local inv_restored = 0
	local inv_skipped = 0
	-- Pass 1: beacons only
	for _, entity_data in ipairs(entities_to_create) do
		if entity_data and entity_data.entity_id and entity_data.type == "beacon" then
			local entity = entity_map[entity_data.entity_id]
			if entity and entity.valid then
				Deserializer.restore_inventories(entity, entity_data, job.inventory_overflow_losses)
			end
		end
	end
	-- Pass 2: all other entities
	for _, entity_data in ipairs(entities_to_create) do
		if entity_data and entity_data.entity_id and entity_data.type ~= "beacon" then
			local entity = entity_map[entity_data.entity_id]
			if entity and entity.valid then
				Deserializer.restore_inventories(entity, entity_data, job.inventory_overflow_losses)
				inv_restored = inv_restored + 1
			else
				inv_skipped = inv_skipped + 1
			end
		end
	end
	PhaseProfiler.stop(job.job_id, "inventories")
	job.metrics.inventories_completed_tick = game.tick
	log(string.format("[Import] Inventory restoration: %d entities restored, %d skipped (failed/missing)", inv_restored, inv_skipped))
	if job.inventory_overflow_losses.total > 0 then
		log(string.format("[Import] Inventory overflow losses: %d items lost (set_stack API cap)", job.inventory_overflow_losses.total))
	end

	-- Deactivate entities and re-pause platform after inventory restore.
	-- Validation requires machines to be inactive so they cannot consume items between now and validation.
	for _, entity_data in ipairs(entities_to_create) do
		if entity_data and entity_data.entity_id then
			local entity = entity_map[entity_data.entity_id]
			if entity and entity.valid and GameUtils.ACTIVATABLE_ENTITY_TYPES[entity.type] then
				entity.active = false
			end
		end
	end
	if job.transfer_id and job.target_platform and job.target_platform.valid then
		job.target_platform.paused = true
		log(string.format("[Import] Platform %s re-paused for validation (tick %d)", job.platform_name, game.tick))
	end

	-- Complete the frozen world before any verdict or activation. R11 measured the shipped
	-- restoration path at this exact point with zero per-name fluid delta at 1,359 entities.
	local frozen_states = job.frozen_states or {}
	local _dbg_cfg = storage.surface_export_config
	local defer_clone = _dbg_cfg and _dbg_cfg.debug_mode and _dbg_cfg.test_defer_clone_activation
	ActiveStateRestoration.restore_held_items_only(entities_to_create, entity_map)
	job.metrics.fluids_started_tick = game.tick
	PhaseProfiler.start(job.job_id, "fluids")
	local fluids_result = FluidRestoration.restore(entities_to_create, entity_map)
	PhaseProfiler.stop(job.job_id, "fluids")
	job.metrics.fluids_completed_tick = game.tick
	job.metrics.fluids_restored = fluids_result and fluids_result.count or 0
	log(string.format("[Import] Frozen-world fluid restoration: %d fluids restored", job.metrics.fluids_restored))

	do
		local config = storage.surface_export_config
		local hook = config and config.test_capture_p2_plasma
		if config and config.debug_mode == true and type(hook) == "table"
			and hook.platform_name == job.platform_name then
			config.test_capture_p2_plasma = nil
			storage.fluid_lab = storage.fluid_lab or {}
			storage.fluid_lab.p2_capture = capture_p2_plasma(job.target_surface, job.platform_name)
			log(string.format("[Import][TEST] P2 plasma capture consumed for %s at tick %d",
				job.platform_name, game.tick))
		end
	end

	if job.transfer_id then
		log("[Import] Deferring active state restoration until after the exact transfer gate")
	elseif defer_clone then
		-- TEST-ONLY: fluids are restored, but the clone remains deactivated for a pristine census.
		log("[Import][TEST] test_defer_clone_activation set — clone left DEACTIVATED with frozen fluids restored")
	else
		PhaseProfiler.start(job.job_id, "activation")
		ActiveStateRestoration.restore(entities_to_create, entity_map, frozen_states)
		PhaseProfiler.stop(job.job_id, "activation")
	end

	log("[Import] Post-processing complete")

	local message = string.format(
		"[Import Complete] %s (%d entities in %.1fs)",
		job.platform_name, job.total_entities, duration_seconds
	)
	game.print(message, {0, 1, 0})
	log(message)

	if job.requester == "RCON" then
		rcon.print(string.format("IMPORT_COMPLETE:%s", job.platform_name))
	end

	-- Perform validation if this is a transfer (has verification data and transfer ID)
	job.metrics.validation_started_tick = game.tick

	local validation_result = nil
	local is_transfer = job.transfer_id ~= nil
	local has_platform_data = job.platform_data ~= nil
	local has_verification = has_platform_data and job.platform_data.verification ~= nil

	if is_transfer and has_verification then
		-- NOTE: For transfers, entities are imported in deactivated state (active=false)
		-- so we don't need to freeze again. Just validate and then activate on success.

		-- Adjust expected counts to exclude items/fluids that were inside failed entities.
		-- Those items are unrestorable by design — counting them as "expected" would cause
		-- false validation failures for mod-mismatch or prototype-collision failures.
		local adjusted_verification = {
			item_counts = copy_counts(job.platform_data.verification.item_counts),
			fluid_counts = copy_counts(job.platform_data.verification.fluid_counts),
			engine_owned_fluid_counts = copy_counts(job.platform_data.verification.engine_owned_fluid_counts),
		}
		local fel = job.failed_entity_losses
		if fel and fel.entity_count > 0 then
			for item_key, lost_count in pairs(fel.items) do
				if adjusted_verification.item_counts[item_key] then
					adjusted_verification.item_counts[item_key] = math.max(
						0, adjusted_verification.item_counts[item_key] - lost_count)
				end
			end
			adjusted_verification.fluid_counts = subtract_fluids_by_name(
				adjusted_verification.fluid_counts, fel.fluids)
			log(string.format("[Import] Adjusted expected totals for %d failed entities: -%d items, -%.1f fluids",
				fel.entity_count, fel.total_items, fel.total_fluids))
		end

		-- Adjust expected counts for inventory overflow losses (set_stack API cap).
		-- These items are present in the export but unrestorable due to Factorio engine limits —
		-- counting them as "expected" would cause false validation failures.
		local iol = job.inventory_overflow_losses
		if iol and iol.total > 0 then
			for item_key, lost_count in pairs(iol.items) do
				if adjusted_verification.item_counts[item_key] then
					adjusted_verification.item_counts[item_key] = math.max(
						0, adjusted_verification.item_counts[item_key] - lost_count)
				end
			end
			log(string.format("[Import] Adjusted expected totals: subtracted %d items across %d item types due to inventory overflow (API stack cap)",
				iol.total, table_size(iol.items)))
		end

		-- TEST HOOK (one-shot, debug-gated): inject a REAL, UNACCOUNTED item loss on the destination
		-- AFTER held-restore but BEFORE the gate, to prove the STRICT gate DETECTS loss and the
		-- two-phase commit preserves the source (gate-detects-loss test). Removes N of the most-abundant
		-- (name,quality) from the surface — NOT routed through failed_entity_losses/overflow, so it is a
		-- genuine shortfall the gate must catch. Set via configure({ test_force_item_loss = N }).
		do
			local _cfg2 = storage.surface_export_config
			if _cfg2 and _cfg2.debug_mode and _cfg2.test_force_item_loss and _cfg2.test_force_item_loss > 0 then
				local n_want = _cfg2.test_force_item_loss
				_cfg2.test_force_item_loss = nil  -- consume: applies to one transfer only
				local ents = job.target_surface.find_entities_filtered({})
				local totals = {}
				for _, ent in ipairs(ents) do
					if ent.valid then
						local ok, maxi = pcall(function() return ent.get_max_inventory_index() end) -- intentional probe; failure expected per-entity, no log
						if ok and maxi then
							for ii = 1, maxi do
								local inv = ent.get_inventory(ii)
								if inv and inv.valid and not inv.is_empty() then
									for si = 1, #inv do
										local stack = inv[si]
										if stack.valid_for_read then
											local q = (stack.quality and stack.quality.name) or "normal"
											local key = stack.name .. "|" .. q
											local e = totals[key]
											if not e then e = { name = stack.name, quality = q, count = 0 }; totals[key] = e end
											e.count = e.count + stack.count
										end
									end
								end
							end
						end
					end
				end
				local best
				for _, e in pairs(totals) do
					if not best or e.count > best.count then best = e end
				end
				local removed = 0
				if best then
					for _, ent in ipairs(ents) do
						if removed >= n_want then break end
						if ent.valid then
							local r = ent.remove_item({ name = best.name, count = n_want - removed, quality = best.quality })
							removed = removed + (r or 0)
						end
					end
				end
				log(string.format("[TEST HOOK] Forced item loss: removed %d %s (quality=%s) from destination (requested %d)",
					removed, best and best.name or "?", best and best.quality or "?", n_want))
			end
		end

		-- Engine-managed outputs (for example fusion plasma) reject external writes. Subtract only
		-- writes the engine physically rejected; capacity/partial-insert drops remain real gate failures.
		if fluids_result and fluids_result.write_rejected then
			adjusted_verification.fluid_counts = subtract_fluids_by_name(
				adjusted_verification.fluid_counts, fluids_result.write_rejected)
		end

		-- TEST HOOK (one-shot, debug-gated): inflate expected fluid volume before the single gate.
		do
			local _fluid_cfg = storage.surface_export_config
			if _fluid_cfg and _fluid_cfg.debug_mode and _fluid_cfg.test_force_fluid_loss
				and _fluid_cfg.test_force_fluid_loss > 0 then
				local n_want = _fluid_cfg.test_force_fluid_loss
				_fluid_cfg.test_force_fluid_loss = nil
				local best_key, best_amount = nil, -1
				for key, amount in pairs(adjusted_verification.fluid_counts or {}) do
					if type(amount) == "number" and amount > best_amount then
						best_key, best_amount = key, amount
					end
				end
				if best_key then
					local fluid_name = Util.parse_fluid_temp_key(best_key)
					local missing_key = Util.make_fluid_temp_key(fluid_name, -99999)
					local expected_loss = math.max(n_want, 1500)
					adjusted_verification.fluid_counts[missing_key] =
						(adjusted_verification.fluid_counts[missing_key] or 0) + expected_loss
					log(string.format("[TEST HOOK] Forced fluid loss: inflated missing expected %s by %.1f (largest real key %s=%.1f)",
						missing_key, expected_loss, best_key, best_amount))
				else
					log(string.format("[TEST HOOK] Forced fluid loss requested %.1f but no expected fluid key existed", n_want))
				end
			end
		end

		PhaseProfiler.start(job.job_id, "validation")
		local success, result = TransferValidation.validate_import(
			job.target_surface,
			adjusted_verification,
			{ strict = true, segment_temps = fluids_result and fluids_result.segment_temps }
		)

		-- TEST HOOK (one-shot, debug-gated): force a validation failure to exercise the rollback /
		-- two-phase-commit safety path. Set via configure({ test_force_validation_failure = true }).
		local _cfg = storage.surface_export_config
		if _cfg and _cfg.debug_mode and _cfg.test_force_validation_failure then
			_cfg.test_force_validation_failure = nil  -- consume: applies to one transfer only
			success = false
			result = result or {}
			-- Corrupt the SAME verdict fields the controller receives in the import-complete payload.
			-- Overriding only `success` leaves the count booleans true, so the payload would look like
			-- a contradictory pass to downstream readers.
			result.itemCountMatch = false
			result.fluidCountMatch = false
			result.failedStage = "items"
			result.success = false
			-- mismatchDetails is the field handleValidationFailure logs as the rollback reason;
			-- set it so CI logs read "Rolled back. Error: TEST ..." instead of "Unknown error".
			result.mismatchDetails = "TEST: forced validation failure (rollback safety test)"
			result.message = "TEST: validation failure forced (test_force_validation_failure)"
			result.testForcedFailure = true
			log("[TEST HOOK] Forcing validation failure to exercise rollback")
		end
		if job.test_forced_entity_failure then
			success = false
			result = result or {}
			result.success = false
			result.failedStage = "test_hook"
			result.mismatchDetails = "TEST: forced entity placement failure (source preserved)"
			result.testForcedEntityFailure = true
			log("[TEST HOOK] Forced entity failure made the transfer verdict fail-safe")
		end

		PhaseProfiler.stop(job.job_id, "validation")
		-- Clean validation-only boundary for the waterfall span (the existing
		-- validation_completed_tick at the end of run_phase2 also covers activation/fluids/loss).
		job.metrics.validation_done_tick = game.tick
		validation_result = result
		-- Informational entity accounting for the transfer details (DISPLAY ONLY, no verdict):
		-- reportedEntityCount is the source payload's entity total; result.entityCount (already set by
		-- validate_import from a live scan of the destination surface) is what actually landed. They
		-- legitimately differ — entities that fail to place, serialization-filtered item/character entities,
		-- belt-overflow surplus — so this is NOT a loss signal. The item/fluid strict gate remains the
		-- authoritative data-loss detector.
		result.reportedEntityCount = job.total_entities

		-- Attach failed entity losses to result so it flows through to the transaction log
		if job.failed_entity_losses and job.failed_entity_losses.entity_count > 0 then
			result.failedEntityLosses = job.failed_entity_losses
		end

		-- Attach inventory overflow losses to result
		if job.inventory_overflow_losses and job.inventory_overflow_losses.total > 0 then
			result.inventoryOverflowLosses = job.inventory_overflow_losses
		end

		-- Attach force-bonus sync notices (non-fatal): the dest force was under-researched relative to the
		-- source, so its inserter-capacity bonuses were RAISED to preserve held items. Surfaced in the UI so
		-- this global, raise-only side effect is visible/auditable. Does NOT affect validation success.
		if job.force_bonuses_mismatch and #job.force_bonuses_mismatch > 0 then
			result.forceDataMismatches = job.force_bonuses_mismatch
		end
		if fluids_result and table_size(fluids_result.dropped_fluids or {}) > 0 then
			result.droppedFluids = fluids_result.dropped_fluids
		end
		if fluids_result and table_size(fluids_result.write_rejected or {}) > 0 then
			result.writeRejectedFluids = fluids_result.write_rejected
		end

		TransferValidation.store_validation_result(validation_result_id, result)
		-- Debug export: Always write destination platform data when debug_mode is enabled
		-- This allows comparing source vs destination regardless of validation pass/fail
		if job.transfer_id and job.target_surface and job.target_surface.valid then
			local debug_success, debug_err = pcall(function()
				if DebugExport.is_enabled() then
					local scanned_entities = EntityScanner.scan_surface(job.target_surface)
					local destination_schedule = nil
					if job.target_platform and job.target_platform.valid then
						local captured_schedule, schedule_err = PlatformSchedule.capture(job.target_platform, job.target_platform.hub)
						if captured_schedule then
							destination_schedule = captured_schedule
						else
							log(string.format("[DebugExport] WARNING: Failed to capture destination schedule: %s", tostring(schedule_err)))
						end
					end
					local destination_data = {
						platform_name = job.platform_name,
						tick = game.tick,
						entities = scanned_entities,
						entity_count = #scanned_entities,
						platform = {
							name = job.target_platform and job.target_platform.name or job.platform_name,
							force = job.force_name,
							schedule = destination_schedule,
						},
					}
					DebugExport.export_destination_platform(destination_data, job.platform_name)
				else
					log("[DebugExport] Skipping destination platform export: debug_mode is not enabled")
				end
			end)
			if not debug_success then
				log(string.format("[DebugExport] ERROR: Failed to export destination platform: %s", tostring(debug_err)))
			end
		else
			log(string.format("[DebugExport] Skipping destination platform export: transfer_id=%s, surface_valid=%s",
				tostring(job.transfer_id), tostring(job.target_surface and job.target_surface.valid)))
		end

		if not success then
			game.print(string.format(
				"[Transfer Validation Failed] %s",
				result.mismatchDetails or "Unknown error"
			), {1, 0, 0})

			-- BLACK-BOX DISCARD: evidence is banked before the failed destination is destroyed.
			-- A black-box write failure is itself cleanup_failed: preserve the surface rather than
			-- destroying the only remaining evidence.
			local black_box_ok, black_box_result = pcall(bank_failure_black_box, job, result)
			if not black_box_ok or black_box_result ~= true then
				result.cleanup_failed = true
				result.cleanup_error = string.format("Failed to bank failure black box: %s", tostring(black_box_result))
				log(string.format("[Validation] ERROR: %s; destination preserved paused", result.cleanup_error))
			else
				local config = storage.surface_export_config or {}
				local preserve_failed = config.debug_mode == true and config.preserve_failed_destination == true
				if preserve_failed then
					config.preserve_failed_destination = nil
					result.destinationPreserved = true
					log("[Validation] Failed destination preserved paused by one-shot debug configuration; flag consumed")
				else
					local evacuated, evacuation_err = pcall(function()
						if not job.target_platform or not job.target_platform.valid then
							error("target platform is not valid")
						end
						Gateway.evacuate_passengers(job.target_platform)
					end)
					local discarded = false
					if evacuated then
						local delete_ok, delete_result = pcall(GameUtils.delete_platform, job.target_platform)
						discarded = delete_ok and delete_result == true
						if not delete_ok then evacuation_err = delete_result end
					end
					if discarded then
						log("[Validation] Failed destination discarded after black-box capture")
					else
						result.cleanup_failed = true
						result.cleanup_error = evacuated
							and string.format("GameUtils.delete_platform failed: %s", tostring(evacuation_err or "returned false"))
							or string.format("Passenger evacuation failed: %s", tostring(evacuation_err))
						log(string.format("[Validation] ERROR: cleanup_failed for %s: %s",
							tostring(job.platform_name), result.cleanup_error))
					end
				end
			end
		else
			-- Validation passed. Everything below is post-verdict and cannot alter gate fields.
			if job.target_platform and job.target_platform.valid then
				job.target_platform.paused = false
				log(string.format("[Validation] Platform %s UNPAUSED after successful validation", job.platform_name))
			end
			PhaseProfiler.start(job.job_id, "activation")
			ActiveStateRestoration.restore(job.entities_to_create or {}, job.entity_map or {}, job.frozen_states or {})
			PhaseProfiler.stop(job.job_id, "activation")

			if result.totalExpectedItems then
				PhaseProfiler.start(job.job_id, "loss_analysis")
				LossAnalysis.run(job.target_surface, entities_to_create, result, fluids_result and fluids_result.segment_temps)
				PhaseProfiler.stop(job.job_id, "loss_analysis")
				local post_counts = result.postActivationReport and result.postActivationReport.actualFluidCounts or {}
				local post_diff = build_count_diff(
					aggregate_fluid_counts_by_name(result.actualFluidCounts),
					aggregate_fluid_counts_by_name(post_counts)
				)
				log(string.format("[Validation] Non-gating post-activation fluid recount: %d changed fluid names",
					table_size(post_diff)))
			end
			game.print(string.format("[Validation] Validation passed - entities activated on platform %s!",
				job.platform_name), {0, 1, 0})

			-- GATEWAY TRANSFER: park the platform AT the gateway, paused, instead of letting the
			-- restored schedule fly it there. The unpause above and this all run in one synchronous
			-- tick, so no flight happens in between. Placement is instant (verified on 2.0.76); pausing
			-- holds it until the player resumes. nil for normal transfers — they keep the unpause above.
			-- PAUSE FIRST (its own pcall), THEN place: if the space_location write throws, the platform
			-- is still safely parked-paused rather than flying off next tick.
			if success and job.gateway_target and job.target_platform and job.target_platform.valid then
				local tp = job.target_platform
				-- Unlock the gateway for the platform's force first (a force created after the startup
				-- discover_and_unlock pass wouldn't have it; placement needs a reachable location).
				-- Log on failure: this unlock is a PREREQUISITE for the space_location write below, so a
				-- silent failure here surfaces only as a mysterious "Park INCOMPLETE / location unreachable"
				-- with no root cause. (No data loss either way — pause-first keeps the platform safe.)
				local ok_unlock, err_unlock = pcall(function() tp.force.unlock_space_location(job.gateway_target) end)
				if not ok_unlock then
					log(string.format("[Gateway] unlock_space_location('%s') failed before park for %s: %s",
						tostring(job.gateway_target), tostring(job.platform_name), tostring(err_unlock)))
				end
				-- Pause FIRST so a placement throw leaves it safely parked-paused, not flying the stripped route.
				-- pcall:allow — err_pause and err_loc are BOTH logged jointly in the else branch below; the
				-- pcall-logging linter's scan just stops at the adjacent pcall on the next line and can't see it.
				local ok_pause, err_pause = pcall(function() tp.paused = true end)
				local ok_loc, err_loc = pcall(function() tp.space_location = job.gateway_target end)
				if ok_pause and ok_loc then
					log(string.format("[Gateway] Platform %s arrived PAUSED at gateway '%s'",
						job.platform_name, job.gateway_target))
				else
					-- Report BOTH outcomes — a silent pause failure would leave the platform unpaused.
					log(string.format("[Gateway] Park INCOMPLETE for %s at '%s' — paused=%s (%s), placed=%s (%s)",
						job.platform_name, job.gateway_target,
						tostring(ok_pause), tostring(err_pause), tostring(ok_loc), tostring(err_loc)))
				end
			end
			-- ========================================
		end

	end

	-- Mark validation complete
	job.metrics.validation_completed_tick = game.tick

	storage.async_job_results[job.job_id] = {
		status = "complete",
		complete = true,
		type = "import",
		job_id = job.job_id,
		platform_name = job.platform_name,
		total_entities = job.total_entities,
		duration_ticks = duration_ticks,
		duration_seconds = duration_seconds,
		progress = 100,
		requester = job.requester,
		validation = validation_result,
		metrics = job.metrics
	}

	if clusterio_api and clusterio_api.send_json then
		-- Waterfall phase spans: absolute start offsets (from job.started_tick) + durations, in
		-- pipeline order. Built purely from already-recorded tick marks; nils (e.g. validation on
		-- non-transfer imports) are skipped so they don't appear as zero-width spans.
		local m = job.metrics
		-- Unified t0 = first-chunk arrival when available (so delivery/queue/phases share one origin),
		-- else the job start tick.
		local t0 = m.delivery_started_tick or job.started_tick or 0
		local phase_spans = {}
		local function add_span(name, started_tick, completed_tick)
			local sp = build_phase_span(name, started_tick, completed_tick, t0)
			if sp then phase_spans[#phase_spans + 1] = sp end
		end
		-- Cross-machine front of the import: chunked-RCON delivery, then the async-queue wait.
		add_span("delivery", m.delivery_started_tick, m.delivery_completed_tick)
		add_span("queue", job.started_tick, m.tiles_started_tick)
		add_span("tiles", m.tiles_started_tick, m.tiles_completed_tick)
		add_span("entities", m.entities_started_tick, m.entities_completed_tick)
		add_span("belts", m.belts_started_tick, m.belts_completed_tick)
		add_span("state", m.state_started_tick, m.state_completed_tick)
		add_span("inventories", m.inventories_started_tick, m.inventories_completed_tick)
		add_span("fluids", m.fluids_started_tick, m.fluids_completed_tick)
		add_span("validation", m.validation_started_tick, m.validation_done_tick)

		emit_debug_import_result(job, validation_result, duration_seconds)

		local event_payload = {
			job_id = job.job_id,
			platform_name = job.platform_name,
			entity_count = job.total_entities,
			duration_ticks = duration_ticks,
			-- Include detailed phase metrics
			metrics = {
				-- Timing in ticks (can convert to ms on JS side: ticks / 60 * 1000)
				tiles_ticks = (job.metrics.tiles_completed_tick or 0) - (job.metrics.tiles_started_tick or 0),
				entities_ticks = (job.metrics.entities_completed_tick or job.metrics.entities_started_tick or 0) - (job.metrics.entities_started_tick or 0),
				fluids_ticks = (job.metrics.fluids_completed_tick or 0) - (job.metrics.fluids_started_tick or 0),
				belts_ticks = (job.metrics.belts_completed_tick or 0) - (job.metrics.belts_started_tick or 0),
				state_ticks = (job.metrics.state_completed_tick or 0) - (job.metrics.state_started_tick or 0),
				validation_ticks = (job.metrics.validation_completed_tick or 0) - (job.metrics.validation_started_tick or 0),
				total_ticks = duration_ticks,
				-- Counts
				tiles_placed = job.metrics.tiles_placed or 0,
				entities_created = job.metrics.entities_created or 0,
				entities_failed = job.metrics.entities_failed or 0,
				fluids_restored = job.metrics.fluids_restored or 0,
				belt_items_restored = job.metrics.belt_items_restored or 0,
				circuits_connected = job.metrics.circuits_connected or 0,
				-- Totals from source data
				total_items = job.total_items or 0,
				total_fluids = job.total_fluids or 0,
				-- Waterfall trace: per-phase {name, start_offset_ms, duration_ms} (segment-relative)
				phase_spans = phase_spans,
			}
		}
		event_payload.success = validation_result and validation_result.success == true

		-- Include transfer metadata if available
		if job.transfer_id then
			event_payload.transfer_id = job.transfer_id
			event_payload.source_instance_id = job.source_instance_id

			-- Include validation result for transfers
			if validation_result then
				event_payload.validation = validation_result
			end

			log(string.format("[send_json] Import complete with transfer metadata: transfer_id=%s, source=%s",
				job.transfer_id, tostring(job.source_instance_id)))
		end
		if job.operation_id then
			event_payload.operation_id = job.operation_id
			log(string.format("[send_json] Import complete with operation metadata: operation_id=%s",
				tostring(job.operation_id)))
		end
		clusterio_api.send_json("surface_export_import_complete", event_payload)
	end

	-- Performance summary (profiler values are display-only, not serializable to JSON)
	local perf = PhaseProfiler.get(job.job_id)
	if perf then
		local tiles_ms = math.floor(((job.metrics.tiles_completed_tick or 0) - (job.metrics.tiles_started_tick or 0)) * 16.67)
		local entities_ms = math.floor(((job.metrics.entities_completed_tick or 0) - (job.metrics.entities_started_tick or 0)) * 16.67)
		-- CRITICAL: Each print must stay below the 20-parameter LocalisedString limit.
		game.print({"", "[Perf] Import '", job.platform_name, "' (", job.total_entities, " entities)"})
		game.print({"", "  Setup:         ", perf.queue_setup})
		game.print({"", "  Tiles:         ", tiles_ms, "ms"})
		game.print({"", "  Beacons:       ", perf.beacons})
		game.print({"", "  Entities:      ", entities_ms, "ms"})
		game.print({"", "  Hub restore:   ", perf.hub_restore})
		game.print({"", "  Belts:         ", perf.belts})
		game.print({"", "  State:         ", perf.state})
		game.print({"", "  Inventories:   ", perf.inventories})
		game.print({"", "  Validation:    ", perf.validation})
		game.print({"", "  Activation:    ", perf.activation})
		game.print({"", "  Fluids:        ", perf.fluids})
		game.print({"", "  Loss analysis: ", perf.loss_analysis})
		
		-- Record to transaction history BEFORE discarding profilers
		TransactionHistory.record_import(job, validation_result, perf)
		
		PhaseProfiler.discard(job.job_id)
	end

	JobResults.prune(25)

	storage.async_jobs[job.job_id] = nil
end

return ImportCompletion
