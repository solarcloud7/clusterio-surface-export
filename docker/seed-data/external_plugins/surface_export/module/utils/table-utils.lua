local TableUtils = {}

function TableUtils.sum_items(item_table)
  if type(item_table) ~= "table" then return 0 end
  local total = 0
  for _, count in pairs(item_table) do
    total = total + count
  end
  return total
end

function TableUtils.sum_fluids(fluid_table)
  if type(fluid_table) ~= "table" then return 0 end
  local total = 0
  for _, amount in pairs(fluid_table) do
    total = total + amount
  end
  return total
end

function TableUtils.is_array(t)
  if type(t) ~= "table" then
    return false
  end

  local count = 0
  local max_index = 0
  for k, _ in pairs(t) do
    if type(k) ~= "number" or k <= 0 or math.floor(k) ~= k then
      return false
    end
    count = count + 1
    if k > max_index then
      max_index = k
    end
  end

  return max_index == count
end

return TableUtils
