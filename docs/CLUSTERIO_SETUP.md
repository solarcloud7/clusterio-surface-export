# Clusterio Development Environment Setup

This document describes how to set up and run the Clusterio development cluster for testing the Surface Export plugin.

## Architecture

Hierarchical structure showing Controller → Host → Instance relationship:

```
Controller (clusterio-controller)
  ├─→ Host 1 (clusterio-host-1)
  │     └─→ Instance (clusterio-host-1-instance-1)
  │           Ports: 34197/udp (game), 27015/tcp (RCON)
  └─→ Host 2 (clusterio-host-2)
        └─→ Instance (clusterio-host-2-instance-1)
              Ports: 34198/udp (game), 27016/tcp (RCON)
```

- **1 Controller**: Central management server on `localhost:8080` (HTTP and WebSocket on same port)
- **2 Hosts**: Machines running Clusterio host processes
- **2 Instances**: Factorio servers, one assigned to each host

## Prerequisites

- Docker and Docker Compose installed
- Windows with PowerShell (for RCON automation)

## Quick Start

### 1. Build and Start Cluster

```bash
cd docker
docker-compose -f docker-compose.clusterio.yml build
docker-compose -f docker-compose.clusterio.yml up -d
```

This will:
1. Build controller and host images
2. Start the controller
3. Run initialization (creates instances and host configs)
4. Start both hosts

### 2. Verify Startup

Check controller logs:
```powershell
docker logs clusterio-controller
```

You should see:
- `Starting Clusterio Controller...`
- `Controller started`

Check init logs:
```powershell
docker logs clusterio-init
```

You should see:
- `Cluster Initialization Complete!`
- Created 2 instances and 2 host configs

Check host logs:
```powershell
docker logs clusterio-host-1
docker logs clusterio-host-2
```

You should see:
- `Clusterio Host Startup: clusterio-host-1`
- `Starting Clusterio Host...`
- `Connected to controller`

### 3. Assign Instances to Hosts

Instances must be manually assigned after hosts connect:

```powershell
# Assign instance 1 to host 1
docker exec clusterio-controller npx clusterioctl instance assign clusterio-host-1-instance-1 clusterio-host-1

# Assign instance 2 to host 2
docker exec clusterio-controller npx clusterioctl instance assign clusterio-host-2-instance-1 clusterio-host-2
```

### 4. Start Instances

```powershell
docker exec clusterio-controller npx clusterioctl instance start clusterio-host-1-instance-1
docker exec clusterio-controller npx clusterioctl instance start clusterio-host-2-instance-1
```

### 5. Verify Instances Running

```powershell
docker exec clusterio-controller npx clusterioctl instance list
```

You should see both instances with status `running` and assigned hosts.

## Configuration

### Controller Web UI

Access at: `http://localhost:8080`

Admin token is stored in:
```powershell
docker exec clusterio-controller cat /clusterio/admin-token.txt
```

### Host Configuration

Host configs are automatically created by the init service:
- `/clusterio-host-configs/config-host-1.json`
- `/clusterio-host-configs/config-host-2.json`

These configs include:
- Controller URL: `http://clusterio-controller:8080/`
- Host authentication token (auto-generated)
- Factorio directory: `/opt/factorio`

### Instance Configuration

Instances are pre-configured with:
- RCON password: `Eegh4ohsiethie2`
- Save patching: Enabled
- Factorio version: Latest from factoriotools/factorio image

To modify instance config:
```powershell
docker exec clusterio-controller npx clusterioctl instance config set clusterio-host-1-instance-1 factorio.settings.name "Host 1 Server"
```

## Plugin Development

The Surface Export plugin is mounted into:
- Controller: `/clusterio/plugins/surface_export`
- Hosts: `/clusterio/plugins/surface_export`

After modifying plugin code, restart services:
```powershell
docker-compose -f docker-compose.clusterio.yml restart
```

## Testing Platform Export/Import

### 1. Connect to Instance 1

Use Factorio client to connect to `localhost:34197`

### 2. Export a Platform

Via RCON:
```powershell
rc11 "/export-platform 1"
# Or: docker exec clusterio-controller npx clusterioctl --log-level error instance send-rcon "clusterio-host-1-instance-1" "/export-platform 1"
```

Or via console in-game:
```
/export-platform 1
```

### 3. Verify Export on Controller

Check plugin storage:
```powershell
docker logs clusterio-controller | Select-String "Stored platform export"
```

### 4. Transfer to Instance 2

(Future: Use plugin commands to transfer)

## Troubleshooting

### Controller won't start

Check logs:
```powershell
docker logs clusterio-controller
```

Ensure port 8080 is not in use.

### Hosts can't connect

1. Check controller is running:
   ```powershell
   curl http://localhost:8080/api/version
   ```

2. Check host logs:
   ```powershell
   docker logs clusterio-host-1
   ```

3. Verify host config exists:
   ```powershell
   docker exec clusterio-host-1 cat /clusterio/config-host.json
   ```

### Instances won't start

1. Verify assignment:
   ```powershell
   docker exec clusterio-controller npx clusterioctl instance list
   ```

2. Check host logs:
   ```powershell
   docker logs clusterio-host-1
   ```

3. Verify Factorio mod loaded:
   ```powershell
   docker exec clusterio-host-1 ls /factorio/mods/FactorioSurfaceExport_1.0.0
   ```

### Plugin not loading

1. Check plugin is mounted:
   ```powershell
   docker exec clusterio-controller ls /clusterio/plugins
   ```

2. Check plugin syntax:
   ```powershell
   docker exec clusterio-controller node -c "require('/clusterio/plugins/surface_export/index.js')"
   ```

3. Restart controller:
   ```powershell
   docker-compose -f docker-compose.clusterio.yml restart clusterio-controller
   ```

## Clean Slate

To completely reset:

```powershell
# Stop all services
docker-compose -f docker-compose.clusterio.yml down

# Remove volumes (WARNING: Deletes all data)
docker volume rm clusterio-controller-data clusterio-host-1-data clusterio-host-2-data clusterio-host-configs clusterio-factorio-saves

# Rebuild and restart
docker-compose -f docker-compose.clusterio.yml build --no-cache
docker-compose -f docker-compose.clusterio.yml up -d
```

## Directory Structure

```
docker/
├── Dockerfile.controller           # Controller image
├── Dockerfile.host                # Host image (based on factoriotools/factorio)
├── docker-compose.clusterio.yml   # Orchestration
├── clusterio-init.sh              # Bootstrap script
├── .env                           # Environment configuration
├── .env.template                  # Environment template
├── seed-data/                     # Seed files for instances
│   ├── mods/                      # Initial mod files
│   └── saves/                     # Initial save files
└── clusterio-containers/          # Persistent data (gitignored)
    ├── controller/                # Controller data
    └── hosts/                     # Host data

src/surface_export_plugin/         # Clusterio plugin (mounted into containers)
├── index.js                       # Plugin declaration
├── controller.js                  # Controller plugin
└── instance.js                    # Instance plugin (runs on hosts)

src/                               # Factorio mod (FactorioSurfaceExport)
├── control.lua
├── info.json
└── scripts/
    ├── serializer.lua
    ├── deserializer.lua
    └── ...
```

## References

- [Clusterio Official Docs](https://github.com/clusterio/clusterio/tree/master/docs)
- [Managing a Cluster](https://github.com/clusterio/clusterio/blob/master/docs/managing-a-cluster.md)
- [Writing Plugins](https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md)
- [Configuration System](https://github.com/clusterio/clusterio/blob/master/docs/configuration.md)
