local Gateway = require("modules/surface_export/core/gateway")

local GatewayGuard = {}

GatewayGuard.REASON = {
	OK = "ok",
	NOT_DOCKED = "not_docked",
	IN_FLIGHT = "in_flight",
}

function GatewayGuard.evaluate(deps)
	deps = deps or {}
	local passenger_count = Gateway.passenger_count(deps.aboard_players or {}, deps.aboard_characters or 0)

	if not deps.docked then
		return { allowed = false, reason = GatewayGuard.REASON.NOT_DOCKED, passenger_count = passenger_count }
	end
	if deps.in_flight then
		return { allowed = false, reason = GatewayGuard.REASON.IN_FLIGHT, passenger_count = passenger_count }
	end
	return { allowed = true, reason = GatewayGuard.REASON.OK, passenger_count = passenger_count }
end

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
