# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with the clusterio-surface-export project.

## clusterio-surface-export Project Overview

This project provides tools for exporting and importing Factorio Space Age platforms between Clusterio instances. It consists of:

1. **Lua Module** (`docker/seed-data/external_plugins/surface_export/module/`): Save-patched Lua code that serializes/deserializes platform entities, inventories, fluids, and tiles
2. **Clusterio Plugin** (`docker/seed-data/external_plugins/surface_export/`): JavaScript plugin for cross-instance platform transfer
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
- **Seeding is idempotent**: Fixed in base image — `seed-instances.sh` checks if instance exists before creating, controller writes `.seed-complete` marker, hosts detect token desync. `docker compose restart` is safe; `docker compose down -v` for full wipe.

**Base Image Capabilities** (from `solarcloud7/clusterio-docker`):
- **Factorio download hardening**: SHA256 verification (optional), `--retry 8` on curl, `SHELL ["/bin/bash", "-eo", "pipefail", "-c"]`
- **Game client support**: `INSTALL_FACTORIO_CLIENT=true` build arg downloads the full Factorio game client for graphical asset export (icon spritesheets). When enabled, headless server download is skipped (client is a superset). Client requires Factorio account credentials at build time.
- **Port range auto-derivation**: Host N → port range `34N00-34N99` (no manual port config needed)
- **Mod seeding before instances**: Mods are uploaded to controller before instances are created/started
- **External plugins must be read-write**: Mount without `:ro` — entrypoint runs `npm install` inside each plugin

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

**Plugin Changes** (JavaScript):
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
docker/seed-data/external_plugins/surface_export/   # Plugin root
├── index.js              # Plugin registration, config fields, permissions
├── controller.js         # Controller: slim coordinator delegating to lib/
├── instance.js           # Instance: RCON bridge, platform listing, chunked import
├── messages.js           # Message type definitions with JSON schemas (transfer + export/import operations)
├── control.js            # CLI command registration (clusterioctl)
├── helpers.js            # Utility functions (chunking, escaping)
├── package.json          # Plugin metadata and dependencies
├── webpack.config.js     # Web UI build config
├── lib/                  # Controller modules (split from controller.js)
│   ├── platform-tree.js          # Tree building + instance resolution
│   ├── transaction-logger.js     # Event logging, phase timing, persistence
│   ├── subscription-manager.js   # WebSocket subscriptions + broadcasting
│   └── transfer-orchestrator.js  # Transfer lifecycle state machine
├── web/                  # React web UI (Ant Design + Module Federation)
│   ├── index.jsx         # WebPlugin class, page wrapper, hooks
│   ├── ManualTransferTab.jsx     # Platform tree + per-platform export / per-instance import UI
│   ├── ExportsTab.jsx            # Stored export list + download/upload-import workflows
│   ├── TransactionLogsTab.jsx    # Log viewer + validation display
│   ├── utils.js          # Pure formatting functions (no React)
│   └── style.css
├── module/               # Lua module (save-patched into Factorio instances)
│   ├── module.json       # Module metadata
│   ├── control.lua       # Entry point, event handlers, on_init/on_load
│   ├── core/             # Core processing (async-processor, serializer, deserializer, json)
│   ├── export_scanners/  # Entity/inventory/connection/tile scanning
│   ├── import_phases/    # Restoration phases (tiles, hub, entities, state, belts, fluids)
│   ├── interfaces/       # Commands (14 files) + remote interface (18 files)
│   ├── utils/            # Helpers (game-utils, string-utils, table-utils, etc.)
│   ├── validators/       # Verification, transfer-validation, surface-counter, loss-analysis
│   └── locale/           # Localization strings
└── dist/                 # Built web UI (npm run build:web, gitignored)

tools/
├── deploy-cluster.ps1    # Main deployment script
├── import-platform.ps1   # Chunked import via RCON
├── export-platform.ps1   # Export trigger helper
└── validate-cluster.ps1  # Cluster health checks

docker/
└── seed-data/            # Seed data: database, mods, saves, plugins

.env                      # All environment config (gitignored, credentials)
.env.example              # Template for .env (tracked in git)
docker-compose.yml        # Cluster definition (uses pre-built GHCR images)
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
remote.call("surface_export", "export_platform", platform_index, force_name, destination_instance_id)
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

## Export/Import Workflow Notes (Current)

