if settings.startup["surfexp-gateway-layout"].value == "multi" then return end

local sprites = data.raw["utility-sprites"] and data.raw["utility-sprites"].default
if not sprites then return end

sprites.starmap_star = {
	type = "sprite",
	filename = "__surfexp_gateways__/graphics/icons/starmap-gateway-hub.png",
	priority = "extra-high-no-scale",
	size = 512,
	flags = {"gui-icon"},
	scale = 0.5,
}
