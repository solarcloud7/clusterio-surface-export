local root = "docker/seed-data/external_plugins/surface_export/module/"

local function element(spec, parent)
	local node = {valid = true, style = {}, children = {}, name = spec and spec.name, type = spec and spec.type,
		caption = spec and spec.caption, text = spec and spec.text, sprite = spec and spec.sprite, tooltip = spec and spec.tooltip}
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
	node.focus = function() node.focused = true end
	node.select_all = function() node.selected_all = true end
	return node
end

local function find(node, name)
	for _, child in ipairs(node.children) do
		if child.name == name then return child end
		local nested = find(child, name)
		if nested then return nested end
	end
end

local printed = {}
local player = {valid = true, index = 1, gui = {top = element(), screen = element()}}
player.print = function(message) printed[#printed + 1] = message end
local env = setmetatable({storage = {}, game = {connected_players = {player}, get_player = function() return player end}}, {__index = _G})
local Links = assert(loadfile(root .. "interfaces/gui/community-links.lua", "t", env))()

Links.refresh(player)
assert(not player.gui.top.surfexp_discord_button, "no invite, no button")
Links.on_join(player)
assert(#printed == 0, "no invite, no join notice")

local reply = Links.configure("  https://discord.gg/example  ")
assert(reply.success and reply.discord_invite == "https://discord.gg/example", "the invite is stored trimmed")
local button = player.gui.top.surfexp_discord_button
assert(button and button.type == "sprite-button" and button.tooltip:find("Discord", 1, true), "setting an invite adds the button for connected players")

Links.on_gui_click{player_index = 1, element = button}
local frame = player.gui.screen.surfexp_discord_frame
local box = frame and find(frame, "surfexp_discord_link")
assert(box and box.type == "text-box" and box.read_only == true and box.text == "https://discord.gg/example", "the window shows the invite in a read-only box")
assert(box.focused and box.selected_all and player.opened == frame, "the link is focused and selected, ready for Ctrl+C")
Links.on_gui_click{player_index = 1, element = button}
assert(not player.gui.screen.surfexp_discord_frame, "the button toggles the window closed")

Links.on_gui_click{player_index = 1, element = button}
Links.on_gui_closed{player_index = 1, element = player.gui.screen.surfexp_discord_frame}
assert(not player.gui.screen.surfexp_discord_frame, "Escape closes the window")

Links.on_join(player)
assert(#printed == 1 and printed[1][3] == "https://discord.gg/example", "joining players see the invite in chat")

Links.on_gui_click{player_index = 1, element = button}
local open_box = find(player.gui.screen.surfexp_discord_frame, "surfexp_discord_link")
open_box.selected_all = nil
local changed = Links.configure("https://discord.gg/replacement")
assert(changed.discord_invite == "https://discord.gg/replacement", "the replacement invite is acknowledged")
assert(open_box.valid and open_box.text == "https://discord.gg/replacement", "an open window shows the replacement invite, not the old one")
assert(open_box.selected_all, "the replacement link is selected, ready for Ctrl+C")

Links.configure(nil)
assert(not player.gui.top.surfexp_discord_button, "clearing the invite removes the button")
assert(not player.gui.screen.surfexp_discord_frame, "clearing the invite closes an open window")
print("PASS the Discord button appears only with an invite, shows a copyable read-only link, and joining players get the link in chat")
