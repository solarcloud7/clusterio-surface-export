-- Exact helper control flow with fake lines: placement target and diagnostic ledger
-- must use the same clamped coordinate. Live topology coverage is in belt-boundary.
local prefix = "modules/surface_export/"
local function stub(name, value) package.preload[prefix .. name] = function() return value end end
stub("core/deserializer", {})
stub("utils/game-utils", {QUALITY_NORMAL = "normal"})
stub("export_scanners/inventory-scanner", {release_item_state_cache = function() end})
stub("utils/util", {pcall_warn = function(_, fn) assert(pcall(fn)) end})
stub("utils/version-compat", {belt_force_insert_at = function(line, position, stack, count)
    line.force_insert_at(position, stack, count)
end})
local logs = {}
function log(message) logs[#logs + 1] = message end
storage = {surface_export_config = {belt_trace = true}}
prototypes = {item = {["iron-plate"] = {}}, quality = {normal = {}}}
local restorer = dofile("docker/seed-data/external_plugins/surface_export/module/import_phases/belt_restoration.lua")
local rows = {}
local line = {line_length = 106 / 256}
line.get_detailed_contents = function() return rows end
line.force_insert_at = function(position, stack, count)
    assert(position == line.line_length, "write must stay within the captured line")
    rows[#rows + 1] = {unique_id = #rows + 1, position = position,
        stack = {valid_for_read = true, name = stack.name, quality = {name = stack.quality}, count = count}}
end
local entity = {valid = true, unit_number = 1, name = "transport-belt", position = {x = 0, y = 0},
    prototype = {belt_speed = 1 / 256}, get_transport_line = function(index)
        assert(index == 2, "the captured lane must not change") return line
    end}
local groups = {{members = {{id = 1, li = 2}}, slots = {{n = "iron-plate", q = "normal", ct = 3}},
    item_source_positions = {1, 2, 240}}}
local placed, unplaced, anomalies = restorer.restore_side_groups(groups, {[1] = entity})
assert(placed == 3 and unplaced == 0 and anomalies == 0)
local trace = table.concat(logs, "\n")
assert(not trace:find("BORN%-AT%-DEST") and not trace:find("VANISHED iron"),
    "clamping must not create a false missing-item diagnostic: " .. trace)
assert(trace:find("BORN 0 | VANISHED 0", 1, true))
for _, invalid in ipairs({math.huge, -math.huge, 0/0, "240"}) do
    groups[1].item_source_positions[3] = invalid
    assert(not pcall(restorer.restore_side_groups, groups, {[1] = entity}))
    assert(#rows == 1, "invalid coordinates must not add cargo")
end
print("PASS: same-lane clamp, accurate trace, nonfinite and nonnumeric rejection")
