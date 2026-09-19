local ImportTarget = {}
local PlanetPolicy = require("modules/surface_export/core/planet-policy")

ImportTarget.default_planet = PlanetPolicy.default_planet

function ImportTarget.resolve(requested)
	if requested == nil or requested == "" then
		return PlanetPolicy.default_planet(), nil, nil
	end
	if type(requested) ~= "string" then
		return nil, nil, string.format("requested target must be a string, got %s", type(requested))
	end
	local proto = prototypes.space_location[requested]
	if proto == nil then
		return nil, nil, string.format("space location '%s' does not exist on this instance", requested)
	end
	if proto.type == "planet" then
		if PlanetPolicy.is_disabled(requested) then return nil, nil, "Planet is unavailable on this instance: " .. requested end
		return requested, nil, nil
	end
	return PlanetPolicy.default_planet(), requested, nil
end

return ImportTarget
