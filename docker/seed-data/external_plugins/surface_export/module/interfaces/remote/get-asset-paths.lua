-- get-asset-paths.lua
-- Remote interface functions for discovering Factorio asset (icon) paths
-- Used by the controller to resolve mod icons for the Web UI

local GetAssetPaths = {}

-- Known vanilla planet names whose icons are bundled as static web assets.
-- These don't need Lua resolution — the web UI has their PNGs built in.
local VANILLA_PLANETS = {
	nauvis = true,
	vulcanus = true,
	gleba = true,
	fulgora = true,
	aquilo = true,
}

--- Returns icon paths for modded planets only.
-- Vanilla planets are skipped — the web UI bundles their icons as static assets.
-- @return table  { [planet_name] = { icon = "__mod__/path.png" } }
function GetAssetPaths.get_planet_icon_paths()
	local result = {}
	if not game or not game.planets then return result end
	for name, _ in pairs(game.planets) do
		if not VANILLA_PLANETS[name] then
			-- For modded planets, try to get the icon path via prototypes global.
			-- Use pcall since runtime prototype fields vary by Factorio version.
			local ok, icon_path = pcall(function()
				---@diagnostic disable-next-line: undefined-global
				local _prototypes = prototypes
				if _prototypes and _prototypes.space_location then
					local proto = _prototypes.space_location[name]
					if proto and proto.icon then
						return proto.icon
					end
				end
				return nil
			end)
			if ok and icon_path then
				result[name] = { icon = icon_path }
			end
		end
	end
	return result
end

--- Returns the icon path for an arbitrary prototype.
-- @param prototype_type  string  e.g. "item", "entity", "technology", "recipe"
-- @param prototype_name  string  prototype name
-- @return string|nil  "__mod__/path.png" or nil if not found
function GetAssetPaths.get_prototype_icon_path(prototype_type, prototype_name)
	if not prototype_type or not prototype_name then return nil end
	---@diagnostic disable-next-line: undefined-global
	local proto_table = prototypes
	if not proto_table then return nil end
	local ok, icon_path = pcall(function()
		local group = proto_table[prototype_type]
		if not group then return nil end
		local proto = group[prototype_name]
		if not proto then return nil end
		return proto.icon
	end)
	if ok then return icon_path end
	return nil
end

return GetAssetPaths
