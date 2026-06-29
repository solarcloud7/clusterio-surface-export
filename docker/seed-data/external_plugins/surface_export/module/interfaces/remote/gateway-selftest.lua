-- FactorioSurfaceExport - Gateway-guard self-test (remote)
-- Pure-function assertions for core/gateway-guard.lua. `require` does not resolve module paths from the
-- /sc sandbox, so this runs the unit checks IN module context and returns a structured result an
-- integration test (or RCON) can assert on. A permanent guard for the passenger HARD BLOCK.
--
-- The load-bearing assertions are not just "the decision is correct" but "the PROTECTIVE ROUTE RAN":
-- on every block, start_fn must NEVER be reached (a green safety test must prove the bad outcome did not
-- happen AND that the guard, not luck, prevented it). For a passenger block, eject_fn must have run.

local GatewayGuard = require("modules/surface_export/core/gateway-guard")

--- Run the gateway-guard self-test.
--- @return table { passed, failed, total, details = { {name, ok, msg}, ... } }
local function gateway_selftest()
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

	-- A spy pair: counts eject + start invocations so we can assert the protective route.
	local function spies(start_ret_ok, start_ret_err)
		local s = { eject_count = 0, start_count = 0 }
		s.eject_fn = function(_) s.eject_count = s.eject_count + 1 end
		s.start_fn = function() s.start_count = s.start_count + 1; return start_ret_ok, start_ret_err end
		return s
	end

	-- ── PURE evaluate(): decisions only, NO side effects ──────────────────────────────────────────
	local d_ok = GatewayGuard.evaluate{ docked = true, in_flight = false, aboard_players = {}, aboard_characters = 0 }
	check("evaluate_allows_clean", d_ok.allowed == true and d_ok.reason == GatewayGuard.REASON.OK,
		"clean docked/empty platform must be allowed, got " .. tostring(d_ok.reason))

	local d_nd = GatewayGuard.evaluate{ docked = false }
	check("evaluate_blocks_not_docked", d_nd.allowed == false and d_nd.reason == GatewayGuard.REASON.NOT_DOCKED,
		"not-docked must block, got " .. tostring(d_nd.reason))

	local d_if = GatewayGuard.evaluate{ docked = true, in_flight = true }
	check("evaluate_blocks_in_flight", d_if.allowed == false and d_if.reason == GatewayGuard.REASON.IN_FLIGHT,
		"in-flight must block, got " .. tostring(d_if.reason))

	local d_pp = GatewayGuard.evaluate{ docked = true, aboard_players = {"a", "b"}, aboard_characters = 0 }
	check("evaluate_blocks_players", d_pp.allowed == false and d_pp.reason == GatewayGuard.REASON.PASSENGERS and d_pp.passenger_count == 2,
		"2 aboard players must block with count 2, got reason=" .. tostring(d_pp.reason) .. " count=" .. tostring(d_pp.passenger_count))

	local d_pc = GatewayGuard.evaluate{ docked = true, aboard_players = {}, aboard_characters = 1 }
	check("evaluate_blocks_characters", d_pc.allowed == false and d_pc.reason == GatewayGuard.REASON.PASSENGERS and d_pc.passenger_count == 1,
		"a lone disconnected character must block, got reason=" .. tostring(d_pc.reason) .. " count=" .. tostring(d_pc.passenger_count))

	-- evaluate() must be side-effect-free: drawing the GUI calls it, and must NOT eject/transfer.
	local pure = spies(true)
	GatewayGuard.evaluate{ docked = true, aboard_players = {"a"}, aboard_characters = 1, eject_fn = pure.eject_fn, start_fn = pure.start_fn }
	check("evaluate_is_side_effect_free", pure.eject_count == 0 and pure.start_count == 0,
		"evaluate must not call eject_fn/start_fn (eject=" .. pure.eject_count .. " start=" .. pure.start_count .. ")")

	-- ── guard_and_transfer(): protective orchestration ───────────────────────────────────────────
	-- Happy path: allowed → start_fn runs, eject_fn does NOT.
	local sp_ok = spies(true)
	local r_ok = GatewayGuard.guard_and_transfer{ docked = true, in_flight = false, aboard_players = {}, aboard_characters = 0,
		eject_fn = sp_ok.eject_fn, start_fn = sp_ok.start_fn }
	check("guard_happy_starts", r_ok.started == true and sp_ok.start_count == 1, "clean transfer must start exactly once")
	check("guard_happy_no_eject", sp_ok.eject_count == 0, "clean transfer must not eject anyone")

	-- Passenger block: PROTECTIVE ROUTE — eject runs per player, start_fn NEVER reached.
	local sp_pax = spies(true)
	local r_pax = GatewayGuard.guard_and_transfer{ docked = true, in_flight = false, aboard_players = {"a", "b"}, aboard_characters = 0,
		eject_fn = sp_pax.eject_fn, start_fn = sp_pax.start_fn }
	check("guard_passenger_blocks", r_pax.started == false and r_pax.reason == GatewayGuard.REASON.PASSENGERS,
		"passengers must block the start, got started=" .. tostring(r_pax.started) .. " reason=" .. tostring(r_pax.reason))
	check("guard_passenger_no_start", sp_pax.start_count == 0, "PROTECTIVE: start_fn must NEVER run with passengers aboard")
	check("guard_passenger_ejected", sp_pax.eject_count == 2, "PROTECTIVE: eject_fn must run once per aboard player (expected 2, got " .. sp_pax.eject_count .. ")")

	-- Disconnected-character block: start_fn NEVER reached (no players to eject — block IS the protection).
	local sp_chr = spies(true)
	local r_chr = GatewayGuard.guard_and_transfer{ docked = true, in_flight = false, aboard_players = {}, aboard_characters = 1,
		eject_fn = sp_chr.eject_fn, start_fn = sp_chr.start_fn }
	check("guard_character_blocks_no_start", r_chr.started == false and sp_chr.start_count == 0 and r_chr.reason == GatewayGuard.REASON.PASSENGERS,
		"a lone disconnected character must block the start (start_count=" .. sp_chr.start_count .. ")")

	-- Not-docked block: start_fn never reached, NOT ejected (nothing to eject; platform may be moving).
	local sp_nd = spies(true)
	local r_nd = GatewayGuard.guard_and_transfer{ docked = false, aboard_players = {"a"}, aboard_characters = 0,
		eject_fn = sp_nd.eject_fn, start_fn = sp_nd.start_fn }
	check("guard_not_docked_no_start", r_nd.started == false and sp_nd.start_count == 0 and r_nd.reason == GatewayGuard.REASON.NOT_DOCKED,
		"not-docked must block the start")
	check("guard_not_docked_no_eject", sp_nd.eject_count == 0, "not-docked must not eject (platform may be mid-flight)")

	-- In-flight block: start_fn never reached.
	local sp_if = spies(true)
	local r_if = GatewayGuard.guard_and_transfer{ docked = true, in_flight = true, aboard_players = {}, aboard_characters = 0,
		eject_fn = sp_if.eject_fn, start_fn = sp_if.start_fn }
	check("guard_in_flight_no_start", r_if.started == false and sp_if.start_count == 0 and r_if.reason == GatewayGuard.REASON.IN_FLIGHT,
		"in-flight must block the start")

	-- Allowed but start_fn fails: surfaces start_err, started=false, allowed=true.
	local sp_fail = spies(nil, "boom")
	local r_fail = GatewayGuard.guard_and_transfer{ docked = true, in_flight = false, aboard_players = {}, aboard_characters = 0,
		eject_fn = sp_fail.eject_fn, start_fn = sp_fail.start_fn }
	check("guard_start_failure_surfaced", r_fail.started == false and r_fail.allowed == true and r_fail.start_err == "boom",
		"a start_fn failure must surface start_err while allowed=true, got started=" .. tostring(r_fail.started) .. " err=" .. tostring(r_fail.start_err))

	return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return gateway_selftest
