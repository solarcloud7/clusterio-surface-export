-- FactorioSurfaceExport - Export Pipeline
-- Handles the full export job lifecycle: queuing, per-tick batch scanning, and completion.

local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local EntityHandlers = require("modules/surface_export/export_scanners/entity-handlers")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local Verification = require("modules/surface_export/validators/verification")
local Util = require("modules/surface_export/utils/util")
local GameUtils = require("modules/surface_export/utils/game-utils")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local TileScanner = require("modules/surface_export/export_scanners/tile_scanner")
local DebugExport = require("modules/surface_export/utils/debug-export")
local PlatformSchedule = require("modules/surface_export/utils/platform-schedule")
local clusterio_api = require("modules/clusterio/api")
local PhaseProfiler = require("modules/surface_export/utils/phase-profiler")
local TransactionHistory = require("modules/surface_export/utils/transaction-history")
local JobResults = require("modules/surface_export/core/job-results")

local ExportPipeline = {}

--- Sort entities for proper placement order
--- Underground belts, pipes, etc. need special ordering
--- @param entities table: Array of entity data or LuaEntity objects
--- @return table: Sorted array
local function sort_entities_for_placement(entities)
	-- Define placement priority (lower = earlier)
	local function get_priority(entity_or_data)
		-- Handle both LuaEntity (export) and entity_data (import fallback)
		local name = entity_or_data.name or ""
		local type_name = entity_or_data.type or ""

		-- 1. Tiles and rails first (foundation)
		if type_name == "straight-rail" or type_name == "curved-rail" then
			return 1
		end

		-- 2. Underground belts - entrance before exit
		-- Only access belt_to_ground_type if it's actually an underground belt
		if type_name == "underground-belt" then
			-- Safely access belt_to_ground_type (only exists on underground-belt entities)
			local belt_type = entity_or_data.belt_to_ground_type
			if belt_type == "input" then
				return 2  -- Input/entrance first
			else
				return 3  -- Output/exit second
			end
		end

		-- 3. Pipes and underground pipes
		if type_name == "pipe-to-ground" then
			return 4
		end

		-- 4. Regular entities
		return 5
	end

	-- Create sorted copy
	local sorted = {}
	for _, entity in ipairs(entities) do
		table.insert(sorted, entity)
	end

	-- Sort by priority, then by position for deterministic ordering
	table.sort(sorted, function(a, b)
		local priority_a = get_priority(a)
		local priority_b = get_priority(b)

		if priority_a ~= priority_b then
			return priority_a < priority_b
		end

		-- Same priority - sort by position for consistency
		if a.position and b.position then
			local pos_a = a.position
			local pos_b = b.position
			if pos_a.x ~= pos_b.x then
				return pos_a.x < pos_b.x
			end
			return pos_a.y < pos_b.y
		end

		return false
	end)

	return sorted
end

