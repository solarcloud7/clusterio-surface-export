-- FactorioSurfaceExport - Async Job Processor
-- Orchestrates export/import jobs across multiple ticks to prevent game freezing.
-- Delegates all job logic to focused pipeline modules.

local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local ImportSession = require("modules/surface_export/core/import-session")
local ExportPipeline = require("modules/surface_export/core/export-pipeline")
local ImportPipeline = require("modules/surface_export/core/import-pipeline")
local ImportCompletion = require("modules/surface_export/core/import-completion")

local AsyncProcessor = {}

-- Configuration storage (set via remote interface)
local config = {
	batch_size = 50,
	max_concurrent_jobs = 3,
	show_progress = true,
	sync_mode = false,  -- If true, process all entities in a single tick (for debugging)
}

--- Initialize storage for async jobs
function AsyncProcessor.init()
	storage.async_jobs = storage.async_jobs or {}
	storage.async_job_id_counter = storage.async_job_id_counter or 0
	storage.async_job_results = storage.async_job_results or {}
	storage.import_sessions = storage.import_sessions or {}
end

--- Set batch size
--- @param value number: Entities to process per tick
function AsyncProcessor.set_batch_size(value)
	config.batch_size = value
end

--- Set sync mode (process all entities in single tick for debugging)
--- @param value boolean: Whether to enable sync mode
function AsyncProcessor.set_sync_mode(value)
	config.sync_mode = value
	if value then
		log("[AsyncProcessor] SYNC MODE ENABLED - all entities will be processed in single tick")
		game.print("[AsyncProcessor] SYNC MODE ENABLED - all entities processed in single tick (debugging)", {1, 1, 0})
	else
		log("[AsyncProcessor] Sync mode disabled - normal async processing")
		game.print("[AsyncProcessor] Sync mode disabled - normal async processing", {0, 1, 0})
	end
end

--- Get sync mode status
function AsyncProcessor.get_sync_mode()
	return config.sync_mode
end

--- Set max concurrent jobs
--- @param value number: Maximum number of jobs to process simultaneously
function AsyncProcessor.set_max_concurrent_jobs(value)
	config.max_concurrent_jobs = value
end

--- Set show progress flag
--- @param value boolean: Whether to show progress messages
function AsyncProcessor.set_show_progress(value)
	config.show_progress = value
end

local function get_batch_size()
	if config.sync_mode then
		return 1000000  -- Process all entities in single tick for debugging
	end
	return config.batch_size
end

local function get_max_concurrent_jobs()
	return config.max_concurrent_jobs
end

local function should_show_progress()
	return config.show_progress
end

local function calculate_progress(job)
	if not job or not job.total_entities or job.total_entities == 0 then
		return 0
	end
	return math.floor((job.current_index / job.total_entities) * 100)
end

--- Queue an export job
--- @param platform_index number
--- @param force_name string
--- @param requester_name string|nil
--- @param destination_instance_id number|nil
--- @return string|nil, string|nil: job_id or error
function AsyncProcessor.queue_export(platform_index, force_name, requester_name, destination_instance_id)
	AsyncProcessor.init()
	return ExportPipeline.queue(platform_index, force_name, requester_name, destination_instance_id)
end

--- Begin a chunked import session
--- @param session_id string
--- @param total_chunks number
--- @param platform_name string|nil
--- @param force_name string|nil
--- @return boolean, string|nil
function AsyncProcessor.begin_import_session(session_id, total_chunks, platform_name, force_name)
	AsyncProcessor.init()
	return ImportSession.begin(session_id, total_chunks, platform_name, force_name)
end

--- Enqueue a chunk into a session
--- @param session_id string
--- @param chunk_index number
--- @param chunk_data string
--- @return boolean, string|nil
function AsyncProcessor.enqueue_import_chunk(session_id, chunk_index, chunk_data)
	AsyncProcessor.init()
	return ImportSession.enqueue_chunk(session_id, chunk_index, chunk_data)
end

--- Finalize a session, assemble payload, and queue async import
--- @param session_id string
--- @param checksum string|nil
--- @return string|nil, string|nil: job_id or error
function AsyncProcessor.finalize_import_session(session_id, checksum)
	AsyncProcessor.init()
	return ImportSession.finalize(session_id, checksum, ImportPipeline.queue)
end

