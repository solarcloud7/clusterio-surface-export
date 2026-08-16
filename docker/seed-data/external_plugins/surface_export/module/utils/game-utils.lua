local VersionCompat = require("modules/surface_export/utils/version-compat")

local GameUtils = {}

GameUtils.QUALITY_NORMAL = "normal"

GameUtils.FORCE_SYNC_PROPS = { "bulk_inserter_capacity_bonus", "inserter_stack_size_bonus" }

function GameUtils.round_position(position, precision)
  precision = precision or 1
  local multiplier = 10 ^ precision
  return {
    x = math.floor(position.x * multiplier + 0.5) / multiplier,
    y = math.floor(position.y * multiplier + 0.5) / multiplier
  }
end

GameUtils.TYPE_TO_CATEGORY = {
  ["ammo-turret"] = "turret",
  ["arithmetic-combinator"] = "combinator",
  ["cargo-wagon"] = "train",
  ["constant-combinator"] = "combinator",
  ["decider-combinator"] = "combinator",
  ["electric-turret"] = "turret",
  ["fluid-turret"] = "turret",
  ["fluid-wagon"] = "train",
  ["infinity-cargo-wagon"] = "train",
  ["infinity-container"] = "container",
  ["lane-splitter"] = "splitter",
  ["linked-container"] = "container",
  ["locomotive"] = "train",
  ["logistic-container"] = "container",
  ["proxy-container"] = "container",
  ["rocket-silo-rocket"] = "rocket-silo",
  ["rocket-silo-rocket-shadow"] = "rocket-silo",
  ["selector-combinator"] = "combinator",
  ["storage-tank"] = "fluid-storage",
  ["temporary-container"] = "container",
}

function GameUtils.get_entity_category(entity)
  local entity_type = entity.type
  return GameUtils.TYPE_TO_CATEGORY[entity_type] or entity_type
end

function GameUtils.make_quality_key(item_name, quality_name)
  if quality_name and quality_name ~= GameUtils.QUALITY_NORMAL then
    return string.format("%s:%s", item_name, quality_name)
  end
  return item_name
end

function GameUtils.make_fluid_temp_key(fluid_name, temperature)
  return string.format("%s@%.1fC", fluid_name, temperature)
end

function GameUtils.parse_fluid_temp_key(key)
  local name, temp_str = key:match("^(.+)@([%d%.%-]+)C$")
  if name and temp_str then
    return name, tonumber(temp_str)
  end
  return key, 15
end

GameUtils.HIGH_TEMP_THRESHOLD = 10000

function GameUtils.parse_quality_key(key)
  local parts = {}
  for part in key:gmatch("[^:]+") do
    table.insert(parts, part)
  end

  if #parts == 2 then
    return parts[1], parts[2]
  else
    return key, GameUtils.QUALITY_NORMAL
  end
end

function GameUtils.debug_log(message)
end


GameUtils.ACTIVATABLE_ENTITY_TYPES = {
  ["assembling-machine"] = true,
  ["furnace"] = true,
  ["mining-drill"] = true,
  ["lab"] = true,
  ["rocket-silo"] = true,
  ["agricultural-tower"] = true,
  ["reactor"] = true,
  ["generator"] = true,
  ["burner-generator"] = true,
  ["boiler"] = true,
  ["fusion-reactor"] = true,
  ["fusion-generator"] = true,
  ["inserter"] = true,
  ["loader"] = true,
  ["loader-1x1"] = true,
  ["pump"] = true,
  ["offshore-pump"] = true,
  ["roboport"] = true,
  ["beacon"] = true,
  ["radar"] = true,
  ["thruster"] = true,
  ["asteroid-collector"] = true,
  ["cargo-bay"] = true,
  ["space-platform-hub"] = true,
  ["cargo-landing-pad"] = true,
}

GameUtils.BELT_ENTITY_TYPES = {
  ["transport-belt"] = true,
  ["underground-belt"] = true,
  ["splitter"] = true,
  ["loader"] = true,
  ["loader-1x1"] = true,
}


function GameUtils.make_stable_id(entity)
  local position = entity.position or {x = 0, y = 0}
  local orientation_part = entity.orientation and string.format(":%.3f", entity.orientation) or ""
  return string.format("%s@%.3f,%.3f#%s%s",
    entity.name,
    position.x,
    position.y,
    entity.direction or 0,
    orientation_part)
end

local reported_bad_reads = {}

function GameUtils.safe_get(obj, property)
  local ok, val = pcall(function() return obj[property] end)
  if ok then return val end
  if not reported_bad_reads[property] then
    reported_bad_reads[property] = true
    log(string.format("[GameUtils][WARN] safe_get('%s') THREW: %s — a throw means the key does not exist "
      .. "on this class (a legitimately absent value returns nil without throwing). Reported once per name.",
      tostring(property), tostring(val)))
  end
  return nil
end

function GameUtils.extract_color(entity)
  -- intentional probe; failure expected (entity may have no color), no log
  local ok, color = pcall(function() return entity.color end)
  if ok and color then
    return { r = color.r or 0, g = color.g or 0, b = color.b or 0, a = color.a or 1 }
  end
  return nil
end

function GameUtils.pcall_warn(context, fn)
  local ok, err = pcall(fn)
  if not ok then
    log(string.format("%s: %s", context, tostring(err)))
  end
end

function GameUtils.delete_platform(platform)
  if not (platform and platform.valid) then return false end
  local surface = platform.surface
  if surface and surface.valid then
    VersionCompat.delete_platform(platform)
    return true
  end
  log(string.format(
    "[GameUtils] delete_platform: platform '%s' has no valid surface; cannot fully remove (platform.destroy is a no-op)",
    tostring(platform.name)))
  return false
end

function GameUtils.platform_has_hub(platform)
  if not (platform and platform.valid) then return false end
  local hub = platform.hub
  return hub ~= nil and hub.valid
end

return GameUtils
