-- Rung 1a: single turbo belt tile, packed dense, captured + relocated in ONE tick, full-fidelity diff.
-- Pure insert_at fidelity test (no chaining/segment confounds). Source A and dest B on same surface/tick.
local s = game.surfaces['nauvis']
for _, e in pairs(s.find_entities_filtered{area = {{95, 105}, {112, 125}}}) do
  if e.type == 'transport-belt' or e.type == 'item-entity' then e.destroy() end
end
local A = s.create_entity{name = 'turbo-transport-belt', position = {100, 110}, direction = defines.direction.east, force = 'player'}
-- pack both lines densely via insert_at (insert_at_back only fills one slot/tick — Rung0 finding)
for li = 1, A.get_max_transport_line_index() do
  local L = A.get_transport_line(li)
  local p = 0
  while p <= L.line_length + 0.001 do L.insert_at(p, {name = 'iron-plate', count = 4}, 4) p = p + 0.2 end
end
-- capture SOURCE
local function key(li, it)
  return li .. '|' .. string.format('%.3f', it.position) .. '|' .. it.stack.name .. '|' ..
    (it.stack.quality and it.stack.quality.name or 'normal') .. '|' .. it.stack.count
end
local cap = {}
local srcTotal = 0
for li = 1, A.get_max_transport_line_index() do
  for _, it in ipairs(A.get_transport_line(li).get_detailed_contents()) do
    cap[#cap + 1] = {li = li, position = it.position, name = it.stack.name,
      quality = (it.stack.quality and it.stack.quality.name or 'normal'), count = it.stack.count}
    srcTotal = srcTotal + it.stack.count
  end
end
-- build DEST and restore (sorted ascending by position), same tick
local B = s.create_entity{name = 'turbo-transport-belt', position = {100, 120}, direction = defines.direction.east, force = 'player'}
local byline = {}
for _, c in ipairs(cap) do byline[c.li] = byline[c.li] or {}; table.insert(byline[c.li], c) end
for li, items in pairs(byline) do
  table.sort(items, function(a, b) return a.position < b.position end)
  local L = B.get_transport_line(li)
  for _, c in ipairs(items) do
    L.insert_at(c.position, {name = c.name, count = c.count, quality = c.quality}, c.count)
  end
end
-- capture DEST + diff
local srcKeys, dstKeys = {}, {}
for _, c in ipairs(cap) do
  local k = c.li .. '|' .. string.format('%.3f', c.position) .. '|' .. c.name .. '|' .. c.quality .. '|' .. c.count
  srcKeys[k] = (srcKeys[k] or 0) + 1
end
local dstTotal = 0
for li = 1, B.get_max_transport_line_index() do
  for _, it in ipairs(B.get_transport_line(li).get_detailed_contents()) do
    dstKeys[key(li, it)] = (dstKeys[key(li, it)] or 0) + 1
    dstTotal = dstTotal + it.stack.count
  end
end
local mism = {}
for k, v in pairs(srcKeys) do if dstKeys[k] ~= v then mism[#mism + 1] = 'SRC ' .. k .. ' x' .. v .. ' got ' .. tostring(dstKeys[k]) end end
for k, v in pairs(dstKeys) do if srcKeys[k] ~= v then mism[#mism + 1] = 'DST ' .. k .. ' x' .. v .. ' extra' end end
rcon.print('srcTotal=' .. srcTotal .. ' dstTotal=' .. dstTotal .. ' captured=' .. #cap)
rcon.print('MISMATCHES(' .. #mism .. '): ' .. (table.concat(mism, ' ; ') == '' and 'NONE' or table.concat(mism, ' ; ')))
