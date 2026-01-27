-- Remote Interface: configure
-- Configure plugin settings (called from Node.js plugin on startup)

local AsyncProcessor = require("modules/surface_export/core/async-processor")

--- Configure plugin settings (called from Node.js plugin on startup)
--- @param config table: Configuration parameters {batch_size, max_concurrent_jobs, show_progress, debug_mode}
local function configure(config)
  -- Initialize storage config if needed
  if not storage.surface_export_config then
    storage.surface_export_config = {}
  end
  
  if config.batch_size then
    AsyncProcessor.set_batch_size(config.batch_size)
  end
  if config.max_concurrent_jobs then
    AsyncProcessor.set_max_concurrent_jobs(config.max_concurrent_jobs)
  end
  if config.show_progress ~= nil then
    AsyncProcessor.set_show_progress(config.show_progress)
  end
  if config.debug_mode ~= nil then
    storage.surface_export_config.debug_mode = config.debug_mode
  end
  if config.pause_on_validation ~= nil then
    storage.surface_export_config.pause_on_validation = config.pause_on_validation
  end
  
  log(string.format("[FactorioSurfaceExport] Configuration updated: batch_size=%s, max_concurrent_jobs=%s, show_progress=%s, debug_mode=%s, pause_on_validation=%s",
    config.batch_size or "unchanged",
    config.max_concurrent_jobs or "unchanged",
    tostring(config.show_progress),
    tostring(config.debug_mode),
    tostring(config.pause_on_validation)))
end

return configure
