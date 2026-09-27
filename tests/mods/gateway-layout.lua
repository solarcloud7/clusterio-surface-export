local root = "docker/seed-data/mods-src/surfexp_gateways/"
local setting, boarding, instances_setting
data = {extend = function(_, list)
  for _, value in ipairs(list) do
    if value.name == "surfexp-gateway-layout" then setting = value end
    if value.name == "surfexp-platform-boarding" then boarding = value end
    if value.name == "surfexp-gateway-instances" then instances_setting = value end
  end
end}
dofile(root .. "settings.lua")
assert(boarding.type == "bool-setting" and boarding.setting_type == "runtime-global" and boarding.default_value == true)
assert(setting.default_value == "one_gate")
assert(setting.setting_type == "startup")
assert(instances_setting.setting_type == "startup" and instances_setting.default_value == "" and instances_setting.allow_blank)
for _, mode in ipairs(setting.allowed_values) do
  local locations, connections = {}, {}
  settings = {startup = {[setting.name] = {value = mode}, ["surfexp-gateway-instances"] = {value = ""}}}
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
    assert(hub_planets.nauvis, "the Gateway is reached from Nauvis")
    for _, planet in ipairs({"vulcanus", "gleba", "fulgora", "aquilo"}) do
      assert(not hub_planets[planet], planet .. " reaches the Gateway through Nauvis, not its own route")
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
  assert(hub.distance == 0, "the Gateway sits at the sun")
  assert(count == 5 and links == (mode == "one_gate" and 1 or 4))
  assert(visible == (mode == "one_gate" and 1 or 4))
  assert(visible_links == (mode == "one_gate" and 1 or 4))
  print(mode .. ": PASS (visible=" .. visible .. ", retained locations=" .. count .. ", connections=" .. links .. ")")
end

local function load_layout(mode, instances)
  local locations, connections = {}, {}
  settings = {startup = {[setting.name] = {value = mode}, ["surfexp-gateway-instances"] = {value = instances}}}
  data = {extend = function(_, list)
    for _, prototype in ipairs(list) do
      if prototype.type == "space-location" then locations[prototype.name] = prototype end
      if prototype.type == "space-connection" then connections[prototype.name] = prototype end
    end
  end}
  dofile(root .. "data.lua")
  return locations, connections
end

local locations, connections = load_layout("one_gate", " 11=Forge , 22,33 = Cinder Hall ,")
local hub = locations.surfexp_gateway_hub
local angle = hub.orientation * 2 * math.pi
local hub_x, hub_y = hub.distance * math.sin(angle), -hub.distance * math.cos(angle)
local labels = {["11"] = "Forge", ["22"] = "Server 22", ["33"] = "Cinder Hall"}
local orientations = {}
for name, label in pairs(labels) do
  local location = assert(locations["surfexp_gateway_i_" .. name], name .. " destination")
  assert(location.localised_name[1] == "" and location.localised_name[2] == label, name .. " label")
  assert(location.localised_description[2] == label)
  assert(location.hidden == false and location.draw_orbit == true, name .. " orbits the Gateway")
  assert(math.abs(location.origin.x - hub_x) < 1e-9 and math.abs(location.origin.y - hub_y) < 1e-9, name .. " should sit beside the hub")
  assert(location.distance > 0 and location.distance < 10)
  assert(not orientations[location.orientation], "destinations must not overlap")
  assert(location.label_orientation == location.orientation, name .. " labels point away from the Gateway")
  orientations[location.orientation] = true
  local file = assert(io.open(root .. location.starmap_icon:gsub("__surfexp_gateways__/", ""), "rb"))
  file:close()
  local route = assert(connections["surfexp_gateway_link_i_" .. name], name .. " route")
  assert(route.from == "surfexp_gateway_hub" and route.to == location.name and route.length > 0 and route.length < 15001)
end
local extra = 0
for name in pairs(locations) do if name:find("^surfexp_gateway_i_") then extra = extra + 1 end end
assert(extra == 3)
locations = load_layout("one_gate", "44=Solo")
assert(locations.surfexp_gateway_i_44.orientation == locations.surfexp_gateway_hub.orientation, "a single destination sits straight out from the hub")
locations, connections = load_layout("multi", "11=Forge")
assert(not locations.surfexp_gateway_i_11 and not connections.surfexp_gateway_link_i_11, "the four-gateway layout has no hub to route from")
for _, bad in ipairs({"fact1=Forge", "=Forge", "11,11=Again", "0=Zero", "1.5", "-3"}) do
  local ok, err = pcall(load_layout, "one_gate", bad)
  assert(not ok and tostring(err):find("surfexp-gateway-instances", 1, true), "should refuse " .. bad .. ": " .. tostring(err))
end
print("server destinations: PASS (labels, placement beside the hub, hub routes, multi ignored, bad names refused)")

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

for _, mode in ipairs({"one_gate", "multi"}) do
  local original = {type = "sprite", filename = "__core__/graphics/icons/starmap-star.png", size = 512}
  settings = {startup = {[setting.name] = {value = mode}, ["surfexp-gateway-instances"] = {value = ""}}}
  data = {raw = {["utility-sprites"] = {default = {starmap_star = original}}}}
  dofile(root .. "data-final-fixes.lua")
  local star = data.raw["utility-sprites"].default.starmap_star
  if mode == "one_gate" then
    assert(star.filename == "__surfexp_gateways__/graphics/icons/starmap-clear.png" and star.size == 64, "the sun is blacked out")
    local file = assert(io.open(root .. star.filename:gsub("__surfexp_gateways__/", ""), "rb"))
    file:close()
  else
    assert(star == original, "the four-gateway layout keeps the sun")
  end
end
local hub_one_gate = load_layout("one_gate", "").surfexp_gateway_hub
assert(hub_one_gate.starmap_icon:find("starmap-gateway-hub.png", 1, true) and hub_one_gate.starmap_icon_size == 512,
  "the Gateway draws its own portal where the sun was")
assert(hub_one_gate.magnitude >= 3, "the Gateway is sun-sized so its label clears the portal")
print("eclipse: PASS (the sun is blacked out and the Gateway takes its place)")
