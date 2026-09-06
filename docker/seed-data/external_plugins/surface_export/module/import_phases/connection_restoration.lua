local ConnectionRestoration = {}

function ConnectionRestoration.restore_circuit_connections(entity, entity_data, entity_map)
  if not entity.valid then
    return 0
  end

  if not entity_data.circuit_connections then
    return 0
  end

  local connected_count = 0

  log(string.format("[Import] Restoring %d circuit connections for %s (id=%s)",
    #entity_data.circuit_connections,
    entity.name,
    tostring(entity_data.entity_id)))

  for _, conn in ipairs(entity_data.circuit_connections) do
    local target = entity_map[conn.target_entity_id]

    if not target and type(conn.target_entity_id) == "string" and conn.target_entity_id:find("^pos_") then
      local x, y = conn.target_entity_id:match("pos_([%d%.%-]+)_([%d%.%-]+)")
      if x and y then
        x, y = tonumber(x), tonumber(y)
        for _, candidate in pairs(entity_map) do
          if candidate.valid then
            local pos = candidate.position
            if math.abs(pos.x - x) < 0.1 and math.abs(pos.y - y) < 0.1 then
              target = candidate
              break
            end
          end
        end
      end
    end

    if target and target.valid then
      local success, err = pcall(function()
        local source_connector = entity.get_wire_connector(conn.source_circuit_id, true)
        local target_connector = target.get_wire_connector(conn.target_circuit_id, true)

        if source_connector and target_connector then
          local connected = source_connector.connect_to(target_connector, false)
          if connected then
            connected_count = connected_count + 1
          end
        else
          log(string.format("[WARN] Could not get connectors: source=%s, target=%s",
            tostring(source_connector), tostring(target_connector)))
        end
      end)
      if not success then
        log(string.format("[WARN] Failed to connect wire: %s", tostring(err)))
      end
    else
      log(string.format("[FactorioSurfaceExport] Warning: Could not find target entity %s for circuit connection from %s",
        tostring(conn.target_entity_id), entity.name))
    end
  end

  return connected_count
end

local function payload_copper_peers(entity_data, entity_map, copper)
  local peers = {}
  for _, conn in ipairs(entity_data.circuit_connections or {}) do
    if conn.source_circuit_id == copper and conn.target_circuit_id == copper then
      local peer = entity_map[conn.target_entity_id]
      if peer and peer.valid and peer.unit_number then
        peers[peer.unit_number] = true
      end
    end
  end
  return peers
end

local function restored_unit_numbers(entity_map)
  local restored = {}
  for _, entity in pairs(entity_map) do
    if entity and entity.valid and entity.unit_number then
      restored[entity.unit_number] = true
    end
  end
  return restored
end

local function is_pole_like(entity)
  if entity.type == "electric-pole" then
    return true
  end
  return entity.type == "entity-ghost" and entity.ghost_type == "electric-pole"
end

local SCRIPT_REACHABLE_WIRE_ORIGINS = { "player", "script" }

local function resolve_prune_origins()
  local origins = {}
  local names = {}
  for _, name in ipairs(SCRIPT_REACHABLE_WIRE_ORIGINS) do
    local value = defines.wire_origin[name]
    if value == nil then
      log(string.format("[Deserializer] pole copper prune: defines.wire_origin.%s is absent at this engine — "
        .. "copper held at that origin cannot be removed", name))
    else
      origins[#origins + 1] = value
      names[#names + 1] = name
    end
  end
  return origins, table.concat(names, "+")
end

local function disconnect_at_every_origin(connector, target, origins, origin_names, kind, label, tally)
  local removed = 0
  for _, origin in ipairs(origins) do
    if connector.disconnect_from(target.connector, origin) then
      removed = removed + 1
      tally.pruned = tally.pruned + 1
    end
  end
  if removed == 0 then
    log(string.format("[Deserializer] %s copper prune REMOVED NOTHING %s -> %s: no wire was held at any of "
      .. "the origins tried (%s), import continues", kind, label, target.label, origin_names))
  end
end

local function prune_one_pole(entity, entity_data, entity_map, restored, copper, label, tally, origins, origin_names)
  local peers = payload_copper_peers(entity_data, entity_map, copper)
  local connector = entity.get_wire_connector(copper, false)
  if not connector then
    return
  end

  local foreign = {}
  local seen = {}
  for _, conn in ipairs(connector.real_connections) do
    local peer_connector = conn.target
    local peer = peer_connector and peer_connector.owner
    if peer and peer.valid and peer.type == "electric-pole" and peer.unit_number
      and restored[peer.unit_number] and not peers[peer.unit_number] and not seen[peer.unit_number] then
      seen[peer.unit_number] = true
      foreign[#foreign + 1] = {
        connector = peer_connector,
        label = string.format("%s (%.1f, %.1f)", peer.name, peer.position.x, peer.position.y),
      }
    end
  end

  for _, target in ipairs(foreign) do
    disconnect_at_every_origin(connector, target, origins, origin_names, "pole", label, tally)
  end
end

local function prune_one_pole_ghost_wires(entity, entity_data, entity_map, restored, copper, label, tally,
  origins, origin_names)
  local peers = payload_copper_peers(entity_data, entity_map, copper)
  local connector = entity.get_wire_connector(copper, false)
  if not connector then
    return
  end

  local foreign = {}
  local seen = {}
  for _, conn in ipairs(connector.connections) do
    local peer_connector = conn.target
    local peer = peer_connector and peer_connector.owner
    if peer and peer.valid and (connector.is_ghost or peer_connector.is_ghost)
      and is_pole_like(peer) and peer.unit_number
      and restored[peer.unit_number] and not peers[peer.unit_number] and not seen[peer.unit_number] then
      seen[peer.unit_number] = true
      foreign[#foreign + 1] = {
        connector = peer_connector,
        label = string.format("%s (%.1f, %.1f)", peer.name, peer.position.x, peer.position.y),
      }
    end
  end

  for _, target in ipairs(foreign) do
    disconnect_at_every_origin(connector, target, origins, origin_names, "ghost pole", label, tally)
  end
end

function ConnectionRestoration.prune_pole_copper(entities_to_create, entity_map)
  local copper = defines.wire_connector_id.pole_copper
  local restored = restored_unit_numbers(entity_map)
  local tally = { pruned = 0 }
  local origins, origin_names = resolve_prune_origins()

  for _, entity_data in ipairs(entities_to_create) do
    local entity = entity_map[entity_data.entity_id]
    if entity and entity.valid and is_pole_like(entity) then
      local label = string.format("%s (%.1f, %.1f)", entity.name, entity.position.x, entity.position.y)

      if entity.type == "electric-pole" then
        local ok, err = pcall(prune_one_pole, entity, entity_data, entity_map, restored, copper, label, tally,
          origins, origin_names)
        if not ok then
          log(string.format("[Deserializer] pole copper prune THREW for %s: %s — that pole may keep copper the "
            .. "payload does not carry, import continues", label, tostring(err)))
        end
      end

      local ghost_ok, ghost_err = pcall(prune_one_pole_ghost_wires, entity, entity_data, entity_map, restored,
        copper, label, tally, origins, origin_names)
      if not ghost_ok then
        log(string.format("[Deserializer] ghost pole copper prune THREW for %s: %s — that pole may keep a "
          .. "planned wire the payload does not carry, import continues", label, tostring(ghost_err)))
      end
    end
  end

  return tally.pruned
end

return ConnectionRestoration
