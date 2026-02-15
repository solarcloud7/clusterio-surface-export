-- Remote Interface: list_platforms
-- List all available platforms for a given force as structured data.

local SurfaceLock = require("modules/surface_export/utils/surface-lock")

--- List all available platforms for a force.
--- @param force_name string|nil: Force name (defaults to "player")
--- @return table: Array of platform metadata
local function list_platforms(force_name)
  local force = game.forces[force_name or "player"]
  if not force then
    return {}
  end

  local platforms = {}
  for _, platform in pairs(force.platforms) do
    if platform and platform.valid then
      local surface = platform.surface
      local entity_count = 0
      local surface_index = nil
      local surface_name = nil

      if surface and surface.valid then
        surface_index = surface.index
        surface_name = surface.name
        entity_count = #surface.find_entities_filtered({})
      end

      table.insert(platforms, {
        platform_index = platform.index,
        platform_name = platform.name,
        force_name = force.name,
        surface_index = surface_index,
        surface_name = surface_name,
        entity_count = entity_count,
        is_locked = SurfaceLock.is_locked(platform.name),
      })
    end
  end

  table.sort(platforms, function(a, b)
    return a.platform_name < b.platform_name
  end)

  return platforms
end

return list_platforms
