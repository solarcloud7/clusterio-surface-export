# Factorio Surface Export - Clusterio Integration

A Clusterio plugin and Factorio mod that serializes complete Space Age platform state for cluster-wide platform transfer. Captures every entity, item, fluid, **and tile** on a platform with **zero loss or duplication**.

## Table of Contents

1. [Features](#features)
2. [Performance](#performance)
3. [Installation](#installation)
   - [For Clusterio Clusters (Recommended)](#for-clusterio-clusters-recommended)
   - [For Development](#for-development)
4. [Usage](#usage)
   - [Export a Platform](#export-a-platform)
   - [Import a Platform](#import-a-platform)
   - [Clusterio Integration](#clusterio-integration)
5. [Data Format](#data-format)
6. [What Gets Exported](#what-gets-exported)
   - [Entities](#entities)
   - [Items](#items)
   - [Fluids](#fluids)
   - [Entity Settings](#entity-settings)
7. [Verification](#verification)
8. [Development](#development)
   - [Docker Workflow](#docker-workflow)
   - [VS Code Tasks](#vs-code-tasks)
   - [PowerShell Shortcuts for Clusterio](#powershell-shortcuts-for-clusterio)
   - [Project Structure](#project-structure)
9. [Troubleshooting](#troubleshooting)
10. [Contributing](#contributing)
11. [License](#license)
12. [Credits](#credits)
13. [Support](#support)
14. [Version History](#version-history)
15. [Useful Commands](#useful-commands)

---

## Features

- **Complete Platform Serialization**: Export all entities with positions, settings, inventories, fluids, and tiles
- **Tile Support**: Export and import platform floor tiles (concrete, refined concrete, etc.)
- **Async Import/Export**: Background processing prevents game freezing on large platforms
- **Zero Item Loss**: Count every item in every location - inventories, belts, inserters, machines, on ground
- **Mod Content Handling**: Gracefully skip unknown items/entities when importing across different mod sets
- **Verification System**: Checksum verification ensures data integrity
- **Restore Capability**: Import serialized data to recreate platforms on different Factorio instances
- **Clusterio Integration**: Full Clusterio 2.0 plugin with controller storage and inter-instance transfer
- **JSON Format**: Human-readable output for debugging and compatibility
- **Factorio 2.0 Compatible**: Handles read-only properties and runtime API changes

## Performance

**Small platforms (<8KB):** ~1-2 seconds  
**Large platforms (235KB, 488 entities):** ~40 seconds

The bottleneck is RCON round-trip time for chunked data transfer. See [docs/IMPORT_PERFORMANCE.md](docs/IMPORT_PERFORMANCE.md) for detailed analysis.

## Installation

### For Clusterio Clusters (Recommended)

This project is designed for Clusterio 2.0 clusters. It uses pre-built Docker images from [solarcloud7/clusterio-docker](https://github.com/solarcloud7/clusterio-docker).

**Prerequisites**:
- Docker Desktop
- Factorio Space Age DLC

**Setup** (see [docker/README.md](docker/README.md) for detailed instructions):

1. Clone this repository
2. Copy `docker/env/controller.env.example` to `docker/env/controller.env` and set `INIT_CLUSTERIO_ADMIN`
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

### Export a Platform

In-game command:
```
/export-platform <platform_index_or_name>
```

Examples:
```
/export-platform 1              # Export by index
/export-platform "Alpha"        # Export by name
```

The export is processed asynchronously (default: 50 entities per tick) to prevent game lag. Progress messages appear every 10 batches.

**Via RCON** (from outside Factorio):
```powershell
# Using PowerShell shortcuts (see below)
rc11 "/export-platform 1"

# Using clusterioctl directly
docker exec surface-export-controller npx clusterioctl instance rcon clusterio-host-1-instance-1 "/export-platform 1"
```

Exported platforms are stored in the controller's storage and available to all instances in the cluster.

### Import a Platform

In-game command:
```
/import-platform <export_name>
```

Examples:
```
/import-platform platform_Alpha_12345    # Import by name (without .json)
/list-exports                             # List available exports
```

The import creates a new platform and processes asynchronously (default: 50 entities per tick).

**Via RCON**:
```powershell
# List available exports first
rc21 "/list-exports"

# Import to instance 2
rc21 "/import-platform platform_Alpha_12345"
```

### Clusterio Integration

The plugin automatically handles platform transfer between instances:

**Plugin Files**:
- **Location**: `docker/seed-data/external_plugins/surface_export/`
- **Plugin Code**: `index.js`, `controller.js`, `instance.js`, `messages.js`
- **Mod Code**: `module/` directory (Lua files)

**Remote Interface** (called by plugin):

```javascript
// Queue async export (returns job_id)
const result = await this.sendRcon(
  `/sc rcon.print(remote.call("surface_export", "export_platform", 1, "player"))`
);
const job_id = result.trim();

// Retrieve export data after completion (via getExportData)
const exportData = await this.getExportData(job_id);
```

**Storage**:
- Exports are stored in controller: `/clusterio/platforms/`
- Accessible via plugin API: `info.clusterio_plugin.controller.platformStorage`

## Data Format

Exported data is **compressed by default** using deflate compression with base64 encoding to reduce transfer size and storage requirements.

**Compressed Format** (default):
```json
{
  "compressed": true,
  "compression": "deflate",
  "payload": "<base64-encoded compressed JSON>",
  "platform_name": "Platform Alpha",
  "tick": 1735259234,
  "timestamp": 1737896234000,
  "stats": {
    "entities": 1234,
    "items": 56789,
    "size_bytes": 235678
  },
  "verification": {
    "item_counts": { "iron-plate": 5000, ... },
    "fluid_counts": { "water": 50000, ... }
  }
}
```

**Uncompressed JSON Structure** (after decompression):
```json
{
  "schema_version": "1.0.0",
  "factorio_version": "2.0.12",
  "export_timestamp": 1735259234,
  "platform": {
    "name": "Platform Alpha",
    "index": 1,
    "surface_index": 5
  },
  "metadata": {
    "total_entity_count": 1234,
    "total_item_count": 56789
  },
  "entities": [ /* array of entity objects */ ],
  "verification": {
    "item_counts": { "iron-plate": 5000, ... },
    "fluid_counts": { "water": 50000, ... }
  }
}
```

**Compression Benefits**:
- **Typical reduction**: 70-90% size reduction
- **Faster transfers**: Less RCON data to transmit
- **Storage efficiency**: Smaller files on controller
- **Automatic**: Compression/decompression handled transparently

**Note**: The `verification` field remains uncompressed at the top level to allow transfer validation without decompression.

## Verification

The mod includes comprehensive verification to ensure zero item loss:

1. **Pre-export counting**: All items and fluids are counted and stored in `verification.item_counts` and `verification.fluid_counts`
2. **Post-import verification**: After import, all items and fluids are recounted and compared against expected values
3. **Detailed comparison**: Each item type (with quality level) and fluid type (with temperature) is individually verified
4. **Warning messages**: Any discrepancies are reported in-game with exact item names and count differences
5. **Quality-aware**: Tracks items with different quality levels separately to prevent quality loss

**How it works**:
- Export scans every entity: inventories, belts, inserters, items on ground, fluids in tanks/pipes
- Creates a complete manifest of what should exist
- Import recreates entities and then rescans to verify nothing was lost
- Comparison is done item-by-item, not with a simple hash

## Development

### Docker Workflow

```powershell
# Pull pre-built images
docker compose pull

# Start cluster
docker compose up -d

# View logs
docker logs -f surface-export-controller    # Controller logs
docker logs -f surface-export-host-1        # Host 1 logs

# Restart after config changes
docker compose restart

# Stop cluster
docker compose down

# Clean restart (wipe all data)
docker compose down -v
docker compose up -d

# Hot reload (fast, no rebuild)
.\tools\patch-and-reset.ps1
```

### VS Code Tasks

The workspace includes helpful tasks for common operations. Access them via:
- **Command Palette**: `Ctrl+Shift+P` → "Tasks: Run Task"
- **Terminal Menu**: Terminal → Run Task...
- **Keyboard**: `Ctrl+Shift+B` for build tasks

**Available Tasks**:

| Task | Description | Group |
|------|-------------|-------|
| **Deploy: Increment Version & Rebuild Cluster** | Full deployment: increment mod version, rebuild images, restart cluster | Build |
| **Cluster: Show Status** | Display status of all instances and hosts | - |
| **Cluster: Display Logs** | Show recent logs from all Clusterio containers | - |
| **Docker: Build Base Image** | Rebuild base image with Factorio + Clusterio + mods | Build |
| **Docker: Get Admin Token** | Retrieve admin authentication token for Clusterio | - |
| **Clusterio: Start All Instances** | Start all Factorio server instances | - |
| **Clusterio: Stop All Instances** | Stop all Factorio server instances | - |
| **List Transaction Logs** | List all platform export/import transaction logs | - |
| **Get Latest Transaction Log** | Display the most recent transaction log | - |
| **Get Transaction Log (Specific)** | Retrieve a specific transaction log by ID (prompts for ID) | - |
| **Patch and Reset (Hot Reload)** | Hot-reload mod changes without full rebuild | - |

**Quick Actions**:
```
Ctrl+Shift+B  → Shows build tasks (Deploy, Build Base Image)
Ctrl+Shift+P  → "Tasks: Run Task" → Select any task
```

**Example Workflows**:

1. **After Code Changes**: Run "Patch and Reset (Hot Reload)" for quick testing
2. **Full Deployment**: Run "Deploy: Increment Version & Rebuild Cluster"
3. **Debugging**: Run "Get Latest Transaction Log" to see export/import details
4. **Troubleshooting**: Run "Cluster: Display Logs" to check for errors


**Note:** Run `Initialize-RcShortcuts` in any new PowerShell session to regenerate shortcuts based on current cluster configuration.

### Project Structure

```
FactorioSurfaceExport/
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
│   ├── env/                              # Environment config
│   │   ├── controller.env                # Controller settings (not in git)
│   │   └── host.env                      # Host settings (not in git)
│   └── README.md                         # Docker setup docs
├── docker-compose.yml                    # Cluster definition (uses GHCR images)
├── tools/                                # PowerShell helper scripts
├── tests/                                # Integration tests
├── docs/                                 # Documentation
└── README.md                             # This file
```

## Troubleshooting

### Import shows item count warnings
- This may indicate a mod version mismatch
- Ensure the same mods are installed on both servers

### Docker containers won't start
- Ensure Docker Desktop is running
- Check that ports are available (8080, 34100-34109, 34200-34209)
- Review logs: `docker compose logs`
- Check `env/controller.env` configuration
- Ensure GHCR images are accessible: `docker pull ghcr.io/solarcloud7/clusterio-docker-controller`



## Contributing

Contributions are welcome! Please:

1. Follow Factorio Lua style guidelines
2. Add tests for new features
3. Update documentation
4. Ensure zero item loss guarantee is maintained

## License

MIT License - See LICENSE.md for details

## Credits

- Built for [Clusterio 2.0](https://github.com/clusterio/clusterio) 
- Uses Factorio 2.0 Space Age platform API

## Version History

See changelog.txt for detailed version history.


## Useful Commands
### Get all mods versions:
/c for name, version in pairs(script.active_mods) do game.print(name .. ": " .. version) end

### Get surface_export version
/c game.print(script.active_mods["surface_export"])
