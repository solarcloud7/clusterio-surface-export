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
