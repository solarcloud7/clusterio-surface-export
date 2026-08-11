local GatewayConfigStaging = require("modules/surface_export/core/gateway-config-staging")
local configure = require("modules/surface_export/interfaces/remote/configure")
local Util = require("modules/surface_export/utils/util")

local function apply_gateways(gateways_json, active_gateways_json)
	local decoded = Util.json_to_table_compat(gateways_json)
	if type(decoded) ~= "table" then
		error("configure_gateways: gateways_json did not decode to a table")
	end
	local n = 0
	for _ in pairs(decoded) do n = n + 1 end
	configure({ gateways_json = gateways_json, active_gateways_json = active_gateways_json })
	return { ok = true, gateways = n, bytes = #gateways_json }
end

local function configure_gateways(gateways_json, active_gateways_json)
	return apply_gateways(gateways_json, active_gateways_json)
end

local function configure_gateways_begin(token, total_chunks, checksum)
	GatewayConfigStaging.begin(token, total_chunks, checksum)
	return { ok = true }
end

local function configure_gateways_chunk(token, index, part)
	local received = GatewayConfigStaging.add_chunk(token, index, part)
	return { ok = true, received = received }
end

local function configure_gateways_commit(token, active_gateways_json)
	local assembled = GatewayConfigStaging.take(token)
	return apply_gateways(assembled, active_gateways_json)
end

return {
	configure_gateways = configure_gateways,
	configure_gateways_begin = configure_gateways_begin,
	configure_gateways_chunk = configure_gateways_chunk,
	configure_gateways_commit = configure_gateways_commit,
}
