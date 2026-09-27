local CommunityLinks = {}

local RETIRED = {top = "surfexp_discord_button", screen = "surfexp_discord_frame"}

local function invite()
	local community = storage.surface_export_community
	local link = community and community.discord_invite
	return type(link) == "string" and link ~= "" and link or nil
end

function CommunityLinks.refresh(player)
	if not (player and player.valid) then return end
	for root, name in pairs(RETIRED) do
		local element = player.gui[root][name]
		if element then element.destroy() end
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
	if link then player.print({"", "Join us on Discord: ", link}) end
end

return CommunityLinks