--- Handle a pending file write request for a completed export
--- @param export_id string: The export ID to check for pending writes
local function handle_pending_file_write(export_id)
	if not storage.pending_file_writes or not storage.pending_file_writes[export_id] then
		return
	end

	local file_request = storage.pending_file_writes[export_id]
	local filename = file_request.filename

	-- Generate filename if not provided
	if not filename then
		filename = string.format("platform_exports/%s.json", export_id)
	end

	-- Write export to file
	local export_entry = storage.platform_exports[export_id]
	if export_entry then
		local json_string = export_entry.json_string
		if not json_string then
			json_string = Util.encode_json_compat(export_entry)
		end

		if json_string then
			game.write_file(filename, json_string, false)
			log(string.format("[Export] File written: %s (%d bytes)", filename, #json_string))
			game.print(string.format("[Export] File written: script-output/%s", filename), {0, 1, 0})
		else
			log(string.format("[Export ERROR] Failed to serialize export for file write: %s", export_id))
		end
	end

	storage.pending_file_writes[export_id] = nil
end

--- Queue an export job
--- @param platform_index number
--- @param force_name string
--- @param requester_name string|nil: Player name or "RCON"
--- @param destination_instance_id number|nil: If set, transfer to this instance after export
--- @return string|nil, string|nil: job_id or nil + error
function ExportPipeline.queue(platform_index, force_name, requester_name, destination_instance_id)
	storage.async_job_id_counter = storage.async_job_id_counter + 1
	local job_counter = storage.async_job_id_counter

	local force = game.forces[force_name]
	if not force or not force.platforms[platform_index] then
		log(string.format("[Export Queue] FAILED: Platform index %s not found for force '%s'", tostring(platform_index), force_name))
		return nil, "Platform not found"
	end

	local platform = force.platforms[platform_index]

	-- Sanitize platform name (replace non-alphanumeric with dash)
	local safe_name = platform.name:gsub("[^%w%-]", "-")

	-- Generate export_id: counter_platformName
	-- Format: 001_test
	-- (All timing data is in the export payload - ID is just a clean key)
	local job_id = string.format("%03d_%s", job_counter, safe_name)

	log(string.format("[Export Queue] job_id=%s, platform_index=%s, force=%s, requester=%s, dest_instance_id=%s (type=%s)",
		job_id, tostring(platform_index), force_name, tostring(requester_name),
		tostring(destination_instance_id), type(destination_instance_id)))
	local surface = platform.surface
	if not surface or not surface.valid then
		return nil, "Platform surface not valid"
	end

	-- CRITICAL: Lock the platform BEFORE scanning to ensure stable item/fluid counts
	-- This completes cargo pods, deactivates machines, and hides surface
	local lock_success, lock_err = SurfaceLock.lock_platform(platform, force)
	if not lock_success then
		-- If already locked by another operation, that's fine - just note it
		if lock_err ~= "Platform already locked" then
			return nil, "Failed to lock platform: " .. (lock_err or "unknown error")
		end
		log(string.format("[Export] Platform %s was already locked, continuing with export", platform.name))
	else
		game.print(string.format("[Export] Locked platform %s for stable export...", platform.name), {1, 0.8, 0})
	end

	-- CRITICAL: Capture schedule from LuaSpacePlatform (records + interrupts + group),
	-- using hub_entity.platform as primary source.
	local platform_schedule, schedule_err = PlatformSchedule.capture(platform, platform.hub)
	if not platform_schedule then
		SurfaceLock.unlock_platform(platform.name)
		return nil, "Failed to capture platform schedule: " .. tostring(schedule_err)
	end
	local schedule_summary = PlatformSchedule.summarize(platform_schedule)
	log(string.format("[Export] Captured platform schedule: records=%d, interrupts=%d, group=%s",
		schedule_summary.record_count,
		schedule_summary.interrupt_count,
		tostring(schedule_summary.group)))

	local entities = surface.find_entities_filtered({})

	-- Sort entities for proper placement order (inputs before outputs, etc.)
	-- Do this once on export rather than re-sorting on every import
	entities = sort_entities_for_placement(entities)

	-- Scan tiles for platform foundation
	local tiles = TileScanner.scan_surface(surface)
	log(string.format("[Export] Scanned %d tiles and %d entities from platform %s (sorted for placement, locked)", #tiles, #entities, platform.name))

	storage.async_jobs[job_id] = {
		type = "export",
		job_id = job_id,
		platform_index = platform_index,
		platform_name = platform.name,
		force_name = force_name,
		requester = requester_name,
		destination_instance_id = destination_instance_id,  -- Transfer destination
		started_tick = game.tick,
		surface = surface,  -- Keep reference for unlock

		-- Export state
		entities = entities,
		total_entities = #entities,
		current_index = 0,
		-- Belt entities tracked for deferred atomic scan
		-- Maps serialized entity index → live LuaEntity reference
		belt_entities = {},
		-- Fluid segment dedup cache: seg_id → {fluid, amount, temp}
		-- Shared across all export batches so each segment is serialized exactly once
		-- at the segment-level weighted-average temperature (matches FluidRestoration output)
		fluid_segment_cache = {},
		export_data = {
			platform_name = platform.name,
			force_name = force_name,
			tick = game.tick,
			timestamp = Util.format_timestamp(game.tick),
			platform = {
				name = platform.name,
				force = force_name,
				index = platform_index,
				paused = platform.paused == true,
				schedule = platform_schedule,
			},
			tiles = tiles,  -- Include platform foundation tiles
			entities = {},
			stats = {
				entity_count = #entities,
				tile_count = #tiles,
				started_tick = game.tick
			}
		}
	}

	PhaseProfiler.init(job_id, {"completion"})
	return job_id
end

--- Process one batch of an export job
--- @param job table: Job data
--- @param get_batch_size function: returns batch size (supports sync mode)
--- @param should_show_progress function: returns bool
--- @return boolean: true if job complete
function ExportPipeline.process_batch(job, get_batch_size, should_show_progress)
	local batch_size = get_batch_size()
	local start_index = job.current_index + 1
	local end_index = math.min(start_index + batch_size - 1, job.total_entities)

	-- CRITICAL: Tell entity handlers to skip belt item extraction during async scanning.
	-- Belt items will be captured in a single atomic tick in complete() instead.
	-- This prevents the "rolling snapshot" problem where items move between belts during
	-- multi-tick scanning, causing duplicates or missed items.
	-- Also enable fluid segment dedup so each segment is captured at its weighted-average
	-- temperature exactly once, matching what FluidRestoration.restore() will write.
	-- Wrapped to ensure flags are always cleared even if an error occurs mid-batch.
	EntityHandlers.skip_belt_items = true
	InventoryScanner.fluid_segment_cache = job.fluid_segment_cache
	local batch_ok, batch_err = pcall(function()
		for i = start_index, end_index do
			local entity = job.entities[i]
			-- Skip loose ground items (item-entity): the generic serializer would emit a stackless,
			-- unrestorable "item-on-ground" record (silent loss). Captured WITH item payload by the
			-- atomic ground-item scan in complete().
			if entity and entity.valid and entity.type ~= "item-entity" then
				local entity_data = EntityScanner.serialize_entity(entity)
				if entity_data then
					table.insert(job.export_data.entities, entity_data)

					-- Track belt entities for deferred atomic item scan
					local category = Util.get_entity_category(entity)
					if GameUtils.BELT_ENTITY_TYPES[category] then
						local serialized_index = #job.export_data.entities
						job.belt_entities[serialized_index] = entity  -- Live LuaEntity reference
					end
				end
			end
		end
	end)
	EntityHandlers.skip_belt_items = false
	InventoryScanner.fluid_segment_cache = nil
	if not batch_ok then error(batch_err) end

	job.current_index = end_index

	-- Show progress every 10 batches
	if should_show_progress() and end_index % (batch_size * 10) == 0 then
		local progress = math.floor((end_index / job.total_entities) * 100)
		game.print(string.format("[Export %s] Progress: %d%% (%d/%d entities)",
			job.platform_name, progress, end_index, job.total_entities))
	end

	return job.current_index >= job.total_entities
end

--- Complete an export job: atomic belt scan, verification, compression, notifications, cleanup
--- @param job table: Job data
function ExportPipeline.complete(job)
	-- The job_id already contains the full export_id (platformName_tick_export_N)
	-- generated at queue time to prevent race conditions
	local export_id = job.job_id

	-- Start completion profiler (belt scan + verify + serialize + compress)
	PhaseProfiler.start(job.job_id, "completion")

	-- Store completed export with compression
	storage.platform_exports = storage.platform_exports or {}

	-- ========================================
	-- ATOMIC BELT ITEM SCAN (single-tick pass)
	-- ========================================
	-- During async entity scanning, belt item extraction was SKIPPED to prevent the
	-- "rolling snapshot" problem: belts can't be deactivated, so items keep moving
	-- between belts during multi-tick scanning, causing duplicates or missed items.
	--
	-- Now that all entity structure is serialized, we do a single-tick scan of ALL
	-- belt entities' transport lines. This gives an atomic, consistent snapshot of
	-- belt item positions — no items can move between belts within a single tick.
	-- ========================================
	local belt_scan_count = 0
	local belt_item_total = 0
	for serialized_index, live_entity in pairs(job.belt_entities or {}) do
		if live_entity and live_entity.valid then
			local belt_items = InventoryScanner.extract_belt_items(live_entity)
			local entity_data = job.export_data.entities[serialized_index]
			if entity_data and entity_data.specific_data then
				entity_data.specific_data.items = belt_items
				belt_scan_count = belt_scan_count + 1
				-- Count items for logging
				for _, line_data in ipairs(belt_items) do
					for _ in ipairs(line_data.items or {}) do
						belt_item_total = belt_item_total + 1
					end
				end
			end
		else
			log(string.format("[Belt Scan] WARNING: Belt entity at index %d became invalid before atomic scan",
				serialized_index))
		end
	end
	log(string.format("[Export] Atomic belt scan: %d belts scanned, %d item stacks captured (single tick)",
		belt_scan_count, belt_item_total))
	-- ========================================

	-- ========================================
	-- ATOMIC GROUND-ITEM SCAN (single-tick pass)
	-- ========================================
	-- Loose ground items (item-entity / "item-on-ground") are skipped by the async loop (which
	-- would emit a stackless, unrestorable record). Capture them here in one tick WITH their item
	-- payload, BEFORE verification, so they are both counted and restorable. Fixes silent
	-- ground-item loss on transfer.
	local ground_items = EntityScanner.scan_items_on_ground(job.surface)
	for _, ground_item in ipairs(ground_items) do
		table.insert(job.export_data.entities, ground_item)
	end
	log(string.format("[Export] Atomic ground-item scan: %d loose item stack(s) captured", #ground_items))
	-- ========================================

	-- CRITICAL: Generate verification data from SERIALIZED entity data
	-- Now includes the atomically-scanned belt items, so verification counts
	-- exactly match what will be restored on import (no rolling snapshot drift).
	local item_counts = Verification.count_all_items(job.export_data.entities)
	local fluid_counts = Verification.count_all_fluids(job.export_data.entities)
	log(string.format("[Export] Generated verification from serialized entity data (%d item types, %d fluid types)",
		table_size(item_counts), table_size(fluid_counts)))
	job.export_data.verification = {
		item_counts = item_counts,
		fluid_counts = fluid_counts
	}

	-- CRITICAL: Include frozen_states for restoring original active states on import
	-- The frozen_states map contains the ORIGINAL state of each entity BEFORE freezing.
	-- This allows import to restore entities to their pre-export active/disabled state.
	local lock_data = storage.locked_platforms and storage.locked_platforms[job.platform_name]
	if lock_data and lock_data.frozen_states then
		job.export_data.frozen_states = lock_data.frozen_states
		log(string.format("[Export] Including frozen_states for %d entities",
			lock_data.frozen_count or 0))
	end

	-- Debug: Check if verification exists before compression
	log(string.format("[Export] Before compression: has_verification=%s", tostring(job.export_data.verification ~= nil)))
	if job.export_data.verification then
		log(string.format("[Export] Verification has item_counts=%s, fluid_counts=%s",
			tostring(job.export_data.verification.item_counts ~= nil),
			tostring(job.export_data.verification.fluid_counts ~= nil)))
	end

	-- Convert to JSON and compress using helpers.encode_string (deflate + base64)
	local json_string = Util.encode_json_compat(job.export_data)
	local compressed = helpers.encode_string(json_string)

	if compressed then
		-- Store compressed data with metadata
		-- CRITICAL: Include verification as top-level field (not compressed) for transfer validation
		storage.platform_exports[export_id] = {
			compressed = true,
			compression = "deflate",
			payload = compressed,
			-- Preserve metadata for list_exports
			platform_name = job.export_data.platform_name,
			tick = job.export_data.tick,
			timestamp = job.export_data.timestamp,
			stats = job.export_data.stats,
			-- CRITICAL: Verification data must be accessible without decompression for transfers
			verification = job.export_data.verification
		}
		log(string.format("[Compression] Export %s: %d bytes → %d bytes (%.1f%% reduction)",
			export_id, #json_string, #compressed, (1 - #compressed / #json_string) * 100))
		log(string.format("[Export] Stored verification: item_counts=%s, fluid_counts=%s",
			tostring(job.export_data.verification and job.export_data.verification.item_counts ~= nil),
			tostring(job.export_data.verification and job.export_data.verification.fluid_counts ~= nil)))
	else
		-- Fallback to uncompressed if compression fails (verification already in export_data)
		storage.platform_exports[export_id] = job.export_data
		log(string.format("[Compression Warning] Failed to compress export %s, storing uncompressed", export_id))
	end

	-- Stop completion profiler
	PhaseProfiler.stop(job.job_id, "completion")

	-- Calculate duration
	local duration_ticks = game.tick - job.started_tick
	local duration_seconds = duration_ticks / 60
	local duration_ms = math.floor(duration_ticks * 16.67)
	local uncompressed_bytes = #json_string
	local compressed_bytes = compressed and #compressed or nil
	local compression_reduction_pct = nil
	if compressed_bytes and uncompressed_bytes > 0 then
		compression_reduction_pct = math.floor(((1 - (compressed_bytes / uncompressed_bytes)) * 1000) + 0.5) / 10
	end
	local exported_tile_count = #(job.export_data.tiles or {})
	local export_schedule_summary = PlatformSchedule.summarize(
		job.export_data.platform and job.export_data.platform.schedule or nil
	)

	-- Debug export: Write source platform data for comparison
	if job.destination_instance_id then
		-- This is a transfer export - save for comparison
		DebugExport.export_source_platform(job.export_data, job.platform_name)
	end

	-- Notify completion
	local message = string.format(
		"[Export Complete] %s (%d entities in %.1fs) - ID: %s",
		job.platform_name, job.total_entities, duration_seconds, export_id
	)
	game.print(message, {0, 1, 0})
	log(message)

	-- Notify requester if via RCON
	if job.requester == "RCON" then
		rcon.print(string.format("EXPORT_COMPLETE:%s", export_id))
	end

	-- Performance summary
	local perf = PhaseProfiler.get(job.job_id)
	if perf then
		-- CRITICAL: Use profiler objects directly in LocalisedString, NOT tostring().
		local msg = {"", "[Perf] Export '", job.platform_name, "' (", job.total_entities, " entities):\n",
			"  Scanning:   ", math.floor(duration_ticks * 16.67), "ms (", duration_ticks, " ticks)\n",
			"  Completion (belt+verify+compress): ", perf.completion}
		game.print(msg)
		
		-- Record to transaction history BEFORE discarding profilers
		TransactionHistory.record_export(job, perf)
		
		PhaseProfiler.discard(job.job_id)
	end

	-- Send export completion notification to Clusterio plugin via send_json event channel
	-- Note: Don't send full data - it's too large for a send_json payload. Plugin retrieves it via remote interface.
	if clusterio_api and clusterio_api.send_json then
		local event_payload = {
			export_id = export_id,
			platform_name = job.platform_name,
			platform_index = job.platform_index,
			entity_count = job.total_entities,
			duration_ticks = duration_ticks,
			duration_seconds = duration_seconds,
			destination_instance_id = job.destination_instance_id,  -- For auto-transfer
			export_metrics = {
				async_export_ticks = duration_ticks,
				async_export_ms = duration_ms,
				async_export_seconds = duration_seconds,
				entity_count = job.total_entities,
				tile_count = exported_tile_count,
				atomic_belt_entities = belt_scan_count,
				atomic_belt_item_stacks = belt_item_total,
				uncompressed_bytes = uncompressed_bytes,
				compressed_bytes = compressed_bytes,
				compression_reduction_pct = compression_reduction_pct,
				schedule_record_count = export_schedule_summary.record_count,
				schedule_interrupt_count = export_schedule_summary.interrupt_count,
			},
		}

		if job.destination_instance_id then
			log(string.format("[send_json] Sending export notification: %s (%d entities) → transfer to instance %d",
				export_id, job.total_entities, job.destination_instance_id))
		else
			log(string.format("[send_json] Sending export notification: %s (%d entities)", export_id, job.total_entities))
		end
		local send_success, send_err = pcall(function()
			clusterio_api.send_json("surface_export_complete", event_payload)
		end)

		if send_success then
			log("[send_json] Export notification sent successfully")
		else
			log(string.format("[send_json ERROR] Failed to send notification: %s", tostring(send_err)))
		end
	else
		log("[WARN] clusterio_api not available, export notification not sent to plugin")
	end

	storage.async_job_results[job.job_id] = {
		status = "complete",
		complete = true,
		type = "export",
		job_id = job.job_id,
		platform_name = job.platform_name,
		total_entities = job.total_entities,
		duration_ticks = duration_ticks,
		duration_seconds = duration_seconds,
		progress = 100,
		requester = job.requester
	}
	JobResults.prune(25)

	-- Handle pending file write if requested
	handle_pending_file_write(export_id)

	-- Unlock platform if this is NOT a transfer (transfers will delete the platform anyway)
	if not job.destination_instance_id then
		local unlock_success = SurfaceLock.unlock_platform(job.platform_name)
		if unlock_success then
			game.print(string.format("[Export] Platform %s unlocked - machines reactivated", job.platform_name), {0, 1, 0})
			if clusterio_api and clusterio_api.send_json then
				GameUtils.pcall_warn("[ExportPipeline] send_json surface_platform_state_changed", function()
					clusterio_api.send_json("surface_platform_state_changed", {
						platform_name = job.platform_name,
						force_name = job.force_name,
					})
				end)
			end
		end
	else
		log(string.format("[Export] Skipping unlock for transfer - platform %s will be deleted", job.platform_name))
	end

	-- Cleanup
	storage.async_jobs[job.job_id] = nil
end

return ExportPipeline
