-- Remote Interface: clear_old_exports
-- Clear old exports (keep only last N)

--- Clear old exports (keep only last N)
--- @param keep_count number: Number of exports to keep
--- @param exports_table table|nil: Table to prune; defaults to storage.platform_exports.
---   Injectable ONLY so the self-test can exercise this algorithm over its own table instead of
---   swapping live storage out and back — a test that mutates storage.platform_exports is one
---   unexpected error away from destroying real exports, and needs a pcall to be fail-safe. Pruning
---   a table the caller owns needs neither.
--- @return number: Number of exports removed
local function clear_old_exports(keep_count, exports_table)
  keep_count = keep_count or 10
  local target = exports_table or storage.platform_exports
  if not target then
    return 0
  end

  local exports = {}
  for id, data in pairs(target) do
    table.insert(exports, {id = id, tick = data.tick})
  end

  -- `(x.tick or 0)`: every write site sets .tick today (export-pipeline.lua:585 from export_data.tick
  -- stamped at :295, the :598 uncompressed fallback storing that same table, serializer.lua:153) —
  -- verified 2026-08-04, not assumed. The coalesce is here because this now runs from export
  -- completion inside on_tick, where a bare `nil > number` is not a wrong sort but a raw error, and
  -- a raw error in event context kills the headless server (exit 255) as a stall. A fourth write
  -- site that forgets .tick should sort oldest, not take the instance down. Entries in the current
  -- read window are protected by the keep_count floor, not by tick, so ordering them last is safe.
  table.sort(exports, function(a, b) return (a.tick or 0) > (b.tick or 0) end)
  
  local removed = 0
  for i = keep_count + 1, #exports do
    target[exports[i].id] = nil
    removed = removed + 1
  end
  
  return removed
end

return clear_old_exports
