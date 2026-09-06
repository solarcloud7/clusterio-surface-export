local Timing = require("modules/surface_export/utils/operation-timing")
local PhaseProfiler = require("modules/surface_export/utils/phase-profiler")

local PhaseRecorder = {}

PhaseRecorder.IMPORT_PHASES = {
	{ name = "queue_setup" },
	{ name = "delivery",      from = "delivery_started_tick",      to = "delivery_completed_tick",      external = true, profiled = false },
	{ name = "queue",         from_job = "started_tick",           to = "tiles_started_tick",           external = true, profiled = false },
	{ name = "tiles",         from = "tiles_started_tick",         to = "tiles_completed_tick",         profiled = false },
	{ name = "beacons" },
	{ name = "entities",      from = "entities_started_tick",      to = "entities_completed_tick",      profiled = false },
	{ name = "hub",           from = "hub_started_tick",           to = "hub_completed_tick",           profiler = "hub_restore" },
	{ name = "belts",         from = "belts_started_tick",         to = "belts_completed_tick" },
	{ name = "state",         from = "state_started_tick",         to = "state_completed_tick" },
	{ name = "inventories",   from = "inventories_started_tick",   to = "inventories_completed_tick" },
	{ name = "held_items",    from = "held_items_started_tick",    to = "held_items_completed_tick" },
	{ name = "fluids",        from = "fluids_started_tick",        to = "fluids_completed_tick" },
	{ name = "validation",    from = "validation_started_tick",    to = "validation_done_tick" },
	{ name = "activation",    from = "activation_started_tick",    to = "activation_completed_tick" },
	{ name = "loss_analysis", from = "loss_analysis_started_tick", to = "loss_analysis_completed_tick" },
}

local by_name = {}
for _, spec in ipairs(PhaseRecorder.IMPORT_PHASES) do by_name[spec.name] = spec end

function PhaseRecorder.profiler_names()
	local names = {}
	for _, spec in ipairs(PhaseRecorder.IMPORT_PHASES) do
		if spec.profiled ~= false then
			names[#names + 1] = spec.profiler or spec.name
		end
	end
	return names
end

local function spec_for(name, caller)
	local spec = by_name[name]
	if not spec then
		log(string.format("[PhaseRecorder] %s: unknown phase '%s' -- not in IMPORT_PHASES, so nothing "
			.. "was recorded. Add it there rather than re-adding a one-off mark.", caller, tostring(name)))
	end
	return spec
end

function PhaseRecorder.start(job, name)
	if name ~= "entities" and name ~= "tiles" then Timing.start(job.job_id, name) end
	local spec = spec_for(name, "start")
	if not spec then return end
	job.metrics = job.metrics or {}
	if spec.from then job.metrics[spec.from] = game.tick end
	if spec.profiled ~= false then PhaseProfiler.start(job.job_id, spec.profiler or spec.name) end
end

function PhaseRecorder.stop(job, name)
	if name ~= "entities" and name ~= "tiles" then Timing.stop(job.job_id, name) end
	local spec = spec_for(name, "stop")
	if not spec then return end
	job.metrics = job.metrics or {}
	if spec.to then job.metrics[spec.to] = game.tick end
	if spec.profiled ~= false then PhaseProfiler.stop(job.job_id, spec.profiler or spec.name) end
end

function PhaseRecorder.phase_ticks(job, name)
	local spec = spec_for(name, "phase_ticks")
	if not spec then return nil end
	if not spec.to or not (spec.from or spec.from_job) then return nil end
	local metrics = job.metrics or {}
	local started = spec.from_job and job[spec.from_job] or metrics[spec.from]
	local completed = metrics[spec.to]
	if not started or not completed then return nil end
	return math.max(0, completed - started)
end

function PhaseRecorder.build_spans(job, t0)
	local metrics = job.metrics or {}
	local spans = {}
	for _, spec in ipairs(PhaseRecorder.IMPORT_PHASES) do
		if spec.to and (spec.from or spec.from_job) then
			local started = spec.from_job and job[spec.from_job] or metrics[spec.from]
			local completed = metrics[spec.to]
			if started and completed then
				spans[#spans + 1] = {
					name = spec.name,
					start_tick = started,
					end_tick = completed,
					start_offset_ticks = math.max(0, started - t0),
					ticks_elapsed = math.max(0, completed - started),
				}
			end
		end
	end
	return spans
end

return PhaseRecorder
