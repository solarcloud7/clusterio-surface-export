local Deserializer = require("modules/surface_export/core/deserializer")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local FluidRegistry = require("modules/surface_export/export_scanners/fluid-registry")
local FluidRestoration = require("modules/surface_export/import_phases/fluid_restoration")
local EntityStateRestoration = require("modules/surface_export/import_phases/entity_state_restoration")
local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")
local ActiveStateRestoration = require("modules/surface_export/import_phases/active_state_restoration")
local LatchRearm = require("modules/surface_export/import_phases/latch_rearm")
local PlatformHubMapping = require("modules/surface_export/import_phases/platform_hub_mapping")
local TransferValidation = require("modules/surface_export/validators/transfer-validation")
local LossAnalysis = require("modules/surface_export/validators/loss-analysis")
local DebugExport = require("modules/surface_export/utils/debug-export")
local PlatformSchedule = require("modules/surface_export/utils/platform-schedule")
local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local GameUtils = require("modules/surface_export/utils/game-utils")
local Gateway = require("modules/surface_export/core/gateway")
local Util = require("modules/surface_export/utils/util")
local clusterio_api = require("modules/clusterio/api")
local PhaseProfiler = require("modules/surface_export/utils/phase-profiler")
local PhaseRecorder = require("modules/surface_export/utils/phase-recorder")
local PhaseCensus = require("modules/surface_export/utils/phase-census")
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

local function scan_surface_with_registry(surface)
	local registry = FluidRegistry.new()
	InventoryScanner.fluid_registry = registry
	local ok, entities = pcall(EntityScanner.scan_surface, surface)
	InventoryScanner.fluid_registry = nil
	if not ok then
		log("[Import] forensic surface scan failed: " .. tostring(entities))
		return {}, {}
	end
	return entities, FluidRegistry.list(registry)
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
	local physical_entities, physical_fluid_segments = scan_surface_with_registry(job.target_surface)
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
		belt_lines = BeltRestoration.attribute_lines(job.entities_to_create or {}, job.entity_map or {}),
		replay_payload = job.platform_data,
	}
	local written = DebugExport.write_failure_black_box(filename, bundle)
	result.failureBlackBox = { file = written, tick = game.tick }
	return written ~= nil
end

local function belt_delta_to_census_keys(delta)
	local out = {}
	for key, value in pairs(delta or {}) do
		local name, quality = key:match("^(.-)%z(.*)$")
		if name then
			local census_key = Util.make_quality_key(name, quality)
			out[census_key] = (out[census_key] or 0) + value
		else
			out[key] = (out[key] or 0) + value
			log(string.format(
				"[PhaseCensus] belt delta key %q did not match name\\0quality — carried through unconverted", key))
		end
	end
	return out
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

local function census_scope(job)
	local platform = job and job.target_platform
	if platform and platform.valid and platform.surface and platform.surface.valid then
		return platform.surface
	end
	return nil
end

