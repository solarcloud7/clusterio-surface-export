local FluidRegistry = require("modules/surface_export/export_scanners/fluid-registry")
local DebugExport = require("modules/surface_export/utils/debug-export")
local PlatformSchedule = require("modules/surface_export/utils/platform-schedule")
local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local clusterio_api = require("modules/clusterio/api")
local TransactionHistory = require("modules/surface_export/utils/transaction-history")
local Timing = require("modules/surface_export/utils/operation-timing")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")
local GameUtils = require("modules/surface_export/utils/game-utils")
local Util = require("modules/surface_export/utils/util")
local PhaseProfiler = require("modules/surface_export/utils/phase-profiler")
local PhaseRecorder = require("modules/surface_export/utils/phase-recorder")

local ImportReporting = {}

local function aggregate_fluid_counts_by_name(counts)
	local totals = {}
	for key, amount in pairs(counts or {}) do
		local name, _ = Util.parse_fluid_temp_key(key)
		totals[name] = (totals[name] or 0) + amount
	end
	return totals
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

function ImportReporting.bank_failure_black_box(job, result)
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

function ImportReporting.capture_destination(job)
	if job.transfer_id and job.target_surface and job.target_surface.valid then
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

end

function ImportReporting.publish(job, validation_result, duration_ticks)
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
		event_payload.validation = validation_result
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
		storage.async_job_results[job.job_id].completion = event_payload
		clusterio_api.send_json("surface_export_import_complete", event_payload)
	end

end

function ImportReporting.record_performance(job, validation_result)
	local perf = PhaseProfiler.get(job.job_id)
	if perf then
		local function phase_ms_display(name)
			local ticks = PhaseRecorder.phase_ticks(job, name)
			if not ticks then return "n/a" end
			return string.format("%d ticks elapsed", ticks)
		end
		log({"", "[Perf] Import '", job.platform_name, "' (", job.total_entities, " entities)"})
		log({"", "  Setup:         ", perf.queue_setup})
		log({"", "  Tiles:         ", phase_ms_display("tiles")})
		log({"", "  Beacons:       ", perf.beacons})
		log({"", "  Entities:      ", phase_ms_display("entities")})
		log({"", "  Hub restore:   ", perf.hub_restore})
		log({"", "  Belts:         ", perf.belts})
		log({"", "  State:         ", perf.state})
		log({"", "  Inventories:   ", perf.inventories})
		log({"", "  Validation:    ", perf.validation})
		log({"", "  Activation:    ", perf.activation})
		log({"", "  Fluids:        ", perf.fluids})
		TransactionHistory.record_import(job, validation_result, perf)

		PhaseProfiler.discard(job.job_id)
	end
end

return ImportReporting
