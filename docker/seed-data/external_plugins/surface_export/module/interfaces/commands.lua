-- FactorioSurfaceExport - Command Interface
-- Main loader that registers all commands from individual files
-- Each command is in its own file under interfaces/commands/
--
-- IMPORTANT: All require() calls must be at top level (Factorio 2.0 restriction).
-- require() cannot be called inside callbacks like register().

local Commands = {}

-- Pre-load all command modules at parse time (each module self-registers via commands.add_command)
local command_modules = {
  require("modules/surface_export/interfaces/commands/export-platform"),
  require("modules/surface_export/interfaces/commands/export-platform-file"),
  require("modules/surface_export/interfaces/commands/list-platforms"),
  require("modules/surface_export/interfaces/commands/list-exports"),
  require("modules/surface_export/interfaces/commands/list-surfaces"),
  require("modules/surface_export/interfaces/commands/plugin-import-file"),
  require("modules/surface_export/interfaces/commands/transfer-platform"),
  require("modules/surface_export/interfaces/commands/resume-platform"),
  require("modules/surface_export/interfaces/commands/export-sync-mode"),
  require("modules/surface_export/interfaces/commands/step-tick"),
  require("modules/surface_export/interfaces/commands/lock-platform"),
  require("modules/surface_export/interfaces/commands/unlock-platform"),
  require("modules/surface_export/interfaces/commands/lock-status"),
  -- Debug/testing commands
  require("modules/surface_export/interfaces/commands/test-entity"),
}

--- Register all console commands
--- Called from add_commands callback in event_handler interface.
--- Commands are already registered at require-time via commands.add_command,
--- so this is a no-op but kept for interface consistency.
function Commands.register()
  -- Commands self-register via commands.add_command at require time
end

return Commands
