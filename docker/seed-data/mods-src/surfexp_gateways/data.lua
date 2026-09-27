local GATEWAY_COLOURS = { "blue", "green", "orange", "purple" }
local GATEWAY_COUNT = #GATEWAY_COLOURS
local HUB_NAME = "surfexp_gateway_hub"
local PORTAL_ROUTE_LENGTH = 1000
local PORTAL_RING_DISTANCE = 3.5

local locations = {}
local connections = {}

local hub = {
	type = "space-location",
	name = HUB_NAME,
	hidden = false,
	draw_orbit = true,
	icon = "__surfexp_gateways__/graphics/icons/gateway-hub.png",
	starmap_icon = "__surfexp_gateways__/graphics/icons/starmap-gateway-hub.png",
	starmap_icon_size = 512,
	starmap_icon_orientation = 0,
	subgroup = "planets",
	order = "z[surfexp-gateway]-0",
	gravity_pull = -10,
	distance = 0,
	orientation = 0.245,
	magnitude = 4,
	label_orientation = 0,
}
locations[#locations + 1] = hub

local function polar(origin, distance, orientation)
	local angle = orientation * 2 * math.pi
	return { x = origin.x + distance * math.sin(angle), y = origin.y - distance * math.cos(angle) }
end

local hub_position = polar({ x = 0, y = 0 }, hub.distance, hub.orientation)
for i, colour in ipairs(GATEWAY_COLOURS) do
	local name = "surfexp_gateway_" .. i
	local orientation = (i - 0.5) / GATEWAY_COUNT
	locations[#locations + 1] = {
		type = "space-location",
		name = name,
		hidden = false,
		draw_orbit = true,
		icon = "__surfexp_gateways__/graphics/icons/gateway-" .. colour .. ".png",
		starmap_icon = "__surfexp_gateways__/graphics/icons/starmap-gateway-" .. colour .. ".png",
		starmap_icon_size = 512,
		subgroup = "planets",
		order = "z[surfexp-gateway]-" .. i,
		gravity_pull = -10,
		origin = hub_position,
		distance = PORTAL_RING_DISTANCE,
		orientation = orientation,
		magnitude = 0.5,
		label_orientation = orientation,
	}
	connections[#connections + 1] = {
		type = "space-connection",
		name = "surfexp_gateway_link_" .. i,
		subgroup = "planet-connections",
		from = HUB_NAME,
		to = name,
		order = "z[surfexp-gateway]-" .. i,
		length = PORTAL_ROUTE_LENGTH,
		shape = "line",
	}
end

connections[#connections + 1] = {
	type = "space-connection",
	name = "surfexp_gateway_link_hub",
	subgroup = "planet-connections",
	from = "nauvis",
	to = HUB_NAME,
	order = "z[surfexp-gateway]-0-nauvis",
	length = 15001,
}

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
