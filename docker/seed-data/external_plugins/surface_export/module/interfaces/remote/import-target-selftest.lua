local ImportTarget = require("modules/surface_export/core/import-target")
local Gateway = require("modules/surface_export/core/gateway")

local function import_target_selftest()
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

	local default_proto = prototypes.space_location[ImportTarget.DEFAULT_PLANET]
	check("default_creation_target_is_a_planet_on_this_instance",
		default_proto ~= nil and default_proto.type == "planet",
		"'" .. ImportTarget.DEFAULT_PLANET .. "' must exist as a planet — every non-planet target falls back to it")

	local cp, park, err = ImportTarget.resolve(nil)
	check("no_request_resolves_to_the_default_planet",
		cp == ImportTarget.DEFAULT_PLANET and park == nil and err == nil,
		string.format("got create='%s', park='%s', err='%s'", tostring(cp), tostring(park), tostring(err)))

	cp, park, err = ImportTarget.resolve("nauvis")
	check("a_planet_is_its_own_creation_target_with_no_park",
		cp == "nauvis" and park == nil and err == nil,
		string.format("got create='%s', park='%s', err='%s'", tostring(cp), tostring(park), tostring(err)))

	cp, park, err = ImportTarget.resolve("surfexp_selftest_bogus_location")
	check("an_unknown_location_is_refused_not_defaulted",
		cp == nil and err ~= nil,
		"an unknown name silently landing on the default planet would hide the operator's real choice")

	local gateway_name = nil
	for name in pairs(prototypes.space_location) do
		if Gateway.is_gateway(name) then
			gateway_name = name
			break
		end
	end
	check("a_gateway_space_location_exists_on_this_instance", gateway_name ~= nil,
		"no surfexp_gateway_* space location found — the gateway mod pack is missing")
	if gateway_name then
		cp, park, err = ImportTarget.resolve(gateway_name)
		check("a_gateway_creates_on_the_default_planet_and_parks_at_the_gateway",
			cp == ImportTarget.DEFAULT_PLANET and park == gateway_name and err == nil,
			string.format("resolve('%s') got create='%s', park='%s', err='%s' — passing a gateway to "
				.. "create_space_platform throws 'Given space location is not a planet'",
				gateway_name, tostring(cp), tostring(park), tostring(err)))
	end

	local violations = {}
	for name in pairs(prototypes.space_location) do
		local create_target, _, resolve_err = ImportTarget.resolve(name)
		if resolve_err ~= nil then
			violations[#violations + 1] = string.format("%s errored: %s", name, resolve_err)
		else
			local proto = prototypes.space_location[create_target]
			if proto == nil or proto.type ~= "planet" then
				violations[#violations + 1] = string.format("%s -> %s", name, tostring(create_target))
			end
		end
	end
	check("every_known_location_resolves_to_a_planet_creation_target", #violations == 0,
		"create_space_platform would throw for: " .. table.concat(violations, ", "))

	return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return import_target_selftest
