-- FactorioSurfaceExport - Schedule-filter self-test (remote)
-- Pure-function assertions for PlatformSchedule.filter_for_import (WS1 unroutable-stop stripping). `require`
-- does not resolve module paths from the /sc sandbox, so this runs the unit checks IN module context and
-- returns a structured result an integration test (or RCON) can assert on — no platforms or transfer needed.
--
-- Grounded on the LIVE prototype table: "nauvis" is always a real space-location; a "surfexp_selftest_*"
-- name never is. So the routable/unroutable fixtures are real, not mocked (checks 1-2 assert that).

local PlatformSchedule = require("modules/surface_export/utils/platform-schedule")

local UNROUTABLE = "surfexp_selftest_nonexistent_zzz"

--- Run the schedule-filter self-test.
--- @return table { passed, failed, total, details = { {name, ok, msg}, ... } }
local function schedule_selftest()
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

	-- 0. Fixtures match the live prototype table (else every check below is meaningless).
	check("fixture_nauvis_routable", prototypes.space_location["nauvis"] ~= nil,
		"nauvis must be a real space-location on this instance")
	check("fixture_bogus_unroutable", prototypes.space_location[UNROUTABLE] == nil,
		UNROUTABLE .. " must NOT exist on this instance")

	-- 1. Strips an unroutable stop, keeps the routable ones, recomputes the cursor forward.
	local p1 = { current = 2, records = { { station = "nauvis" }, { station = UNROUTABLE }, { station = "nauvis" } }, interrupts = {}, group = nil }
	local f1, d1 = PlatformSchedule.filter_for_import(p1)
	check("strip_keeps_routable_count", #f1.records == 2, "expected 2 kept, got " .. #f1.records)
	check("strip_reports_dropped", #d1.stations == 1 and d1.stations[1] == UNROUTABLE,
		"expected exactly 1 dropped = " .. UNROUTABLE)
	check("strip_not_skipped_empty", d1.skipped_empty == false, "must not be skip-to-empty when routable records remain")
	check("strip_only_routable_kept", f1.records[1].station == "nauvis" and f1.records[2].station == "nauvis",
		"the kept records must be the two routable ones")
	-- cursor was at record 2 (the stripped one); the next kept record is #2 in the new list.
	check("strip_recomputes_cursor", f1.current == 2, "expected recomputed current=2, got " .. tostring(f1.current))

	-- 2. Nothing unroutable → identity: SAME payload back, no drops.
	local p2 = { current = 1, records = { { station = "nauvis" } }, interrupts = {}, group = nil }
	local f2, d2 = PlatformSchedule.filter_for_import(p2)
	check("noop_identity", f2 == p2 and #d2.stations == 0, "an all-routable payload must be returned unchanged")

	-- 3. ALL unroutable → NEVER strip to empty: keep the ORIGINAL, flag skipped_empty, still report them.
	local p3 = { current = 1, records = { { station = UNROUTABLE }, { station = UNROUTABLE .. "2" } }, interrupts = {}, group = nil }
	local f3, d3 = PlatformSchedule.filter_for_import(p3)
	check("never_strip_to_empty", f3 == p3 and d3.skipped_empty == true,
		"all-unroutable must keep the original schedule (skipped_empty), got skipped_empty=" .. tostring(d3.skipped_empty))
	check("skip_empty_still_reports", #d3.stations == 2, "must still report the 2 stations it DECLINED to strip")

	-- 4. A record with no string station is KEPT (defensive — never strip what we don't understand).
	local p4 = { current = 1, records = { { station = "nauvis" }, { temporary = true } }, interrupts = {}, group = nil }
	local f4, d4 = PlatformSchedule.filter_for_import(p4)
	check("keeps_stationless_record", #f4.records == 2 and #d4.stations == 0,
		"a record with no string station must be kept, not stripped")

	return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return schedule_selftest
