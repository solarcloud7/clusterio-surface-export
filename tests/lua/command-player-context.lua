local root = "docker/seed-data/external_plugins/surface_export/module/"
local function noop() end
local stub = setmetatable({}, {__index = function() return noop end})
local commands, console, player_messages, logs, opened = {}, {}, {}, {}, {}
local force = {name = "player", platforms = {}}
local player = {index = 1, name = "admin-one", admin = true, valid = true, force = force,
    print = function(message) player_messages[#player_messages+1] = message end}
local modules = {['interfaces/gui/transaction-dashboard'] = {
    open = function(target, limit) opened[#opened+1] = {player = target, limit = limit} end}}
local env = setmetatable({log = function(message) logs[#logs+1] = message end,
    rcon = {print = function(message) console[#console+1] = message end},
    commands = {add_command = function(name, _, fn) commands[name] = fn end}}, {__index = _G})
env.game = {players = {player}, forces = {player = force},
    get_player = function(index) return env.game.players[index] end}
env.require = function(path) return modules[path:match('^modules/surface_export/(.*)$')] or stub end
modules['interfaces/commands/base'] = assert(loadfile(root .. 'interfaces/commands/base.lua', 't', env))()
assert(loadfile(root .. 'interfaces/commands/transaction-dashboard.lua', 't', env))()
assert(loadfile(root .. 'interfaces/commands/transfer-platform.lua', 't', env))()

local function reset() console, player_messages, logs, opened = {}, {}, {}, {} end
local function joined(list) return table.concat(list, ' | ') end

reset()
commands['transaction-dashboard']({player_index = 1})
assert(#opened == 1, "player-run /transaction-dashboard did not open the dashboard; player saw: " .. joined(player_messages))
assert(opened[1].player == player and opened[1].limit == 25, "dashboard opened for the wrong player or default limit")
assert(#player_messages == 0 and #console == 0, "successful open printed: " .. joined(player_messages) .. joined(console))

reset()
commands['transaction-dashboard']({player_index = 1, parameter = '10'})
assert(#opened == 1 and opened[1].player == player and opened[1].limit == 10, "explicit limit was not passed to the dashboard")

for _, parameter in ipairs({'abc', '0', '501'}) do
    reset()
    commands['transaction-dashboard']({player_index = 1, parameter = parameter})
    assert(#opened == 0, "invalid limit " .. parameter .. " opened the dashboard")
    assert(joined(player_messages):find('Invalid limit', 1, true), "invalid limit " .. parameter .. " was not reported to the player")
end

reset()
commands['transaction-dashboard']({})
assert(#opened == 0, "console-run /transaction-dashboard opened a dashboard")
assert(#console == 1 and console[1]:find('must be run by a player', 1, true), "console caller got: " .. joined(console))
assert(not console[1]:find('Command error', 1, true), "console caller hit a handler error: " .. console[1])

reset()
commands['transfer-platform']({player_index = 1})
assert(logs[1] and logs[1]:find('invoked by admin-one:', 1, true), "transfer log did not name the invoking player: " .. tostring(logs[1]))
reset()
commands['transfer-platform']({})
assert(logs[1] and logs[1]:find('invoked by RCON:', 1, true), "transfer log did not name RCON for a console caller: " .. tostring(logs[1]))

print("PASS player-run commands resolve ctx.player: dashboard opens with its limit, console callers get a player-only message, transfer logs name the caller")
