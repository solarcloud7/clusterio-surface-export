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
  local surface = pad_surface(fixture)

  LifecycleEngine.reset_mutable(surface, fixture, 0)
  LifecycleEngine.reset_mutable(surface, fixture, 14)
  local ctx = { armed_hooks = {}, restores = {}, captured = {} }
  local ok_s, setup_err = LifecycleEngine.run_setup(surface, fixture, ctx)
  if not ok_s then
    LifecycleEngine.cleanup(ctx)
    error("setup failed: " .. tostring(setup_err))
  end

  local scratch_name = SCRATCH_PREFIX .. fixture_id .. "-" .. tostring(run_id)
  if platform_by_name(scratch_name) then
    LifecycleEngine.cleanup(ctx)
    error("scratch platform '" .. scratch_name .. "' already exists (stale run — teardown first)")
  end

  if fixture.padKind == "platform" then
    local platform = platform_by_name(fixture.platformName)
    if not platform then
      LifecycleEngine.cleanup(ctx)
      error("platform fixture '" .. tostring(fixture.platformName) .. "' missing")
    end
    platform.name = scratch_name
    runs_store()[fixture_id] = { run_id = tostring(run_id), scratch_name = scratch_name, ctx = ctx }
    log("[lifecycle] setup " .. fixture_id .. ": renamed platform to " .. scratch_name ..
      " (index " .. tostring(platform.index) .. ")")
    return { ok = true, scratchName = scratch_name, scratchIndex = platform.index, captured = ctx.captured }
  end

  if type(fixture.origin) ~= "table" then
    error("fixture '" .. fixture_id .. "' has no pad origin")
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
    for name in pairs(ctx.armed_hooks) do existing.ctx.armed_hooks[name] = true end
    for _, r in ipairs(ctx.restores) do existing.ctx.restores[#existing.ctx.restores + 1] = r end
  else
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
