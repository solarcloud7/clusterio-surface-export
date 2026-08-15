local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")

local BELT_TYPES = { "transport-belt", "underground-belt", "splitter", "loader", "loader-1x1" }

local function rebuild_on(surface, live, dx, dy)
  local emap, cfails = {}, 0
  for _, e in ipairs(live) do
    local args = {
      name = e.name,
      position = { e.position.x + dx, e.position.y + dy },
      direction = e.direction,
      force = "player",
    }
    if e.type == "underground-belt" then args.type = e.belt_to_ground_type end
    if e.type == "loader" or e.type == "loader-1x1" then args.type = e.loader_type end
    local c = surface.create_entity(args)
    if c and c.valid then emap[e.position.x .. "," .. e.position.y] = c else cfails = cfails + 1 end
  end
  return emap, cfails
end

local function dup_kill(opts)
  local plat
  for _, p in pairs(game.forces.player.platforms) do
    if p.valid and p.name == opts.platform then plat = p end
  end
  if not plat then return { success = false, error = "platform not found: " .. tostring(opts.platform) } end
  local s = plat.surface
  local live = s.find_entities_filtered({ type = BELT_TYPES })
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

  local emap, cfails = rebuild_on(sc, live, 0, 0)
  out.create_fails = cfails
  if cfails > 0 then
    game.delete_surface(sc)
    return { success = false, error = "rebuild create failures: " .. cfails }
  end
  local zero = 0
  for _, e in ipairs(sc.find_entities_filtered({ type = BELT_TYPES })) do
    zero = zero + e.get_item_count()
  end
  if zero ~= 0 then
    game.delete_surface(sc)
    return { success = false, error = "scratch not empty pre-restore" }
  end

  local placed, unplaced, anomalies = BeltRestoration.restore_side_groups(groups, emap)
  out.placed = placed
  out.unplaced = unplaced
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
  for _, e in ipairs(sc.find_entities_filtered({ type = BELT_TYPES })) do
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

local batched = nil

local function side_multiset(g, emap)
  local seen, act, total = {}, {}, 0
  for _, m in ipairs(g.members) do
    local e = emap[m.id]
    if e and e.valid then
      for _, it in ipairs(e.get_transport_line(m.li).get_detailed_contents()) do
        local id = tostring(it.unique_id)
        if not seen[id] then
          seen[id] = true
          local k = it.stack.name .. "|" .. ((it.stack.quality and it.stack.quality.name) or "normal")
          act[k] = (act[k] or 0) + it.stack.count
          total = total + it.stack.count
        end
      end
    end
  end
  return act, total
end

local function multiset_exact(exp, act)
  for k, v in pairs(exp) do if (act[k] or 0) ~= v then return false end end
  for k, v in pairs(act) do if (exp[k] or 0) ~= v then return false end end
  return true
end

