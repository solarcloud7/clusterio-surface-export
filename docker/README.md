# Clusterio Docker Setup

This directory contains Docker Compose configuration for running a Clusterio development cluster with the Surface Export plugin. It uses pre-built base images from [solarcloud7/clusterio-docker](https://github.com/solarcloud7/clusterio-docker).

## Architecture

- **1 Controller**: Central management server (Web UI at port 8080)
- **2 Hosts**: Run Factorio instances (clusterio-host-1, clusterio-host-2)
- **2 Instances**: Automatically created from seed-data convention
- **No init container**: The controller image handles all bootstrapping internally

## Quick Start

### 1. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and set `INIT_CLUSTERIO_ADMIN` to your Factorio username.

### 2. Add Seed Data (Optional)

Place save files, mods, and database seeds following the convention:

```
seed-data/
├── controller/
│   └── database/              # users.json, roles.json (pre-populate on first run)
├── mods/                      # Factorio mod .zip files (uploaded to controller)
├── external_plugins/
│   └── surface_export/        # Plugin source (mounted into containers)
└── hosts/
    ├── clusterio-host-1/
    │   └── clusterio-host-1-instance-1/
    │       ├── config.json    # { "auto_start": true }
    │       └── test.zip       # Save file
    └── clusterio-host-2/
        └── clusterio-host-2-instance-1/
            ├── config.json
            └── MinSeed.zip
```

### 3. Deploy

```powershell
# Full deployment (increments plugin version, pulls images, starts cluster)
./tools/deploy-cluster.ps1

# Without version bump
./tools/deploy-cluster.ps1 -SkipIncrement

# Keep existing data volumes
./tools/deploy-cluster.ps1 -SkipIncrement -KeepData
```

Or manually:

```bash
docker compose pull
docker compose up -d
```

### 4. Get Admin Token

```bash
docker exec surface-export-controller cat /clusterio/tokens/config-control.json
```

### 5. Access Web UI

Open http://localhost:8080 and paste the admin token.

## How It Works

The pre-built images from `ghcr.io/solarcloud7/clusterio-docker-*` handle all bootstrapping:

1. **Controller starts**: Creates admin user, generates host tokens to shared volume
2. **Database seeding**: Copies `seed-data/controller/database/*.json` before first start
3. **Mod seeding**: Uploads `seed-data/mods/*.zip` to controller on first run
4. **Instance seeding**: Creates instances from `seed-data/hosts/<hostname>/<instance>/` folders
5. **Hosts start**: Read tokens from shared volume, connect to controller
6. **Plugin loading**: `surface_export` plugin is mounted and auto-installed via `external_plugins/`

See [solarcloud7/clusterio-docker seed-data docs](https://github.com/solarcloud7/clusterio-docker/blob/main/docs/seed-data.md) for full documentation on the seeding convention.

## Directory Structure

```
docker/
└── seed-data/                     # All seed data (mounted read-only)
    ├── controller/
    │   └── database/              # users.json, roles.json
    ├── mods/                      # Additional mod .zip files
    ├── external_plugins/
    │   └── surface_export/        # Plugin source code + Lua module
    └── hosts/
        ├── clusterio-host-1/
        │   └── <instance-name>/   # Instance folders with saves
        └── clusterio-host-2/
            └── <instance-name>/
```

Runtime data is stored in Docker volumes (not bind-mounted directories):
- `controller-data` — Controller config, database, mods, logs
- `host-1-data` / `host-2-data` — Host config, instances, saves
- `shared-tokens` — Host authentication tokens

## Environment Variables

### Controller

| Variable | Default | Description |
|----------|---------|-------------|
| `INIT_CLUSTERIO_ADMIN` | *(required)* | Admin username for first run |
| `CONTROLLER_HTTP_PORT` | `8080` | Web UI / API port |
| `HOST_COUNT` | `2` (via compose) | Number of host tokens to generate |
| `DEFAULT_MOD_PACK` | `Base Game 2.0` | Default mod pack name |

### Host

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTROLLER_URL` | `http://clusterio-controller:8080/` | Controller URL |
| `FACTORIO_HEADLESS_TAG` | `stable` | Factorio version |

## Plugin Development

The `surface_export` plugin is bind-mounted from `seed-data/external_plugins/surface_export/` into both controller and host containers:

- **JS/TS changes**: Edit plugin files → auto-installed on container restart
- **Lua module changes**: Edit `module/` directory → restart instances to re-patch saves

## Useful Commands

```bash
# View logs
docker compose logs -f

# Check cluster status
docker exec surface-export-controller npx clusterioctl instance list
docker exec surface-export-controller npx clusterioctl host list

# Stop cluster
docker compose down

# Clean restart (wipe all data)
docker compose down -v
docker compose up -d

# Get admin token
docker exec surface-export-controller cat /clusterio/tokens/config-control.json
```

## Differences from Previous Setup

This setup was refactored to use [solarcloud7/clusterio-docker](https://github.com/solarcloud7/clusterio-docker) base images:

| Before | After |
|--------|-------|
| 3 custom Dockerfiles (base, controller, host) | Pre-built `ghcr.io/solarcloud7/clusterio-docker-*` images |
| Separate `clusterio-init` container (700+ line script) | Controller handles all bootstrapping |
| Bind-mounted `clusterio-containers/` directories | Docker volumes |
| Single `.env` file with many variables | Single `.env` at project root |
| Manual port/RCON configuration per instance | Port ranges per host |
| Custom entrypoint scripts | Built into base images |
