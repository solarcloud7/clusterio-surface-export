# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with the clusterio-surface-export project.

## clusterio-surface-export Project Overview

This project provides tools for exporting and importing Factorio Space Age platforms between Clusterio instances. It consists of:

1. **Lua Module** (`docker/seed-data/external_plugins/surface_export/module/`): Save-patched Lua code that serializes/deserializes platform entities, inventories, fluids, and tiles
2. **Clusterio Plugin** (`docker/seed-data/external_plugins/surface_export/`): TypeScript plugin for cross-instance platform transfer
3. **PowerShell Tools** (`tools/`): Helper scripts for deployment, import, export, and validation

**Key Features**:
- Complete platform state export/import (entities, inventories, fluids, tiles)
- Async processing to prevent game freezing
- Graceful handling of mod content mismatches
- Factorio 2.0 compatibility (handles read-only properties)
- Chunked RCON protocol for large payloads (>8KB)
- In-game transaction dashboard with persistent profiler snapshots
- Platform schedule + interrupts preserved (stations, wait conditions, train group inheritance)
- Ghost entities, tile ghosts, and item request proxies preserved

**Performance**: Small platforms (<8KB): ~1-2s | Large platforms (235KB): ~40s (RCON bottleneck)

**Current Cluster Configuration:**
- Uses pre-built images from `ghcr.io/solarcloud7/clusterio-docker-controller` and `ghcr.io/solarcloud7/clusterio-docker-host`
- Controller: `clusterio-controller` (Web UI: http://localhost:8080)
- Host 1: `clusterio-host-1` → Instance: `clusterio-host-1-instance-1` (ports 34100-34109)
- Host 2: `clusterio-host-2` → Instance: `clusterio-host-2-instance-1` (ports 34200-34209)
- Runtime data in Docker volumes (not bind-mounted directories)
- `factorio-client` external volume on host-1 (shared with clusterio-docker project, persists across `down -v`)
- Host-2 uses `SKIP_CLIENT=true` (no game client needed)
- Seed data convention from [solarcloud7/clusterio-docker](https://github.com/solarcloud7/clusterio-docker)
- **Seeding is idempotent**: Fixed in base image — `seed-instances.sh` checks if instance exists before creating, controller writes `.seed-complete` marker, hosts detect token desync. `docker compose restart` is safe; `docker compose down -v` for full wipe.

**Base Image Capabilities** (from `solarcloud7/clusterio-docker`):
- **Factorio download hardening**: SHA256 verification (optional), `--retry 8` on curl, `SHELL ["/bin/bash", "-eo", "pipefail", "-c"]`
- **Game client support**: Two paths available:
  - **Runtime download** (recommended): Set `FACTORIO_USERNAME` + `FACTORIO_TOKEN` env vars — host downloads the client on first startup into the `factorio-client` external volume. Persists across restarts and `docker compose down -v`.
  - **Build-time bake**: `INSTALL_FACTORIO_CLIENT=true` build arg downloads during `docker build`. Credentials appear in `docker history` — only for private images.
  - The game client enables Clusterio's export-data flow for graphical asset export (icon spritesheets). Only host-1 needs it; host-2 uses `SKIP_CLIENT=true`.
- **External factorio-client volume**: Declared as `external: true` in docker-compose.yml. Must be created once with `docker volume create factorio-client`. Shared across projects (clusterio-docker and FactorioSurfaceExport use the same volume).
- **Port range auto-derivation**: Host N → port range `34N00-34N99` (no manual port config needed)
- **Mod seeding before instances**: Mods are uploaded to controller before instances are created/started
- **External plugins must be read-write**: Mount without `:ro` — entrypoint runs `npm install` inside each plugin

## RCON Commands (PowerShell Profile Aliases)

**CRITICAL (interactive humans)**: These aliases are defined in the user's PowerShell profile. Always use them instead of raw docker commands.

**CRITICAL (AI agents / non-interactive shells)**: `rc11`/`rc21`/`rclist` are **interactive-profile-only** and are **NOT available** in the non-interactive shell an agent runs in — calling them errors with `rc11: The term 'rc11' is not recognized`. Use the raw form instead (PowerShell does not MSYS-mangle the path, so prefer it over Git Bash):
```powershell
# rc11 "<cmd>"  ≡
docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error instance send-rcon "clusterio-host-1-instance-1" "<cmd>"'
# rc21 "<cmd>" → swap to "clusterio-host-2-instance-1"
```
A reusable wrapper lives in `tools/rcon.ps1` (see "Development Tools"). When you see `rc11 "X"` below, mentally expand it to the raw form above.

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

The plugin uses **TypeScript** with bind-mounted source and **save patching** for Lua:
- Plugin location: `docker/seed-data/external_plugins/surface_export/`
- Mounted into containers via `external_plugins/` volume (auto-installed by base image)
- Contains TypeScript plugin code (`*.ts`), React web UI (`web/`), and Lua `module/` directory
- Build output: `dist/node/` (Node.js runtime), `dist/web/` (browser bundle)

**Plugin Changes** (TypeScript):
- Edit `*.ts` files in plugin root or `lib/` → `./tools/build-plugin.ps1 node -RestartHosts` (rebuild + reload the hosts)
- Build generates `dist/node/*.js` from TypeScript sources
- Deploy script automatically rebuilds before Docker startup
- Host Node (24.x, matching CI) is available in shells — but **do not** `npm install`/`npm run build` in the live plugin dir while the cluster runs (see the next bullet: it re-adds the `@clusterio` peers and breaks `clusterioctl`; the cluster also strips them, so an in-place build can't resolve `@clusterio` anyway). Use **`./tools/build-plugin.ps1 [all|node|web] [-RestartController] [-RestartHosts]`** — it builds in an isolated `node:24` container (CI parity) with a named volume shadowing `node_modules`, writing `dist/` back to the host; pass `-RestartController` for web changes (the controller caches each plugin's `manifest.json` at startup), or `-RestartHosts` for node changes (the hosts load `dist/node` at startup). Quick node-only compile alternative: `docker exec surface-export-host-1 sh -c 'cd /clusterio/external_plugins/surface_export && npx tsc -p tsconfig.node.json'` then `docker restart surface-export-host-1 surface-export-host-2`.
- **DO NOT** run `npm install`/`npm install --include=dev`/`npm prune` in the plugin dir on a running cluster: the plugin lists `@clusterio/*` as **peer+dev** deps and npm 7+ auto-installs peers, so a second copy of `@clusterio/lib` lands in the shared (bind-mounted) `node_modules` and breaks `clusterioctl` with `Error: Attempt to import duplicate copy of @clusterio/lib`. The base-image entrypoint avoids this by deleting them after install (log line "Removing local @clusterio packages"). **Recover with** `docker exec surface-export-host-1 sh -c 'rm -rf /clusterio/external_plugins/surface_export/node_modules/@clusterio'` (NOT `npm prune` — that re-adds the peers). To lint/build locally, install only the tool you need (`npm install --no-save eslint typescript-eslint`) then remove `@clusterio` again. CI is unaffected — it runs `npm ci` in a clean runner.

**Web UI Changes** (React):
- Edit `*.tsx`/`*.css` files in `web/` → `./tools/build-plugin.ps1 web -RestartController` → reload browser (chunks are content-hashed, so a normal reload suffices — no hard-refresh)
- Build generates `dist/web/` bundle via Webpack Module Federation
- Deploy script automatically rebuilds before Docker startup

**Module Changes** (Lua - Save Patched):
- Edit `*.lua` files in `module/` directory → `./tools/patch-and-reset.ps1` (rebuilds the plugin, resets saves so Clusterio re-patches the Lua, restarts the cluster)
- Clusterio automatically injects Lua code into saves at startup
- No compile step for Lua itself — but the save MUST be reset (a plain restart reuses the old patched `script.dat`); `patch-and-reset.ps1` does that for you

**Development Workflow**:
1. Start cluster: `docker compose up -d`
2. Edit TypeScript files → `./tools/build-plugin.ps1 node -RestartHosts`
3. Edit web (`*.tsx`) files → `./tools/build-plugin.ps1 web -RestartController` → reload browser
4. Edit Lua files → `./tools/patch-and-reset.ps1` (rebuild + reset saves to re-patch Lua + restart)
5. **Or use deploy script** for full rebuild: `.\tools\deploy-cluster.ps1 -SkipIncrement`

### Cluster / transfer / RCON tools (`tools/`)

> Run `ls tools/` for the full set — this list is the agent-relevant subset. The `rc11`/`rc21`
> profile aliases do NOT work in a non-interactive (agent/CI) shell; use `tools/rcon.ps1` instead.

```powershell
# RCON (agent-friendly; replaces the rc11/rc21 profile aliases):
./tools/rcon.ps1 11 "/list-platforms"            # host-1/instance-1   (21 = host-2)

# Find what happened (plugin errors, transfer traces) — reads the JSON logs docker logs hides:
./tools/check-cluster-logs.ps1                   # or -Grep "sendRequest|validation|fail"

# Transfer a platform between instances (then prints post-transfer state):
./tools/transfer-platform.ps1 -PlatformIndex <idx> -Direction 2to1   # or 1to2

# Status / listing:
./tools/show-cluster-status.ps1
./tools/list-platforms.ps1
. ./tools/cluster-utils.ps1                       # dot-source for Send-RCON / Get-InstanceList

# Import an export file: use the web UI "Import JSON" (Manual Transfer / Exports tab) or the in-game
# /plugin-import-file <file> <name> command — both chunk automatically. There is no CLI import script.
```

**Skills** (invoke with `/<name>`): `/cluster-logs` (find logs / trace a failure) and
`/repro-transfer` (reproduce a transfer end-to-end locally). Prefer local repro over CI logs.

## Clusterio Core Development

This repo is a **plugin + dev cluster**; the dev cluster runs **published** `@clusterio/* 2.0.0-alpha.25`
baked into the `ghcr.io/solarcloud7/clusterio-docker-*` images. When you need to change **Clusterio core
itself** (lib/host/controller/ctl), here is where that work lives and how to test it with `surface_export`.

### Home: the sibling fork checkout `../clusterio`
All Clusterio core development lives in the **canonical fork** at `C:\Users\Solar\source\clusterio`
(`origin` = your fork `solarcloud7/clusterio`, `upstream` = `clusterio/clusterio`) — a **sibling** of this
repo, NOT an in-repo checkout (the old `FactorioSurfaceExport/clusterio` was retired; the `/clusterio/`
.gitignore line is a guard so it can't be re-committed). Clusterio uses a **fork-based, pnpm** workflow
(see its `docs/contributing.md`):
- `git fetch upstream` (never `git pull upstream`) → branch off `upstream/master` → push to `origin` →
  PR to `clusterio/clusterio`. Update a branch by rebasing (`git rebase upstream/master`, force-push `+branch`).
- Long-lived fork-only work (e.g. `ExtendedExportData`) stays on its own fork branch.
- Add a changelog entry for user-visible changes; run `pnpm test` + `pnpm lint`.
- To touch a different branch without disturbing in-progress work, use a `git worktree` off `upstream/master`.

### Two ways to test a core change with the plugin
1. **Native pnpm dev env (recommended for *iterating* on a core feature).** Per Clusterio's contributing.md,
   in `../clusterio`: `pnpm install`, put/junction the plugin into `external_plugins/surface_export`,
   `node packages/ctl plugin add ./external_plugins/surface_export`, run `node packages/controller run` +
   `node packages/host run`, iterate with `pnpm watch`. Core edits go live immediately, with source maps.
   The upstream-blessed loop; no version-compat hacks.
2. **Full-cluster Docker override (this repo's 2-host cluster running your fork build).** `pnpm build` the
   fork, then layer `docker-compose.clusterio-src.yml` (bind-mounts each `../clusterio/packages/<pkg>/dist`
   over the image's `@clusterio/<pkg>/dist`):
   ```powershell
   ./tools/rebuild-clusterio.ps1          # pnpm build the fork + recreate the cluster on it
   # revert to the published image:  docker compose up -d --force-recreate
   ```
   **Compatibility caveat:** the fork build must be API-compatible with the plugin's pinned `@clusterio`
   version (alpha.25). Build a branch CLOSE to that release; a heavily-diverged branch may not drop in — if
   instances fail to start, use loop 1 instead. `CLUSTERIO_SRC` overrides the fork path (default `../clusterio`).

### Promoting a change
- **General fix/feature** → verify (loop 1 or 2) → upstream PR to `clusterio/clusterio`. When merged & released,
  the published `@clusterio` version advances.
- **Fork-baseline feature the cluster must persist on** → bake into the images via the **`clusterio-docker`**
  builder (`C:\Users\Solar\source\clusterio-docker`: build from the fork or publish fork packages, bump
  `CLUSTERIO_VERSION`), then bump the pinned tag in `docker-compose.yml` + the plugin `package.json`.

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
├── index.ts              # Plugin registration, config fields, permissions
├── controller.ts         # Controller: slim coordinator delegating to lib/
├── instance.ts           # Instance: RCON bridge, platform listing, chunked import
├── messages.ts           # Message type definitions with JSON schemas (transfer + export/import operations)
├── control.ts            # CLI command registration (clusterioctl)
├── helpers.ts            # Utility functions (chunking, escaping)
├── package.json          # Plugin metadata and dependencies
├── tsconfig.node.json    # TypeScript config: outputs to dist/node/
├── webpack.config.js     # Web UI build config
├── eslint.config.js      # ESLint flat config (TS Link-method binding guard, Pitfall #26)
├── scripts/              # Build/lint helpers (not shipped)
│   ├── lint-lua-invariants.mjs  # Lua guard: storage/global #4, clusterio_lib #12, platform.destroy #19
│   └── lint-webpack-cache.mjs   # Web guard: webpack output must stay content-hashed (static-asset-caching.md)
├── dist/                 # Build output (gitignored, generated by npm run build)
│   ├── node/             # TypeScript compilation output (Node.js runtime)
│   │   ├── index.js      # Built plugin entrypoint
│   │   ├── controller.js # Built controller
│   │   ├── instance.js   # Built instance
│   │   ├── control.js    # Built CLI
│   │   ├── helpers.js    # Built utilities
│   │   ├── messages.js   # Built message types
│   │   ├── *.d.ts        # TypeScript declaration files
│   │   ├── *.map         # Source maps
│   │   └── lib/          # Built library modules
│   └── web/              # Webpack bundle (React + Module Federation)
├── lib/                  # TypeScript source modules
│   ├── platform-tree.ts          # Tree building + instance resolution
│   ├── transaction-logger.ts     # Event logging, phase timing, persistence
│   ├── subscription-manager.ts   # WebSocket subscriptions + broadcasting
│   └── transfer-orchestrator.ts  # Transfer lifecycle state machine
├── web/                  # React web UI (Ant Design + Module Federation)
│   ├── index.jsx         # WebPlugin class, page wrapper, hooks
│   ├── ManualTransferTab.jsx     # Platform tree + per-platform export / per-instance import UI
│   ├── ExportsTab.jsx            # Stored export list + download/upload-import workflows
│   ├── TransactionLogsTab.jsx    # Log viewer + validation display
│   ├── utils.js          # Pure formatting functions (no React)
│   └── style.css
├── module/               # Lua module (save-patched into Factorio instances)
│   ├── module.json       # Module metadata
│   ├── control.lua       # Entry point, event handlers, on_init/on_load, GUI events
│   ├── core/             # Core processing (async-processor, serializer, deserializer, json)
│   ├── export_scanners/  # Entity/inventory/connection/tile scanning
│   ├── import_phases/    # Restoration phases (tiles, hub, entities, state, belts, fluids)
│   ├── interfaces/       # Commands (15 files) + remote interface (18 files) + GUI (1 file)
│   │   ├── commands/     # In-game slash commands
│   │   ├── remote/       # Remote interface functions
│   │   └── gui/          # GUI modules (transaction-dashboard.lua)
│   ├── utils/            # Helpers (game-utils, transaction-history, phase-profiler, etc.)
│   ├── validators/       # Verification, transfer-validation, surface-counter, loss-analysis
│   └── locale/           # Localization strings
└── docs/                 # Documentation

tools/                    # (run `ls tools/` for the full set)
├── deploy-cluster.ps1    # Main deployment script (runs npm run build before Docker startup)
├── build-plugin.ps1      # Safe isolated build (node:24 container): node|web|all, -RestartController / -RestartHosts
├── patch-and-reset.ps1   # Lua / full reload: build plugin (via build-plugin.ps1) + reset saves (re-patch Lua) + restart cluster
├── rcon.ps1              # Agent-friendly one-shot RCON (replaces rc11/rc21 profile aliases)
├── cluster-utils.ps1     # Dot-source for Send-RCON / Get-InstanceList helpers
├── check-cluster-logs.ps1# Dump plugin/factorio logs from where they actually live (JSON files)
├── transfer-platform.ps1 # Transfer a platform between instances
├── show-cluster-status.ps1 # Cluster health/status
└── rebuild-clusterio.ps1 # Build the SIBLING Clusterio fork + run the cluster on it (see "Clusterio Core Development")

docker/
└── seed-data/            # Seed data: database, mods, saves, plugins

.env                      # All environment config (gitignored, credentials)
.env.example              # Template for .env (tracked in git)
docker-compose.yml        # Cluster definition (uses pre-built GHCR images)
docker-compose.clusterio-src.yml  # Opt-in override: run a locally-built Clusterio fork (see "Clusterio Core Development")
```

### Build Architecture

- **Language**: TypeScript 5.5.4 (strict mode) for plugin code, Lua 5.2 for Factorio module
- **Runtime entrypoints**: `index.ts` declares `instanceEntrypoint: "dist/node/instance"`, etc.
- **Build pipeline**: `npm run build` compiles TypeScript → `dist/node/*.js` and bundles React → `dist/web/*`
- **Clean source tree**: Only `.ts` and `.jsx` files in source directories; all generated artifacts in `dist/`
- **Deploy integration**: `deploy-cluster.ps1` runs `npm run build` before Docker compose up
- **Git hygiene**: `dist/` is gitignored; fresh builds ensure consistency
- **Tests**: `npm test` (gated in CI) builds `dist/node` then runs the message round-trip harness
  (`test/messages.roundtrip.test.cjs`, built-in `node --test`, zero deps). It self-discovers every
  message class in `messages.ts` and, per class, asserts the static wire contract
  (`plugin/type/src/dst/jsonSchema/fromJSON`), a stable `toJSON`→`fromJSON` round-trip, and that
  `toJSON` fields agree with `jsonSchema` (catches the field-drift / "Unregistered Event class" /
  serialization-break classes of bug that otherwise only surface at runtime). A new message is
  covered automatically — no edits to the harness needed. Run it in the `@clusterio`-stripped host
  container (it only needs `dist/node`): `docker exec surface-export-host-1 sh -c 'cd /clusterio/external_plugins/surface_export && npm test'`.

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
-- NOTE: clone_platform takes the source platform NAME + dest name (2 args), NOT an index/force.
remote.call("surface_export", "clone_platform", source_name, dest_name)
remote.call("surface_export", "test_import_entity", entity_json, surface_index, position)
remote.call("surface_export", "run_tests")
```

### In-Game Commands
```
/export-platform <index>          # Export platform (async)
/export-platform-file <index>     # Export platform to a disk file (async)
/export-sync-mode [on|off]        # Toggle single-tick (sync) processing — debug
/list-platforms                   # List all platforms
/list-exports                     # List exports in memory
/list-surfaces                    # List all surfaces
/transfer-platform <index> <dest> # Transfer platform to another instance
/lock-platform <index>            # Lock platform for transfer
/unlock-platform <name>           # Unlock a locked platform
/lock-status                      # Show lock status of all platforms
/resume-platform <name>           # Resume a locked platform
/plugin-import-file <file> <name> # Import from a file via plugin
/transaction-dashboard [limit]    # Open in-game transaction history GUI (default: 25 entries)
/step-tick [count]                # Debug: unpause the game to allow async processing
/test-entity <json>               # Debug: test entity import
/test-entity-at <x> <y> <json>    # Debug: test entity import at a position
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

### Space Hub schedule export source (CRITICAL)
- Always read schedule data from `hub_entity.platform`, not from hub entity fields.
- Use `platform.get_schedule()` and serialize both `schedule.stations` and `schedule.interrupts`.
- Include interrupt trigger details, wait conditions, and inherited train-group references.
- This prevents partial exports where stations appear but interrupts are lost.

### Transaction logs
- Logs now include operation type: `transfer`, `export`, `import`.
- `TransactionLogsTab` shows mixed operation history in one list with operation type tags.
- Export/import operations are persisted using the same transaction log store as transfers.

### In-game transaction dashboard
- **Command**: `/transaction-dashboard [limit]` opens GUI (default 25 entries, max 500)
- **Features**: Scrollable history table, color-coded by operation type, detail popups with phase timing
- **Persistence**: Uses LocalisédString profiler snapshots stored in `storage.transaction_history`
- **Phase timing**: Displays per-phase LuaProfiler values that survive save/load
- **Implementation**: Three-part system:
  1. `utils/transaction-history.lua` — Snapshot storage (converts profilers to LocalisedStrings)
  2. `interfaces/gui/transaction-dashboard.lua` — GUI rendering (assigns snapshots to labels)
  3. `core/import-completion.lua` + `core/export-pipeline.lua` — History recording hooks
- **Admin features**: Clear history button, adjustable row limits (10/25/50/100)
- **See**: Pitfall #24 for LocalisedString profiler serialization requirements

## Common Pitfalls & Solutions

### 1. Empty RCON Response
**Symptom**: `rc11` returns nothing (or, in a non-interactive/agent shell, `rc11: not recognized` — the aliases are interactive-profile-only; use `./tools/rcon.ps1 11 "..."`)
**Cause**: Instance not running or mod not loaded
**Fix**: Run `./tools/show-cluster-status.ps1` to check status, then `./tools/check-cluster-logs.ps1` for errors

### 2. Import Fails Silently
**Symptom**: Import command returns but no platform created
**Cause**: JSON too large for a single RCON command
**Fix**: Import via the web UI **Import JSON** (Manual Transfer / Exports tab) or `/plugin-import-file <file> <name>` — both chunk automatically (the instance layer runs the 4KB-chunk RCON protocol). There is no standalone import script.

### 3. Version Mismatch After Deploy
**Symptom**: Old code still running after deploy
**Fix**: Ensure `deploy-cluster.ps1` completed successfully, check for container restart

### 4. Lua `storage` vs `global`
**Important**: Factorio 2.0 renamed `global` to `storage`. Always use `storage.` for persistent data.
**Enforced**: the Lua guard (`npm run lint:lua` → `scripts/lint-lua-invariants.mjs`, gated in CI) fails on any `global.`/`global[`/`global =` in the module tree.

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

### 9. Duplicate Instances on Restart — FIXED IN BASE IMAGE
`docker compose restart` is safe — the base image's `seed-instances.sh` is idempotent (checks for the instance before creating, writes a `.seed-complete` marker, and reconfigures on host token desync). Use `docker compose down -v` only for a full volume wipe.

### 10. Instances Missing Space Age Mods
**Symptom**: Platforms don't exist, Space Age entities missing, game runs in base-game-only mode
**Cause**: `DEFAULT_MOD_PACK` defaults to `"Base Game 2.0"` in the base image controller entrypoint
**Fix**: Set `DEFAULT_MOD_PACK=Space Age 2.0` in `.env`. Requires `docker compose down -v` since mod pack is assigned on first run only.

### 11. Both Instances Have Same Game Port — FIXED IN BASE IMAGE
The base image's `host-entrypoint.sh` auto-derives the port range from HOST_ID (host N → `34N00-34N99`); docker-compose mappings must match. A `down -v` + image pull is needed when upgrading from an older base image.

### 12. Clusterio API Require Path (CRITICAL)
Use `require("modules/clusterio/api")` — the save-patched module path — NOT `require("__clusterio_lib__/api")`. `clusterio_lib` is not a Factorio mod (Clusterio injects its API via save-patching under `modules/`, not as a registered mod), so an `__clusterio_lib__` require or a `script.active_mods["clusterio_lib"]` guard is always nil → "Clusterio API not available - aborting".
**Enforced**: `npm run lint:lua` (gated in CI) fails on any `__clusterio_lib__` reference or `active_mods[...clusterio_lib...]` guard in the module tree.

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

### General Style (partially enforced by ESLint — `npm run lint`, gated in CI)

> `npm run lint` runs four **correctness** guards, all gated in CI:
> - **TS** — `eslint.config.js` in the plugin root (flat config, type-aware via `tsconfig.node.json`). Chiefly the unbound Clusterio Link-method guard (Pitfall #26) via `@typescript-eslint/unbound-method` + a `no-restricted-syntax` selector.
> - **Lua** — `scripts/lint-lua-invariants.mjs` (`npm run lint:lua`), a static guard over the `module/` tree for documented Factorio/Clusterio footguns we've already been bitten by: `global` persistence (Pitfall #4), `__clusterio_lib__` require/`active_mods` guard (#12), and `*platform*.destroy()` no-op (#19). Each rule maps to a Pitfall and was verified clean when added. Add a `-- lint-lua:allow` comment (with a reason) to suppress a verified false positive.
> - **Web cache** — `scripts/lint-webpack-cache.mjs` (`npm run lint:web-cache`), guards that `webpack.config.js` keeps its output filenames content-hashed. A fixed-name `filename`/`chunkFilename` override silently defeats `@clusterio/web_ui`'s hashed default and, with the controller's immutable 1y `/static` cache, serves returning users stale chunks (the regression that shipped in `94e1b8c`; see [docs/static-asset-caching.md](docs/static-asset-caching.md)). Add a `lint-webpack-cache:allow` comment (with a reason) to suppress a verified exception.
> - **Test grounding** — `scripts/lint-test-grounding.mjs` (`npm run lint:test-grounding`), guards that integration tests measure fidelity **independently of the code under test**: a `*fidelity*` test MUST do a physical `get_item_count(...)` count, and any test reading a validator self-report field (`totalItemLoss`/`expectedItemCounts`/`actualItemCounts`) MUST cross-ground it with a physical count. Exists because a `transfer-fidelity` test that asserted on `totalItemLoss` (the value under test) would have gone green on a broken meter — the catch came from physical counts + adversarial review, never the self-report. **Rule of thumb: if the thing under test could be wrong and the test would still pass, it's grounded in the wrong place.** Also: ship the adversarial fixture (inactive inserter, failed entity, non-normal quality) WITH the fix, and run `/code-review` before merging any gate/validation/source-deletion change. Add a `lint-test-grounding:allow` comment (with a reason) to suppress a verified exception.
>
> The cosmetic conventions below (indentation, quotes, naming) are **conventions, not yet all machine-enforced** — match the surrounding code.

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

Transfers preserve **100% of items** and **~100% of fluids**. The durable Factorio 2.0 API facts behind
this — fluid segments, the fluidbox proxy/capacity behavior, segment-ID dedup, fusion-reactor output,
inventory resize/override, the epsilon rule — live in
[factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md). Read that before touching fluid or inventory
restoration.

Project invariants that still bite if changed:
- **Beacon-before-crafter inventory order.** `crafting_speed` (which sets the `set_stack()` cap) only
  reflects beacon bonuses once the beacon's `beacon_modules` inventory is populated, so Phase 3 restores
  beacons first, then everything else. See [Import Phase Ordering](#import-phase-ordering-critical).
- **Belt item drift (±4–8 items).** Belts can't be deactivated, so items move between belts during the
  multi-tick export — cosmetic redistribution, not loss. Export uses an atomic single-tick belt scan to
  keep the snapshot consistent (Pitfall #16).
- **Inject fluid only after activation** (frozen entities are detached from their segment — the
  ghost-buffer trap, Pitfall #17). **Fusion-reactor output rejects writes** (Pitfall #21). Subtract
  rejected writes from expected counts.
- **Entity inventory size** isn't changed by `LuaInventory.resize` (custom inventories only).
  `LuaEntity.set_inventory_size_override` overrides **container** sizes but is a **no-op for crafter inputs**
  at 2.0.76 (verified) — so it is *not* a lever for overloaded-crafter-input loss (already handled by the
  beacon-first ordering). See the API notes.

### Import Phase Ordering (Critical)
The order of post-processing steps in `complete_import_job()` is critical for correctness:

```
1. Hub inventories        — restore after cargo bays exist (inventory size scales with bays)
2. Belt items             — always-active, must restore in single tick
3. Entity state           — control behavior, filters, circuit connections
4. Beacon activation      — activate beacons so crafting_speed bonus propagates instantly
5. Inventories (2 passes) — Pass 1: beacons (populates beacon_modules, crafting_speed updates immediately)
                            Pass 2: everything else (set_stack cap now reflects beacon-boosted cs)
6. Validation             — pre-activation check (items only, fluids skipped)
7. Activation             — ActiveStateRestoration.restore() unfreezes all remaining entities
8. Fluid restoration      — MUST be after activation (ghost buffer fix)
9. Loss analysis          — post-activation counting for accurate transaction log
```

**Why this order matters**:
- Step 4 (beacon activation): beacons are kept active during entity creation (never deactivated). Phase 2 explicitly activates them and fills their energy buffer. This is necessary but not sufficient — beacons need their **module inventory populated** before `crafting_speed` reflects the beacon bonus.
- Step 5 (inventories, 2 passes): The two-pass approach is critical. `crafting_speed` on a machine updates **immediately** when its nearby beacon's `beacon_modules` inventory is populated — no tick delay, no power required. Pass 1 populates all beacon modules. Pass 2 then restores crafter inputs with `set_stack()`, which uses the now-correct beacon-boosted cap (e.g. cs=17.375 → 12 slots instead of cs=2.5 → 7 slots). Machines remain deactivated throughout — they cannot consume items.
- Steps 7→8 are inseparable. If fluids are injected before step 7, Factorio's fluid segment system wipes them on activation. Step 6 skips fluid validation (`skip_fluid_validation=true`) because fluids haven't been injected yet.

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

### 19. Removing a Space Platform — use `game.delete_surface`, not `platform.destroy()` (CRITICAL)
`LuaSpacePlatform.destroy()` is a no-op at our pinned 2.0.76 — verified via RCON: `destroy()`, `destroy(0)`, and `destroy(60)` all return `ok=true` but leave the platform `valid` and present after 100+ ticks; `hub.destroy()` is auto-recovered. (The latest docs describe `destroy(ticks)` as scheduling deferred deletion — a post-2.0.76 change; see [factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md).) Use `game.delete_surface(platform.surface)` (verified to remove the platform) — route all removal through `GameUtils.delete_platform(platform)` (`module/utils/game-utils.lua`), which handles the surfaceless edge case.
**Enforced**: `npm run lint:lua` (gated in CI) fails on any `*platform*.destroy()` call.
**Key files**: `instance.ts` (`handleDeleteSourcePlatform`), `module/core/import-pipeline.lua` (import rollback paths).

### 20. Export-Only Destination Must Be `nil` (Not `0`)
**Symptom**: Export succeeds but source platform remains locked (looks stuck in UI).
**Cause**: `Number(null) === 0` in JS. Passing `0` as destination to Lua is truthy, so export is treated as transfer and unlock is skipped.
**Fix**: In `instance.ts`, only treat `targetInstanceId` as a transfer destination if it is a positive integer (`> 0`); otherwise pass Lua `nil`.

### 21. Fusion-Reactor Output Fluidboxes Reject Writes (Engine Limitation)
Fusion-reactor **output** fluidboxes are engine-managed — `fluidbox[i]=` and `insert_fluid()` return without error but read back 0 (input fluidboxes accept writes normally). See [factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md). The plugin tracks rejected writes in `fluid_restoration.lua` (`write_rejected`) and subtracts them from `expectedFluidCounts` before loss analysis. Covered by the `fusion-reactor-plasma-output` roundtrip test.

### 22. `get_fluid_segment_id()` Returns Nil for Isolated Fluidboxes
`get_fluid_segment_id(i)` returns `nil` for fluidboxes not in a segment (isolated machines such as fusion-generators not connected to pipes) — see [factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md). `inventory-scanner.lua` `extract_fluids` handles this with an `elseif not seg_id` branch that reads the `fluidbox[i]` proxy directly; without it, isolated fluids are silently dropped.

### 23. Thermal Energy Validation for High-Temperature Fluids
Fusion-plasma temperatures (>1,000,000°C) drift continuously, so per-temperature-bucket validation is meaningless (every bucket key changes even though volume is preserved). For high-temp fluids the loss analysis and transaction-log UI validate on **thermal energy (Volume × Temperature)** instead, falling back to per-bucket for old logs without energy data.
**Key files**: `loss-analysis.lua` (`reconcile_fluids` → `highTempAggregates`), `web/utils.js`, `web/TransactionLogsTab.jsx`.

### 24. LuaProfiler Serialization — LocalisedString Snapshots (CRITICAL)
`LuaProfiler` cannot be serialized and `tostring()` returns a memory address, not a time — see [factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md). To persist timing across save/load, embed the profiler in a LocalisedString array (`{"", profiler}`); the engine bakes the value in and a GUI label renders it. Keep live profilers in module-local tables (never `storage`), and snapshot them to LocalisedStrings at job completion. Display-only — no math, no JSON.
**Key files**: `utils/phase-profiler.lua`, `utils/transaction-history.lua`, `interfaces/gui/transaction-dashboard.lua`, `core/import-completion.lua`, `core/export-pipeline.lua`.

### 25. LocalisedString 20-Parameter Limit Can Crash on_tick (CRITICAL)
**Symptom**: Instance shuts down with code 255 during import completion/validation, RCON drops with `Connection closed`, and host logs show `Factorio server unexpectedly shut down`.
**Root Cause**: A single `game.print({...})` LocalisedString exceeded Factorio's hard parameter cap: `Too many parameters for localised string: 39 > 20 (limit)`. This occurred when printing all phase profiler values in one array.
**Error signature**:
```text
Error while running event level::on_tick (ID 0)
Too many parameters for localised string: 39 > 20 (limit)
... import-completion.lua:479 ...
```
**Fix**: Split output into multiple `game.print({"", ...})` calls (one line per phase) so each LocalisedString stays under 20 parameters. Do not pack full perf summaries into one LocalisedString.
**Key file**: `module/core/import-completion.lua`

### 26. NEVER Extract a Clusterio Link Method — Call It Bound (CRITICAL, caused 2 crashes)
**Symptom**: `Cannot read properties of undefined (reading 'handleRequest')` at instance **start**, or `Cannot read properties of undefined (reading 'sendRequest')` during a **transfer**. The instance may even start fine and only crash later when the broken path runs.
**Root Cause**: Clusterio's `Link` methods (`handle`, `sendTo`, `send`, `sendRequest`, `subscribe`, …) rely on `this`. **Extracting one as a value** — directly OR via a cast — loses the binding, so the method runs with `this === undefined` and throws inside `@clusterio/lib`:
```ts
// BROKEN — both of these lose `this`:
const handleMessage = this.i.handle as (cls, h) => void;   // → "reading 'handleRequest'" at start
handleMessage(messages.TransferStatusUpdate, …);
const sendToController = this.i.sendTo as (...) => …;       // → "reading 'sendRequest'" on transfer
await sendToController("controller", new messages.TransferPlatformRequest({…}));
```
Both were introduced by PR #2 (`902c5f8`) as "permissive casts" for Request/Response type mismatches — the `as (...) => …` cast on the *method* silenced the type error AND would silence the lint rule meant to catch it.
**Fix**: ALWAYS call the method **bound** (`this.i.handle(...)`, `this.i.sendTo(...)`). When the plugin's duck-typed message classes don't satisfy the strict overloads, cast the **arguments/result**, never the method:
```ts
this.i.handle(messages.TransferStatusUpdate as never, this.handleTransferStatusUpdate.bind(this) as never);
const resp = await this.i.sendTo(
  "controller",
  new messages.TransferPlatformRequest({ exportId, targetInstanceId }) as never,
) as messages.SimpleResponse & { transferId?: string };
```
**Diagnosing it**: the `this.logger` lines around the throw are in the host log file, not `docker logs` — see Observability above. Read `/clusterio/logs/host/host-*.log` for the exact `Error handling … : Cannot read properties of undefined (reading 'sendRequest')`.
**Mechanical guard**: `npm run lint` (eslint `@typescript-eslint/unbound-method` + a `no-restricted-syntax` rule flagging extraction/cast of any Link method) catches this — and is enforced in CI. This Pitfall exists because a manual audit caught the `handle` site but **missed** the identical `sendTo` site; do not rely on manual review for this class of bug.
**Key file**: `instance.ts` (handler registration ~line 79, `handleExportComplete` sendTo sites).

### 27. Web-UI Icons Blank ("?") — export-data / game-client persistence (CRITICAL)
**Symptom**: Transfer Details / Entities tab shows `?` placeholder icons; browser console/network shows
`Failed to fetch prototype metadata for mod pack <id>, server returned: 404 Not Found`.
**Cause**: the mod pack has no **export-data** (icon spritesheets + prototype metadata). In alpha.25 the icon
system is upstream-native (`FactorioIcon` + `useExportPrototypeMetadata`, [PR #875]; the old `ExtendedExportData`
fork is retired — see [[clusterio-alpha25-migration]]). The data is produced by **`clusterioctl instance
export-data <instance>`**, which is **never** generated unless the export host actually runs the **graphical game
client** (headless has no sprites). Two things silently break it:
  1. **`SKIP_CLIENT=true` on the EXPORT_HOST (host-1).** The base image's `seed-instances.sh` auto-runs
     `export-data` on first seed **only** when `EXPORT_HOST` is set (controller has `EXPORT_HOST=1`) **and** the
     host has a client. With `SKIP_CLIENT=true`, host-1 runs headless-only → export skipped, icons blank. A
     `docker-compose.debug.yml` override once set this on host-1 — **never set `SKIP_CLIENT=true` on host-1**
     (host-2 is import-only and keeps it).
  2. **Stale client version after a Factorio bump.** host-1 uses the client as its `factorio_directory`, a
     single-version **direct install** (clusterio-docker Pitfall #11 — client & multi-version headless are
     mutually exclusive). Clusterio auto-downloads the **free headless** for any version, but **NOT** the
     **owned graphics client** (needs the account token), so the client is a hand-managed install that does
     **not** move when you bump the instance `factorio.version`. A 2.0.x **client** can export icons for any
     2.0.y pack (icons are version-agnostic), but Clusterio refuses to *run the instance* on a mismatched
     binary → export fails. Keep them in lockstep via **`FACTORIO_CLIENT_TAG`** in `.env` (= the instances'
     `factorio.version`; `FACTORIO_CLIENT_BUILD=expansion` for Space Age).
**How it works / where it lands**: `export-data` (instance must be **stopped**) launches the client with
`--export-data` → assets written to the controller's **`/clusterio/static/<kind>.<hash>.{json,png}`**
(prototypes/spritesheet/metadata/locale/defines/settings), referenced by an **`export_manifest`** on the mod-pack
record in `mod-packs.json`, served at **`/static/...`**; `FactorioIcon` fetches them. Verify:
`curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/static/<prototypes-asset>` → `200`.
**Persistence (3 invariants)**: (a) host-1 (=`EXPORT_HOST`) never `SKIP_CLIENT=true`; (b) `FACTORIO_CLIENT_TAG`
pinned in `.env` to the instance version — **bump both together**; (c) the **external** `factorio-client` volume
persists the client across `down -v`, so fresh-seed auto-export always has a client. After a manual version bump
(no `down -v`), the seed-time auto-export does **not** re-run (`.seed-complete`); regenerate by hand:
```powershell
# host-1 must already have a client matching the instance version (FACTORIO_CLIENT_TAG)
./tools/rcon.ps1 ...                                  # (not needed) — use clusterioctl directly:
docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json instance stop clusterio-host-1-instance-1'
docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json instance export-data clusterio-host-1-instance-1'  # "Export complete: N icons"
docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json instance start clusterio-host-1-instance-1'
```
Then **hard-refresh** the browser (the 404 is cached). After a `down -v`, fresh seed regenerates it automatically.
**Key files/config**: `.env` (`FACTORIO_CLIENT_TAG`/`FACTORIO_CLIENT_BUILD`), `docker-compose.debug.yml` (no
`SKIP_CLIENT` on host-1), clusterio-docker `scripts/seed-instances.sh` (auto-export), `web/icons.tsx`.

### 28. Transfer Validation Timing — the gate must count a COMPLETE state (CRITICAL, data-integrity)
**Symptom**: the transfer gate reports a few hundred items "lost" (the phantom 382/417) even though the
transfer physically preserves ~100%. Tightening the loose tolerance to catch real loss then fails *every*
transfer.
**Root cause**: the gate counts the destination **pre-activation** (Pitfall #15 — machines must stay
deactivated through validation or they craft in the gap and produce false GAINS), but inserter **held items**
restore only via `set_stack`, which silently fails on a settled-deactivated inserter — so they're absent at
the gate. The gate measures a *deliberately-incomplete* reality. The data is fine; the clock is wrong.
**DO NOT re-attempt** (each is a proven dead-end — see [memory] `validation-timing-trilemma`): (1) move
validation after activation → craft-gain false failures; (2) subtract *predicted* held items from expected
(PR #25, closed) → prediction ≠ restoration → an inactive inserter's item is subtracted, never restored →
**silent permanent loss**; (3) gate-vs-display two-pass → coupling hell.
**Fix (approach #4 — fix the clock)**: held items only need the *inserter* active, not the machines. A
pre-gate pass (`ActiveStateRestoration.restore_held_items_only`) briefly toggles each inserter active →
`set_stack` → back, in one synchronous pass (no engine tick → no swing, no crafting), so the gate counts a
**complete** physical reality with every machine still deactivated. Then `validate_import(..., {strict=true})`
tightens the per-item tolerance to `max(20, 1.5%·expected)` (≈3× the irreducible belt-restoration floor).
**Rule**: a gate must measure a COMPLETE state, never a mid-process one — fix the timing, not the number.
**Mechanical guard**: `tests/integration/gate-detects-loss` injects a real shortfall (`test_force_item_loss`)
and asserts the strict gate FAILS + the source is preserved — so reverting to a loose gate goes RED in CI.
**Key files**: `module/import_phases/active_state_restoration.lua`, `module/core/import-completion.lua`,
`module/validators/transfer-validation.lua`.
**Deeper root cause (the CI-only residual): see Pitfall #29** — `restore_held_items_only` (the timing fix
above) is necessary but NOT sufficient on an under-researched destination: `set_stack` clamps to the dest
inserter's *physical* hand capacity, which the dest **force's** research governs. The phantom 382/417 was that
clamp, not the clock alone.

### 29. Inserter Held-Item Capacity Is Governed by the DEST Force's Research — Replicate It On Import (CRITICAL, data-integrity)
**Symptom**: a transfer of a busy platform fails the strict gate **only on CI** (railgun-ammo 80→33,
"held_failed=214"), while the *same payload + same code* restores held items fully **locally**. "Same bytes,
different by machine."
**Root cause**: a bulk-inserter hand's physical capacity = the **destination force's**
`bulk_inserter_capacity_bonus` (normal inserters: `inserter_stack_size_bonus`) — research-derived scalars that
live in the **dest save**, which the plugin did not transfer. Measured on 2.0.76: CI's fresh `test2.zip` seed
has `bulk_inserter_capacity_bonus = 0` → a fresh legendary bulk inserter caps at 1 (`set_stack(8)→1`,
`.count=8→1`); a long-lived local host-2 has bonus 11 → seats 8. So the held items the source legitimately held
are **genuinely unplaceable** on a less-researched dest, and the strict gate (Pitfall #28) **correctly** refuses
(two-phase commit preserves the source). NOT a restoration bug. This also overturns the "`held_stack.count` has
no capacity cap" assumption — it clamps (CI: `.count=8→1`).
**Fix — Pre-Hydration Force Sync**: export captures the source force's inserter bonuses (`force_data`); import
replicates them onto the dest force in a one-shot **Phase 0** (`ImportPipeline.process_batch`) **before** any
entity is created — **RAISE-ONLY** (`math.max`; never LOWER a dest bonus, which would eject other platforms'
held items). It raises **every distinct force the entities land on** (`entity_data.force or "player"`), not just
the platform force, so a differently-forced inserter can't be left under-capacity (silent loss). The property
list is a single source of truth: `GameUtils.FORCE_SYNC_PROPS`. The existing `restore_held_items_only` → strict
gate then seats full and passes **natively** — the gate is unchanged. A non-fatal `forceDataMismatches` warning
surfaces the raise in the UI. **Applies to ALL imports (transfer AND uploaded-JSON), by design** — fidelity over
avoiding the (warned, raise-only) research-boost side effect; uploads delete no source, so there is no loss risk
either way.
**Durability (verified on 2.0.76)**: an unbacked direct write grants real seating capacity, and once seated the
hand keeps its items even if the bonus later drops or `reset_technology_effects()` runs — so there is no
post-commit loss path; the write need not be tech-backed.
**Mechanical guard**: `tests/integration/force-bonus-sync` forces the dest bonus to 0, transfers, and asserts
(physical held counts) the bonus is raised, held items seat in full, the strict gate passes, and the warning
fired — reverting the sync goes RED. CI's native bonus-0 host-2 means platform-roundtrip / transfer-fidelity
corroborate.
**Key files**: `module/core/export-pipeline.lua` (capture), `module/core/import-pipeline.lua` (Phase-0 sync),
`module/core/import-completion.lua` (warning), `module/import_phases/active_state_restoration.lua` (the
disproven `count=` hack removed). Memory: [memory] `held-item-loss-is-dest-force-research`.

## Factorio 2.0 Fluid API & Simulation Behavior

Moved to [factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md) — the fluid-segment model, the
fluidbox proxy/capacity behavior, segment-ID dedup, the floating-point epsilon rule, and the
inject-after-activation requirement. Read it before touching fluid scanning or restoration.

## Additional Documentation

- [docs/README.md](docs/README.md) - Plugin overview and documentation index
- [docs/commands-reference.md](docs/commands-reference.md) - All available commands
- [docs/QUICK_START.md](docs/QUICK_START.md) - End-to-end transfer walkthrough
- [docs/CI_CD.md](docs/CI_CD.md) - CI pipeline, Factorio-baking for integration tests, and debugging failed runs
- [docs/TRANSFER_WORKFLOW_GUIDE.md](docs/TRANSFER_WORKFLOW_GUIDE.md) - Transfer phases and validation
- [docs/EXPORT_IMPORT_FLOW.md](docs/EXPORT_IMPORT_FLOW.md) - Complete action trace with debugging
- [docs/IMPLEMENTATION_SUMMARY.md](docs/IMPLEMENTATION_SUMMARY.md) - Module structure and design decisions
- [docs/async-processing.md](docs/async-processing.md) - Async batch processing architecture
- [docs/TRANSFER_CODE_PATHS.md](docs/TRANSFER_CODE_PATHS.md) - Transfer feature mapped to its code paths
- [docs/factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md) - Verified Factorio 2.0 API & fluid-simulation facts
- [docs/FAILED_ENTITY_LOSS_TRACKING.md](docs/FAILED_ENTITY_LOSS_TRACKING.md) - How losses from entities that fail to place are attributed

## Debugging Tips

### Docker Logs (IMPORTANT — Windows Shell Escaping)

**CRITICAL**: On Windows with Git Bash, `docker exec` path arguments get mangled by MSYS path conversion (e.g., `/clusterio/` → `C:/Program Files/Git/clusterio/`). Always wrap commands in `sh -c '...'` with single quotes:

```bash
# WRONG (Git Bash mangles the path):
docker exec surface-export-controller npx clusterioctl --config=/clusterio/tokens/config-control.json ...

# CORRECT (single-quoted sh -c prevents path mangling):
docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json ...'
```

**RCON command (always use sh -c with single quotes):**
```bash
docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error instance send-rcon "clusterio-host-1-instance-1" "/list-platforms"'
```

### Observability — WHERE EACH LOG ACTUALLY LIVES (read this before debugging)

**The #1 gotcha that wastes hours**: a plugin's `this.logger.info(...)` output (controller AND instance/host plugins) does **NOT** reliably appear in `docker logs`. `docker logs surface-export-host-1 | grep surface_export` returns **nothing** — the host plugin's own logs are not on host stdout. Clusterio routes them to **log files on disk** instead. Look in the files, not (only) `docker logs`.

| What you want | Where it actually is | How to read it |
|---|---|---|
| **Everything, aggregated** (controller + every host + every instance plugin `this.logger`) | Controller: `/clusterio/logs/cluster/cluster-YYYY-MM-DD.log` (JSON lines, date-rotated) | `docker exec surface-export-controller sh -c 'cat /clusterio/logs/cluster/cluster-*.log' \| grep -aoE '"message":"[^"]*"'` |
| **One host's plugin logs** (instance `this.logger.info/error`) | Host: `/clusterio/logs/host/host-YYYY-MM-DD.log` (JSON lines) | `docker exec surface-export-host-1 sh -c 'cat /clusterio/logs/host/host-*.log' \| grep -aoE '"message":"[^"]*"' \| grep -i transfer` |
| **Controller-origin plugin logs only** | `docker logs surface-export-controller` stdout (controller `this.logger` DOES appear here; host/instance logs do NOT) | `docker logs --tail 300 surface-export-controller 2>&1 \| grep surface_export` |
| **Factorio engine + Lua `log(...)` / `[Script]`** | Host: `/clusterio/data/instances/<instance>/factorio-current.log` (also mirrored into the host/cluster JSON logs as `"level":"server"`) | `docker exec surface-export-host-1 sh -c 'tail -200 /clusterio/data/instances/clusterio-host-1-instance-1/factorio-current.log'` |
| **Debug dumps** (`debug_source_*`, `debug_destination_*`, `debug_import_result_*`) | Host: `/clusterio/data/instances/<instance>/script-output/` (only when `debug_mode` on) | `docker exec surface-export-host-2 sh -c 'ls /clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_*.json'` |

The JSON log shape is `{"instance_id":…,"instance_name":…,"level":"info|error|server","message":"…","plugin":"surface_export","timestamp":"…"}`. Filter a single plugin with `grep '"plugin":"surface_export"'`. The `cluster-*.log` file is the single best place to trace a cross-instance transfer end-to-end (it has the host-1 export, the controller routing, AND the host-2 import in one stream).

**Prometheus metrics are LIVE**: the `statistics_exporter` plugin exposes `http://localhost:8080/metrics` on the controller (process + cluster metrics, ~45 KB). **Custom surface_export transfer metrics are now implemented** — `lib/metrics.ts` defines collectors that register to Clusterio's default registry (so they surface on the same `/metrics` with no extra wiring) and `recordOperationOutcome()` is called from `SubscriptionManager.emitTransferUpdate` (the universal terminal chokepoint, idempotent per operation):
- `surface_export_operations_total{operation,result}` — counter; `operation` ∈ transfer/export/import, `result` ∈ success/failure/cleanup_failed
- `surface_export_operation_duration_seconds{operation,result}` — histogram (buckets 0.5s…300s)
- `surface_export_entities_transferred_total{operation}` — counter (entities placed on the destination)

These complement, not replace, the JSON-file logs above — metrics tell you *that* transfers are failing and how long they take; the `cluster-*.log` files tell you *why*. Scrape with `docker exec surface-export-controller sh -c 'curl -s http://localhost:8080/metrics | grep ^surface_export_'`.

**Note**: `--tail N` goes BEFORE the container name. After a container restart, `docker logs` loses pre-restart output — but the on-disk `/clusterio/logs/*` files persist across restarts (until date-rotation), so prefer the files for any post-restart investigation.

### Check Plugin Module is Loaded
```powershell
rc11 "/sc rcon.print(remote.interfaces['surface_export'] ~= nil)"  -- Should print 'true'
```

### View Factorio Log (from container)
```bash
docker exec surface-export-host-1 sh -c 'tail -100 /clusterio/data/instances/clusterio-host-1-instance-1/factorio-current.log'
```

### Check Async Job Queue
```powershell
rc11 "/sc rcon.print(serpent.block(storage.async_jobs or {}))"
```

### List Available Remote Interfaces
```powershell
rc11 "/sc for name, _ in pairs(remote.interfaces) do rcon.print(name) end"
```
