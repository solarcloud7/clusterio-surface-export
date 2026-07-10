# Implementation Summary

Technical deep-dive into the Surface Export plugin architecture.

## Module Structure

```
module/
├── control.lua                         Entry point (event_handler interface)
├── core/
│   ├── async-processor.lua             Multi-tick job processor (export/import)
│   ├── deserializer.lua                Entity creation & state restoration
│   ├── serializer.lua                  Synchronous export orchestrator
│   └── json.lua                        rxi/json.lua library
├── export_scanners/
│   ├── entity-scanner.lua              Surface scanning orchestrator
│   ├── entity-handlers.lua             Per-type serialization (assembler, belt, inserter, etc.)
│   ├── connection-scanner.lua          Circuit/power/control behavior extraction
│   ├── inventory-scanner.lua           Dynamic inventory discovery
│   └── tile_scanner.lua                Tile scanning
├── import_phases/                      (execution ORDER is critical and lives in ONE place:
│   │                                    CLAUDE.md § "Import Phase Ordering (Critical)" — validation runs
│   │                                    PRE-activation and fluids inject POST-activation, Pitfalls #15/#17)
│   ├── tile_restoration.lua            Place tiles
│   ├── platform_hub_mapping.lua        Map auto-created hub
│   ├── entity_creation.lua             Batched entity creation (deactivated for transfers)
│   ├── belt_restoration.lua            Single-tick belt items
│   ├── entity_state_restoration.lua    Connections, filters, behaviors
│   ├── active_state_restoration.lua    "Wake up" — restore entity.active (+ pre-gate held-item pass)
│   └── fluid_restoration.lua           Fluid injection — AFTER activation (Pitfall #17, frozen-entity fluid loss)
├── interfaces/
│   ├── remote-interface.lua            Remote interface registrar (the authoritative remote list)
│   ├── commands.lua                    Command loader (the authoritative command list)
│   ├── commands/                       individual command files (run `ls` — counts drift)
│   └── remote/                         remote interface implementations (run `ls` — counts drift)
├── utils/
│   ├── surface-lock.lua                Platform freeze/unfreeze/lock
│   ├── json-compat.lua                 JSON encode/decode + file I/O compat
│   ├── game-utils.lua                  Positions, entity categories, quality keys
│   ├── string-utils.lua                Timestamps, checksums, filename sanitization
│   ├── table-utils.lua                 Deep copy, merge, sum helpers
│   └── debug-export.lua               JSON debug file writer
└── validators/
    ├── transfer-validation.lua         Grouped item/fluid validation
    └── verification.lua                Export integrity verification
```

## Key Design Decisions

### Factorio 2.0 Constraints

1. **No runtime file reading** — `game.read_file()` was removed. File imports route through Node.js (`instance.ts` reads the file, sends via RCON chunks).

2. **`require()` at parse time only** — All `require()` calls are at module top level. Commands self-register during parse via `commands.add_command()`.

3. **`storage` replaces `global`** — All persistent state uses `storage.*` (the Factorio 2.0 equivalent).

4. **Dynamic inventory discovery** — `entity.get_max_inventory_index()` + `entity.get_inventory_name()` replaces hardcoded inventory indices.

5. **Wire connectors API** — `entity.get_wire_connectors()` replaces `circuit_connection_definitions`.

6. **Constant combinator sections** — Factorio 2.0 uses sections API instead of `signals_count`.

### Async Processing

The `AsyncProcessor` spreads export/import work across multiple game ticks:

- **Configurable batch size** (default: 50 entities per tick)
- **Max concurrent jobs** (default: 3)
- **Sync mode** available for debugging (processes everything in one tick)
- Jobs stored in `storage.async_jobs`, results pruned to last 25

### Platform Hub Handling

`space-platform-hub` is auto-created by Factorio when a platform is created — it **cannot** be manually placed via `surface.create_entity()`. The import:

1. Skips hub creation in `Deserializer.create_entity()`
2. `PlatformHubMapping.process()` finds the auto-created hub
3. Maps it to the original `entity_id` for connection restoration

### Entity Sort Order

Entities are sorted for proper placement:

1. Rails (foundation)
2. Underground belt inputs
3. Underground belt outputs
4. Pipe-to-ground
5. Regular entities

Ties broken by position for determinism.

## Export Data Format

