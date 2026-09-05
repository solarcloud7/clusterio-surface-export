local root = "docker/seed-data/mods-src/surfexp_gateways/"
local setting
data = {extend = function(_, list) setting = list[1] end}
dofile(root .. "settings.lua")
assert(setting.default_value == "one_gate")
assert(setting.setting_type == "startup")
for _, mode in ipairs(setting.allowed_values) do
  local locations, connections = {}, {}
  settings = {startup = {[setting.name] = {value = mode}}}
  data = {extend = function(_, list)
    for _, prototype in ipairs(list) do
      if prototype.type == "space-location" then locations[prototype.name] = prototype end
      if prototype.type == "space-connection" then connections[prototype.name] = prototype end
    end
  end}
  dofile(root .. "data.lua")
  local visible, count, links = 0, 0, 0
  for name, location in pairs(locations) do
    count = count + 1
    local expected = mode == "one_gate" and name == "surfexp_gateway_hub"
      or mode == "multi" and name ~= "surfexp_gateway_hub"
    assert(location.hidden == not expected, name .. " visibility")
    assert(location.draw_orbit == expected, name .. " orbit")
    if not location.hidden then visible = visible + 1 end
    local file = assert(io.open(root .. location.starmap_icon:gsub("__surfexp_gateways__/", ""), "rb"))
    file:close()
  end
  for _, connection in pairs(connections) do
    links = links + 1
    assert(connection.from == "nauvis" and locations[connection.to])
  end
  assert(count == 5 and links == 5)
  assert(visible == (mode == "one_gate" and 1 or 4))
  print(mode .. ": PASS (visible=" .. visible .. ", retained locations=" .. count .. ", connections=" .. links .. ")")
end