--- Queue an import job from file
--- @param filename string: Filename in script-output/platform_exports/
--- @param new_platform_name string
--- @param force_name string
--- @param requester_name string|nil
--- @return string|nil, string|nil: job_id or error
function AsyncProcessor.queue_import_from_file(filename, new_platform_name, force_name, requester_name)
	AsyncProcessor.init()
	return ImportPipeline.queue_from_file(filename, new_platform_name, force_name, requester_name)
end

--- Queue an import job from JSON string
--- @param json_data string: JSON string of platform data
--- @param new_platform_name string
--- @param force_name string
--- @param requester_name string|nil
--- @return string|nil, string|nil: job_id or error
function AsyncProcessor.queue_import(json_data, new_platform_name, force_name, requester_name, receive_timing)
	AsyncProcessor.init()
	return ImportPipeline.queue(json_data, new_platform_name, force_name, requester_name, receive_timing)
end

--- Process all active async jobs (called on_tick)
function AsyncProcessor.process_tick()
	if not storage.async_jobs then return end
	ImportSession.prune()

	-- Collect jobs and sort by priority (started_tick - older jobs first)
	local job_list = {}
	for job_id, job in pairs(storage.async_jobs) do
		table.insert(job_list, {id = job_id, job = job, started = job.started_tick or 0})
	end
	table.sort(job_list, function(a, b) return a.started < b.started end)

	-- Periodic progress logging (every 60 ticks = ~1 second)
	if #job_list > 0 and game.tick % 60 == 0 and should_show_progress() then
		for _, entry in ipairs(job_list) do
			local job = entry.job
			local elapsed = game.tick - (job.started_tick or game.tick)
			log(string.format("[Process Tick] job=%s, type=%s, platform='%s', progress=%d/%d (%d%%), elapsed=%d ticks (%.1fs)",
				entry.id, job.type, job.platform_name or "?",
				job.current_index or 0, job.total_entities or 0,
				calculate_progress(job),
				elapsed, elapsed / 60))
		end
	end

	-- Process only up to max_concurrent jobs per tick
	local processed = 0
	for _, entry in ipairs(job_list) do
		if processed >= get_max_concurrent_jobs() then
			break  -- Hit concurrent limit, remaining jobs wait until next tick
		end

		local job = entry.job

		if job.type == "export" then
			local done = ExportPipeline.process_batch(job, get_batch_size, should_show_progress)
			if done then
				ExportPipeline.complete(job)
			end
		elseif job.type == "import" then
			if job.pending_beacon_tick then
				-- Phase 1 done (entities placed); waiting one tick before inventory restore (Phase 2).
				if game.tick >= job.pending_beacon_tick then
					job.pending_beacon_tick = nil
					ImportCompletion.run_phase2(job)
				end
			else
				local done = ImportPipeline.process_batch(job, get_batch_size, should_show_progress)
				if done then
					ImportCompletion.run_phase1(job)
					-- Phase 2 fires next tick when job.pending_beacon_tick is set
				end
			end
		end

		processed = processed + 1
	end
end

--- Get status of all active jobs
--- @return table: Array of job status info
function AsyncProcessor.get_active_jobs()
	AsyncProcessor.init()

	local jobs = {}
	for job_id, job in pairs(storage.async_jobs) do
		table.insert(jobs, {
			job_id = job_id,
			type = job.type,
			platform_name = job.platform_name,
			progress = calculate_progress(job),
			entities_processed = job.current_index,
			total_entities = job.total_entities,
			elapsed_ticks = game.tick - job.started_tick
		})
	end

	return jobs
end

--- Get status for a specific job
--- @param job_id string
--- @return table|nil, string|nil
function AsyncProcessor.get_job_status(job_id)
	AsyncProcessor.init()

	if storage.async_jobs[job_id] then
		local job = storage.async_jobs[job_id]
		return {
			status = "active",
			complete = false,
			type = job.type,
			job_id = job_id,
			platform_name = job.platform_name,
			progress = calculate_progress(job),
			entities_processed = job.current_index,
			total_entities = job.total_entities,
			elapsed_ticks = game.tick - job.started_tick
		}
	end

	if storage.async_job_results[job_id] then
		return storage.async_job_results[job_id]
	end

	return nil, "Job not found"
end

--- Activate a platform surface (exported for use by commands)
--- @param surface LuaSurface: The platform surface
--- @return number: Number of entities activated
function AsyncProcessor.activate_platform(surface)
	return SurfaceLock.activate_all(surface)
end

return AsyncProcessor
