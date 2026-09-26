local Gateway = require("modules/surface_export/core/gateway")
local PlanetPolicy = require("modules/surface_export/core/planet-policy")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local Receipts = require("modules/surface_export/utils/transfer-receipts")
local GameUtils = require("modules/surface_export/utils/game-utils")
local platform_identity = require("modules/surface_export/utils/platform-identity")
local PassengerWindow = require("modules/surface_export/interfaces/gui/passenger-window")
local PassengerArrival = require("modules/surface_export/core/passenger-arrival")

local Transit = {}

Transit.HOLD_SURFACE = Gateway.PASSENGER_HOLD
Transit.OFFER_TICKS = 10 * 60 * 60
Transit.JOB_WAIT_TICKS = 5 * 60
Transit.PLATFORM_GONE_TICKS = 10 * 60

local CARRIED = {
	{key = "main", inventory = "character_main"},
	{key = "guns", inventory = "character_guns"},
	{key = "ammo", inventory = "character_ammo"},
	{key = "trash", inventory = "character_trash"},
	{key = "armor", inventory = "character_armor", armor = true},
}

local function records()
	storage.surface_export_passengers = storage.surface_export_passengers or {}
	return storage.surface_export_passengers
end

local function manifests()
	storage.surface_export_passenger_manifests = storage.surface_export_passenger_manifests or {}
	return storage.surface_export_passenger_manifests
end

function Transit.record(player)
	return player and records()[player.index] or nil
end

function Transit.owns(player)
	return Transit.record(player) ~= nil
end

function Transit.carry_settings()
	if remote.interfaces["inventory_sync"] then return {armor = false, inventory = false} end
	local cfg = storage.surface_export_config or {}
	return {armor = cfg.passenger_carry_armor ~= false, inventory = cfg.passenger_carry_inventory == true}
end

