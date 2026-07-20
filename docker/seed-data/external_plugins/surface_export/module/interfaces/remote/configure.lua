-- Remote Interface: configure
-- Configure plugin settings (called from Node.js plugin on startup)

local AsyncProcessor = require("modules/surface_export/core/async-processor")
local Util = require("modules/surface_export/utils/util")

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
  if config.test_force_validation_failure ~= nil then
    -- Test-only: make the NEXT import deliberately fail validation (exercises the rollback path).
    storage.surface_export_config.test_force_validation_failure = config.test_force_validation_failure
  end
  if config.test_force_entity_failure ~= nil then
    -- Test-only: make the NEXT inventory-bearing entity fail to place (exercises the
    -- failed-entity-loss attribution + expected-count subtraction, Pitfall #20).
    storage.surface_export_config.test_force_entity_failure = config.test_force_entity_failure
  end
  if config.test_defer_clone_activation ~= nil then
    -- Test-only: leave a CLONE/non-transfer import DEACTIVATED (skip the activation step) so the
    -- pristine restored state can be physically counted with ZERO crafting confound — the clean
    -- way to measure belt/inventory restoration fidelity on the same instance (no transmission).
    storage.surface_export_config.test_defer_clone_activation = config.test_defer_clone_activation
  end
  if config.test_force_item_loss ~= nil then
    -- Test-only: remove N items of the most-abundant type from the destination on the NEXT
    -- transfer, AFTER held-item restore but BEFORE the gate — an UNACCOUNTED loss (not routed
    -- through failed_entity_losses/overflow). Proves the STRICT gate DETECTS real loss and the
    -- two-phase commit preserves the source. See validation-timing-trilemma / the gate-item-loss pad fixture.
    storage.surface_export_config.test_force_item_loss = config.test_force_item_loss
  end
  if config.test_force_fluid_loss ~= nil then
    -- Test-only: inflate expected fluid count after frozen restoration but before the single gate.
    storage.surface_export_config.test_force_fluid_loss = tonumber(config.test_force_fluid_loss)
  end
  if config.test_force_census_omission ~= nil then
    -- Test-only ONE-SHOT: on the NEXT export, drop one serialized inventory stack post-serialization
    -- and pre-census so the paired-read SOURCE census DETECTS the omission. Fires PRE-verdict, so a
    -- leaked flag makes the next transfer export ABORT and PRESERVE its source (self-protecting).
    -- Enumerated in lint:test-hooks FAIL_SAFE_HOOKS. See Pitfall #30, mutating test hooks must be
    -- fail-safe on leak.
    storage.surface_export_config.test_force_census_omission = config.test_force_census_omission
  end
  if config.test_capture_p2_plasma ~= nil then
    -- Measurement-only, one-shot capture for the P2 plasma segment-persistence lab.
    -- The unique platform name prevents an unrelated transfer from consuming it.
    storage.surface_export_config.test_capture_p2_plasma = config.test_capture_p2_plasma
  end
  if config.preserve_failed_destination ~= nil then
    -- Debug-only escape hatch. Normal failed transfers always bank evidence and discard the destination.
    local debug_enabled = config.debug_mode == true or storage.surface_export_config.debug_mode == true
    storage.surface_export_config.preserve_failed_destination = debug_enabled
      and config.preserve_failed_destination == true or false
  end
  if config.gateways_json then
    -- Replace the whole gateway link map (controller is the source of truth). Decoded from JSON,
    -- never built as a Lua table literal, so arbitrary instance names cannot inject Lua.
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

  log(string.format("[FactorioSurfaceExport] Configuration updated: batch_size=%s, max_concurrent_jobs=%s, show_progress=%s, debug_mode=%s",
    config.batch_size or "unchanged",
    config.max_concurrent_jobs or "unchanged",
    tostring(config.show_progress),
    tostring(config.debug_mode)))
end

return configure
