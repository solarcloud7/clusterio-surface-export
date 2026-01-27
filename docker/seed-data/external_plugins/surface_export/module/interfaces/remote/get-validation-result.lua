-- Remote Interface: get_validation_result
-- Get validation result for a platform (used by instance plugin after import)

local TransferValidation = require("modules/surface_export/validators/transfer-validation")

--- Get validation result for a platform (used by instance plugin after import)
--- @param platform_name string: Name of the platform
--- @return table|nil: Validation result or nil if not found
local function get_validation_result(platform_name)
  return TransferValidation.get_validation_result(platform_name)
end

return get_validation_result
