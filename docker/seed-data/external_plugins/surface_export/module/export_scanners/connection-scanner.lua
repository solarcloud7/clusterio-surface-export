-- FactorioSurfaceExport - Connection Scanner
-- Extract circuit connections, power connections, and control behavior
-- Updated for Factorio 2.0 wire connector API

local GameUtils = require("modules/surface_export/utils/game-utils")

local ConnectionScanner = {}

--- Extract all circuit wire connections from an entity
--- Uses Factorio 2.0 get_wire_connectors() API
--- Returns connection definitions that can be used to reconnect later
--- @param entity LuaEntity: The entity to extract connections from
--- @return table: Array of connection definitions
function ConnectionScanner.extract_circuit_connections(entity)
  if not entity or not entity.valid then
    return {}
  end

  local connections = {}
  
  -- Factorio 2.0: Use get_wire_connectors() API instead of circuit_connection_definitions
  local success, wire_connectors = pcall(function() return entity.get_wire_connectors(false) end)
  if not success or not wire_connectors then
    return {}
  end

  for connector_id, wire_connector in pairs(wire_connectors) do
    -- wire_connector.wire_type: 2 = red, 3 = green
    -- wire_connector.connections[]: array of {target = WireConnector, origin = position}
    local wire_type = wire_connector.wire_type
    
    for _, conn in ipairs(wire_connector.connections) do
      -- conn.target is a WireConnector, conn.target.owner is the target entity
      local target_entity = conn.target and conn.target.owner
      if target_entity and target_entity.valid then
        local target_id = target_entity.unit_number
        if not target_id then
          -- Fallback to position-based ID for entities without unit_number
          local pos = target_entity.position
          target_id = string.format("pos_%.2f_%.2f", pos.x, pos.y)
        end

        if target_id then
          table.insert(connections, {
            source_circuit_id = connector_id,           -- Wire connector ID on source (encodes wire type)
            target_entity_id = target_id,
            target_circuit_id = conn.target.wire_connector_id  -- Wire connector ID on target
          })
        end
      end
    end
  end

  return connections
end

--- Extract power wire connections (copper cables between electric poles)
--- @param entity LuaEntity: The electric pole entity
--- @return table: Array of connected pole IDs
function ConnectionScanner.extract_power_connections(entity)
  if not entity or not entity.valid then
    return {}
  end

  -- Only electric poles have copper wire connections
  if entity.type ~= "electric-pole" then
    return {}
  end

  local connections = {}
  
  local success, neighbours = pcall(function() return entity.neighbours end)
  if not success or not neighbours or not neighbours.copper then
    return {}
  end

  for _, neighbour in ipairs(neighbours.copper) do
    if neighbour.valid then
      local target_id = neighbour.unit_number
      if not target_id then
        local pos = neighbour.position
        target_id = string.format("pos_%.2f_%.2f", pos.x, pos.y)
      end
      table.insert(connections, target_id)
    end
  end

  return connections
end

--- Extract complete control behavior settings from an entity
--- @param entity LuaEntity: The entity to extract control behavior from
--- @return table|nil: Control behavior data, or nil if no control behavior
function ConnectionScanner.extract_control_behavior(entity)
  if not entity or not entity.valid then
    return nil
  end

  local cb = entity.get_control_behavior()
  if not cb then
    return nil
  end

  local data = {}

  -- Common control behavior properties (many entities)
  local function safe_get(prop)
    local success, value = pcall(function() return cb[prop] end)
    return success and value or nil
  end

  -- Circuit conditions
  data.circuit_condition = safe_get("circuit_condition")
  data.logistic_condition = safe_get("logistic_condition")
  data.enabled_condition = safe_get("enabled_condition")
  
  -- Connection settings
  data.connect_to_logistic_network = safe_get("connect_to_logistic_network")
  
  -- Read settings
  data.read_contents = safe_get("read_contents")
  data.read_stopped_train = safe_get("read_stopped_train")
  data.read_from_train = safe_get("read_from_train")
  data.send_to_train = safe_get("send_to_train")
  data.circuit_read_hand_contents = safe_get("circuit_read_hand_contents")
  data.circuit_hand_read_mode = safe_get("circuit_hand_read_mode")
  data.circuit_mode_of_operation = safe_get("circuit_mode_of_operation")
  data.circuit_read_signal = safe_get("circuit_read_signal")
  data.circuit_set_signal = safe_get("circuit_set_signal")
  data.read_logistics = safe_get("read_logistics")
  data.read_robot_stats = safe_get("read_robot_stats")
  
  -- Entity-specific settings
  data.circuit_stack_size = safe_get("circuit_stack_size")
  data.use_colors = safe_get("use_colors")
  data.trains_limit = safe_get("trains_limit")
  data.set_trains_limit = safe_get("set_trains_limit")
  data.read_trains_count = safe_get("read_trains_count")
  data.circuit_enable_disable = safe_get("circuit_enable_disable")
  data.circuit_read_resources = safe_get("circuit_read_resources")
  
  -- Combinator parameters (arithmetic, decider)
  data.parameters = safe_get("parameters")
  
  -- Constant combinator signals (Factorio 2.0+ uses sections instead of signals_count)
  if entity.name:find("constant%-combinator") then
    local sections_data = {}
    local success, sections = pcall(function() return cb.sections end)
    if success and sections and #sections > 0 then
      for _, section in ipairs(sections) do
        local section_data = {
          group = section.group,
          filters = {}
        }
        
        -- Extract all filters/signals from this section
        for i = 1, section.filters_count do
          local filter = section.get_slot(i)
          if filter and filter.value then
            table.insert(section_data.filters, {
              index = i,
              value = filter.value,
              min = filter.min,
              max = filter.max,
              quality = filter.quality and filter.quality.name or nil
            })
          end
        end
        
        table.insert(sections_data, section_data)
      end
    end
    
    if #sections_data > 0 then
      data.constant_sections = sections_data
    end
  end

  -- Selector combinator (2.0+)
  if entity.name:find("selector%-combinator") then
    data.operation = safe_get("operation")
    data.count = safe_get("count")
    data.quality = safe_get("quality")
  end

  -- Speaker parameters
  if entity.type == "programmable-speaker" then
    data.speaker_parameters = safe_get("parameters")
    data.circuit_parameters = safe_get("circuit_parameters")
  end

  -- Remove nil values to save space
  for k, v in pairs(data) do
    if v == nil then
      data[k] = nil
    end
  end

  return next(data) and data or nil
