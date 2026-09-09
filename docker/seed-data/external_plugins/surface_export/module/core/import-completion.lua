local Timing = require("modules/surface_export/utils/operation-timing")
local Deserializer = require("modules/surface_export/core/deserializer")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local FluidRegistry = require("modules/surface_export/export_scanners/fluid-registry")
local FluidRestoration = require("modules/surface_export/import_phases/fluid_restoration")
local EntityStateRestoration = require("modules/surface_export/import_phases/entity_state_restoration")
local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")
local BeltBatches = require("modules/surface_export/import_phases/belt_batches")
local ActiveStateRestoration = require("modules/surface_export/import_phases/active_state_restoration")
local LatchRearm = require("modules/surface_export/import_phases/latch_rearm")
local PlatformHubMapping = require("modules/surface_export/import_phases/platform_hub_mapping")
local TransferValidation = require("modules/surface_export/validators/transfer-validation")
local DebugExport = require("modules/surface_export/utils/debug-export")
local PlatformSchedule = require("modules/surface_export/utils/platform-schedule")
local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local GameUtils = require("modules/surface_export/utils/game-utils")
local Gateway = require("modules/surface_export/core/gateway")
local DestinationHold = require("modules/surface_export/core/destination-hold")
local Util = require("modules/surface_export/utils/util")
local clusterio_api = require("modules/clusterio/api")
local PhaseProfiler = require("modules/surface_export/utils/phase-profiler")
local PhaseRecorder = require("modules/surface_export/utils/phase-recorder")
local TransactionHistory = require("modules/surface_export/utils/transaction-history")
local JobResults = require("modules/surface_export/core/job-results")

local ImportCompletion = {}

-- An exception can follow a partial write or a published verdict. Never replay that
-- callback. Retain the job for diagnosis and quarantine its destination for review.
function ImportCompletion.interrupt(job, err)
	job.completion_interrupted = {error = tostring(err), tick = game.tick}
	local result = (storage.async_job_results or {})[job.job_id]
	if result then
		result.status, result.complete, result.error = "interrupted", false, tostring(err)
	end
	local protected, protection_error = pcall(function()
		local platform = job.target_platform
		if not (platform and platform.valid) then return end
		local id = job.transfer_id or ("interrupted:" .. job.job_id)
		local held, hold_error = DestinationHold.stage(id, platform, game.forces[job.force_name or "player"], true)
		local hold = DestinationHold.get(id)
		if hold and hold.platform_index == platform.index and hold.surface_index == job.target_surface.index then
			-- This is not a validated hold: recovery must not delete the source for it.
			hold.preparation_failed = true
		end
		assert(held, hold_error)
	end)
	if not protected then log("[Import] Interrupted destination protection failed: " .. tostring(protection_error)) end
	Timing.finish(job.job_id, "interrupted")
end

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

local function scan_surface_with_registry(surface)
	local registry = FluidRegistry.new()
	InventoryScanner.fluid_registry = registry
	local ok, entities = pcall(EntityScanner.scan_surface, surface)
	InventoryScanner.fluid_registry = nil
	if not ok then
		log("[Import] forensic surface scan failed: " .. tostring(entities))
		return nil, nil, tostring(entities)
	end
	return entities, FluidRegistry.list(registry)
end


