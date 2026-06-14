-- FactorioSurfaceExport - Phase Profiler
-- Module-local LuaProfiler management for export/import phase timing.
--
-- LuaProfiler objects cannot be stored in `storage` (Factorio does not serialize them),
-- so they live in a module-local table keyed by job_id.
-- Profilers are silently discarded on save/load — they are display-only and never
-- influence game logic, so loss on reload is acceptable.
--
-- Usage:
--   PhaseProfiler.init(job_id, {"phase_a", "phase_b", ...})
--   PhaseProfiler.start(job_id, "phase_a")
--   -- ... do work ...
--   PhaseProfiler.stop(job_id, "phase_a")
--   local p = PhaseProfiler.get(job_id)
--   if p then game.print({"", "Phase A: ", p.phase_a}) end
--   PhaseProfiler.discard(job_id)

local PhaseProfiler = {}

-- Module-local profiler storage: job_id → { phase_name → LuaProfiler }
-- NOT in `storage` — LuaProfiler is not serializable.
local active = {}

--- Create stopped profilers for a job.
--- Call once in the queue function before any phase work begins.
--- @param job_id string
--- @param phase_names table: Array of phase name strings
function PhaseProfiler.init(job_id, phase_names)
	active[job_id] = {}
	for _, name in ipairs(phase_names) do
		active[job_id][name] = game.create_profiler(true)  -- created stopped
	end
end

--- Get the profiler table for a job, or nil if not available (e.g. after save/load).
--- @param job_id string
--- @return table|nil: { phase_name → LuaProfiler }
function PhaseProfiler.get(job_id)
	return active[job_id]
end

--- Start (or restart) a named profiler. Safe no-op if profilers are not available.
--- Note: restart() resets accumulated time — only call once per measured section.
--- @param job_id string
--- @param phase_name string
function PhaseProfiler.start(job_id, phase_name)
	local profilers = active[job_id]
	if profilers and profilers[phase_name] then
		profilers[phase_name].restart()
	end
end

--- Stop a named profiler. Safe no-op if profilers are not available.
--- @param job_id string
--- @param phase_name string
function PhaseProfiler.stop(job_id, phase_name)
	local profilers = active[job_id]
	if profilers and profilers[phase_name] then
		profilers[phase_name].stop()
	end
end

--- Remove profilers for a completed job. Call after printing the summary.
--- @param job_id string
function PhaseProfiler.discard(job_id)
	active[job_id] = nil
end

return PhaseProfiler
