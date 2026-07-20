-- Remote Interface: lifecycle (P5 of the pad lifecycle framework)
-- Drives a transfer-act fixture's setup / verify / teardown ends for the pad-transfer-suite
-- orchestrator (tests/integration/pad-transfer-suite/run-tests.mjs). The orchestrator owns the act
-- itself (the PRODUCTION /transfer-platform of the scratch platform); this remote only arranges and
-- measures state, so the thing under test is the real transfer pipeline, never a bespoke path.
--
-- Contract:
--   lifecycle_setup(fixture_id, run_id)  [SOURCE end]
--     reset mutable anchors -> run the fixture's lifecycle setup (write-asserted) -> build the
--     scratch platform "se-lifecycle-scratch-<fixture_id>-<run_id>" and clone the pad's LEFT half
--     onto it at the SAME coordinates (anchor locators stay valid on every downstream surface).
--     Returns { ok, scratchName, scratchIndex, captured } — captured feeds the dest-side monotone
--     baseline (setup runs on the source; verify runs on the destination instance).
--   lifecycle_verify(fixture_id, phase, captured_json)  [phase "dest" on the DEST instance,
--     "source-after-act" on the SOURCE]
--     dest: resolve the transferred scratch platform by name, run the fixture's declared verify
--     list against it (roster must be pushed on this instance too). source-after-act: report
--     whether the scratch platform is gone (the two-phase-commit source delete) — a MEASUREMENT,
--     the orchestrator asserts.
--   lifecycle_teardown(fixture_id)  [BOTH ends, idempotent]
--     delete the scratch platform if present (game.delete_surface route — Pitfall #19, platform
--     .destroy is a no-op), run LifecycleEngine.cleanup on the persisted ctx (disarm hooks,
--     restore force props), clear the run record. Safe to call on an end that has no record.
--
-- Debug-gated like the other test instruments. Scratch names are namespaced se-lifecycle-scratch-*
-- so the orchestrator's zero-leftover sweep can assert none survive a run.

local LifecycleEngine = require("modules/surface_export/utils/lifecycle-engine")
local GameUtils = require("modules/surface_export/utils/game-utils")
local Util = require("modules/surface_export/utils/util")

local SCRATCH_PREFIX = "se-lifecycle-scratch-"

local function assert_debug()
  if not (storage.surface_export_config and storage.surface_export_config.debug_mode) then
    error("lifecycle remote requires debug_mode")
  end
end

local function roster_fixture(fixture_id)
  local roster = storage.surface_export_test_roster
  if not (roster and type(roster.fixtures) == "table") then
    error("no test roster pushed on this instance (push-roster first)")
  end
  for _, fx in ipairs(roster.fixtures) do
    if fx.id == fixture_id then return fx end
  end
  error("fixture '" .. tostring(fixture_id) .. "' not in the pushed roster")
end

local function platform_by_name(name)
  for _, platform in pairs(game.forces.player.platforms) do
    if platform.valid and platform.name == name then return platform end
  end
  return nil
end

local function pad_surface(fixture)
  local platform = platform_by_name(fixture.platformName)
  if not (platform and platform.surface) then
    error("pad platform '" .. tostring(fixture.platformName) .. "' missing")
  end
  return platform.surface
end

local function runs_store()
  storage.surface_export_lifecycle_runs = storage.surface_export_lifecycle_runs or {}
  return storage.surface_export_lifecycle_runs
end

