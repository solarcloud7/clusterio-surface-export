# Surface Export Plugin

Clusterio plugin for exporting and importing Factorio 2.0 space platforms between instances. Supports full platform state: entities, tiles, inventories, equipment grids, fluids, belt items, circuit connections, and control behaviors.

This is the plugin-level documentation index. For project-level setup, performance, and the full development workflow, see the [main README](../README.md).

## Table of Contents

- [Architecture](#architecture)
- [Docker Setup](#docker-setup)
- [In-Game Commands](#in-game-commands)
- [CLI Commands](#cli-commands)
- [Remote Interface](#remote-interface)
- [Configuration](#configuration)
- [Plugin Layout](#plugin-layout)
- [Documentation](#documentation)

## Architecture

```
Source Instance (Lua) ←send_json event→ Instance Plugin (TS) ←WebSocket link→ Controller Plugin (TS) ←WebSocket link→ Destination Instance Plugin (TS) ←send_json event→ Destination Instance (Lua)
```

The plugin is written in TypeScript (compiled to `dist/node/`); the Factorio module is Lua, save-patched into instances.

**Components:**

| Component | Source | Role |
|-----------|--------|------|
| Lua module | `module/` | Save-patched into Factorio instances. Serialization, async processing, locking, validation. |
| Instance plugin | `instance.ts` | Bridges Lua ↔ Controller. RCON chunking, send_json event handlers. |
| Controller plugin | `controller.ts` | Stores exports, orchestrates transfers, manages transaction logs. |
| CLI | `control.ts` | `clusterioctl surface-export` subcommands. |
| Web UI | `web/` | React + Module Federation tabs (manual transfer, exports, transaction logs). |

## Docker Setup

This plugin is deployed as an external plugin via the clusterio-surface-export project. See the [main README](../README.md) for Docker setup.

```bash
# From repo root
docker compose up -d

# Verify plugin loaded (controller-origin logs appear on controller stdout)
docker logs surface-export-controller 2>&1 | grep "surface_export"
```

## In-Game Commands

These run in-game via the chat console or remotely via RCON. They are registered in `module/interfaces/commands/`. See [commands-reference.md](commands-reference.md) for full usage and arguments.

| Command | Description |
|---------|-------------|
| `/export-platform <index>` | Export platform asynchronously |
| `/export-platform-file <index>` | Export to disk file in `script-output/` |
| `/export-sync-mode [on\|off]` | Toggle single-tick (sync) processing for debugging |
| `/transfer-platform <index> <dest_id>` | Transfer platform to another instance |
| `/list-platforms` | List all space platforms |
| `/list-exports` | List exports in memory |
| `/list-surfaces` | List all surfaces |
| `/lock-platform <index>` | Lock platform (hide from players) |
| `/unlock-platform <name>` | Unlock a locked platform |
| `/lock-status` | Show lock status of all platforms |
| `/resume-platform <name>` | Unpause a paused platform |
| `/plugin-import-file <file> <name>` | Import from file via plugin |
| `/transaction-dashboard [limit]` | Open in-game transaction history GUI |
| `/step-tick [count]` | Debug: unpause the game to allow async processing |
| `/test-entity <json>` | Debug: test a single entity import |
| `/test-entity-at <x> <y> <json>` | Debug: test a single entity import at a position |

## CLI Commands

Registered under `clusterioctl surface-export` in `control.ts`:

```bash
# List stored exports on the controller
npx clusterioctl surface-export list

# Download a stored export payload as JSON
npx clusterioctl surface-export get-export <exportId> [outputFile]

# Upload a JSON export file and import it onto a target instance
npx clusterioctl surface-export upload-import <file> <targetInstanceId> [forceName] [platformName]

# Start a transfer through the controller orchestration path (same path as the web UI)
npx clusterioctl surface-export start-transfer <sourceInstanceId> <sourcePlatformIndex> <targetInstanceId> [forceName]

# Import a stored export onto a target instance
npx clusterioctl surface-export transfer <exportId> <instanceId>
```

## Remote Interface

The Lua module registers as `"surface_export"`. Functions are defined in `module/interfaces/remote/` and wired up in `module/interfaces/remote-interface.lua`.

```lua
-- Export
remote.call("surface_export", "export_platform", platform_index, force_name)
remote.call("surface_export", "export_platform_to_file", platform_index, force_name, filename)
remote.call("surface_export", "get_export", export_id)
remote.call("surface_export", "get_export_json", export_id)
remote.call("surface_export", "list_exports")
remote.call("surface_export", "list_exports_json")
remote.call("surface_export", "list_platforms")
remote.call("surface_export", "list_platforms_json")
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
remote.call("surface_export", "clone_platform", source_index, dest_name)  -- source by UNIQUE index (names collide), 2 args
remote.call("surface_export", "test_import_entity", entity_json, surface_index, position)
remote.call("surface_export", "run_tests")
```

## Configuration

Config fields are defined in `index.ts`.

**Instance config:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `surface_export.max_export_cache_size` | number | 10 | Max exports cached per instance |
| `surface_export.batch_size` | number | 50 | Entities processed per tick during async operations |
| `surface_export.max_concurrent_jobs` | number | 3 | Max concurrent async import/export jobs |
| `surface_export.show_progress` | boolean | true | Show progress notifications for async operations |
| `surface_export.debug_mode` | boolean | true | Export JSON comparison files for transfer validation |

**Controller config:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `surface_export.max_storage_size` | number | 20 | Max exports stored on the controller |

## Plugin Layout

Plugin root: `docker/seed-data/external_plugins/surface_export/`. The full project tree is in the [main README](../README.md) under Project Structure.

| Path | Contents |
|------|----------|
| `index.ts` | Plugin definition, config fields, message registration |
| `controller.ts` | Controller: export storage, transfer orchestration, transaction logs |
| `instance.ts` | Instance: RCON bridge, chunking, send_json event handlers |
| `control.ts` | CLI: `surface-export` subcommands |
| `messages.ts` | Plugin message type definitions |
| `helpers.ts` | `sendChunkedJson`, Lua escaping helpers |
| `lib/` | TypeScript modules (platform tree, subscription manager, transaction logger, transfer orchestrator, metrics) |
| `web/` | React web UI (Ant Design + Module Federation) |
| `module/` | Lua module, save-patched into Factorio (`core/`, `export_scanners/`, `import_phases/`, `interfaces/`, `utils/`, `validators/`, `locale/`) |
| `test/` | Message round-trip test harness |
| `scripts/` | Build/lint helpers (Lua-invariant and webpack-cache guards) |
| `dist/` | Build output (`dist/node/`, `dist/web/`), gitignored |

For the detailed Lua module breakdown, see [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md).

## Documentation

| Doc | Covers |
|-----|--------|
| [QUICK_START.md](QUICK_START.md) | End-to-end platform transfer walkthrough |
| [ENGINEERING_FAQ.md](ENGINEERING_FAQ.md) | "What if the user does X?" edge-case checklist — how each transfer/lock/failure case is engineered today, with OPEN items flagged for a human call |
| [E2E_TEST_GUIDE.md](E2E_TEST_GUIDE.md) | Hands-on QA checklist to validate the full transfer pipeline (automated suite + manual flows + failure cases) |
| [commands-reference.md](commands-reference.md) | All in-game / RCON console commands with usage |
| [TRANSFER_2PC.md](TRANSFER_2PC.md) | Transfer durability, identity (surface.index not name), and two-phase-commit design + current state — single source of truth |
| [TRANSFER_WORKFLOW_GUIDE.md](TRANSFER_WORKFLOW_GUIDE.md) | Transfer entry points, phases, critical invariants |
| [TRANSFER_CODE_PATHS.md](TRANSFER_CODE_PATHS.md) | End-to-end code trace of a transfer, from UI click to completion |
| [EXPORT_IMPORT_FLOW.md](EXPORT_IMPORT_FLOW.md) | Action trace of export/import/transfer with message names, channels, and handler locations |
| [async-processing.md](async-processing.md) | Async batch-processing architecture for large exports/imports |
| [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) | Plugin architecture deep-dive and Lua module structure |
| [FAILED_ENTITY_LOSS_TRACKING.md](FAILED_ENTITY_LOSS_TRACKING.md) | How items/fluids in entities that fail to place are tallied and attributed |
| [factorio-2.0-api-notes.md](factorio-2.0-api-notes.md) | Verified Factorio 2.0 API & fluid-simulation facts (fluid segments, profiler/LocalisedString, inventory/platform APIs) |
| [static-asset-caching.md](static-asset-caching.md) | Webpack content-hashing requirement for web chunks and its dev-workflow consequence |
| [CI_CD.md](CI_CD.md) | CI pipeline, integration-test flow, and how Factorio is provisioned in CI |
| [GATEWAY_TRANSFER_PRD.md](GATEWAY_TRANSFER_PRD.md) | In-game gateway transfer — design + current state (what's shipped, verified 2.0.76 API facts, planned work) |
