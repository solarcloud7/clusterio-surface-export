local root = "docker/seed-data/mods-src/surfexp_gateways/"
local boarding, ring_setting
local setting_names = {}
data = {extend = function(_, list)
  for _, value in ipairs(list) do
    setting_names[#setting_names + 1] = value.name
    if value.name == "surfexp-platform-boarding" then boarding = value end
    if value.name == "surfexp-ring-layout" then ring_setting = value end
  end
end}
dofile(root .. "settings.lua")
assert(boarding.type == "bool-setting" and boarding.setting_type == "runtime-global" and boarding.default_value == true)
assert(ring_setting.type == "bool-setting" and ring_setting.setting_type == "startup" and ring_setting.default_value == true, "the ring layout is a startup setting, on by default")
assert(#setting_names == 2, "only the boarding and ring layout settings exist; the cluster assigns portals at runtime")

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
assert(gateway_hub.starmap_icon:find("starmap-gateway-hub-padded.png", 1, true) and gateway_hub.starmap_icon_size == 640,
  "the Gateway draws its own portal where the sun was")
assert(gateway_hub.magnitude >= 5, "the Gateway is large enough that its name sits above the portal names")
print("eclipse: PASS (the sun is blacked out and the Gateway takes its place)")

local function final_stage(ring_on)
  local raw = {
    planet = {
      nauvis = {type = "planet", name = "nauvis", distance = 15, orientation = 0.275, magnitude = 1, orbit = {parent = {type = "space-location", name = "star"}, distance = 15, orientation = 0.275}},
      vulcanus = {type = "planet", name = "vulcanus", distance = 10, orientation = 0.1, magnitude = 1.5},
      gleba = {type = "planet", name = "gleba", distance = 20, orientation = 0.45, magnitude = 1.1},
      fulgora = {type = "planet", name = "fulgora", distance = 25, orientation = 0.6, magnitude = 0.9},
      aquilo = {type = "planet", name = "aquilo", distance = 35, orientation = 0.8, magnitude = 0.6},
      luna = {type = "planet", name = "luna", distance = 17, orientation = 0.275, magnitude = 0.3, orbit = {parent = {type = "planet", name = "nauvis"}, distance = 2, orientation = 0.25}},
      trench = {type = "planet", name = "trench", hidden = true, distance = 15.6, orientation = 0.5, magnitude = 0.65},
    },
    ["space-location"] = {
      surfexp_gateway_hub = {type = "space-location", name = "surfexp_gateway_hub", distance = 0, orientation = 0.245},
      ["shattered-planet"] = {type = "space-location", name = "shattered-planet", distance = 70, orientation = 0.3},
    },
    ["space-connection"] = {surfexp_gateway_link_hub = {type = "space-connection", name = "surfexp_gateway_link_hub", from = "nauvis", to = "surfexp_gateway_hub", length = 15001}},
  }
  settings = {startup = {["surfexp-ring-layout"] = {value = ring_on}}}
  data = {raw = raw, extend = function(_, list) for _, p in ipairs(list) do raw[p.type] = raw[p.type] or {} raw[p.type][p.name] = p end end}
  dofile(root .. "data-final-fixes.lua")
  return raw
end

local function position(location)
  local angle = location.orientation * 2 * math.pi
  return location.distance * math.sin(angle), -location.distance * math.cos(angle)
end

do
  local raw = final_stage(true)
  local ring = {"vulcanus", "nauvis", "gleba", "fulgora", "aquilo"}
  local radius = raw.planet.nauvis.distance
  assert(radius >= 12, "the ring clears the Gateway and its portals")
  for index, name in ipairs(ring) do
    local planet = raw.planet[name]
    assert(math.abs(planet.distance - radius) < 1e-9, name .. " sits on the ring")
    assert(math.abs(planet.orientation - (index - 1) / #ring) < 1e-9, name .. " keeps its original order, evenly spaced")
    assert(planet.label_orientation == planet.orientation, name .. " labels point away from the Gateway")
  end
  assert(raw.planet.nauvis.orbit.distance == radius and raw.planet.nauvis.orbit.orientation == raw.planet.nauvis.orientation, "PlanetsLib orbit data follows the ring")
  local nx, ny = position(raw.planet.nauvis)
  local mx, my = position(raw.planet.luna)
  assert(math.abs(mx - (nx + 2)) < 1e-6 and math.abs(my - ny) < 1e-6, "a moon keeps its offset beside its planet")
  assert(raw["space-location"]["shattered-planet"].distance == 70, "outer locations stay where they are")
  assert(raw.planet.trench.distance == 15.6 and raw.planet.trench.orientation == 0.5, "a hidden planet stays off the ring")
  for name in pairs(raw.planet) do
    local spoke = raw["space-connection"]["surfexp_gateway_link_hub_" .. name]
    if name == "nauvis" or name == "trench" then
      assert(not spoke, name .. " gets no new spoke: Nauvis keeps its existing route and hidden planets are not destinations")
    else
      assert(spoke and spoke.from == name and spoke.to == "surfexp_gateway_hub" and spoke.length == 15001 and spoke.shape == "line" and spoke.icon, name .. " has a straight 15001 km spoke")
    end
  end
  assert(raw["space-connection"].surfexp_gateway_link_hub.shape == "line", "the Nauvis route is a straight spoke")
  assert(not raw["space-connection"]["surfexp_gateway_link_hub_shattered-planet"], "outer locations get no spoke")
  local wide = final_stage(true)
  for i = 1, 40 do wide.planet["extra" .. i] = {type = "planet", name = "extra" .. i, distance = 50, orientation = i / 41, magnitude = 1} end
  settings = {startup = {["surfexp-ring-layout"] = {value = true}}}
  data = {raw = wide, extend = function(_, list) for _, p in ipairs(list) do wide[p.type][p.name] = p end end}
  dofile(root .. "data-final-fixes.lua")
  assert(wide.planet.nauvis.distance > radius, "more planets give a wider ring")
  print("ring: PASS (planets on one ring sized by count, moons beside their planets, a spoke from every planet, outer locations unchanged)")
end

do
  local raw = final_stage(false)
  assert(raw.planet.vulcanus.distance == 10 and raw.planet.vulcanus.orientation == 0.1, "ring off keeps the original positions")
  assert(raw["space-connection"].surfexp_gateway_link_hub_fulgora, "spokes exist with the ring off")
  print("ring off: PASS (original positions, spokes still present)")
end
