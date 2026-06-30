-- Command Interface: Base utilities
-- Common helper functions for command modules

local RemoteBase = require("modules/surface_export/interfaces/remote/base")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

local Base = {}

--- Create command context with common utilities
--- @param command table: The command object from Factorio
--- @return table: Context with player, force, is_admin, print
function Base.create_context(command)
  local ctx = {}
  ctx.player = command.player_index and game.get_player(command.player_index)
  ctx.force = (ctx.player and ctx.player.force) or game.forces.player
  ctx.is_admin = not command.player_index or (game.players[command.player_index] and game.players[command.player_index].admin)
  ctx.param = command.parameter
  
  -- Print function that works for both player and RCON
  if ctx.player then
    ctx.print = function(msg) ctx.player.print(msg) end
  else
    ctx.print = function(msg) rcon.print(msg) end
  end
  
  return ctx
end

--- Register an admin-only command with automatic error handling
--- @param name string: Command name (without /)
--- @param help string: Help text shown in /help
--- @param handler function: Handler function(command, ctx)
function Base.admin_command(name, help, handler)
  commands.add_command(name, help, function(command)
    local ctx = Base.create_context(command)
    
    -- Admin check
    if not ctx.is_admin then
      ctx.print("Error: Only admins can use this command")
      return
    end
    
    -- Run handler with pcall for error safety
    local success, err = pcall(handler, command, ctx)
    if not success then
      log(string.format("[ERROR] /%s command crashed: %s", name, err))
      ctx.print("Command error: " .. tostring(err))
    end
  end)
end

--- Register a command (no admin check) with automatic error handling
--- @param name string: Command name (without /)
--- @param help string: Help text shown in /help
--- @param handler function: Handler function(command, ctx)
function Base.command(name, help, handler)
  commands.add_command(name, help, function(command)
    local ctx = Base.create_context(command)
    
    -- Run handler with pcall for error safety
    local success, err = pcall(handler, command, ctx)
    if not success then
      log(string.format("[ERROR] /%s command crashed: %s", name, err))
      ctx.print("Command error: " .. tostring(err))
    end
  end)
end

--- Parse space-separated parameters from command string
--- @param param_string string|nil: The command.parameter string
--- @return table: Array of parameters
function Base.parse_params(param_string)
  local params = {}
  if param_string then
    for param in string.gmatch(param_string, "%S+") do
      table.insert(params, param)
    end
  end
  return params
end

-- Re-export utilities from remote/base
Base.find_platform = RemoteBase.find_platform
Base.get_force = RemoteBase.get_force

--- Resolve a platform name-or-index to its lock-registry key (the unique platform index). A live platform
--- resolves to its `.index`; an orphaned lock (the platform was already deleted) is recovered by a name scan
--- of the registry. Fails loud on an ambiguous name (≥2 live platforms — or ≥2 locks — share it) so a
--- destructive lock op never silently targets the wrong platform; the caller prints the error and returns.
--- @param force LuaForce
--- @param name_or_index string|number: Unique platform index (preferred) or display name
--- @return number|nil lock_key, string|nil err
function Base.resolve_lock_key(force, name_or_index)
  local target, find_err = Base.find_platform(force, name_or_index)
  if find_err then return nil, find_err end
  if target then return target.index, nil end
  return SurfaceLock.find_lock_key_by_name(name_or_index)
end

return Base
