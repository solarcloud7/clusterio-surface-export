-- FactorioSurfaceExport - Table Utilities
-- Helper functions for table operations

local TableUtils = {}

--- Deep copy a table
--- @param orig table: Original table
--- @return table: Deep copy of the table
function TableUtils.deep_copy(orig)
  local orig_type = type(orig)
  local copy
  if orig_type == 'table' then
    copy = {}
    for orig_key, orig_value in next, orig, nil do
      copy[TableUtils.deep_copy(orig_key)] = TableUtils.deep_copy(orig_value)
    end
    setmetatable(copy, TableUtils.deep_copy(getmetatable(orig)))
  else
    copy = orig
  end
  return copy
end

--- Check if a table is empty
--- @param t table: Table to check
--- @return boolean: true if empty
function TableUtils.is_empty(t)
  return next(t) == nil
end

--- Merge two tables (shallow merge)
--- @param t1 table: First table
--- @param t2 table: Second table
--- @return table: Merged table
function TableUtils.merge(t1, t2)
  local result = {}
  for k, v in pairs(t1) do
    result[k] = v
  end
  for k, v in pairs(t2) do
    result[k] = v
  end
  return result
end

--- Count total items in a table
--- @param item_table table: Table of item_name = count pairs
--- @return number: Total item count
function TableUtils.sum_items(item_table)
  local total = 0
  for _, count in pairs(item_table) do
    total = total + count
  end
  return total
end

--- Count total fluid volume in a table
--- @param fluid_table table: Table of fluid_name = amount pairs
--- @return number: Total fluid amount
function TableUtils.sum_fluids(fluid_table)
  local total = 0
  for _, amount in pairs(fluid_table) do
    total = total + amount
  end
  return total
end

--- Determine if a table behaves like an array (1..n integer keys)
--- @param t table
--- @return boolean
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
