-- Commands: /test-clear and /test-run — the in-game gallery test runner pair (owner design,
-- 2026-07-18). Test cells are discovered by STRUCTURE (the name rendering-text + the status trio
-- at the derived origin — no registry).
--
--   /test-clear [name-filter]  RESET every cell: sweep the right-half compare area (the full paste
--                              footprint), status trio to WAITING (clock icon), failure template
--                              restored, name text blue. No copy/paste/audit.
--   /test-run   [name-filter]  The SAME reset first (structural fresh-run guarantee), then run each
--                              test: selection-lab COPY of the left-half fixture -> PASTE onto the
--                              right half (+14,0) -> AUDIT both halves with the real gate meters.
--                              Equal readings = green check; any delta or paste refusal = red X with
--                              the icon-rich delta, which also lands in the status panel's
--                              {failure-message} slot. Name color mirrors state.
--
-- Companion Node driver for batch runners: tests/lab-gallery/test-status.mjs (same trio semantics —
-- keep them in lockstep). Debug instrument (gated on debug_mode); measurement rides the
-- selection_lab_drive remote so it is byte-identical to the manual selection-tool workflow.

local Base = require("modules/surface_export/interfaces/commands/base")
local SelectionLab = require("modules/surface_export/interfaces/gui/selection-lab")
local Util = require("modules/surface_export/utils/util")

-- Cell geometry (mirrors tests/lab-gallery/test-foundation.mjs — the single template source):
-- 26x12 cell; name text at origin+(6,-1.5); trio on the bottom border at +(13.5|14.5|15.5, 11.5);
-- left fixture interior cols 1-12; right compare half cols 14-25 (interior 15-24).
local NAME_OFFSET_X, NAME_OFFSET_Y = 6, -1.5
local TRIO_Y = 11.5
local COLORS = {
  waiting = { r = 0.3, g = 0.85, b = 1, a = 1 },
  pass = { r = 0.3, g = 1, b = 0.3, a = 1 },
  fail = { r = 1, g = 0.3, b = 0.3, a = 1 },
}
local CHAT_GREEN = { r = 0.3, g = 1, b = 0.3 }
local CHAT_RED = { r = 1, g = 0.4, b = 0.4 }
local FAILURE_TEMPLATE = "Failure {failure-message}"
local RUN_PREFIX = "[color=yellow][font=default-bold][test-run][/font][/color]"
local CLEAR_PREFIX = "[color=yellow][font=default-bold][test-clear][/font][/color]"
local CHECK = "[virtual-signal=signal-check]"
local CROSS = "[virtual-signal=signal-deny]"

local function find_trio(surface, ox, oy)
  local function at(name, x)
    return surface.find_entities_filtered({ name = name,
      area = { { ox + x - 0.6, oy + TRIO_Y - 0.6 }, { ox + x + 0.6, oy + TRIO_Y + 0.6 } } })[1]
  end
  return at("constant-combinator", 14.5), at("display-panel", 15.5)
end

local function set_status(text_obj, comb, panel, status, failure_message)
  local cb = comb.get_or_create_control_behavior()
  local s1, s2 = cb.get_section(1), cb.get_section(2)
  if not (s1 and s2) then error("status combinator lacks its two sections") end
  s1.active = (status == "pass")
  s2.active = (status == "fail")
  local pcb = panel.get_or_create_control_behavior()
  local msgs = pcb.messages
  for _, m in ipairs(msgs) do
    if m.text and m.text:find("Failure", 1, true) == 1 then
      m.text = (status == "fail") and ("Failure " .. (failure_message or "?")) or FAILURE_TEMPLATE
    end
  end
  pcb.messages = msgs
  text_obj.color = COLORS[status]
end

--- The ONE reset both commands share: sweep the FULL paste footprint (the +14 offset from a left
--- rect reaching col 13 can land entities up to ox+27.5 — the old ox+26 edge missed the right-most
--- pasteable half-tile), never the trio row (y +11.5), then show WAITING.
local function reset_cell(surface, cell)
  local comb, panel = find_trio(surface, cell.ox, cell.oy)
  if not (comb and panel) then error("status trio missing at origin (" .. cell.ox .. "," .. cell.oy .. ")") end
  local cleared = 0
  for _, e in ipairs(surface.find_entities_filtered({ area = { { cell.ox + 14, cell.oy }, { cell.ox + 27.5, cell.oy + 11 } } })) do
    e.destroy()
    cleared = cleared + 1
  end
  set_status(cell.text_obj, comb, panel, "waiting")
  return cleared, comb, panel
