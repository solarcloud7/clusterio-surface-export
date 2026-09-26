local root = "docker/seed-data/external_plugins/surface_export/module/"
local noop = function() end

local controllers = {character = 1, god = 2, editor = 3, cutscene = 4, spectator = 5, remote = 6}
local inventory_ids = {character_main = 1, character_guns = 3, character_ammo = 4, character_armor = 5, character_trash = 8, hub_main = 20}
local ARMOR = {["power-armor"] = true}

local function grid()
	local g = {valid = true, equipment = {}}
	g.clear = function() g.equipment = {} end
	g.put = function(spec)
		if spec.name == "missing-equipment" then error("Unknown equipment name: missing-equipment") end
		local equipment = {name = spec.name, position = spec.position, quality = spec.quality}
		g.equipment[#g.equipment + 1] = equipment
		return equipment
	end
	return g
end
local function slot(kind)
	local s = {valid_for_read = false}
	s.can_set_stack = function(params)
		if kind == "armor" then return ARMOR[params.name] == true end
		if params.name == "missing-mod-item" then error("unknown item name") end
		return true
	end
	s.set_stack = function(params)
		s.valid_for_read, s.name, s.count, s.quality = true, params.name, params.count, {name = params.quality or "normal"}
		s.grid = ARMOR[params.name] and grid() or nil
		return true
	end
	s.clear = function() s.valid_for_read, s.name, s.count, s.grid = false, nil, nil, nil end
	return s
end
local function inventory(size, kind, filled)
	local inv = {valid = true}
	for i = 1, size do inv[i] = slot(kind) end
	for i, item in ipairs(filled or {}) do inv[i].set_stack(item) end
	return inv
end
local function contents(inv)
	local out = {}
	for i = 1, #inv do if inv[i].valid_for_read then out[#out + 1] = inv[i].name .. "x" .. inv[i].count end end
	return table.concat(out, ",")
end

local ship_surface = {valid = true, index = 80, name = "platform-3"}
local hub_inventory = inventory(1)
local force = {valid = true, name = "player", platforms = {}}
local platform = {valid = true, index = 3, name = "Ship", uid = "uid:3", surface = ship_surface, force = force,
	hub = {valid = true, position = {x = 0.5, y = 0.5}, get_inventory = function(id)
		assert(id == inventory_ids.hub_main, "overflow goes to the hub's main inventory")
		return hub_inventory
	end}}
force.platforms[3] = platform
local nauvis = {valid = true, index = 1, name = "nauvis"}
nauvis.find_entities_filtered = function() return {} end
nauvis.find_non_colliding_position = function(_, anchor) return anchor end

local created = 0
local function character_entity(main_items)
	local c = {valid = true, name = "character", surface = nauvis, position = {x = 0, y = 0}}
	c.inventories = {
		[inventory_ids.character_armor] = inventory(1, "armor"),
		[inventory_ids.character_main] = inventory(3, nil, main_items),
		[inventory_ids.character_guns] = inventory(1),
		[inventory_ids.character_ammo] = inventory(1),
	}
	c.get_inventory = function(id) return c.inventories[id] end
	return c
end
local players = {}
local function new_player(index, name, body)
	local p = {index = index, name = name, valid = true, connected = true, character = body,
		controller_type = body and controllers.character or controllers.god, physical_surface_index = nauvis.index, boarded = 0,
		printed = {}}
	p.print = function(message) p.printed[#p.printed + 1] = message end
	p.set_controller = function(spec)
		if spec.type == controllers.god then p.character = nil end
		if spec.type == controllers.character then p.character = spec.character end
		if spec.type == controllers.remote then p.view = spec end
		p.controller_type = spec.type
	end
	p.exit_remote_view = function() p.controller_type = controllers.character end
	p.teleport = function(_, target)
		if p.teleport_refused then return false end
		p.physical_surface_index = target.index
		return true
	end
	p.enter_space_platform = function(target)
		assert(p.character, "boarding needs a character")
		p.physical_surface_index = target.surface.index
		p.boarded = p.boarded + 1
		return true
	end
	p.create_character = function()
		created = created + 1
		p.created_on = p.physical_surface_index
		p.character = character_entity()
		p.controller_type = controllers.character
		return true
	end
	p.associated = {}
	p.get_associated_characters = function() return p.associated end
	players[index] = p
	return p
end

local uid = "uid:3"
local connected = {}
local decoded = {}
local logged = {}
local env = setmetatable({
	storage = {},
	defines = {controllers = controllers, inventory = inventory_ids},
	log = function(message) logged[#logged + 1] = message end,
	helpers = {json_to_table = function(text) return decoded[text] end},
	game = {tick = 5000, forces = {player = force}, print = noop, connected_players = connected},
}, {__index = _G})

env.require = function(name)
	if name:find("utils/util", 1, true) then return {QUALITY_NORMAL = "normal", pcall_warn = function(_, fn) fn() end} end
	if name:find("inventory-scanner", 1, true) then return {} end
	if name:find("connection_restoration", 1, true) then return {} end
	error(name)
end
local deserializer = assert(loadfile(root .. "core/deserializer.lua", "t", env))()
env.require = function(name)
	if name:find("core/deserializer", 1, true) then return deserializer end
	if name:find("platform-identity", 1, true) then return function(p) return p.valid and uid or nil end end
	if name:find("planet-policy", 1, true) then return {default_surface = function() return nauvis end} end
	if name:find("transfer-receipts", 1, true) then return assert(loadfile(root .. "utils/transfer-receipts.lua", "t", env))() end
	if name:find("game-utils", 1, true) then return {ACTIVATABLE_ENTITY_TYPES = {}} end
	if name:find("core/gateway", 1, true) then return {} end
	if name:find("surface-lock", 1, true) then return {complete_cargo_pods = function() return 0, 0, 0 end} end
	error(name)
end
local arrival = assert(loadfile(root .. "core/passenger-arrival.lua", "t", env))()
ship_surface.find_entities_filtered = function() return {} end
local holds = assert(loadfile(root .. "core/destination-hold.lua", "t", env))()
force.get_surface_hidden = function() return false end
force.set_surface_hidden = noop

local armor = {name = "power-armor", count = 1, quality = "normal", inventory = "armor",
	grid = {equipment = {{name = "battery-equipment", position = {x = 0, y = 0}, quality = "normal"}}}}
local manifest = {
	{name = "alice", items = {
		{name = "iron-plate", count = 50, quality = "normal", inventory = "main"},
		{name = "copper-plate", count = 20, quality = "normal", inventory = "main"},
		{name = "pistol", count = 1, quality = "normal", inventory = "guns"},
		armor,
		{name = "steel-plate", count = 5, quality = "normal", inventory = "main"},
		{name = "stone", count = 5, quality = "normal", inventory = "main"},
	}},
	{name = "bob", items = {}},
}

local alice = new_player(1, "alice", character_entity({{name = "wood", count = 10}}))
connected[1] = alice
assert(not arrival.process(alice), "a player with no arrival record is left to the planet policy")
print("PASS a join before go-live finds no arrival and changes nothing")

assert(holds.stage("tx-1", platform, force, true, nil, "import-1"))
assert(holds.go_live("tx-1", "import-1", manifest))
local record = env.storage.surface_export_arrivals.alice["tx-1"]
assert(record and #record.items == 6 and record.boarding_expires_tick == 5000 + 36000 and record.platform_uid == "uid:3",
	"go-live should record each passenger's gear and a ten-minute boarding offer")
assert(env.storage.surface_export_arrivals.bob["tx-1"] and #env.storage.surface_export_arrivals.bob["tx-1"].items == 0)
assert(holds.go_live("tx-1", "import-1", manifest))
local count = 0
for _ in pairs(env.storage.surface_export_arrivals.alice) do count = count + 1 end
assert(count == 1 and #record.items == 6, "a duplicate go-live must not double the arrival")
print("PASS go-live records arrivals once per transfer and a duplicate go-live adds nothing")

hub_inventory = inventory(1)
assert(arrival.process(alice))
local body = alice.character
assert(body.inventories[inventory_ids.character_armor][1].name == "power-armor", "the armor should be worn")
assert(body.inventories[inventory_ids.character_armor][1].grid.equipment[1].name == "battery-equipment", "the armor grid should be restored")
assert(contents(body.inventories[inventory_ids.character_main]) == "woodx10,iron-platex50,copper-platex20",
	"gear is inserted around the player's existing items without clearing them")
assert(body.inventories[inventory_ids.character_guns][1].name == "pistol")
assert(contents(hub_inventory) == "steel-platex5", "overflow should go to the platform hub")
assert(#record.items == 1 and record.items[1].name == "stone", "gear with no room anywhere should stay in the record")
assert(alice.boarded == 1 and alice.physical_surface_index == ship_surface.index and alice.view.surface == ship_surface
	and alice.view.position == platform.hub.position, "the arrival should board the platform and show it in map view")
assert(env.storage.surface_export_arrivals.alice["tx-1"] == record, "an arrival with gear left keeps its record")
hub_inventory = inventory(2)
arrival.process(alice)
assert(contents(hub_inventory) == "stonex5" and not env.storage.surface_export_arrivals.alice and alice.boarded == 1,
	"the remaining gear is delivered later without boarding again, and the record is then removed")
assert(created == 0, "a player with a character must not get another")
print("PASS arrival inserts gear armor-first without clearing, overflows to the hub, keeps the rest and boards once")

assert(holds.go_live("tx-1", "import-1", manifest))
assert(not env.storage.surface_export_arrivals.alice, "a replayed go-live must not recreate a delivered arrival")
print("PASS a replayed go-live after delivery does not deliver the gear twice")

local carl = new_player(3, "carl", character_entity({{name = "a", count = 1}, {name = "b", count = 1}, {name = "c", count = 1}}))
env.storage.surface_export_arrivals.carl = {["tx-2"] = {transfer_id = "tx-2", force_name = "player", platform_index = 3,
	surface_index = 80, platform_uid = "uid:3", created_tick = 1, boarding_expires_tick = 5000,
	items = {{name = "iron-gear-wheel", count = 5, quality = "normal", inventory = "main"},
		{name = "missing-mod-item", count = 1, quality = "normal", inventory = "main"}}}}
hub_inventory = inventory(1, nil, {{name = "full", count = 1}})
arrival.process(carl)
local late = env.storage.surface_export_arrivals.carl["tx-2"]
assert(late.boarding_done == "expired" and carl.boarded == 0, "an expired offer should not board")
assert(#late.items == 2, "an expired offer keeps its gear until there is room")
env.game.tick = 5000 + 10 * 60 * 60 * 60
carl.character.inventories[inventory_ids.character_main][3].clear()
arrival.process(carl)
assert(#late.items == 1 and late.items[1].name == "missing-mod-item", "gear never expires and is delivered once there is room")
assert(env.storage.surface_export_arrivals.carl["tx-2"] == late, "an item this instance cannot hold stays in the record")
print("PASS an expired boarding offer keeps the gear, which never expires")

env.game.tick = 6000
local dana = new_player(4, "dana", character_entity({{name = "a", count = 1}, {name = "b", count = 1}, {name = "c", count = 1}}))
env.storage.surface_export_arrivals.dana = {["tx-3"] = {transfer_id = "tx-3", force_name = "player", platform_index = 3,
	surface_index = 80, platform_uid = "uid:3", created_tick = 1, boarding_expires_tick = 99999, items = {armor}}}
env.storage.locked_platforms = {[3] = {kind = "transfer"}}
hub_inventory = inventory(1)
dana.character.inventories[inventory_ids.character_armor][1].set_stack({name = "power-armor", count = 1})
arrival.process(dana)
assert(dana.boarded == 0 and contents(hub_inventory) == "", "a locked platform is neither boarded nor used for overflow")
env.storage.locked_platforms = nil
env.storage.destination_holds.other = {platform_index = 3, surface_index = 80}
arrival.process(dana)
assert(dana.boarded == 0 and contents(hub_inventory) == "", "a held platform is neither boarded nor used for overflow")
env.storage.destination_holds.other = nil
arrival.process(dana)
assert(dana.boarded == 1 and contents(hub_inventory) == "power-armorx1", "boarding and overflow resume once the platform is free")
print("PASS a locked or held platform is not boarded or filled until it is released")

local eve_body = character_entity()
local eve = new_player(5, "eve", nil)
eve.controller_type = controllers.editor
eve.stashed_controller_type = controllers.character
env.storage.surface_export_arrivals.eve = {["tx-4"] = {transfer_id = "tx-4", force_name = "player", platform_index = 3,
	surface_index = 80, platform_uid = "uid:3", created_tick = 1, boarding_expires_tick = 99999, items = {}}}
assert(arrival.process(eve) and created == 0 and eve.boarded == 0, "an editor player with a stashed character is not given another")
eve.stashed_controller_type = nil
eve.associated = {eve_body}
arrival.process(eve)
assert(created == 0 and eve.character == eve_body and eve.boarded == 1, "an existing character is reattached instead of creating one")
local finn = new_player(6, "finn", nil)
finn.controller_type = controllers.spectator
env.storage.surface_export_arrivals.finn = {["tx-5"] = {transfer_id = "tx-5", force_name = "player", platform_index = 3,
	surface_index = 80, platform_uid = "uid:3", created_tick = 1, boarding_expires_tick = 99999, items = {}}}
arrival.process(finn)
assert(created == 1 and finn.character and finn.boarded == 1, "a spectator with no character gets exactly one")
local gus = new_player(7, "gus", character_entity())
env.storage.surface_export_passengers = {[7] = {state = "departed"}}
env.storage.surface_export_arrivals.gus = {["tx-6"] = {transfer_id = "tx-6", force_name = "player", platform_index = 3,
	surface_index = 80, platform_uid = "uid:3", created_tick = 1, boarding_expires_tick = 99999, items = {}}}
assert(not arrival.process(gus) and gus.boarded == 0, "a player whose transit is unresolved here waits")
print("PASS arrival never creates a second body and waits for editor or transit players")

decoded["[{\"name\":\"x\"}]"] = {{name = "x"}}
assert(arrival.stage("tx-9", 1, 2, "[{\"name\"") == 1)
assert(arrival.stage("tx-9", 2, 2, ":\"x\"}]") == 2)
local staged, err = arrival.take_staged("tx-9")
assert(not err and staged[1].name == "x" and not env.storage.surface_export_passenger_staging["tx-9"],
	"staged chunks are joined in order and consumed")
arrival.stage("tx-10", 1, 2, "[")
staged, err = arrival.take_staged("tx-10")
assert(not staged and err:find("incomplete", 1, true), "an incomplete manifest must refuse go-live")
assert(arrival.take_staged("tx-11") == nil, "a transfer without staged passengers has none")
assert(not pcall(arrival.stage, "tx-12", 3, 2, "x"), "a chunk outside the declared count is refused")
print("PASS the staged passenger manifest is complete or refused")

local remote_calls = {}
local remote_env = setmetatable({log = noop}, {__index = _G})
local staged_result, go_live_ok = nil, true
remote_env.require = function(name)
	if name:find("passenger-arrival", 1, true) then
		return {take_staged = function() return staged_result, staged_result == false and "Passenger manifest is incomplete" or nil end,
			process_connected = function() remote_calls[#remote_calls + 1] = "process" end}
	end
	return {go_live = function(_, _, passengers)
		remote_calls[#remote_calls + 1] = {"go_live", passengers}
		return go_live_ok, go_live_ok and {} or "refused"
	end}
end
local destination_remote = assert(loadfile(root .. "interfaces/remote/destination-hold.lua", "t", remote_env))()
staged_result = false
assert(not destination_remote("go_live", "tx").success and #remote_calls == 0, "an incomplete manifest must not go live")
staged_result = {{name = "alice"}}
assert(destination_remote("go_live", "tx").success and remote_calls[1][2] == staged_result and remote_calls[2] == "process",
	"go-live should pass the staged passengers and then serve connected arrivals")
print("PASS the go-live remote hands the staged manifest to the hold and serves connected players")

local function late_record(id, items)
	return {[id] = {transfer_id = id, force_name = "player", platform_index = 3, surface_index = 80,
		platform_uid = "uid:3", created_tick = 1, boarding_expires_tick = 0, items = items}}
end
local function count_named(entity, name)
	local n = 0
	for _, inv in pairs(entity.inventories) do
		for i = 1, #inv do if inv[i].valid_for_read and inv[i].name == name then n = n + inv[i].count end end
	end
	for i = 1, #hub_inventory do if hub_inventory[i].valid_for_read and hub_inventory[i].name == name then n = n + hub_inventory[i].count end end
	return n
end
env.game.tick = 7000
env.storage.surface_export_passengers = {}
local hana = new_player(8, "hana", character_entity())
hub_inventory = inventory(1)
env.storage.surface_export_arrivals.hana = late_record("tx-20", {{name = "power-armor", count = 1, quality = "normal",
	inventory = "armor", grid = {equipment = {{name = "missing-equipment", position = {x = 0, y = 0}, quality = "normal"}}}},
	{name = "iron-plate", count = 50, quality = "normal", inventory = "main"}})
for _ = 1, 3 do arrival.process(hana) end
assert(count_named(hana.character, "power-armor") == 0, "armor whose grid cannot be restored must not be inserted degraded or twice")
assert(count_named(hana.character, "iron-plate") == 50, "the other gear is delivered exactly once")
local kept = env.storage.surface_export_arrivals.hana["tx-20"]
assert(kept and #kept.items == 1 and kept.items[1].name == "power-armor", "the armor that cannot be restored stays in the record")
assert(#hana.printed == 1 and hana.printed[1]:find("power-armor", 1, true), "the player is told once that the item is kept")
print("PASS a stack whose properties cannot be restored stays in the record, and the rest is delivered once")

local ian_body = character_entity()
local ian = new_player(9, "ian", ian_body)
local ian_inventory = ian_body.get_inventory
ian_body.get_inventory = function(id)
	if id == inventory_ids.character_guns and ian_body.broken then error("injected inventory failure") end
	return ian_inventory(id)
end
ian_body.broken = true
env.storage.surface_export_arrivals.ian = late_record("tx-21", {
	{name = "iron-plate", count = 50, quality = "normal", inventory = "main"},
	{name = "pistol", count = 1, quality = "normal", inventory = "guns"}})
arrival.process(ian)
ian_body.broken = false
arrival.process(ian)
assert(count_named(ian_body, "iron-plate") == 50 and count_named(ian_body, "pistol") == 1,
	"items placed before a delivery error must not be delivered again")
print("PASS delivery progress is kept per item across an error")

local kim = new_player(10, "kim", nil)
kim.controller_type, kim.physical_surface_index = controllers.spectator, ship_surface.index
env.storage.surface_export_arrivals.kim = late_record("tx-22", {})
arrival.process(kim)
assert(kim.created_on == nauvis.index, "a created body should start on the default planet, not at the old view")
local lou = new_player(11, "lou", nil)
lou.controller_type, lou.stashed_controller_type = controllers.editor, controllers.remote
env.storage.surface_export_arrivals.lou = late_record("tx-23", {})
local before = created
arrival.process(lou)
assert(created == before and not lou.character, "an editor player with any stashed controller that can hold a character gets no new body")
print("PASS a created body starts on the default planet and editor players with a stash are left alone")

local mo = new_player(12, "mo", nil)
mo.associated = {character_entity()}
mo.teleport_refused = true
env.storage.surface_export_arrivals.mo = late_record("tx-24", {})
arrival.process(mo)
assert(not mo.character and created == before, "a refused teleport must not attach or create a character")
print("PASS a refused teleport to an existing character stops the reattach")

local logs_before = #logged
env.game.tick = 8000
assert(holds.stage("tx-30", platform, force, true, nil, "import-30"))
assert(holds.go_live("tx-30", "import-30", {{name = "pat", items = {{name = "iron-plate"}, {count = 3},
	{name = "stone", count = 2, quality = "normal", inventory = "main"}}}}))
assert(#env.storage.surface_export_arrivals.pat["tx-30"].items == 1, "only well-formed items are recorded")
local dropped = 0
for i = logs_before + 1, #logged do if logged[i]:find("malformed", 1, true) then dropped = dropped + 1 end end
assert(dropped == 2, "each dropped malformed item is logged")
print("PASS malformed arrival items are logged when dropped")
