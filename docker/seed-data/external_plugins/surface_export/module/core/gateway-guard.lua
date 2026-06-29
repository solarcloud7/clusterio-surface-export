-- FactorioSurfaceExport - Gateway transfer guard (pure decision + protective orchestration)
--
-- The safety gate for a gateway transfer fired from the on-arrival chooser GUI. Split deliberately
-- into two layers so the decision is side-effect-free and callable at GUI render time:
--
--   GatewayGuard.evaluate(deps)          -- PURE. No side effects. Safe to call while drawing the GUI
--                                           (used to enable/disable the Transfer button). Returns the
--                                           decision only.
--   GatewayGuard.guard_and_transfer(deps) -- SIDE-EFFECTING. Called ONLY on the explicit Transfer click:
--                                           re-evaluates, runs the protective route (best-effort eject /
--                                           notify) when blocked by passengers, and starts the transfer
--                                           ONLY when allowed.
--
-- Why a HARD passenger block is the guarantee (researched on 2.0.76): a platform parked at a gateway sits
-- on a surfaceless `space-location` — there is no planet to `land_on_planet` onto, so a passenger cannot
-- actually be put anywhere; eject is therefore best-effort/notify only. Transferring with anyone aboard
-- would delete the source surface out from under them, orphaning the player. So we never start a transfer
-- while a passenger is detected — the block, not the eject, is the safety floor.
--
-- All inputs are INJECTED via `deps` (docked / in_flight / aboard_players / aboard_characters / eject_fn /
-- start_fn) so the gate is unit-testable with fakes — see interfaces/remote/gateway-selftest.lua. NOTE:
-- `online` is deliberately NOT a gate input — it is a stale controller snapshot (no instance-status hook),
-- so gating on it could block a transfer to a genuinely-reachable instance; the live controller routing is
-- the real reachability gate, and a failed route rolls the source back. `online` is informational only.

local GatewayGuard = {}

--- Reasons a transfer can be blocked (stable identifiers for tests + UI messaging).
GatewayGuard.REASON = {
	OK = "ok",
	NOT_DOCKED = "not_docked",
	IN_FLIGHT = "in_flight",
	PASSENGERS = "passengers_aboard",
}

--- Pure decision: may this gateway transfer start? NO side effects — safe at render time.
--- @param deps table {
---   docked            boolean  -- the platform is parked AT a gateway right now
---   in_flight         boolean  -- the platform is already locked / mid-transfer (authoritative lock state)
---   aboard_players    table?   -- array of LuaPlayer (or fakes) bodily aboard
---   aboard_characters number?  -- count of character entities on the platform surface
--- }
--- @return table { allowed boolean, reason string, passenger_count number }
function GatewayGuard.evaluate(deps)
	deps = deps or {}
	local aboard_players = deps.aboard_players or {}
	local aboard_characters = deps.aboard_characters or 0
	-- Conservative over-count is fine for a safety gate: a connected player aboard is counted both as a
	-- player and (via its character entity) in aboard_characters. Over-counting only ever makes the block
	-- MORE cautious; it can never let a real passenger slip through.
	local passenger_count = #aboard_players + aboard_characters

	if not deps.docked then
		return { allowed = false, reason = GatewayGuard.REASON.NOT_DOCKED, passenger_count = passenger_count }
	end
	if deps.in_flight then
		return { allowed = false, reason = GatewayGuard.REASON.IN_FLIGHT, passenger_count = passenger_count }
	end
	if passenger_count > 0 then
		return { allowed = false, reason = GatewayGuard.REASON.PASSENGERS, passenger_count = passenger_count }
	end
	return { allowed = true, reason = GatewayGuard.REASON.OK, passenger_count = 0 }
end

--- Protective orchestration for the explicit Transfer action. Re-evaluates the gate; on a passenger block
--- runs the best-effort protective route (eject_fn per aboard player — really a notify at a surfaceless
--- gateway); and calls start_fn() ONLY when the gate allows. start_fn is never reached on any block — that
--- is the invariant the self-test asserts (a green safety test must prove the protective route ran AND the
--- bad outcome did not happen).
--- @param deps table evaluate()'s deps PLUS:
---   eject_fn  function(player)  -- best-effort eject/notify of one aboard player (pcall-guarded)
---   start_fn  function()->ok,err -- starts the transfer; called only when allowed
--- @return table { started boolean, allowed boolean, reason string, passenger_count number, start_err string|nil }
function GatewayGuard.guard_and_transfer(deps)
	deps = deps or {}
	local decision = GatewayGuard.evaluate(deps)

	if not decision.allowed then
		-- Protective route: when blocked by passengers, best-effort eject/notify each one so they know to
		-- disembark before retrying. Pcall-guarded — a notify failure must never abort the (already-safe)
		-- block. NOT run for not_docked / in_flight (nothing to eject, and the platform may be mid-flight).
		if decision.reason == GatewayGuard.REASON.PASSENGERS and deps.eject_fn then
			for _, player in ipairs(deps.aboard_players or {}) do
				-- intentional probe; eject/notify is best-effort and a failure must NOT abort the block
				-- (the block is the safety guarantee, not the eject) — see the comment block above. No log.
				pcall(deps.eject_fn, player)
			end
		end
		return {
			started = false,
			allowed = false,
			reason = decision.reason,
			passenger_count = decision.passenger_count,
		}
	end

	-- Allowed: fire the transfer. start_fn owns its own failure reporting; we surface (ok, err).
	local ok, err = deps.start_fn()
	return {
		started = ok and true or false,
		allowed = true,
		reason = GatewayGuard.REASON.OK,
		passenger_count = 0,
		start_err = (not ok) and err or nil,
	}
end

return GatewayGuard
