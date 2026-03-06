# Async Processor Refactor Plan

## Problem Statement

`module/core/async-processor.lua` is **1,699 lines** and has accumulated at least **6 distinct responsibilities**:

| Responsibility | Lines | Key functions |
|---|---|---|
| Config & storage init | 34-104 | `init()`, `set_batch_size()`, `set_sync_mode()`, etc. |
| Import session (chunked RCON) | 125-481 | `begin_import_session()`, `enqueue_import_chunk()`, `finalize_import_session()` |
| Export job lifecycle | 230-1162 | `queue_export()`, `process_export_batch()`, `complete_export_job()` |
| Import job lifecycle | 489-1577 | `queue_import()`, `process_import_batch()`, `finish_import_job()`, `finish_import_job_phase3()` |
| Tick scheduling | 1580-1641 | `process_tick()` |
| Status queries | 1645-1697 | `get_active_jobs()`, `get_job_status()` |

The two worst offenders are:
- **`finish_import_job_phase3()`** (360 lines) - inventory restoration, validation adjustment, activation, fluid restoration, debug exports, loss analysis, notifications
- **`queue_import()`** (265 lines) - JSON parsing, decompression, transfer validation, platform creation, starter entity cleanup, schedule restoration, job struct building

The file should be a **thin orchestrator** that delegates to focused modules.

---

## Design Principle

After refactoring, `async-processor.lua` should:
1. Own **job lifecycle state** (storage, create/destroy jobs, tick dispatch)
2. **Delegate everything else** to purpose-built modules
3. Read like a table of contents, not an implementation

Target: **~200-300 lines** for async-processor.lua (down from 1,699).

---

## Proposed Module Extractions

### 1. `core/import-session.lua` (~140 lines)

**What**: Chunked RCON session management - the protocol layer for receiving large payloads in pieces.

**Extract from async-processor.lua**:
- `begin_import_session()` (lines 349-390)
- `enqueue_import_chunk()` (lines 397-422)
- `finalize_import_session()` (lines 428-481)
- `prune_import_sessions()` (lines 125-154)
- Constants: `MAX_IMPORT_SESSIONS`, `MAX_SESSION_AGE_TICKS`, `MAX_TOTAL_CHUNKS`

**Interface**:
```lua
local ImportSession = {}
function ImportSession.init()           -- ensure storage.import_sessions exists
function ImportSession.begin(session_id, total_chunks, platform_name, force_name)
function ImportSession.enqueue_chunk(session_id, chunk_index, chunk_data)
function ImportSession.finalize(session_id, checksum)  -- returns assembled JSON string
function ImportSession.prune()
return ImportSession
```

**Why separate**: This is a self-contained transport protocol concern. It has no knowledge of what export/import data looks like - it just reassembles chunks.

---

### 2. `core/export-pipeline.lua` (~350 lines)

**What**: The full export job lifecycle - from queuing through batch processing to completion.

**Extract from async-processor.lua**:
- `sort_entities_for_placement()` (lines 160-222)
- `queue_export()` (lines 230-341)
- `process_export_batch()` (lines 777-823)
- `complete_export_job()` (lines 941-1162)
- `handle_pending_file_write()` (lines 906-937)

**Interface**:
```lua
local ExportPipeline = {}
function ExportPipeline.queue(platform_index, force_name, requester_name, destination_instance_id)
function ExportPipeline.process_batch(job)      -- returns true when all entities scanned
function ExportPipeline.complete(job)            -- atomic belt scan, verification, compress, notify
return ExportPipeline
```

**Why separate**: Export is a complete, independent workflow. It touches locking, scanning, compression, and notification - but these are all export-specific orchestration. Moving this out removes ~350 lines from async-processor with zero coupling to import logic.

**Internal breakdown of `complete()`** (currently 220 lines):
- Atomic belt scan (~25 lines)
- Verification generation (~15 lines)
- Frozen states inclusion (~10 lines)
- Compression + storage (~40 lines)
- Duration/metrics calculation (~20 lines)
- Debug export (~5 lines)
- Game/RCON/Clusterio notifications (~50 lines)
- Result storage + cleanup (~30 lines)

