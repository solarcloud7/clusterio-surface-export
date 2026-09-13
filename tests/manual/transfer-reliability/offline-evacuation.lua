return function(action, name, remote_view)
  assert(#game.connected_players == 0, "offline fixture requires no connected players")
  local rec = storage.offline_evacuation_probe
  if action == "prepare" then
    assert(not rec, "fixture already exists")
    local player
    for _, candidate in pairs(game.players) do
      if not candidate.connected then player = candidate; break end
    end
    assert(player, "seed save has no offline player; connect once to a disposable seed and save it")
    local p = player.force.create_space_platform{name=name, planet="nauvis", starter_pack="space-platform-starter-pack"}
    assert(p, "platform creation failed")
    p.apply_starter_pack()
    p.paused = true
    player.set_controller{type=defines.controllers.god}
    local origin = game.surfaces.nauvis
    local position = origin.find_non_colliding_position("character", player.force.get_spawn_position(origin), 32, 0.5)
    assert(position, "Nauvis has no character spawn position")
    assert(player.teleport(position, origin), "offline teleport to Nauvis failed")
    local character = origin.create_entity{name="character", position=position, force=player.force}
    assert(character, "character creation failed")
    local steps = {}
    local function observe(label)
      steps[#steps+1] = {label=label,valid=character.valid,player_character=player.character and player.character.valid,
        controller=player.controller_type,physical=player.physical_surface_index}
    end
    observe("created")
    player.set_controller{type=defines.controllers.character, character=character}
    observe("controller")
    assert(not player.connected and player.character == nil, "expected logged-off character")
    local inv = player.get_main_inventory()
    assert(inv.insert{name="iron-plate", count=37, quality="legendary"} == 37)
    assert(inv.insert{name="copper-plate", count=19, quality="normal"} == 19)
    assert(player.teleport({2,3}, p.surface), "offline teleport to platform failed")
    observe("platform-teleport")
    if remote_view then player.set_controller{type=defines.controllers.remote, surface="nauvis", position={0,0}} end
    observe("inventory-and-view")
    p.hidden = true
    observe("hidden")
    player.force.set_surface_hidden(p.surface, true)
    observe("force-hidden")
    rec = {player=player.index, platform=p.index, surface=p.surface.index, character=character,
      before=inv.get_contents(), remote_view=remote_view, force=player.force.name, job=name}
    storage.offline_evacuation_probe = rec
    return {success=true, player=player.index, connected=player.connected,
      physical=player.physical_surface_index, surface=rec.surface, inventory=rec.before,
      steps=steps, tile=character.valid and character.surface.get_tile(character.position).name,
      unit=character.valid and character.unit_number, health=character.valid and character.health, controller=player.controller_type}
  end
  assert(rec, "fixture missing")
  local player = assert(game.get_player(rec.player))
  local p = assert(game.forces[rec.force].platforms[rec.platform])
  if action == "inspect" then
    return {success=true, connected=player.connected, physical=player.physical_surface_index,
      character_valid=rec.character.valid, current_character=player.character and player.character.valid,
      unit=player.character and player.character.valid and player.character.unit_number,
      health=rec.character.valid and rec.character.health, controller=player.controller_type,
      characters=p.surface.count_entities_filtered{type="character"}}
  end
  assert(not player.connected and player.physical_surface_index == rec.surface, "offline checkpoint changed")
  local controller = player.controller_type
  assert(controller == (rec.remote_view and defines.controllers.remote or defines.controllers.character),
    "checkpoint did not preserve the requested controller")
  assert(player.character == nil, "offline character unexpectedly exposed")
  local gateway = assert(package.loaded["__level__/modules/surface_export/core/gateway.lua"])
  local passengers, characters, complete = gateway.collect_passengers(p)
  assert(complete and #passengers == 1 and passengers[1].index == player.index and characters == 0,
    "offline passenger was missed")
  local locks = assert(package.loaded["__level__/modules/surface_export/utils/surface-lock.lua"])
  local locked, reason = locks.lock_platform(p, p.force, {kind="transfer", job_id=rec.job,
    expires_tick=game.tick + locks.DEFAULT_TRANSFER_LOCK_TTL_TICKS})
  assert(locked, reason)
  local identity = helpers.json_to_table(remote.call("surface_export", "source_recovery_identity", p.index, rec.force, rec.job))
  assert(identity.success and identity.platformUid, identity.error)
  local result = remote.call("surface_export", "delete_platform_for_transfer", p.index, p.name, rec.force, rec.job, identity.platformUid)
  local report = {success=true, result=result, connected=player.connected,
    remote_view=controller == defines.controllers.remote, controller_before=controller,
    detected=#passengers, characters=characters, character_logged_off=player.character == nil,
    physical_after=player.physical_surface.name,
    before=rec.before, after=player.get_main_inventory().get_contents(),
    platform_remaining=game.forces[rec.force].platforms[rec.platform] ~= nil,
    surface_remaining=game.surfaces[rec.surface] ~= nil,
    lock_remaining=storage.locked_platforms[rec.platform] ~= nil}
  if result == "SUCCESS" then
    player.set_controller{type=defines.controllers.god}
    storage.offline_evacuation_probe = nil
  end
  return report
end
