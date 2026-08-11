local GameUtils = require("modules/surface_export/utils/game-utils")

local ConnectionScanner = {}

function ConnectionScanner.extract_circuit_connections(entity)
  if not entity or not entity.valid then
    return {}
  end

  local connections = {}
  
  local success, wire_connectors = pcall(function() return entity.get_wire_connectors(false) end)
  if not success then log(string.format("[connection-scanner] get_wire_connectors failed on %s: %s", entity.name, tostring(wire_connectors))) end
  if not success or not wire_connectors then
    return {}
  end

  for connector_id, wire_connector in pairs(wire_connectors) do
    local wire_type = wire_connector.wire_type
    
    for _, conn in ipairs(wire_connector.connections) do
      local target_entity = conn.target and conn.target.owner
      if target_entity and target_entity.valid then
        local target_id = target_entity.unit_number
        if not target_id then
          local pos = target_entity.position
          target_id = string.format("pos_%.2f_%.2f", pos.x, pos.y)
        end

        if target_id then
          table.insert(connections, {
            source_circuit_id = connector_id,
            target_entity_id = target_id,
            target_circuit_id = conn.target.wire_connector_id
          })
        end
      end
    end
  end

  return connections
end

function ConnectionScanner.extract_power_connections(entity)
  if not entity or not entity.valid then
    return {}
  end

  if entity.type ~= "electric-pole" then
    return {}
  end

  local connections = {}

  local success, wire_connectors = pcall(function() return entity.get_wire_connectors(false) end)
  if not success then log(string.format("[connection-scanner] get_wire_connectors failed on %s: %s", entity.name, tostring(wire_connectors))) end
  if not success or not wire_connectors then
    return {}
  end

  local copper_connector = wire_connectors[defines.wire_connector_id.pole_copper]
  if not copper_connector or not copper_connector.connections then
    return {}
  end

  for _, conn in ipairs(copper_connector.connections) do
    local neighbour = conn.target and conn.target.owner
    if neighbour and neighbour.valid then
      local target_id = neighbour.unit_number
      if target_id then
        table.insert(connections, target_id)
      else
        log(string.format("[connection-scanner] copper neighbour of %s has no unit_number (type=%s) — skipped", entity.name, tostring(neighbour.type)))
      end
    end
  end

  return connections
end

function ConnectionScanner.extract_control_behavior(entity)
  if not entity or not entity.valid then
    return nil
  end

  local cb = entity.get_control_behavior()
  if not cb then
    return nil
  end

  local data = {}

  local function safe_get(prop)
    -- intentional probe; failure expected, no log
    local success, value = pcall(function() return cb[prop] end)
    return success and value or nil
  end

  data.circuit_condition = safe_get("circuit_condition")
  data.logistic_condition = safe_get("logistic_condition")
  data.enabled_condition = safe_get("enabled_condition")
  
  data.connect_to_logistic_network = safe_get("connect_to_logistic_network")
  
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
  
  data.circuit_stack_size = safe_get("circuit_stack_size")
  data.use_colors = safe_get("use_colors")
  data.trains_limit = safe_get("trains_limit")
  data.set_trains_limit = safe_get("set_trains_limit")
  data.read_trains_count = safe_get("read_trains_count")
  data.circuit_enable_disable = safe_get("circuit_enable_disable")
  data.circuit_read_resources = safe_get("circuit_read_resources")
  
  data.parameters = safe_get("parameters")
  
  if entity.name:find("constant%-combinator") then
    local sections_data = {}
    local success, sections = pcall(function() return cb.sections end)
    if not success then log(string.format("[connection-scanner] read constant-combinator sections failed on %s: %s", entity.name, tostring(sections))) end
    if success and sections and #sections > 0 then
      for _, section in ipairs(sections) do
        local section_data = {
          group = section.group,
          filters = {}
        }
        
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

  if entity.name:find("selector%-combinator") then
    data.operation = safe_get("operation")
    data.count = safe_get("count")
    data.quality = safe_get("quality")
  end

  if entity.type == "programmable-speaker" then
    data.speaker_parameters = safe_get("parameters")
    data.circuit_parameters = safe_get("circuit_parameters")
  end

  for k, v in pairs(data) do
    if v == nil then
      data[k] = nil
    end
  end

  return next(data) and data or nil
end

