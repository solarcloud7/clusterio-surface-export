# Clusterio Surface Export

A Clusterio plugin and Factorio mod that serializes complete Space Age platform state for cluster-wide platform transfer. Captures every entity, item, fluid, and tile on a platform with full verification.

## Table of Contents

1. [Features](#features)
2. [Performance](#performance)
3. [Installation](#installation)
4. [Usage](#usage)
   - [Transfer a Platform](#transfer-a-platform)
   - [Export a Platform](#export-a-platform)
   - [Import a Platform](#import-a-platform)
5. [How It Works](#how-it-works)
   - [Export Pipeline](#export-pipeline)
   - [Import Pipeline](#import-pipeline)
   - [Atomic Belt Scan](#atomic-belt-scan)
   - [Verification](#verification)
6. [Data Format](#data-format)
7. [Development](#development)
   - [Docker Workflow](#docker-workflow)
   - [Hot Reload](#hot-reload)
   - [Integration Tests](#integration-tests)
   - [Transaction Logs](#transaction-logs)
   - [Project Structure](#project-structure)
8. [Troubleshooting](#troubleshooting)
9. [Contributing](#contributing)
10. [License](#license)

---

## Features

- **Complete Platform Serialization**: Every entity, tile, inventory, fluid, belt item, circuit connection, and control behavior
- **Async Processing**: Export/import across multiple ticks — zero game freezing on any platform size
- **Atomic Belt Scan**: Belt item positions captured in a single tick for consistent snapshots (belts can't be deactivated in Factorio)
- **Platform Locking**: Cargo pods completed, entities frozen, surface hidden during export for stable state
- **Platform Pause**: Destination platform paused during import to prevent fuel consumption
- **Transfer Validation**: Post-import item/fluid count verification with automatic rollback on failure
- **Deferred Activation**: Entities stay deactivated through validation — machines never process resources during transfer
- **Clusterio Integration**: Full plugin with controller storage, chunked RCON transport, and inter-instance transfer
- **Transaction Logging**: Every transfer recorded with phase timing, entity breakdowns, per-item verification
- **Integration Tests**: Automated platform-roundtrip (4 tests) and entity-roundtrip (28 tests) suites
- **Factorio 2.0 / Space Age**: Handles quality, stacked belt items, fusion, cargo bays, and all read-only API changes

## Performance

**Platform transfer (1359 entities, 4350 tiles, 5600+ items):** ~1-2 seconds end-to-end

| Phase | Typical Time |
|-------|-------------|
| Export (async, 50 entities/tick) | ~450ms |
| Transmission (compressed, ~55KB) | ~110ms |
| Import (entity creation + restoration) | ~450ms |
| Validation | <1ms |
| **Total transfer** | **~1s** |

The async processor handles 50 entities per tick (configurable), so even platforms with thousands of entities process without any game lag.

## Installation

### For Clusterio Clusters (Recommended)

This project is designed for Clusterio 2.0 clusters. It uses pre-built Docker images from [solarcloud7/clusterio-docker](https://github.com/solarcloud7/clusterio-docker).

**Prerequisites**:
- Docker Desktop
- Factorio Space Age DLC

**Setup** (see [docker/README.md](docker/README.md) for detailed instructions):

1. Clone this repository
2. Copy `.env.example` to `.env` and set `INIT_CLUSTERIO_ADMIN`
3. Place save files in `docker/seed-data/hosts/<hostname>/<instance>/` directories
4. Run `docker compose up -d`

The plugin is bind-mounted from `seed-data/external_plugins/surface_export/` and auto-installed.

### For Development

**Quick Commands**:

```powershell
# Pull pre-built images and start the cluster
docker compose pull
docker compose up -d

# View logs
docker logs -f surface-export-controller
docker logs -f surface-export-host-1

# Stop the cluster
docker compose down

# Clean restart (wipe all data)
docker compose down -v
docker compose up -d
```

**Hot Reload** (after mod changes):

Use the VS Code task "Patch and Reset (Hot Reload)" or run:

```powershell
.\tools\patch-and-reset.ps1
```

This patches the running instances without a full rebuild (~30 seconds vs 3 minutes).

**Development Files**:
- **Clusterio Plugin**: `docker/seed-data/external_plugins/surface_export/` (Node.js code)
- **Factorio Mod**: `docker/seed-data/external_plugins/surface_export/module/` (Lua code)
- **Save Files**: `docker/seed-data/hosts/<hostname>/<instance>/` (per-instance `.zip` saves)
- **Mods**: `docker/seed-data/mods/` (additional Factorio mods as `.zip` files)
- **Database Seeds**: `docker/seed-data/controller/database/` (users, roles)

## Usage

### Transfer a Platform

Transfer a platform between instances in a single command:
```
/transfer-platform <platform_index_or_name> <target_instance>
```

This performs the full pipeline: lock → export → transmit → import → validate → activate → unlock. Progress messages appear throughout. See [docs/TRANSFER_WORKFLOW_GUIDE.md](docs/TRANSFER_WORKFLOW_GUIDE.md) for the detailed phase breakdown.

### Export a Platform

```
/export-platform <platform_index_or_name>
```

Exports are processed asynchronously (50 entities/tick by default). Exported data is stored on the controller and available to all instances.

### Import a Platform

```
/import-platform <export_name>
```

Creates a new platform and restores all entities, tiles, inventories, and belt items. Use `/list-exports` to see available exports.

See [docs/commands-reference.md](docs/commands-reference.md) for all 15 available commands.

## How It Works

### Export Pipeline

1. **Lock Platform** — Complete any in-flight cargo pods, freeze entities, hide the surface from players
2. **Async Entity Scan** — Process 50 entities/tick: serialize position, settings, inventories, circuit connections (belt items are deferred)
3. **Tile Scan** — Capture all platform tiles in a single tick
4. **Atomic Belt Scan** — Scan all belt item positions in a single tick for a consistent snapshot
5. **Verification Snapshot** — Count all items/fluids from the serialized data
6. **Compress & Transmit** — Deflate-compress the JSON, send via chunked RCON to the controller

### Import Pipeline

1. **Create Platform** — Build a new platform with floor tiles
2. **Entity Creation** — Place entities in dependency order (inserters last), deactivated
3. **Inventory Restoration** — Fill all inventories, set recipes, configure behaviors
4. **Belt Item Restoration** — Re-insert items onto belts at correct positions
5. **Circuit Wiring** — Reconnect all circuit network connections
6. **Pause Platform** — Keep platform paused to prevent fuel consumption during validation
7. **Validation** — Compare post-import item/fluid counts against export verification data
8. **Activation** — Activate all entities, unpause platform — transfer complete

### Atomic Belt Scan

Transport belts move items continuously and cannot be paused in Factorio. During async export (which spans many ticks), items would shift positions between scan batches, causing duplication or loss in the snapshot.

The solution: during entity scanning, belt item extraction is **skipped**. After all entities are serialized, a dedicated pass scans every belt entity's items in a **single game tick**, then patches the serialized data. This guarantees a point-in-time consistent snapshot of all belt contents.

### Verification

After import, the system counts every item and fluid across all entities and compares against the export snapshot:
- Each item type tracked separately (with quality level)
- Each fluid type tracked separately (with temperature)
- Discrepancies reported in-game with exact counts
- Automatic rollback on validation failure

## Data Format

Export data is **deflate-compressed** by default (70-90% size reduction). The outer envelope:

```json
{
  "compressed": true,
  "compression": "deflate",
  "payload": "<base64-encoded compressed JSON>",
  "platform_name": "Platform Alpha",
  "tick": 1735259234,
  "timestamp": 1737896234000,
  "stats": {
    "entities": 1359,
    "items": 5618,
    "fluids": 8,
    "tiles": 4350,
    "size_bytes": 55000
  },
  "verification": {
    "item_counts": { "iron-plate": 500, "copper-plate": 300 },
    "fluid_counts": { "water": 50000 }
  }
}
```

The `verification` block stays uncompressed at the top level so the destination instance can validate counts without decompressing the full payload.

## Development

### Docker Workflow

```powershell
docker compose pull              # Pull pre-built images
docker compose up -d             # Start cluster
docker compose down              # Stop cluster
docker compose down -v && docker compose up -d   # Clean restart
```

### Hot Reload

After modifying plugin or mod code:
```powershell
.\tools\patch-and-reset.ps1
```
Patches running instances without a full rebuild (~30 seconds vs 3 minutes).

### Integration Tests

Two test suites verify platform transfer correctness:

```powershell
# Platform roundtrip: export → transfer → import → verify (4 tests)
.\tests\integration\platform-roundtrip\run-tests.ps1

# Entity roundtrip: per-entity-type verification (28 tests)
.\tests\integration\entity-roundtrip\run-tests.ps1
```

Tests run against the Docker cluster and verify item counts, entity positions, and data integrity.

### Transaction Logs

Every transfer is logged with phase timing and per-item breakdowns:

```powershell
.\tools\list-transaction-logs.ps1      # List all transfers
.\tools\get-transaction-log.ps1        # Show latest transfer details
```

Or use VS Code tasks: "List Transaction Logs", "Get Latest Transaction Log".

### Project Structure

```
clusterio-surface-export/
├── docker/
│   ├── seed-data/
│   │   ├── controller/
│   │   │   └── database/                 # Pre-seeded users.json, roles.json
│   │   ├── external_plugins/
│   │   │   └── surface_export/           # Clusterio Plugin + Mod
│   │   │       ├── index.js              # Plugin entry point
│   │   │       ├── controller.js         # Controller-side logic
│   │   │       ├── instance.js           # Instance-side logic
│   │   │       ├── messages.js           # Plugin message definitions
│   │   │       ├── helpers.js            # Utility functions
│   │   │       ├── package.json          # Node.js dependencies
│   │   │       └── module/               # Factorio Mod (Lua)
│   │   │           ├── control.lua       # Mod entry point
│   │   │           ├── module.json       # Module metadata
│   │   │           ├── core/             # Core export/import logic
│   │   │           ├── export_scanners/  # Entity scanning
│   │   │           ├── import_phases/    # Import phases
│   │   │           ├── interfaces/       # Remote interfaces
│   │   │           ├── utils/            # Utilities
│   │   │           └── validators/       # Validation logic
│   │   ├── hosts/                        # Seed instances (folder convention)
│   │   │   ├── clusterio-host-1/
│   │   │   │   └── clusterio-host-1-instance-1/
│   │   │   │       └── test.zip          # Save file for instance 1
│   │   │   └── clusterio-host-2/
│   │   │       └── clusterio-host-2-instance-1/
│   │   │           └── MinSeed.zip       # Save file for instance 2
│   │   ├── saves/                        # Legacy save storage
│   │   └── mods/                         # Additional Factorio mods (.zip)

│   └── README.md                         # Docker setup docs
├── docker-compose.yml                    # Cluster definition (uses GHCR images)
├── tools/                                # PowerShell helper scripts
├── tests/                                # Integration tests
├── docs/                                 # Documentation
└── README.md                             # This file
```

## Troubleshooting

### Import shows item count warnings
Item count discrepancies of ~5-6% are expected due to items in non-scannable locations (e.g., items consumed during the final tick before locking). Large discrepancies may indicate a mod version mismatch between instances.

### Docker containers won't start
- Ensure Docker Desktop is running
- Check port availability (8080, 34100-34109, 34200-34209)
- Review logs: `docker compose logs`
- Ensure GHCR images are accessible: `docker pull ghcr.io/solarcloud7/clusterio-docker-controller`

### Server doesn't tick (headless)
Set `auto_pause: false` in server settings. Headless servers with no connected players will pause by default, blocking async processing.

## Contributing

Contributions are welcome! Please:

1. Follow Factorio Lua style guidelines
2. Add tests for new features
3. Update documentation

## License

MIT License - See [LICENSE.md](LICENSE.md) for details.

Built for [Clusterio 2.0](https://github.com/clusterio/clusterio) with Factorio 2.0 Space Age.
