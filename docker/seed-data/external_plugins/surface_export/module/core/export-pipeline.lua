-- FactorioSurfaceExport - Export Pipeline
-- Handles the full export job lifecycle: queuing, per-tick batch scanning, and completion.

local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local EntityHandlers = require("modules/surface_export/export_scanners/entity-handlers")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local FluidOwnership = require("modules/surface_export/utils/fluid-ownership")
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
local CensusAccumulator = require("modules/surface_export/export_scanners/census-accumulator")

local ExportPipeline = {}

--- Test-only ONE-SHOT: simulate a serializer omission the paired-read source census must catch.
--- Drops one serialized inventory stack from THIS entity_data AFTER serialization and BEFORE the
--- census records it, so physical (full) > serialized (short) and the verdict fails. Fires PRE-verdict,
--- so a leaked flag makes the NEXT transfer export ABORT and PRESERVE its source (self-protecting —
--- enumerated in lint:test-hooks FAIL_SAFE_HOOKS; Pitfall #30, mutating test hooks must be fail-safe on leak).
--- @param entity_data table: the just-serialized entity form (mutated in place on a hit)
local function maybe_inject_census_omission(entity_data)
	local cfg = storage.surface_export_config
	if not (cfg and cfg.test_force_census_omission) then return end
	local invs = entity_data and entity_data.specific_data and entity_data.specific_data.inventories
	if not invs then return end
	for _, inv in ipairs(invs) do
		if inv.items and #inv.items > 0 then
			local removed = table.remove(inv.items, 1)  -- drop one serialized stack (physical still has it)
			cfg.test_force_census_omission = nil          -- consume: one entity, one export
			log(string.format(
				"[Census][test hook] test_force_census_omission dropped serialized stack '%s' x%d from entity_id=%s",
				tostring(removed and removed.name),
				tonumber(removed and removed.count) or 0,
				tostring(entity_data.entity_id)))
			return
		end
	end
end

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
			-- Use the pcall-guarded compat wrapper: on Factorio 2.0 `game.write_file` does not exist and even
			-- ACCESSING the key throws ("LuaGameScript doesn't contain key write_file"), which crashed the host
			-- instance on every /export-platform-file. write_file_compat falls back to helpers.write_file.
			local wrote_ok, write_err = Util.write_file_compat(filename, json_string, false)
			if wrote_ok then
				log(string.format("[Export] File written: %s (%d bytes)", filename, #json_string))
				game.print(string.format("[Export] File written: script-output/%s", filename), {0, 1, 0})
			else
				log(string.format("[Export ERROR] write_file failed for %s: %s", filename, tostring(write_err)))
				game.print(string.format("[Export ERROR] Could not write file %s", filename), {1, 0.3, 0})
			end
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
--- @param gateway_target string|nil: If set, this is a GATEWAY transfer — the destination parks the
---        imported platform at this gateway (paused) and strips the gateway hop. Stamped into the
---        payload (rides the compressed blob, opaque to the TS layers; read on the dest as
---        platform_data.platform.gateway_target). nil for ordinary transfers/exports.
--- @return string|nil, string|nil: job_id or nil + error
function ExportPipeline.queue(platform_index, force_name, requester_name, destination_instance_id, gateway_target)
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

	-- Transferability gate — the chokepoint for the ASYNC export/transfer path (web, ctl, in-game transfers
	-- + gateway). Only a real, materialized space platform (one with a hub) may be exported; a hub-less
	-- source would produce a trivially-passing "green" (~0 content → ~0 loss) and misleading details.
	-- Hub-less stubs (waiting_for_starter_pack) are already caught above by the surface==nil check; this
	-- also covers the surface-valid-but-hub-missing edge. NOTE: the SYNCHRONOUS Serializer.export_platform
	-- path (reached via clone_platform) is separate and NOT gated here — it neither transfers nor deletes a
	-- source, so an empty clone is harmless; add the same guard there if it ever becomes a transfer source.
	if not GameUtils.platform_has_hub(platform) then
		return nil, string.format(
			"Platform '%s' (index %d) has no hub — not a transferable platform",
			platform.name, platform_index)
	end

	-- NOTE: passengers are NOT blocked here. A transfer is allowed with players aboard; they are evacuated to
	-- a planet at the SOLE source-delete chokepoint (delete_platform_for_transfer → Gateway.evacuate_passengers)
	-- so no one is orphaned and no entry point can be bypassed. See gateway.lua.

	local lock_opts = {
		kind = destination_instance_id and "transfer" or "export",
		job_id = job_id,
		expires_tick = game.tick + SurfaceLock.DEFAULT_TRANSFER_LOCK_TTL_TICKS,
	}

	-- CRITICAL: Lock the platform BEFORE scanning to ensure stable item/fluid counts
	-- This completes cargo pods, deactivates machines, and hides surface
	local lock_success, lock_err = SurfaceLock.lock_platform(platform, force, lock_opts)
	if not lock_success then
		-- If already locked by this transfer path, that's fine - just note it. A transfer targeting a platform
		-- already locked by a non-transfer lock returns a distinct error and is refused below.
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
		SurfaceLock.unlock_platform(platform.index)
		return nil, "Failed to capture platform schedule: " .. tostring(schedule_err)
	end
	local schedule_summary = PlatformSchedule.summarize(platform_schedule)
	log(string.format("[Export] Captured platform schedule: records=%d, interrupts=%d, group=%s",
		schedule_summary.record_count,
		schedule_summary.interrupt_count,
		tostring(schedule_summary.group)))

	local entities = surface.find_entities_filtered({})
	local engine_owned_segments = FluidOwnership.collect_engine_owned_segments(entities)

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
		-- Paired-reads source census (Task 4). Storage-safe plain data — it lives here in
		-- storage.async_jobs across the multi-tick walk; record() folds physical-vs-serialized
		-- per entity in the SAME execution the entity is serialized in. The census shares the
		-- serializer's pre-passed engine-owned segment set (rationale + measurement: the
		-- ENGINE-OWNED FLUIDS note in census-accumulator.lua).
		census = CensusAccumulator.new(engine_owned_segments),
		-- Fluid segment dedup cache: seg_id → {fluid, amount, temp}
		-- Shared across all export batches so each segment is serialized exactly once
		-- at the segment-level weighted-average temperature (matches FluidRestoration output)
		fluid_segment_cache = {},
		engine_owned_segments = engine_owned_segments,
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
				-- Explicit gateway-transfer signal (nil ⇒ ordinary transfer). Rides the same payload
				-- rails as `schedule`; the dest reads it as platform_data.platform.gateway_target.
				gateway_target = gateway_target,
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
	InventoryScanner.engine_owned_segments = job.engine_owned_segments
	local batch_ok, batch_err = pcall(function()
		for i = start_index, end_index do
			local entity = job.entities[i]
			-- Exclude non-cargo entities (loose ground items + passengers) via the SINGLE shared predicate, so
			-- this async transfer path and the sync EntityScanner.scan_surface cannot drift. Ground items are
			-- captured separately WITH their payload by the atomic scan in complete(); characters are evacuated,
			-- not copied (the cardinal-sin duplication guard — see EntityScanner.is_exportable_entity).
			if EntityScanner.is_exportable_entity(entity) then
				local entity_data = EntityScanner.serialize_entity(entity)
				if entity_data then
					-- Test-only one-shot: drop a serialized stack to simulate a serializer omission the
					-- census must catch (post-serialization, pre-record). No-op unless armed.
					maybe_inject_census_omission(entity_data)

					table.insert(job.export_data.entities, entity_data)

					-- Track belt entities for deferred atomic item scan
					local category = Util.get_entity_category(entity)
					if GameUtils.BELT_ENTITY_TYPES[category] then
						local serialized_index = #job.export_data.entities
						job.belt_entities[serialized_index] = entity  -- Live LuaEntity reference
					else
						-- Paired source census (Task 4): fold the PHYSICAL and SERIALIZED reads of this ONE
						-- entity in the SAME Lua execution it was serialized in. Belt-type entities are
						-- DEFERRED — their items are not serialized until the atomic pass in complete()
						-- (skip_belt_items) — so they are paired there instead (Pitfall #16, atomic belt scan).
						CensusAccumulator.record(job.census, entity, entity_data)
					end
				end
			end
		end
	end)
	EntityHandlers.skip_belt_items = false
	InventoryScanner.fluid_segment_cache = nil
	InventoryScanner.engine_owned_segments = nil
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
				-- Paired source census (Task 4) for belts: the physical read re-derives belt contents via
				-- extract_belt_items INDEPENDENTLY of the just-patched serialized copy. CRITICAL: belt pairing
				-- is ONLY valid inside this single-tick atomic pass — belts cannot be frozen, so items move
				-- between ticks; the physical read and the serialized items must be the SAME tick (Pitfall #16).
				CensusAccumulator.record(job.census, live_entity, entity_data)
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
	-- DEVIATION (Task 4 item 4): ground items are intentionally NOT census-paired. count_entity_items
	-- (validators/surface-counter.lua) has no item-entity branch, so a paired read of an item-entity
	-- would be physical=0 vs serialized=N => a spurious census abort on EVERY loose ground item. There
	-- is also no handler-dispatch layer to omit here (scan_items_on_ground reads stack.name/count directly),
	-- so the census has no omission surface to catch; ground-item conservation is covered by the dest gate.
	-- Making it commensurate would require editing the gate-feeding validator (out of scope) — adjudicate
	-- at /di-change if independent ground coverage is wanted.
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
	local engine_owned_fluid_counts = Verification.count_engine_owned_fluids(job.export_data.entities)
	log(string.format("[Export] Generated verification from serialized entity data (%d item types, %d fluid types)",
		table_size(item_counts), table_size(fluid_counts)))
	job.export_data.verification = {
		item_counts = item_counts,
		fluid_counts = fluid_counts,
		engine_owned_fluid_counts = engine_owned_fluid_counts
	}

	-- ========================================
	-- PAIRED-READS SOURCE CENSUS VERDICT (Task 4)
	-- ========================================
	-- Every entity was paired physical-vs-serialized in the SAME execution it was serialized in
	-- (non-belts in process_batch, belts in the atomic pass above). The verdict applies the same
	-- exact contract as the frozen transfer gate. This is a SOURCE-side omission check the destination
	-- gate structurally cannot see: a serializer that drops an item makes BOTH the exported payload AND
	-- the dest gate's "expected" wrong, so they agree while silently losing data.
	job.census_verdict = CensusAccumulator.verdict(job.census)
	if job.destination_instance_id then
		-- TRANSFER: fail closed on a mismatch. Do NOT store or send the export; the destination is
		-- never contacted (the surface_export_complete -> TransferPlatformRequest continuation cannot
		-- run). The census totals are NOT attached to the transmitted payload — they would only bloat
		-- the RCON-bottlenecked transfer path; a mismatch aborts and a clean verdict just proceeds.
		if not job.census_verdict.ok then
			ExportPipeline.abort_transfer_on_census_mismatch(job)
			return
		end
	else
		-- Non-transfer export (file / clone / uploaded-source): no source-delete risk, so NEVER abort.
		-- Attach the verdict for inspection; log a loud warning on a mismatch, export the payload anyway.
		job.export_data.census_verdict = job.census_verdict
		if not job.census_verdict.ok then
			log(string.format(
				"[Census][WARN] Source census MISMATCH on non-transfer export '%s': %d mismatch row(s) — exporting anyway (no source-delete risk)",
				job.platform_name, #job.census_verdict.mismatches))
		end
	end

	-- CRITICAL: Include frozen_states for restoring original active states on import
	-- The frozen_states map contains the ORIGINAL state of each entity BEFORE freezing.
	-- This allows import to restore entities to their pre-export active/disabled state.
	local lock_data = storage.locked_platforms and storage.locked_platforms[job.platform_index]
	if lock_data and lock_data.frozen_states then
		job.export_data.frozen_states = lock_data.frozen_states
		log(string.format("[Export] Including frozen_states for %d entities",
			lock_data.frozen_count or 0))
	end

	-- Source force research bonuses that govern INSERTER HAND CAPACITY. These are not entity data — they
	-- live in the source force's tech tree — so the import side replicates them onto the destination force
	-- BEFORE hydration; otherwise a less-researched dest physically caps each inserter hand below what the
	-- source held, and the held items are genuinely unplaceable (see Pitfall #28 / the held-item root cause).
	local src_force = game.forces[job.force_name]
	if src_force and src_force.valid then
		local force_data = {}
		for _, prop in ipairs(GameUtils.FORCE_SYNC_PROPS) do
			force_data[prop] = src_force[prop]
		end
		job.export_data.force_data = force_data
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
		local unlock_success = SurfaceLock.unlock_platform(job.platform_index)
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

--- Fail-closed abort for a TRANSFER export whose paired-read source census found a mismatch.
--- The destination is NEVER contacted: the export is not stored or sent, so the
--- surface_export_complete -> TransferPlatformRequest continuation cannot run. Banks an always-on
--- forensic bundle (write_failure_black_box deliberately bypasses the debug gate),
--- unlocks/preserves the source, marks the job failed, and signals the failure on the existing
--- export-completion channel with an export_failed_* id (the TS handleExportComplete recognizer
--- isInvalidExportId refuses it -> a double guard at the boundary).
--- @param job table: the export job (destination_instance_id set, census_verdict not ok)
function ExportPipeline.abort_transfer_on_census_mismatch(job)
	local verdict = job.census_verdict or { mismatches = {}, totals = {} }
	local mismatch_count = #(verdict.mismatches or {})
	local safe_name = string.gsub(job.platform_name or "unknown", "[^%w_-]", "_")
	local filename = string.format("census_%s_%d.json", safe_name, game.tick)

	-- Always-on forensic bundle (bypasses the debug gate) — must exist before we discard the transfer.
	local bundle = {
		reason = "source_census_mismatch",
		platform_name = job.platform_name,
		platform_index = job.platform_index,
		destination_instance_id = job.destination_instance_id,
		gate_tick = game.tick,
		started_tick = job.started_tick,
		verdict_ok = verdict.ok,
		mismatch_count = mismatch_count,
		mismatches = verdict.mismatches,
		totals = verdict.totals,
	}
	local written = DebugExport.write_failure_black_box(filename, bundle)

	log(string.format(
		"[Census][ABORT] Transfer export '%s' ABORTED — source census mismatch: %d row(s); destination NOT contacted; source preserved. Bundle=%s",
		job.platform_name, mismatch_count, tostring(written)))
	game.print(string.format(
		"[Census] Transfer of '%s' ABORTED — source serialization mismatch detected; source preserved.",
		job.platform_name), {1, 0.3, 0})

	-- Unlock (preserve) the source — the same path a non-transfer/failed export uses.
	local unlock_success = SurfaceLock.unlock_platform(job.platform_index)
	if unlock_success and clusterio_api and clusterio_api.send_json then
		GameUtils.pcall_warn("[ExportPipeline] send_json surface_platform_state_changed (census abort)", function()
			clusterio_api.send_json("surface_platform_state_changed", {
				platform_name = job.platform_name,
				force_name = job.force_name,
			})
		end)
	end

	-- Signal the failure on the existing export-completion channel. isInvalidExportId(export_failed*)
	-- makes the TS handler log-and-return WITHOUT contacting the destination (double guard).
	if clusterio_api and clusterio_api.send_json then
		GameUtils.pcall_warn("[ExportPipeline] send_json surface_export_complete (census abort)", function()
			clusterio_api.send_json("surface_export_complete", {
				export_id = "export_failed_census_" .. safe_name,
				platform_name = job.platform_name,
				platform_index = job.platform_index,
				destination_instance_id = job.destination_instance_id,
				census_failure = true,
				census_mismatch_count = mismatch_count,
				failure_black_box = written,
			})
		end)
	end

	if job.requester == "RCON" then
		rcon.print(string.format("EXPORT_FAILED:census_mismatch:%s", job.platform_name))
	end

	-- Record a FAILED job result (mirror the success shape) so the job never looks green or leaks.
	storage.async_job_results[job.job_id] = {
		status = "failed",
		complete = true,
		failed = true,
		type = "export",
		job_id = job.job_id,
		platform_name = job.platform_name,
		error = "source_census_mismatch",
		census_mismatch_count = mismatch_count,
		requester = job.requester,
	}
	JobResults.prune(25)

	-- Discard the completion profiler and clear the job so it cannot be reprocessed.
	PhaseProfiler.discard(job.job_id)
	storage.async_jobs[job.job_id] = nil
end

return ExportPipeline
