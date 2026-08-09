local PhaseProfiler = {}

local active = {}

function PhaseProfiler.init(job_id, phase_names)
	active[job_id] = {}
	for _, name in ipairs(phase_names) do
		active[job_id][name] = helpers.create_profiler(true)
	end
end

function PhaseProfiler.get(job_id)
	return active[job_id]
end

function PhaseProfiler.start(job_id, phase_name)
	local profilers = active[job_id]
	if profilers and profilers[phase_name] then
		profilers[phase_name].restart()
	end
end

function PhaseProfiler.stop(job_id, phase_name)
	local profilers = active[job_id]
	if profilers and profilers[phase_name] then
		profilers[phase_name].stop()
	end
end

function PhaseProfiler.discard(job_id)
	active[job_id] = nil
end

return PhaseProfiler