local function emit_debug_import_result(job, validation_result, duration_ticks)
	if not job.transfer_id then return end
	local ok, err = pcall(function()
		DebugExport.export_import_result({
			platform_name = job.platform_name,
			transfer_id = job.transfer_id,
			validation_success = validation_result and validation_result.success == true,
			validation_result = validation_result,
			duration_ticks = duration_ticks,
			total_entities = job.total_entities,
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

local function sweep_created_logistic_groups(job)
	local names = job.created_logistic_groups
	if type(names) ~= "table" or #names == 0 then
		return
	end
	local force = game.forces[job.force_name]
	if not force then
		log(string.format("[Validation] Cannot sweep %d import-created logistic group(s): force '%s' not found",
			#names, tostring(job.force_name)))
		return
	end
	local swept = 0
	for _, name in ipairs(names) do
		local ok, err = pcall(function() force.delete_logistic_group(name) end)
		if ok then
			swept = swept + 1
		else
			log(string.format("[Validation] delete_logistic_group('%s') failed during discard sweep: %s",
				tostring(name), tostring(err)))
		end
	end
	log(string.format("[Validation] Swept %d/%d import-created logistic group(s) after discard", swept, #names))
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
	local physical_entities, physical_fluid_segments, capture_error = scan_surface_with_registry(job.target_surface)
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
		physical_entities = physical_entities,
		physical_fluid_segments = physical_fluid_segments,
		physical_capture_available = capture_error == nil,
		physical_capture_error = capture_error,
		belt_lines = BeltRestoration.attribute_lines(job.entities_to_create or {}, job.entity_map or {}),
		replay_payload = job.platform_data,
	}
	local written = DebugExport.write_failure_black_box(filename, bundle)
	result.failureBlackBox = { file = written, tick = game.tick }
	return written ~= nil
end

local function record_item_state(job, session)
	if not session then return end
	job.metrics = job.metrics or {}
	job.metrics.inventory_state_applied = (job.metrics.inventory_state_applied or 0) + session.applied
	job.metrics.inventory_state_declined = (job.metrics.inventory_state_declined or 0) + session.declined
	job.metrics.inventory_state_failed = (job.metrics.inventory_state_failed or 0) + session.failed
end

local function log_item_state(job)
	local applied = job.metrics.inventory_state_applied or 0
	local declined = job.metrics.inventory_state_declined or 0
	local failed = job.metrics.inventory_state_failed or 0
	if applied + declined + failed > 0 then
		log(string.format("[Import] INVENTORY ITEM STATE %s: applied %d | declined %d | failed %d",
			tostring((job.target_platform and job.target_platform.valid and job.target_platform.name)
				or job.platform_name),
			applied, declined, failed))
	end
end

local function restore_belt_batch(job)
	local entity_map = job.entity_map or {}
	local entities_to_create = job.entities_to_create or {}

	PhaseRecorder.start(job, "belts")
	local belts_result
	local more_belts = false
	local side_groups = job.platform_data and job.platform_data.belt_side_groups
	if side_groups and #side_groups > 0 then
		local total_side_groups = #side_groups
		local placed, unplaced, anomalies
		local shape_ok, shape_err = true, nil
		if not job.belt_batches then shape_ok, shape_err = BeltRestoration.validate_side_groups(side_groups) end
		if not shape_ok then
			log(string.format("[Import] belt_side_groups REFUSED (malformed payload): %s", tostring(shape_err)))
			job.metrics.belt_shape_error = tostring(shape_err)
			placed, unplaced, anomalies = 0, 0, 1
		else
			if not job.belt_batches then
				local cfg = storage.surface_export_config or {}
				local ok_plan, plan = pcall(BeltBatches.plan, side_groups, entity_map, cfg.belt_batch_size or 500)
				if not ok_plan then
					log("[Import] Belt batch planning failed; using one atomic batch: " .. tostring(plan))
					local indices = {}; for i in ipairs(side_groups) do indices[#indices + 1] = i end
					plan = { batches = {{ indices = indices, cost = 0 }}, cursor = 1, networks = 1 }
				end
				plan.placed, plan.unplaced, plan.anomalies, plan.state = 0, 0, 0, {}
				job.belt_batches = plan
				job.metrics.belt_networks = plan.networks
				log(string.format("[Import] Belt restoration: %d network(s), %d batch(es)%s", plan.networks,
					#plan.batches, plan.atomic_reason and ("; atomic: " .. plan.atomic_reason) or ""))
			end
			local progress = job.belt_batches
			local batch = progress.batches[progress.cursor]
			local slice = {}; for _, i in ipairs(batch.indices) do slice[#slice + 1] = side_groups[i] end
			side_groups = slice
			job.metrics.belt_restore_batches = (job.metrics.belt_restore_batches or 0) + 1
			job.metrics.belt_max_batch_work = math.max(job.metrics.belt_max_batch_work or 0, batch.cost)
			local restore_fn = BeltRestoration.restore_side_groups
			local ok_restore, r_placed, r_unplaced, r_anomalies, _, r_state = pcall(restore_fn, side_groups,
				entity_map, job.target_platform and job.target_platform.name or job.platform_name)
			if not ok_restore then
				log(string.format("[Import] belt side-restore THREW (routed to verdict, never error()): %s",
					tostring(r_placed)))
				job.metrics.belt_restore_error = tostring(r_placed)
				placed, unplaced, anomalies = progress.placed, progress.unplaced, progress.anomalies + 1
			else
				progress.placed = progress.placed + r_placed
				progress.unplaced = progress.unplaced + r_unplaced
				progress.anomalies = progress.anomalies + r_anomalies
				placed, unplaced, anomalies = progress.placed, progress.unplaced, progress.anomalies
				if r_state then
					for key, value in pairs(r_state) do progress.state[key] = (progress.state[key] or 0) + value end
					r_state = progress.state
					job.metrics.belt_state_applied = r_state.applied
					job.metrics.belt_state_unmatched = r_state.unmatched
					job.metrics.belt_state_failed = r_state.failed
					job.metrics.belt_state_merge_discarded = r_state.merge_discarded
					job.metrics.belt_state_declined = r_state.declined
				end
				progress.cursor = progress.cursor + 1
				more_belts = unplaced == 0 and anomalies == 0 and progress.cursor <= #progress.batches
					and (progress.state.failed or 0) == 0 and (progress.state.unmatched or 0) == 0
					and (progress.state.declined or 0) == 0
			end
		end
		belts_result = { items_restored = placed, attribution = nil }
		job.metrics.belt_side_groups = total_side_groups
		job.metrics.belt_unplaced = unplaced
		job.metrics.belt_anomalies = anomalies
		if unplaced > 0 then
			log(string.format("[Import] Side restore UNPLACED: placed=%d unplaced=%d", placed, unplaced))
		end
		if anomalies > 0 then
			log(string.format("[Import] BELT ANOMALIES: %d (placed=%d unplaced=%d) — verdict will refuse",
				anomalies, placed, unplaced))
		end
	else
		local has_belt_items = false
		for _, entity_data in ipairs(entities_to_create or {}) do
			local line_list = entity_data.specific_data and entity_data.specific_data.items
			if type(line_list) == "table" then
				for _, line_data in ipairs(line_list) do
					if type(line_data) == "table" and line_data.line ~= nil
						and type(line_data.items) == "table" and #line_data.items > 0 then
						has_belt_items = true
						break
					end
				end
			end
			if has_belt_items then break end
		end
		if has_belt_items then
			log("[Import] REFUSED: payload carries belt items but no belt_side_groups (export predates captured source positions)"
				.. " — re-export from the source with the current version")
			job.metrics.belt_shape_error = "payload predates captured source positions (no belt_side_groups); the legacy restore is deleted"
			job.metrics.belt_anomalies = 1
		end
		belts_result = { items_restored = 0 }
	end
	PhaseRecorder.stop(job, "belts")
	job.metrics.belt_items_restored = belts_result and belts_result.items_restored or 0
	if more_belts then return false end
	job.belt_batches = nil
	return true
end

function ImportCompletion.run_phase1(job)
	local entity_map = job.entity_map or {}
	local entities_to_create = job.entities_to_create or {}

	if not job.phase1_started then
		PhaseRecorder.start(job, "hub")
		local hub_item_state = Deserializer.new_item_state_session()
		local hub_ok, hub_err = pcall(PlatformHubMapping.restore_hub_inventories, job, hub_item_state)
		Deserializer.release_item_state_session(hub_item_state)
		record_item_state(job, hub_item_state)
		if not hub_ok then error(hub_err, 0) end
		PhaseRecorder.stop(job, "hub")
		job.phase1_started = true
		return
	end

	if not job.belts_complete then
		job.belts_complete = restore_belt_batch(job)
		return
	end

	PhaseRecorder.start(job, "state")
	local state_result = EntityStateRestoration.restore_all(entities_to_create, entity_map)
	PhaseRecorder.stop(job, "state")
	job.metrics.circuits_connected = state_result and state_result.circuits_connected or 0
	job.metrics.copper_pruned = state_result and state_result.copper_pruned or 0
	job.metrics.proxies_linked = state_result and state_result.proxies_linked or 0
	job.created_logistic_groups = state_result and state_result.created_logistic_groups or nil

	Timing.start(job.job_id, "deferred_beacon_wait", "wait")
	job.pending_beacon_tick = game.tick + 1
	log(string.format("[Import] Phase 1 complete (tick %d). Inventory restore scheduled for tick %d", game.tick, job.pending_beacon_tick))
end

local function restore_inventories(job, budget)
	local entity_map = job.entity_map or {}
	local entities_to_create = job.entities_to_create or {}

	if not job.inventory_overflow_losses then
		job.inventory_overflow_losses = { total = 0, items = {}, entities = {} }
	end
	PhaseRecorder.start(job, "inventories")
	local cursor = job.inventory_cursor or {index = 1, beacons = true, restored = 0, skipped = 0}
	job.inventory_cursor = cursor
	local inv_item_state = Deserializer.new_item_state_session()
	local inv_ok, inv_err = pcall(function()
		local work = 0
		while work < budget do
			if cursor.index > #entities_to_create then
				if not cursor.beacons then break end
				cursor.beacons, cursor.index = false, 1
			end
			local entity_data = entities_to_create[cursor.index]
			if not entity_data then break end
			work = work + 1
			if entity_data.entity_id and ((entity_data.type == "beacon") == cursor.beacons) then
				local entity = entity_map[entity_data.entity_id]
				if entity and entity.valid then
					Deserializer.restore_inventories(entity, entity_data, job.inventory_overflow_losses, inv_item_state)
					-- Reassert dormancy before every yield, not after the entire inventory pass.
					if GameUtils.ACTIVATABLE_ENTITY_TYPES[entity.type] then entity.disabled_by_script = true end
					for _, inventory in ipairs((entity_data.specific_data or {}).inventories or {}) do
						work = work + #(inventory.items or {})
					end
					cursor.restored = cursor.restored + 1
				else cursor.skipped = cursor.skipped + 1 end
			end
			-- An entity inventory remains atomic; progress advances only after its writes finish.
			cursor.index = cursor.index + 1
		end
	end)
	Deserializer.release_item_state_session(inv_item_state)
	record_item_state(job, inv_item_state)
	if not inv_ok then error(inv_err, 0) end
	PhaseRecorder.stop(job, "inventories")
	if cursor.beacons or cursor.index <= #entities_to_create then
		job.metrics.inventories_completed_tick = nil
		return false
	end
	log_item_state(job)
	log(string.format("[Import] Inventory restoration: %d entities restored, %d skipped", cursor.restored, cursor.skipped))
	if job.inventory_overflow_losses.total > 0 then
		log(string.format("[Import] Inventory overflow losses: %d items lost (set_stack API cap)", job.inventory_overflow_losses.total))
	end
	job.inventory_cursor = nil
	if job.transfer_id and job.target_platform and job.target_platform.valid then
		job.target_platform.paused = true
		log(string.format("[Import] Platform %s re-paused for validation (tick %d)", job.platform_name, game.tick))
	end
	return true
end

function ImportCompletion.run_phase2(job, batch_size)
	job.metrics = job.metrics or {}
	local entity_map = job.entity_map or {}
	local entities_to_create = job.entities_to_create or {}

	-- Persist only the next phase; inventory scratch objects are released before yielding.
	if not job.phase2_stage then
		Timing.stop(job.job_id, "deferred_beacon_wait")
		if not restore_inventories(job, (batch_size or 50) * 10) then return end
		job.phase2_stage = "held_items"
		return
	end
	if job.phase2_stage == "held_items" then
		PhaseRecorder.start(job, "held_items")
		ActiveStateRestoration.restore_held_items_only(entities_to_create, entity_map)
		PhaseRecorder.stop(job, "held_items")
		job.phase2_stage = "finish"
		return
	end

	local duration_ticks = game.tick - job.started_tick
	local validation_result_id = job.transfer_id or job.job_id
	local frozen_states = job.frozen_states or {}
	local _dbg_cfg = storage.surface_export_config
	local defer_clone = _dbg_cfg and _dbg_cfg.debug_mode and _dbg_cfg.test_defer_clone_activation
	-- Keep injection, the exact cargo gate and activation in one callback: fluid
	-- temperatures and amounts may change if the simulation advances between them.
	PhaseRecorder.start(job, "fluids")
	local fluids_result = FluidRestoration.restore(entities_to_create, entity_map,
		job.platform_data and job.platform_data.fluid_segments)
	PhaseRecorder.stop(job, "fluids")
	job.metrics.fluids_restored = fluids_result and fluids_result.count or 0
	log(string.format("[Import] Frozen-world fluid restoration: %d fluids restored", job.metrics.fluids_restored))

	if job.transfer_id then
		log("[Import] Deferring active state restoration until after the exact transfer gate")
	elseif defer_clone then
		log("[Import][TEST] test_defer_clone_activation set — clone left DEACTIVATED with frozen fluids restored")
	else
		PhaseRecorder.start(job, "activation")
		ActiveStateRestoration.restore(entities_to_create, entity_map, frozen_states)
		PhaseRecorder.stop(job, "activation")
	end

	log("[Import] Post-processing complete")

	local message = string.format(
		"[Import Complete] %s (%d entities; %d ticks elapsed)",
		job.platform_name, job.total_entities, duration_ticks
	)
	game.print(message, {0, 1, 0})
	log(message)

	if job.requester == "RCON" then
		rcon.print(string.format("IMPORT_COMPLETE:%s", job.platform_name))
	end

	Timing.start(job.job_id, "verdict_handling", "inclusive")
	job.metrics.validation_started_tick = game.tick

	local validation_result = nil
	local is_transfer = job.transfer_id ~= nil
	local has_platform_data = job.platform_data ~= nil
	local has_verification = has_platform_data and job.platform_data.verification ~= nil

	if is_transfer and has_verification then
		Timing.start(job.job_id, "verification_preparation")

		local cargo_expectations = {
			item_counts = copy_counts(job.platform_data.verification.item_counts),
			fluid_counts = copy_counts(job.platform_data.verification.fluid_counts),
		}
		do
			local _cfg2 = storage.surface_export_config
			if _cfg2 and _cfg2.debug_mode and _cfg2.test_force_item_loss and _cfg2.test_force_item_loss > 0 then
				local n_want = _cfg2.test_force_item_loss
				_cfg2.test_force_item_loss = nil
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

		do
			local _fluid_cfg = storage.surface_export_config
			if _fluid_cfg and _fluid_cfg.debug_mode and _fluid_cfg.test_force_fluid_loss
				and _fluid_cfg.test_force_fluid_loss > 0 then
				local n_want = _fluid_cfg.test_force_fluid_loss
				_fluid_cfg.test_force_fluid_loss = nil
				local best_key, best_amount = nil, -1
				for key, amount in pairs(cargo_expectations.fluid_counts or {}) do
					if type(amount) == "number" and amount > best_amount then
						best_key, best_amount = key, amount
					end
				end
				if best_key then
					local fluid_name = Util.parse_fluid_temp_key(best_key)
					local missing_key = Util.make_fluid_temp_key(fluid_name, -99999)
					local expected_loss = math.max(n_want, 1500)
					cargo_expectations.fluid_counts[missing_key] =
						(cargo_expectations.fluid_counts[missing_key] or 0) + expected_loss
					log(string.format("[TEST HOOK] Forced fluid loss: inflated missing expected %s by %.1f (largest real key %s=%.1f)",
						missing_key, expected_loss, best_key, best_amount))
				else
					log(string.format("[TEST HOOK] Forced fluid loss requested %.1f but no expected fluid key existed", n_want))
				end
			end
		end

		Timing.stop(job.job_id, "verification_preparation")
		Timing.start(job.job_id, "exact_verification")
		PhaseProfiler.start(job.job_id, "validation")
		local success, result = TransferValidation.validate_import(
			job.target_surface,
			cargo_expectations,
			{ strict = true, segment_temps = fluids_result and fluids_result.segment_temps, timing_job_id = job.job_id }
		)

		local _cfg = storage.surface_export_config
		if _cfg and _cfg.debug_mode and _cfg.test_force_validation_failure then
			_cfg.test_force_validation_failure = nil
			success = false
			result = result or {}
			result.itemCountMatch = false
			result.fluidCountMatch = false
			result.failedStage = "items"
			result.success = false
			result.mismatchDetails = "TEST: forced validation failure (rollback safety test)"
			result.message = "TEST: validation failure forced (test_force_validation_failure)"
			result.testForcedFailure = true
			log("[TEST HOOK] Forcing validation failure to exercise rollback")
		end
		if job.failed_entity_losses and job.failed_entity_losses.entity_count > 0 then
			success = false
			result.success = false
			result.failedStage = result.failedStage or "entities"
			result.mismatchDetails = (result.mismatchDetails and (result.mismatchDetails .. "; ") or "")
				.. string.format("%d entities failed to restore", job.failed_entity_losses.entity_count)
			result.testForcedEntityFailure = job.test_forced_entity_failure or nil
		end
		if (job.metrics and job.metrics.belt_anomalies or 0) > 0 then
			success = false
			result = result or {}
			result.success = false
			result.failedStage = result.failedStage or "belts"
			result.mismatchDetails = string.format(
				"belt side-restore reported %d structural anomalies (bracket/side witness)%s",
				job.metrics.belt_anomalies,
				job.metrics.belt_shape_error and (" — payload refused: " .. job.metrics.belt_shape_error)
					or (job.metrics.belt_restore_error and (" — restore error: " .. job.metrics.belt_restore_error) or ""))
			log("[Import] Verdict REFUSED on belt structural anomalies: " .. tostring(job.metrics.belt_anomalies))
		end

		PhaseProfiler.stop(job.job_id, "validation")
		Timing.stop(job.job_id, "exact_verification")
		if not success then Timing.fail(job.job_id, "exact_verification") end

		job.metrics.validation_done_tick = game.tick
		validation_result = result
		result.reportedEntityCount = job.total_entities

		if job.failed_entity_losses and job.failed_entity_losses.entity_count > 0 then
			result.failedEntityLosses = job.failed_entity_losses
		end

		if job.inventory_overflow_losses and job.inventory_overflow_losses.total > 0 then
			result.inventoryOverflowLosses = job.inventory_overflow_losses
		end

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
		if success and job.transfer_id and job.target_surface and job.target_surface.valid then
			local debug_success, debug_err = pcall(function()
				if DebugExport.destination_snapshot_enabled() then
					Timing.start(job.job_id, "diagnostic_capture")
					local scanned_entities, scanned_fluid_segments, capture_error = scan_surface_with_registry(job.target_surface)
					if capture_error then
						Timing.stop(job.job_id, "diagnostic_capture")
						Timing.fail(job.job_id, "diagnostic_capture")
						error("Destination snapshot unavailable: " .. capture_error)
					end
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
						fluid_segments = scanned_fluid_segments,
						entity_count = #scanned_entities,
						platform = {
							name = job.target_platform and job.target_platform.name or job.platform_name,
							force = job.force_name,
							schedule = destination_schedule,
						},
					}
					Timing.stop(job.job_id, "diagnostic_capture")
					local written = Timing.scope(job.job_id, "diagnostic_output", DebugExport.export_destination_platform, destination_data, job.platform_name)
					if not written then
						Timing.fail(job.job_id, "diagnostic_output")
						error("Destination snapshot unavailable: JSON output failed")
					end
				end
			end)
			if not debug_success then
				log(string.format("[DebugExport] ERROR: Failed to export destination platform: %s", tostring(debug_err)))
			end
		end

		-- Finalize and hold in one callback: no simulation tick runs between activation
		-- state restoration and the hold taking ownership of that state.
		if success then
			local prepared, prepare_error = pcall(function()
				if job.target_platform and job.target_platform.valid then
					job.target_platform.paused = false
					log(string.format("[Validation] Platform %s UNPAUSED after successful validation", job.platform_name))
				end
				PhaseRecorder.start(job, "activation")
				ActiveStateRestoration.restore(job.entities_to_create or {}, job.entity_map or {}, job.frozen_states or {})
				PhaseRecorder.stop(job, "activation")


				game.print(string.format("[Validation] Validation passed - platform %s prepared; awaiting source deletion",
					job.platform_name), {0, 1, 0})

				if success and job.park_target and job.target_platform and job.target_platform.valid then
					local tp = job.target_platform
					local ok_pause, err_pause = pcall(function() tp.paused = true end)
					if not ok_pause then
						log(string.format("[Gateway] Pause write failed for %s: %s", job.platform_name, tostring(err_pause)))
					end
					local at_park = tp.space_location ~= nil and tp.space_location.name == job.park_target
					if ok_pause and not at_park then
						local ok_repark, err_repark = pcall(function() tp.space_location = job.park_target end)
						if not ok_repark then
							log(string.format("[Gateway] Re-park write failed for %s at '%s': %s",
								job.platform_name, job.park_target, tostring(err_repark)))
						end
						at_park = tp.valid and tp.space_location ~= nil and tp.space_location.name == job.park_target
						if at_park then
							log(string.format("[Gateway] Platform %s RE-PARKED at '%s' after activation — the schedule had pulled it off the park",
								job.platform_name, job.park_target))
						end
					end
					result.gatewayParked = (ok_pause and at_park) or false
					if ok_pause and at_park then
						log(string.format("[Gateway] Platform %s arrived PAUSED at '%s' (parked at creation)",
							job.platform_name, job.park_target))
					else
						log(string.format("[Gateway] Park INCOMPLETE for %s at '%s' — paused=%s (%s), at_park=%s (location=%s)",
							job.platform_name, job.park_target,
							tostring(ok_pause), tostring(err_pause), tostring(at_park),
							tostring(tp.space_location and tp.space_location.name)))
					end
				end

				if not job.park_target and job.target_platform and job.target_platform.valid then
					local tp = job.target_platform
					local captured_paused = job.platform_data.platform.paused == true
					local ok_captured, err_captured = pcall(function() tp.paused = captured_paused end)
					result.sourcePaused = captured_paused
					result.sourcePausedApplied = ok_captured == true
					if ok_captured then
						log(string.format("[Import] Platform %s settled at the CAPTURED paused=%s (tick %d)",
							job.platform_name, tostring(captured_paused), game.tick))
					else
						log(string.format("[Import] Captured pause write failed for %s (captured %s): %s",
							job.platform_name, tostring(captured_paused), tostring(err_captured)))
					end
				end
				local held, hold_error = DestinationHold.stage(job.transfer_id, job.target_platform, game.forces[job.force_name or "player"], true)
				assert(held, hold_error)
				result.destinationHeld = true
				LatchRearm.schedule(job)
			end)
			if not prepared then
				success = false
				result.success = false
				result.failedStage = "destination_hold"
				result.mismatchDetails = "Destination preparation failed: " .. tostring(prepare_error)
				log("[Import] " .. result.mismatchDetails)
			end
		end

		if not success then
			game.print(string.format(
				"[Transfer Validation Failed] %s",
				result.mismatchDetails or "Unknown error"
			), {1, 0, 0})

			Timing.start(job.job_id, "failure_diagnostics")
			local black_box_ok, black_box_result = pcall(bank_failure_black_box, job, result)
			Timing.stop(job.job_id, "failure_diagnostics")
			if not black_box_ok or black_box_result ~= true then Timing.fail(job.job_id, "failure_diagnostics") end
			if not black_box_ok or black_box_result ~= true then
				log(string.format("[Validation] ERROR: failed to bank failure black box: %s — "
					.. "discarding the destination anyway (observability never gates the contract; "
					.. "the preserved source is the authoritative evidence)", tostring(black_box_result)))
			end

			local config = storage.surface_export_config or {}
			local preserve_failed = config.debug_mode == true and config.preserve_failed_destination == true
			if not job.target_platform or not job.target_platform.valid then
				log("[Validation] Failed destination already invalid — nothing to discard"
					.. (preserve_failed and "; preserve_failed_destination stays ARMED (nothing to preserve)" or ""))
				sweep_created_logistic_groups(job)
			elseif preserve_failed then
				config.preserve_failed_destination = nil
				result.destinationPreserved = true
				log("[Validation] Failed destination preserved paused by one-shot debug configuration; flag consumed")
			else
				Timing.start(job.job_id, "passenger_evacuation")
				local evacuated, evacuation_err = pcall(Gateway.evacuate_passengers, job.target_platform)
				Timing.stop(job.job_id, "passenger_evacuation")
				if not evacuated then Timing.fail(job.job_id, "passenger_evacuation") end
				if not evacuated then
					log(string.format("[Validation] WARNING: passenger evacuation failed (%s) — proceeding "
						.. "with discard; the engine returns players to a planet on hub loss natively",
						tostring(evacuation_err)))
				end
				Timing.start(job.job_id, "destination_recovery")
				local delete_ok, delete_result = pcall(function()
					local hold = DestinationHold.get(job.transfer_id)
					if hold and hold.platform_index == job.target_platform.index
						and hold.surface_index == job.target_surface.index then
						return DestinationHold.discard(job.transfer_id)
					end
					return GameUtils.delete_platform(job.target_platform)
				end)
				Timing.stop(job.job_id, "destination_recovery")
				if not delete_ok or delete_result ~= true then Timing.fail(job.job_id, "destination_recovery") end
				if delete_ok and delete_result == true then
					log("[Validation] Failed destination discarded after black-box capture")
					sweep_created_logistic_groups(job)
				else
					result.cleanup_failed = true
					result.cleanup_error = string.format("GameUtils.delete_platform failed: %s",
						tostring(delete_ok and (delete_result or "returned false") or delete_result))
					log(string.format("[Validation] ERROR: cleanup_failed for %s: %s",
						tostring(job.platform_name), result.cleanup_error))
				end
			end

		end

	end

	if not (is_transfer and has_verification) and (job.metrics and job.metrics.belt_anomalies or 0) > 0 then
		validation_result = {
			success = false,
			failedStage = "belts",
			mismatchDetails = string.format(
				"belt side-restore reported %d structural anomalies on a non-transfer import%s — platform kept, operation FAILED",
				job.metrics.belt_anomalies,
				job.metrics.belt_shape_error and (" — payload refused: " .. job.metrics.belt_shape_error)
					or (job.metrics.belt_restore_error and (" — restore error: " .. job.metrics.belt_restore_error) or "")),
		}
		game.print(string.format("[Import FAILED] %s", validation_result.mismatchDetails), {1, 0, 0})
		log("[Import] Non-transfer import FAILED on belt structural anomalies: "
			.. tostring(job.metrics.belt_anomalies))
	end

	job.metrics.validation_completed_tick = game.tick

	storage.async_job_results[job.job_id] = {
		status = "complete",
		complete = true,
		type = "import",
		job_id = job.job_id,
		platform_name = job.platform_name,
		total_entities = job.total_entities,
		duration_ticks = duration_ticks,
		progress = 100,
		requester = job.requester,
		validation = validation_result,
		metrics = job.metrics
	}

	if clusterio_api and clusterio_api.send_json then
		local m = job.metrics
		local t0 = m.delivery_started_tick or job.started_tick or 0
		local phase_spans = PhaseRecorder.build_spans(job, t0)
		emit_debug_import_result(job, validation_result, duration_ticks)

		local event_payload = {
			job_id = job.job_id,
			platform_name = job.platform_name,
			entity_count = job.total_entities,
			duration_ticks = duration_ticks,
			metrics = {
				tiles_ticks = PhaseRecorder.phase_ticks(job, "tiles"),
				entities_ticks = PhaseRecorder.phase_ticks(job, "entities"),
				fluids_ticks = PhaseRecorder.phase_ticks(job, "fluids"),
				belts_ticks = PhaseRecorder.phase_ticks(job, "belts"),
				state_ticks = PhaseRecorder.phase_ticks(job, "state"),
				validation_ticks = PhaseRecorder.phase_ticks(job, "validation"),
				total_ticks = duration_ticks,
				tiles_placed = job.metrics.tiles_placed or 0,
				entities_created = job.metrics.entities_created or 0,
				entities_failed = job.metrics.entities_failed or 0,
				entities_skipped = job.metrics.entities_skipped or 0,
				entities_mapped = job.metrics.entities_mapped or 0,
				fluids_restored = job.metrics.fluids_restored or 0,
				belt_items_restored = job.metrics.belt_items_restored or 0,
				belt_restore_batches = job.metrics.belt_restore_batches or 0,
				belt_max_batch_work = job.metrics.belt_max_batch_work or 0,
				belt_networks = job.metrics.belt_networks or 0,
				belt_state_applied = job.metrics.belt_state_applied or 0,
				belt_state_unmatched = job.metrics.belt_state_unmatched or 0,
				belt_state_failed = job.metrics.belt_state_failed or 0,
				belt_state_merge_discarded = job.metrics.belt_state_merge_discarded or 0,
				belt_state_declined = job.metrics.belt_state_declined or 0,
				inventory_state_applied = job.metrics.inventory_state_applied or 0,
				inventory_state_declined = job.metrics.inventory_state_declined or 0,
				inventory_state_failed = job.metrics.inventory_state_failed or 0,
				circuits_connected = job.metrics.circuits_connected or 0,
				copper_pruned = job.metrics.copper_pruned or 0,
				proxies_linked = job.metrics.proxies_linked or 0,
				total_items = job.total_items or 0,
				total_fluids = job.total_fluids or 0,
				phase_ticks = phase_spans,
			}
		}
		event_payload.success = validation_result and validation_result.success == true
		if validation_result and validation_result.success ~= true then
			event_payload.failed_stage = validation_result.failedStage
			event_payload.error = validation_result.mismatchDetails
				or validation_result.message
				or "the destination refused the import"
			event_payload.cleanup_failed = validation_result.cleanup_failed == true
			event_payload.cleanup_error = validation_result.cleanup_error
			event_payload.destination_preserved = validation_result.destinationPreserved == true
		end

		if job.transfer_id then
			event_payload.transfer_id = job.transfer_id
			event_payload.source_instance_id = job.source_instance_id

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

	Timing.stop(job.job_id, "verdict_handling")
	if validation_result and validation_result.success == false then
		Timing.fail(job.job_id, "verdict_handling")
		if validation_result.failedStage == "belts" then Timing.fail(job.job_id, "belts") end
	end
	Timing.finish(job.job_id, validation_result and validation_result.success == false and "failed" or "completed")
	local perf = PhaseProfiler.get(job.job_id)
	if perf then
		local function phase_ms_display(name)
			local ticks = PhaseRecorder.phase_ticks(job, name)
			if not ticks then return "n/a" end
			return string.format("%d ticks elapsed", ticks)
		end
		game.print({"", "[Perf] Import '", job.platform_name, "' (", job.total_entities, " entities)"})
		game.print({"", "  Setup:         ", perf.queue_setup})
		game.print({"", "  Tiles:         ", phase_ms_display("tiles")})
		game.print({"", "  Beacons:       ", perf.beacons})
		game.print({"", "  Entities:      ", phase_ms_display("entities")})
		game.print({"", "  Hub restore:   ", perf.hub_restore})
		game.print({"", "  Belts:         ", perf.belts})
		game.print({"", "  State:         ", perf.state})
		game.print({"", "  Inventories:   ", perf.inventories})
		game.print({"", "  Validation:    ", perf.validation})
		game.print({"", "  Activation:    ", perf.activation})
		game.print({"", "  Fluids:        ", perf.fluids})
		TransactionHistory.record_import(job, validation_result, perf)
		
		PhaseProfiler.discard(job.job_id)
	end

	JobResults.prune(25)

	storage.async_jobs[job.job_id] = nil
end

return ImportCompletion