local function lifecycle_setup(fixture_id, run_id)
  assert_debug()
  local fixture = roster_fixture(fixture_id)
  local lc = fixture.lifecycle
  if not (lc and lc.act == "transfer") then
    error("fixture '" .. fixture_id .. "' has no transfer-act lifecycle")
  end
  if type(fixture.origin) ~= "table" then
    error("fixture '" .. fixture_id .. "' has no pad origin")
  end
  local surface = pad_surface(fixture)

  -- Same run shape as the local runner: reset both halves, then setup (write-asserted ops).
  LifecycleEngine.reset_mutable(surface, fixture, 0)
  LifecycleEngine.reset_mutable(surface, fixture, 14)
  local ctx = { armed_hooks = {}, restores = {}, captured = {} }
  local ok_s, setup_err = LifecycleEngine.run_setup(surface, fixture, ctx)
  if not ok_s then
    LifecycleEngine.cleanup(ctx)
    error("setup failed: " .. tostring(setup_err))
  end

  -- Scratch platform: pad LEFT half cloned at identical coordinates.
  local scratch_name = SCRATCH_PREFIX .. fixture_id .. "-" .. tostring(run_id)
  if platform_by_name(scratch_name) then
    LifecycleEngine.cleanup(ctx)
    error("scratch platform '" .. scratch_name .. "' already exists (stale run — teardown first)")
  end
  local platform = game.forces.player.create_space_platform({
    name = scratch_name,
    planet = "nauvis",
    starter_pack = "space-platform-starter-pack",
  })
  if not platform then
    LifecycleEngine.cleanup(ctx)
    error("create_space_platform failed")
  end
  platform.apply_starter_pack()
  local scratch_surface = platform.surface
  if not scratch_surface then
    LifecycleEngine.cleanup(ctx)
    error("scratch platform has no surface after apply_starter_pack")
  end
  local o = fixture.origin
  local area = { { o.x + 1, o.y }, { o.x + 13, o.y + 11 } }
  surface.clone_area({
    source_area = area,
    destination_area = area,
    destination_surface = scratch_surface,
    clone_tiles = true,
    clone_entities = true,
    clone_decoratives = false,
    clear_destination_entities = false,
    expand_map = true,
  })

  runs_store()[fixture_id] = {
    run_id = tostring(run_id),
    scratch_name = scratch_name,
    ctx = ctx,
  }
  log("[lifecycle] setup " .. fixture_id .. ": scratch " .. scratch_name ..
    " (platform index " .. tostring(platform.index) .. ")")
  return {
    ok = true,
    scratchName = scratch_name,
    scratchIndex = platform.index,
    captured = ctx.captured,
  }
end

