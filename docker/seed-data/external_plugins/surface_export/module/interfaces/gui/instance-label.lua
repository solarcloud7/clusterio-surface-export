local Label = {}
local NAME = "surfexp_instance_name"
local WIDTH = 320
local RIGHT_COLUMN = 256
local GAP = 8
local TOP = 8

function Label.refresh_position(player)
	local label = player.gui.screen[NAME]
	if not label then return end
	local scale = player.display_scale
	local x = math.floor(math.max(0, player.display_resolution.width - (RIGHT_COLUMN + GAP + WIDTH) * scale) + 0.5)
	local y = math.floor(TOP * scale + 0.5)
	local location = label.location
	if location and location.x == x and location.y == y then return end
	label.location = {x, y}
end

function Label.refresh(player)
	local policy = storage.surface_export_planet_policy
	local label = player.gui.screen[NAME]
	if not policy then
		if label then label.destroy() end
		return
	end
	if not label then
		label = player.gui.screen.add{type = "label", name = NAME, caption = policy.instance_name, ignored_by_interaction = true}
		label.style.font = "default-large-bold"
		label.style.font_color = {1, 1, 1}
		label.style.width = WIDTH
		label.style.horizontal_align = "right"
		label.style.single_line = true
	elseif label.caption ~= policy.instance_name then
		label.caption = policy.instance_name
	end
	Label.refresh_position(player)
end

return Label