Consider whether the notification block (~50 lines) should be a helper, but don't over-extract - it's export-specific payload building.

---

### 3. `core/import-pipeline.lua` (~350 lines)

**What**: Import job creation and batch processing (Phases 1-3 of entity creation).

**Extract from async-processor.lua**:
- `queue_import_from_file()` (lines 489-500)
- `queue_import()` (lines 508-772)
- `process_import_batch()` (lines 828-902)

**Interface**:
```lua
local ImportPipeline = {}
function ImportPipeline.queue_from_file(filename, platform_name, force_name, requester)
function ImportPipeline.queue(json_data, platform_name, force_name, requester)
function ImportPipeline.process_batch(job)   -- returns true when all entities placed
return ImportPipeline
```

**Why separate**: `queue_import()` alone is 265 lines of setup logic (JSON parse, decompress, validate transfer schema, create platform, apply starter pack, destroy non-hub starters, restore schedule, build job struct). This is self-contained platform initialization that has nothing to do with tick processing or completion.

**Internal cleanup opportunity**: `queue_import()` has an inline `platform_name_exists()` function and duplicate name resolution logic (~30 lines) that could become a helper, but this is optional polish - the main win is getting it out of async-processor.

---

### 4. `core/import-completion.lua` (~400 lines)

**What**: Post-entity-creation phases - the most complex part of the codebase.

**Extract from async-processor.lua**:
- `finish_import_job()` (lines 1166-1213) - Phase 1: hub inventories, belts, entity state
- `finish_import_job_phase3()` (lines 1218-1577) - Phase 2: inventories, validation, activation, fluids, loss analysis

**Interface**:
```lua
local ImportCompletion = {}
function ImportCompletion.run_phase1(job)   -- hub inv, belts, entity state; schedules phase2
function ImportCompletion.run_phase2(job)   -- inventories, validation, activation, fluids, notify
return ImportCompletion
```

**Why separate**: This is the most complex logic in the system and the most frequently modified (every bug fix around validation, activation ordering, fluid ghost buffers, beacon module ordering has touched these functions). Isolating it means:
- Changes to validation logic don't risk breaking tick dispatch
- The critical phase ordering (see CLAUDE.md "Import Phase Ordering") is documented in one focused file
- The 360-line `finish_import_job_phase3` can be further decomposed internally

**Internal decomposition of `run_phase2()`** (currently 360 lines):
```
run_phase2(job)
  |-- restore_inventories(job)          -- 2-pass beacon ordering (~30 lines)
  |-- deactivate_for_validation(job)    -- pause + deactivate (~15 lines)
  |-- run_validation(job)               -- adjust expected, validate, store result (~100 lines)
  |     |-- adjust_for_failed_entities()
  |     |-- adjust_for_overflow_losses()
  |     |-- TransferValidation.validate_import()
  |     |-- attach_loss_metadata()
  |-- handle_validation_result(job)     -- activate or leave paused (~80 lines)
  |     |-- on_success: activate, restore fluids, loss analysis
  |     |-- on_failure: log, leave paused
  |-- build_result_and_notify(job)      -- result storage + clusterio event (~60 lines)
```

Whether to split these into private functions within `import-completion.lua` or leave them inline is a readability judgment call. The key win is getting them out of async-processor.

---

## Resulting async-processor.lua (~250 lines)

After extraction, async-processor becomes a thin orchestrator:

