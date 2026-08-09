local SelectionLab = require("modules/surface_export/interfaces/gui/selection-lab")

local function selection_lab_drive(mode, player_index, x1, y1, x2, y2, surface_name)
  if not (storage.surface_export_config and storage.surface_export_config.debug_mode) then
    return { ok = false, err = "debug_mode off" }
  end
  local player = (player_index and player_index >= 1) and game.get_player(player_index) or nil
  local surface
  if surface_name then
    surface = game.surfaces[surface_name]
    if not surface then return { ok = false, err = "no such surface: " .. tostring(surface_name) } end
  elseif player then
    surface = player.surface
  else
    return { ok = false, err = "no such player" }
  end
  local effective_index = (player and player.index) or player_index or 0
  if mode == "undo" or mode == "redo" then
    SelectionLab[mode]({ player_index = effective_index })
    return { ok = true }
  end
  if not (x1 and y1 and x2 and y2) then return { ok = false, err = "area required" } end
  local entities = surface.find_entities_filtered({ area = { { x1, y1 }, { x2, y2 } } })
  local result = SelectionLab.handle({
    player_index = effective_index, surface = surface,
    area = { left_top = { x = x1, y = y1 }, right_bottom = { x = x2, y = y2 } },
    item = "selection-lab-tool", entities = entities, tiles = {},
  }, mode)
  return { ok = true, n = #entities, report = result }
end

return selection_lab_drive
