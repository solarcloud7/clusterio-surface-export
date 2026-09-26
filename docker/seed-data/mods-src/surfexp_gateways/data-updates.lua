local util = require("util")

local template = data.raw.planet.nauvis and data.raw.planet.nauvis.platform_surface_render_parameters
if not template then return end

local function texture(name)
	return {filename = "__surfexp_gateways__/graphics/space/gateway-" .. name .. ".png", width = 2048, height = 1024}
end

for name, location in pairs(data.raw["space-location"]) do
	if name:find("^surfexp_gateway") then
		local parameters = util.table.deepcopy(template)
		parameters.platform_backdrop = {
			radius = 600,
			position = {-680, 601},
			parallax_strength = {0.95, 0.95},
			rotation_seconds = 1000000,
			planet_axis = {90.0, 0.0},
			planet_axis_deviation_amplitude = {0.0, 0.0},
			planet_axis_deviation_seconds = {890.5, 753.7},
			light_direction = {-0.2, 0.2, 1.0},
			light_radius = 8.9,
			light_intensity_contrast = 0.15,
			cloudiness = 0,
			specular_intensity = 0.3,
			atmosphere_color = {0.05, 0.03, 0.12, 0.04},
			emission_scalar = 1.2,
			emission_scales_with_shadow = false,
			planet_surface = texture("surface"),
			planet_normal = texture("normal"),
			planet_reflectivity = texture("reflectivity"),
			planet_emission = texture("emission"),
		}
		location.platform_surface_render_parameters = parameters
	end
end
