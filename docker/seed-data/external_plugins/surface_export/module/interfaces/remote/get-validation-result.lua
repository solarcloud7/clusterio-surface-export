-- Remote Interface: get_validation_result
-- Debug lookup for an import/transfer validation result by canonical transfer id or job id.

local TransferValidation = require("modules/surface_export/validators/transfer-validation")

local function looks_like_result_id(value)
  if type(value) ~= "string" or value == "" then return false end
  if string.find(value, ":", 1, true) then return true end -- canonical transfer id
  if string.match(value, "^%d+_") then return true end -- source/import job id
  if string.match(value, "^uploaded") then return true end
  return false
end

--- Get validation result for a transfer/job id (debug only; production uses import-complete payload).
--- @param result_id string: Canonical transfer id or job id
--- @return table|nil: Validation result or nil if not found
local function get_validation_result(result_id)
  if not looks_like_result_id(result_id) then
    error("validation result lookup requires canonical transfer id or job id, not platform name: " .. tostring(result_id))
  end
  return TransferValidation.get_validation_result(result_id)
end

return get_validation_result