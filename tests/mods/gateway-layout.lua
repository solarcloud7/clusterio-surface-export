local root = "docker/seed-data/mods-src/surfexp_gateways/"
local boarding
local setting_names = {}
data = {extend = function(_, list)
  for _, value in ipairs(list) do
    setting_names[#setting_names + 1] = value.name
    if value.name == "surfexp-platform-boarding" then boarding = value end
  end
end}
dofile(root .. "settings.lua")
assert(boarding.type == "bool-setting" and boarding.setting_type == "runtime-global" and boarding.default_value == true)
assert(#setting_names == 1, "only the boarding setting remains; the cluster assigns portals at runtime")

local function load_layout()
  local locations, connections = {}, {}
  settings = nil
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
  local locations, connections = load_layout()
  local count, links = 0, 0
  local hub_planets = {}
  for name, location in pairs(locations) do
    count = count + 1
    assert(location.hidden == false, name .. " is visible")
    assert(location.draw_orbit == true, name .. " draws its orbit")
    assert(not name:find("^surfexp_gateway_i_"), name .. ": per-server destinations are gone")
    local file = assert(io.open(root .. location.starmap_icon:gsub("__surfexp_gateways__/", ""), "rb"))
    file:close()
  end
  for name, connection in pairs(connections) do
    links = links + 1
    assert(locations[connection.to], connection.name .. " connects an unknown location")
    assert(not connection.hidden)
    if connection.to == "surfexp_gateway_hub" then
      assert(connection.length == 15001, connection.name .. " should be one longer than the planet's own route")
      assert(not hub_planets[connection.from], "duplicate hub route")
      hub_planets[connection.from] = true
    else
      assert(name:find("^surfexp_gateway_link_[1-4]$"), name .. " is a portal route")
    end
  end
  assert(hub_planets.nauvis, "the Gateway is reached from Nauvis")
  for _, planet in ipairs({"vulcanus", "gleba", "fulgora", "aquilo"}) do
    assert(not hub_planets[planet], planet .. " reaches the Gateway through Nauvis, not its own route")
  end
  assert(connections.surfexp_gateway_link_hub.from == "nauvis")
  local hub = locations.surfexp_gateway_hub
  local angle = hub.orientation * 2 * math.pi
  local hub_x, hub_y = hub.distance * math.sin(angle), -hub.distance * math.cos(angle)
  local colours = {"blue", "green", "orange", "purple"}
  for i = 1, 4 do
    local name = "surfexp_gateway_" .. i
    local location = assert(locations[name], name .. " portal")
    assert(location.starmap_icon:find("starmap-gateway-" .. colours[i] .. ".png", 1, true), name .. " is " .. colours[i])
    assert(math.abs(location.origin.x - hub_x) < 1e-9 and math.abs(location.origin.y - hub_y) < 1e-9, name .. " orbits the Gateway")
    assert(location.distance == 3.5, name .. " sits on the ring beside the Gateway")
    assert(math.abs(location.orientation - (i - 0.5) / 4) < 1e-9, name .. " sits on a diagonal")
    assert(location.label_orientation == location.orientation, name .. " labels point away from the Gateway")
    local gap = math.min(location.orientation, 1 - location.orientation)
    assert(gap >= 0.125 - 1e-9, name .. " would cover the Gateway's name")
    assert(location.magnitude == 0.5 and hub.magnitude > location.magnitude)
    local route = assert(connections["surfexp_gateway_link_" .. i], name .. " route")
    assert(route.from == "surfexp_gateway_hub" and route.to == name and route.length > 0 and route.length < 15001)
    assert(route.shape == "line", name .. " route is drawn straight from the Gateway")
  end
  assert(hub.starmap_icon_orientation == 0)
  assert(hub.distance == 0, "the Gateway sits at the sun")
  assert(hub.label_orientation == 0, "the Gateway's name is drawn above it")
  assert(count == 5 and links == 5)
  print("layout: PASS (the Gateway and four coloured portals on the diagonals, straight hub routes, locations=" .. count .. ", connections=" .. links .. ")")
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

do
  local original = {type = "sprite", filename = "__core__/graphics/icons/starmap-star.png", size = 512}
  settings = nil
  data = {raw = {["utility-sprites"] = {default = {starmap_star = original}}}}
  dofile(root .. "data-final-fixes.lua")
  local star = data.raw["utility-sprites"].default.starmap_star
  assert(star.filename == "__surfexp_gateways__/graphics/icons/starmap-clear.png" and star.size == 64, "the sun is blacked out")
  local file = assert(io.open(root .. star.filename:gsub("__surfexp_gateways__/", ""), "rb"))
  file:close()
end
local gateway_hub = load_layout().surfexp_gateway_hub
assert(gateway_hub.starmap_icon:find("starmap-gateway-hub.png", 1, true) and gateway_hub.starmap_icon_size == 512,
  "the Gateway draws its own portal where the sun was")
assert(gateway_hub.magnitude >= 3, "the Gateway is sun-sized so its label clears the portal")
print("eclipse: PASS (the sun is blacked out and the Gateway takes its place)")