end

--- Compare two audit reports. Returns nil on match, else an icon-rich delta (renders in chat AND
--- in the status panel's {failure-message} slot).
local function report_delta(left, right)
  if left.entity_count ~= right.entity_count then
    return string.format("entities %d vs %d", left.entity_count, right.entity_count)
  end
  local parts = {}
  local function item_tag(key)
    local name, quality = Util.parse_quality_key(key)
    if quality and quality ~= "normal" then return string.format("[img=item.%s][img=quality.%s]", name, quality) end
    return string.format("[img=item.%s]", name)
  end
  local function diff(kind, a, b)
    local seen = {}
    for name, count in pairs(a or {}) do
      seen[name] = true
      local other = (b or {})[name] or 0
      if math.abs(count - other) > 1e-6 then
        local tag = (kind == "item") and item_tag(name) or string.format("[img=fluid.%s]", name:match("^([^@]+)") or name)
        parts[#parts + 1] = string.format("%s %s->%s", tag, count, other)
      end
    end
    for name, count in pairs(b or {}) do
      if not seen[name] and math.abs(count) > 1e-6 then
        local tag = (kind == "item") and item_tag(name) or string.format("[img=fluid.%s]", name:match("^([^@]+)") or name)
        parts[#parts + 1] = string.format("%s 0->%s", tag, count)
      end
    end
  end
  diff("item", left.items, right.items)
  diff("fluid", left.fluids, right.fluids)
  if #parts == 0 and math.abs((left.fluid_total or 0) - (right.fluid_total or 0)) > 1e-6 then
    parts[#parts + 1] = string.format("fluid_total %s->%s", left.fluid_total, right.fluid_total)
  end
  if #parts == 0 then return nil end
  return table.concat(parts, "; ", 1, math.min(#parts, 4))
end

local function run_one(player, surface, cell)
  local _, comb, panel = reset_cell(surface, cell)

  local drive = function(mode, x1, y1, x2, y2)
    return remote.call("surface_export", "selection_lab_drive", mode, player.index, x1, y1, x2, y2)
  end
  local ox, oy = cell.ox, cell.oy
  local copy = drive("copy", ox + 1, oy, ox + 13, oy + 12)
  if not (copy and copy.ok) then
    set_status(cell.text_obj, comb, panel, "fail", "copy failed")
    return "fail", "copy failed"
  end
  local paste = drive("paste", ox + 15, oy, ox + 27, oy + 12)
  local paste_report = paste and paste.report or {}
  if not (paste and paste.ok) or paste_report.outcome ~= "pasted" then
    local why = string.format("paste %s (%d conflicts)",
      tostring(paste_report.outcome or "error"), tonumber(paste_report.conflicts) or 0)
    set_status(cell.text_obj, comb, panel, "fail", why)
    return "fail", why
  end
  -- Audit windows stop at oy+11: the BORDER row (+11..+12) carries the status trio, and the status
  -- panel at +15.5 sits inside a naive +15..+27 right window — the meter then counts its own
  -- display and every test fails "entities N vs N+1" (measured on the first live run).
  local left = drive("audit", ox + 1, oy, ox + 13, oy + 11)
  local right = drive("audit", ox + 15, oy, ox + 27, oy + 11)
  if not (left and left.ok and left.report and right and right.ok and right.report) then
    set_status(cell.text_obj, comb, panel, "fail", "audit failed")
    return "fail", "audit failed"
  end

  local delta = report_delta(left.report, right.report)
  if delta then
    set_status(cell.text_obj, comb, panel, "fail", delta)
    return "fail", delta
  end
  set_status(cell.text_obj, comb, panel, "pass")
  return "pass"
end

--- Structure-discovery shared by both commands.
local function discover_cells(surface, filter)
  local cells = {}
  for _, o in pairs(rendering.get_all_objects()) do
    if o.valid and o.type == "text" and o.surface and o.surface.index == surface.index then
      local t = o.target and o.target.position
      local name = tostring(o.text)
      if t and (not filter or name:find(filter, 1, true)) then
        local ox, oy = t.x - NAME_OFFSET_X, t.y - NAME_OFFSET_Y
        if ox == math.floor(ox) and oy == math.floor(oy) then
          local comb, panel = find_trio(surface, ox, oy)
          if comb and panel then cells[#cells + 1] = { name = name, text_obj = o, ox = ox, oy = oy } end
        end
      end
    end
  end
  table.sort(cells, function(a, b) return a.name < b.name end)
  return cells
end

local function command_context(cmd, ctx)
  if not (storage.surface_export_config and storage.surface_export_config.debug_mode) then
    ctx.print("Error: this is a debug instrument (enable debug_mode)")
    return nil
  end
  local player = ctx.player or game.connected_players[1]
  if not player then
    ctx.print("Error: needs a connected player (the selection lab is player-scoped)")
    return nil
  end
  local filter = cmd.parameter and cmd.parameter:gsub("%s+", "") or nil
  if filter == "" then filter = nil end
  local cells = discover_cells(player.surface, filter)
  return player, player.surface, cells, filter
end

Base.admin_command("test-clear",
  "Reset every gallery test cell on this surface (right-half sweep + waiting status). Usage: /test-clear [name-filter]",
  function(cmd, ctx)
    local player, surface, cells, filter = command_context(cmd, ctx)
    if not player then return end
    if #cells == 0 then
      ctx.print(CLEAR_PREFIX .. " no test cells found on " .. surface.name .. (filter and (" matching '" .. filter .. "'") or ""))
      return
    end
    for _, cell in ipairs(cells) do
      local ok, cleared_or_err = pcall(reset_cell, surface, cell)
      if ok then
        ctx.print(string.format("%s %s: reset (%d entities swept)", CLEAR_PREFIX, cell.name, cleared_or_err))
      else
        ctx.print(string.format("%s %s: FAILED to reset — %s", CLEAR_PREFIX, cell.name, tostring(cleared_or_err)))
        log("[test-clear] " .. cell.name .. " reset failed: " .. tostring(cleared_or_err))
      end
    end
    ctx.print(string.format("%s %d cell(s) reset on %s", CLEAR_PREFIX, #cells, surface.name))
  end
)

Base.admin_command("test-run",
  "Reset + run every gallery test cell fresh (copy -> paste -> audit compare). Usage: /test-run [name-filter]",
  function(cmd, ctx)
    local player, surface, cells, filter = command_context(cmd, ctx)
    if not player then return end
    if #cells == 0 then
      ctx.print(RUN_PREFIX .. " no test cells found on " .. surface.name .. (filter and (" matching '" .. filter .. "'") or ""))
      return
    end
    local passed, failed = 0, 0
    for _, cell in ipairs(cells) do
      -- QUIET: suppress the lab's per-action chat narration for the whole run (typed returns +
      -- [MODE-JSON] log lines keep the evidence); restored unconditionally after the pcall.
      SelectionLab.set_quiet(true)
      local ok, verdict_or_err, detail = pcall(run_one, player, surface, cell)
      SelectionLab.set_quiet(false)
      if not ok then
        failed = failed + 1
        log("[test-run] " .. cell.name .. " CRASHED: " .. tostring(verdict_or_err))
        ctx.print(string.format("%s %s: %s runner error: %s", RUN_PREFIX, cell.name, CROSS, tostring(verdict_or_err)), CHAT_RED)
        local comb, panel = find_trio(surface, cell.ox, cell.oy)
        if comb and panel then
          -- intentional probe; status display is best-effort after a runner crash, error already surfaced above
          pcall(set_status, cell.text_obj, comb, panel, "fail", "runner error")
        end
      elseif verdict_or_err == "pass" then
        passed = passed + 1
        ctx.print(string.format("%s %s: %s", RUN_PREFIX, cell.name, CHECK), CHAT_GREEN)
      elseif verdict_or_err == "fail" then
        failed = failed + 1
        ctx.print(string.format("%s %s: %s %s", RUN_PREFIX, cell.name, CROSS, tostring(detail)), CHAT_RED)
      end
    end
    ctx.print(string.format("%s %d/%d passed on %s", RUN_PREFIX, passed, passed + failed, surface.name),
      failed == 0 and CHAT_GREEN or CHAT_RED)
  end
)

return true
