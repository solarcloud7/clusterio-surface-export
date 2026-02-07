# Clusterio Docker Setup

This directory contains Docker configuration for running a Clusterio development cluster with platform export/import capabilities.

## Architecture

- **1 Controller**: Central management server (port 8080/4533)
- **2 Hosts**: Run Factorio instances (clusterio-host-1, clusterio-host-2)
- **2 Instances**: Factorio servers assigned to hosts
- **Init Service**: One-time bootstrap to configure the cluster

## Quick Start

### 1. Configuration

Copy the environment template and customize it:

```bash
cp .env.template .env
```

Edit `.env` and set:
- `RCON_PASSWORD`: Strong password for RCON access
- `FACTORIO_ADMINS`: Comma-separated usernames that should get admin rights automatically
- Port configurations (defaults should work for most setups)

### 2. Build the Shared Base Image

The controller and host images now inherit from a common base that already contains:
- Factorio headless server files (Space Age, Quality, and Elevated Rails assets ship with the game)
- Node.js 20 plus the shared `@clusterio/*` packages
- Everything under `docker/seed-data/` (mods, saves, config templates, helper scripts)
- The Surface Export Factorio mod and Clusterio plugin

Build it once (or when you change `docker/Dockerfile.base`):

```bash
docker build -t factorio-surface-export/base:latest -f docker/Dockerfile.base .
```

In VS Code you can run the **Docker: Build Base Image** task (from the `FactorioSurfaceExport.code-workspace`) instead of typing the command manually.

### 3. Build and Start

```bash
# Build all images
docker-compose -f docker-compose.clusterio.yml build

# Start the cluster
docker-compose -f docker-compose.clusterio.yml up -d
```

The init service will automatically:
- Create instances
- Configure ports and RCON
- Generate host configurations
- Add the Clusterio core plugins (global chat, inventory sync, player auth, research sync, statistics exporter, subspace storage) plus the surface export plugin
- Create a default mod pack
- **Assign instances to hosts** (new!)
- **Display admin token** for web UI login (new!)

Mods and plugins are baked into the base image during build:
- The Surface Export mod archive lives in `/opt/seed-mods/FactorioSurfaceExport_<version>.zip` and is auto-added to the default mod pack.
- Drop any `.zip` into `docker/seed-data/mods/` and rebuild the base image; the next controller bootstrap uploads/enables them automatically.
- Clusterio core plugins (`@clusterio/plugin-global_chat`, `inventory_sync`, `player_auth`, `research_sync`, `statistics_exporter`, `subspace_storage`) plus the Surface Export plugin are preinstalled under `/opt/seed-plugins/`.

**Note**: The init script logs will contain your admin token. You can also retrieve it anytime with:
```bash
docker exec clusterio-controller cat /clusterio/config-control.json | grep token
```

### 3. Configure Factorio Credentials (Optional)

If you want to download mods from the Factorio mod portal:

1. Get your token from https://factorio.com/profile
2. Edit `.env` and set:
   ```
   FACTORIO_USERNAME=your_username
   FACTORIO_TOKEN=your_token
   ```
3. Restart controller: `docker-compose -f docker-compose.clusterio.yml restart clusterio-controller`

### 4. Get Admin Token

The init script outputs the admin token in its logs. To retrieve it:

```bash
# View init script logs (token will be displayed at the end)
docker logs clusterio-init

# Or extract directly from config
docker exec clusterio-controller cat /clusterio/config-control.json | grep token
```

### 5. Review the Auto-Populated Mod Pack

`my-server-pack` already includes the development mod plus every archive you place in `docker/seed-data/mods/`. Use the web UI at http://localhost:8080 to confirm the list or to add/remove additional mods from `/opt/seed-mods/` manually.

### 6. Start Factorio Instances

Instances are already assigned to hosts automatically! Just start them:

```bash
docker exec clusterio-controller npx clusterioctl instance start clusterio-host-1-instance-1
docker exec clusterio-controller npx clusterioctl instance start clusterio-host-2-instance-1
```

## Directory Structure

```
docker/
├── .env                    # Your configuration (not in git)
├── .env.template           # Configuration template
├── docker-compose.clusterio.yml
├── Dockerfile.controller
├── Dockerfile.host
├── clusterio-init.sh       # Bootstrap script
├── seed-data/              # Additional assets baked/mounted into images
│   ├── mods/              # Additional mod .zip files (optional)
│   └── saves/             # Initial save files (optional)
└── clusterio-containers/   # All runtime data (not in git)
    ├── controller/         # Controller database, logs, config
    └── hosts/
        ├── clusterio-host-1/  # Host 1 data and instances
        └── clusterio-host-2/  # Host 2 data and instances
```