local function dup_kill_batched(opts)
  if opts.op == "abort" then
    local sc = game.surfaces["belt-r15-scratch"]
    if sc then game.delete_surface(sc) end
    batched = nil
    return { success = true, aborted = true }
  end

  if opts.op == "start" then
    if batched then return { success = false, error = "batched run already in progress (abort first)" } end
    local plat
    for _, p in pairs(game.forces.player.platforms) do
      if p.valid and p.name == opts.platform then plat = p end
    end
    if not plat then return { success = false, error = "platform not found: " .. tostring(opts.platform) } end
    local s = plat.surface
    local live = s.find_entities_filtered({ type = BELT_TYPES })
    local pairs_list = {}
    for _, e in ipairs(live) do
      pairs_list[#pairs_list + 1] = { entity = e, id = e.position.x .. "," .. e.position.y }
    end
    local t0 = game.tick
    local groups = BeltRestoration.capture_side_groups(pairs_list)
    local capture_same_tick = (game.tick == t0)
    if not groups then return { success = false, error = "capture returned nil" } end
    local slots, captured_total = 0, 0
    for _, g in ipairs(groups) do
      for _, sl in ipairs(g.slots) do slots = slots + 1 captured_total = captured_total + sl.ct end
    end

    local old = game.surfaces["belt-r15-scratch"]
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
    local sc = game.create_surface("belt-r15-scratch", { width = 2 * half, height = 2 * half })
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
    if cfails > 0 then
      game.delete_surface(sc)
      return { success = false, error = "rebuild create failures: " .. cfails }
    end

    batched = {
      groups = groups, emap = emap, cursor = 0,
      captured_total = captured_total, slots = slots,
      start_tick = game.tick,
      placed = 0, unplaced = 0, anomalies = 0,
      per_side = {}, inexact = {},
    }
    return { success = true, belt_count = #live, groups = #groups, slots = slots,
      captured_total = captured_total, capture_same_tick = capture_same_tick, tick = game.tick }
  end

  if opts.op == "step" then
    if not batched then return { success = false, error = "no batched run in progress" } end
    local batch = opts.batch or 32
    local from = batched.cursor + 1
    local to = math.min(batched.cursor + batch, #batched.groups)
    if from > to then return { success = false, error = "cursor past end" } end
    local slice = {}
    for i = from, to do slice[#slice + 1] = batched.groups[i] end
    local placed, unplaced, anomalies = BeltRestoration.restore_side_groups(slice, batched.emap)
    batched.placed = batched.placed + placed
    batched.unplaced = batched.unplaced + unplaced
    batched.anomalies = batched.anomalies + anomalies
    local batch_exact = 0
    local batch_inexact = {}
    for i = from, to do
      local g = batched.groups[i]
      local exp, expt = {}, 0
      for _, sl in ipairs(g.slots) do
        local k = sl.n .. "|" .. sl.q
        exp[k] = (exp[k] or 0) + sl.ct
        expt = expt + sl.ct
      end
      local act, actt = side_multiset(g, batched.emap)
      local exact = multiset_exact(exp, act)
      batched.per_side[i] = { exact = exact, expected = expt, at_completion = act, at_completion_total = actt }
      if exact then batch_exact = batch_exact + 1
      else
        batch_inexact[#batch_inexact + 1] = { g = i, expected = expt, actual = actt }
        batched.inexact[#batched.inexact + 1] = { g = i, expected = expt, actual = actt }
      end
    end
    batched.cursor = to
    return { success = true, tick = game.tick, from = from, to = to,
      placed = placed, unplaced = unplaced, anomalies = anomalies,
      batch_exact = batch_exact, batch_inexact = batch_inexact, done = to >= #batched.groups }
  end

  if opts.op == "finish" then
    if not batched then return { success = false, error = "no batched run in progress" } end
    if batched.cursor < #batched.groups then
      return { success = false, error = "finish before all sides restored: " .. batched.cursor .. "/" .. #batched.groups }
    end
    local sc = game.surfaces["belt-r15-scratch"]
    local suid, stotal = {}, 0
    if sc then
      for _, e in ipairs(sc.find_entities_filtered({ type = BELT_TYPES })) do
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
    end
    local drifted, drift_abs = 0, 0
    for i, g in ipairs(batched.groups) do
      local act = side_multiset(g, batched.emap)
      local snap = batched.per_side[i] and batched.per_side[i].at_completion or {}
      local keys = {}
      for k in pairs(act) do keys[k] = true end
      for k in pairs(snap) do keys[k] = true end
      local delta = 0
      for k in pairs(keys) do delta = delta + math.abs((act[k] or 0) - (snap[k] or 0)) end
      if delta > 0 then drifted = drifted + 1 drift_abs = drift_abs + delta end
    end
    local exact_at_completion = 0
    for _, r in pairs(batched.per_side) do if r.exact then exact_at_completion = exact_at_completion + 1 end end
    local out = {
      success = true, tick = game.tick,
      sides = #batched.groups, sides_exact_at_completion = exact_at_completion,
      inexact_sides = batched.inexact,
      placed = batched.placed, unplaced = batched.unplaced, anomalies = batched.anomalies,
      captured_total = batched.captured_total, scratch_census = stotal,
      drifted_after_completion = drifted, drift_abs = drift_abs,
      elapsed_ticks = game.tick - batched.start_tick,
    }
    if sc then game.delete_surface(sc) end
    batched = nil
    return out
  end

  return { success = false, error = "unknown batched op: " .. tostring(opts.op) }
end

local function iso(opts)
  if opts.op == "clear" then
    storage.belt_iso = nil
    return { success = true, cleared = true }
  end

  if opts.op == "capture" then
    local plat
    for _, p in pairs(game.forces.player.platforms) do
      if p.valid and p.name == opts.platform then plat = p end
    end
    if not plat then return { success = false, error = "platform not found: " .. tostring(opts.platform) } end
    local area = opts.area
    if type(area) ~= "table" then return { success = false, error = "iso capture needs opts.area" } end
    local live = plat.surface.find_entities_filtered({ type = BELT_TYPES, area = area })
    if #live == 0 then return { success = false, error = "no belts in area" } end
    local pairs_list = {}
    for _, e in ipairs(live) do
      pairs_list[#pairs_list + 1] = { entity = e, id = e.position.x .. "," .. e.position.y }
    end
    local groups = BeltRestoration.capture_side_groups(pairs_list)
    if not groups then return { success = false, error = "capture returned nil" } end
    local slots, total = 0, 0
    for _, g in ipairs(groups) do
      for _, sl in ipairs(g.slots) do slots = slots + 1 total = total + sl.ct end
    end
    storage.belt_iso = { groups = groups, platform = opts.platform, area = area,
      captured_total = total, tick = game.tick }
    return { success = true, belts = #live, groups = #groups, slots = slots, captured_total = total }
  end

  if opts.op == "restore" then
    local iso_data = storage.belt_iso
    if not iso_data then return { success = false, error = "no iso capture in storage — run capture first" } end
    local plat
    for _, p in pairs(game.forces.player.platforms) do
      if p.valid and p.name == iso_data.platform then plat = p end
    end
    if not plat then return { success = false, error = "capture platform gone: " .. tostring(iso_data.platform) } end
    local live = plat.surface.find_entities_filtered({ type = BELT_TYPES, area = iso_data.area })
    if #live == 0 then return { success = false, error = "source belts gone from area" } end

    local order = opts.order or "forward"
    local groups = iso_data.groups
    if order == "reversed" then
      local rev = {}
      for i = #groups, 1, -1 do rev[#rev + 1] = groups[i] end
      groups = rev
    end

    local context = opts.context or "scratch"
    local target, dx, dy, cleanup
    if context == "scratch" then
      local old = game.surfaces["belt-iso-scratch"]
      if old then game.delete_surface(old) end
      local sc = game.create_surface("belt-iso-scratch", { width = 128, height = 128 })
      sc.request_to_generate_chunks({ 0, 0 }, 3)
      sc.force_generate_chunk_requests()
      local a = iso_data.area
      local tiles = {}
      for x = math.floor(a[1][1]) - 3, math.ceil(a[2][1]) + 3 do
        for y = math.floor(a[1][2]) - 3, math.ceil(a[2][2]) + 3 do
          tiles[#tiles + 1] = { name = "lab-dark-1", position = { x, y } }
        end
      end
      sc.set_tiles(tiles, true, false, true, false)
      target, dx, dy = sc, 0, 0
      cleanup = function() if sc.valid then game.delete_surface(sc) end end
    elseif context == "platform" then
      local slot = opts.slot
      if type(slot) ~= "table" then return { success = false, error = "context platform needs opts.slot {x,y}" } end
      local a = iso_data.area
      dx = slot.x - a[1][1]
      dy = slot.y - a[1][2]
      target = plat.surface
      local dest_area = { { a[1][1] + dx, a[1][2] + dy }, { a[2][1] + dx, a[2][2] + dy } }
      if #target.find_entities_filtered({ area = dest_area }) > 0 then
        return { success = false, error = "platform slot not empty — refusing to build over content" }
      end
      cleanup = function()
        for _, e in pairs(target.find_entities_filtered({ area = dest_area, type = BELT_TYPES })) do
          if e.valid then e.destroy() end
        end
      end
    else
      return { success = false, error = "unknown context: " .. tostring(context) }
    end

    local ok, result = pcall(function()
      local emap, cfails = rebuild_on(target, live, dx, dy)
      if cfails > 0 then error("rebuild create failures: " .. cfails) end
      local placed, unplaced, anomalies = BeltRestoration.restore_side_groups(groups, emap)
      local all_exact, inexact = true, {}
      for gi, g in ipairs(groups) do
        local exp = {}
        local expt = 0
        for _, sl in ipairs(g.slots) do
          local k = sl.n .. "|" .. sl.q
          exp[k] = (exp[k] or 0) + sl.ct
          expt = expt + sl.ct
        end
        local act, actt = side_multiset(g, emap)
        if not multiset_exact(exp, act) then
          all_exact = false
          inexact[#inexact + 1] = { g = gi, expected = expt, actual = actt }
        end
      end
      return {
        success = true, context = context, order = order,
        placed = placed, unplaced = unplaced, anomalies = anomalies,
        all_sides_exact = all_exact, inexact_sides = inexact,
        captured_total = iso_data.captured_total,
      }
    end)
    cleanup()
    if not ok then
      log("[belt-iso] restore leg failed: " .. tostring(result))
      return { success = false, error = tostring(result), context = context, order = order }
    end
    return result
  end

  return { success = false, error = "unknown iso op: " .. tostring(opts.op) }
end

local function belt_side_restore_selftest(opts)
  if type(opts) == "table" and opts.mode == "dup_kill" then
    return dup_kill(opts)
  end
  if type(opts) == "table" and opts.mode == "iso" then
    return iso(opts)
  end
  if type(opts) == "table" and opts.mode == "dup_kill_batched" then
    return dup_kill_batched(opts)
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
          stack = { name = item.name, quality = { name = item.quality }, count = item.count,
            valid_for_read = true },
        }
      end
      return out
    end
    line.can_insert_at = function() return true end
    line.insert_at = function(_position, stack, count)
      line.contents[#line.contents + 1] = new_stack(stack.name, stack.quality, count)
      return true
    end
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
    return true
  end

  local prototype = { belt_speed = 1 / 256 }
  local entity_map = {
    [1] = { valid = true, prototype = prototype, get_transport_line = function() return target end },
    [2] = { valid = true, prototype = prototype, get_transport_line = function() return target end },
    [3] = { valid = true, prototype = prototype, get_transport_line = function() return neighbour end },
  }
  local groups = {
    { members = { { id = 1, li = 1 }, { id = 2, li = 1 } },
      slots = { { n = "iron-plate", q = "legendary", ct = 1 } },
      item_source_positions = { 1, 1, 200 } },
    { members = { { id = 3, li = 1 } }, slots = {}, item_source_positions = {} },
  }

  local placed, unplaced, anomalies = BeltRestoration.restore_side_groups(groups, entity_map)
  check("aliased_windows_do_not_double_count", placed == 1 and unplaced == 0,
    string.format("placed=%d unplaced=%d", placed, unplaced))
  check("cross_side_landing_fails_both_sides", anomalies == 2,
    "a wrong-side landing must fail its own side (short) AND the side it hit (over); got anomalies=" .. tostring(anomalies))

  local function count(line, quality)
    local total = 0
    for _, item in ipairs(line.contents) do
      if item.name == "iron-plate" and item.quality == quality then total = total + item.count end
    end
    return total
  end
  check("no_retry_after_trusted_landing", count(target, "legendary") == 0 and count(target, "normal") == 0,
    "a trusted landing must not be retried (the census-driven rescan was the R16 duplication engine)")
  check("leak_is_visible_not_silent", count(neighbour, "legendary") == 1 and count(neighbour, "normal") == 5,
    "expected the leaked legendary plate to sit on the neighbour, witnessed by the anomaly")

  local lie_line = make_line()
  lie_line.insert_at = function() return true end
  local lie_map = { [7] = { valid = true, prototype = prototype, get_transport_line = function() return lie_line end } }
  local lie_groups = {
    { members = { { id = 7, li = 1 } },
      slots = { { n = "iron-plate", q = "normal", ct = 3 } },
      item_source_positions = { 7, 1, 128 } },
  }
  local lplaced, lunplaced, lanomalies = BeltRestoration.restore_side_groups(lie_groups, lie_map)
  check("success_lie_fails_its_side_bracket", lanomalies >= 1,
    string.format("an insert that lies about landing must fail the side bracket; placed=%d unplaced=%d anomalies=%d",
      lplaced, lunplaced, lanomalies))
  check("success_lie_leaves_nothing_physical", #lie_line.contents == 0,
    "the lying insert must not have manufactured items")

  local honest_line = make_line()
  local honest_map = { [9] = { valid = true, prototype = prototype, get_transport_line = function() return honest_line end } }
  local honest_groups = {
    { members = { { id = 9, li = 1 } },
      slots = { { n = "iron-plate", q = "normal", ct = 2 }, { n = "iron-plate", q = "legendary", ct = 1 } },
      item_source_positions = { 9, 1, 200, 9, 1, 100 } },
  }
  local hplaced, hunplaced, hanomalies = BeltRestoration.restore_side_groups(honest_groups, honest_map)
  check("honest_restore_is_bracket_silent", hplaced == 3 and hunplaced == 0 and hanomalies == 0,
    string.format("clean restore must place all with zero anomalies; placed=%d unplaced=%d anomalies=%d",
      hplaced, hunplaced, hanomalies))

  local merge_line = make_line()
  merge_line.can_insert_at = function() return #merge_line.contents == 0 end
  local merge_map = { [11] = { valid = true, prototype = prototype, get_transport_line = function() return merge_line end } }
  local merge_groups = {
    { members = { { id = 11, li = 1 } },
      slots = { { n = "iron-plate", q = "normal", ct = 2 }, { n = "iron-plate", q = "normal", ct = 3 } },
      item_source_positions = { 11, 1, 200, 11, 1, 100 } },
  }
  local mplaced, munplaced, manomalies = BeltRestoration.restore_side_groups(merge_groups, merge_map)
  check("merge_lands_single_oversized_stack",
    mplaced == 5 and munplaced == 0 and manomalies == 0
      and #merge_line.contents == 1 and merge_line.contents[1].count == 5,
    string.format("merge must land one oversized stack of 5; placed=%d unplaced=%d anomalies=%d stacks=%d",
      mplaced, munplaced, manomalies, #merge_line.contents))

  local decline_line = make_line()
  decline_line.can_insert_at = function() return #decline_line.contents == 0 end
  decline_line.insert_at = function(_position, stack, count)
    if count > 2 then return false end
    decline_line.contents[#decline_line.contents + 1] = new_stack(stack.name, stack.quality, count)
    return true
  end
  local decline_map = { [13] = { valid = true, prototype = prototype, get_transport_line = function() return decline_line end } }
  local decline_groups = {
    { members = { { id = 13, li = 1 } },
      slots = { { n = "iron-plate", q = "normal", ct = 2 }, { n = "iron-plate", q = "normal", ct = 3 } },
      item_source_positions = { 13, 1, 200, 13, 1, 100 } },
  }
  local dplaced, dunplaced, danomalies = BeltRestoration.restore_side_groups(decline_groups, decline_map)
  check("merge_decline_restores_partner",
    dplaced == 2 and dunplaced == 3 and danomalies == 0
      and #decline_line.contents == 1 and decline_line.contents[1].count == 2,
    string.format("a declined merge must put the partner back and stay bracket-silent; placed=%d unplaced=%d anomalies=%d stacks=%d count=%s",
      dplaced, dunplaced, danomalies, #decline_line.contents,
      decline_line.contents[1] and tostring(decline_line.contents[1].count) or "none"))

  local bp_inv = game.create_inventory(2)
  bp_inv[1].set_stack({ name = "blueprint", count = 1 })
  bp_inv[1].set_blueprint_entities({ { entity_number = 1, name = "wooden-chest", position = { x = 0.5, y = 0.5 } } })
  local same_type_string = bp_inv[1].export_stack()
  bp_inv[2].set_stack({ name = "blueprint-book", count = 1 })
  local cross_type_string = bp_inv[2].export_stack()
  bp_inv.destroy()

  local preflight_scratch = InventoryScanner.new_item_state_cache()
  local same_ok, same_seen = BeltRestoration.export_string_keeps_identity(
    preflight_scratch, "blueprint", "normal", 1, same_type_string)
  local cross_ok, cross_seen = BeltRestoration.export_string_keeps_identity(
    preflight_scratch, "blueprint", "normal", 1, cross_type_string)
  InventoryScanner.release_item_state_cache(preflight_scratch)
  check("preflight_passes_a_same_type_export_string", same_ok == true,
    string.format("a blueprint's own export string must preflight clean; got %s (%s)",
      tostring(same_ok), tostring(same_seen)))
  check("preflight_refuses_a_type_changing_export_string",
    cross_ok == false and type(cross_seen) == "string" and string.find(cross_seen, "blueprint%-book") ~= nil,
    string.format("a blueprint-book string imported into a blueprint stack changes the item name and "
      .. "import_stack still returns 0, so only a measured identity comparison can refuse it; got %s (%s)",
      tostring(cross_ok), tostring(cross_seen)))

  local decline_state_line = make_line()
  local decline_state_map = {
    [15] = { valid = true, prototype = prototype, get_transport_line = function() return decline_state_line end },
  }
  local decline_state_groups = {
    { members = { { id = 15, li = 1 } },
      slots = { { n = "blueprint", q = "normal", ct = 1, st = { export_string = cross_type_string } } },
      item_source_positions = { 15, 1, 200 } },
  }
  local zplaced, zunplaced, zanomalies, _, zstate =
    BeltRestoration.restore_side_groups(decline_state_groups, decline_state_map)
  check("declined_export_string_never_reaches_the_stack",
    zstate ~= nil and zstate.declined == 1 and zstate.applied == 0 and zstate.failed == 0
      and zplaced == 1 and zunplaced == 0 and zanomalies == 0
      and #decline_state_line.contents == 1 and decline_state_line.contents[1].name == "blueprint",
    string.format("a type-changing export_string must be declined and counted while the stack stays placed and "
      .. "a blueprint; declined=%s applied=%s failed=%s placed=%d unplaced=%d anomalies=%d stacks=%d name=%s",
      tostring(zstate and zstate.declined), tostring(zstate and zstate.applied), tostring(zstate and zstate.failed),
      zplaced, zunplaced, zanomalies, #decline_state_line.contents,
      decline_state_line.contents[1] and tostring(decline_state_line.contents[1].name) or "none"))

  local v1 = BeltRestoration.validate_side_groups({ {} })
  check("shape_guard_refuses_empty_group", v1 == false, "group {} must fail shape validation")
  local v2 = BeltRestoration.validate_side_groups({ 1, 2, 3 })
  check("shape_guard_refuses_scalars", v2 == false, "scalar groups must fail shape validation")
  local v3 = BeltRestoration.validate_side_groups({
    { members = { { id = 1, li = 1 } }, slots = { { n = "iron-plate", q = "normal", ct = 1 } }, item_source_positions = { 1, 1 } },
  })
  check("shape_guard_refuses_misaligned_source_positions", v3 == false, "item_source_positions not a multiple of 3 must fail")
  local v4 = BeltRestoration.validate_side_groups({
    { members = { { id = 1, li = 1 } }, slots = { { n = "iron-plate", q = "normal", ct = 1 } }, item_source_positions = { 1, 1, 64 } },
  })
  check("shape_guard_accepts_wellformed", v4 == true, "a well-formed group must pass shape validation")

  return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return belt_side_restore_selftest