```lua
local ImportSession = require("modules/surface_export/core/import-session")
local ExportPipeline = require("modules/surface_export/core/export-pipeline")
local ImportPipeline = require("modules/surface_export/core/import-pipeline")
local ImportCompletion = require("modules/surface_export/core/import-completion")

local AsyncProcessor = {}

-- Config (batch_size, sync_mode, etc.) - stays here, ~70 lines
-- init() - stays here, delegates to sub-modules
-- process_tick() - stays here, dispatches to pipelines
-- get_active_jobs() / get_job_status() - stays here, ~50 lines
-- prune_results() / calculate_progress() - stays here, ~20 lines

-- Delegated API surface:
function AsyncProcessor.queue_export(...)
  return ExportPipeline.queue(...)
end

function AsyncProcessor.queue_import(...)
  return ImportPipeline.queue(...)
end

function AsyncProcessor.begin_import_session(...)
  return ImportSession.begin(...)
end

-- process_tick: dispatch logic stays here
function AsyncProcessor.process_tick()
  -- ...existing job scheduling...
  if job.type == "export" then
    local complete = ExportPipeline.process_batch(job)
    if complete then ExportPipeline.complete(job) end
  elseif job.type == "import" then
    if job.pending_phase2_tick then
      ImportCompletion.run_phase2(job)
    else
      local complete = ImportPipeline.process_batch(job)
      if complete then ImportCompletion.run_phase1(job) end
    end
  end
end
```

---

## Execution Order

Ordered by **independence** (least coupling first) and **risk** (safest first):

### Step 1: Extract `import-session.lua`
- **Risk**: Low. Self-contained transport layer with no dependencies on export/import logic.
- **Test**: Chunked import still works end-to-end.
- **Lines moved**: ~140

### Step 2: Extract `export-pipeline.lua`
- **Risk**: Low-medium. Export is a well-understood, stable workflow.
- **Test**: Export + download flow, transfer export trigger.
- **Lines moved**: ~350

### Step 3: Extract `import-pipeline.lua`
- **Risk**: Medium. `queue_import()` is large but well-scoped (all setup, no state machine).
- **Test**: Upload-import, transfer import, file import.
- **Lines moved**: ~350

### Step 4: Extract `import-completion.lua`
- **Risk**: Medium-high. This is the most critical and fragile code (phase ordering, validation). Extract last so all other modules are stable.
- **Test**: Transfer with validation (the most complete integration test).
- **Lines moved**: ~400

### Step 5 (optional): Internal cleanup
- Break `run_phase2()` into named private functions
- Consider extracting notification payload builders if they get reused

---

## Shared State Concern

The job struct (stored in `storage.async_jobs[job_id]`) is the shared state between all phases. Currently it's a flat table with ~30 fields, populated by `queue_*` and mutated by every phase.

**Approach**: Don't change the job struct shape. All new modules receive the job table by reference and mutate it directly (same as today). This avoids a coordinated refactor of the job schema.

The only coupling is:
- `ExportPipeline.queue()` creates the job struct (must include all fields process_batch/complete expect)
- `ImportPipeline.queue()` creates the job struct (must include all fields process_batch/completion expect)
- `ImportCompletion.run_phase1()` sets `job.pending_phase2_tick` to signal phase transition
- `process_tick()` checks `job.pending_phase2_tick` to dispatch to phase 2

This is the same coupling that exists today, just across file boundaries.

---

## What NOT to Change

- **Job struct shape**: Keep the flat table. Don't introduce a Job class.
- **Phase ordering**: The 9-step import phase order is battle-tested. Move the code, don't reorder it.
- **Public API**: `AsyncProcessor.queue_export()`, `queue_import()`, `begin_import_session()`, etc. all keep their signatures. External callers (remote interface, commands) don't change.
- **Storage keys**: `storage.async_jobs`, `storage.import_sessions`, etc. remain unchanged.
- **Config module-locals**: `config.batch_size` etc. stay in async-processor and get passed to pipelines via function args or getter functions.

---

## File size summary

| File | Before | After (est.) |
|---|---|---|
| `core/async-processor.lua` | 1,699 | ~250 |
| `core/import-session.lua` | (new) | ~140 |
| `core/export-pipeline.lua` | (new) | ~350 |
| `core/import-pipeline.lua` | (new) | ~350 |
| `core/import-completion.lua` | (new) | ~400 |
| **Total** | **1,699** | **~1,490** |

Total line count grows slightly (imports, module boilerplate) but no single file exceeds 400 lines, and async-processor becomes a readable orchestrator.
