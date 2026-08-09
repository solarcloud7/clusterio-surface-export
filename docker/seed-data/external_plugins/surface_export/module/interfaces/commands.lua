local Commands = {}

local command_modules = {
  require("modules/surface_export/interfaces/commands/export-platform"),
  require("modules/surface_export/interfaces/commands/export-platform-file"),
  require("modules/surface_export/interfaces/commands/list-platforms"),
  require("modules/surface_export/interfaces/commands/list-exports"),
  require("modules/surface_export/interfaces/commands/list-surfaces"),
  require("modules/surface_export/interfaces/commands/plugin-import-file"),
  require("modules/surface_export/interfaces/commands/transfer-platform"),
  require("modules/surface_export/interfaces/commands/gateway-transfer"),
  require("modules/surface_export/interfaces/commands/gateway-gui"),
  require("modules/surface_export/interfaces/commands/resume-platform"),
  require("modules/surface_export/interfaces/commands/export-sync-mode"),
  require("modules/surface_export/interfaces/commands/step-tick"),
  require("modules/surface_export/interfaces/commands/lock-platform"),
  require("modules/surface_export/interfaces/commands/unlock-platform"),
  require("modules/surface_export/interfaces/commands/lock-status"),
  require("modules/surface_export/interfaces/commands/transaction-dashboard"),
  require("modules/surface_export/interfaces/commands/teleport"),
  require("modules/surface_export/interfaces/commands/test-entity"),
  require("modules/surface_export/interfaces/commands/run-tests"),
}

function Commands.register()
end

return Commands