```
{
  schema_version: "1.0.0",
  factorio_version: "2.0",
  mod_version: "1.0.0",
  export_timestamp: <tick>,
  platform: {
    name, force, index, surface_index,
    schedule,     // Platform travel schedule (stations, wait conditions, interrupts)
    paused        // Thrust mode
  },
  metadata: {
    total_entity_count, total_tile_count,
    total_item_count, total_fluid_volume
  },
  entities: [ <serialized_entity>, ... ],
  tiles: [ { name, position }, ... ],
  verification: {
    item_counts: { [quality_key]: count },
    fluid_counts: { [temp_key]: amount }
  },
  frozen_states: { [entity_id]: was_active }
}
```

### Entity Serialization

Each entity is serialized by `EntityScanner.serialize_entity()`:

```
{
  entity_id:     unit_number or stable_id ("name@x,y#dir[:orient]"),
  name, type, position, direction, force,
  health, quality, mirror, orientation,
  specific_data:        Per-type handler output (recipes, belt items, etc.),
  circuit_connections:   Wire connections (red/green),
  power_connections:     Copper cable connections (electric poles),
  control_behavior:      Circuit conditions, combinator signals,
  logistic_requests:     Requester/buffer chest requests,
  entity_filters:        Filter inserters, loaders,
  backer_name:           Train stop names,
  tags:                  Custom mod data
}
```

### Stable Entity IDs

Entities without `unit_number` (belts, poles, pipes, etc.) use a position-based stable ID: `"name@x.xxx,y.yyy#dir[:orient]"`. This is used consistently between:
- Export `frozen_states` keys
- Import `entity_map` keys
- `SurfaceLock` freeze/unfreeze tracking

### Compression

Export data is compressed via Factorio's `helpers.encode_string()` (deflate + base64). Stored as:

```
{
  compressed: true,
  compression: "deflate",
  payload: "<base64 deflate data>",
  verification: { ... }    // Also stored outside payload for quick access
}
```

## Export Flow

