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
  if keep_count == nil then keep_count = 10 end
  assert(type(keep_count) == "number" and keep_count >= 0 and keep_count < math.huge and keep_count % 1 == 0,
    "keep_count must be a nonnegative finite integer")
  local target = exports_table or storage.platform_exports
  if type(target) ~= "table" then
    return 0
  end
  local protected_ids = {}
  for id, keep in pairs(protected or {}) do protected_ids[id] = keep end
  if target == storage.platform_exports then
    for _, lock in pairs(storage.locked_platforms or {}) do
      if lock.transfer_job_id then protected_ids[lock.transfer_job_id] = true end
      if lock.committed_transfer_id then protected_ids[lock.committed_transfer_id] = true end
    end
  end

  local exports = {}
  for id, data in pairs(target) do
    table.insert(exports, {id = id, tick = data.tick, cache_seq = data.cache_seq})
  end

  table.sort(exports, is_newer)

  local removed = 0
  for i = keep_count + 1, #exports do
    local id = exports[i].id
    if not protected_ids[id] then
      target[id] = nil
      removed = removed + 1
    end
  end

  return removed
end

return clear_old_exports