end

--- Extract logistic request slots from a requester/buffer chest
--- @param entity LuaEntity: The logistic container entity
--- @return table: Array of request slots
function ConnectionScanner.extract_logistic_requests(entity)
  if not entity or not entity.valid then
    return {}
  end

  if entity.type ~= "logistic-container" then
    return {}
  end

  local requests = {}
  
  local success, slot_count = pcall(function() return entity.request_slot_count end)
  if not success or not slot_count or slot_count == 0 then
    return {}
  end

  for i = 1, slot_count do
    local req_success, request = pcall(function() return entity.get_request_slot(i) end)
    if req_success and request then
      table.insert(requests, {
        index = i,
        name = request.name,
        count = request.count,
        quality = request.quality and request.quality.name or GameUtils.QUALITY_NORMAL
      })
    end
  end

  return requests
end

--- Extract filter slots from filter inserters, loaders, etc.
--- @param entity LuaEntity: The entity with filters
--- @return table: Array of filter definitions
function ConnectionScanner.extract_entity_filters(entity)
  if not entity or not entity.valid then
    return {}
  end

  local filters = {}
  
  -- Filter inserters (2.0+ supports multiple filter slots)
  if entity.type == "inserter" then
    local success, slot_count = pcall(function() return entity.filter_slot_count end)
    if success and slot_count and slot_count > 0 then
      for i = 1, slot_count do
        local filter_success, filter = pcall(function() return entity.get_filter(i) end)
        if filter_success and filter and filter.name then
          table.insert(filters, {
            index = i,
            name = filter.name,
            quality = filter.quality and filter.quality.name or GameUtils.QUALITY_NORMAL,
            comparator = filter.comparator
          })
          log(string.format("[ConnectionScanner] Extracted inserter filter at (%.1f, %.1f) slot %d: %s", 
            entity.position.x, entity.position.y, i, filter.name))
        end
      end
      
      -- Debug: Log if we have slot count but no filters extracted
      if #filters == 0 and slot_count > 0 then
        log(string.format("[ConnectionScanner] Inserter at (%.1f, %.1f) has %d filter slots but no filters extracted", 
          entity.position.x, entity.position.y, slot_count))
      end
    end
  end

  -- Loaders and loader-1x1
  if entity.type == "loader" or entity.type == "loader-1x1" then
    local success, slot_count = pcall(function() return entity.filter_slot_count end)
    if success and slot_count and slot_count > 0 then
      for i = 1, slot_count do
        local filter_success, filter = pcall(function() return entity.get_filter(i) end)
        if filter_success and filter then
          table.insert(filters, {
            index = i,
            name = filter.name,
            quality = filter.quality and filter.quality.name or GameUtils.QUALITY_NORMAL
          })
        end
      end
    end
  end

  -- Cargo wagon filters
  if entity.type == "cargo-wagon" then
    local success, inventory = pcall(function() return entity.get_inventory(defines.inventory.cargo_wagon) end)
    if success and inventory and inventory.valid then
      for i = 1, #inventory do
        local filter_success, filter = pcall(function() return inventory.get_filter(i) end)
        if filter_success and filter then
          table.insert(filters, {
            index = i,
            name = filter.name,
            quality = filter.quality and filter.quality.name or GameUtils.QUALITY_NORMAL
          })
        end
      end
    end
  end

  return filters
end

--- Extract infinity container filters (mainly for testing/creative mode)
--- @param entity LuaEntity: The infinity container
--- @return table: Array of infinity filters
function ConnectionScanner.extract_infinity_filters(entity)
  if not entity or not entity.valid then
    return {}
  end

  if not entity.prototype.name:find("infinity") then
    return {}
  end

  local filters = {}
  
  local success, infinity_filters = pcall(function() return entity.infinity_container_filters end)
  if success and infinity_filters then
    for i, filter in ipairs(infinity_filters) do
      if filter and filter.name then
        table.insert(filters, {
          index = filter.index or i,
          name = filter.name,
          count = filter.count,
          mode = filter.mode, -- "at-least", "at-most", "exactly"
          quality = filter.quality and filter.quality.name or GameUtils.QUALITY_NORMAL
        })
      end
    end
  end

  return filters
end

return ConnectionScanner
