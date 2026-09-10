-- Native blueprint capture is independent of the plugin serializer and validator.
-- Temporary inventory is always destroyed, including capture errors.
return function(index, fail_capture)
  local platform = assert(game.forces.player.platforms[index], "platform absent")
  local surface = platform.surface
  local physical = surface.find_entities_filtered{force="player"}
  assert(#physical <= 12000, "settings observer entity bound")
  local inventory = game.create_inventory(1)
  local ok, result = pcall(function()
    assert(inventory[1].set_stack{name="blueprint",count=1})
    local area = {{-1,-1},{1,1}}
    for _, entity in pairs(physical) do
      area[1][1] = math.min(area[1][1], entity.position.x-8)
      area[1][2] = math.min(area[1][2], entity.position.y-8)
      area[2][1] = math.max(area[2][1], entity.position.x+8)
      area[2][2] = math.max(area[2][2], entity.position.y+8)
    end
    local mapping = inventory[1].create_blueprint{surface=surface,force="player",area=area,
      include_entities=true,include_modules=true,include_trains=true,include_fuel=true,
      include_station_names=true}
    local entities = inventory[1].get_blueprint_entities() or {}
    local identities, covered, excluded = {}, {}, {}
    for number, entity in pairs(mapping) do
      identities[tostring(number)] = entity.name .. "@" .. entity.position.x .. "," .. entity.position.y
      covered[identities[tostring(number)]] = true
    end
    for _, entity in pairs(physical) do
      local identity = entity.name .. "@" .. entity.position.x .. "," .. entity.position.y
      if not covered[identity] then
        excluded[#excluded+1] = {name=entity.name,type=entity.type,position=entity.position}
      end
    end
    for _, entity in pairs(entities) do
      entity.position = mapping[entity.entity_number].position
    end
    assert(not fail_capture, "intentional settings capture failure")
    return {success=true,tick=game.tick,index=platform.index,name=platform.name,
      entities=entities,identities=identities,uncovered=excluded,physicalCount=#physical}
  end)
  inventory.destroy()
  if not ok then return {success=true,captureError=tostring(result),inventoryDestroyed=not inventory.valid} end
  result.inventoryDestroyed = not inventory.valid
  return result
end