Production export/transfer is **asynchronous**: `AsyncProcessor.queue_export()` → `ExportPipeline`
(`module/core/export-pipeline.lua`) batches the work across ticks (default ~50 entities/tick) and does an
**atomic single-tick belt-item scan** (Pitfall #16, consistent belt snapshot) before building verification. A synchronous variant,
`Serializer.export_platform()` (`module/core/serializer.lua`), runs the same conceptual steps in one tick — it is
used by `clone-platform` (and therefore the integration-test fixture) and `/export-sync-mode`, and carries the
belt rolling-snapshot limitation the async path avoids.

The conceptual steps (async = pipeline phases, sync = inline steps):

1. Validate platform exists
2. Get surface reference
3. Scan entities → `EntityScanner.scan_surface()` (async: per-tick batches)
4. Scan tiles → `TileScanner.scan_surface()`
5. (async only) Atomic single-tick belt-item scan once all entities are captured (Pitfall #16, consistent belt snapshot)
6. Count items → `Verification.count_all_items()`
7. Count fluids → `Verification.count_all_fluids()`
8. Build export structure (+ `frozen_states`, `force_data`)
9. Verify internal consistency → `Verification.verify_export()`
10. Serialize to JSON (+ compression) → store in `storage.platform_exports[export_id]`

### Entity Handlers

`entity-handlers.lua` provides per-type `specific_data`:

| Type | Captured Data |
|------|--------------|
| `assembling-machine` | inventories, recipe, recipe_quality, crafting_progress, productivity_bonus, overload_multiplier |
| `furnace` | inventories, recipe, previous_recipe, crafting_progress |
| `transport-belt` | items per transport line with exact positions |
| `underground-belt` | belt items + `belt_to_ground_type` |
| `splitter` | belt items + filter/priority |
| `inserter` | held_item, pickup/drop_position, filter_mode, stack_size_override, spoil_priority |
| *(default)* | dynamic inventory + fluid extraction for any unhandled type |

### Inventory Scanner

Uses dynamic discovery — no hardcoded inventory indices:

- **Items**: name, count, quality, export_string (blueprints), health, durability, ammo, spoil_percent/result, label, custom_description
- **Equipment grids**: position, energy, shield, quality, burner fuel/result inventories
- **Belt items**: `get_detailed_contents()` → per-line items with exact position
- **Inserter held items**: `entity.held_stack` + `held_stack_position`

## Import Flow

### Phase Overview

> **Do not implement from this summary — the authoritative ordering is CLAUDE.md § "Import Phase Ordering
> (Critical)".** The two load-bearing rules a summary can silently rot on: **validation runs PRE-activation**
> (Pitfall #15 — active machines craft in the gap → false GAINS) and **fluid injection runs POST-activation**
> (Pitfall #17's empirical rule — injecting earlier reproducibly lost ~15% of fluids).

Condensed current order (transfers): tiles → hub mapping → entity creation (deactivated) → hub inventories →
belt items (single tick) → entity state → beacon activation + two-pass inventories → **validation
(pre-activation, strict; pre-gate held-item pass)** → **activation** → **fluid restoration (post-activation)** →
loss analysis.

After completion:
- **send_json event**: `surface_export_import_complete` to Node.js with metrics

### Transfer Safety Measures

- Platform **paused** immediately on import (prevents thruster fuel consumption during multi-tick import)
- All entities **deactivated** during creation (prevents recipe consumption before all items are placed)
- Belt items restored in **single tick** (belts can't be deactivated, items would move)
- Fluids restored via **segment aggregation** (inject into storage tanks preferentially, clamp to segment capacity)
- `frozen_states` carries original `entity.active` values to restore exact pre-export state

### Fluid Restoration Detail

Factorio's fluid system uses network segments — multiple connected pipes/tanks share a fluid network. The import:

1. Groups entities by fluid network segment
2. Calculates total expected fluid per segment
3. Injects into storage tanks preferentially (highest capacity)
4. Clamps to actual segment capacity
5. Tolerates partial loss (networks redistribute automatically)

## Validation System

### Export Verification (`verification.lua`)

Internal consistency check: recalculates item/fluid counts from serialized entities and compares against the `verification` section.

- Item counts must match exactly
- Fluid amounts allow 0.1 tolerance (floating point)

### Transfer Validation (`transfer-validation.lua`)

Post-import validation with **asymmetric tolerances**:

**Items:**
- GAINED items → fail (should never happen; tolerance: 5 for storage effects)
- Excessive LOSS → fail only if lost >95% AND >100 absolute items
- Logic: machines with `recipe.overload_multiplier` may reduce what fits

**Fluids:**
- GAIN > 500 → fail
- Complete disappearance of large volumes (>1000 expected, <1 actual) → fail
- Partial loss acceptable (fluid networks redistribute automatically)

**Unexpected items/fluids:**
- Flagged only if significant quantity (>20 items, >fluid minimum tolerance)

## Node.js Layer

### Hybrid JSON Escaping (`helpers.js`)

RCON commands embed JSON in Lua strings. Two strategies:

1. **Lua long string** `[[json]]` — fast, no escaping overhead. Used when JSON doesn't contain `]]`.
2. **`lib.escapeString()`** — escapes special characters, wraps in single quotes. Used when JSON contains `]]`.

The `]]` check is necessary because Lua long strings terminate on that sequence.

### Template-Based Chunking (`helpers.js`)

Large payloads are chunked for RCON transmission:

- `sendChunkedJson()`: Template with `%CHUNK%`, `%INDEX%`, `%TOTAL%` placeholders
- `sendAdaptiveJson()`: Auto-selects strategy based on size:
  - <50KB → direct send (no chunking)
  - 50KB–1MB → 50KB chunks  
  - \>1MB → 100KB chunks

### Controller Storage (`controller.ts`)

Export data stored in `platformStorage` map, persisted to `surface_export_storage.json`. Auto-cleanup when exceeding `max_storage_size` config (oldest first).

### Transaction Logging (`controller.ts`)

Events tracked per transfer: `transfer_created`, `import_started`, `validation_received`, `validation_timeout`, `source_deleted`, `rollback_success`, `transfer_completed`, `transfer_failed`.

Each event includes: ISO timestamp, `elapsedMs` from start, `deltaMs` from last event. Phase timing (transmission, validation, cleanup) is calculated. Last 10 logs persisted.

## Message Types

| Message | Type | Direction | Purpose |
|---------|------|-----------|---------|
| `ExportPlatformRequest` | request | controller/instance → instance | Trigger export |
| `PlatformExportEvent` | event | instance → controller | Export complete + data |
| `ImportPlatformRequest` | request | controller → instance | Send export data for import |
| `ImportPlatformFromFileRequest` | request | controller → instance | Import from file path |
| `ListExportsRequest` | request | control → controller | List stored exports |
| `TransferPlatformRequest` | request | control/instance → controller | Initiate transfer |
| `TransferValidationEvent` | event | instance → controller | Validation result |
| `DeleteSourcePlatformRequest` | request | controller → instance | Delete source after success |
| `UnlockSourcePlatformRequest` | request | controller → instance | Unlock source on failure |
| `TransferStatusUpdate` | request | controller → instance | In-game status messages |
| `GetTransactionLogRequest` | request | control → controller | Retrieve transfer logs |
