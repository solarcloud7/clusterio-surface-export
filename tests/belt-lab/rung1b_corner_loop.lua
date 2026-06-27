-- Rung 1b: adversarial mid-motion test. 2x2 turbo CORNER loop, items circulate ~300 ticks (chaotic sub-tile
-- floats from corner accel), then ONE-tick atomic capture -> two-pass rebuild offset -> rank-matched diff.
-- Diff phase 1 (FATAL): per-line count drop = insert_at collapsed a gap below min separation -> collision/loss.
-- Diff phase 2: per-rank Delta=|pos_src-pos_dst| = engine quantization on insert. (unique_id can't bridge a
-- destroy/recreate, so we rank-match: 1D belt physics => items can't pass => sorted index i = same item.)
local s = game.surfaces['nauvis']
for _, e in pairs(s.find_entities_filtered{area = {{95, 105}, {115, 132}}}) do
  if e.type == 'transport-belt' or e.type == 'item-entity' then e.destroy() end
end
-- clockwise corner loop: TL east, TR south, BR west, BL north
local specs = {{0, 0, defines.direction.east}, {1, 0, defines.direction.south}, {1, 1, defines.direction.west}, {0, 1, defines.direction.north}}
local function build(ox, oy)
  local b = {}
  for i, sp in ipairs(specs) do b[i] = s.create_entity{name = 'turbo-transport-belt', position = {ox + sp[1], oy + sp[2]}, direction = sp[3], force = 'player'} end
  return b
end
local A = build(100, 110)
-- seed single items at spaced positions on every line (sparse enough to keep flowing -> mid-motion)
for _, belt in ipairs(A) do
  for li = 1, belt.get_max_transport_line_index() do
    local L = belt.get_transport_line(li)
    local p = 0.1
    while p < L.line_length do L.insert_at(p, {name = 'iron-plate', count = 1}, 1) p = p + 0.3 end
  end
end
storage.r1b = {A = A, t0 = game.tick}
script.on_event(defines.events.on_tick, function()
  local r = storage.r1b
  if not (r and r.A and r.A[1] and r.A[1].valid) then script.on_event(defines.events.on_tick, nil) return end
  if game.tick - r.t0 < 300 then return end
  script.on_event(defines.events.on_tick, nil)
  -- CAPTURE A (atomic, this tick)
  local cap, srcTotal = {}, 0
  for i, belt in ipairs(r.A) do
    cap[i] = {}
    for li = 1, belt.get_max_transport_line_index() do
      local lst = {}
      for _, it in ipairs(belt.get_transport_line(li).get_detailed_contents()) do
        lst[#lst + 1] = {pos = it.position, name = it.stack.name, q = (it.stack.quality and it.stack.quality.name or 'normal'), count = it.stack.count}
        srcTotal = srcTotal + it.stack.count
      end
      table.sort(lst, function(a, b) return a.pos < b.pos end)
      cap[i][li] = lst
    end
  end
  -- BUILD B (two-pass: all 4 entities first), then RESTORE sorted insert_at
  local B = build(100, 127)
  for i, belt in ipairs(B) do
    for li, lst in pairs(cap[i]) do
      local L = belt.get_transport_line(li)
      for _, c in ipairs(lst) do L.insert_at(c.pos, {name = c.name, count = c.count, quality = c.q}, c.count) end
    end
  end
  -- DIFF rank-matched
  local dstTotal, drops, maxD, driftN = 0, {}, 0, 0
  for i, belt in ipairs(B) do
    for li = 1, belt.get_max_transport_line_index() do
      local dst = {}
      for _, it in ipairs(belt.get_transport_line(li).get_detailed_contents()) do dst[#dst + 1] = it.position dstTotal = dstTotal + it.stack.count end
      table.sort(dst)
      local src = cap[i][li] or {}
      if #src ~= #dst then drops[#drops + 1] = 'b' .. i .. 'L' .. li .. '(src' .. #src .. '/dst' .. #dst .. ')' end
      for k = 1, math.min(#src, #dst) do
        local d = math.abs(src[k].pos - dst[k])
        if d > maxD then maxD = d end
        if d > 1e-5 then driftN = driftN + 1 end
      end
    end
  end
  log('[R1B] srcTotal=' .. srcTotal .. ' dstTotal=' .. dstTotal)
  log('[R1B] countDrops(' .. #drops .. '): ' .. (table.concat(drops, ' ') == '' and 'NONE' or table.concat(drops, ' ')))
  log('[R1B] maxDelta=' .. string.format('%.6f', maxD) .. ' driftCount=' .. driftN)
  log('[R1B] DONE')
end)
