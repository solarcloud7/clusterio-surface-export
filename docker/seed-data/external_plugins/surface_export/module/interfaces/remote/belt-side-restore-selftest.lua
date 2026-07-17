-- FactorioSurfaceExport - side-scoped belt restoration self-test
-- Exercises the production helper with aliased line windows and mixed qualities. The fake lines model
-- the measured BELT-R11 leak signature while keeping the test deterministic and cluster-light.

local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")

local function belt_side_restore_selftest()
  local details = {}
  local passed, failed = 0, 0

  local function check(name, condition, message)
    if condition then
      passed = passed + 1
      details[#details + 1] = { name = name, ok = true }
    else
      failed = failed + 1
      details[#details + 1] = { name = name, ok = false, msg = message or "assertion failed" }
    end
  end

  local next_id = 10
  local function new_stack(name, quality, count)
    next_id = next_id + 1
    return { id = next_id, name = name, quality = quality, count = count }
  end

  local function make_line(initial)
    local line = { contents = initial or {}, line_length = 1 }
    line.get_detailed_contents = function()
      local out = {}
      for _, item in ipairs(line.contents) do
        out[#out + 1] = {
          unique_id = item.id,
          stack = { name = item.name, quality = { name = item.quality }, count = item.count },
        }
      end
      return out
    end
    line.can_insert_at = function() return true end
    line.remove_item = function(spec)
      local remaining, removed = spec.count, 0
      local i = 1
      while i <= #line.contents do
        local item = line.contents[i]
        if item.name == spec.name and (not spec.quality or item.quality == spec.quality) then
          local take = math.min(item.count, remaining)
          item.count = item.count - take
          remaining = remaining - take
          removed = removed + take
          if item.count == 0 then table.remove(line.contents, i) else i = i + 1 end
          if remaining == 0 then break end
        else i = i + 1 end
      end
      return removed
    end
    return line
  end

  local target = make_line()
  local neighbour = make_line({ new_stack("iron-plate", "normal", 5) })
  local insert_count = 0
  target.insert_at = function(_position, stack, count)
    insert_count = insert_count + 1
    local destination = insert_count == 1 and neighbour or target
    destination.contents[#destination.contents + 1] = new_stack(stack.name, stack.quality, count)
    return count
  end
  neighbour.insert_at = function(_position, stack, count)
    neighbour.contents[#neighbour.contents + 1] = new_stack(stack.name, stack.quality, count)
    return count
  end

  local prototype = { belt_speed = 1 / 256 }
  local entity_map = {
    [1] = { valid = true, prototype = prototype, get_transport_line = function() return target end },
    [2] = { valid = true, prototype = prototype, get_transport_line = function() return target end },
    [3] = { valid = true, prototype = prototype, get_transport_line = function() return neighbour end },
  }
  local groups = {
    { members = { { id = 1, li = 1 }, { id = 2, li = 1 } },
      slots = { { n = "iron-plate", q = "legendary", ct = 1 } } },
    { members = { { id = 3, li = 1 } }, slots = {} },
  }

  local placed, unplaced, leaks_undone, anomalies = BeltRestoration.restore_side_groups(groups, entity_map)
  check("aliased_windows_do_not_double_count", placed == 1 and unplaced == 0 and anomalies == 0,
    string.format("placed=%d unplaced=%d anomalies=%d", placed, unplaced, anomalies))
  check("cross_side_leak_is_detected", leaks_undone == 1,
    "expected one detected and undone leak, got " .. tostring(leaks_undone))

  local function count(line, quality)
    local total = 0
    for _, item in ipairs(line.contents) do
      if item.name == "iron-plate" and item.quality == quality then total = total + item.count end
    end
    return total
  end
  check("target_receives_exact_quality", count(target, "legendary") == 1 and count(target, "normal") == 0,
    "target did not receive exactly one legendary plate")
  check("leak_undo_preserves_neighbour_quality", count(neighbour, "normal") == 5 and count(neighbour, "legendary") == 0,
    "leak undo changed the neighbour's mixed-quality multiset")

  return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return belt_side_restore_selftest
