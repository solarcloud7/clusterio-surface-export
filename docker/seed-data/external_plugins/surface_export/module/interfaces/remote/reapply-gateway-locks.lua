local Gateway = require("modules/surface_export/core/gateway")

local function reapply_gateway_locks()
  return Gateway.discover_and_unlock()
end

return reapply_gateway_locks