Seed assets:
- `/opt/seed-mods` and `/opt/seed-saves` are populated from `docker/seed-data/` when you build the base image. Every `.zip` placed under `seed-data/mods/` is baked into the layer and later uploaded to the controller.
- `/opt/seed-plugins/surface_export` contains the prebuilt Clusterio plugin used by controller and hosts.

## Base Image Strategy & Performance Notes

The shared base image exists so every container inherits the heavy dependencies once:
- **Factorio headless + DLC assets** are downloaded during the base build, not every time `docker compose up` runs. This keeps rebuilds fast and guarantees hosts/controllers are running the same binaries.
- **Node.js + @clusterio packages** are globally installed in the base layer so controller/host/init containers share a single `node_modules` tree. That eliminates repeated `npm install` runs and prevents mismatched versions.
- **Surface Export mod + plugin** are bundled and zipped ahead of time so bootstrap only has to copy files into persistent volumes.
- **Shared scripts** (like the dev-warning suppressor) already live under `/opt/scripts`, so derived images can opt-in without invoking additional downloads.

In practice this means most rebuilds only invalidate the small controller/host layers, while the expensive Factorio and Node layers stay cached.

## Mod & Save Seeding Flow

1. When you build the base image, everything under `docker/seed-data/mods/` and `docker/seed-data/saves/` is copied into `/opt/seed-mods` and `/opt/seed-saves`.
2. `clusterio-init` uploads each mod archive from `/opt/seed-mods` once per clean controller volume and adds them to the default `my-server-pack`.
3. After assigning instances to hosts, the init script automatically copies saves from `/opt/seed-saves` into each instance's `/clusterio/instances/<instance-name>/saves` directory.
4. Hosts copy `/opt/seed-plugins/surface_export` into `/clusterio/plugins` on every boot so controller and host plugin versions always match.
5. Clusterio automatically syncs mods from the controller to each host's `/clusterio/mods` directory based on the assigned mod pack.

## DLC Mods (Space Age, Quality, Elevated Rails)

The three bundled DLC mods are now fully integrated into the Clusterio workflow:

**How it works:**
1. During base image build, the DLC directories under `/opt/factorio/data/` are automatically zipped and placed in `/opt/seed-mods/`
2. The controller init script uploads these zips (e.g., `space-age_2.0.72.zip`) alongside your community mods
3. The init script explicitly adds and enables all three DLCs in the `my-server-pack` mod pack
4. Hosts download them from the controller just like any other mod during instance startup

**You don't need to:**
- Manually download DLC `.zip` files
- Copy DLC mods into `seed-data/mods/`
- Patch `mod-list.json` on hosts
- Mount a `space-age` directory

The controller's mod storage at `docker/clusterio-containers/controller/mods/` will contain `space-age_2.0.72.zip`, `quality_2.0.72.zip`, and `elevated-rails_2.0.72.zip` after initialization, and you'll see all three with ★ (enabled) in the web UI mod pack view.

## Seeding Saved Games

To have instances automatically load a saved game on startup:

**1. Place saves in the correct location:**
```bash
# Saves must be in the instance-specific directory:
docker/clusterio-containers/hosts/<host-name>/instances/<instance-name>/saves/your-save.zip

# Example for clusterio-host-1-instance-1:
docker/clusterio-containers/hosts/clusterio-host-1/instances/clusterio-host-1-instance-1/saves/my-save.zip
```

**3. Start the instance:**
```bash
docker exec clusterio-controller npx clusterioctl instance start clusterio-host-1-instance-1
```

**Notes:**
- Save files must end with `.zip` (not `.tmp.zip`)
- Clusterio automatically patches saves with plugin Lua modules if `factorio.enable_save_patching` is enabled (default)
- The save must be compatible with the Factorio version configured in the mod pack
- Saves are per-instance, not shared across instances
- The `docker/seed-data/saves/` directory contains templates copied into `/opt/seed-saves` in the base image but is not automatically loaded by instances—it's for manual import via the web UI

## Key Files (What They Do)

| File | Purpose |
| --- | --- |
| `.env` | Central configuration for ports, RCON password, Factorio credentials, and the comma-separated `FACTORIO_ADMINS` list. Copy from `.env.template` and keep it out of source control. |

