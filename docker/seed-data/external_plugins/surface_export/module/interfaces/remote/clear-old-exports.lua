-- Remote Interface: clear_old_exports
-- Clear old exports (keep only last N)

--- Clear old exports (keep only last N)
--- @param keep_count number: Number of exports to keep
--- @return number: Number of exports removed
local function clear_old_exports(keep_count)
  keep_count = keep_count or 10
  if not storage.platform_exports then
    return 0
  end
  
  local exports = {}
  for id, data in pairs(storage.platform_exports) do
    table.insert(exports, {id = id, tick = data.tick})
  end
  
  table.sort(exports, function(a, b) return a.tick > b.tick end)
  
  local removed = 0
  for i = keep_count + 1, #exports do
    storage.platform_exports[exports[i].id] = nil
    removed = removed + 1
  end
  
  return removed
end

return clear_old_exports
