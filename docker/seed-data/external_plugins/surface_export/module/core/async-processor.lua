local Timing = require("modules/surface_export/utils/operation-timing")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local ImportSession = require("modules/surface_export/core/import-session")
local ExportCache = require("modules/surface_export/utils/export-cache")
local ExportPipeline = require("modules/surface_export/core/export-pipeline")
local ImportPipeline = require("modules/surface_export/core/import-pipeline")
local ImportCompletion = require("modules/surface_export/core/import-completion")
local ActiveStateRestoration = require("modules/surface_export/import_phases/active_state_restoration")
local LatchRearm = require("modules/surface_export/import_phases/latch_rearm")
local GatewayConfigStaging = require("modules/surface_export/core/gateway-config-staging")

local AsyncProcessor = {}

local config = {
	batch_size = 50,
	max_concurrent_jobs = 3,
	show_progress = true,
	sync_mode = false,
}

ExportCache.set_concurrency(config.max_concurrent_jobs)

function AsyncProcessor.init()
	storage.async_jobs = storage.async_jobs or {}
	storage.async_job_id_counter = storage.async_job_id_counter or 0
	storage.async_job_results = storage.async_job_results or {}
	storage.import_sessions = storage.import_sessions or {}
end

function AsyncProcessor.set_batch_size(value)
	config.batch_size = value
end

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

function AsyncProcessor.get_sync_mode()
	return config.sync_mode
end

function AsyncProcessor.set_max_concurrent_jobs(value)
	config.max_concurrent_jobs = value
	ExportCache.set_concurrency(value)
end

function AsyncProcessor.set_show_progress(value)
	config.show_progress = value
end

function AsyncProcessor.set_max_export_cache_size(value)
	ExportCache.set_cap(value)
end

function AsyncProcessor.get_max_export_cache_size()
	return ExportCache.get_cap()
end

function AsyncProcessor.get_max_concurrent_jobs()
	return config.max_concurrent_jobs
end

local function get_batch_size()
	if config.sync_mode then
		return 1000000
	end
	return config.batch_size
end

local function get_max_concurrent_jobs()
	return AsyncProcessor.get_max_concurrent_jobs()
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

function AsyncProcessor.queue_export(platform_index, force_name, requester_name, destination_instance_id, gateway_target, clone_dest_name)
	AsyncProcessor.init()
	return ExportPipeline.queue(platform_index, force_name, requester_name, destination_instance_id, gateway_target, clone_dest_name)
end

function AsyncProcessor.begin_import_session(session_id, total_chunks, platform_name, force_name)
	AsyncProcessor.init()
	return ImportSession.begin(session_id, total_chunks, platform_name, force_name)
end

function AsyncProcessor.enqueue_import_chunk(session_id, chunk_index, chunk_data)
	AsyncProcessor.init()
	return ImportSession.enqueue_chunk(session_id, chunk_index, chunk_data)
end

function AsyncProcessor.finalize_import_session(session_id, checksum)
	AsyncProcessor.init()
	return ImportSession.finalize(session_id, checksum, ImportPipeline.queue)
end

function AsyncProcessor.queue_import_from_file(filename, new_platform_name, force_name, requester_name)
	AsyncProcessor.init()
	return ImportPipeline.queue_from_file(filename, new_platform_name, force_name, requester_name)
end

function AsyncProcessor.queue_import(json_data, new_platform_name, force_name, requester_name, receive_timing)
	AsyncProcessor.init()
	return ImportPipeline.queue(json_data, new_platform_name, force_name, requester_name, receive_timing)
end

function AsyncProcessor.process_tick()
	ActiveStateRestoration.service_pending_mining_progress()
	LatchRearm.process_tick()
	GatewayConfigStaging.prune()
	if not storage.async_jobs then return end
	ImportSession.prune()

	local job_list = {}
	for job_id, job in pairs(storage.async_jobs) do
		table.insert(job_list, {id = job_id, job = job, started = job.started_tick or 0})
	end
	table.sort(job_list, function(a, b) return a.started < b.started end)

	if #job_list > 0 and game.tick % 60 == 0 and should_show_progress() then
		for _, entry in ipairs(job_list) do
			local job = entry.job
			local elapsed = game.tick - (job.started_tick or game.tick)
			log(string.format("[Process Tick] job=%s, type=%s, platform='%s', progress=%d/%d (%d%%), elapsed=%d ticks",
				entry.id, job.type, job.platform_name or "?",
				job.current_index or 0, job.total_entities or 0,
				calculate_progress(job),
				elapsed))
		end
	end

	local processed = 0
	for _, entry in ipairs(job_list) do
		if processed >= get_max_concurrent_jobs() then
			break
		end

		local job = entry.job

		if job.type == "export" then
			local done = Timing.scope(job.job_id, "entities", ExportPipeline.process_batch, job, get_batch_size, should_show_progress)
			if done then
				ExportPipeline.complete(job)
			end
		elseif job.type == "import" then
			if job.pending_beacon_tick then
				if game.tick >= job.pending_beacon_tick then
					job.pending_beacon_tick = nil
					ImportCompletion.run_phase2(job)
				end
			else
				local done = ImportPipeline.process_batch(job, get_batch_size, should_show_progress)
				if done then
					ImportCompletion.run_phase1(job)
				end
			end
		end

		processed = processed + 1
	end
end

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

function AsyncProcessor.activate_platform(surface)
	return SurfaceLock.activate_all(surface)
end

return AsyncProcessor
