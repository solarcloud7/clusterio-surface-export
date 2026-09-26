local prints = {}
local color = {r = 0.2, g = 0.6, b = 0.9}
local player = {name = "Solar", index = 1, valid = true, connected = true, color = color, physical_surface_index = 2}
local storage = {}
local surface = {planet = {name = "fulgora"}}
local env = setmetatable({
	storage = storage,
	require = function() return {} end,
	prototypes = {space_location = {fulgora = {localised_name = {"space-location-name.fulgora"}}}},
	game = {
		get_player = function() return player end,
		get_surface = function(index) assert(index == 2); return surface end,
		print = function(message, options) prints[#prints + 1] = {message = message, options = options} end
	}
}, {__index = _G})
local gui = assert(loadfile("docker/seed-data/external_plugins/surface_export/module/interfaces/gui/teleport-gui.lua", "t", env))()
assert(gui.announce_arrival("Solar", "fact1", "fact3").success)
assert(prints[1].options.color == color)
assert(prints[1].message == "Solar → fact3 [img=space-location/fulgora]", prints[1].message)
player.connected = false
assert(not gui.announce_arrival("Solar", "fact1", "fact3").success and #prints == 1)
player.connected = true
surface = {platform = {space_location = {name = "fulgora"}}}
assert(gui.announce_arrival("Solar", "fact1", "[img=item/iron-plate]").success)
assert(prints[2].message == "Solar → (img=item/iron-plate) [img=space-location/fulgora]", prints[2].message)
surface = {}
assert(gui.announce_arrival("Solar", "fact1", "fact3").success)
assert(prints[3].message == "Solar → fact3", prints[3].message)
storage.surface_export_pending_arrivals = {[1] = true}
assert(gui.announce_arrival("Solar", "fact1", "fact3").success)
gui.flush_announcements()
assert(#prints == 3)
storage.surface_export_pending_arrivals[1] = nil
surface = {planet = {name = "fulgora"}}
gui.flush_announcements()
assert(#prints == 4 and prints[4].message == "Solar → fact3 [img=space-location/fulgora]")
gui.flush_announcements()
assert(#prints == 4)
storage.surface_export_pending_arrivals[1] = true
assert(gui.announce_arrival("Solar", "fact1", "fact3").success)
player.connected = false
gui.flush_announcements()
assert(#prints == 4 and next(storage.surface_export_pending_announcements) == nil)
player.connected = true
local visits = {}
env.game.get_player = function(name)
	visits[name] = (visits[name] or 0) + 1
	return player
end
for index = 1, 200 do storage.surface_export_pending_announcements["player" .. index] = {source = "fact1", target = "fact3"} end
gui.flush_announcements()
local count = 0
for _, value in pairs(visits) do assert(value == 1); count = count + 1 end
assert(count == 200 and #prints == 4)
print("PASS travel announces physical arrival in player color; disconnected players are not announced")
