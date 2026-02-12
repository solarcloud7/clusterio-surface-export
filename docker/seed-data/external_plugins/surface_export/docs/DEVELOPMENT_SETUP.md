# Development Setup

## Prerequisites

- Docker Desktop (for containerized development)
- PowerShell (for tools scripts)
- A text editor (Lua + JavaScript)

## Plugin Location

The plugin source lives at:
```
docker/seed-data/external_plugins/surface_export/
```

This directory is bind-mounted into containers at `/clusterio/external_plugins/surface_export/`. The base image entrypoint runs `npm install` on startup, so no manual install step is needed.

## Directory Structure

```
surface_export/
├── index.js              # Plugin definition (config fields, messages, permissions)
├── controller.js         # Controller logic (storage, transfer orchestration)
├── instance.js           # Instance logic (RCON bridge, chunking, IPC)
├── control.js            # CLI commands (surface-export list/transfer)
├── helpers.js            # Chunked JSON, hybrid Lua escaping
├── messages.js           # 11 message type definitions
├── package.json          # Plugin metadata
├── module/               # Lua module (save-patched into Factorio)
│   ├── module.json       # Module metadata
│   ├── control.lua       # Entry point (event_handler interface)
│   ├── core/             # Async processing, serialization, deserialization
│   ├── export_scanners/  # Entity, inventory, connection, tile scanning
│   ├── import_phases/    # Entity creation, state restoration, fluids, belts, tiles
│   ├── interfaces/       # Commands (14) and remote interface (18 functions)
│   │   ├── commands/     # Console command implementations
│   │   └── remote/       # Remote interface function implementations
│   ├── utils/            # Helpers: surface-lock, json-compat, game-utils, etc.
│   └── validators/       # Verification and transfer validation
└── docs/                 # Documentation (this directory)
```

## Development Workflow

### Starting the Cluster

```bash
# From repo root
docker compose up -d
```

### Editing Lua Module Code

Lua files in `module/` are **save-patched** — Clusterio injects them into Factorio saves at instance startup. To pick up changes:

1. Edit `.lua` files in `module/`
2. Restart all instances to re-patch saves:

```powershell
# Via RCON aliases (if configured)
rc11 "/sc game.print('test')"  # Verify connection first

# Or via clusterioctl
docker exec surface-export-controller npx clusterioctl instance stop "clusterio-host-1-instance-1"
docker exec surface-export-controller npx clusterioctl instance start "clusterio-host-1-instance-1"
```

No build step needed for Lua changes.

### Editing JavaScript Plugin Code

Changes to `controller.js`, `instance.js`, `control.js`, etc. require container restarts:

```bash
docker compose restart surface-export-host-1 surface-export-host-2
# Or for controller changes:
docker compose restart surface-export-controller
```

No build step needed — pure JavaScript (not TypeScript).

### Hot Reload Script

Use the workspace task for quick iteration:

```powershell
./tools/patch-and-reset.ps1
```

This script handles stop → start for all instances, re-patching saves with latest Lua code.

## Verifying Plugin is Loaded

### Controller Logs
```bash
docker logs surface-export-controller 2>&1 | grep "surface_export"
```

Look for: `Loaded plugin surface_export`

### Instance Logs
```bash
docker exec surface-export-host-1 tail -50 /clusterio/instances/clusterio-host-1-instance-1/factorio-current.log
```

Look for: `[Surface Export] Clusterio module initialized`

### Remote Interface Check
```powershell
rc11 "/sc rcon.print(remote.interfaces['surface_export'] ~= nil)"
# Should print: true
```

## Testing

### Manual Testing

1. Connect to Factorio instance
2. Create a space platform or use an existing one
3. Run `/list-platforms` to verify detection
4. Run `/export-platform 1` to test export
5. Run `/list-exports` to verify export stored
6. Transfer: `/transfer-platform 1 2` (requires 2+ instances)

### Entity Round-Trip Tests

```powershell
# Run from repo root
./tests/integration/entity-roundtrip/run-tests.ps1
```

### Platform Round-Trip Tests

```powershell
./tests/integration/platform-roundtrip/run-tests.ps1
```

## Troubleshooting

### Plugin Not Loading

**Symptom:** `Loaded plugin surface_export` not in controller logs

**Check:** Verify `package.json` has the `"clusterio-plugin"` keyword and the `external_plugins` volume mount is read-write (not `:ro`).

### Module Not Initializing

**Symptom:** No `[Surface Export] Clusterio module initialized` in Factorio logs

**Check:** Verify `module/module.json` exists with correct `name` and `load` fields. Check for Lua syntax errors in controller logs.

### RCON Command Errors

**Symptom:** Remote interface commands fail with `nil` or `attempt to call nil`

**Check:** Ensure the remote interface name is `"surface_export"` (not `"FactorioSurfaceExport"`). Run:
```lua
/sc for name, _ in pairs(remote.interfaces) do rcon.print(name) end
```

### Transfer Validation Failed

**Common causes:**
1. Different mods on source vs destination
2. Fuel consumed in furnaces during transfer
3. Platform modified during transfer (lock bypassed via RCON)

**Check logs:** Look for `[Transfer Validation Failed]` messages with item count details.
