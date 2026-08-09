local RemoteBase = require("modules/surface_export/interfaces/remote/base")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

local Base = {}

function Base.create_context(command)
  local ctx = {}
  ctx.player = command.player_index and game.get_player(command.player_index)
  ctx.force = (ctx.player and ctx.player.force) or game.forces.player
  ctx.is_admin = not command.player_index or (game.players[command.player_index] and game.players[command.player_index].admin)
  ctx.param = command.parameter
  
  if ctx.player then
    ctx.print = function(msg, color) ctx.player.print(msg, color) end
  else
    ctx.print = function(msg) rcon.print(msg) end
  end
  
  return ctx
end

function Base.admin_command(name, help, handler)
  commands.add_command(name, help, function(command)
    local ctx = Base.create_context(command)
    
    if not ctx.is_admin then
      ctx.print("Error: Only admins can use this command")
      return
    end
    
    local success, err = pcall(handler, command, ctx)
    if not success then
      log(string.format("[ERROR] /%s command crashed: %s", name, err))
      ctx.print("Command error: " .. tostring(err))
    end
  end)
end

function Base.command(name, help, handler)
  commands.add_command(name, help, function(command)
    local ctx = Base.create_context(command)
    
    local success, err = pcall(handler, command, ctx)
    if not success then
      log(string.format("[ERROR] /%s command crashed: %s", name, err))
      ctx.print("Command error: " .. tostring(err))
    end
  end)
end

function Base.parse_params(param_string)
  local params = {}
  if param_string then
    for param in string.gmatch(param_string, "%S+") do
      table.insert(params, param)
    end
  end
  return params
end

Base.find_platform = RemoteBase.find_platform
Base.get_force = RemoteBase.get_force

function Base.resolve_lock_key(force, name_or_index)
  local target, find_err = Base.find_platform(force, name_or_index)
  if find_err then return nil, find_err end
  if target then return target.index, nil, target.name end
  return SurfaceLock.find_lock_key_by_name(name_or_index)
end

return Base
