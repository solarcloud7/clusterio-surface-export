-- FactorioSurfaceExport - Gateway identification + unlock
--
-- Gateways are surfaceless `space-location` prototypes added by the `surfexp_gateways` data mod
-- (surfexp_gateway_1..N). A platform can route to and PARK at one (they have no fly_condition). This
-- module identifies them and unlocks them per-force so platforms can route there. It caches NOTHING:
-- prototypes are always queryable at runtime, so a stored gateway set would just be redundant state.
--
-- All gateway *logic* (arrival detection, transfer trigger, hop-strip) lives in the save-patched
-- module, not the data mod. See docs/GATEWAY_TRANSFER_PRD.md.

local Gateway = {}

-- Every gateway space-location name starts with this. Kept in lockstep with surfexp_gateways/data.lua.
Gateway.PREFIX = "surfexp_gateway_"

--- Is `name` a gateway space-location? Prefix match AND a real prototype, so a renamed/stale name
--- (or an arbitrary station that merely starts with the prefix) cannot masquerade as a gateway.
--- @param name string|nil
--- @return boolean
function Gateway.is_gateway(name)
	if type(name) ~= "string" then
		return false
	end
	if name:sub(1, #Gateway.PREFIX) ~= Gateway.PREFIX then
		return false
	end
	return prototypes.space_location[name] ~= nil
end

--- Unlock every gateway space-location for every force so platforms can route to them. Idempotent and
--- cheap — safe to call on every server startup. pcall-guarded per (force, gateway) so one bad force
--- (e.g. a force without space travel) can't abort the rest.
--- @return number unlocked The number of (force, gateway) unlocks that succeeded.
function Gateway.discover_and_unlock()
	local unlocked = 0
	for name, _ in pairs(prototypes.space_location) do
		if Gateway.is_gateway(name) then
			for _, force in pairs(game.forces) do
				local ok, err = pcall(function()
					force.unlock_space_location(name)
				end)
				if ok then
					unlocked = unlocked + 1
				else
					log(string.format("[Gateway] unlock '%s' for force '%s' failed: %s",
						name, tostring(force.name), tostring(err)))
				end
			end
		end
	end
	log(string.format("[Gateway] discover_and_unlock: %d gateway/force unlocks", unlocked))
	return unlocked
end

return Gateway