function ConnectionScanner.extract_logistic_sections(entity)
  if not entity or not entity.valid then
    return {}
  end

  local ok, points = pcall(function() return entity.get_logistic_point() end)
  if not ok then
    log(string.format("[connection-scanner] get_logistic_point failed on %s: %s", entity.name, tostring(points)))
    return {}
  end
  if not points then
    return {}
  end

  local out = {}
  for _, point in pairs(points) do
    local captured = {}
    local scan_ok, scan_err = pcall(function()
      for _, section in pairs(point.sections or {}) do
        if section.is_manual then
          local filters = {}
          for i = 1, section.filters_count do
            local filter = section.get_slot(i)
            if filter and filter.value then
              table.insert(filters, {
                index = i,
                value = {
                  type = filter.value.type,
                  name = filter.value.name,
                  quality = filter.value.quality,
                  comparator = filter.value.comparator,
                },
                min = filter.min,
                max = filter.max,
                import_from = filter.import_from and filter.import_from.name or nil,
              })
            end
          end
          table.insert(captured, {
            group = (section.group ~= "" and section.group) or nil,
            multiplier = section.multiplier,
            active = section.active,
            filters = filters,
          })
        end
      end
    end)
    if not scan_ok then
      log(string.format("[connection-scanner] logistic section scan failed on %s: %s — point OMITTED from payload (a partial capture would truncate the destination's sections on restore)",
        entity.name, tostring(scan_err)))
    elseif #captured > 0 then
      table.insert(out, { point_index = point.logistic_member_index, sections = captured })
    end
  end

  return out
end

function ConnectionScanner.extract_entity_filters(entity)
  if not entity or not entity.valid then
    return {}
  end

  local filters = {}
  
  if entity.type == "inserter" then
    local success, slot_count = pcall(function() return entity.filter_slot_count end)
    if not success then log(string.format("[connection-scanner] read inserter filter_slot_count failed on %s: %s", entity.name, tostring(slot_count))) end
    if success and slot_count and slot_count > 0 then
      for i = 1, slot_count do
        local filter_success, filter = pcall(function() return entity.get_filter(i) end)
        if not filter_success then log(string.format("[connection-scanner] inserter get_filter(%d) failed on %s: %s", i, entity.name, tostring(filter))) end
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
      
      if #filters == 0 and slot_count > 0 then
        log(string.format("[ConnectionScanner] Inserter at (%.1f, %.1f) has %d filter slots but no filters extracted", 
          entity.position.x, entity.position.y, slot_count))
      end
    end
  end

  if entity.type == "loader" or entity.type == "loader-1x1" then
    local success, slot_count = pcall(function() return entity.filter_slot_count end)
    if not success then log(string.format("[connection-scanner] read loader filter_slot_count failed on %s: %s", entity.name, tostring(slot_count))) end
    if success and slot_count and slot_count > 0 then
      for i = 1, slot_count do
        local filter_success, filter = pcall(function() return entity.get_filter(i) end)
        if not filter_success then log(string.format("[connection-scanner] loader get_filter(%d) failed on %s: %s", i, entity.name, tostring(filter))) end
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

  if entity.type == "cargo-wagon" then
    local success, inventory = pcall(function() return entity.get_inventory(defines.inventory.cargo_wagon) end)
    if not success then log(string.format("[connection-scanner] get cargo-wagon inventory failed on %s: %s", entity.name, tostring(inventory))) end
    if success and inventory and inventory.valid then
      for i = 1, #inventory do
        local filter_success, filter = pcall(function() return inventory.get_filter(i) end)
        if not filter_success then log(string.format("[connection-scanner] cargo-wagon get_filter(%d) failed on %s: %s", i, entity.name, tostring(filter))) end
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

function ConnectionScanner.extract_infinity_filters(entity)
  if not entity or not entity.valid then
    return {}
  end

  if entity.type ~= "infinity-container" and entity.type ~= "infinity-cargo-wagon" then
    return {}
  end

  local filters = {}
  
  local success, infinity_filters = pcall(function() return entity.infinity_container_filters end)
  if not success then log(string.format("[connection-scanner] read infinity_container_filters failed on %s: %s", entity.name, tostring(infinity_filters))) end
  if success and infinity_filters then
    for i, filter in ipairs(infinity_filters) do
      if filter and filter.name then
        table.insert(filters, {
          index = filter.index or i,
          name = filter.name,
          count = filter.count,
          mode = filter.mode,
          quality = filter.quality and filter.quality.name or GameUtils.QUALITY_NORMAL
        })
      end
    end
  end

  return filters
end

return ConnectionScanner
