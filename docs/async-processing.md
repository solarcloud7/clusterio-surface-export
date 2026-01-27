# Async Processing Architecture

This document explains how FactorioSurfaceExport uses asynchronous batch processing to handle large platform exports and imports without freezing the game.

## The Problem: Game Freezing

Factorio runs at 60 UPS (Updates Per Second), giving each game tick ~16.67ms to complete. When processing large platforms with thousands of entities:

- **Synchronous processing**: All entities processed in one tick → game freezes for seconds
- **Multiplayer impact**: All players experience lag/disconnect
- **User experience**: Game appears frozen, no progress feedback

**Example:** A 1000-entity platform taking 50ms to serialize would freeze the game for 3 ticks (~3 seconds).

## The Solution: Async Batch Processing

The `AsyncProcessor` module processes large operations across multiple ticks:

```
Tick 1:  Process entities 1-50    (16ms)  ✓ Game continues
Tick 2:  Process entities 51-100  (16ms)  ✓ Game continues  
Tick 3:  Process entities 101-150 (16ms)  ✓ Game continues
...
Tick 20: Complete job              (5ms)   ✓ Done!
```

### Key Benefits

- ✅ Game never freezes (stays under 16ms per tick)
- ✅ Real-time progress feedback to players
- ✅ Multiplayer-friendly (no lag spikes)
- ✅ Configurable batch size per settings
- ✅ Multiple jobs can run in parallel

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Command Entry Point                       │
│  /export-platform OR remote.call('...', 'export_platform')  │
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
│  • Updates job progress                                     │
│  • Shows progress message every 10 batches                  │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼ (when complete)
┌─────────────────────────────────────────────────────────────┐
│              complete_export_job()                           │
│  • Stores export in storage.platform_exports                │
│  • Generates export_id: platform_name_tick_job_id          │
│  • Logs completion message                                  │
│  • Notifies RCON caller if applicable                       │
│  • Cleans up job from storage.async_jobs                    │
└─────────────────────────────────────────────────────────────┘
```

## Usage: Export Platform

### 1. Via Custom Command

```lua
/export-platform [platform_index] [force_name]
```

**Example:**
```lua
/export-platform 1 player
```

**Flow:**
1. Command handler validates inputs
2. Calls `AsyncProcessor.queue_export(platform_index, force_name, player_name)`
3. Returns job_id: `export_42`
4. Job processes over multiple ticks
5. Completion message: `[Export Complete] My Platform (1234 entities in 5.2s) - ID: My Platform_12345_export_42`

### 2. Via Remote Interface (Synchronous for Clusterio)

```lua
local export_data = remote.call('FactorioSurfaceExport', 'export_platform', 1, 'player')
```

**Note:** This uses `Safety.atomic_export()` which is **synchronous** and will freeze the game. Used by Clusterio plugin because:
- Export must complete before returning to Node.js
- Clusterio controls when export happens (typically when no players online)
- Return value needed immediately for transmission

### 3. Via RCON (Async)

```bash
/c AsyncProcessor = require('scripts.async-processor')
AsyncProcessor.queue_export(1, 'player', 'RCON')
```

## Usage: Import Platform

### 1. Via Remote Interface (Synchronous)

```lua
local json_data = helpers.read_file('exports/platform.json')
local success, msg = remote.call('FactorioSurfaceExport', 'import_platform_data', 
  json_data, 'New Platform', 'player')
