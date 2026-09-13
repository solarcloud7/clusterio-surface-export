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
    assert(player.teleport({2,3}, p.surface), "offline teleport to platform failed")
    local character = p.surface.create_entity{name="character", position={2,3}, force=player.force}
    assert(character, "character creation failed")
    player.set_controller{type=defines.controllers.character, character=character}
    local inv = player.get_main_inventory()
    assert(inv.insert{name="iron-plate", count=37, quality="legendary"} == 37)
    assert(inv.insert{name="copper-plate", count=19, quality="normal"} == 19)
    if remote_view then player.set_controller{type=defines.controllers.remote, surface="nauvis", position={0,0}} end
    p.hidden = true
    player.force.set_surface_hidden(p.surface, true)
    rec = {player=player.index, platform=p.index, surface=p.surface.index, character=character,
      before=inv.get_contents(), remote_view=remote_view, force=player.force.name, job=name}
    storage.offline_evacuation_probe = rec
    return {success=true, player=player.index, connected=player.connected,
      physical=player.physical_surface_index, surface=rec.surface, inventory=rec.before}
  end
  assert(rec, "fixture missing")
  local player = assert(game.get_player(rec.player))
  local p = assert(game.forces[rec.force].platforms[rec.platform])
  assert(not player.connected and player.physical_surface_index == rec.surface, "offline checkpoint changed")
  local controller = player.controller_type
  assert(controller == (rec.remote_view and defines.controllers.remote or defines.controllers.character),
    "checkpoint did not preserve the requested controller")
  assert(rec.character.valid, "character missing after load")
  local gateway = assert(package.loaded["__level__/modules/surface_export/core/gateway.lua"])
  local passengers, characters, complete = gateway.collect_passengers(p)
  assert(complete and #passengers == 1 and passengers[1].index == player.index and characters == 1,
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
    detected=#passengers, characters=characters, character_valid=rec.character.valid,
    physical_after=player.physical_surface.name,
    character_surface=rec.character.valid and rec.character.surface.name,
    before=rec.before, after=rec.character.valid and rec.character.get_main_inventory().get_contents(),
    platform_remaining=game.forces[rec.force].platforms[rec.platform] ~= nil,
    surface_remaining=game.surfaces[rec.surface] ~= nil,
    lock_remaining=storage.locked_platforms[rec.platform] ~= nil}
  if result == "SUCCESS" then
    player.set_controller{type=defines.controllers.god}
    assert(rec.character.destroy(), "fixture character cleanup failed")
    storage.offline_evacuation_probe = nil
  end
  return report
end
