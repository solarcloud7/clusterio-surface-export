local root = "docker/seed-data/mods-src/surfexp_gateways/"
local boarding, instances_setting
local setting_names = {}
data = {extend = function(_, list)
  for _, value in ipairs(list) do
    setting_names[#setting_names + 1] = value.name
    if value.name == "surfexp-platform-boarding" then boarding = value end
    if value.name == "surfexp-gateway-instances" then instances_setting = value end
  end
end}
dofile(root .. "settings.lua")
assert(boarding.type == "bool-setting" and boarding.setting_type == "runtime-global" and boarding.default_value == true)
assert(instances_setting.setting_type == "startup" and instances_setting.default_value == "" and instances_setting.allow_blank)
assert(#setting_names == 2, "only the boarding and server destination settings remain")

local function load_layout(instances)
  local locations, connections = {}, {}
  settings = {startup = {["surfexp-gateway-instances"] = {value = instances}}}
  data = {extend = function(_, list)
    for _, prototype in ipairs(list) do
      if prototype.type == "space-location" then locations[prototype.name] = prototype end
      if prototype.type == "space-connection" then connections[prototype.name] = prototype end
    end
  end}
  dofile(root .. "data.lua")
  return locations, connections
end

do
  local locations, connections = load_layout("")
  local visible, count, links = 0, 0, 0
  local hub_planets = {}
  for name, location in pairs(locations) do
    count = count + 1
    local expected = name == "surfexp_gateway_hub"
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
    assert(connection.length == 15001, connection.name .. " should be one longer than the planet's own route")
    assert(not connection.hidden)
    assert(connection.to == "surfexp_gateway_hub")
    assert(not hub_planets[connection.from], "duplicate hub route")
    hub_planets[connection.from] = true
  end
  assert(hub_planets.nauvis, "the Gateway is reached from Nauvis")
  for _, planet in ipairs({"vulcanus", "gleba", "fulgora", "aquilo"}) do
    assert(not hub_planets[planet], planet .. " reaches the Gateway through Nauvis, not its own route")
  end
  assert(connections.surfexp_gateway_link_hub.from == "nauvis")
  for i=1,4 do
    local name = "surfexp_gateway_" .. i
    local location = assert(locations[name], name .. " is kept so older saves load")
    assert(location.hidden == true and location.draw_orbit == false, name .. " is hidden")
    assert(not connections["surfexp_gateway_link_" .. i], name .. " has no route")
    for _, connection in pairs(connections) do
      assert(connection.from ~= name and connection.to ~= name, name .. " has no connections")
    end
  end
  local hub = locations.surfexp_gateway_hub
  assert(hub.starmap_icon_orientation == 0)
  assert(hub.magnitude > locations.surfexp_gateway_1.magnitude)
  assert(hub.distance == 0, "the Gateway sits at the sun")
  assert(count == 5 and links == 1 and visible == 1)
  print("layout: PASS (visible=" .. visible .. ", retained locations=" .. count .. ", connections=" .. links .. ")")
end

local locations, connections = load_layout(" 11=Forge , 22,33 = Cinder Hall ,")
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
  assert(location.distance > 0 and location.distance <= 4, name .. " should orbit close to the Gateway")
  assert(not orientations[location.orientation], "destinations must not overlap")
  assert(location.label_orientation == location.orientation, name .. " labels point away from the Gateway")
  orientations[location.orientation] = true
  local file = assert(io.open(root .. location.starmap_icon:gsub("__surfexp_gateways__/", ""), "rb"))
  file:close()
  local route = assert(connections["surfexp_gateway_link_i_" .. name], name .. " route")
  assert(route.from == "surfexp_gateway_hub" and route.to == location.name and route.length > 0 and route.length < 15001)
  assert(route.shape == "line", name .. " route is drawn straight from the Gateway")
end
local extra = 0
for name in pairs(locations) do if name:find("^surfexp_gateway_i_") then extra = extra + 1 end end
assert(extra == 3)
locations = load_layout("44=Solo")
assert(locations.surfexp_gateway_i_44.orientation == 0.5, "a single destination sits below the Gateway")
assert(locations.surfexp_gateway_hub.label_orientation == 0, "the Gateway's name is drawn above it")
for count = 1, 6 do
  local list = {}
  for i = 1, count do list[i] = tostring(10 + i) .. "=S" .. i end
  for name, location in pairs(load_layout(table.concat(list, ","))) do
    if name:find("^surfexp_gateway_i_") then
      local gap = math.min(location.orientation, 1 - location.orientation)
      assert(gap >= 0.5 / count - 1e-9, count .. " destinations: " .. name .. " would cover the Gateway's name")
    end
  end
end
for _, bad in ipairs({"fact1=Forge", "=Forge", "11,11=Again", "0=Zero", "1.5", "-3"}) do
  local ok, err = pcall(load_layout, bad)
  assert(not ok and tostring(err):find("surfexp-gateway-instances", 1, true), "should refuse " .. bad .. ": " .. tostring(err))
end
print("server destinations: PASS (labels, placement beside the hub, hub routes, bad names refused)")

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

do
  local original = {type = "sprite", filename = "__core__/graphics/icons/starmap-star.png", size = 512}
  settings = {startup = {["surfexp-gateway-instances"] = {value = ""}}}
  data = {raw = {["utility-sprites"] = {default = {starmap_star = original}}}}
  dofile(root .. "data-final-fixes.lua")
  local star = data.raw["utility-sprites"].default.starmap_star
  assert(star.filename == "__surfexp_gateways__/graphics/icons/starmap-clear.png" and star.size == 64, "the sun is blacked out")
  local file = assert(io.open(root .. star.filename:gsub("__surfexp_gateways__/", ""), "rb"))
  file:close()
end
local gateway_hub = load_layout("").surfexp_gateway_hub
assert(gateway_hub.starmap_icon:find("starmap-gateway-hub.png", 1, true) and gateway_hub.starmap_icon_size == 512,
  "the Gateway draws its own portal where the sun was")
assert(gateway_hub.magnitude >= 3, "the Gateway is sun-sized so its label clears the portal")
print("eclipse: PASS (the sun is blacked out and the Gateway takes its place)")
