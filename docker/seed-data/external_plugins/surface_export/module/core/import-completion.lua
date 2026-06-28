-- FactorioSurfaceExport - Import Completion
-- Handles post-entity-creation phases: hub inventories, belts, state, inventories,
-- validation, activation, fluid restoration, loss analysis, and notifications.
--
-- Phase ordering (CRITICAL — do not reorder):
--   Phase 1 (run_phase1): hub inventories → belts → entity state → schedule phase 2
--   Phase 2 (run_phase2): inventories (beacons first) → deactivate → validate → activate
--                         → fluid restoration → loss analysis → notify

local Deserializer = require("modules/surface_export/core/deserializer")
local FluidRestoration = require("modules/surface_export/import_phases/fluid_restoration")
local EntityStateRestoration = require("modules/surface_export/import_phases/entity_state_restoration")
local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")
local ActiveStateRestoration = require("modules/surface_export/import_phases/active_state_restoration")
local PlatformHubMapping = require("modules/surface_export/import_phases/platform_hub_mapping")
local TransferValidation = require("modules/surface_export/validators/transfer-validation")
local LossAnalysis = require("modules/surface_export/validators/loss-analysis")
local DebugExport = require("modules/surface_export/utils/debug-export")
local PlatformSchedule = require("modules/surface_export/utils/platform-schedule")
local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local GameUtils = require("modules/surface_export/utils/game-utils")
local Util = require("modules/surface_export/utils/util")
local clusterio_api = require("modules/clusterio/api")
local PhaseProfiler = require("modules/surface_export/utils/phase-profiler")
local TransactionHistory = require("modules/surface_export/utils/transaction-history")
local JobResults = require("modules/surface_export/core/job-results")