```

**Current Status:** ⚠️ Uses `Safety.atomic_import_from_data()` - **synchronous, will freeze game**

**Why synchronous:**
- Simpler error handling (return success/failure immediately)
- Less complex state management
- Imports typically smaller than exports (filtered entities)

**Performance:** 230 KB import (~1000 entities) = ~2-3 second freeze

### 2. Via Custom Command (Not Implemented Yet)

**Potential addition:**
```lua
/import-platform [file_name] [platform_name]
```

Would call `AsyncProcessor.queue_import()` for async processing.

## Async Processor API

### Queue Export

```lua
AsyncProcessor.queue_export(platform_index, force_name, requester_name)
```

**Parameters:**
- `platform_index` (number): Platform index in force.platforms (1-based)
- `force_name` (string): Force name (e.g., "player")
- `requester_name` (string|nil): Player name or "RCON" for tracking

**Returns:**
- `job_id` (string): Job identifier for tracking (e.g., "export_42")
- `nil, error` (string): If validation fails

**Job Storage:**
```lua
storage.async_jobs[job_id] = {
  type = "export",
  job_id = "export_42",
  platform_index = 1,
  platform_name = "My Platform",
  force_name = "player",
  requester = "player1",
  started_tick = 12345,
  
  entities = {--[[array of LuaEntity]]},
  total_entities = 1234,
  current_index = 0,
  export_data = {
    platform_name = "My Platform",
    force_name = "player",
    tick = 12345,
    timestamp = "2026-01-15T12:34:56Z",
    entities = {--[[serialized entities]]},
    stats = {--[[metadata]]}
  }
}
```

### Queue Import

```lua
AsyncProcessor.queue_import(json_data, new_platform_name, force_name, requester_name)
```

**Parameters:**
- `json_data` (string): JSON string of platform export data
- `new_platform_name` (string): Name for new platform
- `force_name` (string): Force name (defaults to "player")
- `requester_name` (string|nil): Player name or "RCON"

**Returns:**
- `job_id` (string): Job identifier (e.g., "import_43")
- `nil, error` (string): If validation/parsing fails

**Features:**
- ✅ Auto-generates platform names if missing
- ✅ Detects name conflicts and appends numbers
- ✅ Creates platform automatically
- ✅ Processes entity creation in batches

**Job Storage:**
```lua
storage.async_jobs[job_id] = {
  type = "import",
  job_id = "import_43",
  platform_name = "Imported Platform",
  force_name = "player",
  requester = "RCON",
  started_tick = 12400,
  
  platform_data = {--[[parsed JSON]]},
  target_surface = LuaSurface,
  entities_to_create = {--[[entity data]]},
  total_entities = 1234,
  current_index = 0
}
```

### Process Tick

```lua
AsyncProcessor.process_tick()
```

**Called from:** `script.on_event(defines.events.on_tick, ...)`

**Behavior:**
- Processes **one batch** per active job
- Batch size from mod settings (default: 50 entities/tick)
- Shows progress every 10 batches (500 entities)
- Completes jobs when `current_index >= total_entities`

**Performance:**
- 50 entities/tick = ~3000 entities/second at 60 UPS
- 1000-entity platform = ~20 ticks (~0.33 seconds)
- No game freezing, smooth UPS

### Get Active Jobs

```lua
local jobs = AsyncProcessor.get_active_jobs()
```

**Returns:** Array of job status objects
```lua
{
  {
    job_id = "export_42",
    type = "export",
    platform_name = "My Platform",
    progress = 45,              -- Percentage (0-100)
    entities_processed = 567,
    total_entities = 1234,
    elapsed_ticks = 234
  },
  -- ... more jobs
}
```

## Configuration

### Mod Settings

**Batch Size:**
```lua
settings.global["factorio-surface-export-batch-size"] = 50
```
- Default: 50 entities/tick
- Lower = slower but safer for low-spec machines
- Higher = faster but may impact UPS on complex entities

**Progress Messages:**
```lua
settings.global["factorio-surface-export-show-progress"] = true
```
- Default: true
- Shows progress messages every 10 batches
- Disable to reduce chat spam

### Location

Defined in `settings.lua`:
```lua
{
  type = "int-setting",
  name = "factorio-surface-export-batch-size",
  setting_type = "runtime-global",
  default_value = 50,
  minimum_value = 10,
  maximum_value = 500
}
```

## Performance Characteristics

### Export Performance

| Entity Count | Batch Size | Processing Time | Game Impact |
|--------------|------------|-----------------|-------------|
| 100 entities | 50/tick | ~2 ticks (0.03s) | None |
| 1,000 entities | 50/tick | ~20 ticks (0.33s) | None |
| 10,000 entities | 50/tick | ~200 ticks (3.3s) | None |
| 50,000 entities | 50/tick | ~1000 ticks (16.7s) | None |

**Key Point:** Async processing prevents freezing regardless of entity count.

### Import Performance

**Current (Synchronous):**
| Entity Count | Processing Time | Game Impact |
|--------------|-----------------|-------------|
| 100 entities | ~0.1s | Minor freeze |
| 1,000 entities | ~2-3s | Noticeable freeze |
| 10,000 entities | ~20-30s | Major freeze |

**Future (Async):**
Same as export - no freezing at any scale.

## Migration: Adding Async Import

Currently `import_platform_data` remote interface uses synchronous `Safety.atomic_import_from_data()`. To migrate to async:

### Option 1: Add New Async Remote Interface

```lua
remote.add_interface("FactorioSurfaceExport", {
  -- Existing synchronous import (keep for compatibility)
  import_platform_data = function(json_data, new_platform_name, force)
    -- Current synchronous implementation
  end,
  
  -- New async import
  import_platform_data_async = function(json_data, new_platform_name, force)
    local job_id = AsyncProcessor.queue_import(
      json_data, 
      new_platform_name, 
      force or 'player',
      'RCON'
    )
    return job_id  -- Return job_id instead of success/failure
  end,
  
  -- Check import status
  get_import_status = function(job_id)
    local jobs = AsyncProcessor.get_active_jobs()
    for _, job in ipairs(jobs) do
      if job.job_id == job_id then
        return {
          complete = false,
          progress = job.progress,
          platform_name = job.platform_name
        }
      end
    end
    -- Not in active jobs = complete
    return { complete = true }
  end
})
```

### Option 2: Polling Pattern (Node.js Side)

```javascript
// Queue import
let jobId = await this.sendRcon(
  `/sc return remote.call('FactorioSurfaceExport', 'import_platform_data_async', ...)`
);

