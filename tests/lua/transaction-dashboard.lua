local root = os.getenv("SE_MODULE_ROOT") or "docker/seed-data/external_plugins/surface_export/module/"
local cleared = 0
local history = {list = function() return {} end, count = function() return 0 end, clear = function() cleared = cleared + 1 end}

local function element(spec, parent)
    local tags = {}
    for k, v in pairs(spec.tags or {}) do tags[k] = v end
    local self = {valid = true, name = spec.name, type = spec.type, tags = tags, style = {}, enabled = true}
    self.add = function(child_spec)
        local child = element(child_spec, self)
        if child.name then self[child.name] = child end
        return child
    end
    self.destroy = function()
        self.valid = false
        if parent and self.name and parent[self.name] == self then parent[self.name] = nil end
    end
    return self
end

local printed = {}
local player = {index = 1, admin = true, valid = true, gui = {screen = element({type = "screen"})},
    print = function(message) printed[#printed + 1] = message end}
local game_stub = {players = {player}}

local function load_dashboard()
    local env = setmetatable({game = game_stub}, {__index = _G})
    env.require = function(path)
        assert(path == "modules/surface_export/utils/transaction-history", "unexpected require " .. tostring(path))
        return history
    end
    return assert(loadfile(root .. "interfaces/gui/transaction-dashboard.lua", "t", env))()
end
local function frame() return player.gui.screen["transaction_dashboard_frame"] end
local function click(dashboard, name)
    return pcall(dashboard.on_gui_click, {element = {valid = true, name = name}, player_index = 1})
end

local dashboard = load_dashboard()
dashboard.open(player, 50)
assert(frame() and frame().valid, "the dashboard opens")

local restarted = load_dashboard()
local ok, err = click(restarted, "transaction_dashboard_clear")
assert(ok, "Clear History on a dashboard left open across a restart raised: " .. tostring(err))
assert(cleared == 1 and frame() and frame().tags.limit == 50, "the cleared dashboard reopens with the limit it had before the restart")
print("PASS Clear History on a dashboard left open across a restart clears and keeps the limit, without a Lua error")

assert(click(restarted, "transaction_dashboard_limit_10") and frame().tags.limit == 10, "a limit button reopens the dashboard with that limit")
local again = load_dashboard()
again.refresh(player)
assert(frame() and frame().tags.limit == 10, "refresh after a restart keeps the frame's limit")
again.on_gui_closed({element = frame(), player_index = 1})
assert(frame() == nil, "closing the dashboard removes its frame")
again.refresh(player)
assert(frame() == nil, "refresh does not reopen a closed dashboard")
assert(click(again, "transaction_dashboard_clear") and cleared == 2 and frame().tags.limit == 25,
    "Clear History with no dashboard frame falls back to the default limit")
print("PASS limit buttons, refresh and close work from the frame alone, so nothing depends on state lost at a restart")
