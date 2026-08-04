-- Remote Interface: clear_old_exports
-- Clear old exports (keep only last N)

--- Is `a` newer than `b`?
---
--- Entries stored through ExportCache.record carry `cache_seq`, a monotonic insertion stamp. Older
--- saves (and any entry written before this field existed) have none, so they sort as oldest and are
--- the first to go — which is correct: they ARE the accumulated backlog this cap was added to clear.
---
--- Ordering deliberately does NOT use `tick`. That field is stamped when an export is QUEUED, not
--- when it completes, so a large platform completes carrying the oldest tick in the table; ordering
--- by it would delete the biggest export at the instant it finished. `tick` is only the tiebreaker
--- among legacy entries, where nothing better exists.
---
--- `(x.tick or 0)`: nil-tolerant because this runs from export completion inside on_tick, where a
--- bare `nil > number` is not a bad sort but a raw error, and a raw error in event context kills the
--- headless server (exit 255) presenting as a stall.
local function is_newer(a, b)
  local sa, sb = a.cache_seq, b.cache_seq
  if sa and sb then
    return sa > sb
  end
  if sa then
    return true
  end
  if sb then
    return false
  end
  return (a.tick or 0) > (b.tick or 0)
end

--- Clear old exports (keep only last N)
--- @param keep_count number: Number of exports to keep
--- @param exports_table table|nil: Table to prune; defaults to storage.platform_exports.
---   Injectable ONLY so the self-test can exercise this algorithm over its own table instead of
---   swapping live storage out and back — a test that mutates storage.platform_exports is one
---   unexpected error away from destroying real exports, and needs a pcall to be fail-safe. Pruning
---   a table the caller owns needs neither.
--- @param protected table|nil: set of export ids that must survive regardless of age (see
---   ExportCache.protected_export_ids — an export still referenced by a platform lock is being
---   transmitted or is mid-transfer).
--- @return number: Number of exports removed
local function clear_old_exports(keep_count, exports_table, protected)
  keep_count = keep_count or 10
  local target = exports_table or storage.platform_exports
  if type(target) ~= "table" then
    return 0
  end
  protected = protected or {}

  local exports = {}
  for id, data in pairs(target) do
    table.insert(exports, {id = id, tick = data.tick, cache_seq = data.cache_seq})
  end

  table.sort(exports, is_newer)

  local removed = 0
  for i = keep_count + 1, #exports do
    local id = exports[i].id
    if not protected[id] then
      target[id] = nil
      removed = removed + 1
    end
  end

  return removed
end

return clear_old_exports
