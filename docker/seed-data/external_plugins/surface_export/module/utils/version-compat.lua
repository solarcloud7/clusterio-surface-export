local VersionCompat = {}

local NEWEST_KNOWN = "2.1"


VersionCompat.PAYLOAD_SCHEMA_VERSION = "2.0.0"

function VersionCompat.check_payload_schema(payload)
  local got = payload and payload.schema_version
  if got ~= VersionCompat.PAYLOAD_SCHEMA_VERSION then
    return false, string.format(
      "Payload schema %s is not importable (this build requires schema %s — the fluid-segment " ..
      "registry payload). Old exports must be re-exported by a current source; there is no " ..
      "legacy translator by design.",
      tostring(got), VersionCompat.PAYLOAD_SCHEMA_VERSION)
  end
  return true, nil
end


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
    patch = tonumber(patch),
    bucket = string.format("%d.%d", major, minor),
  }
end

local _runtime_bucket_cache = nil

function VersionCompat.runtime_bucket()
  if _runtime_bucket_cache ~= nil then
    return _runtime_bucket_cache or nil
  end
  local active_mods = (script and script.active_mods) or (game and game.active_mods) or {}
  local parsed = VersionCompat.parse(active_mods.base)
  _runtime_bucket_cache = (parsed and parsed.bucket) or false
  return _runtime_bucket_cache or nil
end


local PROFILES = {}

PROFILES["2.0"] = {
  belt_insert_at = function(line, position, stack, belt_stack_size)
    return line.insert_at(position, stack, belt_stack_size) == true
  end,
  belt_insert_at_back = function(line, stack, belt_stack_size)
    return line.insert_at_back(stack, belt_stack_size)
  end,
  delete_platform = function(platform)
    game.delete_surface(platform.surface)
  end,
}

PROFILES["2.1"] = {
  belt_insert_at = PROFILES["2.0"].belt_insert_at,
  belt_insert_at_back = PROFILES["2.0"].belt_insert_at_back,
  delete_platform = PROFILES["2.0"].delete_platform,
}


local _warned = {}
local function warn_once(key, message)
  if not _warned[key] then
    _warned[key] = true
    log(message)
  end
end

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

function VersionCompat.resolve_for(bucket)
  local _, used, fell_back = profile_for(bucket)
  return used, fell_back
end

function VersionCompat.has_profile(bucket)
  return PROFILES[bucket] ~= nil
end


function VersionCompat.belt_insert_at(line, position, stack, belt_stack_size)
  return resolve_profile().belt_insert_at(line, position, stack, belt_stack_size)
end

function VersionCompat.belt_insert_at_back(line, stack, belt_stack_size)
  return resolve_profile().belt_insert_at_back(line, stack, belt_stack_size)
end

function VersionCompat.delete_platform(platform)
  return resolve_profile().delete_platform(platform)
end


function VersionCompat.migrate(payload, from_bucket, to_bucket)
  if from_bucket == to_bucket then
    return payload
  end
  warn_once("migrate:" .. tostring(from_bucket) .. "->" .. tostring(to_bucket), string.format(
    "[VersionCompat] No payload migration registered for %s -> %s; importing unmigrated " ..
    "(best-effort). Add a migration in version-compat.lua (phase 2).",
    tostring(from_bucket), tostring(to_bucket)))
  return payload
end

return VersionCompat
