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
├── index.ts              # Plugin definition (config fields, messages, permissions)
├── controller.ts         # Controller logic (storage, transfer orchestration)
├── instance.ts           # Instance logic (RCON bridge, chunking, send_json event handlers)
├── control.ts            # CLI commands (surface-export list/transfer)
├── helpers.ts            # Chunked JSON, hybrid Lua escaping
├── messages.ts           # 11 message type definitions with JSON schemas
├── package.json          # Plugin metadata
├── tsconfig.node.json    # TypeScript configuration for Node.js runtime
├── webpack.config.js     # Web UI build configuration
├── dist/                 # Build output (gitignored, generated on deploy)
│   ├── node/             # Node.js runtime artifacts (.js, .d.ts, .map)
│   │   ├── index.js      # Built entrypoint
│   │   ├── controller.js # Built controller
│   │   ├── instance.js   # Built instance
│   │   ├── control.js    # Built CLI
│   │   └── lib/          # Built library modules
│   └── web/              # Web UI bundle (React + Webpack Module Federation)
├── lib/                  # TypeScript source modules
│   ├── platform-tree.ts          # Tree building + instance resolution
│   ├── transaction-logger.ts     # Event logging, phase timing, persistence
│   ├── subscription-manager.ts   # WebSocket subscriptions + broadcasting
│   └── transfer-orchestrator.ts  # Transfer lifecycle state machine
├── web/                  # React web UI source
│   ├── index.jsx         # WebPlugin class, page wrapper, hooks
│   ├── ManualTransferTab.jsx     # Platform tree + export/import UI
│   ├── ExportsTab.jsx            # Stored export list + workflows
│   ├── TransactionLogsTab.jsx    # Log viewer + validation display
│   ├── utils.js          # Pure formatting functions
│   └── style.css
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

### Build Architecture

The plugin uses **TypeScript with clean source tree architecture**:

- **Source**: TypeScript files (`.ts`) in plugin root and `lib/`, React components in `web/`
- **Build output**: Compiled JavaScript in `dist/node/` (Node runtime) and `dist/web/` (browser bundle)
- **Entrypoints**: `package.json` points `main` to `dist/node/index.js`, plugin entrypoint paths reference `dist/node/*`
- **Git**: Only source (`.ts`) is tracked; `dist/` is gitignored and rebuilt on deploy

This keeps the source tree clean — no generated `.js`, `.d.ts`, or `.map` files mixed with source code.

## Development Workflow

### Starting the Cluster

```bash
# One-time: create external volume for Factorio game client
docker volume create factorio-client

# From repo root
docker compose up -d
```

**Factorio Game Client**: Host-1 mounts the `factorio-client` external volume at `/opt/factorio-client`. If `FACTORIO_USERNAME` and `FACTORIO_TOKEN` are set in `.env` and the volume is empty, the client is downloaded automatically on first startup (~4 GB, expansion build with Space Age). Host-2 has `SKIP_CLIENT=true` — it doesn't need the client.

The game client is required for Clusterio's export-data flow (icon/graphics spritesheets). The headless server is sufficient for running game instances.

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

### Editing TypeScript Plugin Code

The plugin uses TypeScript for type safety. Changes to `.ts` files require a rebuild:

```powershell
# From plugin directory
cd docker/seed-data/external_plugins/surface_export
npm run build  # Builds both dist/node/ (Node.js) and dist/web/ (browser bundle)

# Or build individually
npm run build:node  # TypeScript compilation only
npm run build:web   # Webpack web UI bundle only
```

Then restart containers to pick up the cha on **Lua code only**:

```powershell
./tools/patch-and-reset.ps1
```

This script handles stop → start for all instances, re-patching saves with latest Lua code. **Note**: This only hot-reloads Lua — TypeScript changes require a full deploy.

### Development Iteration Patterns

**For Lua changes** (fastest):
1. Edit files in `module/`
2. Run `.\tools\patch-and-reset.ps1`
3. Test in-game

**For TypeScript changes** (requires rebuild):
1. Edit `.ts` files in plugin root or `lib/`
2. Run `npm run build:node` in plugin directory
3. Run `docker compose restart` to pick up built files
4. Test via RCON or web UI

**For web UI changes**:
1. Edit React files in `web/`
2. Run `npm run build:web` in plugin directory
3. Hard-refresh browser (Ctrl+Shift+R) to reload bundle
4. Test in controller web UI

**For full deployment** (cleanest):
1. Make all changes
2. Run `.\tools\deploy-cluster.ps1 -SkipIncrement`
3. Test end-to-end

**Best practice**: Use the full deployment script which handles version bump, build, and restart:

```powershell
.\tools\deploy-cluster.ps1           # Increment version + full rebuild
.\tools\deploy-cluster.ps1 -SkipIncrement  # Rebuild without version bump
```

The deploy script automatically runs `npm run build` to regenerate `dist/node/` and `dist/web/` before Docker startup.

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

**Check:** Ensure the remote interface name is `"surface_export"` (not `"clusterio-surface-export"`). Run:
```lua
/sc for name, _ in pairs(remote.interfaces) do rcon.print(name) end
```

### Transfer Validation Failed

**Common causes:**
1. Different mods on source vs destination
2. Fuel consumed in furnaces during transfer
3. Platform modified during transfer (lock bypassed via RCON)

**Check logs:** Look for `[Transfer Validation Failed]` messages with item count details.
