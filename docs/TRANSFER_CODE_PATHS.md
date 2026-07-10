# Transfer Code Paths

End-to-end trace of a platform transfer, from UI click to completion.

## Table of Contents

- [1. User clicks "Transfer" in Web UI](#1-user-clicks-transfer-in-web-ui)
- [2. Controller receives the request](#2-controller-receives-the-request)
- [3. Instance receives ExportPlatformRequest](#3-instance-receives-exportplatformrequest)
- [4. Lua export entry point](#4-lua-export-entry-point)
- [5. Instance receives export data, forwards to controller](#5-instance-receives-export-data-forwards-to-controller)
- [6. Controller sends import to target instance](#6-controller-sends-import-to-target-instance)
- [7. Instance chunks and sends via RCON](#7-instance-chunks-and-sends-via-rcon)
- [8. Lua import entry point](#8-lua-import-entry-point)
- [9. Validation flows back, source platform deleted](#9-validation-flows-back-source-platform-deleted)
- [Key Invariants](#key-invariants)

---

## 1. User clicks "Transfer" in Web UI

**[web/ManualTransferTab.tsx](../docker/seed-data/external_plugins/surface_export/web/ManualTransferTab.tsx)** → `submitTransfer()`

Calls `plugin.startTransfer(...)`, which constructs and sends the `StartPlatformTransferRequest` message in **[web/index.tsx](../docker/seed-data/external_plugins/surface_export/web/index.tsx)** (`SurfaceExportPlugin.startTransfer`) via WebSocket to the controller.

---

## 2. Controller receives the request

**[controller.ts](../docker/seed-data/external_plugins/surface_export/controller.ts)** routes `StartPlatformTransferRequest` to **[lib/transfer-orchestrator.ts](../docker/seed-data/external_plugins/surface_export/lib/transfer-orchestrator.ts)** → `handleStartPlatformTransferRequest()`

```
t0 = Date.now()
sendTo(sourceInstance, ExportPlatformRequest)   ← waits for async export to complete
waitForStoredExport(exportId)                   ← waits for data to arrive at controller
transferPlatform(exportId, targetInstanceId, ...)
```

---

## 3. Instance receives ExportPlatformRequest

**[instance.ts](../docker/seed-data/external_plugins/surface_export/instance.ts)** → `handleExportPlatformRequest()`

Sends RCON to Factorio:
```lua
remote.call('surface_export', 'export_platform', platformIndex, forceName, targetInstanceId)
```

---

## 4. Lua export entry point

**[module/interfaces/remote-interface.lua](../docker/seed-data/external_plugins/surface_export/module/interfaces/remote-interface.lua)** registers the `export_platform` handler

→ **[module/interfaces/remote/export-platform.lua](../docker/seed-data/external_plugins/surface_export/module/interfaces/remote/export-platform.lua)**

→ `AsyncProcessor.queue_export(...)`

### Async export (runs over multiple ticks)

**[module/core/async-processor.lua](../docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua)** → `process_tick()` dispatches to the export pipeline:

```
ExportPipeline.process_batch()  (called each tick until complete)   [core/export-pipeline.lua]
  → EntityScanner.scan_surface()       [export_scanners/entity-scanner.lua]
  → entity-handlers.lua                [export_scanners/entity-handlers.lua]
     (belt items deferred — skip_belt_items flag)

ExportPipeline.complete()  (single tick, after all entities scanned)  [core/export-pipeline.lua]
  → atomic belt scan (extract_belt_items for all belt entities)
  → Verification.count_all_items() / count_all_fluids()   [validators/verification.lua]
  → clusterio_api.send_json("surface_export_complete", data)
```

---

## 5. Instance receives export data, forwards to controller

**[instance.ts](../docker/seed-data/external_plugins/surface_export/instance.ts)** → `server.handle("surface_export_complete", handleExportComplete)`

`handleExportComplete()` retrieves the full export from the mod (via the `get_export_json` remote interface) and sends a `PlatformExportEvent` to the controller.

**[controller.ts](../docker/seed-data/external_plugins/surface_export/controller.ts)** → `handlePlatformExport()` (handles `PlatformExportEvent`) stores the payload in `platformStorage`. `waitForStoredExport` resolves → `transferPlatform()` begins, logs `transfer_created`.

---

## 6. Controller sends import to target instance

**[lib/transfer-orchestrator.ts](../docker/seed-data/external_plugins/surface_export/lib/transfer-orchestrator.ts)** → `transferPlatform()`

Sends `ImportPlatformRequest` to the target instance via WebSocket link.

---

## 7. Instance chunks and sends via RCON

**[instance.ts](../docker/seed-data/external_plugins/surface_export/instance.ts)** → `handleImportPlatformRequest()`

Splits the JSON payload into ~4KB chunks, sends each via RCON:
```lua
remote.call('surface_export', 'import_platform_chunk', name, chunk, n, total, force)
```

---

## 8. Lua import entry point

**[module/interfaces/remote-interface.lua](../docker/seed-data/external_plugins/surface_export/module/interfaces/remote-interface.lua)** registers `import_platform_chunk`

→ **[module/interfaces/remote/import-platform-chunk.lua](../docker/seed-data/external_plugins/surface_export/module/interfaces/remote/import-platform-chunk.lua)**

Assembles chunks, then calls `AsyncProcessor.queue_import(...)`.

### Phase 1 — Entity placement (async, multiple ticks)

**[module/core/async-processor.lua](../docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua)** → `process_tick()` dispatches to `ImportPipeline.process_batch()` in **[module/core/import-pipeline.lua](../docker/seed-data/external_plugins/surface_export/module/core/import-pipeline.lua)**

```
→ TileRestoration.process()          [import_phases/tile_restoration.lua]
→ EntityCreation.process_batch()     [import_phases/entity_creation.lua]
```

### Post-placement Phase 1 (single tick) — `ImportCompletion.run_phase1()`

**[module/core/import-completion.lua](../docker/seed-data/external_plugins/surface_export/module/core/import-completion.lua)**

```
→ PlatformHubMapping.restore_hub_inventories()   [import_phases/platform_hub_mapping.lua]
→ BeltRestoration.restore()                      [import_phases/belt_restoration.lua]
→ EntityStateRestoration.restore_all()           [import_phases/entity_state_restoration.lua]
→ job.pending_beacon_tick = tick + 1   (wait 1 tick → Phase 2)
```

### Phase 2 — Inventory + validation + fluids (single tick) — `ImportCompletion.run_phase2()`

**[module/core/import-completion.lua](../docker/seed-data/external_plugins/surface_export/module/core/import-completion.lua)**

```
→ Deserializer.restore_inventories()   PASS 1: beacons only       [core/deserializer.lua]
   (beacon_modules populated → crafting_speed updates immediately)
→ Deserializer.restore_inventories()   PASS 2: all other entities
   (set_stack cap now uses beacon-boosted crafting_speed)
→ deactivate all entities, re-pause platform
→ TransferValidation.validate_import() [validators/transfer-validation.lua]
→ FluidRestoration.restore()           [import_phases/fluid_restoration.lua]
   (paused/deactivated; segment temperatures feed the census)
→ TransferValidation.validate_import(strict=true)
   (ONE immutable exact item + by-name fluid verdict)
→ ActiveStateRestoration.restore()     [import_phases/active_state_restoration.lua]
   (unfreeze + activate only after verdict success)
→ LossAnalysis.run()                   [validators/loss-analysis.lua]
   (reporting-only postActivationReport; cannot change verdict fields)
→ clusterio_api.send_json("surface_export_import_complete", result)
```

---

## 9. Validation flows back, source platform deleted

**[instance.ts](../docker/seed-data/external_plugins/surface_export/instance.ts)** → `server.handle("surface_export_import_complete", handleImportCompleteValidation)`

`handleImportCompleteValidation()` consumes the validation result embedded in the Lua completion payload and sends a `TransferValidationEvent` to the controller.

**[controller.ts](../docker/seed-data/external_plugins/surface_export/controller.ts)** routes `TransferValidationEvent` to **[lib/transfer-orchestrator.ts](../docker/seed-data/external_plugins/surface_export/lib/transfer-orchestrator.ts)** → `handleTransferValidation()`

```
validation passed → sendTo(sourceInstance, DeleteSourcePlatformRequest)
                      (instance runs game.delete_surface(platform.surface) via RCON)
                 → logTransactionEvent("transfer_completed")
                 → persistTransactionLog()
validation failed → always-on black box written → destination discarded → source rollback
```

---

## Key Invariants

| Rule | Why |
|------|-----|
| Belt items extracted in a single atomic tick | Items move between ticks — multi-tick scan causes double-counting |
| Beacon modules restored before crafter inputs | `crafting_speed` updates instantly when `beacon_modules` is populated; `set_stack()` cap depends on it |
| Fluids injected after `ActiveStateRestoration` | Injecting before activation reproducibly lost ~15% of fluids (empirical rule, Pitfall #17; the ghost-buffer mechanism once used to explain it is dead on 2.0.77 — see api-notes) |
| `game.delete_surface()` not `platform.destroy()` | `LuaSpacePlatform.destroy()` is a no-op in Factorio 2.0 Space Age |