// Poll until complete
while (true) {
  await new Promise(resolve => setTimeout(resolve, 500)); // Wait 0.5s
  let status = await this.sendRcon(
    `/sc return remote.call('FactorioSurfaceExport', 'get_import_status', '${jobId}')`
  );
  
  if (status.complete) break;
  this.logger.info(`Import progress: ${status.progress}%`);
}
```

### Option 3: Event-Based (Best for Large Imports)

Use Clusterio's `send_json` to notify when complete:

```lua
-- In complete_import_job()
if clusterio_api then
  clusterio_api.send_json("surface_export_import_complete", {
    job_id = job.job_id,
    platform_name = job.platform_name,
    entity_count = job.total_entities,
    duration_ticks = game.tick - job.started_tick
  })
end
```

Then handle in plugin:
```javascript
async init() {
  this.instance.server.handle("surface_export_import_complete", 
    this.handleImportComplete.bind(this)
  );
}
```

## Comparison: Sync vs Async

### Synchronous (Current Import)

**Pros:**
- ✅ Simpler code (no state management)
- ✅ Immediate error handling
- ✅ Return value available instantly
- ✅ Easier to test

**Cons:**
- ❌ Game freezes during processing
- ❌ Multiplayer: all players freeze
- ❌ No progress feedback
- ❌ Risk of timeout on large imports
- ❌ Can't cancel mid-operation

### Asynchronous (Current Export, Future Import)

**Pros:**
- ✅ No game freezing
- ✅ Real-time progress feedback
- ✅ Multiplayer-friendly
- ✅ Scales to any size
- ✅ Can monitor/cancel jobs

**Cons:**
- ❌ More complex code
- ❌ Requires polling for completion (from Node.js)
- ❌ State management overhead
- ❌ Testing complexity

## Best Practices

### When to Use Async

Use `AsyncProcessor.queue_*()` when:
- ✅ Operation triggered by player in-game
- ✅ Platform has > 100 entities
- ✅ Multiplayer server with active players
- ✅ Need progress feedback
- ✅ Large-scale operations (thousands of entities)

### When Sync is Acceptable

Use synchronous methods when:
- ✅ Server is offline/paused (Clusterio controller-initiated)
- ✅ Small platforms (< 100 entities)
- ✅ Single-player mode
- ✅ Need immediate return value
- ✅ Critical error handling required

## Debugging

### Enable Debug Logging

```lua
/c storage.debug_async = true
```

### Check Active Jobs

```lua
/c local AsyncProcessor = require('scripts.async-processor')
local jobs = AsyncProcessor.get_active_jobs()
for _, job in ipairs(jobs) do
  game.print(string.format("%s: %s (%d%%)", job.job_id, job.platform_name, job.progress))
end
```

### Inspect Job State

```lua
/c for id, job in pairs(storage.async_jobs) do
  game.print(serpent.block(job))
end
```

### Force Complete Job

```lua
/c storage.async_jobs["export_42"] = nil  -- Clear job (use with caution)
```

## Related Files

- [async-processor.lua](../src/surface_export_mod/scripts/async-processor.lua) - Core async logic
- [control.lua](../src/surface_export_mod/control.lua) - Event handlers & remote interfaces
- [safety.lua](../src/surface_export_mod/scripts/safety.lua) - Synchronous export/import functions
- [settings.lua](../src/surface_export_mod/settings.lua) - Mod settings definitions

## See Also

- [clusterio-limits.md](./clusterio-limits.md) - Data transfer size limits
- [architecture.md](./architecture.md) - Overall mod architecture
- [testing-guide.md](./testing-guide.md) - Testing procedures