### Export for download
- UI path: Manual Transfer per-platform **Export JSON** and Exports tab download action.
- Controller path: `ExportPlatformForDownloadRequest` sends `ExportPlatformRequest` with `targetInstanceId: null`.
- Instance/Lua path: destination must be Lua `nil` for export-only; otherwise export is treated as transfer.
- Export-only jobs unlock the source platform after completion; transfer jobs keep source locked until cleanup.

### Upload-import JSON
- UI path: Manual Transfer per-instance **Import JSON** and Exports tab upload/import action.
- Controller path: `ImportUploadedExportRequest` forwards payload via `ImportPlatformRequest` to target instance.
- Controller injects `_operationId` into payload; Lua emits completion with `operation_id`.
- Instance forwards `ImportOperationCompleteEvent` to controller so non-transfer imports can complete their transaction logs.

### Transaction logs
- Logs now include operation type: `transfer`, `export`, `import`.
- `TransactionLogsTab` shows mixed operation history in one list with operation type tags.
- Export/import operations are persisted using the same transaction log store as transfers.

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

### 9. Duplicate Instances on Restart (Seeding Idempotency) — FIXED IN BASE IMAGE
**Status**: All three fixes are now implemented in [solarcloud7/clusterio-docker](https://github.com/solarcloud7/clusterio-docker):
1. **Idempotent `seed_instance()`**: `seed-instances.sh` checks `instance list | grep -wF` before creating — skips duplicates.
2. **Seed-complete marker**: `.seed-complete` file on controller data volume prevents re-seeding after successful first run. Interrupted first runs re-attempt safely.
3. **Token desync detection**: `host-entrypoint.sh` compares stored token vs shared volume token — reconfigures automatically on mismatch.

`docker compose restart` is now safe (no duplicate instances). Use `docker compose down -v` only when you want a full volume wipe.

### 10. Instances Missing Space Age Mods
**Symptom**: Platforms don't exist, Space Age entities missing, game runs in base-game-only mode
**Cause**: `DEFAULT_MOD_PACK` defaults to `"Base Game 2.0"` in the base image controller entrypoint
**Fix**: Set `DEFAULT_MOD_PACK=Space Age 2.0` in `.env`. Requires `docker compose down -v` since mod pack is assigned on first run only.

### 11. Both Instances Have Same Game Port — FIXED IN BASE IMAGE
**Status**: Fixed in [solarcloud7/clusterio-docker](https://github.com/solarcloud7/clusterio-docker) — `host-entrypoint.sh` auto-derives port range from HOST_ID (host N → `34N00-34N99`). Docker-compose port mappings must match. Requires `docker compose down -v` + image pull/rebuild if upgrading from an older base image.

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
**See**: [TRANSFER_WORKFLOW_GUIDE.md](docs/TRANSFER_WORKFLOW_GUIDE.md) — "Entity Lifecycle (Critical Invariant)" section

### 20. Failed Entity Loss Attribution (Fixed)
**Symptom**: Transfer validation fails or shows unexplained item/fluid losses when some entities fail to place (e.g., mod mismatch, prototype collision). Validation reports "expected 500 iron-plate, got 450" with no indication of why.
**Cause**: When `create_entity` returns nil, all downstream restoration phases skip that entity silently (they check `entity_map[id]` and move on). Items and fluids inside the failed entity are never placed, but they remain in the "expected" totals from verification data, causing false validation failures or unexplained loss.
**Fix**: At the failure site in `entity_creation.lua`, tally items (inventories, belt lines, held item) and fluids from the serialized entity data into `job.failed_entity_losses`. In `async-processor.lua`, before calling `validate_import`, deep-copy and subtract failed-entity items from expected counts so validation only compares achievable totals. Attach `failedEntityLosses` to the validation result so it flows through `send_json` to the controller and web UI. In `loss-analysis.lua`, log a full per-entity breakdown.
**Key files**: `entity_creation.lua` (tally at failure site), `async-processor.lua` (adjust expected + attach to result), `loss-analysis.lua` (report section)
**Output**: Log lines like `[Entity Creation] FAILED to create 'foundry' (type=furnace) at (12.5,4.5) — lost 50 items, 200.0 fluids` and `[Loss Analysis] 1 entities failed to place — 50 items, 200.0 fluids unrestorable`. `failedEntityLosses` field in validation result JSON sent to controller.
**See**: [docs/FAILED_ENTITY_LOSS_TRACKING.md](docs/FAILED_ENTITY_LOSS_TRACKING.md)

### 16. Verification Counts From Live Scan vs Serialized Data (CRITICAL — Fixed)
**Symptom**: Transfer validation fails with "GAINED items" across many item types (iron-plate, copper-cable, piercing-rounds-magazine, etc.). Gains are a fraction of belt item totals.
**Cause**: Export verification used `Verification.count_surface_items()` (live scan) AFTER entity scanning completed across multiple ticks. **Belt items can't be deactivated** — they keep moving on locked platforms. During the multi-tick export, items move between belts causing a "rolling snapshot" effect: an item on belt A captured in tick 1 may move to belt B captured in tick 5 → double-counted in serialized data. Conversely, items can move from unscanned to already-scanned belts and be missed. The net result is the serialized data doesn't match the live surface state at any single point in time.
**Fix (v2 — Atomic Belt Scan)**: Belt item extraction is now **deferred** during async entity scanning. Entity structure (position, direction, type, belt_to_ground_type, etc.) is still captured async per-tick, but `extract_belt_items()` is skipped (controlled by `EntityHandlers.skip_belt_items` flag). When all entities are scanned, `complete_export_job` does a single-tick atomic pass over all tracked belt entities, calling `extract_belt_items()` and patching the serialized data. This gives a consistent snapshot: no items can move between belts within a single tick. Verification is then generated from this consistent serialized data.
**Key files**: `entity-handlers.lua` (`skip_belt_items` flag on transport-belt/underground-belt/splitter handlers), `async-processor.lua` (`process_export_batch` sets flag + tracks belt entities, `complete_export_job` atomic belt scan block before verification)
**Previous approach (v1)**: Used `Verification.count_all_items()` from serialized data for verification (self-consistent but inaccurate). This masked the problem — verification matched import, but both were based on inconsistent belt data.

## Architecture Overview

For Clusterio core architecture, see [Clusterio docs](https://github.com/clusterio/clusterio).

### Communication Architecture

**Link Protocol**: Custom WebSocket-based message routing with typed addressing (controller, host, instance, control, broadcast).

**Message Flow**:
1. Controller manages central state and routes messages
2. Hosts run Factorio instances and communicate via RCON
3. Instances (Factorio servers) are patched with Lua modules at runtime
4. Web UI connects via WebSocket for real-time updates
5. Ctl provides CLI access to same functionality as Web UI

**Message Types**: Request/Response pattern and Event broadcasting

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
- **Clusterio send_json event channel (Lua→Node)**: `clusterio_api.send_json("channel_name", data_table)` — plugin listens via `server.handle("channel_name", handler)`
- **RCON transport (Node→Lua)**: `this.sendRcon("/sc ...")` to execute Lua via RCON

## Code Style and Conventions

### General Style (enforced by ESLint)

- **Indentation**: Tabs (not spaces, except in Markdown)
- **Line length**: 120 characters (tabs count as 4)
- **Strings**: Double quotes `"` (single quotes `'` if string contains double quotes)
- **Naming (JavaScript)**:
  - Variables/members: camelCase
  - Classes: PascalCase
  - Config values: lowercase_underscore
  - Booleans: Start with verb unless ending in "ed" (e.g., `canRestart`, `isEnabled`, `connected`)
  - Times/durations: End with SI unit (e.g., `updatedAtMs`, `timeoutS`)
- **Naming (Lua)**: Everything uses lowercase_underscore
- **File naming**:
  - lowercase_underscore for files exporting multiple values
  - PascalCase for single-class exports

## Plugin Development

Plugins are the primary extension mechanism. See [Clusterio plugin docs](https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md) for comprehensive guide.

**Plugin Structure**:
- Separate entrypoints: controller, host, instance, ctl, web
- Each entrypoint implements lifecycle hooks (onStart, onStop, etc.)
- Plugins define custom Request/Event messages
- Config fields integrate into main config system
- Web modules use Module Federation for runtime loading

## Known Factorio API Limitations (Transfer Fidelity)

Platform transfers preserve **~99.6% of items** (API-limited) and **~100% of fluids** (after segment fixes). The remaining item losses are Factorio engine limitations, not code bugs.

### Item Losses (~0.4%, ~45-49 items per transfer)
- **Assembling machine overloaded inventories**: During gameplay, inserters can stuff items beyond the API-enforced `set_stack()` limit. For example, a foundry with `molten-copper` recipe allows 264 copper-ore per slot via inserters but `set_stack()` caps at 164. The Factorio API provides no way to exceed this limit — `set_stack()`, `insert()`, and direct `.count` assignment all enforce it. **Engine detail**: Inserters check `recipe_requirements * multiplier` (accounting for quality and productivity bonuses) to determine how many items to insert, not `get_max_stack_size()`. This means crafting buffers can exceed API stack limits when quality/productivity multipliers are active.
- **Belt item drift** (±4-8 items): Transport belts, underground belts, and splitters are always active and cannot be deactivated. Items physically move on belts between the export scan and import validation, causing small bidirectional shifts between entity types. This is cosmetic, not actual loss.

### Fluid Handling (Fixed Bugs)
Fluid losses that previously appeared as ~15% loss (19,607 units) were caused by multiple bugs, not API limitations:

1. **Frozen entity ghost buffer (CRITICAL FIX)**: Factorio 2.0's fluid segment system means frozen/inactive entities are **detached from fluid segments**. Writing fluid to a frozen entity via `entity.fluidbox[i] = {...}` writes to a "ghost buffer" that is silently **wiped when the entity is unfrozen** and joins a live fluid segment. The fix: inject fluid AFTER `entity.active = true` and `entity.frozen = false`, never before. See Pitfall #17.

2. **Entity handlers missing fluid extraction**: The `assembling-machine` and `furnace` entity handlers only exported inventories, not fluids. Chemical plants, oil refineries, foundries, and other crafting machines with fluidboxes had their fluid silently dropped during export. Fixed by adding `InventoryScanner.extract_fluids(entity)` to both handlers.

3. **Segment injection target selection (CRITICAL)**: `get_capacity(i)` returns INCONSISTENT values depending on entity type — pipes/tanks return the FULL segment capacity (e.g., 11,800), while thrusters/machines return only the LOCAL fluidbox capacity (e.g., 1,000). Writing `fluidbox[i]=` through a thruster only sets the LOCAL buffer, not the segment total. Fix: always pick the entity with the highest `get_capacity()` as the injection target (pipes/tanks). See `fluid_restoration.lua`. **Prototype-level explanation**: Pipe prototypes define `base_area` as their primary fluid identity — the engine uses this to compute segment capacity across connected pipes. Thrusters and machines instead define specific `fluid_box` entries that act as internal buffers with fixed local capacity. This is why `get_capacity()` returns segment-total for pipes but local-only for thrusters.

4. **Loss analysis undercounting (false alarm)**: After writing a segment total through a pipe, `entity.fluidbox[i]` for other entities (especially thrusters) returns 0 for several ticks while the engine redistributes fluid to internal buffers. The loss analysis was reading these values too early, showing ~19,607 phantom loss. Fix: use `get_fluid_segment_contents(i)` for segment-aware counting, deduplicating by segment ID. A first-pass temperature cache resolves entities whose local fluidbox is nil.

### Remaining Fluid Losses (Unavoidable, ~20 units)
- **Fusion plasma temperature merging**: The ~20 units of fusion-plasma loss is NOT a simple rejection — it's **floating-point segment merging** at extreme temperatures. At >1,000,000°C, IEEE 754 double-precision representation is stretched to its limit. When multiple 10-unit plasma packets at slightly different extreme temperatures (e.g., 1065464.9°C vs 1063417.1°C) are restored, the engine may merge them into neighboring plasma segments via weighted-average temperature calculation: `T_final = (m1*T1 + m2*T2) / (m1 + m2)`. The 20 "lost" units actually shift the temperature of the surviving 80 units by a fraction of a degree too small to display. The validation then reports 0 for the original temperature keys because no exact-temperature match exists — the fluid migrated to a slightly-altered temperature bucket. This is a Factorio engine limitation at extreme temperature ranges and is **not fixable via API**.

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
**Root Cause**: Factorio 2.0 uses a **fluid segment system**. Fluids don't live per-entity — they exist in shared segments spanning connected pipes/machines. When an entity has `frozen=true` or `active=false`, it is **detached from its fluid segment** — internally, `fluid_network_id` is nil or points to a singular (isolated) network. Writing to `entity.fluidbox[i]` on a frozen entity writes to a **ghost buffer** — a temporary per-entity store. When the entity is later unfrozen, `FluidSystem::on_entity_unfrozen` triggers a network merge. The merge priority favors the existing large segment over the newly joined entity's ghost buffer, **overwriting the ghost buffer contents**. All injected fluid is silently deleted.
**Fix**: Always set `entity.frozen = false` and `entity.active = true` **before** writing to `entity.fluidbox[i]`. In the import flow, `FluidRestoration.restore()` must run **after** `ActiveStateRestoration.restore()`, not before.
**Confirmed by**: Factorio API expert analysis of `FluidSystem::merge_segment()` and `FluidSystem::on_entity_unfrozen` behavior.
**Key files**: `async-processor.lua` (`complete_import_job`), `fluid_restoration.lua`, `active_state_restoration.lua`

### 18. Entity Handlers Must Export Fluids for Crafting Machines
**Symptom**: Assembling machines (chemical plants, oil refineries) and furnaces (foundries) lose all fluid on transfer, even though pipes/tanks preserve fluid correctly.
**Root Cause**: `EntityHandlers["assembling-machine"]` and `EntityHandlers["furnace"]` in `entity-handlers.lua` only exported `inventories`, not `fluids`. These entity types have fluidboxes (chemical plants hold fluid reagents, foundries hold molten metals), but the handler never called `InventoryScanner.extract_fluids(entity)`. Entities without a specific handler use the default handler, which correctly exports both inventories AND fluids — so pipes, tanks, pumps, and thrusters (no specific handler) worked fine.
**Fix**: Added `fluids = InventoryScanner.extract_fluids(entity)` to both the `assembling-machine` and `furnace` handlers.
**Key files**: `entity-handlers.lua` (lines ~45 and ~92)
**Lesson**: When adding a new entity handler, always check if the entity type has a fluidbox. The default handler exports both inventories and fluids — a specific handler that only exports inventories silently drops fluid data.

### 19. `platform.destroy()` is a No-Op in Factorio 2.0 Space Age (CRITICAL)
**Symptom**: After a successful transfer, the source platform still exists in-game. Transfer shows "completed" status but platform is not deleted, creating duplicates.
**Root Cause**: `LuaSpacePlatform.destroy()` in Factorio 2.0 Space Age is silently broken — it returns without error but does NOT actually remove the platform or its surface. Similarly, destroying the hub entity (`platform.hub.destroy()`) is auto-recovered by the engine (it recreates the hub). Both APIs report success but have no effect.
**Fix**: Use `game.delete_surface(platform.surface)` — this is the only reliable way to remove a space platform in Factorio 2.0. It fully tears down the surface, all entities, and the platform itself.
```lua
-- BROKEN (returns ok=true but platform persists):
platform.destroy()

-- BROKEN (engine auto-recreates the hub):
platform.hub.destroy()

-- WORKS (fully removes platform, surface, and all entities):
game.delete_surface(platform.surface)
```
**Key file**: `instance.js` (`handleDeleteSourcePlatform` method)
**Verified**: Empirically tested via RCON — `platform.destroy()` returns `ok=true, err=nil` but `/list-platforms` shows the platform unchanged. `game.delete_surface()` confirmed working.

### 20. Export-Only Destination Must Be `nil` (Not `0`)
**Symptom**: Export succeeds but source platform remains locked (looks stuck in UI).
**Cause**: `Number(null) === 0` in JS. Passing `0` as destination to Lua is truthy, so export is treated as transfer and unlock is skipped.
**Fix**: In `instance.js`, only treat `targetInstanceId` as a transfer destination if it is a positive integer (`> 0`); otherwise pass Lua `nil`.

## Factorio 2.0 Fluid API & Simulation Behavior

**Topic**: Fluidbox Persistence, Segment Logic, and State Validation.
**Context**: Factorio Space Age (2.0) API; interacting with entities (Thrusters) during state changes (`active=true`, `paused=false`).

### Critical Knowledge

1. **The Proxy Problem**: In Factorio 2.0, `entity.fluidbox[i]` is a proxy window, not a container. When an entity is activated or a platform is unpaused, the entity's local fluidbox buffer may read `0` or `nil` for one or more ticks while it synchronizes with the backend Fluid Segment.

2. **The Solution**: Do not read `entity.fluidbox[i]` for validation immediately after a state change. Instead, use `entity.fluidbox.get_fluid_segment_contents(i)`. This queries the C++ segment directly, bypassing the entity's visual/local update lag.

3. **Deduplication**: When summing fluid contents across a network (e.g., 9 thrusters), you must deduplicate by the Fluid Segment ID. Summing `get_fluid_segment_contents` for every entity will multiply the result by the number of entities.

4. **Floating Point Epsilon**: Fluid operations at extreme temperatures (e.g., Fusion Plasma > 1,000,000°C) or large volumes suffer from floating-point drift. Validation logic must use an epsilon (tolerance) check (e.g., `diff < 0.01%`) rather than strict equality, or false "loss" positives will occur. **Concrete example**: 10 plasma packets at temperatures like 1065464.9°C and 1063417.1°C — the engine may merge 2 packets into neighbors via weighted-average temperature, shifting the surviving packets' temperature by an undetectable fraction. Validation keyed on exact `fluid_name@temp` then reports `0` for the originals.

5. **Capacity Clamping**: Writing to `fluidbox[i]` writes to the entire segment. If the write amount exceeds the physical capacity of the connected segment (pipes + machines), the excess is silently voided. Always check `entity.fluidbox.get_capacity(i)` (which returns segment total for pipes/tanks) before bulk insertion. **Caveat**: `get_capacity(i)` returns LOCAL capacity for thrusters/machines but SEGMENT capacity for pipes. This is because pipe prototypes define `base_area` (used to compute segment capacity) while thrusters/machines define `fluid_box` entries with fixed local capacity. Always pick the entity with the highest capacity as the injection target.

### Implementation Pattern

```lua
-- BAD: Reads local proxy (0) before sync
entity.active = true
local amount = entity.fluidbox[1].amount -- Returns 0 or incorrect value

-- GOOD: Reads simulation truth
entity.active = true
local content = entity.fluidbox.get_fluid_segment_contents(1) -- Returns actual segment total
```

## Additional Documentation

- [docs/README.md](docs/README.md) - Plugin overview and documentation index
- [docs/commands-reference.md](docs/commands-reference.md) - All available commands
- [docs/QUICK_START.md](docs/QUICK_START.md) - End-to-end transfer walkthrough
- [docs/DEVELOPMENT_SETUP.md](docs/DEVELOPMENT_SETUP.md) - Plugin development workflow
- [docs/TRANSFER_WORKFLOW_GUIDE.md](docs/TRANSFER_WORKFLOW_GUIDE.md) - Transfer phases and validation
- [docs/EXPORT_IMPORT_FLOW.md](docs/EXPORT_IMPORT_FLOW.md) - Complete action trace with debugging
- [docs/IMPLEMENTATION_SUMMARY.md](docs/IMPLEMENTATION_SUMMARY.md) - Module structure and design decisions
- [docs/async-processing.md](docs/async-processing.md) - Async batch processing architecture
- [docs/CARGO_POD_API.md](docs/CARGO_POD_API.md) - Factorio cargo pod API reference
- [docs/REORGANIZATION_PLAN.md](docs/REORGANIZATION_PLAN.md) - Planned code structure improvements

## Debugging Tips

### Docker Logs (IMPORTANT — Windows Shell Escaping)

**CRITICAL**: On Windows with Git Bash, `docker exec` path arguments get mangled by MSYS path conversion (e.g., `/clusterio/` → `C:/Program Files/Git/clusterio/`). Always wrap commands in `sh -c '...'` with single quotes:

```bash
# WRONG (Git Bash mangles the path):
docker exec surface-export-controller npx clusterioctl --config=/clusterio/tokens/config-control.json ...

# CORRECT (single-quoted sh -c prevents path mangling):
docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json ...'
```

**Getting container logs**: The controller container has massive `chown` noise on stderr from npm installs. Always filter:

```bash
# Get clean controller plugin logs (filter npm/chown noise):
docker logs --tail 200 surface-export-controller 2>&1 | grep "surface_export"

# Get host plugin logs:
docker logs --tail 200 surface-export-host-1 2>&1 | grep "surface_export"

# RCON commands (always use sh -c with single quotes):
docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error instance send-rcon "clusterio-host-1-instance-1" "/list-platforms"'
```

**Note**: `docker logs` pipes work with `grep` in Git Bash. The `--tail N` flag goes BEFORE the container name. After a container restart, old logs are lost — only post-restart logs are available.

### Check Plugin Module is Loaded
```powershell
rc11 "/sc rcon.print(remote.interfaces['surface_export'] ~= nil)"  -- Should print 'true'
```

### View Factorio Log (from container)
```bash
docker exec surface-export-host-1 sh -c 'tail -100 /clusterio/instances/clusterio-host-1-instance-1/factorio-current.log'
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