function Transit.hold_surface()
	local surface = game.get_surface(Transit.HOLD_SURFACE)
	if not (surface and surface.valid) then
		surface = game.create_surface(Transit.HOLD_SURFACE, {width = 64, height = 64})
		surface.no_enemies_mode = true
		surface.peaceful_mode = true
		surface.request_to_generate_chunks({0, 0}, 1)
		surface.force_generate_chunk_requests()
		local tiles = {}
		for x = -16, 15 do
			for y = -16, 15 do tiles[#tiles + 1] = {name = "lab-dark-1", position = {x = x, y = y}} end
		end
		surface.set_tiles(tiles)
	end
	for _, force in pairs(game.forces) do force.set_surface_hidden(surface, true) end
	return surface
end

function Transit.hide_hold(force)
	local surface = game.get_surface(Transit.HOLD_SURFACE)
	if surface and surface.valid and force and force.valid then force.set_surface_hidden(surface, true) end
end

local function hold_position(surface)
	return surface.find_non_colliding_position("character", {0, 0}, 32, 0.5) or {x = 0, y = 0}
end

function Transit.landing(force)
	local surface = PlanetPolicy.default_surface()
	if not (surface and surface.valid) then return nil, nil end
	local anchor = {x = 0, y = 0}
	local pads = surface.find_entities_filtered{type = "cargo-landing-pad", force = force}
	if pads[1] and pads[1].valid then anchor = pads[1].position end
	return surface, surface.find_non_colliding_position("character", anchor, 64, 0.5) or anchor
end

local function resolve_platform(record)
	local force = record and game.forces[record.force_name]
	local platform = force and force.platforms[record.platform_index]
	if not (platform and platform.valid) or not record.platform_uid
		or platform_identity(platform) ~= record.platform_uid then return nil end
	return platform
end

local function is_locked(platform_index)
	return storage.locked_platforms ~= nil and storage.locked_platforms[platform_index] ~= nil
end

local function show_window(player, record)
	if not player.connected then return end
	local planet = PlanetPolicy.default_planet()
	if record.state == "in_transit" or (record.state == "departed" and not record.notified) then
		PassengerWindow.show_transit(player, record, planet)
	elseif record.state == "departed" then
		PassengerWindow.show_arrived(player, record, planet)
	end
end

function Transit.toggle_window(player)
	local record = Transit.record(player)
	if PassengerWindow.is_open(player) or not record then
		PassengerWindow.close(player)
		return
	end
	show_window(player, record)
end

local function connect(player, record)
	if type(record.destination_address) ~= "string" or record.destination_address == "" then return false end
	GameUtils.pcall_warn("[Passenger] connect prompt for " .. tostring(player.name), function()
		player.connect_to_server{address = record.destination_address, name = record.destination_name}
	end)
	return true
end

local function remote_view(player, platform)
	player.set_controller{type = defines.controllers.remote, surface = platform.surface, position = platform.hub.position}
end

local function park_connected(player, record, platform, hold)
	if not player.clear_cursor() then return false, "cursor" end
	player.leave_space_platform()
	local body = player.character
	if not (body and body.valid) then return false end
	record.body, record.body_unit_number = body, body.unit_number
	player.set_controller{type = defines.controllers.god}
	local position = hold_position(hold)
	if not body.teleport(position, hold) then error("character teleport to the passenger hold was refused") end
	if not player.teleport(position, hold) then error("player teleport to the passenger hold was refused") end
	remote_view(player, platform)
	return true
end

local function park_offline(player, _, _, hold)
	player.leave_space_platform()
	if player.controller_type == defines.controllers.remote then player.exit_remote_view() end
	if not player.teleport(hold_position(hold), hold) then error("offline passenger teleport to the passenger hold was refused") end
	if player.physical_surface_index ~= hold.index then error("offline passenger did not reach the passenger hold") end
	return true
end

local function reattach(player, record)
	local body = record.body
	if body and body.valid then
		if player.character ~= body then
			if player.controller_type ~= defines.controllers.god then player.set_controller{type = defines.controllers.god} end
			if not player.teleport(body.position, body.surface) then error("player teleport to the parked character was refused") end
			player.set_controller{type = defines.controllers.character, character = body}
		end
		return player.character == body
	end
	local character = player.character
	if character and character.valid then return true end
	for _, associated in pairs(player.get_associated_characters()) do
		if associated.valid then
			if player.controller_type ~= defines.controllers.god then player.set_controller{type = defines.controllers.god} end
			if not player.teleport(associated.position, associated.surface) then
				error("player teleport to the existing character was refused")
			end
			player.set_controller{type = defines.controllers.character, character = associated}
			return player.character == associated
		end
	end
	log(string.format("[Passenger] no character exists for '%s' (parked unit %s); creating one",
		tostring(player.name), tostring(record.body_unit_number)))
	if player.controller_type ~= defines.controllers.god then player.set_controller{type = defines.controllers.god} end
	return player.create_character() and player.character ~= nil
end

local function place(player, record, where)
	if where == "aboard" then
		local platform = resolve_platform(record)
		if platform and not is_locked(platform.index) then
			player.enter_space_platform(platform)
			if player.physical_surface_index == platform.surface.index then return end
			log(string.format("[Passenger] '%s' could not board '%s'; returning to the landing position",
				tostring(player.name), tostring(platform.name)))
		end
	end
	local surface, position = Transit.landing(player.force)
	if not surface then error("the default planet surface is unavailable") end
	if player.controller_type == defines.controllers.remote then player.exit_remote_view() end
	if not player.teleport(position, surface) then error("teleport to the landing position was refused") end
end

function Transit.restore(player, record, where)
	if not (player and player.valid and player.connected) then return false end
	local ok, err = pcall(function()
		if not reattach(player, record) then error("the parked character could not be reattached") end
		place(player, record, where)
	end)
	if not ok then
		log(string.format("[Passenger] restore '%s' (%s, %s) failed: %s",
			tostring(player.name), tostring(record.state), where, tostring(err)))
		return false
	end
	if records()[player.index] == record then records()[player.index] = nil end
	PassengerWindow.close(player)
	return true
end

function Transit.park(platform, target, gateway_name, players)
	local parked = {}
	if not (platform and platform.valid and platform.hub and platform.hub.valid) then return parked end
	local hold = Transit.hold_surface()
	local uid = platform_identity(platform)
	for _, player in ipairs(players or {}) do
		if player.valid and not records()[player.index] then
			local connected = player.connected
			local record = {
				state = "in_transit", player_name = player.name,
				platform_index = platform.index, platform_uid = uid, force_name = platform.force.name,
				gateway_name = gateway_name, destination_id = target.instanceId,
				destination_name = target.instanceName, destination_address = target.address,
				started_tick = game.tick,
			}
			records()[player.index] = record
			local ok, err, reason = pcall(connected and park_connected or park_offline, player, record, platform, hold)
			if ok and err then
				parked[#parked + 1] = player.index
				show_window(player, record)
			elseif ok then
				records()[player.index] = nil
				if reason == "cursor" then
					player.print("The item in your hand could not be put away, so you were not held for the transfer. You will be moved to the planet when the platform leaves.")
				end
			else
				log(string.format("[Passenger] parking '%s' from '%s' failed: %s",
					tostring(player.name), tostring(platform.name), tostring(err)))
				record.state = "returned"
				Transit.restore(player, record, "aboard")
			end
		end
	end
	return parked
end

function Transit.assign_job(parked, job_id)
	for _, index in ipairs(parked or {}) do
		local record = records()[index]
		if record and record.state == "in_transit" then record.job_id = job_id end
	end
end

function Transit.return_parked(parked)
	for _, index in ipairs(parked or {}) do
		local record = records()[index]
		if record and record.state == "in_transit" and not record.job_id then
			record.state = "returned"
			Transit.restore(game.get_player(index), record, "aboard")
		end
	end
end

local function give_back(record, job_id)
	local manifest = manifests()[job_id]
	if not manifest then return end
	for position, entry in ipairs(manifest) do
		if entry.name == record.player_name then
			if #(entry.items or {}) > 0 then
				PassengerArrival.give_back(record.player_name, "returned:" .. job_id, record, entry.items)
			end
			table.remove(manifest, position)
			break
		end
	end
	if #manifest == 0 then manifests()[job_id] = nil end
end

function Transit.transfer_released(job_id)
	if type(job_id) ~= "string" or job_id == "" then return end
	local confirmed = Receipts.get("source_deleted", job_id) ~= nil
	for index, record in pairs(records()) do
		local unconfirmed = record.state == "departed" and not record.notified and not confirmed
		if record.job_id == job_id and (record.state == "in_transit" or unconfirmed) then
			if unconfirmed then give_back(record, job_id) end
			record.state = "returned"
			local player = game.get_player(index)
			if Transit.restore(player, record, "aboard") then
				GameUtils.pcall_warn("[Passenger] give back gear to " .. tostring(player.name), function() PassengerArrival.process(player) end)
			end
		end
	end
	if confirmed then Transit.notify_departed(job_id) end
end

function Transit.abort(player)
	local record = Transit.record(player)
	if not (record and record.state == "in_transit") then return false end
	local lock = storage.locked_platforms and storage.locked_platforms[record.platform_index]
	if lock and lock.kind == "transfer" and lock.phase == "committed" and lock.transfer_job_id == record.job_id then
		player.print("This transfer is being reconciled by an administrator. You stay held until it is resolved.")
		return false
	end
	record.state = "aborted"
	return Transit.restore(player, record, "landing")
end

local function armor_fits(body)
	local armor = body.get_inventory(defines.inventory.character_armor)
	local main = body.get_inventory(defines.inventory.character_main)
	if not (armor and main) then return true end
	local bonus = 0
	for slot = 1, #armor do
		local stack = armor[slot]
		if stack.valid_for_read then
			bonus = bonus + (stack.prototype.get_inventory_size_bonus(stack.quality) or 0)
			local grid = stack.grid
			for _, equipment in ipairs(grid and grid.equipment or {}) do bonus = bonus + (equipment.inventory_bonus or 0) end
		end
	end
	if bonus == 0 then return true end
	local highest = 0
	for slot = 1, #main do
		if main[slot].valid_for_read then highest = slot end
	end
	return highest <= #main - bonus
end

local function carried_stacks(body, carry)
	local stacks = {}
	local armor = carry.armor and (carry.inventory or armor_fits(body))
	for _, spec in ipairs(CARRIED) do
		if (spec.armor and armor) or (not spec.armor and carry.inventory) then
			local inventory = body.get_inventory(defines.inventory[spec.inventory])
			for slot = 1, inventory and #inventory or 0 do
				local stack = inventory[slot]
				if stack.valid_for_read then stacks[#stacks + 1] = {stack = stack, key = spec.key} end
			end
		end
	end
	return stacks, carry.armor and not armor
end

function Transit.depart(job_id)
	local list = manifests()
	list[job_id] = list[job_id] or {}
	local manifest = list[job_id]
	local carry = Transit.carry_settings()
	for index, record in pairs(records()) do
		if record.job_id == job_id and record.state == "in_transit" then
			local player = game.get_player(index)
			local entry = {name = player and player.name or record.player_name, items = {}}
			local stacks, kept_armor = {}, false
			local read, read_err = pcall(function()
				if record.body and record.body.valid then stacks, kept_armor = carried_stacks(record.body, carry) end
				for _, carried in ipairs(stacks) do
					local item = InventoryScanner.extract_item_properties(carried.stack)
					item.inventory = carried.key
					entry.items[#entry.items + 1] = item
				end
			end)
			if not read then
				log(string.format("[Passenger] reading the carried gear of '%s' failed; it stays on the body: %s",
					tostring(entry.name), tostring(read_err)))
				if player and player.connected then player.print("Your gear could not be read, so it stays here and you travel without it.") end
				stacks, kept_armor, entry.items = {}, false, {}
			end
			local extracted = entry.items
			entry.items = {}
			for position, carried in ipairs(stacks) do
				local cleared, clear_err = pcall(carried.stack.clear)
				if cleared and not carried.stack.valid_for_read then
					entry.items[#entry.items + 1] = extracted[position]
				else
					log(string.format("[Passenger] a carried stack of '%s' could not be removed and stays on the body: %s",
						tostring(entry.name), tostring(clear_err)))
				end
			end
			record.state = "departed"
			record.departed_tick = game.tick
			manifest[#manifest + 1] = entry
			if kept_armor then
				log(string.format("[Passenger] '%s' keeps their armor: its inventory slots are full", tostring(entry.name)))
				if player and player.connected then player.print("Your armor stayed behind: removing it would spill your inventory.") end
			end
		end
	end
	return manifest
end

function Transit.settle(job_id)
	manifests()[job_id] = nil
end

function Transit.manifest(job_id)
	local receipt = Receipts.get("source_deleted", job_id)
	if receipt then return receipt.passengers or {} end
	return nil
end

function Transit.notify_departed(job_id)
	for index, record in pairs(records()) do
		if record.job_id == job_id and record.state == "departed" and not record.notified then
			record.notified, record.notified_tick = true, game.tick
			local player = game.get_player(index)
			if player and player.connected then
				GameUtils.pcall_warn("[Passenger] move the departed view of " .. tostring(player.name), function()
					local surface, position = Transit.landing(player.force)
					if surface then player.set_controller{type = defines.controllers.remote, surface = surface, position = position} end
				end)
				GameUtils.pcall_warn("[Passenger] arrival window for " .. tostring(player.name), function() show_window(player, record) end)
				connect(player, record)
			end
		end
	end
end

local function resume(player, record)
	local hold = Transit.hold_surface()
	local body = record.body
	if not (body and body.valid) then
		body = player.character
		if body and body.valid then record.body, record.body_unit_number = body, body.unit_number end
	end
	player.set_controller{type = defines.controllers.god}
	if body and body.valid and body.surface.index ~= hold.index then
		if not body.teleport(hold_position(hold), hold) then error("character teleport to the passenger hold was refused") end
	end
	player.teleport(hold_position(hold), hold)
	local platform = resolve_platform(record)
	if platform and platform.hub and platform.hub.valid then remote_view(player, platform) end
end

function Transit.on_join(player)
	local record = Transit.record(player)
	if not record then return false end
	if record.state == "in_transit" or (record.state == "departed" and not record.notified) then
		GameUtils.pcall_warn("[Passenger] resume transit for " .. tostring(player.name), function() resume(player, record) end)
		show_window(player, record)
	elseif record.state == "departed" or record.state == "aborted" then
		Transit.restore(player, record, "landing")
	else
		Transit.restore(player, record, "aboard")
	end
	return true
end

function Transit.on_tick()
	local list = storage.surface_export_passengers
	if not list or next(list) == nil then return end
	local settled = {}
	for index, record in pairs(list) do
		local player = game.get_player(index)
		if record.state == "departed" and not record.notified and record.job_id then
			if Receipts.get("source_deleted", record.job_id) then
				settled[record.job_id] = true
			elseif resolve_platform(record) then
				record.platform_missing_tick = nil
			else
				record.platform_missing_tick = record.platform_missing_tick or game.tick
				if game.tick - record.platform_missing_tick >= Transit.PLATFORM_GONE_TICKS then settled[record.job_id] = true end
			end
		end
		if record.state == "in_transit" and not record.job_id
			and game.tick >= (record.started_tick or 0) + Transit.JOB_WAIT_TICKS then
			log(string.format("[Passenger] '%s' was parked without a transfer job; returning aboard", tostring(record.player_name)))
			record.state = "returned"
		end
		if not player then
			list[index] = nil
		elseif player.connected then
			if record.state == "departed" and record.notified
				and game.tick >= (record.notified_tick or 0) + Transit.OFFER_TICKS then
				Transit.restore(player, record, "landing")
			elseif record.state == "aborted" then
				Transit.restore(player, record, "landing")
			elseif record.state == "returned" then
				Transit.restore(player, record, "aboard")
			end
		end
	end
	for job_id in pairs(settled) do
		log(string.format("[Passenger] source deletion of %s is settled; notifying its departed passengers", job_id))
		Transit.notify_departed(job_id)
	end
end

function Transit.on_gui_click(event)
	local element = event.element
	if not (element and element.valid and type(element.name) == "string") then return end
	local name = element.name
	if name:sub(1, #PassengerWindow.PREFIX) ~= PassengerWindow.PREFIX then return end
	local player = game.get_player(event.player_index)
	if not player then return end
	local record = Transit.record(player)
	if name == PassengerWindow.CLOSE or not record then
		PassengerWindow.close(player)
	elseif name == PassengerWindow.ABORT then
		if Transit.abort(player) then
			player.print("Transfer aborted. You stayed behind.")
		elseif Transit.record(player) then
			if Transit.record(player).state == "departed" then player.print("The platform has already left; the transfer can no longer be aborted.") end
			show_window(player, Transit.record(player))
		end
	elseif name == PassengerWindow.STAY and record.state == "departed" and record.notified then
		Transit.restore(player, record, "landing")
	elseif name == PassengerWindow.JOIN and record.state == "departed" and record.notified then
		connect(player, record)
	end
end

function Transit.on_gui_closed(event)
	local element = event.element
	if element and element.valid and element.name == PassengerWindow.FRAME then
		PassengerWindow.close(game.get_player(event.player_index))
	end
end

return Transit
