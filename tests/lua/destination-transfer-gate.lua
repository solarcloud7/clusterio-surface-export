local root = "docker/seed-data/external_plugins/surface_export/module/"
local noop = function() end
local first = {valid = true, unit_number = 1, type = "inserter", active = true}
local second = setmetatable({valid = true, unit_number = 2, type = "inserter", active = true}, {
    __newindex = function() error("injected entity deactivation failure") end,
})
local surface = {valid = true, index = 8, find_entities_filtered = function(filter)
    return filter.name and {} or {first, second}
end}
local force = {valid = true, name = "player", get_surface_hidden = function() return false end,
    set_surface_hidden = noop}
local platform = {valid = true, name = "fixture", index = 3, surface = surface, hidden = false, paused = false, force = force}
force.platforms = {[3] = platform}
local deleteAccepted = false
local env = setmetatable({storage = {}, game = {tick = 1, forces = {player = force}}, log = noop}, {__index = _G})
env.require = function(name)
    if name:find("transfer-receipts", 1, true) then return assert(loadfile(root .. "utils/transfer-receipts.lua", "t", env))() end
    if name:find("game-utils", 1, true) then return {
        ACTIVATABLE_ENTITY_TYPES = {inserter = true}, delete_platform = function() return deleteAccepted end,
    } end
    if name:find("surface-lock", 1, true) then return {complete_cargo_pods = function() return 0, 0, 0 end} end
    error(name)
end
local holds = assert(loadfile(root .. "core/destination-hold.lua", "t", env))()
local ok, err = holds.stage("transfer", platform, force, true)
assert(not ok and err:find("injected entity", 1, true))
assert(platform.hidden and platform.paused and first.disabled_by_script)
assert(holds.get("transfer").preparation_failed, "partial hold was released")
assert(not holds.go_live("transfer"), "partial preparation activated")
assert(not holds.discard("transfer"), "refused deletion reported success")
assert(holds.get("transfer"), "refused deletion released the hold")
deleteAccepted = true
assert(holds.discard("transfer") and not holds.get("transfer"))
print("PASS partial staging and refused discard retain quarantine; incomplete preparation cannot activate")

surface.find_entities_filtered = function() return {} end
assert(holds.stage("released", platform, force, true))
assert(holds.go_live("released"))
local firstReceipt = env.storage.surface_export_transfer_receipts.destination_live.records.released
local replayOk, replayReceipt = holds.go_live("released")
assert(replayOk and replayReceipt == firstReceipt, "lost activation reply cannot be retried")
platform.valid = false
assert(not holds.go_live("released"), "receipt accepted a missing destination")
platform.valid = true
assert(not holds.stage("released", platform, force, true), "released ID created a new held copy")
assert(not holds.go_live("unknown"), "missing receipt manufactured activation success")
print("PASS activation receipt is idempotent and cannot stage another destination")

-- Deferred latch work must not execute or consume its job while the hold owns the surface.
env.storage = {destination_holds = {transfer = {}}, latch_rearm_jobs = {
    latch = {transfer_id = "transfer", at_tick = 0, stage = "preflight", items = {}},
}}
env.require = function() return {} end
local rearm = assert(loadfile(root .. "import_phases/latch_rearm.lua", "t", env))()
rearm.process_tick()
assert(env.storage.latch_rearm_jobs.latch.stage == "preflight", "held latch job ran")
assert(env.storage.latch_rearm_jobs.latch.at_tick == 0, "held latch job was rescheduled")
print("PASS deferred latch work waits for destination release")