--- Dest-end setup: runs ONLY the ops declared `end = "dest"` (sabotage hooks / force mutations)
--- on this (destination) instance, recording the ctx so lifecycle_teardown here disarms/restores
--- them even if the orchestrator dies mid-fixture. Surface-touching ops are source-end only
--- (manifest-validated), so no surface is needed.
local function lifecycle_dest_setup(fixture_id)
  assert_debug()
  local fixture = roster_fixture(fixture_id)
  local ctx = { armed_hooks = {}, restores = {}, captured = {} }
  local ok_s, setup_err = LifecycleEngine.run_setup(nil, fixture, ctx, "dest")
  if not ok_s then
    LifecycleEngine.cleanup(ctx)
    error("dest setup failed: " .. tostring(setup_err))
  end
  local existing = runs_store()[fixture_id]
  if existing then
    -- merge so a later teardown cleans both (verify-created record + this one)
    for name in pairs(ctx.armed_hooks) do existing.ctx.armed_hooks[name] = true end
    for _, r in ipairs(ctx.restores) do existing.ctx.restores[#existing.ctx.restores + 1] = r end
  else
    -- scratch_name stays nil: this end owns hooks/restores only. The dest verify fills in the
    -- REAL arrived platform name later so teardown can delete a leftover dest copy.
    runs_store()[fixture_id] = { scratch_name = nil, ctx = ctx }
  end
  local armed = {}
  for name in pairs(ctx.armed_hooks) do armed[#armed + 1] = name end
  return { ok = true, armedHooks = armed, restores = #ctx.restores }
end

local function lifecycle_verify(fixture_id, phase, captured_json)
  assert_debug()
  local fixture = roster_fixture(fixture_id)
  local record = runs_store()[fixture_id]
  if phase == "source-after-act" then
    if not record then error("no lifecycle run recorded for '" .. fixture_id .. "'") end
    -- Measurement only: the orchestrator asserts scratchGone/preserved per the fixture's expect —
    -- recording the measured fact, not enforcing desired architecture here. When the scratch is
    -- still present (a refused transfer), the fixture's source-end checks run against it (the
    -- source-preserved witness).
    local platform = platform_by_name(record.scratch_name)
    local out = { ok = true, scratchGone = platform == nil }
    if platform and platform.surface then
      local ctx = { armed_hooks = {}, restores = {}, captured = record.ctx and record.ctx.captured or {} }
      local result = LifecycleEngine.run_verify(platform.surface, fixture, ctx,
        { dx = 0, end_filter = "source" })
      out.verdict = result.verdict
      out.checks = result.checks
    end
    return out
  elseif phase == "dest" then
    -- Dest end has no run record (setup ran on the source): resolve the transferred platform by
    -- the namespaced scratch name the orchestrator passes through captured_json.scratchName.
    local payload = {}
    if captured_json and captured_json ~= "" then
      local decoded = Util.json_to_table_compat(captured_json)
      if type(decoded) ~= "table" then error("captured_json did not decode to a table") end
      payload = decoded
    end
    local scratch_name = payload.scratchName
    if type(scratch_name) ~= "string" or scratch_name:sub(1, #SCRATCH_PREFIX) ~= SCRATCH_PREFIX then
      error("dest verify needs payload.scratchName with the scratch prefix")
    end
    local platform = platform_by_name(scratch_name)
    if not (platform and platform.surface) then
      return { ok = true, platformPresent = false, verdict = "fail",
        checks = { { name = "platform", verdict = "fail", detail = "scratch platform absent on dest" } } }
    end
    local ctx = { armed_hooks = {}, restores = {}, captured = payload.captured or {} }
    local result = LifecycleEngine.run_verify(platform.surface, fixture, ctx, { dx = 0, end_filter = "dest" })
    result.ok = true
    result.platformPresent = true
    -- Remember the REAL arrived name so teardown on THIS end can delete a leftover dest copy after
    -- a failure (fills in the nil left by a prior lifecycle_dest_setup record).
    local existing = runs_store()[fixture_id]
    if existing then
      existing.scratch_name = existing.scratch_name or scratch_name
    else
      runs_store()[fixture_id] = { scratch_name = scratch_name, ctx = { armed_hooks = {}, restores = {} } }
    end
    return result
  end
  error("unknown lifecycle_verify phase '" .. tostring(phase) .. "'")
end

-- NOTE (review F4): if the orchestrator dies before dest-verify runs, the dest end has no run
-- record and this deletes nothing there — backstopped by lifecycle_leftovers (prefix sweep) and by
-- the batch restore discarding the golden world entirely; never a live-data leak.
local function lifecycle_teardown(fixture_id)
  assert_debug()
  local record = runs_store()[fixture_id]
  local deleted = false
  if record then
    local platform = record.scratch_name and platform_by_name(record.scratch_name)
    if platform then
      GameUtils.delete_platform(platform)
      deleted = true
    end
    LifecycleEngine.cleanup(record.ctx)
    runs_store()[fixture_id] = nil
  end
  return { ok = true, hadRecord = record ~= nil, deletedScratch = deleted }
end

--- Zero-leftover sweep support: names of any surviving se-lifecycle-scratch-* platforms.
local function lifecycle_leftovers()
  local names = {}
  for _, platform in pairs(game.forces.player.platforms) do
    if platform.valid and platform.name:sub(1, #SCRATCH_PREFIX) == SCRATCH_PREFIX then
      names[#names + 1] = platform.name
    end
  end
  return { ok = true, leftovers = names, records = table_size(storage.surface_export_lifecycle_runs or {}) }
end

return {
  lifecycle_setup = lifecycle_setup,
  lifecycle_dest_setup = lifecycle_dest_setup,
  lifecycle_verify = lifecycle_verify,
  lifecycle_teardown = lifecycle_teardown,
  lifecycle_leftovers = lifecycle_leftovers,
}
