-- FactorioSurfaceExport - Gateway-guard self-test (remote)
-- Pure-function assertions for core/gateway-guard.lua. `require` does not resolve module paths from the
-- /sc sandbox, so this runs the unit checks IN module context and returns a structured result an
-- integration test (or RCON) can assert on.
--
-- Behaviour under test: passengers do NOT block a gateway transfer — anyone aboard is EVACUATED to a planet
-- at the source-delete chokepoint (Gateway.evacuate_passengers), which is exercised by the
-- `passenger-evacuate` integration test, not here. The guard's job is only the gate (docked + not-in-flight)
-- and the invariant that start_fn is NEVER reached on a real block.

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

	-- A spy: counts start invocations so we can assert start_fn is/ isn't reached.
	local function spies(start_ret_ok, start_ret_err)
		local s = { start_count = 0 }
		s.start_fn = function() s.start_count = s.start_count + 1; return start_ret_ok, start_ret_err end
		return s
	end

	-- ── PURE evaluate(): gate = docked + not-in-flight; passengers do NOT block ───────────────────
	local d_ok = GatewayGuard.evaluate{ docked = true, in_flight = false }
	check("evaluate_allows_clean", d_ok.allowed == true and d_ok.reason == GatewayGuard.REASON.OK,
		"clean docked platform must be allowed, got " .. tostring(d_ok.reason))

	local d_pax = GatewayGuard.evaluate{ docked = true, in_flight = false, aboard_players = {"a", "b"}, aboard_characters = 0 }
	check("evaluate_allows_with_passengers", d_pax.allowed == true and d_pax.passenger_count == 2,
		"passengers must NOT block (evacuated at delete); expected allowed + count 2, got allowed=" ..
		tostring(d_pax.allowed) .. " count=" .. tostring(d_pax.passenger_count))

	local d_chr = GatewayGuard.evaluate{ docked = true, aboard_players = {}, aboard_characters = 1 }
	check("evaluate_allows_with_character", d_chr.allowed == true and d_chr.passenger_count == 1,
		"a lone character must NOT block, got allowed=" .. tostring(d_chr.allowed) .. " count=" .. tostring(d_chr.passenger_count))

	local d_max = GatewayGuard.evaluate{ docked = true, aboard_players = {"a"}, aboard_characters = 1 }
	check("evaluate_count_is_max_not_sum", d_max.passenger_count == 1,
		"1 connected player (player + their character) must count as 1 via max(), got " .. tostring(d_max.passenger_count))

	local d_nd = GatewayGuard.evaluate{ docked = false }
	check("evaluate_blocks_not_docked", d_nd.allowed == false and d_nd.reason == GatewayGuard.REASON.NOT_DOCKED,
		"not-docked must block, got " .. tostring(d_nd.reason))

	local d_if = GatewayGuard.evaluate{ docked = true, in_flight = true }
	check("evaluate_blocks_in_flight", d_if.allowed == false and d_if.reason == GatewayGuard.REASON.IN_FLIGHT,
		"in-flight must block, got " .. tostring(d_if.reason))

	-- evaluate() must be side-effect-free: drawing the GUI calls it, and must NOT start a transfer.
	local pure = spies(true)
	GatewayGuard.evaluate{ docked = true, aboard_players = {"a"}, aboard_characters = 1, start_fn = pure.start_fn }
	check("evaluate_is_side_effect_free", pure.start_count == 0,
		"evaluate must not call start_fn (start=" .. pure.start_count .. ")")

	-- ── guard_and_transfer(): starts when allowed (incl. with passengers); never on a block ───────
	local sp_ok = spies(true)
	local r_ok = GatewayGuard.guard_and_transfer{ docked = true, in_flight = false, start_fn = sp_ok.start_fn }
	check("guard_happy_starts", r_ok.started == true and sp_ok.start_count == 1, "clean transfer must start exactly once")

	-- Passengers aboard must NOT block the start — they are evacuated at the source delete.
	local sp_pax = spies(true)
	local r_pax = GatewayGuard.guard_and_transfer{ docked = true, in_flight = false, aboard_players = {"a", "b"}, aboard_characters = 0, start_fn = sp_pax.start_fn }
	check("guard_starts_with_passengers", r_pax.started == true and sp_pax.start_count == 1,
		"passengers must NOT block the start (evacuated at delete); started=" .. tostring(r_pax.started) .. " start_count=" .. sp_pax.start_count)

	-- Not-docked block: start_fn NEVER reached.
	local sp_nd = spies(true)
	local r_nd = GatewayGuard.guard_and_transfer{ docked = false, start_fn = sp_nd.start_fn }
	check("guard_not_docked_no_start", r_nd.started == false and sp_nd.start_count == 0 and r_nd.reason == GatewayGuard.REASON.NOT_DOCKED,
		"not-docked must block the start (start_count=" .. sp_nd.start_count .. ")")

	-- In-flight block: start_fn NEVER reached.
	local sp_if = spies(true)
	local r_if = GatewayGuard.guard_and_transfer{ docked = true, in_flight = true, start_fn = sp_if.start_fn }
	check("guard_in_flight_no_start", r_if.started == false and sp_if.start_count == 0 and r_if.reason == GatewayGuard.REASON.IN_FLIGHT,
		"in-flight must block the start (start_count=" .. sp_if.start_count .. ")")

	-- Allowed but start_fn fails: surfaces start_err, started=false, allowed=true.
	local sp_fail = spies(nil, "boom")
	local r_fail = GatewayGuard.guard_and_transfer{ docked = true, in_flight = false, start_fn = sp_fail.start_fn }
	check("guard_start_failure_surfaced", r_fail.started == false and r_fail.allowed == true and r_fail.start_err == "boom",
		"a start_fn failure must surface start_err while allowed=true, got started=" .. tostring(r_fail.started) .. " err=" .. tostring(r_fail.start_err))

	return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return gateway_selftest
