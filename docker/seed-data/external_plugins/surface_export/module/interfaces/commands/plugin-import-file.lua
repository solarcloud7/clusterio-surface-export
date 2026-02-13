-- Command: /plugin-import-file
-- Request plugin to import a platform from file

local Base = require("modules/surface_export/interfaces/commands/base")

local clusterio_api = require("modules/clusterio/api")

Base.command("plugin-import-file",
  "Request plugin to import a platform from file (usage: /plugin-import-file filename [new_name])",
  function(cmd, ctx)
    local params = Base.parse_params(ctx.param)
    local filename = params[1] or "platform_exports/Strana Mechty_25494879.json"
    local new_name = params[2]

    ctx.print("Requesting plugin to import from file: " .. filename)
    if new_name then
      ctx.print("New platform name: " .. new_name)
    end

    -- Send request to plugin via IPC
    if clusterio_api then
      clusterio_api.send_json("surface_import_file_request", {
        filename = filename,
        platform_name = new_name,
        force_name = "player"
      })
      ctx.print("✓ Request sent to plugin")
      ctx.print("Check logs for import status")
    else
      ctx.print("✗ Clusterio not available")
    end
  end
)