| `docker/seed-data/scripts/install-space-age.sh` | Historical helper for downloading a licensed Space Age archive during the base build. It’s now dormant (assets are bundled with Factorio), but kept around so advanced users can re-enable it if they ever need offline DLC provisioning. |
| `docker/seed-data/scripts/suppress-dev-warning.js` | Best-effort patch that rewrites the noisy 2.0 alpha warning banner in `clusteriocontroller`/`clusterioctl`. The controller image runs it once, gated by `CLUSTERIO_SUPPRESS_DEV_WARNING`. |
| `docker/seed-data/scripts/host-entrypoint.sh` | Runtime entrypoint for host containers. Handles plugin syncing, admin list generation from `FACTORIO_ADMINS`, and launches `clusteriohost`. Clusterio manages mod and save synchronization automatically. |

All scripts (build-time helpers and runtime entrypoints) now live under `docker/seed-data/scripts/`. Build-time utilities are baked into the base image under `/opt/scripts`, while runtime scripts like `host-entrypoint.sh` are copied directly into specific derived images.

## Directory Reference

| Directory | Purpose |
| --- | --- |
| `docker/seed-data/mods/` | Drop any `.zip` Factorio mods here. They’re baked into `/opt/seed-mods` and uploaded automatically when the controller initializes. Leave the `.gitkeep` if you need the folder tracked. |
| `docker/seed-data/saves/` | Starter saves baked into `/opt/seed-saves`. The init script automatically copies them into each instance's saves directory (`/clusterio/instances/<instance-name>/saves`) after assignment. Place `.zip` save files here to have them available on first cluster startup. |
| `docker/seed-data/scripts/` | Build-time helpers and runtime entrypoints. Build scripts land in `/opt/scripts` with read+execute permissions; runtime scripts are copied directly into derived images. |
| `docker/clusterio-containers/controller/` | Persistent controller data: configs, database, uploaded mods, logs. Safe to delete when you want a pristine cluster; Compose will recreate it. |
| `docker/clusterio-containers/hosts/` | Per-host state (configs, Factorio saves, script-output, plugin cache). Structured as `clusterio-host-1/` and `clusterio-host-2/`. |

If a `docker/seed-data/space-age/` directory reappears (for example, because a script created it), delete it. The build no longer references that path, and keeping it around invites confusion about whether a DLC drop-in is required.

## Environment Variables

All configuration is in `.env` (copy from `.env.template`).

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTROLLER_HTTP_PORT` | 8080 | Controller web UI, HTTP API, and WebSocket |
| `HOST1_INSTANCE1_GAME_PORT` | 34197 | Factorio game port for host 1 |
| `HOST1_INSTANCE1_RCON_PORT` | 27015 | RCON port for host 1 |
| `HOST2_INSTANCE1_GAME_PORT` | 34198 | Factorio game port for host 2 |
| `HOST2_INSTANCE1_RCON_PORT` | 27016 | RCON port for host 2 |
| `RCON_PASSWORD` | - | RCON password (required) |
| `MOD_PACK_FACTORIO_VERSION` | 2.0 | Factorio version used when auto-creating the default mod pack |
| `FACTORIO_AUTO_START` | false | When `true`, instances will auto-start when hosts connect (requires saves in instance directory) |
| `FACTORIO_ADMINS` | admin | Comma-separated list of players added to `server-adminlist.json` on host startup |
| `FACTORIO_USERNAME` | (empty) | Factorio.com username (optional, for mod downloads) |
| `FACTORIO_TOKEN` | (empty) | Factorio.com API token (optional, for mod downloads) |

**Admin Token**: Get from `docker/clusterio-containers/controller/config-control.json`

## Common Issues

### Init Script Hangs

**Cause**: Controller WebSocket API not accessible

**Check**: 
```bash
docker logs clusterio-controller
docker logs clusterio-init
```

The init script has 30-second timeouts and will fail with clear error messages.

### Ports Already in Use

**Solution**: Change ports in `.env` file:
```
HOST1_INSTANCE1_GAME_PORT=34299
HOST1_INSTANCE1_RCON_PORT=27115
```

## Useful Commands

```bash
# View logs
docker-compose -f docker-compose.clusterio.yml logs -f

# Check cluster status
docker exec clusterio-controller npx clusterioctl instance list
docker exec clusterio-controller npx clusterioctl host list

# Access controller web UI
# Open http://localhost:8080 in your browser

# Stop cluster
docker-compose -f docker-compose.clusterio.yml down

# Clean restart
docker-compose -f docker-compose.clusterio.yml down
rm -rf clusterio-data
docker-compose -f docker-compose.clusterio.yml up -d
```

## Plugin Development

The `surface_export` is automatically mounted and loaded by the controller and instances. No additional setup needed for plugin development.

## Notes

- The `clusterio-init` container runs once and exits (restart: "no")
- All data persists in local `clusterio-data/` directory
- Mods and saves-seed are mounted read-only
- Each host has isolated saves and script-output directories
