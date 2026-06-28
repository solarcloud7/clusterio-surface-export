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
