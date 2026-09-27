local root = "docker/seed-data/external_plugins/surface_export/module/"

local function element(spec, parent)
	local node = {valid = true, children = {}, name = spec and spec.name, type = spec and spec.type}
	node.add = function(child_spec)
		local child = element(child_spec, node)
		node.children[#node.children + 1] = child
		if child.name then node[child.name] = child end
		return child
	end
	node.destroy = function()
		node.valid = false
		if parent and node.name then parent[node.name] = nil end
	end
	return node
end

local printed = {}
local player = {valid = true, index = 1, gui = {top = element(), screen = element()}}
player.print = function(message) printed[#printed + 1] = message end
local env = setmetatable({storage = {}, game = {connected_players = {player}, get_player = function() return player end}}, {__index = _G})
local Links = assert(loadfile(root .. "interfaces/gui/community-links.lua", "t", env))()

Links.on_join(player)
assert(#printed == 0, "no invite, no join notice")

local reply = Links.configure("  https://discord.gg/example  ")
assert(reply.success and reply.discord_invite == "https://discord.gg/example", "the invite is stored trimmed")
assert(#player.gui.top.children == 0 and #player.gui.screen.children == 0, "configuring an invite adds no GUI")

Links.on_join(player)
assert(#printed == 1 and printed[1][3] == "https://discord.gg/example", "joining players see the invite in chat")

local button = player.gui.top.add{type = "sprite-button", name = "surfexp_discord_button"}
local frame = player.gui.screen.add{type = "frame", name = "surfexp_discord_frame"}
local other = player.gui.top.add{type = "button", name = "surfexp_other_button"}
Links.on_join(player)
assert(not button.valid and not frame.valid, "a Discord button and window left in an existing save are removed on join")
assert(other.valid, "other GUI is left alone")

Links.configure(nil)
Links.on_join(player)
assert(#printed == 2, "clearing the invite stops the join notice")
print("PASS the Discord invite is shown in chat on join, with no button, and retired Discord GUI is removed")
