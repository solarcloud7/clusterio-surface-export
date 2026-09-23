local Controls = {}
local BUTTON = "surfexp_selection_lab"
local TOOL = "selection-lab-tool"

local function enabled()
	return storage.surface_export_configuration_received == true
		and storage.surface_export_config and storage.surface_export_config.debug_mode == true
end

function Controls.refresh(player)
	if prototypes.shortcut[TOOL] then player.set_shortcut_available(TOOL, false) end
	local button = player.gui.top[BUTTON]
	if enabled() and prototypes.item[TOOL] then
		if not button then
			player.gui.top.add{type = "sprite-button", name = BUTTON, sprite = "item/" .. TOOL, style = "mod_gui_button",
				tooltip = "Selection Lab: select a factory area with the debug copy, paste and audit tool."}
		end
	elseif button then button.destroy() end
end

function Controls.on_gui_click(event)
	local element = event.element
	if not (element and element.valid and element.name == BUTTON) then return end
	local player = game.get_player(event.player_index)
	if not player then return end
	if not enabled() then Controls.refresh(player); return end
	if prototypes.item[TOOL] and player.cursor_stack and player.cursor_stack.valid and player.clear_cursor() then
		local cursor = player.cursor_stack
		if cursor and cursor.valid then cursor.set_stack{name = TOOL} end
	end
end

return Controls
