local GATEWAY_COLOURS = { "blue", "green", "orange", "purple" }
local GATEWAY_COUNT = #GATEWAY_COLOURS
local multi = settings.startup["surfexp-gateway-layout"].value == "multi"

local locations = {}
local connections = {}

for i, colour in ipairs(GATEWAY_COLOURS) do
	local name = "surfexp_gateway_" .. i
	locations[#locations + 1] = {
		type = "space-location",
		name = name,
		hidden = not multi,
		draw_orbit = multi,
		icon = "__surfexp_gateways__/graphics/icons/gateway-" .. colour .. ".png",
		starmap_icon = "__surfexp_gateways__/graphics/icons/starmap-gateway-" .. colour .. ".png",
		starmap_icon_size = 512,
		subgroup = "planets",
		order = "z[surfexp-gateway]-" .. i,
		gravity_pull = -10,
		distance = 45,
		orientation = (i - 1) / GATEWAY_COUNT + 0.05,
		magnitude = 1.0,
		label_orientation = 0.15,
	}
	if multi then
		connections[#connections + 1] = {
			type = "space-connection",
			name = "surfexp_gateway_link_" .. i,
			subgroup = "planet-connections",
			from = "nauvis",
			to = name,
			order = "z[surfexp-gateway]-" .. i,
			length = 15001,
		}
	end
end

local HUB_NAME = "surfexp_gateway_hub"

local hub = {
	type = "space-location",
	name = HUB_NAME,
	hidden = multi,
	draw_orbit = not multi,
	icon = "__surfexp_gateways__/graphics/icons/gateway-hub.png",
	starmap_icon = multi and "__surfexp_gateways__/graphics/icons/starmap-gateway-hub.png" or "__surfexp_gateways__/graphics/icons/starmap-clear.png",
	starmap_icon_size = multi and 512 or 64,
	starmap_icon_orientation = 0,
	subgroup = "planets",
	order = "z[surfexp-gateway]-0",
	gravity_pull = -10,
	distance = 0,
	orientation = 0.245,
	magnitude = 4,
	label_orientation = 0.15,
}
locations[#locations + 1] = hub

local INSTANCE_PREFIX = "surfexp_gateway_i_"
local INSTANCE_ROUTE_LENGTH = 1000
local INSTANCE_RING_DISTANCE = 6.5

local function parse_instances(value)
	local entries, seen = {}, {}
	for raw in string.gmatch(value or "", "[^,]+") do
		local entry = raw:match("^%s*(.-)%s*$")
		if entry ~= "" then
			local name, label = entry:match("^([^=]*)=(.*)$")
			name = (name or entry):match("^%s*(.-)%s*$")
			label = label and label:match("^%s*(.-)%s*$") or ""
			if not name:match("^[1-9]%d*$") then
				error("surfexp-gateway-instances: '" .. name .. "' must be a Clusterio instance id (digits only); the label after '=' is the name players see")
			end
			if seen[name] then
				error("surfexp-gateway-instances: instance id " .. name .. " is listed twice")
			end
			seen[name] = true
			entries[#entries + 1] = { name = name, label = label ~= "" and label or ("Server " .. name) }
		end
	end
	return entries
end

local function polar(origin, distance, orientation)
	local angle = orientation * 2 * math.pi
	return { x = origin.x + distance * math.sin(angle), y = origin.y - distance * math.cos(angle) }
end

local instances = multi and {} or parse_instances(settings.startup["surfexp-gateway-instances"].value)
local hub_position = polar({ x = 0, y = 0 }, hub.distance, hub.orientation)
for i, instance in ipairs(instances) do
	local name = INSTANCE_PREFIX .. instance.name
	local colour = GATEWAY_COLOURS[(i - 1) % GATEWAY_COUNT + 1]
	locations[#locations + 1] = {
		type = "space-location",
		name = name,
		localised_name = { "", instance.label },
		localised_description = { "space-location-description.surfexp_gateway_instance", instance.label },
		hidden = false,
		draw_orbit = true,
		icon = "__surfexp_gateways__/graphics/icons/gateway-" .. colour .. ".png",
		starmap_icon = "__surfexp_gateways__/graphics/icons/starmap-gateway-" .. colour .. ".png",
		starmap_icon_size = 512,
		subgroup = "planets",
		order = "z[surfexp-gateway]-i-" .. string.format("%03d", i),
		gravity_pull = -10,
		origin = hub_position,
		distance = INSTANCE_RING_DISTANCE,
		orientation = (hub.orientation + (i - 1) / #instances) % 1,
		magnitude = 0.5,
		label_orientation = (hub.orientation + (i - 1) / #instances) % 1,
	}
	connections[#connections + 1] = {
		type = "space-connection",
		name = "surfexp_gateway_link_i_" .. instance.name,
		subgroup = "planet-connections",
		from = HUB_NAME,
		to = name,
		order = "z[surfexp-gateway]-i-" .. string.format("%03d", i),
		length = INSTANCE_ROUTE_LENGTH,
	}
end

if not multi then
	for _, planet in ipairs({ "nauvis" }) do
		connections[#connections + 1] = {
			type = "space-connection",
			name = "surfexp_gateway_link_hub" .. (planet == "nauvis" and "" or "_" .. planet),
			subgroup = "planet-connections",
			from = planet,
			to = HUB_NAME,
			order = "z[surfexp-gateway]-0-" .. planet,
			length = planet == "aquilo" and 30001 or 15001,
		}
	end
end

data:extend(locations)
data:extend(connections)

local lab_select = function(color)
	return {
		border_color = color,
		cursor_box_type = "entity",
		mode = { "any-entity" },
	}
end

data:extend({
	{
		type = "selection-tool",
		name = "selection-lab-tool",
		icons = {
			{ icon = "__base__/graphics/icons/blueprint.png", icon_size = 64, tint = { r = 0.6, g = 1, b = 0.8 } },
		},
		subgroup = "tool",
		order = "z[selection-lab-tool]",
		stack_size = 1,
		flags = { "only-in-cursor", "spawnable", "not-stackable" },
		select = lab_select({ r = 0.25, g = 0.75, b = 1 }),
		alt_select = lab_select({ r = 0.35, g = 1, b = 0.35 }),
		reverse_select = lab_select({ r = 1, g = 0.75, b = 0.25 }),
		alt_reverse_select = lab_select({ r = 1, g = 0.3, b = 0.3 }),
	},
	{
		type = "custom-input",
		name = "selection-lab-undo",
		key_sequence = "CONTROL + ALT + Z",
	},
	{
		type = "custom-input",
		name = "selection-lab-redo",
		key_sequence = "CONTROL + ALT + Y",
	},
})
