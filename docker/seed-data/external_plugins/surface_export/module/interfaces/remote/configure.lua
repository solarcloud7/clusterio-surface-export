local AsyncProcessor = require("modules/surface_export/core/async-processor")
local Util = require("modules/surface_export/utils/util")
local Gateway = require("modules/surface_export/core/gateway")

local function configure(config)
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
  if config.max_export_cache_size then
    AsyncProcessor.set_max_export_cache_size(config.max_export_cache_size)
  end
  if config.profile_batches ~= nil then
    storage.surface_export_config.profile_batches = config.profile_batches == true
  end
  if config.debug_mode ~= nil then
    storage.surface_export_config.debug_mode = config.debug_mode
  end
  if config.test_force_validation_failure ~= nil then
    storage.surface_export_config.test_force_validation_failure = config.test_force_validation_failure
  end
  if config.test_force_entity_failure ~= nil then
    storage.surface_export_config.test_force_entity_failure = config.test_force_entity_failure
  end
  if config.test_defer_clone_activation ~= nil then
    storage.surface_export_config.test_defer_clone_activation = config.test_defer_clone_activation
  end
  if config.test_force_item_loss ~= nil then
    storage.surface_export_config.test_force_item_loss = config.test_force_item_loss
  end
  if config.test_force_fluid_loss ~= nil then
    storage.surface_export_config.test_force_fluid_loss = tonumber(config.test_force_fluid_loss)
  end
  if config.test_force_census_omission ~= nil then
    storage.surface_export_config.test_force_census_omission = config.test_force_census_omission
  end
  if config.preserve_failed_destination ~= nil then
    local debug_enabled = config.debug_mode == true or storage.surface_export_config.debug_mode == true
    storage.surface_export_config.preserve_failed_destination = debug_enabled
      and config.preserve_failed_destination == true or false
  end
  if config.active_gateways_json then
    local decoded = Util.json_to_table_compat(config.active_gateways_json)
    if type(decoded) == "table" then
      storage.surface_export_config.active_gateways = decoded
      local ok, err = pcall(Gateway.discover_and_unlock)
      if not ok then
        log(string.format("[FactorioSurfaceExport] configure: gateway re-unlock failed: %s", tostring(err)))
      end
      log(string.format("[FactorioSurfaceExport] Active gateway set: %d name(s)", #decoded))
    else
      log("[FactorioSurfaceExport] configure: active_gateways_json did not decode to a table")
    end
  end
  if config.gateways_json then
    local decoded = Util.json_to_table_compat(config.gateways_json)
    if type(decoded) == "table" then
      storage.surface_export_config.gateways = decoded
      local n = 0
      for _ in pairs(decoded) do n = n + 1 end
      log(string.format("[FactorioSurfaceExport] Gateway config updated: %d gateway(s)", n))
    else
      log("[FactorioSurfaceExport] configure: gateways_json did not decode to a table")
    end
  end

  log(string.format("[FactorioSurfaceExport] Configuration updated: batch_size=%s, max_concurrent_jobs=%s, show_progress=%s, debug_mode=%s, max_export_cache_size=%s",
    config.batch_size or "unchanged",
    config.max_concurrent_jobs or "unchanged",
    tostring(config.show_progress),
    tostring(config.debug_mode),
    config.max_export_cache_size or "unchanged"))
end

return configure
