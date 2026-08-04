-- Export cache policy
--
-- storage.platform_exports accumulates one entry per completed export and, until this module
-- existed, NOTHING ever removed one: the `clear_old_exports` remote is the only pruner and no
-- caller in the Node plugin has ever invoked it, while `surface_export.max_export_cache_size` was
-- declared and validated in Node and then discarded without ever reaching Lua. The result was a
-- save that grew by one whole compressed platform payload per export, permanently.
--
-- This module owns the POLICY (how many entries to keep); clear-old-exports.lua owns the
-- ALGORITHM (drop all but the newest N). Write sites call prune_to_configured_cap() so the cap is
-- enforced in Lua at the point of growth — not from a Node-side RCON call that a broken config
-- push or a missing caller would silently skip.

local clear_old_exports = require("modules/surface_export/interfaces/remote/clear-old-exports")

local ExportCache = {}

-- THIS MODULE DOES NOT REQUIRE AsyncProcessor, and cannot — the dependency is INVERTED instead:
-- AsyncProcessor pushes its values in here. Two constraints force it, and both are load-bearing:
--
--   1. async-processor.lua requires export-pipeline.lua, which requires THIS module, so a top-level
--      require back into AsyncProcessor would close a cycle.
--   2. Deferring that require into the function bodies does NOT work around it. Factorio only
--      resolves `require` while control.lua is being parsed; a runtime call raises
--      "Require can't be used outside of control.lua parsing" — measured on 2.1.11, which is how
--      this shape was found (the offline tests all passed against the broken version).
--
-- `concurrency` is a MIRROR, not a second source of truth: AsyncProcessor.set_max_concurrent_jobs
-- is the single mutation point for that value and updates this copy in the same call, and
-- async-processor seeds it from its own default at load, so there is no second literal to drift.
local cap = 10
local concurrency = 3

--- Set the retained-export cap (the operator-facing max_export_cache_size).
function ExportCache.set_cap(value)
	cap = value
end

--- Get the configured cap, UNCLAMPED — resolve_keep_count applies the safety floor.
function ExportCache.get_cap()
	return cap
end

--- Mirror AsyncProcessor's concurrency limit; called from its setter, never read back across modules.
function ExportCache.set_concurrency(value)
	concurrency = value
end

--- Resolve the effective number of exports to keep.
---
--- THE INTERACTION THIS EXISTS FOR: an export entry must outlive Node's chunked RCON read of it
--- (~40s for a 235KB platform, per the throughput figure in CLAUDE.md). That read starts AFTER the
--- export job has completed and left storage.async_jobs, so "is a job still running?" cannot tell
--- us whether an entry is still needed — the entry is at its most vulnerable precisely when no job
--- references it. The only thing standing between a still-being-read export and eviction is the cap
--- being larger than the number of exports that can complete during one read.
---
--- max_concurrent_jobs bounds how many exports can be in flight at once, so keeping
--- max_concurrent_jobs + 1 guarantees every completed-but-unread export survives: at most
--- max_concurrent_jobs of them can exist, and the +1 is the entry written by the export that
--- triggered this prune. Node validates the field as >= 1 (instance.ts), which alone is NOT safe —
--- max_export_cache_size = 1 with two concurrent exports would evict the older one mid-read. Hence
--- a floor, not just a minimum.
--- @return number keep_count, boolean was_raised
function ExportCache.resolve_keep_count()
	return ExportCache.resolve_keep_count_for(cap, concurrency)
end

--- The policy as a PURE function of its two inputs, so it can be tested without mutating the live
--- config (a self-test that sets the real cap and restores it needs a pcall to be fail-safe on an
--- unexpected error; a pure function needs nothing).
--- @param configured number: the operator-facing cap
--- @param concurrency_limit number: AsyncProcessor's max_concurrent_jobs
--- @return number keep_count, boolean was_raised
function ExportCache.resolve_keep_count_for(configured, concurrency_limit)
	if type(configured) ~= "number" or configured < 1 then
		configured = 10
	end
	local floor = concurrency_limit
	if type(floor) ~= "number" or floor < 1 then
		floor = 3
	end
	floor = floor + 1
	if configured < floor then
		return floor, true
	end
	return configured, false
end

--- Prune storage.platform_exports down to the effective cap.
--- Safe to call from export completion (runs inside on_tick).
--- @return number: entries removed
function ExportCache.prune_to_configured_cap()
	local keep_count, was_raised = ExportCache.resolve_keep_count()
	local removed = clear_old_exports(keep_count)
	if was_raised then
		log(string.format(
			"[ExportCache] max_export_cache_size=%s is below the max_concurrent_jobs+1 floor; " ..
			"keeping %d instead so an export still being read over RCON cannot be evicted",
			tostring(cap), keep_count))
	end
	if removed > 0 then
		log(string.format("[ExportCache] Pruned %d old export(s), keeping newest %d", removed, keep_count))
	end
	return removed
end

return ExportCache
