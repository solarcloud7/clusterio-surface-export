local game = {tick_paused = false}
local interfaces = {}
local env = setmetatable({
	game = game,
	remote = {add_interface = function(name, functions) interfaces[name] = functions end},
}, {__index = _G})
local ClusterPause = assert(loadfile("plugins/cluster_pause/module/cluster-pause.lua", "t", env))()
env.require = function(name)
	assert(name == "modules/cluster_pause/cluster-pause", name)
	return ClusterPause
end
local Module = assert(loadfile("plugins/cluster_pause/module/control.lua", "t", env))()
Module.add_remote_interface()
local set_paused = assert(interfaces.cluster_pause and interfaces.cluster_pause.set_paused, "cluster_pause.set_paused is not registered")

local result = set_paused(true)
assert(result.success == true and result.paused == true and game.tick_paused == true)
result = set_paused(false)
assert(result.success == true and result.paused == false and game.tick_paused == false)

game.tick_paused = true
for _, value in ipairs({"false", 0, {}}) do
	result = set_paused(value)
	assert(result.success == false and result.error == "paused must be true or false", tostring(value))
	assert(game.tick_paused == true, "a refused value changed tick_paused")
end
result = set_paused(nil)
assert(result.success == false and game.tick_paused == true)

env.game = setmetatable({}, {
	__index = function(_, key) if key == "tick_paused" then return false end end,
	__newindex = function() end,
})
result = set_paused(true)
assert(result.success == true and result.paused == false, "the reply must carry the value the game holds, not the value requested")

print("PASS cluster_pause sets tick_paused, reports the applied value and refuses non-boolean values (simulated game object, not the engine)")