function ImportCompletion.run_phase1(job)
	local entity_map = job.entity_map or {}
	local entities_to_create = job.entities_to_create or {}

	job.phase_census = job.phase_census or {}
	PhaseCensus.record_baseline(job, "entity_creation", census_scope(job))

	log("[Import] Phase 1 post-processing: hub inventories, belts, entity state...")

	PhaseRecorder.start(job, "hub")
	local hub_scope
	do
		local surf = census_scope(job)
		hub_scope = surf and surf.find_entities_filtered({ type = "space-platform-hub" }) or nil
	end
	PhaseCensus.open(job, "hub", PhaseCensus.SUBJECT_INVENTORIES, hub_scope)
	local hub_item_state = Deserializer.new_item_state_session()
	local hub_ok, hub_err = pcall(PlatformHubMapping.restore_hub_inventories, job, hub_item_state)
	Deserializer.release_item_state_session(hub_item_state)
	record_item_state(job, hub_item_state)
	if not hub_ok then error(hub_err, 0) end
	PhaseCensus.close(job, "hub", PhaseCensus.SUBJECT_INVENTORIES, hub_scope)
	PhaseRecorder.stop(job, "hub")

	PhaseRecorder.start(job, "belts")
	local belts_result
	local side_groups = job.platform_data and job.platform_data.belt_side_groups
	if side_groups and #side_groups > 0 then
		local placed, unplaced, anomalies
		local shape_ok, shape_err = BeltRestoration.validate_side_groups(side_groups)
		if not shape_ok then
			log(string.format("[Import] belt_side_groups REFUSED (malformed payload): %s", tostring(shape_err)))
			job.metrics.belt_shape_error = tostring(shape_err)
			placed, unplaced, anomalies = 0, 0, 1
			PhaseCensus.close(job, "belts", PhaseCensus.SUBJECT_BELTS, nil)
		else
			local restore_fn = BeltRestoration.restore_side_groups
			local ok_restore, r_placed, r_unplaced, r_anomalies, r_delta, r_state = pcall(restore_fn, side_groups,
				entity_map, job.target_platform and job.target_platform.name or job.platform_name)
			if not ok_restore then
				log(string.format("[Import] belt side-restore THREW (routed to verdict, never error()): %s",
					tostring(r_placed)))
				job.metrics.belt_restore_error = tostring(r_placed)
				placed, unplaced, anomalies = 0, 0, 1
				PhaseCensus.close(job, "belts", PhaseCensus.SUBJECT_BELTS, nil)
			else
				placed, unplaced, anomalies = r_placed, r_unplaced, r_anomalies
				if r_state then
					job.metrics.belt_state_applied = r_state.applied
					job.metrics.belt_state_unmatched = r_state.unmatched
					job.metrics.belt_state_failed = r_state.failed
					job.metrics.belt_state_merge_discarded = r_state.merge_discarded
					job.metrics.belt_state_declined = r_state.declined
				end
				PhaseCensus.record_external(job, "belts", PhaseCensus.SUBJECT_BELTS,
					belt_delta_to_census_keys(r_delta), "side-group member lines")
			end
		end
		belts_result = { items_restored = placed, attribution = nil }
		job.metrics.belt_side_groups = #side_groups
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
			PhaseCensus.close(job, "belts", PhaseCensus.SUBJECT_BELTS, nil)
		end
		belts_result = { items_restored = 0 }
	end
	PhaseRecorder.stop(job, "belts")
	job.metrics.belt_items_restored = belts_result and belts_result.items_restored or 0

	PhaseRecorder.start(job, "state")
	local state_result = EntityStateRestoration.restore_all(entities_to_create, entity_map)
	PhaseRecorder.stop(job, "state")
	job.metrics.circuits_connected = state_result and state_result.circuits_connected or 0
	job.metrics.copper_pruned = state_result and state_result.copper_pruned or 0
	job.metrics.proxies_linked = state_result and state_result.proxies_linked or 0
	job.created_logistic_groups = state_result and state_result.created_logistic_groups or nil

	job.pending_beacon_tick = game.tick + 1
	log(string.format("[Import] Phase 1 complete (tick %d). Inventory restore scheduled for tick %d", game.tick, job.pending_beacon_tick))
end

