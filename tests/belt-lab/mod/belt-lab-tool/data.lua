-- Belt Lab Tool — a selection tool for capture/apply experiments on belt lane contents.
-- Four modes on one tool (2.0 SelectionToolPrototype):
--   select              = CAPTURE lanes (transfer-record shape)
--   alt_select          = APPLY captured state, PRODUCTION per-piece algorithm
--   reverse_select      = APPLY captured state, WHOLE-LINE candidate algorithm
--   alt_reverse_select  = CLEAR lanes
local belt_types = { "transport-belt", "underground-belt", "splitter" }

data:extend({
	{
		type = "selection-tool",
		name = "belt-lab-tool",
		icons = {
			{ icon = "__base__/graphics/icons/transport-belt.png", icon_size = 64 },
			{ icon = "__base__/graphics/icons/signal/signal_L.png", icon_size = 64, scale = 0.25, shift = { 8, -8 } },
		},
		subgroup = "tool",
		order = "z[belt-lab-tool]",
		stack_size = 1,
		flags = { "only-in-cursor", "spawnable", "not-stackable" },
		select = {
			border_color = { r = 0.25, g = 0.75, b = 1 },
			cursor_box_type = "entity",
			mode = { "any-entity" },
			entity_type_filters = belt_types,
		},
		alt_select = {
			border_color = { r = 0.35, g = 1, b = 0.35 },
			cursor_box_type = "entity",
			mode = { "any-entity" },
			entity_type_filters = belt_types,
		},
		reverse_select = {
			border_color = { r = 1, g = 0.75, b = 0.25 },
			cursor_box_type = "entity",
			mode = { "any-entity" },
			entity_type_filters = belt_types,
		},
		alt_reverse_select = {
			border_color = { r = 1, g = 0.3, b = 0.3 },
			cursor_box_type = "entity",
			mode = { "any-entity" },
			entity_type_filters = belt_types,
		},
	},
	{
		type = "shortcut",
		name = "belt-lab-tool",
		action = "spawn-item",
		item_to_spawn = "belt-lab-tool",
		icon = "__base__/graphics/icons/transport-belt.png",
		icon_size = 64,
		small_icon = "__base__/graphics/icons/transport-belt.png",
		small_icon_size = 64,
		associated_control_input = "",
	},
})
