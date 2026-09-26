local Deserializer = require("modules/surface_export/core/deserializer")
local platform_identity = require("modules/surface_export/utils/platform-identity")
local PlanetPolicy = require("modules/surface_export/core/planet-policy")

local Arrival = {}

Arrival.STAGING_MAX_AGE_TICKS = 60 * 60 * 60
Arrival.MAX_STAGED_CHUNKS = 256

local TARGETS = {
	armor = "character_armor", main = "character_main", guns = "character_guns",
	ammo = "character_ammo", trash = "character_trash",
}

local function arrivals()
	storage.surface_export_arrivals = storage.surface_export_arrivals or {}
	return storage.surface_export_arrivals
end

local function staging()
	storage.surface_export_passenger_staging = storage.surface_export_passenger_staging or {}
	return storage.surface_export_passenger_staging
end

function Arrival.stage(transfer_id, index, total, part)
	assert(type(transfer_id) == "string" and transfer_id ~= "", "transfer_id is required")
	index, total = tonumber(index), tonumber(total)
	assert(total and total >= 1 and total <= Arrival.MAX_STAGED_CHUNKS and total % 1 == 0,
		"total must be an integer from 1 to " .. Arrival.MAX_STAGED_CHUNKS)
	assert(index and index >= 1 and index <= total and index % 1 == 0, "index must be an integer from 1 to total")
	assert(type(part) == "string", "part must be a string")
	local list = staging()
	for id, staged in pairs(list) do
		if game.tick - staged.started_tick > Arrival.STAGING_MAX_AGE_TICKS then list[id] = nil end
	end
	local staged = list[transfer_id]
	if index == 1 or not staged or staged.total ~= total then
		staged = {total = total, parts = {}, started_tick = game.tick}
		list[transfer_id] = staged
	end
	staged.parts[index] = part
	local received = 0
	for i = 1, total do
		if staged.parts[i] then received = received + 1 end
	end
	return received
end

function Arrival.take_staged(transfer_id)
	local list = staging()
	local staged = list[transfer_id]
	if not staged then return nil, nil end
	list[transfer_id] = nil
	for i = 1, staged.total do
		if not staged.parts[i] then return nil, "Passenger manifest is incomplete" end
	end
	local decoded = helpers.json_to_table(table.concat(staged.parts, "", 1, staged.total))
	if type(decoded) ~= "table" then return nil, "Passenger manifest did not decode" end
	return decoded, nil
end

function Arrival.pending(player)
	local by_player = player and arrivals()[player.name]
	return by_player ~= nil and next(by_player) ~= nil
end

local function resolve_platform(record)
	local force = game.forces[record.force_name]
	local platform = force and force.platforms[record.platform_index]
	if not (platform and platform.valid) or platform_identity(platform) ~= record.platform_uid then return nil end
	return platform
end

local function unavailable(platform)
	if storage.locked_platforms and storage.locked_platforms[platform.index] then return true end
	for _, hold in pairs(storage.destination_holds or {}) do
		if type(hold) == "table" and hold.platform_index == platform.index
			and hold.surface_index == platform.surface.index then return true end
	end
	return false
end

local function ensure_body(player)
	local character = player.character
	if character and character.valid then return true end
	local controller = player.controller_type
	if controller == defines.controllers.cutscene then return false end
	if controller == defines.controllers.editor and player.stashed_controller_type ~= nil
		and player.stashed_controller_type ~= defines.controllers.god
		and player.stashed_controller_type ~= defines.controllers.spectator then
		return false
	end
	for _, associated in pairs(player.get_associated_characters()) do
		if associated.valid then
			if controller ~= defines.controllers.god then player.set_controller{type = defines.controllers.god} end
			if not player.teleport(associated.position, associated.surface) then
				error("player teleport to the existing character was refused")
			end
			player.set_controller{type = defines.controllers.character, character = associated}
			return player.character ~= nil and player.character.valid
		end
	end
	if controller ~= defines.controllers.god then player.set_controller{type = defines.controllers.god} end
	local surface = PlanetPolicy.default_surface()
	if not (surface and surface.valid) then error("the default planet surface is unavailable") end
	local anchor = {x = 0, y = 0}
	local pads = surface.find_entities_filtered{type = "cargo-landing-pad", force = player.force}
	if pads[1] and pads[1].valid then anchor = pads[1].position end
	local position = surface.find_non_colliding_position("character", anchor, 64, 0.5) or anchor
	if not player.teleport(position, surface) then error("player teleport to the default planet was refused") end
	log(string.format("[Passenger] '%s' arrived without a character; creating one", tostring(player.name)))
	return player.create_character() and player.character ~= nil and player.character.valid
end

local function place_into(inventory, item)
	if not (inventory and inventory.valid) then return false end
	local params = {name = item.name, count = item.count, quality = item.quality}
	for slot = 1, #inventory do
		local stack = inventory[slot]
		if not stack.valid_for_read then
			-- intentional probe; an item or quality missing on this instance stays in the arrival record
			local probed, accepted = pcall(function() return stack.can_set_stack(params) end)
			if probed and accepted then
				local placed, err, unrestorable = Deserializer.place_stack(stack, item)
				if placed then return true end
				if unrestorable then return false, err end
			end
		end
	end
	return false
