local HUB = "surfexp_gateway_hub"
local NAUVIS_ROUTE = "surfexp_gateway_link_hub"
local SPOKE_LENGTH = 15001
local MIN_RING_RADIUS = 12
local LABEL_ROOM = 3

local function parent_of(location)
	local parent = location.orbit and location.orbit.parent
	if parent and parent.name ~= "star" then return parent end
	return nil
end

local function rectangular(distance, orientation)
	local angle = (orientation or 0) * 2 * math.pi
	return (distance or 0) * math.sin(angle), -(distance or 0) * math.cos(angle)
end

local function polar(x, y)
	return math.sqrt(x * x + y * y), (0.25 + math.atan2(y, x) / (2 * math.pi)) % 1
end

local function ring_layout()
	local ring = {}
	for _, planet in pairs(data.raw.planet or {}) do
		if not parent_of(planet) then ring[#ring + 1] = planet end
	end
	if #ring == 0 then return end
	table.sort(ring, function(a, b)
		if (a.orientation or 0) ~= (b.orientation or 0) then return (a.orientation or 0) < (b.orientation or 0) end
		return a.name < b.name
	end)
	local largest = 0
	for _, planet in ipairs(ring) do largest = math.max(largest, planet.magnitude or 1) end
	local radius = math.max(MIN_RING_RADIUS, #ring * (2 * largest + LABEL_ROOM) / (2 * math.pi))
	local old = {}
	for _, kind in pairs({"planet", "space-location"}) do
		for name, location in pairs(data.raw[kind] or {}) do
			local x, y = rectangular(location.distance, location.orientation)
			old[kind .. "/" .. name] = {x = x, y = y}
		end
	end
	local placed = {}
	for _, kind in pairs({"planet", "space-location"}) do
		for name, location in pairs(data.raw[kind] or {}) do
			if not parent_of(location) then placed[kind .. "/" .. name] = true end
		end
	end
	for index, planet in ipairs(ring) do
		planet.distance = radius
		planet.orientation = (index - 1) / #ring
		planet.label_orientation = planet.orientation
		if planet.orbit then
			planet.orbit.distance = radius
			planet.orbit.orientation = planet.orientation
		end
	end
	local progressed = true
	while progressed do
		progressed = false
		for _, kind in pairs({"planet", "space-location"}) do
			for name, location in pairs(data.raw[kind] or {}) do
				local key = kind .. "/" .. name
				local parent = parent_of(location)
				local parent_key = parent and ((parent.type or "planet") .. "/" .. parent.name)
				local parent_data = parent and data.raw[parent.type or "planet"] and data.raw[parent.type or "planet"][parent.name]
				if parent and not placed[key] and placed[parent_key] and parent_data then
					local px, py = rectangular(parent_data.distance, parent_data.orientation)
					local ox, oy
					if location.orbit.distance then
						ox, oy = rectangular(location.orbit.distance, location.orbit.orientation)
					else
						ox, oy = old[key].x - old[parent_key].x, old[key].y - old[parent_key].y
					end
					location.distance, location.orientation = polar(px + ox, py + oy)
					placed[key] = true
					progressed = true
				end
			end
		end
	end
end

if settings and settings.startup and settings.startup["surfexp-ring-layout"] and settings.startup["surfexp-ring-layout"].value then ring_layout() end

local nauvis_route = data.raw["space-connection"] and data.raw["space-connection"][NAUVIS_ROUTE]
if nauvis_route then nauvis_route.shape = "line" end

local spokes = {}
for name in pairs(data.raw.planet or {}) do
	if name ~= "nauvis" and data.raw["space-location"][HUB] then
		spokes[#spokes + 1] = {
			type = "space-connection",
			name = "surfexp_gateway_spoke_" .. name,
			subgroup = "planet-connections",
			from = name,
			to = HUB,
			order = "z[surfexp-gateway]-0-" .. name,
			length = SPOKE_LENGTH,
			shape = "line",
			icon = "__surfexp_gateways__/graphics/icons/gateway-hub.png",
			icon_size = 64,
			localised_name = {"", {"space-location-name." .. name}, " - ", {"space-location-name." .. HUB}},
		}
	end
end
if #spokes > 0 then data:extend(spokes) end

local sprites = data.raw["utility-sprites"] and data.raw["utility-sprites"].default
if not sprites then return end

sprites.starmap_star = {
	type = "sprite",
	filename = "__surfexp_gateways__/graphics/icons/starmap-clear.png",
	priority = "extra-high-no-scale",
	size = 64,
	flags = {"gui-icon"},
}
