-- Rung 0, step 1: stand up the lab patch and confirm a turbo underground pair forms ONE merged line.
-- Run on nauvis at a far origin. Readable source of record; sent to RCON as a collapsed one-liner.
local s = game.surfaces['nauvis']
s.request_to_generate_chunks({100, 100}, 1)
s.force_generate_chunk_requests()
local t = {}
for x = 95, 112 do for y = 97, 103 do t[#t + 1] = {name = 'refined-concrete', position = {x, y}} end end
s.set_tiles(t)
for _, e in pairs(s.find_entities_filtered{area = {{95, 97}, {112, 103}}}) do
  if e.type == 'underground-belt' or e.type == 'transport-belt' or e.type == 'item-entity' then e.destroy() end
end
local e1 = s.create_entity{name = 'turbo-underground-belt', position = {100, 100}, direction = defines.direction.east, type = 'input', force = 'player'}
local e2 = s.create_entity{name = 'turbo-underground-belt', position = {103, 100}, direction = defines.direction.east, type = 'output', force = 'player'}
local out = {}
out[#out + 1] = 'e1=' .. tostring(e1 ~= nil and e1.valid)
out[#out + 1] = 'e2=' .. tostring(e2 ~= nil and e2.valid)
if e1 and e2 and e1.valid and e2.valid then
  local nb = e1.neighbours
  out[#out + 1] = 'e1.connected=' .. tostring(nb ~= nil and nb.valid == true)
  out[#out + 1] = 'e1.maxline=' .. e1.get_max_transport_line_index()
  out[#out + 1] = 'e2.maxline=' .. e2.get_max_transport_line_index()
  local l1 = e1.get_transport_line(1)
  out[#out + 1] = 'e1.l1.linelen=' .. l1.line_length
  out[#out + 1] = 'e1.l1.seglen=' .. l1.total_segment_length
  out[#out + 1] = 'le(e1l1,e2l1)=' .. tostring(l1.line_equals(e2.get_transport_line(1)))
  out[#out + 1] = 'le(e1l2,e2l2)=' .. tostring(e1.get_transport_line(2).line_equals(e2.get_transport_line(2)))
end
rcon.print(table.concat(out, ' | '))
