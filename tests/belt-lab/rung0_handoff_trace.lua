-- Rung 0 (deeper): per-tick hand-off trace across the underground boundary.
-- Insert 3 tracked items on the entrance tunnel line (e1.L3) and log, EVERY tick, the full 8-line occupancy
-- by unique_id + a hard conservation invariant: total must stay 3, dup (any id on >1 line) must stay 0.
-- A "blind tick" (total<3) = capture miss risk; a "duplication tick" (dup>0 or total>3) = double-count risk.
local s = game.surfaces['nauvis']
for _, e in pairs(s.find_entities_filtered{area = {{95, 97}, {112, 103}}}) do
  if e.type == 'underground-belt' then e.destroy() end
end
local e1 = s.create_entity{name = 'turbo-underground-belt', position = {100, 100}, direction = defines.direction.east, type = 'input', force = 'player'}
local e2 = s.create_entity{name = 'turbo-underground-belt', position = {103, 100}, direction = defines.direction.east, type = 'output', force = 'player'}
local L = e1.get_transport_line(3)
for _, p in ipairs({0.2, 0.6, 1.0}) do L.insert_at(p, {name = 'iron-plate', count = 1}, 1) end
storage.lab = {e1 = e1, e2 = e2, log = {}, tick0 = game.tick}
script.on_event(defines.events.on_tick, function()
  local lab = storage.lab
  if not (lab and lab.e1 and lab.e1.valid) then script.on_event(defines.events.on_tick, nil) return end
  local t = game.tick - lab.tick0
  local total, idcount, occ = 0, {}, {}
  for _, pr in ipairs({{'e1', lab.e1}, {'e2', lab.e2}}) do
    for i = 1, 4 do
      local ids = {}
      for _, it in ipairs(pr[2].get_transport_line(i).get_detailed_contents()) do
        total = total + it.stack.count
        idcount[it.unique_id] = (idcount[it.unique_id] or 0) + 1
        ids[#ids + 1] = '#' .. it.unique_id .. '@' .. string.format('%.2f', it.position)
      end
      if #ids > 0 then occ[#occ + 1] = pr[1] .. 'L' .. i .. '[' .. table.concat(ids, ',') .. ']' end
    end
  end
  local dup = 0
  for _, n in pairs(idcount) do if n > 1 then dup = dup + 1 end end
  lab.log[#lab.log + 1] = 't' .. t .. ' total=' .. total .. ' dup=' .. dup .. ' ' .. table.concat(occ, ' ')
  if t >= 70 then
    script.on_event(defines.events.on_tick, nil)
    for _, l in ipairs(lab.log) do log('[LABTRACE] ' .. l) end
    log('[LABTRACE] DONE ticks=' .. #lab.log)
  end
end)
