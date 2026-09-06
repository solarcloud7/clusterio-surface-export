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
			length = 3000,
		}
	end
end

local HUB_NAME = "surfexp_gateway_hub"

locations[#locations + 1] = {
	type = "space-location",
	name = HUB_NAME,
	hidden = multi,
	draw_orbit = not multi,
	icon = "__surfexp_gateways__/graphics/icons/gateway-hub.png",
	starmap_icon = "__surfexp_gateways__/graphics/icons/starmap-gateway-hub.png",
	starmap_icon_size = 512,
	starmap_icon_orientation = 0,
	subgroup = "planets",
	order = "z[surfexp-gateway]-0",
	gravity_pull = -10,
	distance = 25.5,
	orientation = 0.245,
	magnitude = 2.25,
	label_orientation = 0.15,
}

if not multi then
	for _, planet in ipairs({ "nauvis", "vulcanus", "gleba", "fulgora", "aquilo" }) do
		connections[#connections + 1] = {
			type = "space-connection",
			name = "surfexp_gateway_link_hub" .. (planet == "nauvis" and "" or "_" .. planet),
			subgroup = "planet-connections",
			from = planet,
			to = HUB_NAME,
			order = "z[surfexp-gateway]-0-" .. planet,
			length = 3000,
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
		type = "shortcut",
		name = "selection-lab-tool",
		action = "spawn-item",
		item_to_spawn = "selection-lab-tool",
		icon = "__base__/graphics/icons/blueprint.png",
		icon_size = 64,
		small_icon = "__base__/graphics/icons/blueprint.png",
		small_icon_size = 64,
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
