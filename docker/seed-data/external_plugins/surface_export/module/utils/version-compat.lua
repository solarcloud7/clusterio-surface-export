-- FactorioSurfaceExport - Version Compatibility / Dispatch Layer
--
-- Centralizes every Factorio-engine API call whose SIGNATURE or SEMANTICS drift between engine
-- versions, so the export/import logic can pick the right behavior dynamically. We have been bitten
-- repeatedly by version drift (insert_at parameter order, LuaSpacePlatform.destroy() becoming a
-- no-op, set_inventory_size_override arg order) — this module is the single seam where that lives.
--
-- TWO VERSION AXES (conflating them is the trap):
--   * SOURCE version  — the engine that PRODUCED a payload (stamped into the export as
--                       payload.factorio_version). Governs the DATA SHAPE. Handled by migrate().
--   * RUNTIME version — the engine EXECUTING the API call (script.active_mods.base). Governs which
--                       API primitive/signature to call. Handled by the PROFILES dispatch below.
-- On import you READ per the source shape, WRITE per the runtime engine's API, and MIGRATE the shape
-- in between when they differ.
--
-- Phase 1 supports only the 2.0 bucket (Factorio 2.0.76, build 84451 — verified empirically). Every
-- dispatch resolves to today's verified behavior. Phase 2 adds PROFILES["2.1"] + cross-version
-- migrate() entries after each candidate site is checked against lua-api.factorio.com/2.1.10/.
--
-- SIGNATURE SOURCE OF TRUTH: lua-api.factorio.com/<version>/ — NEVER the "latest" docs (they have
-- drifted; e.g. they reorder insert_at's params). The factorio-ai-tools MCP only serves "latest" and
-- must not be trusted for signatures.

local VersionCompat = {}

-- The newest engine bucket this module has a profile for. Used as the fallback target when the
-- runtime engine is newer/unknown (with a loud warning — never a silent wrong-version dispatch).
local NEWEST_KNOWN = "2.0"

-- ---------------------------------------------------------------------------
-- Version parsing & bucketing
-- ---------------------------------------------------------------------------

--- Parse a Factorio version string "major.minor.patch" into components + a "major.minor" bucket.
--- @param version_string string|nil: e.g. "2.0.76"
--- @return table|nil: { major, minor, patch (may be nil), bucket="major.minor" }, or nil if unparseable
function VersionCompat.parse(version_string)
  local s = tostring(version_string or "")
  local major, minor, patch = s:match("^(%d+)%.(%d+)%.?(%d*)")
  major = tonumber(major)
  minor = tonumber(minor)
  if not major or not minor then
    return nil
  end
  return {
    major = major,
    minor = minor,
    patch = tonumber(patch),  -- nil when the patch component is absent
    bucket = string.format("%d.%d", major, minor),
  }
end

-- Module-local cache. Re-evaluated whenever the chunk is reloaded (save/load re-runs require), so it
-- can never go stale relative to the running engine within a session.
local _runtime_bucket_cache = nil

--- The runtime engine's "major.minor" bucket (e.g. "2.0"), read from active_mods.base.
--- @return string|nil
function VersionCompat.runtime_bucket()
  if _runtime_bucket_cache ~= nil then
    return _runtime_bucket_cache or nil
  end
  local active_mods = (script and script.active_mods) or (game and game.active_mods) or {}
  local parsed = VersionCompat.parse(active_mods.base)
  -- Cache false (not nil) to distinguish "computed, unknown" from "not yet computed".
  _runtime_bucket_cache = (parsed and parsed.bucket) or false
  return _runtime_bucket_cache or nil
end

-- ---------------------------------------------------------------------------
-- Runtime-axis dispatch: per-version API primitive implementations
-- ---------------------------------------------------------------------------

local PROFILES = {}

PROFILES["2.0"] = {
  -- LuaTransportLine insertion. 2.0.76 signature (lua-api.factorio.com/2.0.76/): the position comes
  -- FIRST and belt_stack_size (max items per slot, OPTIONAL — turbo belts cap at 4) comes LAST. The
  -- "latest" docs reorder these; using that order on 2.0.76 places nothing. Thin signature wrappers:
  -- the caller keeps the pcall + error logging so failures stay grounded at the richer call site.
  belt_insert_at = function(line, position, stack, belt_stack_size)
    return line.insert_at(position, stack, belt_stack_size)
  end,
  belt_insert_at_back = function(line, stack, belt_stack_size)
    return line.insert_at_back(stack, belt_stack_size)
  end,
  -- Platform teardown. LuaSpacePlatform.destroy() is a SILENT no-op at 2.0.76 (Pitfall #19) — the
  -- only API that actually removes a platform is game.delete_surface(). The caller (GameUtils.
  -- delete_platform) owns the validity checks and the surfaceless-leak logging.
  delete_platform = function(platform)
    game.delete_surface(platform.surface)
  end,
}

-- ---------------------------------------------------------------------------
-- Profile resolution (with loud, once-per-key fallback warnings)
-- ---------------------------------------------------------------------------

local _warned = {}
local function warn_once(key, message)
  if not _warned[key] then
    _warned[key] = true
    log(message)
  end
end

--- Resolve the dispatch profile for an explicit runtime bucket.
--- @param bucket string|nil
--- @return table, string, boolean: profile, used_bucket, fell_back
local function profile_for(bucket)
  if bucket and PROFILES[bucket] then
    return PROFILES[bucket], bucket, false
  end
  if bucket then
    warn_once(bucket, string.format(
      "[VersionCompat] No dispatch profile for Factorio %s — falling back to newest known profile " ..
      "'%s'. API behavior may be wrong for this engine; add PROFILES['%s'] in version-compat.lua.",
      tostring(bucket), NEWEST_KNOWN, tostring(bucket)))
  else
    warn_once("__no_version__",
      "[VersionCompat] Could not detect the runtime Factorio version (script.active_mods.base " ..
      "missing) — falling back to newest known profile '" .. NEWEST_KNOWN .. "'.")
  end
  return PROFILES[NEWEST_KNOWN], NEWEST_KNOWN, true
end

local function resolve_profile()
  return profile_for(VersionCompat.runtime_bucket())
end

--- Test/introspection helper: which profile bucket WOULD be used for a given runtime bucket, and was
--- it a fallback? Lets tests exercise the resolver (incl. unknown-version fallback) without touching
--- active_mods.
--- @param bucket string|nil
--- @return string, boolean: used_bucket, fell_back
function VersionCompat.resolve_for(bucket)
  local _, used, fell_back = profile_for(bucket)
  return used, fell_back
end

--- @return boolean: whether a dispatch profile exists for the given bucket
function VersionCompat.has_profile(bucket)
  return PROFILES[bucket] ~= nil
end

-- ---------------------------------------------------------------------------
-- Public runtime-axis shims (thin — caller keeps pcall + logging)
-- ---------------------------------------------------------------------------

--- Insert items onto a transport line at an exact position. See PROFILES["2.0"].belt_insert_at.
--- @param line LuaTransportLine
--- @param position number: 0..line_length
--- @param stack table: { name, count, quality }
--- @param belt_stack_size number|nil: max items per slot (turbo belts cap at 4); optional
--- @return boolean
function VersionCompat.belt_insert_at(line, position, stack, belt_stack_size)
  return resolve_profile().belt_insert_at(line, position, stack, belt_stack_size)
end

--- Append items at the back of a transport line. See PROFILES["2.0"].belt_insert_at_back.
--- @param line LuaTransportLine
--- @param stack table: { name, count, quality }
--- @param belt_stack_size number|nil
--- @return boolean
function VersionCompat.belt_insert_at_back(line, stack, belt_stack_size)
  return resolve_profile().belt_insert_at_back(line, stack, belt_stack_size)
end

--- Issue the version-correct platform teardown primitive. Caller (GameUtils.delete_platform) owns the
--- validity guards and surfaceless logging.
--- @param platform LuaSpacePlatform: must be valid with a valid surface
function VersionCompat.delete_platform(platform)
  return resolve_profile().delete_platform(platform)
end

-- ---------------------------------------------------------------------------
-- Source-axis dispatch: payload data-shape migration
-- ---------------------------------------------------------------------------

--- Migrate an export payload's DATA SHAPE from the engine that produced it (from_bucket) to the
--- engine that will import it (to_bucket). SOURCE-axis seam.
--- Phase 1 is identity: only the "2.0" bucket exists, so from_bucket == to_bucket on every real
--- transfer. Phase 2 registers per-pair shape migrations (e.g. "2.0" -> "2.1"). Building the call
--- site now is the point — import already routes through here.
--- @param payload table: the deserialized export payload
--- @param from_bucket string|nil: source engine bucket (from payload.factorio_version)
--- @param to_bucket string|nil: runtime engine bucket
--- @return table: the (possibly migrated) payload
function VersionCompat.migrate(payload, from_bucket, to_bucket)
  if from_bucket == to_bucket then
    return payload
  end
  -- No migration registered yet. Return the payload unchanged (best-effort) so phase-1 same-version
  -- transfers are never affected, and log loudly so a cross-version mismatch is visible rather than
  -- silently mis-imported.
  warn_once("migrate:" .. tostring(from_bucket) .. "->" .. tostring(to_bucket), string.format(
    "[VersionCompat] No payload migration registered for %s -> %s; importing unmigrated " ..
    "(best-effort). Add a migration in version-compat.lua (phase 2).",
    tostring(from_bucket), tostring(to_bucket)))
  return payload
end

return VersionCompat
