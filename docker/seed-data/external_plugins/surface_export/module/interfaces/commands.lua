-- FactorioSurfaceExport - Command Interface
-- Main loader that registers all commands from individual files
-- Each command is in its own file under interfaces/commands/

local Commands = {}

--- Register all console commands
function Commands.register()
  -- Import and register each command from separate files
  require("modules/surface_export/interfaces/commands/export-platform")
  require("modules/surface_export/interfaces/commands/export-platform-file")
  require("modules/surface_export/interfaces/commands/list-platforms")
  require("modules/surface_export/interfaces/commands/list-exports")
  require("modules/surface_export/interfaces/commands/list-surfaces")
  require("modules/surface_export/interfaces/commands/plugin-import-file")
  require("modules/surface_export/interfaces/commands/transfer-platform")
  require("modules/surface_export/interfaces/commands/resume-platform")
  require("modules/surface_export/interfaces/commands/export-sync-mode")
  require("modules/surface_export/interfaces/commands/step-tick")
  require("modules/surface_export/interfaces/commands/lock-platform")
  require("modules/surface_export/interfaces/commands/unlock-platform")
  require("modules/surface_export/interfaces/commands/lock-status")
  
  -- Debug/testing commands
  require("modules/surface_export/interfaces/commands/test-entity")
end

return Commands
