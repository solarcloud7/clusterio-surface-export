local Util = require("modules/surface_export/utils/util")
local Timing = {}
local jobs = {}
local batch_limit = 2000
local expected_stages = {
	["source-lua"] = {"preflight", "locking", "preparation", "scheduler_wait", "entities", "belt_capture", "ground_items", "verification_census", "finalize_payload", "serialization", "compression", "cache_output", "diagnostic_output", "file_output", "source_unlock", "failure_diagnostics"},
	["destination-lua"] = {"queue_setup", "decode", "decompression", "decode_payload", "compatibility_checks", "platform_preparation", "scheduler_wait", "tiles", "beacons", "entities", "hub_mapping", "hub", "belts", "state", "deferred_beacon_wait", "inventories", "held_items", "fluids", "verdict_handling", "verification_preparation", "exact_verification", "item_census", "fluid_census", "item_comparison", "fluid_comparison", "diagnostic_capture", "diagnostic_output", "failure_diagnostics", "passenger_evacuation", "destination_recovery", "activation", "loss_analysis"},
}

local function snapshot(clock)
	local value = helpers.create_profiler(true)
	value.add(clock)
	return value
end

local function emit(job, stage, status)
	stage.revision = (stage.revision or 0) + 1
	local meta = {
		v = 1, id = stage.id, jobId = job.id, owner = job.owner,
		operationId = job.operation_id, exportId = job.export_id,
		stage = stage.name, parent = stage.parent, kind = stage.kind,
		status = status, revision = stage.revision,
		startTick = stage.start_tick, endTick = stage.end_tick,
		ticksElapsed = stage.end_tick and stage.start_tick and stage.end_tick - stage.start_tick or nil,
		batchCount = stage.count, workTicks = stage.work_ticks, batch = stage.batch,
		truncated = job.truncated or nil,
	}
	log({"", "[SE_TIMING_V1]", Util.encode_json_compat(meta), "\t", stage.start or "-",
		"\t", stage.finish or "-", "\t", stage.kind == "execution" and stage.count and stage.count > 0 and stage.execution or "-"})
end

function Timing.begin(id, owner, operation_id, export_id)
	if jobs[id] then return end
	jobs[id] = { id = id, owner = owner, operation_id = operation_id, export_id = export_id,
		clock = helpers.create_profiler(), stages = {}, batches = 0 }
	Timing.start(id, "job", "inclusive")
end

function Timing.bind(id, operation_id, export_id)
	local job = jobs[id]
	if job then
		job.operation_id = operation_id or job.operation_id
		job.export_id = export_id or job.export_id
	end
end

function Timing.start(id, name, kind, parent)
	local job = jobs[id]
	if not job then return end
	local stage = job.stages[name]
	if not stage then
		stage = { id = name, name = name, kind = kind or "execution", parent = parent,
			start = snapshot(job.clock), start_tick = game.tick,
			execution = helpers.create_profiler(true), count = 0, work_ticks = 0 }
		job.stages[name] = stage
		emit(job, stage, "running")
	end
	if stage.running then return end
	stage.running = true
	if stage.kind == "execution" then
		stage.execution.restart()
		stage.count = stage.count + 1
		if stage.last_tick ~= game.tick then stage.work_ticks = stage.work_ticks + 1 end
		stage.last_tick = game.tick
		if storage.surface_export_config and storage.surface_export_config.profile_batches then
			if job.batches < batch_limit then
				job.batches = job.batches + 1
				stage.sample = { id = name .. ":batch:" .. stage.count, name = name,
					parent = name, kind = "execution", batch = stage.count, count = 1, work_ticks = 1,
					start = snapshot(job.clock), start_tick = game.tick, execution = helpers.create_profiler() }
			else job.truncated = true end
		end
	end
end

function Timing.stop(id, name)
	local job = jobs[id]
	local stage = job and job.stages[name]
	if not stage or not stage.running then return end
	stage.execution.stop()
	stage.running = false
	stage.finish = snapshot(job.clock)
	stage.end_tick = game.tick
	if stage.sample then
		local sample = stage.sample
		sample.execution.stop()
		sample.finish = snapshot(job.clock)
		sample.end_tick = game.tick
		emit(job, sample, "completed")
		stage.sample = nil
	end
end

function Timing.fail(id, name)
	local job = jobs[id]
	if job and job.stages[name] then job.stages[name].failed = true end
end

function Timing.finish(id, status, expected)
	local job = jobs[id]
	if not job then return end
	for _, name in ipairs(expected or (job.stages.chunk_delivery and {} or expected_stages[job.owner]) or {}) do
		if not job.stages[name] then
			job.stages[name] = { id = name, name = name, kind = "execution", skipped = true }
		end
	end
	for name, stage in pairs(job.stages) do
		local was_running = stage.running
		Timing.stop(id, name)
		emit(job, stage, stage.skipped and "skipped" or stage.failed and "failed" or (was_running and status ~= "completed" and status or "completed"))
	end
	jobs[id] = nil
end

function Timing.scope(id, name, fn, ...)
	Timing.start(id, name)
	local function invoke(...) return table.pack(fn(...)) end
	local ok, result = pcall(invoke, ...)
	Timing.stop(id, name)
	if not ok then
		log("[SE_TIMING_SCOPE_ERROR] " .. name .. ": " .. tostring(result))
		local job = jobs[id]
		if job and job.stages[name] then job.stages[name].failed = true end
		error(result, 0)
	end
	return table.unpack(result, 1, result.n)
end

for name, fn in pairs(Timing) do
	if name ~= "scope" then
		Timing[name] = function(...)
			local ok, err = pcall(fn, ...)
			if not ok then log("[SE_TIMING_ERROR] " .. name .. ": " .. tostring(err)) end
		end
	end
end

return Timing
