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

-- Hiding an unfinished platform is not a validated hold. The eventual hold must
-- restore the visibility captured before import preparation, not its temporary hiding.
platform.hidden = true
assert(not holds.get("preparing"), "temporary hiding manufactured a validated hold")
assert(not holds.go_live("preparing"), "temporary hiding authorized activation")
assert(holds.stage("preparing", platform, force, true, {platform_hidden = false, surface_hidden = false}))
assert(holds.go_live("preparing"))
assert(platform.hidden == false, "completed import retained temporary preparation visibility")
print("PASS early preparation visibility is restored only through a validated hold")

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

-- Persistent engine refusal must back off without losing the original rules or export guard.
local logs, allow_write, attempts = {}, false, 0
local parameters = {original = true}
local cb = setmetatable({}, {__newindex = function(_, key, value)
    assert(key == "parameters" and value == parameters)
    attempts = attempts + 1
    if not allow_write then error("injected rule refusal") end
end})
local item = {entity = {valid = true, get_control_behavior = function() return cb end}, captured_parameters = parameters}
local record = {version = 2, stage = "restore", at_tick = 0, items = {item}}
env.storage = {latch_rearm_jobs = {retry = record}}
env.log = function(message) logs[#logs + 1] = message end
for i = 1, 310 do
    env.game.tick = record.at_tick
    rearm.process_tick()
    assert(record.at_tick - env.game.tick == 60 * math.min(i, 300), "retry backoff incorrect")
    assert(env.storage.latch_rearm_jobs.retry == record and not item.parameters_restored)
end
assert(#logs > 1 and #logs < 70, "persistent failures need bounded reminders")
allow_write = true
env.game.tick = record.at_tick
rearm.process_tick()
assert(item.parameters_restored and record.stage == "verify")
env.game.tick = record.at_tick
rearm.process_tick()
assert(not env.storage.latch_rearm_jobs.retry and attempts == 311)
print("PASS bounded retry backoff retains original rules and completes after engine recovery")

-- An interrupted restoration may be quarantined, but that hold is never a validated destination.
local stub = setmetatable({}, {__index = function() return noop end})
env.require = function(name)
    if name:find("core/destination-hold", 1, true) then return holds end
    return stub
end
local completion = assert(loadfile(root .. "core/import-completion.lua", "t", env))()
local job = {job_id = "partial", transfer_id = "partial-transfer", target_platform = platform, target_surface = surface}
completion.interrupt(job, "injected partial inventory write")
assert(job.completion_interrupted.error == "injected partial inventory write")
assert(holds.get(job.transfer_id).preparation_failed)
assert(not holds.go_live(job.transfer_id), "interrupted import was released")
assert(platform.hidden and platform.paused, "interrupted destination escaped quarantine")
print("PASS interrupted import quarantine cannot authorize destination release")