local ImportCompletion = {}

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

	-- Step 0a: Fluid restoration DEFERRED until after entity activation
	-- Factorio 2.0 fluid segment system: frozen entities are detached from fluid segments.
	-- Writing fluid to a frozen entity writes to a "ghost buffer" that gets wiped when
	-- the entity is unfrozen and joins a live segment. Must inject fluid AFTER activation.
	job.metrics.fluids_deferred = true
	log("[Import] Fluid restoration deferred until after entity activation (frozen entity ghost buffer fix)")

	-- Step 0b: Restore belt items synchronously
	-- CRITICAL: Belts are always active and cannot be deactivated.
	-- Must restore all belt items in a single tick to prevent partial restoration
	job.metrics.belts_started_tick = game.tick
	PhaseProfiler.start(job.job_id, "belts")
	local belts_result = BeltRestoration.restore(entities_to_create, entity_map)
	PhaseProfiler.stop(job.job_id, "belts")
	job.metrics.belts_completed_tick = game.tick
	job.metrics.belt_items_restored = belts_result and belts_result.items_restored or 0

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

	-- FINAL STEP: Restore original active/disabled states
	-- For non-transfer imports: activate immediately (no validation step)
	-- For transfers: DEFER activation until AFTER validation passes
	--   This prevents machines from processing resources between activation and validation
	local frozen_states = job.frozen_states or {}
	local _dbg_cfg = storage.surface_export_config
	local defer_clone = _dbg_cfg and _dbg_cfg.debug_mode and _dbg_cfg.test_defer_clone_activation
	if job.transfer_id then
		log("[Import] Deferring active state restoration until after validation (transfer mode)")
	elseif defer_clone then
		-- TEST-ONLY: leave the clone DEACTIVATED so the pristine restored state can be physically
		-- counted with zero crafting confound (clean same-instance restoration-fidelity measurement).
		log("[Import][TEST] test_defer_clone_activation set — clone left DEACTIVATED (no activation, no fluids)")
	else
		PhaseProfiler.start(job.job_id, "activation")
		ActiveStateRestoration.restore(entities_to_create, entity_map, frozen_states)
		PhaseProfiler.stop(job.job_id, "activation")
		-- Non-transfer: restore fluids after activation (same ghost buffer fix)
		job.metrics.fluids_started_tick = game.tick
		PhaseProfiler.start(job.job_id, "fluids")
		local fluids_result = FluidRestoration.restore(entities_to_create, entity_map)
		PhaseProfiler.stop(job.job_id, "fluids")
		job.metrics.fluids_completed_tick = game.tick
		job.metrics.fluids_restored = fluids_result and fluids_result.count or 0
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
		local adjusted_verification = job.platform_data.verification
		local fel = job.failed_entity_losses
		if fel and fel.entity_count > 0 then
			local adjusted_items = {}
			for k, v in pairs(adjusted_verification.item_counts or {}) do
				adjusted_items[k] = v
			end
			for item_name, lost_count in pairs(fel.items) do
				if adjusted_items[item_name] then
					adjusted_items[item_name] = math.max(0, adjusted_items[item_name] - lost_count)
				end
			end
			adjusted_verification = {
				item_counts = adjusted_items,
				fluid_counts = adjusted_verification.fluid_counts,
			}
			log(string.format("[Import] Adjusted expected totals: subtracted %d items across %d item types due to %d failed entities",
				fel.total_items, table_size(fel.items), fel.entity_count))
		end

		-- Adjust expected counts for inventory overflow losses (set_stack API cap).
		-- These items are present in the export but unrestorable due to Factorio engine limits —
		-- counting them as "expected" would cause false validation failures.
		local iol = job.inventory_overflow_losses
		if iol and iol.total > 0 then
			local adjusted_items = {}
			for k, v in pairs(adjusted_verification.item_counts or {}) do
				adjusted_items[k] = v
			end
			for item_name, lost_count in pairs(iol.items) do
				if adjusted_items[item_name] then
					adjusted_items[item_name] = math.max(0, adjusted_items[item_name] - lost_count)
				end
			end
			adjusted_verification = {
				item_counts = adjusted_items,
				fluid_counts = adjusted_verification.fluid_counts,
			}
			log(string.format("[Import] Adjusted expected totals: subtracted %d items across %d item types due to inventory overflow (API stack cap)",
				iol.total, table_size(iol.items)))
		end

		-- Restore inserter held items BEFORE counting so the strict gate sees them while machines
		-- stay deactivated (Pitfall #15). Removes the pre-activation "held phantom" (a few hundred
		-- items) that previously forced a loose tolerance — without opening a craft window, because
		-- only inserters are briefly toggled (within one synchronous pass; they cannot swing).
		ActiveStateRestoration.restore_held_items_only(entities_to_create, entity_map)

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

		PhaseProfiler.start(job.job_id, "validation")
		local success, result = TransferValidation.validate_import(
			job.target_surface,
			adjusted_verification,
			{ skip_fluid_validation = true, strict = true }  -- strict per-item gate; fluids deferred
		)

		-- TEST HOOK (one-shot, debug-gated): force a validation failure to exercise the rollback /
		-- two-phase-commit safety path. Set via configure({ test_force_validation_failure = true }).
		local _cfg = storage.surface_export_config
		if _cfg and _cfg.debug_mode and _cfg.test_force_validation_failure then
			_cfg.test_force_validation_failure = nil  -- consume: applies to one transfer only
			success = false
			result = result or {}
			-- Corrupt the SAME fields the controller's source-delete gate actually reads
			-- (instance.ts re-fetches get_validation_result_json and computes
			--  success = itemCountMatch && fluidCountMatch). Overriding only `success` here
			-- left these true, so the controller saw a "pass" and deleted the source.
			result.itemCountMatch = false
			result.fluidCountMatch = false
			-- mismatchDetails is the field handleValidationFailure logs as the rollback reason;
			-- set it so CI logs read "Rolled back. Error: TEST ..." instead of "Unknown error".
			result.mismatchDetails = "TEST: forced validation failure (rollback safety test)"
			result.message = "TEST: validation failure forced (test_force_validation_failure)"
			result.testForcedFailure = true
			log("[TEST HOOK] Forcing validation failure to exercise rollback")
		end

		PhaseProfiler.stop(job.job_id, "validation")
		-- Clean validation-only boundary for the waterfall span (the existing
		-- validation_completed_tick at the end of run_phase2 also covers activation/fluids/loss).
		job.metrics.validation_done_tick = game.tick
		validation_result = result
		result.success = success

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

		TransferValidation.store_validation_result(job.platform_name, result)

		-- Debug export: Write validation result for analysis
		DebugExport.export_import_result({
			platform_name = job.platform_name,
			transfer_id = job.transfer_id,
			validation_success = success,
			validation_result = result,
			total_entities = job.total_entities,
			duration_seconds = duration_seconds
		}, job.platform_name)

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
			-- Leave platform paused and entities deactivated on validation failure so user can investigate
			log("[Validation] Platform left paused and deactivated due to validation failure")
		else
			-- Validation passed — auto-unpause platform and activate all entities
			-- Use ActiveStateRestoration to restore original active states (not blanket activate_all)
			if job.target_platform and job.target_platform.valid then
				job.target_platform.paused = false
				log(string.format("[Validation] Platform %s UNPAUSED after successful validation", job.platform_name))
			end
			PhaseProfiler.start(job.job_id, "activation")
			ActiveStateRestoration.restore(job.entities_to_create or {}, job.entity_map or {}, job.frozen_states or {})
			PhaseProfiler.stop(job.job_id, "activation")

			-- POST-ACTIVATION FLUID RESTORATION
			-- Entities are now unfrozen and active, connected to live fluid segments.
			-- Fluid injected now will persist correctly instead of being wiped.
			job.metrics.fluids_started_tick = game.tick
			PhaseProfiler.start(job.job_id, "fluids")
			local fluids_result = FluidRestoration.restore(entities_to_create, entity_map)
			PhaseProfiler.stop(job.job_id, "fluids")
			job.metrics.fluids_completed_tick = game.tick
			job.metrics.fluids_restored = fluids_result and fluids_result.count or 0
			log(string.format("[Import] Post-activation fluid restoration: %d fluids restored",
				job.metrics.fluids_restored))

			game.print(string.format("[Validation] ✓ Validation passed - entities activated on platform %s!",
				job.platform_name), {0, 1, 0})

			-- ========================================
			-- POST-ACTIVATION LOSS ANALYSIS
			-- Run AFTER active state restoration so inserter held items and
			-- fluid equilibrium are measured accurately.
			-- Updates validation_result so the transaction log gets correct numbers.
			-- ========================================
			-- Adjust expected fluid counts for engine-rejected writes (e.g., fusion-reactor plasma output).
			-- These fluids are unrestorable via any API — subtract from expected so validation doesn't
			-- report them as loss. Same pattern as failedEntityLosses for items.
			if fluids_result and fluids_result.write_rejected then
				for fluid_name, rejected_amount in pairs(fluids_result.write_rejected) do
					if rejected_amount > 0 then
						log(string.format("[Import] Adjusting expected fluids: -%s=%.1f (engine write-rejected)", fluid_name, rejected_amount))
						-- Subtract from expected fluid counts across matching temperature keys
						local remaining = rejected_amount
						for key, amt in pairs(result.expectedFluidCounts or {}) do
							if remaining <= 0 then break end
							local name, _ = Util.parse_fluid_temp_key(key)
							if name == fluid_name and amt > 0 then
								local subtract = math.min(amt, remaining)
								result.expectedFluidCounts[key] = amt - subtract
								remaining = remaining - subtract
							end
						end
						result.totalExpectedFluids = (result.totalExpectedFluids or 0) - (rejected_amount - remaining)
					end
				end
			end

			if result.totalExpectedItems then
				PhaseProfiler.start(job.job_id, "loss_analysis")
				LossAnalysis.run(job.target_surface, entities_to_create, result, fluids_result and fluids_result.segment_temps)

				PhaseProfiler.stop(job.job_id, "loss_analysis")
				-- Re-store updated validation result
				validation_result = result
				TransferValidation.store_validation_result(job.platform_name, result)
			end

			-- GATEWAY TRANSFER: park the platform AT the gateway, paused, instead of letting the
			-- restored schedule fly it there. The unpause above and this all run in one synchronous
			-- tick, so no flight happens in between. Placement is instant (verified on 2.0.76); pausing
			-- holds it until the player resumes. nil for normal transfers — they keep the unpause above.
			-- PAUSE FIRST (its own pcall), THEN place: if the space_location write throws, the platform
			-- is still safely parked-paused rather than flying off next tick.
			if job.gateway_target and job.target_platform and job.target_platform.valid then
				local tp = job.target_platform
				-- Unlock the gateway for the platform's force first (a force created after the startup
				-- discover_and_unlock pass wouldn't have it; placement needs a reachable location).
				pcall(function() tp.force.unlock_space_location(job.gateway_target) end)
				-- Pause FIRST so a placement throw leaves it safely parked-paused, not flying the stripped route.
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
		add_span("validation", m.validation_started_tick, m.validation_done_tick)
		add_span("fluids", m.fluids_started_tick, m.fluids_completed_tick)

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
