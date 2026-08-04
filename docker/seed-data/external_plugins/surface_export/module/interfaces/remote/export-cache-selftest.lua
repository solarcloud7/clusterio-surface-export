-- FactorioSurfaceExport - Export-cache bound self-test (remote)
--
-- THE INVARIANT THIS EXISTS TO STATE, over the OUTPUT of pruning rather than over its steps:
--
--   After any number of completed exports, storage.platform_exports holds AT MOST the effective
--   keep_count entries, and the entries it holds are the keep_count NEWEST ones.
--
-- Both halves are load-bearing and fail differently: losing "at most N" is the unbounded-save leak
-- this module was written for; losing "the newest" silently evicts the export a transfer is about
-- to read while keeping ancient ones, which reads as a transfer failure far from its cause.
--
-- The checks below are chosen so each way of breaking the implementation kills a DIFFERENT one:
-- inverting the sort kills keeps_newest; hard-coding the old literal 10 instead of honouring the
-- passed cap kills bounded_after_overflow (it prunes to 6, not 10); dropping the concurrency floor
-- kills floor_raises_unsafe_cap. Deleting the prune CALL SITES is not observable from in here — that
-- is pinned in test/export-cache-cap.test.cjs and proven end to end by a real export.
--
-- TOUCHES NO LIVE STATE. It prunes a table it owns and evaluates the policy as a pure function, so
-- there is nothing to restore and no pcall wrapper standing between an error and the report. An
-- earlier draft swapped storage.platform_exports out and back, which is one unexpected error away
-- from destroying real exports — the injectable table exists to make that unnecessary.

local ExportCache = require("modules/surface_export/utils/export-cache")
local clear_old_exports = require("modules/surface_export/interfaces/remote/clear-old-exports")

--- Run export-cache bound self-test.
--- @return table { passed, failed, total, details = { {name, ok, msg}, ... } }
local function export_cache_selftest()
	local details = {}
	local passed, failed = 0, 0

	local function check(name, cond, msg)
		if cond then
			passed = passed + 1
			details[#details + 1] = { name = name, ok = true }
		else
			failed = failed + 1
			details[#details + 1] = { name = name, ok = false, msg = msg or "assertion failed" }
		end
	end

	-- A cap deliberately DIFFERENT from the old hard-coded literal 10, so an implementation that
	-- ignores its argument and always keeps 10 fails here instead of passing by coincidence.
	local fake = {}
	for i = 1, 25 do
		fake["export_" .. i] = { tick = i * 100, platform_name = "p" .. i }
	end

	local removed = clear_old_exports(6, fake)

	local count = 0
	for _ in pairs(fake) do count = count + 1 end
	check("bounded_after_overflow", count == 6,
		"25 exports pruned to a cap of 6 must leave exactly 6, left " .. tostring(count))
	check("prune_reports_removed_count", removed == 19,
		"prune must report the 19 it removed, reported " .. tostring(removed))

	-- The newest 6 of 25 are export_20..export_25 (ticks 2000..2500).
	local newest_ok = true
	local newest_detail = ""
	for i = 20, 25 do
		if fake["export_" .. i] == nil then
			newest_ok = false
			newest_detail = newest_detail .. " missing export_" .. i
		end
	end
	for i = 1, 19 do
		if fake["export_" .. i] ~= nil then
			newest_ok = false
			newest_detail = newest_detail .. " kept stale export_" .. i
		end
	end
	check("keeps_newest", newest_ok,
		"survivors must be exactly the 6 highest ticks;" ..
		(newest_detail ~= "" and newest_detail or " (no detail)"))

	-- A cap under the concurrency floor must be RAISED, not honoured: an export stays in the cache
	-- until the controller finishes reading it, which happens after its job is already gone.
	local raised, was_raised = ExportCache.resolve_keep_count_for(1, 3)
	check("floor_raises_unsafe_cap", raised == 4 and was_raised == true,
		"cap 1 with max_concurrent_jobs 3 must resolve to 4 (raised), got " ..
		tostring(raised) .. " raised=" .. tostring(was_raised))

	local safe, safe_raised = ExportCache.resolve_keep_count_for(10, 3)
	check("floor_leaves_safe_cap_alone", safe == 10 and safe_raised == false,
		"a cap above the floor must pass through unchanged, got " ..
		tostring(safe) .. " raised=" .. tostring(safe_raised))

	-- The floor must TRACK concurrency rather than being a literal: raising max_concurrent_jobs
	-- without raising the floor is exactly how a prune would start evicting in-flight exports.
	local scaled, scaled_raised = ExportCache.resolve_keep_count_for(5, 9)
	check("floor_tracks_concurrency", scaled == 10 and scaled_raised == true,
		"cap 5 with max_concurrent_jobs 9 must resolve to 10, got " ..
		tostring(scaled) .. " raised=" .. tostring(scaled_raised))

	-- A write site that forgets .tick must sort oldest, NOT raise: pruning runs from export
	-- completion inside on_tick, where a raw error takes the headless server down (exit 255).
	local tickless = {
		no_tick = { platform_name = "no-tick" },
		newer = { tick = 500, platform_name = "has-tick" },
		newest = { tick = 900, platform_name = "has-tick-2" },
	}
	clear_old_exports(2, tickless)
	check("nil_tick_sorts_oldest_without_raising",
		tickless.no_tick == nil and tickless.newer ~= nil and tickless.newest ~= nil,
		"a tickless entry must be treated as oldest and dropped first, without raising")

	local under = { only = { tick = 10, platform_name = "solo" } }
	local nothing_removed = clear_old_exports(10, under)
	check("no_op_under_cap", nothing_removed == 0 and under.only ~= nil,
		"a cache under the cap must be left completely alone, removed=" .. tostring(nothing_removed))

	return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return export_cache_selftest
