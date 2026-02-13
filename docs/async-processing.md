# Async Processing Architecture

This document explains how FactorioSurfaceExport uses asynchronous batch processing to handle large platform exports and imports without freezing the game.

## The Problem: Game Freezing

Factorio runs at 60 UPS (Updates Per Second), giving each game tick ~16.67ms to complete. When processing large platforms with thousands of entities:

- **Synchronous processing**: All entities processed in one tick → game freezes for seconds
- **Multiplayer impact**: All players experience lag/disconnect
- **User experience**: Game appears frozen, no progress feedback

## The Solution: Async Batch Processing

The `AsyncProcessor` module processes large operations across multiple ticks:

```
Tick 1:  Process entities 1-50    (16ms)  ✓ Game continues
Tick 2:  Process entities 51-100  (16ms)  ✓ Game continues  
Tick 3:  Process entities 101-150 (16ms)  ✓ Game continues
...
Tick N:  Atomic belt scan          (5ms)  ✓ Single-tick consistency
Tick N+1: Complete job             (1ms)  ✓ Done!
```

### Key Benefits

- Game never freezes (stays under 16ms per tick)
- Real-time progress feedback to players
- Multiplayer-friendly (no lag spikes)
- Configurable batch size
- Both export and import are fully async

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Command Entry Point                       │
│  /export-platform OR remote.call("surface_export", ...)     │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│              AsyncProcessor.queue_export()                   │
│  • Validates platform exists                                 │
│  • Scans all entities on platform                           │
│  • Creates job entry in storage.async_jobs                  │
│  • Returns job_id for tracking                              │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│              on_tick Event Handler                           │
│  Called every game tick (60 times/second)                   │
│                                                              │
│  AsyncProcessor.process_tick()                              │
│  • Processes ONE BATCH per active job                       │
│  • Batch size: 50 entities/tick (configurable)             │
│  • Belt items SKIPPED during entity scanning                │
│  • Updates job progress                                     │
│  • Shows progress message every 10 batches                  │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼ (when all entities scanned)
┌─────────────────────────────────────────────────────────────┐
│              complete_export_job()                           │
│  1. Atomic belt scan — all belt items in single tick        │
│  2. Build verification counts from serialized data          │
│  3. Compress & store export                                 │
│  4. Notify RCON caller if applicable                        │
│  5. Clean up job from storage.async_jobs                    │
└─────────────────────────────────────────────────────────────┘
```

## Atomic Belt Scan

Transport belts continuously move items and cannot be paused in Factorio. During async export (spanning many ticks), items shift positions between batches, causing inconsistent snapshots.

**Solution:** During entity scanning, `EntityHandlers.skip_belt_items` is set to `true`. Belt handlers serialize entity data but skip `extract_belt_items()`. After all entities are processed, `complete_export_job()` performs a single-tick pass over all belt entities:

1. Set `skip_belt_items = true` before each batch
2. Track belt entities by serialized index in `job.belt_entities`  
3. Reset flag after batch
4. In `complete_export_job`: iterate all tracked belts, call `extract_belt_items()`, patch serialized data

This guarantees a point-in-time consistent snapshot of all belt contents.

## Usage: Export Platform

### Via Custom Command

```lua
/export-platform 1
/export-platform "Alpha"
```

### Via Remote Interface

```lua
-- Queue async export (returns job_id)
local job_id = remote.call("surface_export", "export_platform", 1, "player")
```

### Via RCON (Clusterio)

```
/sc rcon.print(remote.call("surface_export", "export_platform", 1, "player"))
```

## Usage: Import Platform

Import is also fully async, using the same batch processing as export.

### Via Remote Interface (Chunked)

```lua
-- Send data in chunks (Factorio 2.0 cannot read files at runtime)
remote.call("surface_export", "import_platform_chunk", name, chunk, n, total, force)
```

### Via Custom Command

```lua
/import-platform platform_Alpha_12345
/plugin-import-file <filename> <platform_name>
```

### Import Pipeline

1. Parse and decompress JSON data
2. Create platform with tiles (single tick)
3. Entity creation — async batches (50/tick), entities deactivated
4. Inventory restoration
5. Belt item restoration (single tick — belts can't be deactivated)
6. Circuit connection restoration
7. Platform paused (fuel protection during validation)
8. Validation (compare item/fluid counts)
9. Activation + unpause (on success)

## Async Processor API

### Queue Export

```lua
AsyncProcessor.queue_export(platform_index, force_name, requester_name)
-- Returns: job_id (string) or nil, error (string)
```

### Queue Import

```lua
AsyncProcessor.queue_import(json_data, platform_name, force_name, requester_name)
-- Returns: job_id (string) or nil, error (string)
```

### Process Tick

```lua
AsyncProcessor.process_tick()
-- Called from: script.on_event(defines.events.on_tick)
-- Processes one batch per active job per tick
```

### Get Active Jobs

```lua
local jobs = AsyncProcessor.get_active_jobs()
-- Returns array of { job_id, type, platform_name, progress, entities_processed, total_entities, elapsed_ticks }
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `batch_size` | 50 | Entities processed per tick |
| `max_concurrent_jobs` | 3 | Max parallel async jobs |
| `show_progress` | true | Show progress messages in game |
| `debug_mode` | false | Enable debug logging |

Configured via `remote.call("surface_export", "configure", config_table)` from the Clusterio plugin.

## Performance

| Entity Count | Batch Size | Processing Time | Game Impact |
|--------------|------------|-----------------|-------------|
| 100 entities | 50/tick | ~2 ticks (0.03s) | None |
| 1,000 entities | 50/tick | ~20 ticks (0.33s) | None |
| 1,359 entities | 50/tick | ~27 ticks (0.45s) | None |
| 10,000 entities | 50/tick | ~200 ticks (3.3s) | None |

Both export and import use async processing — no game freezing at any scale.

## Debugging

### Check Active Jobs

```lua
/c for id, job in pairs(storage.async_jobs) do
  game.print(string.format("%s: %s (%d/%d)", id, job.platform_name or "?", job.current_index or 0, job.total_entities or 0))
end
```

### Force Clear a Stuck Job

```lua
/c storage.async_jobs["export_42"] = nil
```

## Related Files

- [async-processor.lua](../docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua) — Core async logic
- [entity-handlers.lua](../docker/seed-data/external_plugins/surface_export/module/export_scanners/entity-handlers.lua) — Entity serialization with skip_belt_items flag
- [control.lua](../docker/seed-data/external_plugins/surface_export/module/control.lua) — Event handlers & tick processing
