# Platform Export/Import Flow: Complete Action Trace

Step-by-step action breakdown of the export, import, and transfer flows, with the
real message names, send_json channels, remote-interface calls, and file/handler
locations to use when tracing or debugging an operation. (Absorbed the former
`TRANSFER_WORKFLOW_GUIDE.md` and `TRANSFER_CODE_PATHS.md`.)

All plugin paths below are relative to
`docker/seed-data/external_plugins/surface_export/`. All Lua `require` paths inside
the save-patched module use the `modules/surface_export/...` prefix.

## Table of Contents

- [Transfer Sequence Diagrams](#transfer-sequence-diagrams)
- [Surface Lock Mechanism](#surface-lock-mechanism)
- [Export Flow: Instance to Controller](#export-flow-instance-to-controller)
- [Import Flow: Controller to Instance](#import-flow-controller-to-instance)
- [Transfer Flow: Instance to Instance](#transfer-flow-instance-to-instance)
- [Validation Summary](#validation-summary)
- [Transaction Log Tracking](#transaction-log-tracking)
- [Code Reference Map](#code-reference-map)
- [Architecture Notes](#architecture-notes)
- [Debug Commands](#debug-commands)

## Transfer Sequence Diagrams

### Canonical end-to-end transfer

```mermaid
sequenceDiagram
autonumber
participant U as Initialize Transfer
participant SF as Factorio 1 (Lua)
participant SI as Host 1
participant C as Controller
participant DI as Host 2
participant DF as Factorio 2 (Lua)

U->>SF: /command
SF->>SF: Export Job
SF->>SI: clusterio_api.send_json("surface_export_complete", data)
SI->>C:  PlatformExportEvent + TransferPlatformRequest
C->>DI: ImportPlatformRequest
DI->>DF: Send import payload in chunks
DF->>DF: Run async import + validation preparation
DF->>DI: send_json event surface_export_import_complete
DI->>C: TransferValidationEvent

alt Validation success
  C->>SI: DeleteSourcePlatformRequest
  SI->>SF: Delete source platform surface
  C->>C: Mark completed + persist log
else Validation failed or timeout
  C->>SI: UnlockSourcePlatformRequest
  SI->>SF: Unlock source platform (rollback)
  C->>C: Mark failed + persist log
end
```

### Export internals (source side)

```mermaid
sequenceDiagram
autonumber
participant SF as Source Factorio (Lua)
participant SI as Source Instance Plugin
participant C as Controller

SF->>SF: Lock platform (cargo pods complete, entities freeze, surface hidden)
SF->>SF: Capture platform schedule (records + interrupts + group)

loop on_tick export batches
  SF->>SF: Serialize entities (belt contents deferred)
end

SF->>SF: Atomic single-tick belt scan
SF->>SF: Build verification counts + compress + store export by export_id
SF->>SI: send_json event surface_export_complete {export_id, metrics}
SI->>SF: RCON get_export_json(export_id)
SF-->>SI: Export payload
SI->>C: PlatformExportEvent(export_id, platformName, instanceId, exportData)
C->>C: Store export in platformStorage
```

### Import internals (destination side)

```mermaid
sequenceDiagram
autonumber
participant DI as Destination Instance Plugin
participant DF as Destination Factorio (Lua)

loop Chunk transfer
  DI->>DF: import_platform_chunk(platform, chunk, index, total, force)
  DF->>DF: Store chunk session
end

DF->>DF: Finalize chunks -> queue_import()
DF->>DF: Parse/decompress payload + validate transfer schedule payload
DF->>DF: Create platform + apply starter pack + pause platform

loop on_tick creation phases
  DF->>DF: Tile restoration
  DF->>DF: Hub mapping
  DF->>DF: Entity creation (entities kept inactive)
end

DF->>DF: Deferred hub inventory restore
DF->>DF: Belt restore (single tick)
DF->>DF: Entity state/connections restore
DF->>DF: Inventories (beacons first), complete held items, restore fluids — all paused/deactivated
DF->>DF: TransferValidation.validate_import(strict=true)

alt validation success
  DF->>DF: Unpause platform
  DF->>DF: Restore active states from frozen_states
  DF->>DF: Reporting-only post-activation recount
else validation failure
  DF->>DF: Bank always-on black box
  DF->>DF: Discard destination (unless debug preserve flag is armed)
end

DF->>DF: Store validation result
DF->>DI: send_json event surface_export_import_complete (verdict payload)
```

## Surface Lock Mechanism

A platform is locked while it is being exported or transferred so its entities are
not modified mid-scan. Locking freezes every activatable entity (recording each
entity's original `active` state so import can restore it), completes in-flight cargo
pods, hides the surface from players, and captures the platform schedule.

| Operation | Function | Storage key |
|-----------|----------|-------------|
| Lock | `SurfaceLock.lock_platform(platform, force, transfer_opts?)` | `storage.locked_platforms[platform.index]` (unique index, NOT name) |
| Unlock | `SurfaceLock.unlock_platform(platform_index, expected_name?)` | (removes the same entry; `expected_name` is a display tripwire only) |
| Check | `SurfaceLock.is_locked(platform_index)` | — |
| Activate after validation | `SurfaceLock.activate_all(surface)` | — |
| Transfer-lock expiry (source-side TTL) | `SurfaceLock.scan_transfer_expiries()` (on_tick, `%60`) | auto-unlocks expired `kind="transfer"` and `kind="export"` locks |

`lock_platform` returns `false` with `"Platform already locked"` if the platform is
already locked. The lock record stores `frozen_states` (entity id → original active
state), `original_hidden`, `original_schedule`, `surface_index`, and `locked_tick`.
Lock state lives in `storage`, so it survives save/load.

For export-only operations the source platform is unlocked after the export
completes. For transfers the source stays locked until cleanup (delete or unlock)
runs after the destination import is validated.

**File**: `module/utils/surface-lock.lua`

```powershell
# View locked platforms
./tools/clusterio/rcon.ps1 11 "/sc for name, data in pairs(storage.locked_platforms or {}) do game.print(name) end"

# Force unlock one platform (use with caution)
./tools/clusterio/rcon.ps1 11 "/unlock-platform <platform_name>"
```

## Export Flow: Instance to Controller

### 1. Queue the export (in Factorio)

An export is queued by the `/export-platform <index> [destination_instance_id]`
command (`module/interfaces/commands/export-platform.lua`) or by the
`ExportPlatformRequest` message handled on the instance plugin
(`instance.ts` → `handleExportPlatformRequest` → `exportPlatform`).

Both paths reach `AsyncProcessor.queue_export(platform_index, force_name,
player_name, destination_instance_id)`. When `destination_instance_id` is `nil`,
the job is export-only; when set, it is a transfer (the destination is carried
through to completion).

The instance plugin's `exportPlatform()` calls the Lua remote interface over RCON:

```text
remote.call("surface_export", "export_platform", platformIndex, forceName, targetArg)
```

`targetArg` is `"nil"` for export-only and the numeric instance id for a transfer
(`exportPlatform` only treats a positive integer as a transfer destination).

### 2. Async export processing (in Factorio)

The export job is processed across multiple ticks by the async processor and export
pipeline. Entity structure, inventories, fluids, and tiles are scanned in batches;
belt-item extraction is deferred to a single atomic pass at completion.

**Why the belt scan must be atomic (design constraint).** Belts keep moving even on a paused
platform — there is no frozen regime; a saturated lane is only jam-stable. A scan spread across
ticks would therefore read a world that changed underneath it and double-count or miss items. The
single atomic tick is what makes the export trustworthy, not an optimisation. The original rung
behind "belts keep moving" was measured pre-2.1.11 and was deleted on 2026-07-31 with the rest of
the stale evidence; the constraint is retained because the restore is built on it, but re-measure
before treating it as proven on this pin.

On completion the serialized export is
stored in the mod and the plugin is notified via the `surface_export_complete`
send_json channel.

```
AsyncProcessor.process_tick()                 [core/async-processor.lua]
  → ExportPipeline.process_batch()            [core/export-pipeline.lua]  (each tick until complete)
      → EntityScanner.scan_surface()          [export_scanners/entity-scanner.lua]
      → entity-handlers.lua                   (belt items deferred — skip_belt_items flag)
  → ExportPipeline.complete()                 (single tick, after all entities scanned)
      → atomic belt scan (extract_belt_items for all tracked belt entities)
      → Verification counts from the consistent serialized data
      → clusterio_api.send_json("surface_export_complete", data)
```

**Files**: `module/core/async-processor.lua`, `module/core/export-pipeline.lua`

### 3. Instance plugin receives the export

`instance.ts` registers `this.i.server.handle("surface_export_complete",
this.handleExportComplete.bind(this))`. `handleExportComplete`:

1. Reads the full serialized export from Lua via
   `remote.call("surface_export", "get_export_json", exportId)` (`getExportData`).
2. Sends it to the controller with a **`PlatformExportEvent`**
   (`exportId`, `platformName`, `instanceId`, `exportData`, `timestamp`,
   `exportMetrics`).
3. If `destination_instance_id` is present in the payload, it then sends a
   **`TransferPlatformRequest`** to the controller to start the transfer (unless the
   export was already controller-managed, tracked in
   `controllerManagedTransferExports`).

**File**: `instance.ts` (`handleExportComplete`)

### 4. Controller stores the export

`controller.ts` registers `this.c.handle(messages.PlatformExportEvent,
this.handlePlatformExport.bind(this))`. `handlePlatformExport` stores the export in
the in-memory `platformStorage` map (keyed by `exportId`), enforces the
`surface_export.max_storage_size` cap (`cleanupOldExports`), then persists storage to
disk and queues a platform-tree broadcast.

Storage is an in-memory `Map` persisted as a single JSON file under the controller's
`controller.database_directory` (see [Code Reference Map](#code-reference-map)), not
one file per export.

**File**: `controller.ts` (`handlePlatformExport`)

### Export-for-download variant

The web UI / `clusterioctl` "export for download" path sends an
**`ExportPlatformForDownloadRequest`** to the controller
(`handleExportPlatformForDownloadRequest`), which forwards an `ExportPlatformRequest`
with `targetInstanceId: null` to the source instance, waits for the export to be
stored (`orchestrator.waitForStoredExport`), and returns the stored export data in
the response for the browser to download.

## Import Flow: Controller to Instance

### Upload-import (JSON file uploaded through the UI)

1. The control connection sends an **`ImportUploadedExportRequest`** to the
   controller (`handleImportUploadedExportRequest`).
2. The controller creates an `import` operation record, injects `_operationId` into
   the payload, and forwards an **`ImportPlatformRequest`** to the target instance.
3. The instance plugin's `handleImportPlatformRequest` calls `importPlatform`, which
   sends the data to Lua in 100 KB chunks (`RCON_CHUNK_SIZE` in `helpers.ts`) via the
   `remote.call("surface_export", "import_platform_chunk", platform_name, chunk,
   index, total, force_name)` interface (`sendChunkedJson` in `helpers.ts`).
4. When all chunks arrive, `import-platform-chunk.lua` reassembles the JSON and calls
   `AsyncProcessor.queue_import(...)`.
5. On completion Lua emits the `surface_export_import_complete` send_json event. The
   instance forwards an **`ImportOperationCompleteEvent`** (carrying `operationId`) to
   the controller so non-transfer imports complete their transaction log
   (`handleImportOperationCompleteEvent`).

**Files**: `controller.ts` (`handleImportUploadedExportRequest`,
`handleImportOperationCompleteEvent`), `instance.ts` (`handleImportPlatformRequest`,
`importPlatform`, `handleImportCompleteValidation`),
`module/interfaces/remote/import-platform-chunk.lua`

### Import from a file on disk

`/plugin-import-file <file> <name>` (and the `ImportPlatformFromFileRequest` message)
route to `instance.ts` → `importPlatformFromFile`. Because Factorio 2.0 Lua cannot
read files, Node reads the file from the instance's `script-output/` directory and
sends it to Lua through the same `import_platform_chunk` interface.

**File**: `instance.ts` (`importPlatformFromFile`)

### Async import processing and validation (in Factorio)

The import job runs across multiple ticks. The post-placement phase ordering is
critical (hub inventories, belt items, entity state, two-pass inventory restoration, held-item
completion, frozen fluid restoration, exact validation, activation, reporting) and
is documented in CLAUDE.md under "Import Phase Ordering (Critical)". On completion
the mod emits `surface_export_import_complete` with validation and import metrics.

This list used to include a "beacon activation" phase. **There is no such phase** — the same
fiction was removed from CLAUDE.md and survived here. Beacons are never deactivated during entity
creation, nothing fills an energy buffer, and populating `beacon_modules` in inventory Pass 1 needs
no tick and no power. The one-tick gap between Phase 1 and Phase 2 is real, but it is a phase
boundary, not a beacon step: the field that carries it (`job.pending_beacon_tick`) is named after
the retired rationale, and the code comment beside it says plainly "waiting one tick before
inventory restore".

```
AsyncProcessor.process_tick()                     [core/async-processor.lua]
  → ImportPipeline.process_batch()                [core/import-pipeline.lua]  (async, multiple ticks)
      → Phase-0 force sync (raise-only inserter bonuses — dest-force research replication)
      → TileRestoration.process()                 [import_phases/tile_restoration.lua]
      → EntityCreation.process_batch()            [import_phases/entity_creation.lua]  (entities kept inactive)

ImportCompletion.run_phase1()  (single tick)      [core/import-completion.lua]
  → PlatformHubMapping.restore_hub_inventories()  [import_phases/platform_hub_mapping.lua]
  → BeltRestoration.restore()                     [import_phases/belt_restoration.lua]
  → EntityStateRestoration.restore_all()          [import_phases/entity_state_restoration.lua]
  → job.pending_beacon_tick = tick + 1            (wait 1 tick → Phase 2; the field name is
                                                   vestigial — see the note above, there is no
                                                   beacon-activation step)

ImportCompletion.run_phase2()  (single tick)      [core/import-completion.lua]
  → Deserializer.restore_inventories()  PASS 1: beacons only     [core/deserializer.lua]
     (beacon_modules populated → crafting_speed updates immediately)
  → Deserializer.restore_inventories()  PASS 2: all other entities
     (beacons first because the ordering is free; the old "set_stack cap widens with
      beacon-boosted crafting_speed" rationale was RETRACTED 2026-07-31 - measured
      speed-invariant on 2.1.11)
  → deactivate all entities, re-pause platform
  → ActiveStateRestoration.restore_held_items_only()   (single owner of held seating — gate counts a complete state)
  → FluidRestoration.restore()                    [import_phases/fluid_restoration.lua]  (paused/deactivated)
  → TransferValidation.validate_import(strict=true)    [validators/transfer-validation.lua]
     (ONE immutable exact item + by-name fluid verdict)
  → ActiveStateRestoration.restore()              (unfreeze + activate only after verdict success)
  → LatchRearm.schedule()                         [import_phases/latch_rearm.lua]
     (post-activation, non-gating: re-arms self-feedback decider latches; deferred
      multi-tick stage machine, runs paused or not, can never touch gate fields)
  → LossAnalysis.run()                            [validators/loss-analysis.lua]
     (reporting-only postActivationReport; cannot change verdict fields)
  → clusterio_api.send_json("surface_export_import_complete", result)
```

**Belt restore design constraints.** Two rules the restore is built on, kept here rather than in the
engine notes because they are properties of THIS pipeline, not of Factorio:

- **Engine transport-line identity is not a cross-import key.** The same physical belt does not carry
  a stable line identity from the source instance to the destination, so nothing may key a restore on
  it. The side partition is instead computed from populated-source `line_equals` grouping *within one
  execution*, where the comparison is meaningful.
- **Every item is placed at its captured source position.** Each payload side carries a compact
  `item_source_positions` array (source entity/line/position per stack), and `item_source_positions`
  is REQUIRED - a payload without it is refused rather than restored approximately. Top-of-line writes
  would otherwise trip the boundary handoff, where an item lands across the piece boundary onto the
  downstream line; when that crosses SIDES the census reads "nothing landed", which is how a retry can
  turn a misplacement into an excess.

Both were originally measured pre-2.1.11 and their rungs were deleted on 2026-07-31 with the rest of
the stale evidence. They are retained because the code depends on them - re-measure before treating
either as proven on this pin. Belt PHYSICS (what a lane is, what the fidelity unit is) stays in the
canonical belt section of [factorio-2.0-api-notes.md](factorio-2.0-api-notes.md); this section covers
only how the pipeline uses it.

For transfers, `instance.ts` → `handleImportCompleteValidation` consumes the validation
result carried by the Lua completion event (no name-keyed refetch) and sends a
**`TransferValidationEvent`** to the controller. For
non-transfer imports (those carrying an `operation_id`) it sends an
`ImportOperationCompleteEvent` instead.

**Files**: `module/core/async-processor.lua`, `module/core/import-pipeline.lua`,
`module/core/import-completion.lua`, `instance.ts` (`handleImportCompleteValidation`)

## Transfer Flow: Instance to Instance

A transfer combines an export and an import. It is driven by the controller's
**`TransferOrchestrator`** (`lib/transfer-orchestrator.ts`), registered on the
controller for `TransferPlatformRequest`, `StartPlatformTransferRequest`, and
`TransferValidationEvent`.

1. **Start.** `StartPlatformTransferRequest` (from the UI — `web/TransferModal.tsx`
   `handleSubmit()` → `SurfaceExportPlugin.startTransfer` in `web/index.tsx`) or
   `TransferPlatformRequest` (from an instance whose export carried a
   `destination_instance_id`) opens a transfer operation on the controller.
2. **Export.** The source platform is exported and locked (see
   [Export Flow](#export-flow-instance-to-controller)).
3. **Import.** The controller forwards an `ImportPlatformRequest` (with a
   `_transferId` in the payload) to the target instance.
4. **Validate.** The target instance imports, validates, and returns a
   `TransferValidationEvent`. The orchestrator handles it
   (`handleTransferValidation`).
5. **Cleanup.** On a validated transfer the controller asks the source instance to
   remove the source platform via a **`DeleteSourcePlatformRequest`**
   (`instance.ts` → `handleDeleteSourcePlatform`, which uses
   `game.delete_surface(...)` — `platform.destroy()` is a silent no-op, so teardown goes through
   `GameUtils.delete_platform`). On failure the source is unlocked via a
   **`UnlockSourcePlatformRequest`** (`handleUnlockSourcePlatform`).

In-game status messages are pushed to the source instance with
`TransferStatusUpdate` (`instance.ts` → `handleTransferStatusUpdate`).

**Files**: `lib/transfer-orchestrator.ts`, `instance.ts`
(`handleDeleteSourcePlatform`, `handleUnlockSourcePlatform`,
`handleTransferStatusUpdate`)

## Validation Summary

- Transfers require exact per-key item counts; gains, losses, and unexpected keys fail.
- Transfers require exact aggregate-by-name fluid volume within `1e-6`.
- Failed-entity items/fluids and engine-rejected output writes are subtracted before the gate; capacity drops are not.
- `failedStage` is set once from the mismatched category. Post-activation analysis cannot change gate fields.
- The loose non-strict policy remains only for non-transfer import callers.

## Transaction Log Tracking

Transaction logs are managed by the controller's `TransactionLogger`
(`lib/transaction-logger.ts`). Every operation (`transfer`, `export`, `import`) is
recorded as an operation record with a sequence of events. Two files under the
controller's `controller.database_directory` hold the result, with different jobs:

| File | Shape | Holds | Bounded |
|---|---|---|---|
| `surface_export_transaction_audit.jsonl` | append-only JSONL, one slim row per lifecycle event | every transfer — scalars only, no count maps | yes, by size: rotates at 32 MB keeping 8 generations (~288 MB ceiling, ~half a million transfers at the measured ~614 bytes/row) |
| `surface_export_transaction_logs.json` | single JSON array, upserted per transfer | the fat detail: events, phase timings, validation maps | yes — `surface_export.transaction_log_detail_entries`, default 100 |

Retention keeps detail preferentially: transfers whose export payload is still downloadable (so the
download button never outlives its data), then failures, then recent successes — with at least 25
slots reserved for successes so a burst of failures cannot erase every healthy example to compare
against. A missing or nonsensical cap keeps EVERYTHING rather than emptying the store.

Measured on a real store when retention first ran: 453 entries / 7.6 MB → 100 entries / 2.0 MB, while
the ledger went 453 → 454 rows and the transfer list still returned all 454.

The split exists because the two requirements pull apart. The detail store is read,
parsed, re-serialised and rewritten IN FULL on every persist, so its cost grows with
total history and cannot be left unbounded — but it is also the only record that a
transfer happened, and users need to see every transfer to satisfy themselves no
duplication occurred. Capping it alone would trade a cost problem for a trust problem.
The ledger answers "did it happen, and what was the verdict" in rows small enough to keep
forever; the detail store can then become a recent window without erasing history.

`ListTransactionLogsRequest` (the Transaction Logs tab's list) is served from the
ledger, folded one row per transfer. `GetTransactionLogRequest` (the per-transfer
detail view) still reads the detail store.

Two ledger rules worth knowing before changing it:

- A **terminal row beats a start row regardless of file position**. Transfer IDs are
  reused — `transferPlatform` replaces a failed record under the same ID, and the gallery
  batch suites reset the Lua counter and regenerate identical IDs — so a stale start row
  can legitimately appear after a terminal one.
- A **damaged line is skipped, not fatal**. It is reported with its line number and byte
  offset. This is deliberately unlike the detail store, where one bad byte makes the
  loader surface zero history and the writer refuse every future write until a human
  intervenes.

On first run after upgrade the ledger is derived from the existing detail entries and
written with a single atomic replace, so it either exists complete or not at all — a
crash partway leaves no ledger and the next boot re-derives. The migration never modifies
the detail store.

Rotated generations are named `…audit.1.jsonl`, `…audit.2.jsonl` and so on, generation 1 being the
newest. **The loader reads every generation, oldest first**, so a rotated transfer stays in the index
— a loader that read only the live file would silently delete the history the ledger exists to keep.
Rotation is size-based rather than age-based because the cost it bounds is disk, and rows arrive at
whatever rate the cluster transfers: an age rule would erase a quiet cluster's whole history while
failing to bound a busy one.

Common event progression: `transfer_created` → `import_started` → `validation_received` →
`transfer_completed`. The failure path includes rollback events (`rollback_attempt`,
`rollback_success`, `transfer_failed`); the timeout path records `validation_timeout`
then rollback, and if the destination finishes after the timeout its late verdict is
refused with a `validation_after_settle` event (a late SUCCESS also re-marks the
transfer `cleanup_failed` — the destination went live beside the restored source).

```powershell
# Latest transaction
./tools/surface-export/get-transaction-log.ps1

# Specific transaction
./tools/surface-export/get-transaction-log.ps1 -TransferId "<transferId>"

# List all transactions
./tools/surface-export/list-transaction-logs.ps1
```

## Code Reference Map

### Lua module (save-patched into Factorio)

| File | Purpose |
|------|---------|
| `module/control.lua` | Entry point: `on_init`, `on_load`, event handlers, GUI events |
| `module/interfaces/commands/` | In-game slash commands (`export-platform.lua`, `transfer-platform.lua`, `plugin-import-file.lua`, …) |
| `module/interfaces/remote/` | Remote-interface functions (`export-platform.lua`, `get-export.lua`, `import-platform-chunk.lua`, `get-validation-result.lua`, `unlock-platform.lua`, …) |
| `module/core/async-processor.lua` | Async job queue + per-tick processing |
| `module/core/export-pipeline.lua` | Export job lifecycle (scan + complete) |
| `module/core/import-pipeline.lua`, `import-completion.lua` | Import job lifecycle + completion |
| `module/export_scanners/` | Entity / inventory / connection / tile scanning |
| `module/import_phases/` | Restoration phases (tiles, hub, entities, state, belts, fluids) |
| `module/utils/surface-lock.lua` | Platform locking / freezing |
| `module/validators/` | Verification, transfer validation, loss analysis |

### TypeScript plugin (Node runtime)

| File | Purpose | Key handlers |
|------|---------|--------------|
| `instance.ts` | Instance plugin (RCON bridge) | `handleExportComplete`, `handleImportPlatformRequest`, `importPlatform`, `importPlatformFromFile`, `handleImportCompleteValidation`, `handleDeleteSourcePlatform` |
| `controller.ts` | Controller plugin (coordinator) | `handlePlatformExport`, `handleImportUploadedExportRequest`, `handleExportPlatformForDownloadRequest`, `handleImportOperationCompleteEvent` |
| `lib/transfer-orchestrator.ts` | Transfer lifecycle state machine | `handleTransferPlatformRequest`, `handleStartPlatformTransferRequest`, `handleTransferValidation` |
| `lib/transaction-logger.ts` | Event logging + persistence | — |
| `lib/subscription-manager.ts` | WebSocket subscriptions + broadcasting | — |
| `lib/platform-tree.ts` | Tree building + instance resolution | — |
| `messages.ts` | Message classes + JSON schemas | — |
| `helpers.ts` | Chunking, escaping, metric helpers | `sendChunkedJson` |

### send_json channels (Lua → Node)

`surface_export_complete`, `surface_import_file_request`,
`surface_export_import_complete`, `surface_platform_state_changed`,
`surface_transfer_request` — registered via `this.i.server.handle(...)` in
`instance.ts`.

### Messages (Node ↔ Node)

Export/store: `ExportPlatformRequest`, `PlatformExportEvent`,
`ExportPlatformForDownloadRequest`, `GetStoredExportRequest`, `ListExportsRequest`.
Import: `ImportPlatformRequest`, `ImportUploadedExportRequest`,
`ImportPlatformFromFileRequest`, `ImportOperationCompleteEvent`.
Transfer: `TransferPlatformRequest`, `StartPlatformTransferRequest`,
`TransferValidationEvent`, `DeleteSourcePlatformRequest`,
`UnlockSourcePlatformRequest`, `TransferStatusUpdate`.
UI / logs: `GetPlatformTreeRequest`, `SetSurfaceExportSubscriptionRequest`,
`ListTransactionLogsRequest`, `GetTransactionLogRequest`, plus the
`SurfaceExport*UpdateEvent` broadcast events.

**File**: `messages.ts`

### Storage locations

| Data | Location |
|------|----------|
| Stored exports | In-memory `platformStorage` map, persisted to a single JSON file under the controller's `controller.database_directory` |
| Transaction logs | In-memory maps, persisted to `surface_export_transaction_logs.json` under `controller.database_directory` |
| Locked platforms | `storage.locked_platforms` (Factorio save) |
| Chunked import sessions | `storage.chunked_imports` (Factorio save) |
| Debug dumps | Instance `script-output/` (only when `debug_mode` is on) |

For where logs actually land at runtime (host/controller JSON log files vs
`factorio-current.log`), see the Observability table in CLAUDE.md.

## Architecture Notes

Design constraints and data formats behind the flows above. (Absorbed from the former
`IMPLEMENTATION_SUMMARY.md`.)

### Factorio 2.0 constraints

1. **No runtime file reading** — `game.read_file()` was removed. File imports route through Node.js
   (`instance.ts` reads the file, sends via RCON chunks).
2. **`require()` at parse time only** — all `require()` calls are at module top level. Commands self-register
   during parse via `commands.add_command()`.
3. **`storage` replaces `global`** — all persistent state uses `storage.*` (enforced by `lint:lua`).
4. **Dynamic inventory discovery** — `entity.get_max_inventory_index()` + `entity.get_inventory_name()`
   replaces hardcoded inventory indices.
5. **Wire connectors API** — `entity.get_wire_connectors()` replaces `circuit_connection_definitions`.
6. **Constant combinator sections** — Factorio 2.0 uses the sections API instead of `signals_count`.

### Platform hub handling

`space-platform-hub` is auto-created by Factorio when a platform is created — it **cannot** be manually placed
via `surface.create_entity()`. The import skips hub creation in entity creation, then
`PlatformHubMapping` finds the auto-created hub and maps it to the original `entity_id` for connection
restoration.

### Entity sort order

Entities are sorted for proper placement: rails (foundation) → underground belt inputs → underground belt
outputs → pipe-to-ground → regular entities. Ties broken by position for determinism.

### Export data format

```
{
  schema_version, factorio_version, mod_version, export_timestamp,
  platform: { name, force, index, surface_index, schedule, paused },
  metadata: { total_entity_count, total_tile_count, total_item_count, total_fluid_volume },
  entities: [ <serialized_entity>, ... ],
  tiles: [ { name, position }, ... ],
  verification: { item_counts: { [quality_key]: count }, fluid_counts: { [temp_key]: amount } },
  frozen_states: { [entity_id]: was_active }
}
```

Each entity carries: `entity_id` (unit_number or stable ID), name/type/position/direction/force,
health/quality/mirror/orientation, `specific_data` (per-type handler output), circuit/power connections,
control behavior, manual logistic sections, entity filters, backer_name, and tags.

**Stable entity IDs**: entities without `unit_number` (belts, poles, pipes, …) use a position-based stable ID
`"name@x.xxx,y.yyy#dir[:orient]"`, used consistently across export `frozen_states` keys, import `entity_map`
keys, and `SurfaceLock` freeze/unfreeze tracking.

**Compression**: export data is compressed via Factorio's `helpers.encode_string()` (deflate + base64) and
stored as `{ compressed: true, compression: "deflate", payload: "<base64>", verification: {...} }` — the
verification block is duplicated outside the payload for quick access.

### RCON payload escaping (`helpers.ts`)

RCON commands embed JSON in Lua strings using a hybrid strategy: a Lua long string `[[json]]` (fast, no
escaping) when the JSON contains no `]]` sequence, else `lib.escapeString()` with single quotes (Lua long
strings terminate on `]]`). Chunking is `sendChunkedJson` at `RCON_CHUNK_SIZE = 100_000` bytes per command.

## Debug Commands

```powershell
# List platforms / exports on an instance (11 = host-1, 21 = host-2)
./tools/clusterio/rcon.ps1 11 "/list-platforms"
./tools/clusterio/rcon.ps1 11 "/list-exports"

# List exports as JSON (for scripting)
./tools/clusterio/rcon.ps1 11 "/sc rcon.print(remote.call('surface_export', 'list_exports_json'))"

# Lock status of all platforms
./tools/clusterio/rcon.ps1 11 "/lock-status"

# Confirm the remote interface is loaded
./tools/clusterio/rcon.ps1 11 "/sc rcon.print(remote.interfaces['surface_export'] ~= nil)"
```

For questions or issues, see [README.md](../README.md).
