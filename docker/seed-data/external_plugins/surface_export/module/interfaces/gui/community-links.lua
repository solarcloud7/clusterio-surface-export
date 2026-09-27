local CommunityLinks = {}

local BUTTON = "surfexp_discord_button"
local FRAME = "surfexp_discord_frame"
local LINK = "surfexp_discord_link"
local CLOSE = "surfexp_discord_close"
local SPRITE = "virtual-signal/signal-info"

local function invite()
	local community = storage.surface_export_community
	local link = community and community.discord_invite
	return type(link) == "string" and link ~= "" and link or nil
end

function CommunityLinks.close(player)
	local frame = player.gui.screen[FRAME]
	if frame then frame.destroy() end
end

function CommunityLinks.open(player)
	local link = invite()
	if not link then return end
	CommunityLinks.close(player)
	local frame = player.gui.screen.add{type = "frame", name = FRAME, caption = "Join us on Discord", direction = "vertical"}
	frame.auto_center = true
	frame.add{type = "label", caption = "Select the link, press Ctrl+C and open it in your browser."}
	local box = frame.add{type = "text-box", name = LINK, text = link}
	box.read_only = true
	box.style.width = 360
	box.style.height = 32
	local buttons = frame.add{type = "flow", direction = "horizontal"}
	buttons.add{type = "empty-widget"}.style.horizontally_stretchable = true
	buttons.add{type = "button", name = CLOSE, caption = "Close"}
	player.opened = frame
	box.focus()
	box.select_all()
end

function CommunityLinks.refresh(player)
	if not (player and player.valid) then return end
	local button = player.gui.top[BUTTON]
	local link = invite()
	if not link then
		if button then button.destroy() end
		CommunityLinks.close(player)
		return
	end
	if not button then
		player.gui.top.add{type = "sprite-button", name = BUTTON, style = "mod_gui_button", sprite = SPRITE,
			tooltip = "Discord: copy the invite link."}
	end
	local frame = player.gui.screen[FRAME]
	local box = frame and frame[LINK]
	if box and box.text ~= link then
		box.text = link
		box.select_all()
	end
end

function CommunityLinks.configure(discord_invite)
	local link = type(discord_invite) == "string" and discord_invite:match("^%s*(.-)%s*$") or ""
	storage.surface_export_community = {discord_invite = link}
	for _, player in pairs(game.connected_players) do CommunityLinks.refresh(player) end
	return {success = true, discord_invite = link}
end

function CommunityLinks.on_join(player)
	CommunityLinks.refresh(player)
	local link = invite()
	if link then player.print({"", "Join us on Discord: ", link, " (Discord button, top left, to copy it)"}) end
end

function CommunityLinks.on_gui_click(event)
	local element = event.element
	if not (element and element.valid) then return end
	local player = game.get_player(event.player_index)
	if not player then return end
	if element.name == BUTTON then
		if player.gui.screen[FRAME] then CommunityLinks.close(player) else CommunityLinks.open(player) end
	elseif element.name == CLOSE then
		CommunityLinks.close(player)
	end
end

function CommunityLinks.on_gui_closed(event)
	local element = event.element
	if element and element.valid and element.name == FRAME then
		local player = game.get_player(event.player_index)
		if player then CommunityLinks.close(player) end
	end
end

return CommunityLinks
