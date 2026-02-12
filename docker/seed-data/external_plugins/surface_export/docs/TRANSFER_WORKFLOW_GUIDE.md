# Transfer Workflow Guide

Complete reference for platform transfers between Factorio instances.

## Transfer Overview

A transfer moves a space platform from one Clusterio instance to another. The process has 5 phases:

```
Lock → Export → Transfer → Import → Validate/Cleanup
```

**Automatic transfer** (recommended): The `/transfer-platform` command or `surface-export transfer` CLI command handles all phases automatically with rollback on failure.

**Manual transfer**: Individual commands/API calls for each phase. Useful for debugging or custom workflows.

## Automatic Transfer

### Via In-Game Command

```
/transfer-platform <platform_index> <destination_instance_id>
```

Example:
```
/transfer-platform 1 2
```

This triggers the full pipeline automatically.

### Via CLI

```bash
npx clusterioctl surface-export transfer <exportId> <instanceId>
```

Use `npx clusterioctl surface-export list` to find available export IDs.

### What Happens Internally

1. **Lock** — `SurfaceLock.lock_platform()`:
   - Complete all in-flight cargo pods (capture items)
   - Freeze all entities (`entity.active = false`), recording original states
   - Hide surface from players

2. **Export** — `AsyncProcessor.queue_export()`:
   - Scan all entities across multiple ticks (batch_size per tick)
   - Scan tiles
   - Generate live verification counts
   - Compress (deflate + base64)
   - Store in `storage.platform_exports`
   - Send `surface_export_complete` IPC to Node.js

3. **Transfer** — `instance.js` → `controller.js`:
   - Node.js retrieves full export via RCON (`get_export_json`)
   - Sends `PlatformExportEvent` to controller
   - Controller stores export data, creates transfer record
   - Controller sends `ImportPlatformRequest` to destination instance

4. **Import** — Destination `instance.js` → RCON:
   - Sends export data to Factorio in chunks (100KB per chunk, hybrid JSON escaping)
   - `import_platform_chunk` reassembles and queues import job
   - 7-phase import process (tiles → hub mapping → entities → fluids → belts → state → activate)
   - Platform paused during import to prevent fuel consumption

5. **Validate & Cleanup** — `controller.js`:
   - Destination runs `TransferValidation.validate_import()`:
     - Compares live item/fluid counts against export verification
     - Asymmetric tolerances (small losses OK, gains always flagged)
   - **On success**: Controller sends `DeleteSourcePlatformRequest` → source platform destroyed → transfer complete
   - **On failure**: Controller sends `UnlockSourcePlatformRequest` → source platform unlocked, entities reactivated → rollback complete
   - 120-second validation timeout triggers synthetic failure (rollback)

## Manual Transfer Steps

### Step 1: Lock the Platform

```
/lock-platform <name_or_index>
```

Or via RCON:
```
/sc remote.call('surface_export', 'lock_platform_for_transfer', <platform_index>, '<force_name>')
```

Verify lock status:
```
/lock-status <name_or_index>
```

### Step 2: Export

```
/export-platform <platform_index>
```

Or via RCON:
```
/sc local job_id = remote.call('surface_export', 'export_platform', <platform_index>, '<force_name>') rcon.print(job_id or 'nil')
```

Wait for the export to complete (watch for in-game notification or poll `list_exports_json`).

### Step 3: List Exports

```
/list-exports
```

Or via RCON:
```
/sc rcon.print(remote.call('surface_export', 'list_exports_json'))
```

Note the export ID for the next step.

### Step 4: Transfer via CLI

```bash
npx clusterioctl surface-export transfer <exportId> <targetInstanceId>
```

### Step 5: Monitor

The controller broadcasts status updates to both instances. Watch for:
- "Importing platform..." (green)
- "Validation passed ✓" (green) → source deleted automatically
- "Validation failed ✗ - Rolling back..." (red) → source unlocked automatically

### Manual Unlock (if needed)

If a transfer fails and the source wasn't automatically unlocked:
```
/unlock-platform <name_or_index>
```

## Platform Locking Detail

### What Gets Locked

1. **Cargo pods**: Descending pods → items captured into hub inventory → `force_finish_descending()`. Ascending pods → `force_finish_ascending()`. Awaiting launch → destroyed.

2. **Entities (35+ freezable types)**: Production (assembling machines, furnaces, mining drills, labs, rocket silos, agricultural towers), Power (reactors, generators, boilers, fusion), Logistics (inserters, loaders, pumps, roboports), Space (thrusters, asteroid collectors, cargo bays, hubs, landing pads), Misc (beacons, radar).

