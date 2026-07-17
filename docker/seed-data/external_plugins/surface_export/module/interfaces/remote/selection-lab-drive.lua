-- FactorioSurfaceExport - Selection-lab drive (remote, debug-gated self-test seam)
-- The engine refuses script.raise_event for the on_player_*_selected_area events, so headless
-- tests could not exercise the selection-lab handlers and every tool regression had to be found
-- by a human dragging in game. This remote builds the same event table the engine delivers and
-- calls the REAL handler — the tool's actual code path, no duplication.
-- Modes: 'copy' | 'paste' | 'audit' | 'force' (area required) and 'undo' | 'redo' (area ignored).

local SelectionLab = require("modules/surface_export/interfaces/gui/selection-lab")

--- Drive a selection-lab action headlessly.
--- @param mode string: copy|paste|audit|force|undo|redo
--- @param player_index number|nil: defaults to 1
--- @param x1 number|nil @param y1 number|nil @param x2 number|nil @param y2 number|nil: selection area
--- @return table: { ok, n = entity count in area (selection modes) } or { ok = false, err }
local function selection_lab_drive(mode, player_index, x1, y1, x2, y2)
  if not (storage.surface_export_config and storage.surface_export_config.debug_mode) then
    return { ok = false, err = "debug_mode off" }
  end
  local player = game.get_player(player_index or 1)
  if not player then return { ok = false, err = "no such player" } end
  if mode == "undo" or mode == "redo" then
    SelectionLab[mode]({ player_index = player.index })
    return { ok = true }
  end
  if not (x1 and y1 and x2 and y2) then return { ok = false, err = "area required" } end
  local surface = player.surface
  local entities = surface.find_entities_filtered({ area = { { x1, y1 }, { x2, y2 } } })
  SelectionLab.handle({
    player_index = player.index, surface = surface,
    area = { left_top = { x = x1, y = y1 }, right_bottom = { x = x2, y = y2 } },
    item = "selection-lab-tool", entities = entities, tiles = {},
  }, mode)
  return { ok = true, n = #entities }
end

return selection_lab_drive
