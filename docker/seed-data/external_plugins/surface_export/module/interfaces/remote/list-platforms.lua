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
      local has_space_hub = false

      if surface and surface.valid then
        surface_index = surface.index
        surface_name = surface.name
        entity_count = #surface.find_entities_filtered({})
        local hub = surface.find_entity("space-platform-hub", {0, 0})
        has_space_hub = hub ~= nil and hub.valid
      end

      local space_location_name = nil
      if platform.space_location and platform.space_location.valid then
        space_location_name = platform.space_location.name
      end

      -- Read destination from schedule (platform.current_target does NOT exist on LuaSpacePlatform)
      local current_target_name = nil
      local ok_sched, schedule = pcall(function() return platform.schedule end)
      if ok_sched and schedule and schedule.records and schedule.current then
        local current_record = schedule.records[schedule.current]
        if current_record and current_record.station then
          current_target_name = current_record.station
        end
      end

      local flight_data = storage.platform_flight_data and storage.platform_flight_data[platform.name]

      -- CRITICAL: Space platforms use defines.space_platform_state, NOT defines.train_state
      local platform_state = nil
      local ok_state, state_val = pcall(function() return platform.state end)
      if ok_state and state_val then
        local sps = defines.space_platform_state
        if state_val == sps.on_the_path then
          platform_state = "on_the_path"
        elseif state_val == sps.waiting_at_station then
          platform_state = "wait_station"
        elseif state_val == sps.waiting_for_departure then
          platform_state = "waiting_for_departure"
        elseif state_val == sps.no_path then
          platform_state = "no_path"
        elseif state_val == sps.no_schedule then
          platform_state = "no_schedule"
        elseif state_val == sps.paused then
          platform_state = "paused"
        end
      end

      table.insert(platforms, {
        platform_index = platform.index,
        platform_name = platform.name,
        force_name = force.name,
        surface_index = surface_index,
        surface_name = surface_name,
        entity_count = entity_count,
        is_locked = SurfaceLock.is_locked(platform.name),
        has_space_hub = has_space_hub,
        space_location = space_location_name,
        current_target = current_target_name,
        speed = platform.speed or 0,
        state = platform_state,
        departure_tick = flight_data and flight_data.departure_tick or nil,
        estimated_duration_ticks = flight_data and flight_data.estimated_duration_ticks or nil,
      })
    end
  end

  table.sort(platforms, function(a, b)
    return a.platform_name < b.platform_name
  end)

  return platforms
end

return list_platforms
