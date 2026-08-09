local TransferValidation = require("modules/surface_export/validators/transfer-validation")

local function looks_like_result_id(value)
  if type(value) ~= "string" or value == "" then return false end
  if string.find(value, ":", 1, true) then return true end
  if string.match(value, "^%d+_") then return true end
  if string.match(value, "^uploaded") then return true end
  return false
end

local function get_validation_result(result_id)
  if not looks_like_result_id(result_id) then
    error("validation result lookup requires canonical transfer id or job id, not platform name: " .. tostring(result_id))
  end
  return TransferValidation.get_validation_result(result_id)
end

return get_validation_result