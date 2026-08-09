local ExportCache = require("modules/surface_export/utils/export-cache")
local clear_old_exports = require("modules/surface_export/interfaces/remote/clear-old-exports")

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

	local fake = {}
	for i = 1, 25 do
		fake["export_" .. i] = { cache_seq = i, tick = i * 100, platform_name = "p" .. i }
	end

	local removed = clear_old_exports(6, fake)

	local count = 0
	for _ in pairs(fake) do count = count + 1 end
	check("bounded_after_overflow", count == 6,
		"25 exports pruned to a cap of 6 must leave exactly 6, left " .. tostring(count))
	check("prune_reports_removed_count", removed == 19,
		"prune must report the 19 it removed, reported " .. tostring(removed))

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
		"survivors must be exactly the 6 highest cache_seq;" ..
		(newest_detail ~= "" and newest_detail or " (no detail)"))

	local mixed = {
		slow = { cache_seq = 99, tick = 1000, platform_name = "big" },
		quick_a = { cache_seq = 97, tick = 5000, platform_name = "small-a" },
		quick_b = { cache_seq = 98, tick = 6000, platform_name = "small-b" },
	}
	clear_old_exports(1, mixed)
	check("slow_export_is_not_self_evicted",
		mixed.slow ~= nil and mixed.quick_a == nil and mixed.quick_b == nil,
		"the most recently INSERTED entry must survive even though its tick is the oldest")

	local legacy = {
		old_a = { tick = 31000000, platform_name = "legacy-a" },
		old_b = { tick = 31000001, platform_name = "legacy-b" },
		fresh = { cache_seq = 1, tick = 5, platform_name = "stamped" },
	}
	clear_old_exports(1, legacy)
	check("unstamped_legacy_entries_sort_oldest",
		legacy.fresh ~= nil and legacy.old_a == nil and legacy.old_b == nil,
		"a stamped entry must outrank unstamped legacy entries regardless of their much larger ticks")

	local guarded = {
		in_flight = { cache_seq = 1, platform_name = "locked" },
		spare_a = { cache_seq = 2, platform_name = "a" },
		spare_b = { cache_seq = 3, platform_name = "b" },
	}
	local guarded_removed = clear_old_exports(1, guarded, { in_flight = true })
	check("protects_locked_export",
		guarded.in_flight ~= nil and guarded.spare_b ~= nil and guarded.spare_a == nil and guarded_removed == 1,
		"a protected id must survive a cap of 1 while the unprotected surplus is dropped, removed=" ..
		tostring(guarded_removed))

	local tickless = {
		no_tick = { platform_name = "no-tick" },
		has_tick = { tick = 500, platform_name = "has-tick" },
	}
	clear_old_exports(1, tickless)
	check("nil_tick_does_not_raise", tickless.has_tick ~= nil and tickless.no_tick == nil,
		"a tickless legacy entry must sort oldest and be dropped first, without raising")

	local under = { only = { cache_seq = 1, platform_name = "solo" } }
	local nothing_removed = clear_old_exports(10, under)
	check("no_op_under_cap", nothing_removed == 0 and under.only ~= nil,
		"a cache under the cap must be left completely alone, removed=" .. tostring(nothing_removed))

	local raised, was_raised = ExportCache.resolve_keep_count_for(1, 3)
	check("floor_raises_unsafe_cap", raised == 4 and was_raised == true,
		"cap 1 with a per-tick limit of 3 must resolve to 4 (raised), got " ..
		tostring(raised) .. " raised=" .. tostring(was_raised))

	local safe, safe_raised = ExportCache.resolve_keep_count_for(10, 3)
	check("floor_leaves_safe_cap_alone", safe == 10 and safe_raised == false,
		"a cap above the floor must pass through unchanged, got " ..
		tostring(safe) .. " raised=" .. tostring(safe_raised))

	local scaled, scaled_raised = ExportCache.resolve_keep_count_for(5, 9)
	check("floor_tracks_concurrency", scaled == 10 and scaled_raised == true,
		"cap 5 with a per-tick limit of 9 must resolve to 10, got " ..
		tostring(scaled) .. " raised=" .. tostring(scaled_raised))

	local live_cap, live_concurrency = ExportCache.get_cap(), ExportCache.get_concurrency()
	if live_cap == live_concurrency then
		check("resolve_composes_inputs", false,
			"cap and per-tick limit are both " .. tostring(live_cap) .. ", so this check cannot " ..
			"distinguish a swapped argument order — configure them differently to restore its teeth")
	else
		local live_keep, live_raised = ExportCache.resolve_keep_count()
		local expected_keep, expected_raised = ExportCache.resolve_keep_count_for(live_cap, live_concurrency)
		check("resolve_composes_inputs", live_keep == expected_keep and live_raised == expected_raised,
			"resolve_keep_count must pass (cap, concurrency) in that order: got " .. tostring(live_keep) ..
			"/" .. tostring(live_raised) .. ", expected " .. tostring(expected_keep) .. "/" .. tostring(expected_raised))
	end


	return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return export_cache_selftest
