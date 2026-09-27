local CommunityLinks = require("modules/surface_export/interfaces/gui/community-links")

local function configure_community(discord_invite)
	return CommunityLinks.configure(discord_invite)
end

return configure_community
