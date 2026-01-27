# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with the FactorioSurfaceExport project.

## FactorioSurfaceExport Project Overview

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
- Controller: `clusterio-controller` (Web UI: http://localhost:8080)
- Host 1: `clusterio-host-1` → Instance: `clusterio-host-1-instance-1` (Game: 34197, RCON: 27015)
- Host 2: `clusterio-host-2` → Instance: `clusterio-host-2-instance-1` (Game: 34198, RCON: 27016)

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

# Check async job status
rc11 "/sc rcon.print(remote.call('FactorioSurfaceExport', 'get_job_status', 'export_1'))"

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
docker exec clusterio-controller npx clusterioctl --log-level error instance send-rcon "clusterio-host-1-instance-1" "/list-platforms"
```

## Development Tools

### Primary Deployment Script
```powershell
./tools/deploy-cluster.ps1                 # Full deployment: increment version, rebuild cluster
./tools/deploy-cluster.ps1 -SkipIncrement  # Rebuild without version bump
```

### Hot Reload Development (Recommended)

The plugin uses **save patching** with hot reload:
- Controller runs with `--dev --dev-plugin surface_export` flags
- Plugin location: `docker/seed-data/external_plugins/surface-export/`
- Contains both Node.js plugin code and Lua `module/` directory

**Plugin Changes** (TypeScript/JavaScript):
- Edit `*.js` files in plugin root → Hot reload automatically
- No restart needed

**Module Changes** (Lua - Save Patched):
- Edit `*.lua` files in `module/` directory → Restart instances to re-patch saves
- Clusterio automatically injects Lua code into saves at startup

**Development Workflow**:
1. Start cluster: `docker-compose -f docker/docker-compose.clusterio.yml up -d`
2. Edit plugin JS files → changes reload automatically (hot reload enabled)
3. Edit module Lua files → restart instances: `clusterioctl instance stop-all && clusterioctl instance start-all`
4. Saves are automatically patched with your Lua code

See [docs/save-patching-and-hot-loading.md](docs/save-patching-and-hot-loading.md) for save patching details.

### Import/Export Tools
```bash
# Recommended: Use bash script inside container (100KB chunks, ~3.4s)
docker exec clusterio-host-1 /clusterio/seed-data/scripts/import-platform-linux.sh \
  /clusterio/seed-data/exports/export.json clusterio-host-1-instance-1

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
│       ├── safety.lua            # pcall wrappers for atomic operations
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
├── docker-compose.clusterio.yml  # Cluster definition
├── .env                          # Ports, passwords, credentials
└── seed-data/                    # Initial configs, mods, saves
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

### Remote Interface (`FactorioSurfaceExport`)
```lua
-- Key remote interface functions (call via /sc remote.call(...))
remote.call("FactorioSurfaceExport", "export_platform", platform_index, force_name)
remote.call("FactorioSurfaceExport", "import_platform_data_async", json_data, platform_name, force_name)
remote.call("FactorioSurfaceExport", "begin_import_session", session_id, total_chunks, platform_name, force_name)
remote.call("FactorioSurfaceExport", "enqueue_import_chunk", session_id, chunk_index, chunk_data)
remote.call("FactorioSurfaceExport", "finalize_import_session", session_id, checksum)
remote.call("FactorioSurfaceExport", "get_import_status", job_id)  -- Returns {complete, progress, platform_name, ...}
remote.call("FactorioSurfaceExport", "list_exports")

-- Note: File-based import not available (Factorio 2.0 removed runtime file reading)
-- Chunked RCON is the only method for large imports
```

### In-Game Commands
```
/export-platform <index>          # Export platform (async)
/export-platform-file <index>     # Export to disk file
/import-platform <export_id>      # Import from memory
/list-platforms                   # List all platforms
/list-exports                     # List exports in memory
/list-surfaces                    # List all surfaces
/async-status                     # Show active async jobs
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

### Check Mod is Loaded
```powershell
rc11 "/sc rcon.print((script.active_mods and script.active_mods['FactorioSurfaceExport']) or 'NOT_LOADED')"
```

### View Factorio Log (from container)
```powershell
docker exec clusterio-host-1 tail -100 /clusterio/instances/clusterio-host-1-instance-1/factorio-current.log
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
