-- surfexp_gateways — surfaceless "gateway" space-locations for the surface_export plugin.
--
-- Modeled EXACTLY on vanilla space-age `solar-system-edge` (a parkable, surfaceless
-- space-location): no `surface`/`map_gen` (so no surface is generated), and crucially NO
-- `fly_condition` — so a platform that routes here reaches a stable `waiting_at_station`
-- (it PARKS) instead of flying by. The neighbouring `shattered-planet` sets `fly_condition = true`,
-- which is the fly-by tell; we deliberately omit it. Verified empirically in Phase 0.
--
-- Shipped LOCKED (no unlocking technology). The save-patched surface_export module unlocks each
-- gateway per-force at runtime via `force.unlock_space_location(name)`. This is a PURE DATA-STAGE
-- mod — there is no control.lua; all gateway logic lives in the plugin module.

local GATEWAY_COUNT = 4

local locations = {}
local connections = {}

for i = 1, GATEWAY_COUNT do
	local name = "surfexp_gateway_" .. i
	locations[#locations + 1] = {
		type = "space-location",
		name = name,
		-- Reuse the solar-system-edge icon (this mod hard-depends on space-age). Cosmetic only;
		-- distinct gateway art is a later-polish concern, not part of the transfer mechanic.
		icon = "__space-age__/graphics/icons/solar-system-edge.png",
		subgroup = "planets",
		order = "z[surfexp-gateway]-" .. i,
		gravity_pull = -10,
		-- Star-map placement only (cosmetic). Spread around an empty ring near the system edge.
		distance = 45,
		orientation = (i - 1) / GATEWAY_COUNT + 0.05,
		magnitude = 1.0,
		label_orientation = 0.15,
		-- NO fly_condition              -> a routed platform PARKS here (the transfer trigger).
		-- NO asteroid_spawn_definitions  -> a safe, asteroid-free gateway route.
	}
	connections[#connections + 1] = {
		type = "space-connection",
		name = "surfexp_gateway_link_" .. i,
		subgroup = "planet-connections",
		from = "nauvis",
		to = name,
		order = "z[surfexp-gateway]-" .. i,
		-- Short hop. Vanilla nauvis->planet is 15000; aquilo->solar-system-edge is 100000.
		length = 3000,
	}
end

data:extend(locations)
data:extend(connections)

-- ============================================================================
-- Selection Lab tool — drag-select debug instrument for the surface_export module.
-- Prototype ONLY (this mod stays data-stage); all four handlers live in the save-patched
-- module (interfaces/gui/selection-lab.lua), gated on debug_mode:
--   select              = CAPTURE selection via the real export serializer (RAM only)
--   alt_select          = APPLY capture via the real import restores (in place)
--   reverse_select      = PREVIEW: highlight ONLY blocks an apply would overwrite/conflict
--   alt_reverse_select  = CLEAR selected belts' transport lanes
-- ============================================================================
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
		select = lab_select({ r = 0.25, g = 0.75, b = 1 }),          -- capture: blue
		alt_select = lab_select({ r = 0.35, g = 1, b = 0.35 }),      -- apply: green
		reverse_select = lab_select({ r = 1, g = 0.75, b = 0.25 }),  -- preview: orange
		alt_reverse_select = lab_select({ r = 1, g = 0.3, b = 0.3 }),-- clear lanes: red
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
	-- Selection Lab undo/redo hotkeys. Bound to CONTROL+ALT (unbound in vanilla) rather than
	-- CONTROL+SHIFT: vanilla Redo defaults to BOTH "CONTROL + Y" and "CONTROL + SHIFT + Z", so the
	-- former CONTROL+SHIFT+Z lab-undo binding collided with vanilla Redo and fired lab undo on a normal
	-- build-redo keystroke. CONTROL+ALT+Z / CONTROL+ALT+Y do not collide with any vanilla default.
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
