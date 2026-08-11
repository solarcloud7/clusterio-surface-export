local ImportTarget = {}

ImportTarget.DEFAULT_PLANET = "nauvis"

function ImportTarget.resolve(requested)
	if requested == nil or requested == "" then
		return ImportTarget.DEFAULT_PLANET, nil, nil
	end
	if type(requested) ~= "string" then
		return nil, nil, string.format("requested target must be a string, got %s", type(requested))
	end
	local proto = prototypes.space_location[requested]
	if proto == nil then
		return nil, nil, string.format("space location '%s' does not exist on this instance", requested)
	end
	if proto.type == "planet" then
		return requested, nil, nil
	end
	return ImportTarget.DEFAULT_PLANET, requested, nil
end

return ImportTarget
