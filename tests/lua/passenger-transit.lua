local root = "docker/seed-data/external_plugins/surface_export/module/"
local noop = function() end

local controllers = {character = 1, god = 2, editor = 3, cutscene = 4, spectator = 5, remote = 6}
local inventory_ids = {character_main = 1, character_guns = 3, character_ammo = 4, character_armor = 5, character_trash = 8, hub_main = 20}

local counter = 0
local function gui(parent, values)
	local element = values or {}
	counter = counter + 1
	element.valid, element.index, element.style = true, counter, {}
	element.children = {}
	element.enabled = element.enabled ~= false
	element.add = function(spec)
		local child = gui(element, spec)
		element.children[#element.children + 1] = child
		if spec.name then element[spec.name] = child end
		return child
	end
	element.destroy = function()
		element.valid = false
		if parent and element.name then parent[element.name] = nil end
	end
	return element
end
local function find(element, name)
	for _, child in ipairs(element.children) do
		if child.name == name then return child end
		local nested = find(child, name)
		if nested then return nested end
	end
end

local surfaces, surfaces_by_name = {}, {}
local function surface(name, index)
	local s = {valid = true, name = name, index = index, pads = {}}
	s.find_non_colliding_position = function(_, anchor) return {x = anchor.x or anchor[1], y = anchor.y or anchor[2]} end
	s.find_entities_filtered = function(filter)
		assert(filter.type == "cargo-landing-pad" and filter.force, "landing pad search must be scoped to the force")
		return s.pads
	end
	s.request_to_generate_chunks = noop
	s.force_generate_chunk_requests = noop
	surfaces[index], surfaces_by_name[name] = s, s
	return s
end
local nauvis = surface("nauvis", 1)
local default_surface = nauvis
local ship_surface = surface("platform-7", 70)

local function stack(name, count, extra)
	local s = {valid_for_read = true, name = name, count = count, quality = {name = "normal"},
		prototype = {type = extra and extra.type or "item", get_inventory_size_bonus = function() return extra and extra.bonus or 0 end}}
	s.clear = function()
		s.valid_for_read, s.name, s.count = false, nil, nil
	end
	return s
end
local function empty()
	local s = stack(nil, nil)
	s.valid_for_read = false
	return s
end
local function inventory(size, items)
	local inv = {valid = true}
	for slot = 1, size do
		inv[slot] = items and items[slot] or empty()
	end
	inv.sort_and_merge = function()
		local filled = {}
		for slot = 1, size do if inv[slot].valid_for_read then filled[#filled + 1] = inv[slot] end end
		for slot = 1, size do
			inv[slot] = filled[slot] or empty()
		end
		inv.sorted = true
	end
	inv.count_empty_stacks = function()
		local n = 0
		for slot = 1, size do if not inv[slot].valid_for_read then n = n + 1 end end
		return n
	end
	return inv
end

local characters = {}
local function character(where, inventories)
	local c = {valid = true, name = "character", surface = where, position = {x = 0, y = 0}, unit_number = 100 + #characters,
		inventories = inventories or {}}
	c.get_inventory = function(id) return c.inventories[id] end
	c.teleport = function(position, target)
		c.position, c.surface = {x = position.x or position[1], y = position.y or position[2]}, target or c.surface
		return true
	end
	characters[#characters + 1] = c
	return c
end

local created = 0
local players = {}
local function new_player(index, name, connected, body)
	local p = {index = index, name = name, valid = true, connected = connected, force = {name = "player"},
		gui = {screen = gui()}, printed = {}, connects = {}, in_hub = true,
		controller_type = controllers.remote, physical_surface_index = ship_surface.index,
		surface_index = ship_surface.index, position = {x = 0, y = 0}}
	p.stored = body
	p.character = connected and body or nil
	if body then body.surface = ship_surface; body.player = p end
	local function attached() return p.connected and p.character or p.stored end
	p.print = function(message) p.printed[#p.printed + 1] = message end
	p.leave_space_platform = function()
		if not p.in_hub then return end
		p.in_hub = false
		local body_now = attached()
		if body_now then body_now.surface = surfaces[p.physical_surface_index] end
		p.controller_type = controllers.character
		p.surface_index = p.physical_surface_index
	end
	p.exit_remote_view = function()
		if p.controller_type == controllers.remote and not p.in_hub then
			p.controller_type = attached() and controllers.character or controllers.god
			p.surface_index = p.physical_surface_index
		end
	end
	p.set_controller = function(spec)
		if spec.type == controllers.god then
			if p.character then p.character.player = nil end
			if p.controller_type == controllers.remote then p.physical_surface_index = p.surface_index end
			p.character, p.stored = nil, nil
			p.in_hub = false
			p.controller_type = controllers.god
			p.surface_index = p.physical_surface_index
		elseif spec.type == controllers.remote then
			p.controller_type = controllers.remote
			p.surface_index = spec.surface.index
			p.view_position = spec.position
		elseif spec.type == controllers.character then
			local c = spec.character
			assert(c and c.valid, "set_controller needs a valid character")
			assert(c.surface.index == p.physical_surface_index, "set_controller{character} needs the character on the player's surface")
			assert(c.player == nil, "the character belongs to another player")
			p.character, c.player = c, p
			p.controller_type = controllers.character
			p.surface_index = p.physical_surface_index
		end
	end
	p.teleport = function(position, target)
		if p.teleport_refused then return false end
		target = target or surfaces[p.physical_surface_index]
		if p.controller_type == controllers.remote then
			p.surface_index = target.index
			return true
		end
		p.physical_surface_index, p.surface_index = target.index, target.index
		p.position = {x = position.x or position[1], y = position.y or position[2]}
		local body_now = attached()
		if body_now then body_now.surface, body_now.position = target, p.position end
		return true
	end
	p.enter_space_platform = function(platform)
		assert(attached(), "entering a platform needs a character")
		p.physical_surface_index, p.surface_index = platform.surface.index, platform.surface.index
		attached().surface = platform.surface
		p.in_hub = true
		p.controller_type = controllers.remote
		return true
	end
	p.connect_to_server = function(spec) p.connects[#p.connects + 1] = spec end
	p.create_character = function()
		created = created + 1
		local c = character(surfaces[p.physical_surface_index])
		p.character, c.player = c, p
		p.controller_type = controllers.character
		return true
	end
	p.associated = {}
	p.get_associated_characters = function() return p.associated end
	p.clear_cursor = function() return not p.cursor_stuck end
	p.join = function()
		p.connected = true
		if p.stored then p.character, p.stored = p.stored, nil end
	end
	players[index] = p
	return p
end

local force = {name = "player", valid = true, platforms = {}, hidden = {}}
force.set_surface_hidden = function(s, hidden) force.hidden[s.name] = hidden end
local platform = {valid = true, index = 7, name = "Ship", uid = "uid:7", surface = ship_surface, force = force,
	hub = {valid = true, position = {x = 0.5, y = 0.5}}}
ship_surface.platform = platform
force.platforms[7] = platform

local logged = {}
local env = setmetatable({
	storage = {surface_export_config = {}},
	defines = {controllers = controllers, inventory = inventory_ids},
	remote = {interfaces = {}},
	prototypes = {space_location = {nauvis = {localised_name = "Nauvis"}}},
	helpers = {is_valid_sprite_path = function() return true end},
	log = function(message) logged[#logged + 1] = message end,
	game = {tick = 1000, forces = {player = force}, get_player = function(index) return players[index] end},
}, {__index = _G})
env.game.get_surface = function(key) return type(key) == "number" and surfaces[key] or surfaces_by_name[key] end
env.game.create_surface = function(name, settings)
	assert(settings.width == 64 and settings.height == 64, "the passenger hold is a small surface")
	return surface(name, 90)
end

local window = assert(loadfile(root .. "interfaces/gui/passenger-window.lua", "t", env))()
local receipts = assert(loadfile(root .. "utils/transfer-receipts.lua", "t", env))()
local util_stub = {QUALITY_NORMAL = "normal"}
env.require = function(name)
	if name:find("utils/util", 1, true) then return util_stub end
	if name:find("fluid-registry", 1, true) then return {} end
	error(name)
end
local scanner = assert(loadfile(root .. "export_scanners/inventory-scanner.lua", "t", env))()
env.require = function(name)
	if name:find("core/gateway", 1, true) then return {PASSENGER_HOLD = "surfexp_passenger_hold"} end
	if name:find("planet-policy", 1, true) then
		return {default_surface = function() return default_surface end, default_planet = function() return "nauvis" end}
	end
	if name:find("inventory-scanner", 1, true) then return scanner end
	if name:find("transfer-receipts", 1, true) then return receipts end
	if name:find("game-utils", 1, true) then
		return {pcall_warn = function(context, fn)
			local ok, err = pcall(fn)
			if not ok then logged[#logged + 1] = context .. ": " .. tostring(err) end
		end}
	end
	if name:find("platform-identity", 1, true) then return function(p) return p.valid and p.uid or nil end end
	if name:find("passenger-window", 1, true) then return window end
	error(name)
end
local transit = assert(loadfile(root .. "core/passenger-transit.lua", "t", env))()
local target = {instanceId = 2, instanceName = "Two", address = "10.0.0.2:34197"}

local function gear(opts)
	opts = opts or {}
	local armor = stack("power-armor", 1, {type = "armor", bonus = opts.bonus or 0})
	armor.grid = {valid = true, equipment = {{name = "battery-equipment", position = {x = 0, y = 0}, quality = {name = "normal"}}}}
	local main_items = {}
	for slot = 1, opts.filled or 2 do main_items[slot] = stack(slot == 1 and "iron-plate" or "copper-plate", 50) end
	return {
		[inventory_ids.character_armor] = inventory(1, {armor}),
		[inventory_ids.character_main] = inventory(opts.main or 80, main_items),
		[inventory_ids.character_guns] = inventory(3, {stack("pistol", 1)}),
		[inventory_ids.character_ammo] = inventory(3, {stack("firearm-magazine", 10)}),
		[inventory_ids.character_trash] = inventory(10),
	}
end
local function count_items(c)
	local n = 0
	for _, inv in pairs(c.inventories) do
		for slot = 1, #inv do if inv[slot].valid_for_read then n = n + inv[slot].count end end
	end
	return n
end

local alice_body = character(nil, gear())
local alice = new_player(1, "alice", true, alice_body)
local bob_body = character(nil, gear())
local bob = new_player(2, "bob", false, bob_body)

local parked = transit.park(platform, target, "surfexp_gateway_hub", {alice, bob})
local hold = env.game.get_surface("surfexp_passenger_hold")
assert(hold and force.hidden.surfexp_passenger_hold == true and hold.no_enemies_mode, "the hold surface should exist, hidden and without enemies")
assert(#parked == 2 and parked[1] == 1 and parked[2] == 2, "both passengers should be parked")
local a = env.storage.surface_export_passengers[1]
assert(a.state == "in_transit" and a.body == alice_body and a.destination_address == "10.0.0.2:34197" and a.platform_uid == "uid:7")
assert(alice.character == nil and alice_body.surface == hold and alice_body.player == nil, "a connected passenger's body should be parked on the hold")
assert(alice.physical_surface_index == hold.index, "a parked passenger should no longer be physically aboard")
assert(alice.controller_type == controllers.remote and alice.surface_index == ship_surface.index, "a parked passenger should watch the platform")
local frame = alice.gui.screen[window.FRAME]
assert(frame and find(frame, window.ABORT).sprite == "space-location/nauvis", "the transit window should offer Abort with the default planet icon")
assert(find(frame, window.PREFIX .. "title").caption[3] == "Two", "the transit window should name the destination")
local b = env.storage.surface_export_passengers[2]
assert(b.state == "in_transit" and b.body == nil and bob.physical_surface_index == hold.index and bob_body.surface == hold,
	"an offline passenger should be moved with their stored body")
assert(transit.owns(alice) and transit.owns(bob))
local zed = new_player(20, "zed", true, nil)
zed.in_hub, zed.controller_type = false, controllers.editor
assert(#transit.park(platform, target, "surfexp_gateway_hub", {zed}) == 0 and not transit.owns(zed),
	"a connected player aboard without a character is not parked")
print("PASS pressing Transfer parks connected and offline passengers on the hidden hold")

transit.return_parked(parked)
assert(not transit.owns(alice) and alice.character == alice_body and alice.in_hub and alice.physical_surface_index == ship_surface.index,
	"a transfer that fails to start should put a connected passenger back aboard in their own body")
assert(not alice.gui.screen[window.FRAME], "the transit window should close when the passenger is restored")
assert(env.storage.surface_export_passengers[2].state == "returned", "an offline passenger's return waits for their next join")
bob.join()
transit.on_join(bob)
assert(not transit.owns(bob) and bob.character == bob_body and bob.in_hub and bob.physical_surface_index == ship_surface.index,
	"an offline passenger should rejoin aboard after a failed start")
print("PASS a transfer that fails to start returns everyone aboard")

parked = transit.park(platform, target, "surfexp_gateway_hub", {alice})
transit.assign_job(parked, "job-1")
nauvis.pads = {{valid = true, position = {x = 12, y = -4}}}
transit.on_gui_click{player_index = 1, element = find(alice.gui.screen[window.FRAME], window.ABORT)}
assert(not transit.owns(alice) and alice.character == alice_body, "Abort should restore the passenger's own body")
assert(alice.physical_surface_index == nauvis.index and alice.position.x == 12 and alice.position.y == -4,
	"Abort should land the passenger at the default planet's landing pad")
assert(#transit.depart("job-1") == 0, "an aborted passenger should not be in the manifest")
nauvis.pads = {}
parked = transit.park(platform, target, "surfexp_gateway_hub", {alice})
transit.assign_job(parked, "job-1b")
assert(transit.abort(alice) and alice.position.x == 0 and alice.position.y == 0, "without a landing pad Abort should land at 0,0")
parked = transit.park(platform, target, "surfexp_gateway_hub", {alice})
transit.assign_job(parked, "job-1c")
default_surface = nil
assert(not transit.abort(alice) and env.storage.surface_export_passengers[1].state == "aborted",
	"an Abort that cannot land yet stays pending")
assert(#transit.depart("job-1c") == 0 and env.storage.surface_export_passengers[1].state == "aborted",
	"a pending Abort is still excluded from the manifest")
default_surface = nauvis
transit.on_tick()
assert(not transit.owns(alice) and alice.character == alice_body and alice.physical_surface_index == nauvis.index,
	"a pending Abort lands the passenger once the planet is available")
print("PASS Abort lands the passenger at the landing pad or 0,0 and excludes them from the manifest")

alice.physical_surface_index, alice.in_hub, alice.controller_type = ship_surface.index, true, controllers.remote
alice_body.surface = ship_surface
bob.physical_surface_index, bob.in_hub, bob.controller_type = ship_surface.index, true, controllers.remote
bob_body.surface = ship_surface
bob.connected, bob.character, bob.stored = false, nil, bob_body
local carol_body = character(nil, gear())
local carol = new_player(3, "carol", true, carol_body)
parked = transit.park(platform, target, "surfexp_gateway_hub", {alice, bob, carol})
transit.assign_job(parked, "job-2")
local alice_before = count_items(alice_body)
local manifest = transit.depart("job-2")
assert(#manifest == 3, "every in-transit passenger of the job should be in the manifest")
local by_name = {}
for _, entry in ipairs(manifest) do by_name[entry.name] = entry end
assert(#by_name.alice.items == 1 and by_name.alice.items[1].name == "power-armor" and by_name.alice.items[1].inventory == "armor",
	"only the armor should be carried by default")
assert(by_name.alice.items[1].grid and by_name.alice.items[1].grid.equipment[1].name == "battery-equipment", "the armor grid should be serialized")
assert(not alice_body.inventories[inventory_ids.character_armor][1].valid_for_read, "the carried armor should leave the parked body")
assert(count_items(alice_body) == alice_before - 1, "only the carried stacks should be removed")
assert(#by_name.bob.items == 0, "an offline passenger's unreachable gear is not carried")
assert(env.storage.surface_export_passengers[1].state == "departed" and env.storage.surface_export_passengers[2].state == "departed")
assert(transit.depart("job-2") == manifest and #manifest == 3, "a retried delete should return the same manifest without stripping again")
receipts.put("source_deleted", "job-2", {passengers = manifest})
transit.settle("job-2")
assert(transit.manifest("job-2") == manifest and transit.manifest("job-x") == nil, "the manifest should be read from the deletion receipt")
print("PASS success strips only carried stacks, marks passengers departed and keeps an idempotent manifest")

transit.notify_departed("job-2")
assert(#alice.connects == 1 and alice.connects[1].address == "10.0.0.2:34197" and alice.connects[1].name == "Two",
	"a connected departed passenger should get the connect prompt")
assert(alice.surface_index == nauvis.index, "the departed passenger's view should move off the deleted platform")
frame = alice.gui.screen[window.FRAME]
assert(frame and find(frame, window.JOIN).enabled and find(frame, window.STAY).sprite == "space-location/nauvis",
	"the arrived window should offer Join and Stay")
assert(#bob.connects == 0, "an offline passenger cannot be prompted")
transit.notify_departed("job-2")
assert(#alice.connects == 1, "the departure notice should be sent once")
transit.on_gui_click{player_index = 1, element = find(frame, window.JOIN)}
assert(#alice.connects == 2, "Join should send the connect prompt again")
transit.on_gui_click{player_index = 1, element = find(alice.gui.screen[window.FRAME], window.STAY)}
assert(not transit.owns(alice) and alice.character == alice_body and alice.physical_surface_index == nauvis.index,
	"Stay should restore the departed passenger at the landing position")
assert(not alice_body.inventories[inventory_ids.character_armor][1].valid_for_read, "the carried armor stays with the ship")
env.game.tick = env.game.tick + 100
transit.on_tick()
assert(transit.owns(carol), "a departed passenger keeps the offer for ten minutes")
env.game.tick = env.storage.surface_export_passengers[3].departed_tick + transit.OFFER_TICKS
transit.on_tick()
assert(not transit.owns(carol) and carol.character == carol_body and carol.physical_surface_index == nauvis.index,
	"a passenger still here after ten minutes should be restored at the landing position")
bob.join()
transit.on_join(bob)
assert(not transit.owns(bob) and bob.character == bob_body and bob.physical_surface_index == nauvis.index and count_items(bob_body) > 0,
	"an offline departed passenger should rejoin at the landing position with their own gear")
print("PASS departed passengers get the connect prompt, and Stay, the timeout or a later join lands them")

env.storage.surface_export_config.passenger_carry_inventory = true
local dave_body = character(nil, gear())
local dave = new_player(4, "dave", true, dave_body)
parked = transit.park(platform, target, "surfexp_gateway_hub", {dave})
transit.assign_job(parked, "job-3")
manifest = transit.depart("job-3")
assert(#manifest[1].items == 5 and count_items(dave_body) == 0, "with inventory carry on, armor, main, guns and ammo should all go")
local order = {}
for _, item in ipairs(manifest[1].items) do order[#order + 1] = item.inventory end
assert(order[#order] == "armor", "the armor should be removed last so its bonus slots are already empty")
env.storage.surface_export_config.passenger_carry_inventory = false
env.remote.interfaces.inventory_sync = {}
local erin_body = character(nil, gear())
local erin = new_player(5, "erin", true, erin_body)
parked = transit.park(platform, target, "surfexp_gateway_hub", {erin})
transit.assign_job(parked, "job-4")
local erin_before = count_items(erin_body)
manifest = transit.depart("job-4")
assert(#manifest == 1 and #manifest[1].items == 0 and count_items(erin_body) == erin_before, "inventory_sync disables gear carry-over")
env.remote.interfaces.inventory_sync = nil
local fay_body = character(nil, gear({bonus = 10, main = 90, filled = 85}))
local fay = new_player(6, "fay", true, fay_body)
parked = transit.park(platform, target, "surfexp_gateway_hub", {fay})
transit.assign_job(parked, "job-5")
manifest = transit.depart("job-5")
assert(#manifest[1].items == 0 and fay_body.inventories[inventory_ids.character_armor][1].valid_for_read,
	"armor whose bonus slots are in use should stay rather than spill the inventory")
assert(#fay.printed == 1, "the passenger should be told their armor stayed")
print("PASS inventory carry, inventory_sync and full armor pockets change only what is carried")

local gil_body = character(nil, gear())
local gil = new_player(7, "gil", true, gil_body)
local hana_body = character(nil, gear())
local hana = new_player(8, "hana", false, hana_body)
parked = transit.park(platform, target, "surfexp_gateway_hub", {gil, hana})
transit.assign_job(parked, "job-6")
transit.transfer_released("job-other")
assert(transit.owns(gil), "another job's release should not return these passengers")
transit.transfer_released("job-6")
assert(not transit.owns(gil) and gil.character == gil_body and gil.in_hub and gil.physical_surface_index == ship_surface.index,
	"a failed transfer should put the connected passenger back aboard")
assert(env.storage.surface_export_passengers[8].state == "returned")
env.storage.locked_platforms = {[7] = {kind = "transfer"}}
hana.join()
transit.on_join(hana)
assert(not transit.owns(hana) and hana.character == hana_body and hana.physical_surface_index == nauvis.index,
	"a returned passenger whose platform is locked again should land on the default planet")
env.storage.locked_platforms = nil
print("PASS a failed transfer returns passengers aboard, or to the planet when the platform is unavailable")

local ivy_body = character(nil, gear())
local ivy = new_player(9, "ivy", false, ivy_body)
parked = transit.park(platform, target, "surfexp_gateway_hub", {ivy})
transit.assign_job(parked, "job-7")
ivy.join()
transit.on_join(ivy)
local ivy_record = env.storage.surface_export_passengers[9]
assert(ivy_record.state == "in_transit" and ivy_record.body == ivy_body and ivy.character == nil and ivy_body.surface == hold,
	"an in-transit passenger who joins should be parked bodiless again")
assert(ivy.controller_type == controllers.remote and ivy.surface_index == ship_surface.index and ivy.gui.screen[window.FRAME],
	"a joining in-transit passenger should watch the platform with the transit window")
manifest = transit.depart("job-7")
assert(#manifest[1].items == 1, "a passenger parked at join carries their armor")
print("PASS joining while in transit parks the passenger again and shows the transit window")

assert(created == 0, "no flow above may create a second body")
local jay_body = character(nil, gear())
local jay = new_player(10, "jay", true, jay_body)
parked = transit.park(platform, target, "surfexp_gateway_hub", {jay})
transit.assign_job(parked, "job-8")
jay_body.valid = false
transit.transfer_released("job-8")
assert(created == 1 and jay.character and jay.character ~= jay_body and not transit.owns(jay),
	"a body is created only when the parked body no longer exists")
print("PASS a body is created only when the passenger has none")

local kay_body = character(nil, gear())
local kay = new_player(11, "kay", true, kay_body)
parked = transit.park(platform, target, "surfexp_gateway_hub", {kay})
transit.assign_job(parked, "job-12")
transit.depart("job-12")
window.close(kay)
transit.toggle_window(kay)
frame = kay.gui.screen[window.FRAME]
assert(frame and not find(frame, window.JOIN), "no arrival offer before the source deletion is confirmed")
transit.on_gui_click{player_index = 11, element = {valid = true, name = window.STAY}}
env.game.tick = env.game.tick + transit.OFFER_TICKS + 1
transit.on_tick()
assert(transit.owns(kay) and kay.character == nil, "Stay and the ten-minute timer wait for the confirmed deletion")
transit.on_gui_click{player_index = 11, element = {valid = true, name = window.ABORT}}
assert(transit.owns(kay) and env.storage.surface_export_passengers[11].state == "departed", "Abort is refused after departure")
transit.notify_departed("job-12")
assert(find(kay.gui.screen[window.FRAME], window.JOIN), "the arrival offer appears once the deletion is confirmed")
env.game.tick = env.game.tick + transit.OFFER_TICKS - 1
transit.on_tick()
assert(transit.owns(kay), "the ten-minute offer counts from the confirmed deletion")
env.game.tick = env.game.tick + 1
transit.on_tick()
assert(not transit.owns(kay) and kay.character == kay_body, "the offer ends ten minutes after the confirmed deletion")
print("PASS the arrival offer, Stay and the timer start only after the source deletion is confirmed")

local lee_body = character(nil, gear())
local lee = new_player(12, "lee", true, lee_body)
parked = transit.park(platform, target, "surfexp_gateway_hub", {lee})
env.game.tick = env.game.tick + 60
transit.on_tick()
assert(transit.owns(lee), "a just-parked passenger waits for the job id")
env.game.tick = env.game.tick + 600
transit.on_tick()
assert(not transit.owns(lee) and lee.character == lee_body and lee.in_hub, "a parked passenger whose transfer never got a job returns aboard")
print("PASS a parked passenger without a job returns aboard")

local mae_body = character(nil, gear())
local mae = new_player(13, "mae", true, mae_body)
mae.cursor_stuck = true
assert(#transit.park(platform, target, "surfexp_gateway_hub", {mae}) == 0 and not transit.owns(mae)
	and mae.character == mae_body and mae.in_hub, "a passenger whose cursor cannot be emptied stays aboard")
print("PASS a passenger whose cursor cannot be emptied is not parked")

local ned_body = character(nil, gear())
local ned = new_player(14, "ned", true, ned_body)
parked = transit.park(platform, target, "surfexp_gateway_hub", {ned})
transit.assign_job(parked, "job-13")
ned_body.valid = false
local spare = character(nauvis)
ned.associated = {spare}
ned.teleport_refused = true
local logs_before = #logged
transit.transfer_released("job-13")
local refused = false
for i = logs_before + 1, #logged do refused = refused or logged[i]:find("existing character was refused", 1, true) ~= nil end
assert(transit.owns(ned) and ned.character == nil and refused, "a refused teleport to an existing character stops the reattach")
ned.teleport_refused = false
print("PASS a refused teleport to an existing character stops the reattach")

local ona = new_player(15, "ona", true, character(nil, gear()))
parked = transit.park(platform, {instanceId = 3, instanceName = "Three", address = ""}, "surfexp_gateway_hub", {ona})
transit.assign_job(parked, "job-14")
transit.depart("job-14")
transit.notify_departed("job-14")
local join = find(ona.gui.screen[window.FRAME], window.JOIN)
assert(join and not join.enabled and join.tooltip and #ona.connects == 0, "Join is disabled with a reason when the destination has no address")
print("PASS Join is disabled when the destination has no address")

local lock_env = setmetatable({storage = {source_recovery_ready = true, locked_platforms = {}}, log = noop,
	game = {forces = {player = force}}}, {__index = _G})
local released = {}
lock_env.require = function(name)
	if name:find("game-utils", 1, true) then return {ACTIVATABLE_ENTITY_TYPES = {}} end
	if name:find("platform-schedule", 1, true) then return {apply = function() return true end} end
	if name:find("latch_rearm", 1, true) then return {pending_on_surface = function() return false end} end
	if name:find("platform-identity", 1, true) then return function(p) return p.uid end end
	if name:find("passenger-transit", 1, true) then
		return {transfer_released = function(job)
			assert(lock_env.storage.locked_platforms[7] == nil, "passengers returned before the lock was released")
			released[#released + 1] = job
		end}
	end
	error(name)
end
ship_surface.find_entities_filtered = function() return {} end
local surface_lock = assert(loadfile(root .. "utils/surface-lock.lua", "t", lock_env))()
local function lock(kind, job)
	lock_env.storage.locked_platforms[7] = {kind = kind, transfer_job_id = job, phase = kind == "transfer" and "pre_commit" or nil,
		platform_name = "Ship", platform_index = 7, force_name = "player", surface_index = 70, platform_uid = "uid:7",
		frozen_states = {}, original_hidden = false}
end
lock("transfer", "job-9")
assert(surface_lock.unlock_platform(7, nil, nil, nil, "job-9") and released[1] == "job-9", "a transfer unlock should return that job's passengers")
lock("export", "job-10")
assert(surface_lock.unlock_platform(7) and #released == 1, "an export unlock has no passengers")
lock("transfer", "job-15")
lock_env.storage.locked_platforms[7].force_name = "ghost"
assert(not surface_lock.unlock_platform(7) and released[#released] == "job-15", "a lock cleared for a missing force returns its passengers")
lock("transfer", "job-11")
lock_env.storage.locked_platforms[7].phase = "committed"
assert(not surface_lock.unlock_platform(7) and #released == 2, "a committed source keeps its passengers in transit")
print("PASS the transfer unlock returns its job's passengers after the lock is released")