function ImportCompletion.run_phase2(job)
	local duration_ticks = game.tick - job.started_tick
	local duration_seconds = duration_ticks / 60
	job.metrics = job.metrics or {}
	local entity_map = job.entity_map or {}
	local entities_to_create = job.entities_to_create or {}
	local validation_result_id = job.transfer_id or job.job_id


	if not job.inventory_overflow_losses then
		job.inventory_overflow_losses = { total = 0, items = {}, entities = {} }
	end
	PhaseRecorder.start(job, "inventories")
	PhaseCensus.open(job, "inventories", PhaseCensus.SUBJECT_INVENTORIES, census_scope(job))
	local inv_restored = 0
	local inv_skipped = 0
	local inv_item_state = Deserializer.new_item_state_session()
	local inv_ok, inv_err = pcall(function()
		for _, entity_data in ipairs(entities_to_create) do
			if entity_data and entity_data.entity_id and entity_data.type == "beacon" then
				local entity = entity_map[entity_data.entity_id]
				if entity and entity.valid then
					Deserializer.restore_inventories(entity, entity_data, job.inventory_overflow_losses, inv_item_state)
				end
			end
		end
		for _, entity_data in ipairs(entities_to_create) do
			if entity_data and entity_data.entity_id and entity_data.type ~= "beacon" then
				local entity = entity_map[entity_data.entity_id]
				if entity and entity.valid then
					Deserializer.restore_inventories(entity, entity_data, job.inventory_overflow_losses, inv_item_state)
					inv_restored = inv_restored + 1
				else
					inv_skipped = inv_skipped + 1
				end
			end
		end
	end)
	Deserializer.release_item_state_session(inv_item_state)
	record_item_state(job, inv_item_state)
	if not inv_ok then error(inv_err, 0) end
	log_item_state(job)
	PhaseCensus.close(job, "inventories", PhaseCensus.SUBJECT_INVENTORIES, census_scope(job))
	PhaseRecorder.stop(job, "inventories")
	log(string.format("[Import] Inventory restoration: %d entities restored, %d skipped (failed/missing)", inv_restored, inv_skipped))
	if job.inventory_overflow_losses.total > 0 then
		log(string.format("[Import] Inventory overflow losses: %d items lost (set_stack API cap)", job.inventory_overflow_losses.total))
	end


	for _, entity_data in ipairs(entities_to_create) do
		if entity_data and entity_data.entity_id then
			local entity = entity_map[entity_data.entity_id]
			if entity and entity.valid and GameUtils.ACTIVATABLE_ENTITY_TYPES[entity.type] then
				entity.disabled_by_script = true
			end
		end
	end
	if job.transfer_id and job.target_platform and job.target_platform.valid then
		job.target_platform.paused = true
		log(string.format("[Import] Platform %s re-paused for validation (tick %d)", job.platform_name, game.tick))
	end

	local frozen_states = job.frozen_states or {}
	local _dbg_cfg = storage.surface_export_config
	local defer_clone = _dbg_cfg and _dbg_cfg.debug_mode and _dbg_cfg.test_defer_clone_activation
	PhaseRecorder.start(job, "held_items")
	local held_scope
	do
		local surf = census_scope(job)
		held_scope = surf and surf.find_entities_filtered({ type = "inserter" }) or nil
	end
	PhaseCensus.open(job, "held_items", PhaseCensus.SUBJECT_HELD, held_scope)
	ActiveStateRestoration.restore_held_items_only(entities_to_create, entity_map)
	PhaseCensus.close(job, "held_items", PhaseCensus.SUBJECT_HELD, held_scope)
	PhaseRecorder.stop(job, "held_items")
	PhaseRecorder.start(job, "fluids")
	local fluids_result = FluidRestoration.restore(entities_to_create, entity_map,
		job.platform_data and job.platform_data.fluid_segments)
	PhaseRecorder.stop(job, "fluids")
	job.metrics.fluids_restored = fluids_result and fluids_result.count or 0
	log(string.format("[Import] Frozen-world fluid restoration: %d fluids restored", job.metrics.fluids_restored))

	local _, phase_complete = PhaseCensus.total(job)
	job.metrics.phase_census = job.phase_census
	job.metrics.phase_census_complete = phase_complete
	log(string.format("[Import] PHASE CENSUS: %s", PhaseCensus.format(job)))
	if not phase_complete then
		log("[Import] PHASE CENSUS is a LOWER BOUND — at least one phase went unmeasured; "
			.. "do not read the sum as an exact reconciliation against the gate.")
	end

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
		"[Import Complete] %s (%d entities in %.1fs)",
		job.platform_name, job.total_entities, duration_seconds
	)
	game.print(message, {0, 1, 0})
	log(message)

	if job.requester == "RCON" then
		rcon.print(string.format("IMPORT_COMPLETE:%s", job.platform_name))
	end

	job.metrics.validation_started_tick = game.tick

	local validation_result = nil
	local is_transfer = job.transfer_id ~= nil
	local has_platform_data = job.platform_data ~= nil
	local has_verification = has_platform_data and job.platform_data.verification ~= nil

	if is_transfer and has_verification then

		local adjusted_verification = {
			item_counts = copy_counts(job.platform_data.verification.item_counts),
			fluid_counts = copy_counts(job.platform_data.verification.fluid_counts),
		}
		local fel = job.failed_entity_losses
		if fel and fel.entity_count > 0 then
			for item_key, lost_count in pairs(fel.items) do
				if adjusted_verification.item_counts[item_key] then
					adjusted_verification.item_counts[item_key] = math.max(
						0, adjusted_verification.item_counts[item_key] - lost_count)
				end
			end
			log(string.format("[Import] Adjusted expected ITEM totals for %d failed entities: -%d items (fluids never adjusted — fail => revert)",
				fel.entity_count, fel.total_items))
		end

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

		if fluids_result and fluids_result.write_rejected then
			adjusted_verification.fluid_counts = subtract_fluids_by_name(
				adjusted_verification.fluid_counts, fluids_result.write_rejected)
		end

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
		if job.test_forced_entity_failure then
			success = false
			result = result or {}
			result.success = false
			result.failedStage = "test_hook"
			result.mismatchDetails = "TEST: forced entity placement failure (source preserved)"
			result.testForcedEntityFailure = true
			log("[TEST HOOK] Forced entity failure made the transfer verdict fail-safe")
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
		if job.transfer_id and job.target_surface and job.target_surface.valid then
			local debug_success, debug_err = pcall(function()
				if DebugExport.is_enabled() then
					local scanned_entities, scanned_fluid_segments = scan_surface_with_registry(job.target_surface)
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

			local black_box_ok, black_box_result = pcall(bank_failure_black_box, job, result)
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
				local evacuated, evacuation_err = pcall(Gateway.evacuate_passengers, job.target_platform)
				if not evacuated then
					log(string.format("[Validation] WARNING: passenger evacuation failed (%s) — proceeding "
						.. "with discard; the engine returns players to a planet on hub loss natively",
						tostring(evacuation_err)))
				end
				local delete_ok, delete_result = pcall(GameUtils.delete_platform, job.target_platform)
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
		else
			if job.target_platform and job.target_platform.valid then
				job.target_platform.paused = false
				log(string.format("[Validation] Platform %s UNPAUSED after successful validation", job.platform_name))
			end
			PhaseRecorder.start(job, "activation")
			ActiveStateRestoration.restore(job.entities_to_create or {}, job.entity_map or {}, job.frozen_states or {})
			PhaseRecorder.stop(job, "activation")

			local rearm_count = LatchRearm.schedule(job)
			if rearm_count > 0 then
				result.latchRearmScheduled = rearm_count
			end

			if result.totalExpectedItems then
				PhaseRecorder.start(job, "loss_analysis")
				LossAnalysis.run(job.target_surface, entities_to_create, result, fluids_result and fluids_result.segment_temps)
				PhaseRecorder.stop(job, "loss_analysis")
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
		duration_seconds = duration_seconds,
		progress = 100,
		requester = job.requester,
		validation = validation_result,
		metrics = job.metrics
	}

	if clusterio_api and clusterio_api.send_json then
		local m = job.metrics
		local t0 = m.delivery_started_tick or job.started_tick or 0
		local phase_spans = PhaseRecorder.build_spans(job, t0)
		emit_debug_import_result(job, validation_result, duration_seconds)

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
				total_items = job.total_items or 0,
				total_fluids = job.total_fluids or 0,
				phase_spans = phase_spans,
			}
		}
		event_payload.success = validation_result and validation_result.success == true

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

	local perf = PhaseProfiler.get(job.job_id)
	if perf then
		local function phase_ms_display(name)
			local ticks = PhaseRecorder.phase_ticks(job, name)
			if not ticks then return "n/a" end
			return string.format("%dms", math.floor(ticks * 16.67))
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
		game.print({"", "  Loss analysis: ", perf.loss_analysis})
		
		TransactionHistory.record_import(job, validation_result, perf)
		
		PhaseProfiler.discard(job.job_id)
	end

	JobResults.prune(25)

	storage.async_jobs[job.job_id] = nil
end

return ImportCompletion
