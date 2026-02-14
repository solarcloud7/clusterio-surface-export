# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with the clusterio-surface-export project.

## clusterio-surface-export Project Overview

This project provides tools for exporting and importing Factorio Space Age platforms between Clusterio instances. It consists of:

1. **Factorio Mod** (`src/surface_export_mod/`): Lua mod that serializes/deserializes platform entities, inventories, fluids, and tiles
2. **Clusterio Plugin** (`src/surface_export_plugin/`): TypeScript plugin for cross-instance platform transfer
3. **PowerShell Tools** (`tools/`): Helper scripts for deployment, import, export, and validation

**Key Features (v1.0.88)**:
- Complete platform state export/import (entities, inventories, fluids, tiles)
- Async processing to prevent game freezing
- Graceful handling of mod content mismatches
- Factorio 2.0 compatibility (handles read-only properties)
- Chunked RCON protocol for large payloads (>8KB)

**Performance**: Small platforms (<8KB): ~1-2s | Large platforms (235KB): ~40s (RCON bottleneck)

**Current Cluster Configuration:**
- Uses pre-built images from `ghcr.io/solarcloud7/clusterio-docker-controller` and `ghcr.io/solarcloud7/clusterio-docker-host`
- Controller: `clusterio-controller` (Web UI: http://localhost:8080)
- Host 1: `clusterio-host-1` → Instance: `clusterio-host-1-instance-1` (ports 34100-34109)
- Host 2: `clusterio-host-2` → Instance: `clusterio-host-2-instance-1` (ports 34200-34209)
- Runtime data in Docker volumes (not bind-mounted directories)
- Seed data convention from [solarcloud7/clusterio-docker](https://github.com/solarcloud7/clusterio-docker)
- **Seeding is idempotent**: Fixed in base image — `seed-instances.sh` checks if instance exists before creating, controller writes `.seed-complete` marker, hosts detect token desync (see Pitfall #9). Still recommend `docker compose down -v` for cleanest restarts.

## RCON Commands (PowerShell Profile Aliases)

**CRITICAL**: These aliases are defined in the user's PowerShell profile. Always use them instead of raw docker commands.

### Core RCON Aliases
```powershell
rc <host> <instance> "<command>"   # Send RCON command to any instance
rc11 "<command>"                   # Shortcut: Host 1, Instance 1
rc21 "<command>"                   # Shortcut: Host 2, Instance 1
rclist                             # List all instances + validate mod loaded
```

### Common RCON Usage Examples
```powershell
# List platforms on instance 1
rc11 "/list-platforms"

# Export platform (queues async export)
rc11 "/export-platform 1"

# Check export data (JSON for RCON)
rc11 "/sc rcon.print(remote.call('surface_export', 'list_exports_json'))"

# List exports in memory
rc11 "/list-exports"

# Get game time
rc11 "/time"

# Execute Lua code (use /sc for silent, /c for verbose)
rc11 "/sc rcon.print(game.tick)"
rc11 "/c game.print('Hello')"
```

### Raw Docker RCON (avoid when aliases available)
```powershell
docker exec surface-export-controller npx clusterioctl --log-level error instance send-rcon "clusterio-host-1-instance-1" "/list-platforms"
```

## Development Tools

### Primary Deployment Script
```powershell
./tools/deploy-cluster.ps1                 # Full deployment: increment version, pull images, start cluster
./tools/deploy-cluster.ps1 -SkipIncrement  # Deploy without version bump
./tools/deploy-cluster.ps1 -SkipIncrement -KeepData  # Restart without wiping volumes
```

### Hot Reload Development (Recommended)

The plugin uses **save patching** with bind-mounted source:
- Plugin location: `docker/seed-data/external_plugins/surface_export/`
- Mounted into containers via `external_plugins/` volume (auto-installed by base image)
- Contains both Node.js plugin code and Lua `module/` directory

**Plugin Changes** (TypeScript/JavaScript):
- Edit `*.js` files in plugin root → Restart container to pick up changes
- No image rebuild needed

**Module Changes** (Lua - Save Patched):
- Edit `*.lua` files in `module/` directory → Restart instances to re-patch saves
- Clusterio automatically injects Lua code into saves at startup

**Development Workflow**:
1. Start cluster: `docker compose up -d`
2. Edit plugin JS files → restart containers to pick up changes
3. Edit module Lua files → restart instances: `clusterioctl instance stop-all && clusterioctl instance start-all`
4. Saves are automatically patched with your Lua code

### Import/Export Tools
```bash
# Recommended: Use bash script inside container (100KB chunks, ~3.4s)
docker exec surface-export-host-1 bash -c 'cat /clusterio/external_plugins/surface_export/docs/import-platform-linux.sh | bash -s -- \
  /path/to/export.json clusterio-host-1-instance-1'

# Alternative: PowerShell on Windows (4KB chunks, slower due to docker exec overhead)
./tools/import-platform.ps1 -ExportFile "path/to/export.json" -InstanceName "clusterio-host-1-instance-1"

# Export and validation
./tools/export-platform.ps1 -PlatformIndex 1 -HostNumber 1 -InstanceNumber 1
./tools/validate-cluster.ps1       # Run health checks on cluster
```

## Clusterio Architecture (Reference)

Clusterio is a clustered Factorio server manager using a WebSocket Link Protocol where the Controller routes messages between Hosts (which run Factorio instances) and control interfaces.

### Key Components
- **Controller**: Central hub routing messages, managing cluster state
- **Host**: Manages Factorio instances, handles RCON communication
- **Instance**: Individual Factorio server with patched Lua modules
- **Ctl**: CLI tool (`clusterioctl`) for cluster management

## Project File Structure

```
src/
├── surface_export_mod/           # Factorio Lua mod
│   ├── info.json                 # Mod metadata (version here!)
│   ├── control.lua               # Main entry point, remote interfaces, commands
│   └── scripts/
│       ├── async-processor.lua   # Async job queue (import/export batching)
│       ├── serializer.lua        # Entity → JSON export logic
│       ├── deserializer.lua      # JSON → Entity import logic
│       ├── entity-scanner.lua    # Entity state capture
│       ├── util.lua              # JSON encoding, checksums, helpers
│       └── verification.lua      # Data integrity checks
│
├── surface_export_plugin/        # Clusterio TypeScript plugin
│   ├── package.json              # Plugin metadata (version here!)
│   ├── index.ts                  # Plugin entry point
│   ├── controller.ts             # Controller-side logic
│   ├── instance.ts               # Instance-side logic
│   └── messages.ts               # IPC message definitions
│
tools/
├── deploy-cluster.ps1            # Main deployment script
├── import-platform.ps1           # Chunked import via RCON
├── export-platform.ps1           # Export trigger helper
└── validate-cluster.ps1          # Cluster health checks

docker/
├── env/                          # Environment config (controller.env, host.env)
└── seed-data/                    # Seed data: database, mods, saves, plugins

docker-compose.yml                  # Cluster definition (uses pre-built GHCR images)
```

## Key Technical Constraints

### RCON Throughput Limits
- **Factorio throttles RCON**: ~100 bytes/tick = ~6 KB/s
- **Max single command**: ~8KB before timeout risks
- **Solution**: Chunked import (4KB chunks) with async processing

### Async Processing Model
- Import/Export use batched async processing (~100 entities/tick)
- Jobs queued via `AsyncProcessor.queue_import()` / `queue_export()`
- Progress tracked in `storage.async_jobs`
- Results stored in `storage.async_job_results`

### Remote Interface (`surface_export`)
```lua
-- Key remote interface functions (call via /sc remote.call(...))
-- Export:
remote.call("surface_export", "export_platform", platform_index, force_name)
remote.call("surface_export", "export_platform_to_file", platform_index, force_name, filename)
remote.call("surface_export", "get_export", export_id)
remote.call("surface_export", "get_export_json", export_id)  -- JSON string for RCON
remote.call("surface_export", "list_exports")
remote.call("surface_export", "list_exports_json")  -- JSON string for RCON
remote.call("surface_export", "clear_old_exports", max_to_keep)

-- Import (chunked RCON — Factorio 2.0 removed runtime file reading):
remote.call("surface_export", "import_platform_chunk", platform_name, chunk_data, chunk_num, total_chunks, force_name)

-- Platform locking (transfer workflow):
remote.call("surface_export", "lock_platform_for_transfer", platform_index, force_name)
remote.call("surface_export", "unlock_platform", platform_name)

-- Validation:
remote.call("surface_export", "get_validation_result", platform_name)
remote.call("surface_export", "get_validation_result_json", platform_name)  -- JSON string for RCON

-- Configuration:
remote.call("surface_export", "configure", config_table)

-- Debug/testing:
remote.call("surface_export", "clone_platform", platform_index, force_name, new_name)
remote.call("surface_export", "test_import_entity", entity_json, surface_index, position)
remote.call("surface_export", "run_tests")
```

### In-Game Commands
```
/export-platform <index>          # Export platform (async)
/export-platform-file <index>     # Export to disk file
/export-sync-mode <index>         # Export platform synchronously
/list-platforms                   # List all platforms
/list-exports                     # List exports in memory
/list-surfaces                    # List all surfaces
/transfer-platform <index> <dest> # Transfer platform to another instance
/lock-platform <index>            # Lock platform for transfer
/unlock-platform <name>           # Unlock a locked platform
/lock-status                      # Show lock status of all platforms
/resume-platform <name>           # Resume a locked platform
/plugin-import-file <file> <name> # Import from file via plugin
/step-tick <count>                # Debug: step N ticks
/test-entity <json>               # Debug: test entity import
```

## Common Pitfalls & Solutions

### 1. Empty RCON Response
**Symptom**: `rc11` returns nothing
**Cause**: Instance not running or mod not loaded
**Fix**: Run `rclist` to check status, then `./tools/validate-cluster.ps1`

### 2. Import Fails Silently
**Symptom**: Import command returns but no platform created
**Cause**: JSON too large for single RCON command
**Fix**: Use `./tools/import-platform.ps1` which handles chunking

### 3. Version Mismatch After Deploy
**Symptom**: Old code still running after deploy
**Fix**: Ensure `deploy-cluster.ps1` completed successfully, check for container restart

### 4. Lua `storage` vs `global`
**Important**: Factorio 2.0 renamed `global` to `storage`. Always use `storage.` for persistent data.

### 5. Finding Platform Index
Platform indices are **per-force** and **1-based**. Use `/list-platforms` to find correct index.

### 6. Read-Only Entity Properties (Factorio 2.0)
**Symptom**: Crash with "property is read only" error
**Cause**: Factorio 2.0 made many properties read-only (quality, productivity_bonus, etc.)
**Fix**: Set properties during entity creation, not after. Use pcall for optional properties.

### 7. Unknown Items During Import
**Symptom**: Import crashes with "Unknown item name: ..." 
**Cause**: Export from modded game, importing to instance with different mods
**Expected**: v1.0.84+ gracefully skips unknown items with warnings. Check logs for what was skipped.

### 8. Missing Tiles After Import
**Symptom**: Entities present but no floor tiles
**Cause**: Export created with version < 1.0.87 (before tile support)
**Fix**: Re-export platform with v1.0.87+ to include tiles

### 9. Duplicate Instances on Restart (Seeding Idempotency)
**Symptom**: Extra instances appear after restarting the cluster (e.g., `clusterio-host-2-instance-2` alongside the expected `instance-1`)
**Cause**: The base image's `seed-instances.sh` (in [solarcloud7/clusterio-docker](https://github.com/solarcloud7/clusterio-docker)) unconditionally calls `clusterioctl instance create` with `|| true` error swallowing. Clusterio allows multiple instances with the same name (they get different UUIDs), so if seeding runs again, duplicates are created. The `FIRST_RUN` guard (checks for `config-controller.json`) normally prevents re-seeding, but any scenario where the controller volume is wiped while host volumes persist — or an interrupted first run — can trigger duplicate creation.

**Root Cause Location**: **Base image repository** (`solarcloud7/clusterio-docker`), specifically `scripts/seed-instances.sh`. This is **not** a bug in this project's code.

**Required Fixes** (in `solarcloud7/clusterio-docker`):
1. **P0 — Idempotent `seed_instance()`**: Before calling `instance create`, check if an instance with that name already exists via `clusterioctl instance list` and skip if found.
2. **P1 — Seed-complete marker**: Write a `.seed-complete` marker file to the controller data volume after successful seeding. Check it alongside `FIRST_RUN` so an interrupted first run re-attempts seeding (with idempotent instance creation) rather than silently skipping.
3. **P2 — Token desync detection**: In `host-entrypoint.sh`, compare the stored token against the shared token volume. If they differ (controller volume was wiped and regenerated new tokens), reconfigure the host automatically.

**Current Workaround**: Always use `docker compose down -v` (with `-v` to remove volumes) before `docker compose up -d` for a clean restart. This ensures seeding starts from scratch. Plain `docker compose down` + `up -d` may produce duplicates if volumes get into an inconsistent state.

### 10. Instances Missing Space Age Mods
**Symptom**: Platforms don't exist, Space Age entities missing, game runs in base-game-only mode
**Cause**: `DEFAULT_MOD_PACK` defaults to `"Base Game 2.0"` in the base image controller entrypoint
**Fix**: Set `DEFAULT_MOD_PACK=Space Age 2.0` in `docker/env/controller.env`. Requires `docker compose down -v` + rebuild since mod pack is assigned on first run only.

### 11. Both Instances Have Same Game Port
**Symptom**: Only one instance reachable via game browser, both show same port in Clusterio UI
**Cause**: Each host auto-assigns game port from its `host.factorio_port_range`. Previously all hosts defaulted to the same range (34100-34199), so all first instances got port 34100.
**Fix**: Fixed in base image — `host-entrypoint.sh` now derives port range from HOST_ID (host N → `34N00-34N99`). Docker-compose port mappings must match. Requires `docker compose down -v` + image rebuild since port range is set on first host configuration only.

### 12. Clusterio API Require Path (CRITICAL)
**Symptom**: "Clusterio API not available - aborting" when running `/transfer-platform`, or `clusterio_api` is nil
**Cause**: Lua code uses `require("__clusterio_lib__/api")` with `script.active_mods["clusterio_lib"]` guard. This is **wrong** — `clusterio_lib` is NOT a Factorio mod. Clusterio injects its API via **save-patching** under `modules/`, not as a registered mod. `script.active_mods["clusterio_lib"]` will always be `nil`.
**Fix**: Use `require("modules/clusterio/api")` — this is the save-patched module path. See [Clusterio plugin docs](https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md).
```lua
-- WRONG (Factorio mod path — clusterio_lib is not a mod):
if script.active_mods["clusterio_lib"] then
  clusterio_api = require("__clusterio_lib__/api")
end

-- CORRECT (save-patched module path):
local clusterio_api = require("modules/clusterio/api")
```
**Key Concept**: Clusterio has two Lua injection mechanisms:
- **Save-patching** (`modules/`): Plugin modules injected into saves at instance start. Use `require("modules/...")`
- **Factorio mod** (`__clusterio_lib__`): A real Factorio mod that would need to be in the mod pack. NOT used by save-patched plugins.

### 13. Debug Mode Lost After Save Reset
**Symptom**: Integration tests fail with "Debug mode not enabled on source instance" after patch-and-reset
**Cause**: `debug_mode` is stored in `storage.surface_export_config`, which lives in the save file. When saves are wiped (by `patch-and-reset.ps1`), the config is gone.
**Fix**: `on_init()` in `control.lua` now defaults `debug_mode = true` for fresh saves:
```lua
storage.surface_export_config = storage.surface_export_config or { debug_mode = true }
```
If the default was added after the current save was created, you need either:
- A `patch-and-reset` (since the default only runs on `on_init`, which only fires for fresh saves)
- Or manual enable: `rc11 "/sc remote.call('surface_export', 'configure', {debug_mode = true})"`

### 14. Instance 2 "Platform Hasn't Been Built Yet"
**Symptom**: Connecting to instance 2 shows "space platform hasn't been built yet" for spikedoom08, `/list-platforms` shows 0 entities
**Cause**: Instance 2 uses a **minimal seed save** (`test2.zip`) that has a platform stub in save metadata but no physical space platform hub entity. The surface doesn't actually exist.
**Expected behavior**: Instance 2 is the **import target**. Integration tests clone from the fully-built "test" platform on host 1 (1359 entities) and transfer it to host 2. The empty spikedoom08 is not used for exports.

### 15. Entity Activation Before Validation (Historical Bug, Fixed)
**Symptom**: Transfer validation fails with "Item mismatches: iron-plate: GAINED items — expected 590, got 600"
**Cause**: `ActiveStateRestoration.restore()` was called as Phase 7 of import (before validation), which re-activated machines. In the ticks between activation and item counting, furnaces processed iron ore → iron plate, causing a net gain that triggered validation failure.
**Fix**: For **transfers only**, Phase 7 (activation) is deferred until after validation passes. Entities stay deactivated through all restoration phases and validation. Activation happens via `ActiveStateRestoration.restore()` using `frozen_states` only after `TransferValidation.validate_import()` succeeds. On failure, entities are left deactivated for investigation.
**Key files**: `async-processor.lua` (`complete_import_job` function), `active_state_restoration.lua`
**See**: [TRANSFER_WORKFLOW_GUIDE.md](docker/seed-data/external_plugins/surface_export/docs/TRANSFER_WORKFLOW_GUIDE.md) — "Entity Lifecycle (Critical Invariant)" section

### 16. Verification Counts From Live Scan vs Serialized Data (CRITICAL — Fixed)
**Symptom**: Transfer validation fails with "GAINED items" across many item types (iron-plate, copper-cable, piercing-rounds-magazine, etc.). Gains are a fraction of belt item totals.
**Cause**: Export verification used `Verification.count_surface_items()` (live scan) AFTER entity scanning completed across multiple ticks. **Belt items can't be deactivated** — they keep moving on locked platforms. During the multi-tick export, items move between belts causing a "rolling snapshot" effect: an item on belt A captured in tick 1 may move to belt B captured in tick 5 → double-counted in serialized data. Conversely, items can move from unscanned to already-scanned belts and be missed. The net result is the serialized data doesn't match the live surface state at any single point in time.
**Fix (v2 — Atomic Belt Scan)**: Belt item extraction is now **deferred** during async entity scanning. Entity structure (position, direction, type, belt_to_ground_type, etc.) is still captured async per-tick, but `extract_belt_items()` is skipped (controlled by `EntityHandlers.skip_belt_items` flag). When all entities are scanned, `complete_export_job` does a single-tick atomic pass over all tracked belt entities, calling `extract_belt_items()` and patching the serialized data. This gives a consistent snapshot: no items can move between belts within a single tick. Verification is then generated from this consistent serialized data.
**Key files**: `entity-handlers.lua` (`skip_belt_items` flag on transport-belt/underground-belt/splitter handlers), `async-processor.lua` (`process_export_batch` sets flag + tracks belt entities, `complete_export_job` atomic belt scan block before verification)
**Previous approach (v1)**: Used `Verification.count_all_items()` from serialized data for verification (self-consistent but inaccurate). This masked the problem — verification matched import, but both were based on inconsistent belt data.

## Architecture Overview

### Core Packages (`/packages/`)

- **lib**: Shared library containing the Link Protocol, config system, plugin framework, data structures, logging, and messaging. All other packages depend on this.
- **controller**: Central hub coordinating all hosts, provides the web interface, routes messages between components, manages user authentication and cluster-wide state.
- **host**: Manages Factorio server instances on a physical machine, handles RCON communication, patches saves with Lua modules at runtime.
- **ctl**: Command-line interface tool providing the same functionality as the web UI.
- **web_ui**: React-based web interface components using Ant Design, built with Webpack Module Federation for plugin extensibility.
- **create**: Installation wizard/bootstrapping tool (`npm init @clusterio`).

### Built-in Plugins (`/plugins/`)

Plugins extend functionality across controller, host, instance, ctl, and web components. Each plugin has separate entrypoints for these contexts and can define custom messages, config fields, and UI components.

Key built-in plugins: global_chat, research_sync, statistics_exporter, player_auth, inventory_sync

### Communication Architecture

**Link Protocol**: Custom WebSocket-based message routing with typed addressing (controller, host, instance, control, broadcast).

**Message Flow**:
1. Controller manages central state and routes messages
2. Hosts run Factorio instances and communicate via RCON
3. Instances (Factorio servers) are patched with Lua modules at runtime
4. Web UI connects via WebSocket for real-time updates
5. Ctl provides CLI access to same functionality as Web UI

**Message Types**: Request/Response pattern and Event broadcasting

### Key Files for Understanding Architecture

- [packages/lib/src/link/link.ts](packages/lib/src/link/link.ts) - Core message routing
- [packages/lib/src/plugin.ts](packages/lib/src/plugin.ts) - Plugin system
- [packages/lib/src/config/classes.ts](packages/lib/src/config/classes.ts) - Configuration system
- [packages/controller/src/Controller.ts](packages/controller/src/Controller.ts) - Central controller
- [packages/host/src/Host.ts](packages/host/src/Host.ts) - Host management
- [packages/host/src/Instance.ts](packages/host/src/Instance.ts) - Factorio instance management
- [packages/lib/src/data/messages_core.ts](packages/lib/src/data/messages_core.ts) - Core message definitions

### Frontend Build (Webpack)

- Module Federation enables runtime loading of plugin UIs
- SWC loader for fast TypeScript/JSX compilation
- Development mode with `--dev` flag for hot reload
- Production builds use Terser minification

### Factorio Integration (Lua)

- Custom module system using event_handler library
- Save patching to inject Clusterio code at runtime
- RCON protocol for server communication
- JSON serialization for data exchange
- Lua modules located in `/packages/host/modules/` and `/packages/host/lua/`
- **Clusterio API path**: Always `require("modules/clusterio/api")` for save-patched modules (see Pitfall #12)
- **IPC from Lua→Node**: `clusterio_api.send_json("channel_name", data_table)` — plugin listens via `server.handle("channel_name", handler)`
- **IPC from Node→Lua**: `this.sendRcon("/sc ...")` to execute Lua via RCON

## Code Style and Conventions

### General Style (enforced by ESLint)

- **Indentation**: Tabs (not spaces, except in Markdown)
- **Line length**: 120 characters (tabs count as 4)
- **Strings**: Double quotes `"` (single quotes `'` if string contains double quotes)
- **Naming (TypeScript)**:
  - Variables/members: camelCase
  - Classes: PascalCase
  - Config values: lowercase_underscore
  - Booleans: Start with verb unless ending in "ed" (e.g., `canRestart`, `isEnabled`, `connected`)
  - Times/durations: End with SI unit (e.g., `updatedAtMs`, `timeoutS`)
- **Naming (Lua)**: Everything uses lowercase_underscore
- **File naming**:
  - lowercase_underscore for files exporting multiple values
  - PascalCase for single-class exports

### Imports Within `lib` Package

When importing files within the lib package, prefix all imports with "lib" to avoid naming conflicts:

```typescript
import * as libConfig from "./config";
import * as libErrors from "./errors";
```

### TypeScript Configuration

- Project uses TypeScript references with incremental compilation
- Base config: `tsconfig.base.json` (strict mode enabled)
- Specialized configs: `tsconfig.node.json`, `tsconfig.browser.json`
- Each package may have its own `tsconfig.json` extending from root

## Plugin Development

Plugins are the primary extension mechanism. See [docs/writing-plugins.md](docs/writing-plugins.md) for comprehensive guide.

**Plugin Structure**:
- Separate entrypoints: controller, host, instance, ctl, web
- Each entrypoint implements lifecycle hooks (onStart, onStop, etc.)
- Plugins define custom Request/Event messages
- Config fields integrate into main config system
- Web modules use Module Federation for runtime loading

**Adding a Plugin**:
```bash
npm install @clusterio/plugin-<name>
npx clusteriocontroller plugin add @clusterio/plugin-<name>
```

For development, use absolute or relative paths (starting with `.` or `..`).

## Testing

- **Framework**: Mocha with nyc for coverage
- **Test location**: `/test/` directory mirrors package structure
- **Common utilities**: `test/common.js` and `test/mock.js`
- **CI**: GitHub Actions with matrix testing (Node.js 20.x & 22.x, Factorio 1.1.110 & 2.0.47)

## Technology Stack

**Backend**: Node.js >= 18, TypeScript 5.7+, Express 4.x, ws (WebSockets), Winston (logging), Ajv + TypeBox (validation)

**Frontend**: React 18.x, Ant Design 5.x, React Router 6.x, Webpack 5 with Module Federation, SWC

**Factorio**: Lua with event_handler library, RCON client, custom save patching

## Key Architectural Decisions

- **Separation of concerns**: Controller (coordination) vs Host (instance management) vs Ctl/Web (control)
- **Minimal dependencies**: New dependencies require strong justification
- **Plugin-based extensibility**: Core provides infrastructure, plugins add functionality
- **Message-based communication**: All inter-component communication uses Link Protocol
- **No database**: Custom JSON file-based storage for simplicity

## Known Factorio API Limitations (Transfer Fidelity)

Platform transfers preserve **~99.6% of items** (API-limited) and **~100% of fluids** (after segment fixes). The remaining item losses are Factorio engine limitations, not code bugs.

### Item Losses (~0.4%, ~45-49 items per transfer)
- **Assembling machine overloaded inventories**: During gameplay, inserters can stuff items beyond the API-enforced `set_stack()` limit. For example, a foundry with `molten-copper` recipe allows 264 copper-ore per slot via inserters but `set_stack()` caps at 164. The Factorio API provides no way to exceed this limit — `set_stack()`, `insert()`, and direct `.count` assignment all enforce it.
- **Belt item drift** (±4-8 items): Transport belts, underground belts, and splitters are always active and cannot be deactivated. Items physically move on belts between the export scan and import validation, causing small bidirectional shifts between entity types. This is cosmetic, not actual loss.

### Fluid Handling (Fixed Bugs)
Fluid losses that previously appeared as ~15% loss (19,607 units) were caused by multiple bugs, not API limitations:

1. **Frozen entity ghost buffer (CRITICAL FIX)**: Factorio 2.0's fluid segment system means frozen/inactive entities are **detached from fluid segments**. Writing fluid to a frozen entity via `entity.fluidbox[i] = {...}` writes to a "ghost buffer" that is silently **wiped when the entity is unfrozen** and joins a live fluid segment. The fix: inject fluid AFTER `entity.active = true` and `entity.frozen = false`, never before. See Pitfall #17.

2. **Entity handlers missing fluid extraction**: The `assembling-machine` and `furnace` entity handlers only exported inventories, not fluids. Chemical plants, oil refineries, foundries, and other crafting machines with fluidboxes had their fluid silently dropped during export. Fixed by adding `InventoryScanner.extract_fluids(entity)` to both handlers.

3. **Segment injection target selection (CRITICAL)**: `get_capacity(i)` returns INCONSISTENT values depending on entity type — pipes/tanks return the FULL segment capacity (e.g., 11,800), while thrusters/machines return only the LOCAL fluidbox capacity (e.g., 1,000). Writing `fluidbox[i]=` through a thruster only sets the LOCAL buffer, not the segment total. Fix: always pick the entity with the highest `get_capacity()` as the injection target (pipes/tanks). See `fluid_restoration.lua`.

4. **Loss analysis undercounting (false alarm)**: After writing a segment total through a pipe, `entity.fluidbox[i]` for other entities (especially thrusters) returns 0 for several ticks while the engine redistributes fluid to internal buffers. The loss analysis was reading these values too early, showing ~19,607 phantom loss. Fix: use `get_fluid_segment_contents(i)` for segment-aware counting, deduplicating by segment ID. A first-pass temperature cache resolves entities whose local fluidbox is nil.

### Remaining Fluid Losses (Unavoidable, ~20 units)
- **Fusion plasma temperature merging**: The ~20 units of fusion-plasma loss is NOT a simple rejection — it's **floating-point segment merging** at extreme temperatures. At >1,000,000°C, IEEE 754 double-precision representation is stretched to its limit. When multiple 10-unit plasma packets at slightly different extreme temperatures (e.g., 1065464.9°C vs 1063417.1°C) are restored, the engine may merge them into neighboring plasma segments via weighted-average temperature calculation. The 20 "lost" units actually shift the temperature of the surviving 80 units by a fraction of a degree too small to display. The validation then reports 0 for the original temperature keys because no exact-temperature match exists — the fluid migrated to a slightly-altered temperature bucket. This is a Factorio engine limitation at extreme temperature ranges and is **not fixable via API**.

### Fluid Redistribution (Expected, Minor)
- **Pipe network segment redistribution**: When entities are recreated, pipe segments may have slightly different internal capacities. Fluidbox assignment silently caps at segment capacity. The game redistributes fluid across connected entities internally. This causes minor redistribution, not loss.
- **Temperature averaging**: Multiple fluid packets at different temperatures in the same segment get averaged, which can cause minor rounding differences.

### Not Fixable via API
- `LuaInventory::resize()` only works on custom inventories from `create_inventory()`, not entity inventories
- Entity inventory slot limits are enforced by the game engine based on recipe, quality, and research level
- Fluidbox assignment silently caps at segment capacity with no error or return value

### Import Phase Ordering (Critical)
The order of post-processing steps in `complete_import_job()` is critical for correctness:

```
1. Hub inventories   — restore after cargo bays exist (inventory size scales with bays)
2. Belt items        — always-active, must restore in single tick
3. Entity state      — control behavior, filters, circuit connections
4. Validation        — pre-activation check (items only, fluids skipped)
5. Activation        — ActiveStateRestoration.restore() unfreezes entities
6. Fluid restoration — MUST be after activation (ghost buffer fix)
7. Loss analysis     — post-activation counting for accurate transaction log
```

**Why this order matters**: Steps 5→6 are inseparable. If fluids are injected before step 5, Factorio's fluid segment system wipes them on activation. Step 4 skips fluid validation (`skip_fluid_validation=true`) because fluids haven't been injected yet.

### 17. Frozen Entity Fluid Ghost Buffer (Factorio 2.0 Fluid Segments)
**Symptom**: Fluid loss of ~15% on transfer. Fluid appears to be injected successfully (no errors, no overflows), but after activation all injected fluid is gone.
**Root Cause**: Factorio 2.0 uses a **fluid segment system**. Fluids don't live per-entity — they exist in shared segments spanning connected pipes/machines. When an entity has `frozen=true` or `active=false`, it is **detached from its fluid segment**. Writing to `entity.fluidbox[i]` on a frozen entity writes to a **ghost buffer** — a temporary per-entity store. When the entity is later unfrozen (`frozen=false`, `active=true`), the engine re-syncs the entity with its live fluid segment, **overwriting the ghost buffer contents**. All injected fluid is silently deleted.
**Fix**: Always set `entity.frozen = false` and `entity.active = true` **before** writing to `entity.fluidbox[i]`. In the import flow, `FluidRestoration.restore()` must run **after** `ActiveStateRestoration.restore()`, not before.
**Confirmed by**: Factorio API expert analysis of `FluidSystem::merge_segment()` behavior.
**Key files**: `async-processor.lua` (`complete_import_job`), `fluid_restoration.lua`, `active_state_restoration.lua`

### 18. Entity Handlers Must Export Fluids for Crafting Machines
**Symptom**: Assembling machines (chemical plants, oil refineries) and furnaces (foundries) lose all fluid on transfer, even though pipes/tanks preserve fluid correctly.
**Root Cause**: `EntityHandlers["assembling-machine"]` and `EntityHandlers["furnace"]` in `entity-handlers.lua` only exported `inventories`, not `fluids`. These entity types have fluidboxes (chemical plants hold fluid reagents, foundries hold molten metals), but the handler never called `InventoryScanner.extract_fluids(entity)`. Entities without a specific handler use the default handler, which correctly exports both inventories AND fluids — so pipes, tanks, pumps, and thrusters (no specific handler) worked fine.
**Fix**: Added `fluids = InventoryScanner.extract_fluids(entity)` to both the `assembling-machine` and `furnace` handlers.
**Key files**: `entity-handlers.lua` (lines ~45 and ~92)
**Lesson**: When adding a new entity handler, always check if the entity type has a fluidbox. The default handler exports both inventories and fluids — a specific handler that only exports inventories silently drops fluid data.

## Factorio 2.0 Fluid API & Simulation Behavior

**Topic**: Fluidbox Persistence, Segment Logic, and State Validation.
**Context**: Factorio Space Age (2.0) API; interacting with entities (Thrusters) during state changes (`active=true`, `paused=false`).

### Critical Knowledge

1. **The Proxy Problem**: In Factorio 2.0, `entity.fluidbox[i]` is a proxy window, not a container. When an entity is activated or a platform is unpaused, the entity's local fluidbox buffer may read `0` or `nil` for one or more ticks while it synchronizes with the backend Fluid Segment.

2. **The Solution**: Do not read `entity.fluidbox[i]` for validation immediately after a state change. Instead, use `entity.fluidbox.get_fluid_segment_contents(i)`. This queries the C++ segment directly, bypassing the entity's visual/local update lag.

3. **Deduplication**: When summing fluid contents across a network (e.g., 9 thrusters), you must deduplicate by the Fluid Segment ID. Summing `get_fluid_segment_contents` for every entity will multiply the result by the number of entities.

4. **Floating Point Epsilon**: Fluid operations at extreme temperatures (e.g., Fusion Plasma > 1,000,000°C) or large volumes suffer from floating-point drift. Validation logic must use an epsilon (tolerance) check (e.g., `diff < 0.01%`) rather than strict equality, or false "loss" positives will occur. **Concrete example**: 10 plasma packets at temperatures like 1065464.9°C and 1063417.1°C — the engine may merge 2 packets into neighbors via weighted-average temperature, shifting the surviving packets' temperature by an undetectable fraction. Validation keyed on exact `fluid_name@temp` then reports `0` for the originals.

5. **Capacity Clamping**: Writing to `fluidbox[i]` writes to the entire segment. If the write amount exceeds the physical capacity of the connected segment (pipes + machines), the excess is silently voided. Always check `entity.fluidbox.get_capacity(i)` (which returns segment total for pipes/tanks) before bulk insertion. **Caveat**: `get_capacity(i)` returns LOCAL capacity for thrusters/machines but SEGMENT capacity for pipes — always pick the entity with the highest capacity as the injection target.

### Implementation Pattern

```lua
-- BAD: Reads local proxy (0) before sync
entity.active = true
local amount = entity.fluidbox[1].amount -- Returns 0 or incorrect value

-- GOOD: Reads simulation truth
entity.active = true
local content = entity.fluidbox.get_fluid_segment_contents(1) -- Returns actual segment total
```

## Support Policy

- **Factorio**: Active support for last two major versions (currently 2.0 and 1.1)
- **Node.js**: All LTS versions in active and maintenance phases
- **Operating Systems**: Windows, Linux, MacOS (via Node.js cross-platform support)
- **Breaking Changes**: Currently in alpha, breaking changes documented with migration steps

## Additional Documentation

- [docs/architecture.md](docs/architecture.md) - System architecture overview
- [docs/commands-reference.md](docs/commands-reference.md) - All available commands
- [docs/testing-guide.md](docs/testing-guide.md) - Testing procedures
- [docs/impediments_and_resolutions.md](docs/impediments_and_resolutions.md) - Known issues and solutions (14 documented impediments)
- [docs/factorio-saves.md](docs/factorio-saves.md) - Save management and async import details
- [docs/IMPORT_PERFORMANCE.md](docs/IMPORT_PERFORMANCE.md) - **NEW**: Import performance analysis, chunking rationale, Factorio 2.0 limitations
- [CLUSTERIO_QUICKSTART.md](CLUSTERIO_QUICKSTART.md) - Quick reference for cluster operations
- [factorioAPI/index.html](factorioAPI/index.html) - Offline Factorio API reference (local HTML)

## Debugging Tips

### Check Plugin Module is Loaded
```powershell
rc11 "/sc rcon.print(remote.interfaces['surface_export'] ~= nil)"  -- Should print 'true'
```

### View Factorio Log (from container)
```powershell
docker exec surface-export-host-1 tail -100 /clusterio/instances/clusterio-host-1-instance-1/factorio-current.log
```

### Check Async Job Queue
```powershell
rc11 "/async-status"
# Or detailed:
rc11 "/sc rcon.print(serpent.block(storage.async_jobs or {}))"
```

### List Available Remote Interfaces
```powershell
rc11 "/sc for name, _ in pairs(remote.interfaces) do rcon.print(name) end"
```