3. **Surface visibility**: Hidden from players via `force.set_surface_hidden(surface, true)`.

4. **Frozen state tracking**: Each entity's original `entity.active` state saved as `frozen_states[entity_id]`. This is critical — some entities are intentionally inactive (disabled by circuit conditions), and this state must be preserved.

### Lock Data Structure

```lua
storage.locked_platforms[platform_name] = {
  surface_index = ...,
  force_name = ...,
  frozen_states = { [entity_id] = was_active, ... },
  original_hidden = ...,     -- Was surface already hidden?
  original_schedule = ...,   -- Platform travel schedule backup
}
```

## Import Phases Detail

### Phase 1: Tile Restoration
Place all tiles first — entities need foundation.

### Phase 2: Platform Hub Mapping
`space-platform-hub` is auto-created when the platform is created. Cannot be manually placed. This phase finds the existing hub and maps it into the entity_map so connections can reference it.

### Phase 3: Entity Creation (Batched)
- Processes `batch_size` entities per tick
- Each entity: create → immediately deactivate → restore inventories (NOT fluids yet)
- Skip `space-platform-hub` (handled by Phase 2)
- Sort order: rails → underground-belt inputs → underground-belt outputs → pipe-to-ground → rest

### Phase 4: Fluid Restoration
- Groups entities by fluid network segment
- Calculates total expected fluid per segment
- Injects into storage tanks preferentially (highest capacity)
- Clamps to segment capacity

### Phase 5: Belt Restoration (Synchronous)
- **Must complete in a single tick** — belts can't be deactivated
- Uses `insert_at()` with exact positions from export
- Items placed on correct transport line at correct belt position

### Phase 6: Entity State Restoration
- Control behaviors (circuit conditions, combinator signals)
- Entity filters (filter inserters, loaders)
- Logistic requests (requester/buffer chests)
- Circuit connections (red/green wires)
- Power connections (copper cables between electric poles)

### Phase 7: Active State Restoration
- Restores `entity.active` from `frozen_states`
- This is the "wake up" signal — machines start processing, inserters start moving
- For transfers: platform is still paused (use `/resume-platform` when ready)

## Validation Rules

### Item Validation
| Condition | Result |
|-----------|--------|
| Gained items (not in export) | **FAIL** if >5 (tolerance for storage effects) |
| Lost >95% AND >100 absolute items | **FAIL** |
| Partial loss (<95% or <100 items) | **WARN** (machines may cap with overload_multiplier) |
| Unexpected item type, quantity >20 | **FLAG** |

### Fluid Validation
| Condition | Result |
|-----------|--------|
| Gained >500 units | **FAIL** |
| Expected >1000, actual <1 | **FAIL** (complete disappearance) |
| Partial loss | **OK** (networks redistribute) |
| Unexpected fluid type, significant quantity | **FLAG** |

## Transaction Logs

Every transfer generates a transaction log with timestamped events:

- `transfer_created` → `import_started` → `validation_received` → `source_deleted` → `transfer_completed`
- Or on failure: `transfer_created` → `import_started` → `validation_received` → `rollback_success` → `transfer_failed`
- Or on timeout: `transfer_created` → `import_started` → `validation_timeout` → `rollback_success` → `transfer_failed`

### Viewing Logs

```bash
# List all transfer logs
.\tools\list-transaction-logs.ps1

# Get latest log
.\tools\get-transaction-log.ps1

# Get specific log
.\tools\get-transaction-log.ps1 -TransferId <transfer_id>
```

Each event includes `elapsedMs` from start and `deltaMs` from previous event, with phase timing (transmission, validation, cleanup).

## Troubleshooting

### Platform stuck in locked state
```
/unlock-platform <name_or_index>
```
This restores entity active states, unhides surface, and clears lock data.

### Transfer times out (120s)
The controller triggers a synthetic validation failure → automatic rollback. Check:
- RCON connectivity between controller and destination instance
- Destination instance actually running
- Export data size (very large platforms may need more time)

### Validation fails — items missing
Common causes:
- Machines with `overload_multiplier` recipes cap internal inventories differently
- Items consumed during the multi-tick import (entities should be deactivated — this indicates a bug)
- Belt items shifted (belt restoration should be single-tick — this indicates a bug)

### Validation fails — items gained
Should never happen. Indicates:
- Entity state restoration added unexpected items
- Platform hub auto-created with starter pack items (should be handled by hub mapping)

### "Platform name already exists"
Import auto-appends `#N` suffix on conflict. The platform will be created as e.g., `"My Platform #2"`.
