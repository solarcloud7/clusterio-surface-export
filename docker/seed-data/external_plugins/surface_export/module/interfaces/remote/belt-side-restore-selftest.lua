-- FactorioSurfaceExport - side-scoped belt restoration self-test
-- Exercises the production helper with aliased line windows and mixed qualities. The fake lines model
-- the measured BELT-R11 leak signature while keeping the test deterministic and cluster-light.

local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")

--- DUP-KILL mode (BELT-R14, 2026-07-19): run the PRODUCTION capture_side_groups +
--- restore_side_groups against a REAL platform's belts in ONE execution — capture the live
--- side partition, rebuild the belt geometry on a scratch surface, restore, verdict by
--- independent both-direction per-side multisets + whole-scratch distinct-uid census against
--- the captured basis, then remove the scratch. RCON cannot require() at runtime, so this
--- remote is the lab's only path to the production functions (the no-tick measure_baked
--- pattern). Read-only on the platform; the scratch is created and deleted here.
--- @param opts table: { mode = "dup_kill", platform = <name> }
local function dup_kill(opts)
  local plat
  for _, p in pairs(game.forces.player.platforms) do
    if p.valid and p.name == opts.platform then plat = p end
  end
  if not plat then return { success = false, error = "platform not found: " .. tostring(opts.platform) } end
  local s = plat.surface
  local live = s.find_entities_filtered({ type = { "transport-belt", "underground-belt", "splitter" } })
  local out = { success = true, belt_count = #live }

  local pairs_list = {}
  for _, e in ipairs(live) do
    pairs_list[#pairs_list + 1] = { entity = e, id = e.position.x .. "," .. e.position.y }
  end
  local t0 = game.tick
  local groups = BeltRestoration.capture_side_groups(pairs_list)
  out.capture_same_tick = (game.tick == t0)
  if not groups then return { success = false, error = "capture returned nil" } end
  local slots, captured_total = 0, 0
  for _, g in ipairs(groups) do
    for _, sl in ipairs(g.slots) do slots = slots + 1 captured_total = captured_total + sl.ct end
  end
  out.groups = #groups
  out.slots = slots
  out.captured_total = captured_total

  local old = game.surfaces["belt-r14-scratch"]
  if old then game.delete_surface(old) end
  local minx, miny, maxx, maxy = math.huge, math.huge, -math.huge, -math.huge
  for _, e in ipairs(live) do
    local x, y = e.position.x, e.position.y
    if x < minx then minx = x end
    if x > maxx then maxx = x end
    if y < miny then miny = y end
    if y > maxy then maxy = y end
  end
  local half = math.max(math.abs(minx), math.abs(maxx), math.abs(miny), math.abs(maxy)) + 20
  local sc = game.create_surface("belt-r14-scratch", { width = 2 * half, height = 2 * half })
  sc.request_to_generate_chunks({ 0, 0 }, math.ceil(half / 32) + 1)
  sc.force_generate_chunk_requests()
  local tiles = {}
  for x = math.floor(minx) - 3, math.ceil(maxx) + 3 do
    for y = math.floor(miny) - 3, math.ceil(maxy) + 3 do
      tiles[#tiles + 1] = { name = "lab-dark-1", position = { x, y } }
    end
  end
  sc.set_tiles(tiles, true, false, true, false)

  local emap, cfails = {}, 0
  for _, e in ipairs(live) do
    local args = { name = e.name, position = { e.position.x, e.position.y }, direction = e.direction, force = "player" }
    if e.type == "underground-belt" then args.type = e.belt_to_ground_type end
    local c = sc.create_entity(args)
    if c and c.valid then emap[e.position.x .. "," .. e.position.y] = c else cfails = cfails + 1 end
  end
  out.create_fails = cfails
  if cfails > 0 then
    game.delete_surface(sc)
    return { success = false, error = "rebuild create failures: " .. cfails }
  end
  local zero = 0
  for _, e in ipairs(sc.find_entities_filtered({ type = { "transport-belt", "underground-belt", "splitter" } })) do
    zero = zero + e.get_item_count()
  end
  if zero ~= 0 then
    game.delete_surface(sc)
    return { success = false, error = "scratch not empty pre-restore" }
  end

  local placed, unplaced, leaks_undone, anomalies = BeltRestoration.restore_side_groups(groups, emap)
  out.placed = placed
  out.unplaced = unplaced
  out.leaks_undone = leaks_undone
  out.anomalies = anomalies

  local all_exact = true
  local inexact = {}
  for gi, g in ipairs(groups) do
    local exp, expt = {}, 0
    for _, sl in ipairs(g.slots) do
      local k = sl.n .. "|" .. sl.q
      exp[k] = (exp[k] or 0) + sl.ct
      expt = expt + sl.ct
    end
    local seen, act, actt = {}, {}, 0
    for _, m in ipairs(g.members) do
      local e = emap[m.id]
      if e and e.valid then
        for _, it in ipairs(e.get_transport_line(m.li).get_detailed_contents()) do
          local id = tostring(it.unique_id)
          if not seen[id] then
            seen[id] = true
            local k = it.stack.name .. "|" .. ((it.stack.quality and it.stack.quality.name) or "normal")
            act[k] = (act[k] or 0) + it.stack.count
            actt = actt + it.stack.count
          end
        end
      end
    end
    local exact = true
    for k, v in pairs(exp) do if (act[k] or 0) ~= v then exact = false end end
    for k, v in pairs(act) do if (exp[k] or 0) ~= v then exact = false end end
    if not exact then
      all_exact = false
      inexact[#inexact + 1] = { g = gi, expected = expt, actual = actt }
    end
  end
  out.all_sides_exact = all_exact
  out.inexact_sides = inexact

  local suid, stotal = {}, 0
  for _, e in ipairs(sc.find_entities_filtered({ type = { "transport-belt", "underground-belt", "splitter" } })) do
    for li = 1, e.get_max_transport_line_index() do
      for _, it in ipairs(e.get_transport_line(li).get_detailed_contents()) do
        local id = tostring(it.unique_id)
        if not suid[id] then
          suid[id] = true
          stotal = stotal + it.stack.count
        end
      end
    end
  end
  out.scratch_census = stotal

  game.delete_surface(sc)
  return out
end

local function belt_side_restore_selftest(opts)
  -- Real-world DUP-kill measurement (opts-selected); the no-arg call keeps the fake-line unit
  -- rung below unchanged.
  if type(opts) == "table" and opts.mode == "dup_kill" then
    return dup_kill(opts)
  end
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
