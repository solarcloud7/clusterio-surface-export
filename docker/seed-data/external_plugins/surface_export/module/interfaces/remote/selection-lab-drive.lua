-- FactorioSurfaceExport - Selection-lab drive (remote, debug-gated self-test seam)
-- The engine refuses script.raise_event for the on_player_*_selected_area events, so headless
-- tests could not exercise the selection-lab handlers and every tool regression had to be found
-- by a human dragging in game. This remote builds the same event table the engine delivers and
-- calls the REAL handler — the tool's actual code path, no duplication.
-- Modes: 'copy' | 'paste' | 'audit' | 'preview' | 'force' (area required) and 'undo' | 'redo'
-- (area ignored). 'preview' is the dry-run paste: renders green/red placement boxes, creates
-- nothing, and returns the same planner verdict the real paste would act on.

local SelectionLab = require("modules/surface_export/interfaces/gui/selection-lab")

--- Drive a selection-lab action headlessly.
--- @param mode string: copy|paste|audit|force|undo|redo
--- @param player_index number|nil: defaults to 1; a reserved key (e.g. 0) with no live player drives
---        the tool player-less for the headless /test-run — the SelectionLab handlers nil-guard every
---        player deref on the copy/paste/audit path and operate on `surface` below, not player.surface.
--- @param x1 number|nil @param y1 number|nil @param x2 number|nil @param y2 number|nil: selection area
--- @param surface_name string|nil: explicit surface to drive on. When given it is authoritative (the
---        headless runner passes the fixture's platform surface); when omitted the live player's
---        surface is used (back-compat for the 6-arg selftest callers).
--- @return table: { ok, n = entity count in area (selection modes) } or { ok = false, err }
local function selection_lab_drive(mode, player_index, x1, y1, x2, y2, surface_name)
  if not (storage.surface_export_config and storage.surface_export_config.debug_mode) then
    return { ok = false, err = "debug_mode off" }
  end
  -- A reserved headless key (0, or any non-positive) has no live player — game.get_player rejects
  -- indices < 1, so never call it for the reserved key; player stays nil and the surface_name path runs.
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
  -- The event's player_index rides through to pstate() and every handler; a reserved headless key
  -- (0 when no live player) gets its own capture/undo slot, never colliding with a real player.
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
  -- Every selection mode returns its typed report table (copy/paste/audit/preview/force) so a
  -- headless driver reads the meters and outcomes directly; a nil report can only mean an
  -- unknown mode (logged by handle).
  return { ok = true, n = #entities, report = result }
end

return selection_lab_drive
