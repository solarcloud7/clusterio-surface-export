# Transfer Code Paths

End-to-end trace of a platform transfer, from UI click to completion.

---

## 1. User clicks "Transfer" in Web UI

**[web/ManualTransferTab.jsx](../docker/seed-data/external_plugins/surface_export/web/ManualTransferTab.jsx)**

Sends a `StartPlatformTransferRequest` message via WebSocket to the controller.

---

## 2. Controller receives the request

**[lib/transfer-orchestrator.js](../docker/seed-data/external_plugins/surface_export/lib/transfer-orchestrator.js)** → `handleStartPlatformTransferRequest()`

```
t0 = Date.now()
sendTo(sourceInstance, ExportPlatformRequest)   ← waits for async export to complete
waitForStoredExport(exportId)                   ← waits for data to arrive at controller
transferPlatform(exportId, targetInstanceId, metrics, t0)
```

---

## 3. Instance receives ExportPlatformRequest

**[instance.js](../docker/seed-data/external_plugins/surface_export/instance.js)** → `handleExportPlatformRequest()`

Sends RCON to Factorio:
```lua
remote.call('surface_export', 'export_platform', platformIndex, forceName, targetInstanceId)
```

---

## 4. Lua export entry point

**[module/interfaces/remote-interface.lua](../docker/seed-data/external_plugins/surface_export/module/interfaces/remote-interface.lua)** → `export_platform` handler

→ **[module/interfaces/remote/export-platform.lua](../docker/seed-data/external_plugins/surface_export/module/interfaces/remote/export-platform.lua)**

→ `AsyncProcessor.queue_export(job)`

### Async export (runs over multiple ticks)

**[module/core/async-processor.lua](../docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua)**

```
process_export_batch()  (called each tick until complete)
  → EntityScanner.scan_surface()       [export_scanners/entity-scanner.lua]
  → entity-handlers.lua                [export_scanners/entity-handlers.lua]
     (belt items deferred — skip_belt_items flag)

complete_export_job()  (single tick, after all entities scanned)
  → atomic belt scan (extract_belt_items for all belt entities)
  → Verification.generate()            [validators/verification.lua]
  → clusterio_api.send_json("surface_export_export_ready", data)
```

---

## 5. Controller receives export data

**[controller.js](../docker/seed-data/external_plugins/surface_export/controller.js)** → `server.handle("surface_export_export_ready")`

Stores payload in `platformStorage`. `waitForStoredExport` resolves → `transferPlatform()` begins, logs `transfer_created` event.

---

## 6. Controller sends import to target instance

**[lib/transfer-orchestrator.js](../docker/seed-data/external_plugins/surface_export/lib/transfer-orchestrator.js)**

Sends `ImportPlatformRequest` to the target instance via WebSocket link.

---

## 7. Instance chunks and sends via RCON

**[instance.js](../docker/seed-data/external_plugins/surface_export/instance.js)** → `handleImportPlatformRequest()`

Splits the JSON payload into ~4KB chunks, sends each via RCON:
```lua
remote.call('surface_export', 'import_platform_chunk', name, chunk, n, total, force)
```

---

## 8. Lua import entry point

**[module/interfaces/remote-interface.lua](../docker/seed-data/external_plugins/surface_export/module/interfaces/remote-interface.lua)** → `import_platform_chunk`

Assembles chunks, then calls `AsyncProcessor.queue_import(job)`.

### Phase 1 — Entity placement (async, multiple ticks)

**[module/core/async-processor.lua](../docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua)** → `process_import_batch()`

```
→ TileRestoration.restore()          [import_phases/tile-restoration.lua]
→ EntityCreation.create_entities()   [import_phases/entity-creation.lua]
```

### Phase 1 completion (single tick) — `finish_import_job()`

```
→ HubInventoryRestoration            [import_phases/hub-inventory-restoration.lua]
→ BeltRestoration.restore()          [import_phases/belt-restoration.lua]
→ EntityStateRestoration.restore()   [import_phases/entity-state-restoration.lua]
→ job.pending_beacon_tick = tick + 1   (wait 1 tick → Phase 2)
```

### Phase 2 — Inventory + validation + fluids (single tick) — `finish_import_job_phase3()`

```
→ Deserializer.restore_inventories()   PASS 1: beacons only
   (beacon_modules populated → crafting_speed updates immediately)
→ Deserializer.restore_inventories()   PASS 2: all other entities
   (set_stack cap now uses beacon-boosted crafting_speed)
→ deactivate all entities, re-pause platform
→ TransferValidation.validate_import() [validators/transfer-validation.lua]
   (items only — fluids not yet injected)
→ ActiveStateRestoration.restore()     [import_phases/active-state-restoration.lua]
   (unfreeze + activate all entities)
→ FluidRestoration.restore()           [import_phases/fluid-restoration.lua]
   (MUST be after activation — ghost buffer fix)
→ LossAnalysis.run()                   [validators/loss-analysis.lua]
→ clusterio_api.send_json("surface_export_validation_result", result)
```

---

## 9. Controller receives validation result

**[controller.js](../docker/seed-data/external_plugins/surface_export/controller.js)** → `server.handle("surface_export_validation_result")`

→ **[lib/transfer-orchestrator.js](../docker/seed-data/external_plugins/surface_export/lib/transfer-orchestrator.js)**

```
validation passed → game.delete_surface(platform.surface)  (source deleted)
                 → logTransactionEvent("transfer_completed")
                 → persistTransactionLog()
validation failed → platform left paused + deactivated for investigation
```

---

## Key Invariants

| Rule | Why |
|------|-----|
| Belt items extracted in a single atomic tick | Items move between ticks — multi-tick scan causes double-counting |
| Beacon modules restored before crafter inputs | `crafting_speed` updates instantly when `beacon_modules` is populated; `set_stack()` cap depends on it |
| Fluids injected after `ActiveStateRestoration` | Frozen entities have a ghost buffer that is wiped on unfreeze — injecting before activation silently loses all fluid |
| `game.delete_surface()` not `platform.destroy()` | `LuaSpacePlatform.destroy()` is a no-op in Factorio 2.0 Space Age |
