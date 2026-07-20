-- Commands: /test-clear and /test-run — the in-game gallery test runner pair (owner design,
-- 2026-07-18/19). Test cells are discovered by STRUCTURE (the name rendering-text + the status trio
-- at the derived origin — no registry), and RECONCILED against the pushed manifest roster: a rostered
-- fixture with no live pad/platform is a FAILURE (MISSING), never silence (owner trust requirement —
-- "do I know what tests are actually in play?").
--
--   /test-clear [name-filter]  RESET every cell: sweep the right-half compare area (the full paste
--                              footprint), status trio to WAITING (clock icon), failure template
--                              restored, name text blue. No copy/paste/audit.
--   /test-run   [name-filter]  For each roster fixture: fingerprint the baked state with the shared
--                              FixtureMeters, run its pad-kind check (pad = reset -> copy left ->
--                              paste +14 -> audit both halves -> re-fingerprint the paste; platform/
--                              surface = resolve by name + meter + fingerprint), and reconcile BOTH
--                              ways (rostered fixture with no cell = MISSING red; discovered cell with
--                              no roster id = UNKNOWN PAD yellow). A nil roster is a RED failing run.
--                              Runs headless over RCON (no player) or in-game.
--
-- Debug instrument (gated on debug_mode); pad measurement rides the selection_lab_drive remote so it
-- is byte-identical to the manual selection-tool workflow. Machine-readable evidence is ONE
-- [TESTRUN-JSON] line (log() always; rcon.print when no player drove it). Chat lines are plain
-- concatenated strings (Pitfall #25, LocalisedString 20-param cap — never a big LocalisedString).

local Base = require("modules/surface_export/interfaces/commands/base")
local SelectionLab = require("modules/surface_export/interfaces/gui/selection-lab")
local Util = require("modules/surface_export/utils/util")
local FixtureMeters = require("modules/surface_export/utils/fixture-meters")
local LifecycleEngine = require("modules/surface_export/utils/lifecycle-engine")

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
local CHAT_YELLOW = { r = 1, g = 0.8, b = 0.3 }
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

--- Aggregate audit for LIVE steady-state fixtures (fixture.auditAggregateOnly): a saturated belt
--- loop rotates its item MIX between the copy tick and the audit tick, so a per-name compare
--- false-fails on a physically perfect paste. The class law is the conserved TOTAL (the
--- steady-state fixture class definition); per-name fidelity for frozen fixtures keeps the strict
--- report_delta above.
local function report_delta_aggregate(left, right)
  if left.entity_count ~= right.entity_count then
    return string.format("entities %d vs %d", left.entity_count, right.entity_count)
  end
  local function total(t)
    local s = 0
    for _, c in pairs(t or {}) do s = s + c end
    return s
  end
  local li, ri = total(left.items), total(right.items)
  if li ~= ri then return string.format("item total %s vs %s", li, ri) end
  local lf, rf = total(left.fluids), total(right.fluids)
  if math.abs(lf - rf) > 1e-6 then return string.format("fluid total %s vs %s", lf, rf) end
  return nil
end

-- === fingerprint dispatch =====================================================================
--
-- Locators are code; expected values are the roster fingerprint (single source of truth). Every
-- meter is the SHARED FixtureMeters implementation the seed-prep bake and corpus gate use, so a
-- /test-run fingerprint reads the exact fields the bake certified. args:
--   "anchor"   pad meter (surface, anchor_fn) — anchor_fn from anchor_lookup(roster, id, dx)
--   "area"     pad meter (surface, area_rect) — area-scoped so a pasted right half is not double-counted
--   "surface"  platform/surface meter (surface)
--   "platform" platform meter (platform object)
--   "none"     platform meter () — resolves its own platforms by name (hold pairs)
local FM = FixtureMeters
local function meter_entities(surface) return { entities = #surface.find_entities_filtered({}) } end
local function meter_heat(surface, anchor)
  return { temperature = FM.anchored(surface, anchor, "heat-pipe", "omnibus heat").temperature }
end

local DISPATCH = {
  -- omnibus pads (copy/paste-audited), anchor-scoped fingerprints
  ["omnibus-adversarial-inventory"] = { args = "anchor", meter = FM.measure_omnibus_adversarial },
  ["omnibus-heat-temperature"]      = { args = "anchor", meter = meter_heat },
  ["omnibus-decider-latch"]         = { args = "anchor", meter = FM.measure_omnibus_latch },
  ["omnibus-midcraft-progress"]     = { args = "anchor", meter = FM.measure_omnibus_midcraft },
  ["omnibus-burner-fuel"]           = { args = "anchor", meter = FM.measure_omnibus_burner },
  ["omnibus-equipment-grid"]        = { args = "anchor", meter = FM.measure_omnibus_equipment },
  ["omnibus-circuit-config"]        = { args = "anchor", meter = FM.measure_omnibus_circuit },
  ["omnibus-module-bonus-progress"] = { args = "anchor", meter = FM.measure_omnibus_bonus },
  ["omnibus-crafting-fluids"]       = { args = "anchor", meter = FM.measure_omnibus_fluids },
  ["inserter-held-capacity"]        = { args = "anchor", meter = FM.measure_inserter_held },
  ["no-tick-sync-frozen-pair"]      = { args = "anchor", meter = FM.measure_no_tick_pair },
  ["repin-beacon-speed"]            = { args = "anchor", meter = FM.measure_repin_beacon },
  -- transfer-act lifecycle fixture: locally /test-run validates the LEFT fingerprint then reports
  -- "skipped (transfer act)"; the pad-transfer-suite (P5) owns the act + verify end of it.
  ["omnibus-spoilage-midspoil"]     = { args = "anchor", meter = FM.measure_omnibus_spoilage },
  -- protocol-teeth pads (transfer-act; local /test-run pins the LEFT fingerprint then skips)
  ["gate-item-loss"]                = { args = "anchor", meter = function(s, a) return FM.measure_scratch_anchor(s, a, "steel-chest") end },
  ["gate-fluid-loss"]               = { args = "anchor", meter = function(s, a) return FM.measure_scratch_anchor(s, a, "storage-tank") end },
  ["rollback-validation-failure"]   = { args = "anchor", meter = function(s, a) return FM.measure_scratch_anchor(s, a, "steel-chest") end },
  ["failed-entity-attribution"]     = { args = "anchor", meter = function(s, a) return FM.measure_scratch_anchor(s, a, "steel-chest") end },
  ["force-bonus-held"]              = { args = "anchor", meter = function(s, a) return FM.measure_scratch_anchor(s, a, "bulk-inserter") end },
  -- owner-hand-built pads (previously "skipped: no meter")
  ["belt-combined-omnibus"]         = { args = "area", meter = FM.measure_belt_combined },
  ["mining-drill-acid-feed"]        = { args = "both", meter = FM.measure_mining_drill_acid },
  -- omnibus pads, area-scoped fingerprints (whole-half scans)
  ["omnibus-ghosts-and-proxies"]    = { args = "area", meter = FM.measure_omnibus_ghosts },
  ["omnibus-ground-items"]          = { args = "area", meter = FM.measure_omnibus_ground },
  -- platform-kind fixtures (no copy/paste; resolve by platformName)
  ["omnibus-platform-schedule"]     = { args = "platform", meter = FM.measure_omnibus_schedule },
  ["energy-accumulator-drain"]      = { args = "surface", meter = FM.measure_energy },
  ["belt-corner-recovery"]          = { args = "surface", meter = FM.measure_belt_corner },
  ["transfer-workhorse"]            = { args = "surface", meter = meter_entities },
  ["census-fusion-shared-plasma"]   = { args = "surface", meter = FM.measure_census_fusion },
  ["consumable-hub-1"]              = { args = "surface", meter = meter_entities },
  ["consumable-hub-2"]              = { args = "surface", meter = meter_entities },
  ["consumable-hub-3"]              = { args = "surface", meter = meter_entities },
  ["hold-buffer-spoil"]             = { args = "none", meter = FM.measure_hold_spoil_pair },
  ["hold-buffer-damage"]            = { args = "none", meter = FM.measure_hold_damage_pair },
  ["hold-buffer-pod"]               = { args = "none", meter = FM.measure_hold_pod_pair },
  -- belt-5x5-125-unstacked: no meter here yet (Lane B adds measure_belt_loop) -> SKIPPED (no meter)
  -- specialized-fluid-reachability: roster marks runnerExcluded (mutating write-probe) -> SKIPPED
}

--- Compare a measured reading table against a roster fingerprint. Returns nil on match, else the
--- first drifted "key=got exp want" (approx_equal applies the bake's ULP tolerance to the double
--- fields only). Missing dispatch fields fail loudly (nil ~= expected).
local function compare_fingerprint(reads, fingerprint, exclude)
  for key, expected in pairs(fingerprint or {}) do
    if not (exclude and exclude[key]) and not FM.approx_equal(key, reads and reads[key], expected) then
      return string.format("%s=%s exp %s", key, tostring(reads and reads[key]), tostring(expected))
    end
  end
  return nil
end

-- === pad reconcile (reset -> left fingerprint -> copy/paste/audit -> paste fingerprint) ========

--- Read a pad fixture's fingerprint on one half. dx/rect select the half: left = (dx 0, left rect),
--- paste = (dx 14, right rect). Anchor meters ignore rect; area meters ignore dx.
local function pad_reading(surface, cell, fixture, dispatch, roster, dx, rect)
  if dispatch.args == "area" then
    return dispatch.meter(surface, rect)
  elseif dispatch.args == "both" then
    return dispatch.meter(surface, rect, FM.anchor_lookup(roster, fixture.id, dx))
  end
  return dispatch.meter(surface, FM.anchor_lookup(roster, fixture.id, dx))
end

--- The post-setup body of a pad run: LEFT fingerprint -> act -> (paste fingerprint) -> declared
--- verify. Returns "pass"|"fail"|"skipped", detail; set_status is applied here on every terminal
--- path. run_pad wraps this in a pcall so lifecycle cleanup ALWAYS runs afterwards.
local function run_pad_body(player, surface, cell, fixture, dispatch, roster, ctx, comb, panel)
  local has_lc = fixture.lifecycle ~= nil

  -- (a) LEFT fingerprint: the pristine baked source (unaffected by the paste, which lands right).
  local ok_l, left_reads = pcall(pad_reading, surface, cell, fixture, dispatch, roster, 0,
    { { cell.ox + 1, cell.oy }, { cell.ox + 13, cell.oy + 11 } })
  if not ok_l then
    set_status(cell.text_obj, comb, panel, "fail", "left meter error")
    return "fail", "left meter error: " .. tostring(left_reads)
  end
  local left_drift = compare_fingerprint(left_reads, fixture.fingerprint)
  if left_drift then
    set_status(cell.text_obj, comb, panel, "fail", "left " .. left_drift)
    return "fail", "left " .. left_drift
  end

  -- act dispatch. The default copy-paste act keeps the historical copy/paste/audit + paste
  -- fingerprint block verbatim (verify then reads the pasted +14 half); a transfer/clone act is
  -- owned by the pad-transfer-suite and skipped in-game; an op-list act runs via the engine in place
  -- (verify then reads the mutated left half).
  local act = (has_lc and fixture.lifecycle.act) or "copy-paste"
  local verify_dx = 0
  if has_lc and (act == "transfer" or act == "clone") then
    return "skipped", "transfer act (pad-transfer-suite)"
  elseif has_lc and type(act) == "table" then
    local ok_a, act_err = LifecycleEngine.run_act(surface, fixture, ctx)
    if not ok_a then
      set_status(cell.text_obj, comb, panel, "fail", "act error")
      return "fail", tostring(act_err)
    end
  else
  -- (b) the existing reset->copy->paste->audit compare (entity/item/fluid counts), unchanged.
  local player_index = (player and player.index) or 0
  local drive = function(mode, x1, y1, x2, y2)
    return remote.call("surface_export", "selection_lab_drive", mode, player_index, x1, y1, x2, y2, surface.name)
  end
  local ox, oy = cell.ox, cell.oy
  local copy = drive("copy", ox + 1, oy, ox + 13, oy + 12)
  local copy_report = copy and copy.report or {}
  -- Outcome check, not just ok: a "nothing_exportable" copy still returns ok, and pasting then
  -- uses the PREVIOUS cell's clipboard (measured: the ground-items cell pasted a stale anchor).
  if not (copy and copy.ok) or copy_report.outcome ~= "copied" then
    local why = "copy " .. tostring(copy_report.outcome or (copy and copy.err) or "error")
    set_status(cell.text_obj, comb, panel, "fail", why)
    return "fail", why
  end
  local paste = drive("paste", ox + 15, oy, ox + 27, oy + 12)
  local paste_report = paste and paste.report or {}
  if not (paste and paste.ok) or paste_report.outcome ~= "pasted" then
    local detail = ""
    if type(paste_report.conflict_details) == "table" and #paste_report.conflict_details > 0 then
      detail = ": " .. table.concat(paste_report.conflict_details, "; ")
    elseif paste_report.error then
      detail = ": " .. tostring(paste_report.error)
    end
    local why = string.format("paste %s%s", tostring(paste_report.outcome or (paste and paste.err) or "error"), detail)
    set_status(cell.text_obj, comb, panel, "fail", why)
    return "fail", why
  end
  -- Audit windows stop at oy+11: the BORDER row carries the status trio; a naive +15..+27 right
  -- window would count the status panel and every test fails "entities N vs N+1".
  local left = drive("audit", ox + 1, oy, ox + 13, oy + 11)
  local right = drive("audit", ox + 15, oy, ox + 27, oy + 11)
  if not (left and left.ok and left.report and right and right.ok and right.report) then
    set_status(cell.text_obj, comb, panel, "fail", "audit failed")
    return "fail", "audit failed"
  end
  local delta = (fixture.auditAggregateOnly and report_delta_aggregate or report_delta)(left.report, right.report)
  if delta then
    set_status(cell.text_obj, comb, panel, "fail", delta)
    return "fail", delta
  end

  -- (c) PASTE fingerprint: the same meter over the pasted right half (anchor +14 / right rect). The
  -- new depth catches a paste that keeps entity/item COUNTS but drops progress/signal/held state.
  local ok_p, paste_reads = pcall(pad_reading, surface, cell, fixture, dispatch, roster, 14,
    { { cell.ox + 15, cell.oy }, { cell.ox + 27, cell.oy + 11 } })
  if not ok_p then
    set_status(cell.text_obj, comb, panel, "fail", "paste meter error")
    return "fail", "paste meter error: " .. tostring(paste_reads)
  end
  local paste_exclude = nil
  if fixture.pasteExclude then
    -- Fields the ENGINE cannot carry through a frozen paste (e.g. the decider output register is
    -- not script-writable — measured 2026-07-20). Declared per fixture, never a blanket skip.
    paste_exclude = {}
    for _, key in ipairs(fixture.pasteExclude) do paste_exclude[key] = true end
  end
  local paste_drift = compare_fingerprint(paste_reads, fixture.fingerprint, paste_exclude)
  if paste_drift then
    set_status(cell.text_obj, comb, panel, "fail", "paste " .. paste_drift)
    return "fail", "paste " .. paste_drift
  end
    verify_dx = 14
  end

  -- (d) declared verify (lifecycle only). Per-check summaries append into detail (clipped to 4 like
  -- report_delta); a failing check flips the verdict. No-lifecycle fixtures keep the old pass path
  -- (detail nil), so their verdicts are byte-identical to before this change.
  local detail = nil
  if has_lc then
    local result = LifecycleEngine.run_verify(surface, fixture, ctx, { dx = verify_dx })
    local parts = {}
    for _, c in ipairs(result.checks) do
      parts[#parts + 1] = c.name .. ":" .. c.verdict .. "(" .. tostring(c.detail) .. ")"
    end
    if #parts > 0 then detail = table.concat(parts, "; ", 1, math.min(#parts, 4)) end
    if result.verdict == "fail" then
      set_status(cell.text_obj, comb, panel, "fail", detail or "verify failed")
      return "fail", detail or "verify failed"
    end
  end

  set_status(cell.text_obj, comb, panel, "pass")
  return "pass", detail
end

--- Run one pad fixture. The measurement drives the REAL selection-lab handlers (copy/paste/audit)
--- via selection_lab_drive so it is byte-identical to the manual tool; the added fingerprint depth
--- (crafting_progress / signals / held / energy) is measured on the pristine LEFT half and again on
--- the pasted right half. A lifecycle block (if present) runs setup before, verify after, and its
--- cleanup ALWAYS afterwards (armed hooks disarmed, mutated force props restored). player may be nil
--- (headless). Returns "pass"|"fail"|"skipped", detail.
local function run_pad(player, surface, cell, fixture, dispatch, roster)
  local ctx = { armed_hooks = {}, restores = {}, captured = {} }
  local has_lc = fixture.lifecycle ~= nil
  local _, comb, panel = reset_cell(surface, cell)

  if has_lc then
    LifecycleEngine.reset_mutable(surface, fixture, 0)
    LifecycleEngine.reset_mutable(surface, fixture, 14)
    local ok_s, setup_err = LifecycleEngine.run_setup(surface, fixture, ctx)
    if not ok_s then
      set_status(cell.text_obj, comb, panel, "fail", tostring(setup_err))
      local clean_ok, clean_err = pcall(LifecycleEngine.cleanup, ctx)
      if not clean_ok then log("[test-run] lifecycle cleanup error: " .. tostring(clean_err)) end
      return "fail", "setup: " .. tostring(setup_err)
    end
  end

  local body_ok, verdict, detail = pcall(run_pad_body, player, surface, cell, fixture, dispatch, roster, ctx, comb, panel)
  -- Surface the body error BEFORE the cleanup pcall below (the pcall-logging guard stops scanning at
  -- the next pcall). verdict holds the pcall error message on failure.
  if not body_ok then log("[test-run] run_pad_body error for " .. tostring(fixture.id) .. ": " .. tostring(verdict)) end

  if has_lc then
    local clean_ok, clean_err = pcall(LifecycleEngine.cleanup, ctx)
    if not clean_ok then log("[test-run] lifecycle cleanup error: " .. tostring(clean_err)) end
  end

  if not body_ok then
    set_status(cell.text_obj, comb, panel, "fail", "runner body error")
    return "fail", "runner body error: " .. tostring(verdict)
  end
  return verdict, detail
end

-- === platform / surface reconcile (resolve by name, meter, fingerprint) ========================

--- The live/held hold pairs carry "<live> + <held>"; the meter resolves both by hardcoded name, so
--- MISSING detection only needs the first (live) platform.
local function first_platform_name(name)
  if type(name) ~= "string" then return nil end
  return (name:match("^([^+]+)") or name):gsub("%s+$", "")
end

--- Resolve a platform-kind fixture and fingerprint it. Returns "missing"|"pass"|"fail", detail.
local function run_platform(fixture, dispatch)
  local reads
  if dispatch.args == "none" then
    local first = first_platform_name(fixture.platformName)
    if not first or not FM.surface_for_platform(first) then
      return "missing", "platform " .. tostring(first) .. " absent"
    end
    reads = dispatch.meter()
  else
    local surface, platform = FM.surface_for_platform(fixture.platformName)
    if not surface then
      return "missing", "platform " .. tostring(fixture.platformName) .. " absent"
    end
    if dispatch.args == "platform" then
      reads = dispatch.meter(platform)
    else
      reads = dispatch.meter(surface)
    end
  end
  local drift = compare_fingerprint(reads, fixture.fingerprint)
  if drift then return "fail", drift end
  return "pass"
end

--- Resolve a surface-kind fixture (e.g. the nauvis belt loop) and fingerprint it.
local function run_surface(fixture, dispatch)
  local surface = fixture.surfaceName and game.surfaces[fixture.surfaceName]
  if not surface then
    return "missing", "surface " .. tostring(fixture.surfaceName) .. " absent"
  end
  local reads = dispatch.meter(surface)
  local drift = compare_fingerprint(reads, fixture.fingerprint)
  if drift then return "fail", drift end
  return "pass"
end

-- === discovery ================================================================================

--- Structure-discovery of the gallery test cells on one surface.
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

--- Match a discovered cell to a roster fixture: prefer origin (if the roster carries it), then the
--- cell name text == fixture display name, then == fixture id.
local function match_cell(cells, fixture)
  if type(fixture.origin) == "table" then
    for _, c in ipairs(cells) do
      if c.ox == fixture.origin.x and c.oy == fixture.origin.y then return c end
    end
  end
  for _, c in ipairs(cells) do
    if c.name == fixture.name then return c end
  end
  for _, c in ipairs(cells) do
    if c.name == fixture.id then return c end
  end
  return nil
end

-- === command context ==========================================================================

--- /test-clear context: player-scoped (operates on the viewer's surface). Unchanged behavior.
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

--- /test-run context: debug-gated, but player-LESS is allowed (RCON headless run). Returns
--- player (may be nil), filter.
local function test_run_context(cmd, ctx)
  if not (storage.surface_export_config and storage.surface_export_config.debug_mode) then
    ctx.print("Error: this is a debug instrument (enable debug_mode)")
    return nil, nil, false
  end
  local filter = cmd.parameter and cmd.parameter:gsub("%s+", "") or nil
  if filter == "" then filter = nil end
  return ctx.player, filter, true
end

local function fixture_matches_filter(fixture, filter)
  if not filter then return true end
  return (tostring(fixture.id):find(filter, 1, true) ~= nil)
    or (fixture.name ~= nil and tostring(fixture.name):find(filter, 1, true) ~= nil)
end

--- Emit the single machine-readable summary line: log() always; rcon.print when no player drove it.
local function emit_summary(summary, player)
  local json = helpers.table_to_json(summary)
  log("[TESTRUN-JSON] " .. json)
  if not player then rcon.print("[TESTRUN-JSON] " .. json) end
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
  "Reconcile the pushed manifest roster against the live map and run each fixture. Usage: /test-run [name-filter]",
  function(cmd, ctx)
    local player, filter, ok = test_run_context(cmd, ctx)
    if not ok then return end

    local roster = storage.surface_export_test_roster
    if not (roster and type(roster.fixtures) == "table" and #roster.fixtures > 0) then
      ctx.print(RUN_PREFIX .. " " .. CROSS .. " no roster pushed — run seed-prep or push-roster", CHAT_RED)
      emit_summary({
        rosterHash = roster and roster.hash or nil,
        fixtureCount = 0, passed = 0, failed = 1, missing = 0, unknown = 0, skipped = 0,
        results = { { id = "(roster)", verdict = "fail", detail = "no roster pushed" } },
      }, player)
      return
    end

    -- Per-surface discovery cache (pad reconcile + UNKNOWN PAD detection).
    local disc = {}
    local function cells_for(surface)
      local key = surface.name
      if not disc[key] then
        disc[key] = { surface = surface, cells = discover_cells(surface, filter), matched = {} }
      end
      return disc[key]
    end

    local results = {}
    local passed, failed, missing, unknown, skipped = 0, 0, 0, 0, 0
    local considered = 0
    local function record(id, verdict, detail)
      results[#results + 1] = { id = id, verdict = verdict, detail = detail }
    end

    for _, fx in ipairs(roster.fixtures) do
      if fixture_matches_filter(fx, filter) then
        considered = considered + 1
        local id = fx.id
        -- A SKIPPED pad fixture still owns its live cell: claim it so the reverse reconcile does not
        -- double-report a rostered-but-skipped pad as UNKNOWN (the skipped-no-meter wart, 2026-07-19).
        local function claim_pad_cell()
          if fx.padKind ~= "pad" then return end
          local surface = FM.surface_for_platform(fx.platformName)
          if not surface then return end
          local d = cells_for(surface)
          local cell = match_cell(d.cells, fx)
          if cell then d.matched[cell] = true end
        end
        if fx.runnerExcluded then
          local reason = (type(fx.runnerExcluded) == "string" and fx.runnerExcluded) or "excluded"
          skipped = skipped + 1
          record(id, "skipped", "excluded: " .. reason)
          ctx.print(string.format("%s %s: SKIPPED (excluded: %s)", RUN_PREFIX, id, reason), CHAT_YELLOW)
          claim_pad_cell()
        else
          local dispatch = DISPATCH[id]
          if not dispatch then
            skipped = skipped + 1
            record(id, "skipped", "no meter")
            ctx.print(string.format("%s %s: SKIPPED (no meter)", RUN_PREFIX, id), CHAT_YELLOW)
            claim_pad_cell()
          elseif fx.padKind == "pad" then
            local surface = FM.surface_for_platform(fx.platformName)
            if not surface then
              missing = missing + 1
              record(id, "missing", "platform " .. tostring(fx.platformName) .. " absent")
              ctx.print(string.format("%s %s: %s MISSING (platform %s absent)", RUN_PREFIX, id, CROSS, tostring(fx.platformName)), CHAT_RED)
            else
              local d = cells_for(surface)
              local cell = match_cell(d.cells, fx)
              if not cell then
                missing = missing + 1
                record(id, "missing", "no pad cell on " .. surface.name)
                ctx.print(string.format("%s %s: %s MISSING (no pad cell)", RUN_PREFIX, id, CROSS), CHAT_RED)
              else
                d.matched[cell] = true
                -- QUIET: suppress the lab's per-action chat narration for the whole run.
                SelectionLab.set_quiet(true)
                local run_ok, verdict, detail = pcall(run_pad, player, surface, cell, fx, dispatch, roster)
                SelectionLab.set_quiet(false)
                if not run_ok then
                  failed = failed + 1
                  record(id, "fail", "runner error: " .. tostring(verdict))
                  log("[test-run] " .. id .. " CRASHED: " .. tostring(verdict))
                  ctx.print(string.format("%s %s: %s runner error: %s", RUN_PREFIX, id, CROSS, tostring(verdict)), CHAT_RED)
                elseif verdict == "pass" then
                  passed = passed + 1
                  record(id, "pass", detail)
                  ctx.print(string.format("%s %s: %s", RUN_PREFIX, id, CHECK), CHAT_GREEN)
                elseif verdict == "skipped" then
                  skipped = skipped + 1
                  record(id, "skipped", detail)
                  ctx.print(string.format("%s %s: SKIPPED (%s)", RUN_PREFIX, id, tostring(detail)), CHAT_YELLOW)
                else
                  failed = failed + 1
                  record(id, "fail", detail)
                  ctx.print(string.format("%s %s: %s %s", RUN_PREFIX, id, CROSS, tostring(detail)), CHAT_RED)
                end
              end
            end
          elseif fx.padKind == "platform" or fx.padKind == "surface" then
            local run_ok, verdict, detail = pcall(fx.padKind == "surface" and run_surface or run_platform, fx, dispatch)
            if not run_ok then
              failed = failed + 1
              record(id, "fail", "runner error: " .. tostring(verdict))
              log("[test-run] " .. id .. " CRASHED: " .. tostring(verdict))
              ctx.print(string.format("%s %s: %s runner error: %s", RUN_PREFIX, id, CROSS, tostring(verdict)), CHAT_RED)
            elseif verdict == "missing" then
              missing = missing + 1
              record(id, "missing", detail)
              ctx.print(string.format("%s %s: %s MISSING (%s)", RUN_PREFIX, id, CROSS, tostring(detail)), CHAT_RED)
            elseif verdict == "pass" then
              passed = passed + 1
              record(id, "pass")
              ctx.print(string.format("%s %s: %s", RUN_PREFIX, id, CHECK), CHAT_GREEN)
            else
              failed = failed + 1
              record(id, "fail", detail)
              ctx.print(string.format("%s %s: %s %s", RUN_PREFIX, id, CROSS, tostring(detail)), CHAT_RED)
            end
          else
            skipped = skipped + 1
            record(id, "skipped", "unknown padKind " .. tostring(fx.padKind))
            ctx.print(string.format("%s %s: SKIPPED (unknown padKind %s)", RUN_PREFIX, id, tostring(fx.padKind)), CHAT_YELLOW)
          end
        end
      end
    end

    -- Reconcile the OTHER way: a discovered cell matching no roster fixture is an UNKNOWN PAD (yellow
    -- warning, not a failure). Include the viewer's surface so an in-game run also flags strays there.
    if player then cells_for(player.surface) end
    local open_slots = 0
    for _, d in pairs(disc) do
      for _, c in ipairs(d.cells) do
        if not d.matched[c] then
          -- "open-slot-*" is the sanctioned empty-rack convention — infrastructure, not a stray
          -- test. One summary count instead of a yellow warning per slot.
          if type(c.name) == "string" and c.name:find("^open%-slot%-") then
            open_slots = open_slots + 1
          else
            unknown = unknown + 1
            record(c.name, "unknown", "discovered pad not in roster on " .. d.surface.name)
            ctx.print(string.format("%s %s: UNKNOWN PAD (not in roster)", RUN_PREFIX, c.name), CHAT_YELLOW)
          end
        end
      end
    end
    if open_slots > 0 then
      ctx.print(string.format("%s %d open slot(s) available", RUN_PREFIX, open_slots), CHAT_YELLOW)
    end

    ctx.print(string.format("%s %d passed, %d failed, %d missing, %d unknown, %d skipped (roster %s)",
      RUN_PREFIX, passed, failed, missing, unknown, skipped, tostring(roster.hash)),
      (failed == 0 and missing == 0) and CHAT_GREEN or CHAT_RED)

    emit_summary({
      rosterHash = roster.hash,
      fixtureCount = considered,
      passed = passed, failed = failed, missing = missing, unknown = unknown, skipped = skipped,
      openSlots = open_slots,
      results = results,
    }, player)
  end
)

return true
