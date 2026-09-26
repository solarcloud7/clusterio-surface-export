local root = "docker/seed-data/mods-src/surfexp_gateways/"
local setting, boarding
data = {extend = function(_, list)
  for _, value in ipairs(list) do
    if value.name == "surfexp-gateway-layout" then setting = value end
    if value.name == "surfexp-platform-boarding" then boarding = value end
  end
end}
dofile(root .. "settings.lua")
assert(boarding.type == "bool-setting" and boarding.setting_type == "runtime-global" and boarding.default_value == true)
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
  local visible, count, links, visible_links = 0, 0, 0, 0
  local hub_planets = {}
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
    local destination = assert(locations[connection.to])
    assert(destination.hidden == false, connection.name .. " connects an inactive gateway")
    assert(connection.length == (connection.from == "aquilo" and 30001 or 15001),
      connection.name .. " should be one longer than the planet's own route")
    if not connection.hidden then visible_links = visible_links + 1 end
    if connection.to == "surfexp_gateway_hub" then
      assert(not hub_planets[connection.from], "duplicate hub route")
      hub_planets[connection.from] = true
    else
      assert(connection.from == "nauvis")
    end
  end
  if mode == "one_gate" then
    for _, planet in ipairs({"nauvis", "vulcanus", "gleba", "fulgora", "aquilo"}) do
      assert(hub_planets[planet], "missing hub route from " .. planet)
    end
    assert(connections.surfexp_gateway_link_hub.from == "nauvis")
    for i=1,4 do assert(not connections["surfexp_gateway_link_" .. i]) end
  else
    assert(next(hub_planets) == nil)
    for i=1,4 do assert(connections["surfexp_gateway_link_" .. i]) end
  end
  local hub = locations.surfexp_gateway_hub
  assert(hub.starmap_icon_orientation == 0)
  assert(hub.magnitude > locations.surfexp_gateway_1.magnitude)
  assert(hub.distance > 25 and hub.distance < 35)
  assert(hub.orientation > 0.225 and hub.orientation < 0.275)
  assert(count == 5 and links == (mode == "one_gate" and 5 or 4))
  assert(visible == (mode == "one_gate" and 1 or 4))
  assert(visible_links == (mode == "one_gate" and 5 or 4))
  print(mode .. ": PASS (visible=" .. visible .. ", retained locations=" .. count .. ", connections=" .. links .. ")")
end

local template = {space_dust_background = {animation_speed = 1}, platform_backdrop = {radius = 1}}
local function deepcopy(value)
  if type(value) ~= "table" then return value end
  local copy = {}
  for key, inner in pairs(value) do copy[key] = deepcopy(inner) end
  return copy
end
package.preload.util = function() return {table = {deepcopy = deepcopy}} end
data = {raw = {
  planet = {nauvis = {platform_surface_render_parameters = template}},
  ["space-location"] = {surfexp_gateway_hub = {}, surfexp_gateway_1 = {}, ["solar-system-edge"] = {}},
}}
dofile(root .. "data-updates.lua")
for _, name in ipairs({"surfexp_gateway_hub", "surfexp_gateway_1"}) do
  local parameters = assert(data.raw["space-location"][name].platform_surface_render_parameters, name .. " backdrop")
  assert(parameters.space_dust_background.animation_speed == 1, name .. " should keep the planets' space dust")
  local backdrop = parameters.platform_backdrop
  assert(backdrop ~= template.platform_backdrop and backdrop.planet_emission)
  for _, key in ipairs({"planet_surface", "planet_normal", "planet_reflectivity", "planet_emission"}) do
    local file = assert(io.open(root .. backdrop[key].filename:gsub("__surfexp_gateways__/", ""), "rb"), key .. " artwork")
    file:close()
  end
end
assert(not data.raw["space-location"]["solar-system-edge"].platform_surface_render_parameters, "other locations keep their backdrop")
assert(template.platform_backdrop.radius == 1, "the planet template should not be modified")
print("backdrop: PASS (gateways drawn under parked platforms)")
