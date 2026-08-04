-- Export cache policy
--
-- storage.platform_exports accumulates one entry per completed export and, until this module
-- existed, NOTHING ever removed one: the `clear_old_exports` remote is the only pruner and no
-- caller in the Node plugin has ever invoked it, while `surface_export.max_export_cache_size` was
-- declared and validated in Node and then discarded without ever reaching Lua. The result was a
-- save that grew by one whole compressed platform payload per export, permanently.
--
-- This module owns the POLICY (which entries may go); clear-old-exports.lua owns the ALGORITHM
-- (drop all but the newest N, never touching a protected id). Write sites go through
-- ExportCache.record so an entry cannot be stored without its ordering stamp.

local clear_old_exports = require("modules/surface_export/interfaces/remote/clear-old-exports")

local ExportCache = {}

-- THIS MODULE DOES NOT REQUIRE AsyncProcessor, and cannot — the dependency is INVERTED instead:
-- AsyncProcessor pushes its value in here. Two constraints force it, and both are load-bearing:
--
--   1. async-processor.lua requires export-pipeline.lua, which requires THIS module, so a top-level
--      require back into AsyncProcessor would close a cycle.
--   2. Deferring that require into the function bodies does NOT work around it. Factorio only
--      resolves `require` while control.lua is being parsed; a runtime call raises
--      "Require can't be used outside of control.lua parsing" — measured on 2.1.11, which is how
--      this shape was found (the offline tests all passed against the broken version).
--
-- `concurrency` is a module local rather than storage because it is seeded at module load, when
-- `storage` does not yet exist. It is a MIRROR, not a second source of truth: AsyncProcessor's
-- setter is the single mutation point and updates this copy in the same call.
local DEFAULT_CAP = 10
local DEFAULT_CONCURRENCY = 3
local concurrency = DEFAULT_CONCURRENCY

--- Set the retained-export cap (the operator-facing max_export_cache_size).
--- PERSISTED, unlike the other configure() values: this one governs DELETION. A batch size that
--- silently reverts to its default on save load costs throughput; a cap that silently reverts from
--- an operator's 100 to the default 10 deletes 90 exports on the next completion. The configure()
--- push that would restore it is best-effort — instance.ts swallows its failure into a warn.
function ExportCache.set_cap(value)
	storage.surface_export_config = storage.surface_export_config or {}
	storage.surface_export_config.max_export_cache_size = value
end

--- Get the configured cap, UNCLAMPED — resolve_keep_count applies the sanity floor.
function ExportCache.get_cap()
	local configured = storage.surface_export_config and storage.surface_export_config.max_export_cache_size
	if type(configured) ~= "number" or configured < 1 then
		return DEFAULT_CAP
	end
	return configured
end

--- Mirror AsyncProcessor's per-tick job limit; called from its setter and seeded at its load.
function ExportCache.set_concurrency(value)
	concurrency = value
end

--- Read the mirror back. Exists so a self-test can check that resolve_keep_count composes its two
--- inputs in the right order — without it, swapping the arguments passes every test.
function ExportCache.get_concurrency()
	return concurrency
end

--- Resolve the effective number of exports to keep.
--- @return number keep_count, boolean was_raised
function ExportCache.resolve_keep_count()
	return ExportCache.resolve_keep_count_for(ExportCache.get_cap(), concurrency)
end

--- The policy as a PURE function of its two inputs, so it can be tested without mutating live
--- config (a self-test that sets the real cap and restores it needs a pcall to be fail-safe on an
--- unexpected error; a pure function needs nothing).
---
--- WHAT THE FLOOR IS, HONESTLY: a sanity clamp, NOT a survival guarantee. An earlier version of
--- this file claimed `max_concurrent_jobs` bounds how many exports can be in flight, so that
--- keeping max_concurrent_jobs + 1 guaranteed an unread export could never be evicted. That claim
--- is FALSE about this codebase and has been retracted: ExportPipeline.queue has no admission
--- control whatsoever (its only refusals are surface validity, lock failure and schedule capture),
--- and max_concurrent_jobs is a PER-TICK throughput limiter — async-processor.lua's own comment
--- says "remaining jobs wait until next tick". The number of simultaneously queued exports is
--- bounded by platform count, not by this setting.
---
--- What actually protects an export that has completed but not yet been read is the PROTECTED-ID
--- set in prune_to_configured_cap, which is reference-based rather than count-based. The floor
--- survives only to stop an operator setting a cap so small that ordinary back-to-back exports
--- churn the cache; Node validates >= 1, which is too permissive to be useful on its own.
--- @param configured number: the operator-facing cap
--- @param concurrency_limit number: AsyncProcessor's per-tick job limit
--- @return number keep_count, boolean was_raised
function ExportCache.resolve_keep_count_for(configured, concurrency_limit)
	if type(configured) ~= "number" or configured < 1 then
		configured = DEFAULT_CAP
	end
	local floor = concurrency_limit
	if type(floor) ~= "number" or floor < 1 then
		floor = DEFAULT_CONCURRENCY
	end
	floor = floor + 1
	if configured < floor then
		return floor, true
	end
	return configured, false
end

--- Store an export entry, stamped with a monotonic sequence number.
---
--- The stamp is why this function exists rather than a bare assignment at each write site. The
--- entries carry a `tick` field, but it is stamped when the export is QUEUED (export-pipeline.lua
--- builds export_data in `queue`), not when it completes — so a large platform that takes many
--- ticks to scan completes carrying the OLDEST tick in the table and, ordered by tick, would be
--- deleted by the very prune its own completion triggers. Ordering by insertion instead makes the
--- newest entry actually the newest. `tick`/`timestamp` keep their original meaning; they are
--- surfaced as metadata by list_exports and get_export, so they are not repurposed here.
--- @param export_id string
--- @param entry table
--- @return table the stored entry
function ExportCache.record(export_id, entry)
	storage.platform_exports = storage.platform_exports or {}
	storage.platform_export_seq = (storage.platform_export_seq or 0) + 1
	entry.cache_seq = storage.platform_export_seq
	storage.platform_exports[export_id] = entry
	return entry
end

--- Ids that must never be pruned: an export whose platform still holds its lock is either being
--- transmitted right now or is mid-transfer. The lock is taken before the scan (export-pipeline.lua
--- passes `job_id` as lock_opts.job_id, stored as transfer_job_id) and released at completion,
--- rollback or the TTL reaper, and the export id IS the job id — so the lock table is a direct,
--- reference-based answer to "is anyone still using this entry?", which a count-based cap cannot be.
--- @return table set of protected export ids
local function protected_export_ids()
	local protected = {}
	for _, lock in pairs(storage.locked_platforms or {}) do
		if lock.transfer_job_id then
			protected[lock.transfer_job_id] = true
		end
		if lock.committed_transfer_id then
			protected[lock.committed_transfer_id] = true
		end
	end
	return protected
end

--- Prune storage.platform_exports down to the effective cap, never dropping a protected entry.
--- Safe to call from export completion (runs inside on_tick).
--- @return number: entries removed
function ExportCache.prune_to_configured_cap()
	local keep_count, was_raised = ExportCache.resolve_keep_count()
	local removed = clear_old_exports(keep_count, nil, protected_export_ids())
	if was_raised then
		log(string.format(
			"[ExportCache] max_export_cache_size=%s is below the max_concurrent_jobs+1 sanity floor; keeping %d instead",
			tostring(ExportCache.get_cap()), keep_count))
	end
	if removed > 0 then
		log(string.format("[ExportCache] Pruned %d old export(s), keeping newest %d", removed, keep_count))
	end
	return removed
end

return ExportCache