end

local function deliver(player, record)
	if #record.items == 0 then return end
	local character = player.character
	local platform = resolve_platform(record)
	local hub = platform and not unavailable(platform) and platform.hub and platform.hub.valid
		and platform.hub.get_inventory(defines.inventory.hub_main) or nil
	local ordered = {}
	for _, item in ipairs(record.items) do
		if item.inventory == "armor" then ordered[#ordered + 1] = item end
	end
	for _, item in ipairs(record.items) do
		if item.inventory ~= "armor" then ordered[#ordered + 1] = item end
	end
	for _, item in ipairs(ordered) do
		local target = TARGETS[item.inventory]
		local placed, unrestorable = false, nil
		for _, inventory in ipairs(item.unrestorable and {} or {
			target and character.get_inventory(defines.inventory[target]) or false,
			character.get_inventory(defines.inventory.character_main) or false,
			hub or false,
		}) do
			if inventory then placed, unrestorable = place_into(inventory, item) end
			if placed or unrestorable then break end
		end
		if unrestorable then item.unrestorable = true end
		if unrestorable and not item.unrestorable_notified then
			item.unrestorable_notified = true
			log(string.format("[Passenger] '%s' for '%s' is kept in the arrival record: %s",
				tostring(item.name), tostring(player.name), unrestorable))
			player.print(tostring(item.name) .. " could not be restored on this server; it is kept for you.")
		end
		if placed then
			for index, pending in ipairs(record.items) do
				if pending == item then
					table.remove(record.items, index)
					break
				end
			end
		end
	end
	if record.notice and #record.items > 0 and not record.notice_given then
		record.notice_given = true
		player.print(record.notice)
	end
end

local function board(player, record)
	if record.boarding_done then return end
	if game.tick >= record.boarding_expires_tick then
		record.boarding_done = "expired"
		return
	end
	local platform = resolve_platform(record)
	if not platform then
		record.boarding_done = "missing"
		return
	end
	if unavailable(platform) then return end
	if player.physical_surface_index ~= platform.surface.index then
		if player.controller_type == defines.controllers.remote then player.exit_remote_view() end
		player.enter_space_platform(platform)
		if player.physical_surface_index ~= platform.surface.index then error("the platform could not be boarded") end
	end
	player.set_controller{type = defines.controllers.remote, surface = platform.surface, position = platform.hub.position}
	record.boarding_done = "boarded"
end

local function ordered_records(by_player)
	local list = {}
	for _, record in pairs(by_player) do list[#list + 1] = record end
	table.sort(list, function(a, b)
		if a.created_tick ~= b.created_tick then return a.created_tick < b.created_tick end
		return a.transfer_id < b.transfer_id
	end)
	return list
end

function Arrival.give_back(player_name, key, source, items)
	local list = arrivals()
	local by_player = list[player_name] or {}
	list[player_name] = by_player
	if by_player[key] then return false end
	by_player[key] = {
		transfer_id = key, force_name = source.force_name, platform_index = source.platform_index,
		platform_uid = source.platform_uid, items = items, created_tick = game.tick, boarding_done = "returned",
		notice = "Some of your gear did not fit and is kept for you until there is room.",
	}
	return true
end

function Arrival.process(player, joined)
	if not (player and player.valid and player.connected) then return false end
	local list = arrivals()
	local by_player = list[player.name]
	if not by_player or next(by_player) == nil then return false end
	if (storage.surface_export_passengers or {})[player.index] then return false end
	if joined then
		for _, record in pairs(by_player) do
			for _, item in ipairs(record.items) do item.unrestorable = nil end
		end
	end
	local ok, ready = pcall(ensure_body, player)
	if not ok then
		log(string.format("[Passenger] arrival body for '%s' failed: %s", tostring(player.name), tostring(ready)))
		return true
	end
	if not ready then return true end
	for _, record in ipairs(ordered_records(by_player)) do
		local delivered, deliver_error = pcall(deliver, player, record)
		if not delivered then
			log(string.format("[Passenger] gear delivery for '%s' (%s) failed: %s",
				tostring(player.name), tostring(record.transfer_id), tostring(deliver_error)))
		end
		local boarded, board_error = pcall(board, player, record)
		if not boarded and not record.boarding_error_logged then
			record.boarding_error_logged = true
			log(string.format("[Passenger] boarding for '%s' (%s) failed: %s",
				tostring(player.name), tostring(record.transfer_id), tostring(board_error)))
		end
		if #record.items == 0 and record.boarding_done then by_player[record.transfer_id] = nil end
	end
	if next(by_player) == nil then list[player.name] = nil end
	return true
end

function Arrival.process_connected()
	local list = storage.surface_export_arrivals
	if not list or next(list) == nil then return end
	for _, player in pairs(game.connected_players) do
		if list[player.name] then Arrival.process(player) end
	end
end

return Arrival
