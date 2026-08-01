-- FactorioSurfaceExport - Phase Recorder
--
-- THE declaration point for import phases. One entry per phase, and every instrument reads from it.
--
-- Why this exists. A phase used to be declared in FIVE independent places, and nothing tied them
-- together, so a phase could be half-registered and look fine:
--
--   1. the PhaseProfiler.init(...) name list          (omit it -> start/stop are SILENT no-ops)
--   2. a PhaseProfiler.start/stop bracket             (omit it -> no dashboard timing)
--   3. a job.metrics.<x>_started_tick assignment      (omit it -> no waterfall span)
--   4. the matching _completed_tick assignment        (omit it -> span silently dropped)
--   5. an add_span(...) line in the waterfall builder (omit it -> span never emitted)
--
-- Every combination of those failures was live in this codebase at once: `hub_restore` had a
-- profiler bracket but no tick marks; held-item completion had neither; and when held_items was
-- given a bracket it was NOT added to the init list, so its profiler was a silent no-op while its
-- span worked. Five ways to say "this is a phase" is four too many.
--
-- Now: add a row to IMPORT_PHASES, and the profiler, the tick marks and the waterfall all follow.
--
-- Naming note: `name` is the SPAN name (the wire/UI name, kept stable) and `profiler` is the
-- LuaProfiler key when the two historically differ -- `hub` vs `hub_restore` is the one case.
-- The mismatch is preserved deliberately rather than renamed, so this stays a pure refactor.

local PhaseProfiler = require("modules/surface_export/utils/phase-profiler")

local PhaseRecorder = {}

--- The canonical import phase list, in PIPELINE ORDER (the waterfall is emitted in this order).
---
--- `from` / `to`   job.metrics keys holding the boundary ticks. Both present => the phase emits a
---                 span. Absent => profile-only (no waterfall row).
--- `from_job`      read the start boundary off the job itself, not job.metrics. Only `queue`, whose
---                 start is job creation -- before any phase mark exists.
--- `external`      the marks are written by another subsystem, not by start/stop here. `delivery` is
---                 stamped by the chunked-RCON receiver; `queue` is derived from two other marks.
--- `profiler`      LuaProfiler key when it differs from the span name.
PhaseRecorder.IMPORT_PHASES = {
	{ name = "queue_setup" },
	{ name = "delivery",      from = "delivery_started_tick",      to = "delivery_completed_tick",      external = true },
	{ name = "queue",         from_job = "started_tick",           to = "tiles_started_tick",           external = true },
	{ name = "tiles",         from = "tiles_started_tick",         to = "tiles_completed_tick" },
	{ name = "beacons" },
	{ name = "entities",      from = "entities_started_tick",      to = "entities_completed_tick" },
	{ name = "hub",           from = "hub_started_tick",           to = "hub_completed_tick",           profiler = "hub_restore" },
	{ name = "belts",         from = "belts_started_tick",         to = "belts_completed_tick" },
	{ name = "state",         from = "state_started_tick",         to = "state_completed_tick" },
	{ name = "inventories",   from = "inventories_started_tick",   to = "inventories_completed_tick" },
	{ name = "held_items",    from = "held_items_started_tick",    to = "held_items_completed_tick" },
	{ name = "fluids",        from = "fluids_started_tick",        to = "fluids_completed_tick" },
	-- `to` is validation_DONE_tick, not _completed_tick: the gate's own end. validation_completed_tick
	-- marks the end of the whole completion routine (activation + latch-rearm + loss analysis
	-- included) and is deliberately NOT this phase's boundary -- conflating them is what made
	-- validation_ticks disagree with this span.
	{ name = "validation",    from = "validation_started_tick",    to = "validation_done_tick" },
	{ name = "activation",    from = "activation_started_tick",    to = "activation_completed_tick" },
	{ name = "loss_analysis", from = "loss_analysis_started_tick", to = "loss_analysis_completed_tick" },
}

local by_name = {}
for _, spec in ipairs(PhaseRecorder.IMPORT_PHASES) do by_name[spec.name] = spec end

--- Every profiler key, for PhaseProfiler.init. Derived, so a phase can never be missing from it.
function PhaseRecorder.profiler_names()
	local names = {}
	for _, spec in ipairs(PhaseRecorder.IMPORT_PHASES) do
		names[#names + 1] = spec.profiler or spec.name
	end
	return names
end

--- Look up a phase, complaining LOUDLY (never error()) about an unknown name.
--- error() on the on_tick path kills a headless server outright (measured, exit 255), so a bad phase
--- name must degrade to a log line, not take the instance down over instrumentation.
local function spec_for(name, caller)
	local spec = by_name[name]
	if not spec then
		log(string.format("[PhaseRecorder] %s: unknown phase '%s' -- not in IMPORT_PHASES, so nothing "
			.. "was recorded. Add it there rather than re-adding a one-off mark.", caller, tostring(name)))
	end
	return spec
end

--- Open a phase: stamp its start tick AND start its profiler, so one cannot land without the other.
function PhaseRecorder.start(job, name)
	local spec = spec_for(name, "start")
	if not spec then return end
	job.metrics = job.metrics or {}
	if spec.from then job.metrics[spec.from] = game.tick end
	PhaseProfiler.start(job.job_id, spec.profiler or spec.name)
end

--- Close a phase: stamp its end tick AND stop its profiler.
function PhaseRecorder.stop(job, name)
	local spec = spec_for(name, "stop")
	if not spec then return end
	job.metrics = job.metrics or {}
	if spec.to then job.metrics[spec.to] = game.tick end
	PhaseProfiler.stop(job.job_id, spec.profiler or spec.name)
end

--- Build the waterfall: {name, start_offset_ms, duration_ms} per phase, in IMPORT_PHASES order,
--- offsets relative to t0. A phase missing either boundary is omitted rather than emitted as a
--- zero-width span (validation is absent on non-transfer imports, delivery on non-chunked ones).
--- Pure arithmetic over already-recorded tick reads: no game state, never gates anything.
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
					start_offset_ms = math.max(0, math.floor((started - t0) * 16.67)),
					duration_ms = math.max(0, math.floor((completed - started) * 16.67)),
				}
			end
		end
	end
	return spans
end

return PhaseRecorder
