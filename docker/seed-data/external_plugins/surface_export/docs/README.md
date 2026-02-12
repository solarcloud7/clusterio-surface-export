# Surface Export Plugin

Clusterio plugin for exporting and importing Factorio 2.0 space platforms between instances. Supports full platform state: entities, tiles, inventories, equipment grids, fluids, and connections.

**Version**: 0.9.34 | **License**: MIT | **Author**: Solarcloud7

## Features

- Async export/import (50 entities/tick, <1% UPS impact)
- Chunked RCON transport for large platforms (100KB chunks)
- Surface locking during transfers (prevents player modification)
- Post-transfer validation (item/fluid count verification)
- Automatic rollback on failure, automatic source cleanup on success
- Clone platform within same instance
- Transaction logging for transfer auditing

## Architecture

```
Source Instance (Lua) ←IPC→ Instance Plugin (JS) ←WebSocket→ Controller Plugin (JS) ←WebSocket→ Destination Instance Plugin (JS) ←IPC→ Destination Instance (Lua)
```

**Components:**
- **Lua Module** (`module/`): Save-patched into Factorio instances. Handles serialization, async processing, locking, validation.
- **Instance Plugin** (`instance.js`): Bridges Lua ↔ Controller. Handles RCON chunking, file reads.
- **Controller Plugin** (`controller.js`): Stores exports, orchestrates transfers, manages transaction logs.
- **CLI** (`control.js`): `clusterioctl surface-export` subcommands.

## Docker Setup

This plugin is deployed as an external plugin via the FactorioSurfaceExport project. See the [main README](../../../../../README.md) for Docker setup.

```bash
# From repo root
docker compose up -d

# Verify plugin loaded
docker logs surface-export-controller 2>&1 | grep "surface_export"
```

## In-Game Commands

| Command | Description |
|---------|-------------|
| `/export-platform <index>` | Export platform asynchronously |
| `/export-platform-file <index>` | Export to disk file in script-output/ |
| `/export-sync-mode <index>` | Export synchronously (blocks game) |
| `/transfer-platform <index> <dest_id>` | Transfer platform to another instance |
| `/list-platforms` | List all space platforms |
| `/list-exports` | List exports in memory |
| `/list-surfaces` | List all surfaces |
| `/lock-platform <index>` | Lock platform (hide from players) |
| `/unlock-platform <name>` | Unlock a locked platform |
| `/lock-status` | Show lock status of all platforms |
| `/resume-platform <name>` | Resume a locked platform |
| `/plugin-import-file <file> <name>` | Import from file via plugin |
| `/step-tick <count>` | Debug: advance N async ticks |
| `/test-entity <json>` | Debug: test single entity import |

## CLI Commands

```bash
# List stored exports on controller
npx clusterioctl surface-export list

# Transfer a stored export to a target instance
npx clusterioctl surface-export transfer <exportId> <targetInstanceId>
```

## Remote Interface

The Lua module registers as `"surface_export"` (not `"FactorioSurfaceExport"`).

```lua
-- Export
remote.call("surface_export", "export_platform", platform_index, force_name)
remote.call("surface_export", "export_platform_to_file", platform_index, force_name, filename)
remote.call("surface_export", "get_export", export_id)
remote.call("surface_export", "get_export_json", export_id)
remote.call("surface_export", "list_exports")
remote.call("surface_export", "list_exports_json")
remote.call("surface_export", "clear_old_exports", max_to_keep)

-- Import (chunked — Factorio 2.0 cannot read files at runtime)
remote.call("surface_export", "import_platform_chunk", platform_name, chunk_data, chunk_num, total_chunks, force_name)

-- Platform locking
remote.call("surface_export", "lock_platform_for_transfer", platform_index, force_name)
remote.call("surface_export", "unlock_platform", platform_name)

-- Validation
remote.call("surface_export", "get_validation_result", platform_name)
remote.call("surface_export", "get_validation_result_json", platform_name)

-- Configuration
remote.call("surface_export", "configure", config_table)

-- Debug/testing
remote.call("surface_export", "clone_platform", platform_index, force_name, new_name)
remote.call("surface_export", "test_import_entity", entity_json, surface_index, position)
remote.call("surface_export", "run_tests")
```

## Configuration

**Instance config:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `surface_export.max_export_cache_size` | number | 10 | Max exports kept in memory |
| `surface_export.batch_size` | number | 50 | Entities processed per tick |
| `surface_export.max_concurrent_jobs` | number | 3 | Max parallel async jobs |
| `surface_export.show_progress` | boolean | true | Show progress messages in game |
| `surface_export.debug_mode` | boolean | false | Enable debug logging |
| `surface_export.pause_on_validation` | boolean | false | Pause game during validation |

**Controller config:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `surface_export.max_storage_size` | number | 100 | Max exports stored on controller |

## Plugin File Structure

```
surface_export/
├── index.js                  # Plugin definition, config fields, message registration
├── controller.js             # Controller: export storage, transfer orchestration
├── instance.js               # Instance: RCON bridge, chunking, IPC handlers
├── control.js                # CLI: surface-export list/transfer subcommands
├── helpers.js                # sendChunkedJson, hybrid Lua escaping
├── messages.js               # 11 message type definitions
├── package.json
├── module/                   # Lua module (save-patched into Factorio)
│   ├── module.json
│   ├── control.lua           # Entry point (event_handler interface)
│   ├── core/
│   │   ├── async-processor.lua
│   │   ├── serializer.lua
│   │   ├── deserializer.lua
│   │   └── json.lua
│   ├── export_scanners/
│   │   ├── entity-scanner.lua
│   │   ├── inventory-scanner.lua
│   │   ├── connection-scanner.lua
│   │   ├── entity-handlers.lua
│   │   └── tile_scanner.lua
│   ├── import_phases/
│   │   ├── entity_creation.lua
│   │   ├── entity_state_restoration.lua
│   │   ├── active_state_restoration.lua
│   │   ├── belt_restoration.lua
│   │   ├── fluid_restoration.lua
│   │   ├── tile_restoration.lua
│   │   └── platform_hub_mapping.lua
│   ├── interfaces/
│   │   ├── commands.lua      # Command loader
│   │   ├── commands/         # 14 command files + base.lua
│   │   ├── remote-interface.lua  # Remote interface loader
│   │   └── remote/           # 14 remote function files + base.lua
│   ├── utils/
│   │   ├── util.lua
│   │   ├── game-utils.lua
│   │   ├── string-utils.lua
│   │   ├── table-utils.lua
│   │   ├── json-compat.lua
│   │   ├── surface-lock.lua
│   │   └── debug-export.lua
│   └── validators/
│       ├── verification.lua
│       └── transfer-validation.lua
└── docs/                     # This directory
```

## Documentation

- [QUICK_START.md](QUICK_START.md) — End-to-end transfer walkthrough
- [DEVELOPMENT_SETUP.md](DEVELOPMENT_SETUP.md) — Development and hot-reload workflow
- [TRANSFER_WORKFLOW_GUIDE.md](TRANSFER_WORKFLOW_GUIDE.md) — Transfer phases, validation, troubleshooting
- [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) — Technical decisions and Factorio 2.0 compatibility
- [CARGO_POD_API.md](CARGO_POD_API.md) — Factorio cargo pod API reference
- [import-platform-linux.sh](import-platform-linux.sh) — Bash import script for use inside containers
