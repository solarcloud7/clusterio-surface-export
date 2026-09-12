local root = "docker/seed-data/external_plugins/surface_export/module/"
local function noop() end
local stub = setmetatable({}, {__index = function() return noop end})
local commands, messages, batches = {}, {}, {}
local modules = {['core/export-pipeline'] = {process_batch = function(_, get_size) batches[#batches+1] = get_size() end},
    ['utils/operation-timing'] = {scope = function(_, _, fn, ...) return fn(...) end}}
local env = setmetatable({storage = {surface_export_config = {debug_mode = false}, async_jobs = {
    export = {type = "export", job_id = "export", started_tick = 1}}}, log = noop,
    game = {tick = 1, players = {}, forces = {player = {}}, print = noop},
    rcon = {print = function(message) messages[#messages+1] = message end},
    commands = {add_command = function(name, _, fn) commands[name] = fn end}}, {__index = _G})
env.require = function(path) return modules[path:match('^modules/surface_export/(.*)$')] or stub end
local scheduler = assert(loadfile(root .. 'core/async-processor.lua', 't', env))()
modules['core/async-processor'] = scheduler
modules['interfaces/commands/base'] = assert(loadfile(root .. 'interfaces/commands/base.lua', 't', env))()
assert(loadfile(root .. 'interfaces/commands/export-sync-mode.lua', 't', env))()
commands['export-sync-mode']({parameter = 'on'})
assert(not scheduler.get_sync_mode(), "admin command bypassed debug_mode=false")
assert(table.concat(messages, ' '):find('debug_mode'), "refusal omitted the reason")
for _, value in ipairs({false, 'false', 1}) do
    env.storage.surface_export_config.debug_mode = value
    assert(not pcall(scheduler.set_sync_mode, true), "direct setter bypassed debug gate")
end
env.storage.surface_export_config.debug_mode = true
commands['export-sync-mode']({parameter = 'on'})
scheduler.process_tick()
assert(batches[#batches] == 1000000)
env.storage.surface_export_config.debug_mode = false
env.game.tick = 2; scheduler.process_tick()
assert(batches[#batches] == 50 and not scheduler.get_sync_mode(), "disabling debug retained the large batch limit")
assert(pcall(scheduler.set_sync_mode, false), "could not turn sync mode off with debug disabled")
env.storage.surface_export_config.debug_mode = true
assert(not scheduler.get_sync_mode(), "reenabling debug silently reenabled sync mode")
print("PASS debug-off command/setter refusal and immediate scheduler return to normal batch size")
