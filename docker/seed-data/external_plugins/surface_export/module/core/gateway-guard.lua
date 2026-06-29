-- FactorioSurfaceExport - Gateway transfer guard (pure decision + transfer orchestration)
--
-- The gate for a gateway transfer fired from the on-arrival chooser GUI. Split so the decision is
-- side-effect-free and callable at GUI render time:
--   GatewayGuard.evaluate(deps)           -- PURE. No side effects. Safe while drawing the GUI (to
--                                            enable/disable the Transfer button). Returns the decision.
--   GatewayGuard.guard_and_transfer(deps) -- Re-evaluates, then calls start_fn() ONLY when allowed.
--
-- Passengers do NOT block the transfer: anyone aboard is EVACUATED to a planet at the source-delete
-- chokepoint (delete_platform_for_transfer → Gateway.evacuate_passengers), so the transfer is always safe to
-- start (native-aligned with how the engine returns a player to a planet on hub loss). evaluate still reports
-- passenger_count for an informational GUI note. The gate is simply: docked at the gateway, not already
-- mid-transfer.
--
-- Inputs are INJECTED via `deps` (docked / in_flight / aboard_players / aboard_characters / start_fn) so the
-- gate is unit-testable with fakes — see interfaces/remote/gateway-selftest.lua. `online` is deliberately NOT
-- a gate input (stale controller snapshot; live routing is the real reachability gate).

local Gateway = require("modules/surface_export/core/gateway")

local GatewayGuard = {}

--- Reasons a transfer can be blocked (stable identifiers for tests + UI messaging).
GatewayGuard.REASON = {
	OK = "ok",
	NOT_DOCKED = "not_docked",
	IN_FLIGHT = "in_flight",
}

--- Pure decision: may this gateway transfer start? NO side effects — safe at render time.
--- @param deps table {
---   docked            boolean  -- the platform is parked AT a gateway right now
---   in_flight         boolean  -- the platform is already locked / mid-transfer (authoritative lock state)
---   aboard_players    table?   -- array of LuaPlayer (or fakes) bodily aboard (informational only)
---   aboard_characters number?  -- count of character entities on the platform surface (informational only)
--- }
--- @return table { allowed boolean, reason string, passenger_count number }
function GatewayGuard.evaluate(deps)
	deps = deps or {}
	-- Informational only (max(), not sum() — see Gateway.passenger_count). Passengers do NOT block; they are
	-- evacuated to a planet at the source delete. The GUI uses this to warn "N aboard will be returned home".
	local passenger_count = Gateway.passenger_count(deps.aboard_players or {}, deps.aboard_characters or 0)

	if not deps.docked then
		return { allowed = false, reason = GatewayGuard.REASON.NOT_DOCKED, passenger_count = passenger_count }
	end
	if deps.in_flight then
		return { allowed = false, reason = GatewayGuard.REASON.IN_FLIGHT, passenger_count = passenger_count }
	end
	return { allowed = true, reason = GatewayGuard.REASON.OK, passenger_count = passenger_count }
end

--- Orchestration for the explicit Transfer action: re-evaluate, then start ONLY when allowed. start_fn is
--- never reached on a block — the invariant the self-test asserts (a green safety test proves the bad outcome
--- did not happen AND that the gate, not luck, prevented it).
--- @param deps table evaluate()'s deps PLUS: start_fn function()->ok,err  (starts the transfer; only when allowed)
--- @return table { started boolean, allowed boolean, reason string, passenger_count number, start_err string|nil }
function GatewayGuard.guard_and_transfer(deps)
	deps = deps or {}
	local decision = GatewayGuard.evaluate(deps)
	if not decision.allowed then
		return {
			started = false,
			allowed = false,
			reason = decision.reason,
			passenger_count = decision.passenger_count,
		}
	end

	local ok, err = deps.start_fn()
	return {
		started = ok and true or false,
		allowed = true,
		reason = GatewayGuard.REASON.OK,
		passenger_count = decision.passenger_count,
		start_err = (not ok) and err or nil,
	}
end

return GatewayGuard
