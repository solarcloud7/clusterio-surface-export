-- Command: /run-tests
-- The in-game gallery test runner (owner-designed, 2026-07-18). For every test cell on the
-- invoker's surface (discovered from the name rendering-text + the status trio at the derived
-- origin — no registry): RESET the right-half compare area and the status trio to WAITING, then
-- run the test fresh: selection-lab COPY of the left-half fixture -> PASTE onto the right half
-- (+14,0) -> AUDIT both halves with the real gate meters -> equal readings = PASS, any delta or
-- paste refusal = FAIL with the delta in the status panel's {failure-message} slot. Name text
-- color mirrors the state: blue waiting, green pass, red fail. Companion Node driver for batch
-- runners: tests/lab-gallery/test-status.mjs (same trio semantics — keep them in lockstep).
--
-- Debug instrument (gated on debug_mode); runs through the selection_lab_drive remote so the
-- measurement path is byte-identical to the manual selection-tool workflow.

local Base = require("modules/surface_export/interfaces/commands/base")

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
local FAILURE_TEMPLATE = "Failure {failure-message}"

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

--- Compare two audit reports (entity/item/fluid maps). Returns nil on match, else a short delta text.
local function report_delta(left, right)
  if left.entity_count ~= right.entity_count then
    return string.format("entities %d vs %d", left.entity_count, right.entity_count)
  end
  local parts = {}
  local function diff(kind, a, b)
    local seen = {}
    for name, count in pairs(a or {}) do
      seen[name] = true
      local other = (b or {})[name] or 0
      if math.abs(count - other) > 1e-6 then parts[#parts + 1] = string.format("%s %s %s->%s", kind, name, count, other) end
    end
    for name, count in pairs(b or {}) do
      if not seen[name] and math.abs(count) > 1e-6 then parts[#parts + 1] = string.format("%s %s 0->%s", kind, name, count) end
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

local function run_one(player, surface, name, text_obj, ox, oy, ctx)
  local comb, panel = find_trio(surface, ox, oy)
  if not (comb and panel) then
    ctx.print(string.format("[run-tests] %s: SKIP (no status trio at origin %d,%d)", name, ox, oy))
    return "skip"
  end

  -- RESET: clear the right-half compare area (never the trio row) and show WAITING while running.
  local cleared = 0
  for _, e in ipairs(surface.find_entities_filtered({ area = { { ox + 14, oy }, { ox + 26, oy + 11 } } })) do
    e.destroy()
    cleared = cleared + 1
  end
  set_status(text_obj, comb, panel, "waiting")

  -- RUN: copy left fixture -> paste right (+14,0) -> audit both halves with the gate meters.
  local drive = function(mode, x1, y1, x2, y2)
    return remote.call("surface_export", "selection_lab_drive", mode, player.index, x1, y1, x2, y2)
  end
  local copy = drive("copy", ox + 1, oy, ox + 13, oy + 12)
  if not (copy and copy.ok) then
    set_status(text_obj, comb, panel, "fail", "copy failed")
    return "fail", "copy failed"
  end
  local paste = drive("paste", ox + 15, oy, ox + 27, oy + 12)
  local paste_report = paste and paste.report or {}
  if not (paste and paste.ok) or paste_report.outcome ~= "pasted" then
    local why = string.format("paste %s (%d conflicts)",
      tostring(paste_report.outcome or "error"), tonumber(paste_report.conflicts) or 0)
    set_status(text_obj, comb, panel, "fail", why)
    return "fail", why
  end
  local left = drive("audit", ox + 1, oy, ox + 13, oy + 12)
  local right = drive("audit", ox + 15, oy, ox + 27, oy + 12)
  if not (left and left.ok and left.report and right and right.ok and right.report) then
    set_status(text_obj, comb, panel, "fail", "audit failed")
    return "fail", "audit failed"
  end

  local delta = report_delta(left.report, right.report)
  if delta then
    set_status(text_obj, comb, panel, "fail", delta)
    return "fail", delta
  end
  set_status(text_obj, comb, panel, "pass")
  return "pass"
end

Base.admin_command("run-tests",
  "Reset every gallery test cell on this surface and run each fresh (copy -> paste -> audit compare). Usage: /run-tests [name-filter]",
  function(cmd, ctx)
    if not (storage.surface_export_config and storage.surface_export_config.debug_mode) then
      ctx.print("Error: /run-tests is a debug instrument (enable debug_mode)")
      return
    end
    local player = ctx.player or game.connected_players[1]
    if not player then
      ctx.print("Error: /run-tests needs a connected player (the selection lab is player-scoped)")
      return
    end
    local surface = player.surface
    local filter = cmd.parameter and cmd.parameter:gsub("%s+", "") or nil

    -- Discover test cells: name texts whose derived origin carries a status trio.
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
    if #cells == 0 then
      ctx.print("[run-tests] no test cells found on " .. surface.name .. (filter and (" matching '" .. filter .. "'") or ""))
      return
    end

    local passed, failed = 0, 0
    for _, cell in ipairs(cells) do
      local ok, verdict_or_err, detail = pcall(run_one, player, surface, cell.name, cell.text_obj, cell.ox, cell.oy, ctx)
      if not ok then
        failed = failed + 1
        log("[run-tests] " .. cell.name .. " CRASHED: " .. tostring(verdict_or_err))
        ctx.print(string.format("[run-tests] %s: FAIL (runner error: %s)", cell.name, tostring(verdict_or_err)))
        local comb, panel = find_trio(surface, cell.ox, cell.oy)
        if comb and panel then
          -- intentional probe; status display is best-effort after a runner crash, error already surfaced above
          pcall(set_status, cell.text_obj, comb, panel, "fail", "runner error")
        end
      elseif verdict_or_err == "pass" then
        passed = passed + 1
        ctx.print(string.format("[run-tests] %s: PASS", cell.name))
      elseif verdict_or_err == "fail" then
        failed = failed + 1
        ctx.print(string.format("[run-tests] %s: FAIL — %s", cell.name, tostring(detail)))
      end
    end
    ctx.print(string.format("[run-tests] %d/%d passed on %s", passed, passed + failed, surface.name))
  end
)

return true
