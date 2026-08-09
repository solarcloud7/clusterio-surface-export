local Util = require("modules/surface_export/utils/util")

local function debug_on()
  return storage.surface_export_config and storage.surface_export_config.debug_mode == true
end

local function set_test_roster(roster_json, roster_hash)
  if not debug_on() then
    return { ok = false, error = "debug_mode off" }
  end
  local decoded = Util.json_to_table_compat(roster_json)
  if type(decoded) ~= "table" then
    error("[surface_export] set_test_roster: roster_json did not decode to a table")
  end
  local fixtures = decoded.fixtures
  if type(fixtures) ~= "table" then
    error("[surface_export] set_test_roster: decoded roster has no fixtures array")
  end
  for i, fx in ipairs(fixtures) do
    if type(fx) ~= "table" then
      error("[surface_export] set_test_roster: fixture #" .. i .. " is not a table")
    end
    if type(fx.id) ~= "string" then
      error("[surface_export] set_test_roster: fixture #" .. i .. " has no string id")
    end
    if fx.padKind == nil then
      error("[surface_export] set_test_roster: fixture " .. fx.id .. " has no padKind")
    end
    if type(fx.fingerprint) ~= "table" then
      error("[surface_export] set_test_roster: fixture " .. fx.id .. " has no fingerprint table")
    end
  end
  storage.surface_export_test_roster = {
    schema = decoded.schema,
    hash = roster_hash,
    pushed_tick = game.tick,
    fixtures = fixtures,
  }
  log(string.format("[surface_export] test roster set: %d fixtures, hash=%s",
    #fixtures, tostring(roster_hash)))
  return { ok = true, fixtureCount = #fixtures, hash = roster_hash }
end

local function get_test_roster_summary()
  local r = storage.surface_export_test_roster
  if not r then
    return { hash = nil, fixtureCount = 0, pushedTick = nil }
  end
  return {
    hash = r.hash,
    fixtureCount = (r.fixtures and #r.fixtures) or 0,
    pushedTick = r.pushed_tick,
  }
end


local function set_test_roster_begin(hash)
  if not (storage.surface_export_config and storage.surface_export_config.debug_mode) then
    error("test roster requires debug_mode")
  end
  storage.surface_export_test_roster_staging = { hash = hash, parts = {} }
  return { ok = true }
end

local function set_test_roster_chunk(part)
  local staging = storage.surface_export_test_roster_staging
  if not staging then error("no roster staging in progress (call set_test_roster_begin first)") end
  staging.parts[#staging.parts + 1] = part
  return { ok = true, parts = #staging.parts }
end

local function set_test_roster_commit(expected_len)
  local staging = storage.surface_export_test_roster_staging
  if not staging then error("no roster staging in progress") end
  storage.surface_export_test_roster_staging = nil
  local json = table.concat(staging.parts)
  if expected_len and #json ~= expected_len then
    error(string.format("roster staging length mismatch: got %d, expected %d", #json, expected_len))
  end
  set_test_roster(json, staging.hash)
  return { ok = true, bytes = #json }
end

return {
  set_test_roster = set_test_roster,
  set_test_roster_begin = set_test_roster_begin,
  set_test_roster_chunk = set_test_roster_chunk,
  set_test_roster_commit = set_test_roster_commit,
  get_test_roster_summary = get_test_roster_summary,
}
