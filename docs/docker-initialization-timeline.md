# Docker Initialization Timeline: Complete Command Reference

**Format**: Action-by-action breakdown of every command executed during cluster initialization.  
**Purpose**: Comprehensive audit trail for debugging, optimization, and understanding the complete deployment process.

**Legend**: 
- `→` Creates file/directory
- `✓` Validation checkpoint
- `⚙` Configuration change
- `🔧` System modification
- `📦` Package/mod operation
- `🔥` Critical for mod loading
- `🚨` Known issue/bug
- `⏱` Performance note

**Document Status**: Updated with complete command trace including exit codes, timing, and validation points.  
**Last Updated**: January 26, 2026  
**Related Files**:
- [.env](../docker/.env) - Environment configuration
- [.env.template](../docker/.env.template) - Template with defaults
- [clusterio-init.sh](../docker/seed-data/scripts/clusterio-init.sh) - Main initialization script
- [controller-entrypoint.sh](../docker/seed-data/scripts/controller-entrypoint.sh) - Controller startup
- [host-entrypoint.sh](../docker/seed-data/scripts/host-entrypoint.sh) - Host startup

---

## Quick Start: Understanding the Initialization Flow

**Total Time**: ~2-3 minutes for full cluster deployment (first time), ~30 seconds for restarts

**High-Level Process**:
```
1. Build Images (once)          → Base image with Factorio + Clusterio + Mods
2. Start Controller             → Creates admin user, binds HTTP/WebSocket
3. Init Script Runs             → Configures cluster, uploads mods, assigns instances  
4. Hosts Start                  → Connect to controller, load plugins
5. Instances Start              → Factorio servers launch, load mods
6. Ready for Use                → Export/import commands available
```

**Critical Path for Mod Loading** (FactorioSurfaceExport):
```
Base Image Build
  ├─> /opt/seed-mods/FactorioSurfaceExport_1.0.35.zip created
  └─> 🔥 CHECKPOINT: Mod baked into image

Init Script: Mod Upload
  ├─> Upload to controller: /clusterio/mods/FactorioSurfaceExport_1.0.35.zip
  ├─> Add to mod pack: my-server-pack
  ├─> Enable in mod pack: FactorioSurfaceExport:1.0.35
  └─> 🔥 CHECKPOINT: Mod in controller, enabled in pack

Init Script: Instance Setup
  ├─> Assign instance to host
  ├─> Write /clusterio-hosts/.../mods/mod-list.json
  ├─> Enable mods: clusterio_lib, FactorioSurfaceExport
  └─> 🔥 CHECKPOINT: Mod in mod-list.json

Instance Startup
  ├─> Host syncs mod .zip files from controller
  ├─> Factorio reads mod-list.json
  ├─> Factorio loads FactorioSurfaceExport control.lua
  ├─> Commands registered: /export-platform, /import-platform
  └─> 🔥 CHECKPOINT: Mod loaded, commands available
```

**Common Failure Points**:
1. **Mod not in base image** → Rebuild with `docker-compose build --no-cache base`
2. **Mod not uploaded to controller** → Check init logs for upload errors
3. **Mod not in mod-list.json** → Most common issue, see [Troubleshooting](#troubleshooting-command-trace-for-common-issues)
4. **Mod in mod-list.json but not loaded** → Check dependencies (flib, stdlib2), Factorio logs

**Quick Validation** (after deployment):
```powershell
# Run automated validation script
.\tools\validate-cluster.ps1

# Or manually check mod loaded
docker exec clusterio-controller npx clusterioctl instance rcon clusterio-host-1-instance-1"/c rcon.print(game.active_mods['FactorioSurfaceExport'])"
# Expected: "1.0.35"
```

---



### .env File Structure

**Location**: `docker/.env`  
**Template**: `docker/.env.template`  
**Purpose**: Configure ports, credentials, save files, and startup behavior

**Key Environment Variables Used During Initialization**:

| Variable | Used In Phase | Purpose | Example Value |
|----------|---------------|---------|---------------|
| `CONTROLLER_HTTP_PORT` | 2, 3, 4 | HTTP/WebSocket port for controller | `8080` |
| `HOST1_INSTANCE1_GAME_PORT` | 4 | Factorio game port (Instance 1) | `34197` |
| `HOST1_INSTANCE1_RCON_PORT` | 4 | RCON port (Instance 1) | `27015` |
| `HOST2_INSTANCE1_GAME_PORT` | 4 | Factorio game port (Instance 2) | `34198` |
| `HOST2_INSTANCE1_RCON_PORT` | 4 | RCON port (Instance 2) | `27016` |
| `RCON_PASSWORD` | 4 | RCON authentication password | `Eehsomething2` |
| `FACTORIO_ADMINS` | 4, 5 | Comma-separated admin list | `admin,solarcloud7` |
| `FACTORIO_AUTO_START` | 4 | Auto-start instances after init | `true` / `false` |
| `MOD_PACK_FACTORIO_VERSION` | 4 | Factorio version for mod pack | `2.0` |
| `FACTORIO_USERNAME` | 3, 4 | Factorio portal username | `your_username` |
| `FACTORIO_TOKEN` | 3, 4 | Factorio portal auth token | `your_token` |
| `INSTANCE1_SAVE_NAME` | 4 | Save file for Instance 1 | `test.zip` |
| `INSTANCE2_SAVE_NAME` | 4 | Save file for Instance 2 | `MinSeed.zip` |

**Configuration Files Generated from .env**:
- `/clusterio/config-controller.json` - Controller settings (ports, credentials)
- `/clusterio-hosts/clusterio-host-1/config-host.json` - Host 1 connection config
- `/clusterio-hosts/clusterio-host-2/config-host.json` - Host 2 connection config
- Instance configs stored in controller database

**Note**: The init script reads these environment variables and applies them during cluster setup. Changes to `.env` require re-running `docker-compose up` or manually updating configs via `clusterioctl`.

---

## Table of Contents
1. [PHASE 1: Image Build (Bake-Time)](#phase-1-image-build-bake-time)
2. [PHASE 2: Container Startup Sequence](#phase-2-container-startup-sequence)
3. [PHASE 3: Controller Initialization](#phase-3-controller-initialization-controller-entrypointsh)
4. [PHASE 4: Init Container Execution](#phase-4-init-script-execution-cluster-bootstrap)
5. [PHASE 5: Host Container Startup](#phase-5-host-startup)
6. [PHASE 6: Instance Startup](#phase-6-instance-startup)
7. [PHASE 7: Runtime Validation](#phase-7-runtime-validation)
8. [PHASE 8: Ready for Use](#phase-8-ready-for-use)
9. [Quick Reference](#quick-reference-critical-files-created)
10. [Troubleshooting](#troubleshooting-command-trace-for-common-issues)

---

## PHASE 1: Image Build (Bake-Time)

### 1.1 Base Image: OS Setup

**Trigger**: `docker-compose build` or `docker compose build`  
**Dockerfile**: [docker/Dockerfile.base](../docker/Dockerfile.base)  
**Context**: Docker build context at `./docker`  
**Base Image**: `debian:bookworm-slim` (Debian 12)

```dockerfile
FROM debian:bookworm-slim
```

**Actions** (executed in order, exit code must be 0):
- [ ] `apt-get update` - Update package lists
- [ ] `apt-get install ca-certificates` - Install SSL certificates
- [ ] `apt-get install curl` - Install HTTP client
- [ ] `apt-get install gnupg` - Install GPG for package verification
- [ ] `apt-get install xz-utils` - Install XZ decompression
- [ ] `apt-get install unzip` - Install ZIP extraction
- [ ] `apt-get install python3` - Install Python runtime
- [ ] `apt-get install zip` - Install ZIP creation
- [ ] `rm -rf /var/lib/apt/lists/*` - Clean apt cache
- [ ] `curl -fsSL https://deb.nodesource.com/setup_20.x | bash` - Add NodeSource repository
- [ ] `apt-get update` - Refresh with NodeSource packages
- [ ] `apt-get install nodejs` - Install Node.js 20.x
- [ ] `rm -rf /var/lib/apt/lists/*` - Clean apt cache again

### 1.2 Base Image: Factorio Installation

**Actions**:
- [ ] `mkdir -p /opt` - Create install directory
- [ ] `curl -fsSL "https://factorio.com/get-download/2.0.72/headless/linux64" -o /tmp/factorio-headless.tar.xz` - Download Factorio 2.0.72
- [ ] `tar -xJf /tmp/factorio-headless.tar.xz -C /opt` - Extract Factorio
- [ ] `rm /tmp/factorio-headless.tar.xz` - Remove download archive
- [ ] `ln -s /opt/factorio /factorio` → Creates symlink `/factorio`
- [ ] `groupadd -r factorio` - Create factorio group (gid 999)
- [ ] `useradd -r -g factorio -d /opt/factorio factorio` - Create factorio user (uid 999)
- [ ] `chown -R factorio:factorio /opt/factorio` - Set ownership

### 1.3 Base Image: DLC Packaging

**Actions**:
- [ ] `cd /opt/factorio/data` - Navigate to DLC directory
- [ ] `grep -oP '(?<="version": ")[^"]+' space-age/info.json` - Extract space-age version
- [ ] `zip -rq /opt/seed-mods/space-age_2.0.0.zip space-age` → Creates `/opt/seed-mods/space-age_2.0.0.zip`
- [ ] `grep -oP '(?<="version": ")[^"]+' quality/info.json` - Extract quality version
- [ ] `zip -rq /opt/seed-mods/quality_2.0.0.zip quality` → Creates `/opt/seed-mods/quality_2.0.0.zip`
- [ ] `grep -oP '(?<="version": ")[^"]+' elevated-rails/info.json` - Extract elevated-rails version
- [ ] `zip -rq /opt/seed-mods/elevated-rails_2.0.0.zip elevated-rails` → Creates `/opt/seed-mods/elevated-rails_2.0.0.zip`
- [ ] `chown -R factorio:factorio /opt/seed-mods` - Set ownership

### 1.4 Base Image: Clusterio Installation

**Actions**:
- [ ] `npm install -g @clusterio/lib@2.0.0-alpha.22` → Installs to `/usr/lib/node_modules/@clusterio/lib`
- [ ] `npm install -g @clusterio/controller@2.0.0-alpha.22` → Installs to `/usr/lib/node_modules/@clusterio/controller`
- [ ] `npm install -g @clusterio/host@2.0.0-alpha.22` → Installs to `/usr/lib/node_modules/@clusterio/host`
- [ ] `npm install -g @clusterio/ctl@2.0.0-alpha.22` → Installs to `/usr/lib/node_modules/@clusterio/ctl`
- [ ] `npm install -g @clusterio/plugin-global_chat@2.0.0-alpha.22` → Installs plugin
- [ ] `npm install -g @clusterio/plugin-inventory_sync@2.0.0-alpha.22` → Installs plugin
- [ ] `npm install -g @clusterio/plugin-player_auth@2.0.0-alpha.22` → Installs plugin
- [ ] `npm install -g @clusterio/plugin-research_sync@2.0.0-alpha.22` → Installs plugin
- [ ] `npm install -g @clusterio/plugin-statistics_exporter@2.0.0-alpha.22` → Installs plugin
- [ ] `npm install -g @clusterio/plugin-subspace_storage@2.0.0-alpha.22` → Installs plugin

### 1.5 Base Image: Seed Data Copying

**Actions**:
- [ ] `COPY docker/seed-data/mods/ /opt/seed-mods/` - Copy ~60 mod zip files
- [ ] `COPY docker/seed-data/saves/ /opt/seed-saves/` - Copy save files
- [ ] `COPY docker/seed-data/config /opt/seed-config` - Copy config templates
- [ ] `COPY docker/seed-data/config/plugin-list.controller.json /opt/seed-plugins/` → Creates template
- [ ] `COPY docker/seed-data/scripts /opt/scripts` - Copy entrypoint scripts
- [ ] `COPY src/surface_export_plugin /opt/seed-plugins/surface_export` - Copy custom plugin
- [ ] `COPY src/surface_export_mod /opt/seed-mods/FactorioSurfaceExport_1.0.35` - Copy custom mod source
- [ ] `cd /opt/seed-mods` - Navigate to mods directory
- [ ] `zip -rq FactorioSurfaceExport_1.0.35.zip FactorioSurfaceExport_1.0.35` → Creates `/opt/seed-mods/FactorioSurfaceExport_1.0.35.zip` (107.7 KB)
- [ ] `chmod -R a+rx /opt/scripts` - Make scripts executable

### 1.6 Base Image: clusterio_lib Build

**Actions**:
- [ ] `cd /usr/lib/node_modules/@clusterio/host` - Navigate to host package
- [ ] `npm run build-mod -- --output-dir ./dist` - Build clusterio_lib mod
- [ ] Wait for build completion → Creates `/usr/lib/node_modules/@clusterio/host/dist/clusterio_lib_2.0.20.zip`

**✓ VALIDATION 1A**: Verify baked files exist
- [ ] `test -f /opt/seed-mods/FactorioSurfaceExport_1.0.35.zip` - Check mod zip exists
- [ ] `unzip -l /opt/seed-mods/FactorioSurfaceExport_1.0.35.zip | grep info.json` - Check zip contents
- [ ] `unzip -l /opt/seed-mods/FactorioSurfaceExport_1.0.35.zip | grep control.lua` - Check control.lua present

### 1.7 Controller Image Build

**Actions**:
- [ ] `FROM factorio-surface-export/base:latest` - Inherit all base content
- [ ] `COPY docker/seed-data/scripts/controller-entrypoint.sh /opt/scripts/` - Copy entrypoint
- [ ] `chmod +x /opt/scripts/controller-entrypoint.sh` - Make executable
- [ ] `EXPOSE 8080` - Document port

### 1.8 Host Image Build

**Actions**:
- [ ] `FROM factorio-surface-export/base:latest` - Inherit all base content
- [ ] `COPY docker/seed-data/config/plugin-list.host.json /opt/seed-plugins/` - Copy host plugin template
- [ ] `COPY docker/seed-data/scripts/host-entrypoint.sh /opt/scripts/` - Copy entrypoint
- [ ] `chmod +x /opt/scripts/host-entrypoint.sh` - Make executable

---

## PHASE 2: Container Startup Sequence

### 2.1 docker-compose up Command

**Actions**:
- [ ] `docker network create factoriosurfaceexport_clusterio-network` - Create bridge network
- [ ] `docker volume create factoriosurfaceexport_clusterio-controller-data` - Create controller volume
- [ ] `docker volume create factoriosurfaceexport_clusterio-host-1-data` - Create host-1 volume
- [ ] `docker volume create factoriosurfaceexport_clusterio-host-2-data` - Create host-2 volume
- [ ] `docker run -d --name clusterio-controller ...` - Start controller container

### 2.2 Controller Container Starts

**Actions**:
- [ ] `exec /opt/scripts/controller-entrypoint.sh` - Run entrypoint
- [ ] **T+0s**: Container running, entrypoint begins

### 2.3 Controller Healthcheck Loop (Parallel)

**Actions** (Every 5 seconds for up to 60 seconds):
- [ ] `curl -f http://localhost:8080/` - Check if HTTP responds
- [ ] If successful → Controller marked HEALTHY
- [ ] If 12 retries fail → Controller marked UNHEALTHY

---

## PHASE 3: Controller Initialization (controller-entrypoint.sh)

### 3.1 Controller: Seed Plugin List

**Actions**:
- [ ] `test -f /clusterio/plugin-list.json` - Check if already exists
- [ ] If not exists: `cp /opt/seed-plugins/plugin-list.controller.json /clusterio/plugin-list.json` → Creates `/clusterio/plugin-list.json`

### 3.2 Controller: Create Configuration

**Actions**:
- [ ] `test -f /clusterio/config-controller.json` - Check if config exists
- [ ] If not exists: `npx clusteriocontroller config set controller.name "Surface Export Controller"` ⚙ Sets name
- [ ] If not exists: `npx clusteriocontroller config set controller.bind_address "0.0.0.0"` ⚙ Bind all interfaces
- [ ] If not exists: `npx clusteriocontroller config set controller.http_port 8080` ⚙ Set port
- [ ] If `$FACTORIO_USERNAME`: `npx clusteriocontroller config set controller.factorio_username "$FACTORIO_USERNAME"` ⚙ Set username
- [ ] If `$FACTORIO_TOKEN`: `npx clusteriocontroller config set controller.factorio_token "$FACTORIO_TOKEN"` ⚙ Set token
- [ ] → Creates `/clusterio/config-controller.json`

### 3.3 Controller: Create Admin User

**Actions**:
- [ ] `test -f /clusterio/database/users.json` - Check if users exist
- [ ] If not exists: `npx clusteriocontroller bootstrap create-admin admin` 📦 Creates admin user
- [ ] → Creates `/clusterio/database/users.json` with admin credentials

### 3.4 Controller: Start Service

**Actions**:
- [ ] `exec npx clusteriocontroller run` - Start Clusterio controller
- [ ] Controller loads configuration from `/clusterio/config-controller.json`
- [ ] Controller loads user database from `/clusterio/database/users.json`
- [ ] Controller binds to `0.0.0.0:8080`
- [ ] HTTP server starts, serves `/` endpoint
- [ ] WebSocket server starts on `/api/socket`
- [ ] Controller ready → Healthcheck will now succeed
- [ ] **Dependent containers begin starting**

**✓ VALIDATION 2A**: Controller running
- [ ] `curl http://localhost:8080/` - HTTP responds with 200 OK
- [ ] `test -f /clusterio/database/users.json` - Users database exists
- [ ] `grep -q admin /clusterio/database/users.json` - Admin user present

---

## PHASE 4: Init Container Execution (clusterio-init.sh)

### 4.1 Init: Wait for Controller

**Actions**:
- [ ] Loop up to 30 times (60 seconds total):
  - [ ] `curl -sf http://clusterio-controller:8080/` - Test connection
  - [ ] If success → Break loop
  - [ ] If fail → `sleep 2`, retry
- [ ] If 30 attempts fail → `exit 1`

### 4.2 Init: Check Existing State

**Actions**:
- [ ] `test -f /clusterio/config-control.json` - Check if already initialized
- [ ] If exists: `npx clusterioctl instance list | grep clusterio-host-1-instance-1` - Check instances exist
- [ ] If exists: `test -f /clusterio-hosts/clusterio-host-1/config-host.json` - Check host configs
- [ ] Set `CONTROL_CONFIG_EXISTS=true` if control config found

### 4.3 Init: Create Control Config

**Actions**:
- [ ] If `$CONTROL_CONFIG_EXISTS = false`: `npx clusteriocontroller bootstrap create-ctl-config admin` 📦 Generate ctl auth
- [ ] → Creates `/clusterio/config-control.json` with admin token
- [ ] `npx clusterioctl control-config set control.controller_url "http://clusterio-controller:8080/"` ⚙ Set controller URL
- [ ] → Modifies `/clusterio/config-control.json`

**✓ VALIDATION 3A**: Authentication working
- [ ] `npx clusterioctl instance list` - Test authentication (should not error with "Unauthorized")

### 4.4 Init: Create Instances

**Instance 1**:
- [ ] `npx clusterioctl instance list | grep clusterio-host-1-instance-1` - Check if exists
- [ ] If not exists: `npx clusterioctl instance create clusterio-host-1-instance-1 --id 1` 📦 Create instance
- [ ] → Creates instance record in controller database with ID=1

**Instance 2**:
- [ ] `npx clusterioctl instance list | grep clusterio-host-2-instance-1` - Check if exists
- [ ] If not exists: `npx clusterioctl instance create clusterio-host-2-instance-1 --id 2` 📦 Create instance
- [ ] → Creates instance record in controller database with ID=2

### 4.5 Init: Configure Instance 1

**Actions**:
- [ ] `npx clusterioctl instance config set clusterio-host-1-instance-1 factorio.game_port ${HOST1_INSTANCE1_GAME_PORT}` ⚙ Set game port
  - **Command**: `npx clusterioctl instance config set clusterio-host-1-instance-1 factorio.game_port 34197`
  - **Purpose**: Set the UDP port for game traffic
  - **Stored**: Controller database (`/clusterio/database/instances/`)
  - **Expected Exit**: 0
  - **Output**: `Set factorio.game_port to 34197`

- [ ] `npx clusterioctl instance config set clusterio-host-1-instance-1 factorio.rcon_port ${HOST1_INSTANCE1_RCON_PORT}` ⚙ Set RCON port
  - **Command**: `npx clusterioctl instance config set clusterio-host-1-instance-1 factorio.rcon_port 27015`
  - **Purpose**: Set TCP port for RCON commands
  - **Expected Exit**: 0
  - **Output**: `Set factorio.rcon_port to 27015`

- [ ] `npx clusterioctl instance config set clusterio-host-1-instance-1 factorio.rcon_password "${RCON_PASSWORD}"` ⚙ Set RCON password
  - **Command**: `npx clusterioctl instance config set clusterio-host-1-instance-1 factorio.rcon_password "Eegh4ohsiethie2"`
  - **Purpose**: Authenticate RCON connections
  - **Security**: Password stored in controller database, transmitted to host
  - **Expected Exit**: 0
  - **Output**: `Set factorio.rcon_password to [REDACTED]`

- [ ] `npx clusterioctl instance config set clusterio-host-1-instance-1 factorio.enable_save_patching true` ⚙ Enable save patching
  - **Purpose**: Allow Clusterio to modify save files (inject mods, settings)
  - **Clusterio Feature**: Hot-loads `clusterio_lib` mod without manual save editing
  - **Expected Exit**: 0
  - **Output**: `Set factorio.enable_save_patching to true`

- [ ] `npx clusterioctl instance config set clusterio-host-1-instance-1 factorio.settings '{"name":"Clusterio Host 1 - Instance 1","description":"Factorio server for platform export/import testing","tags":["clusterio","surface-export"],"max_players":0,"visibility":{"public":false,"lan":true},"username":"","password":"","token":"","game_password":"","require_user_verification":false,"max_upload_in_kilobytes_per_second":0,"max_upload_slots":5,"minimum_latency_in_ticks":0,"ignore_player_limit_for_returning_players":false,"allow_commands":"admins-only","autosave_interval":10,"autosave_slots":5,"afk_autokick_interval":0,"auto_pause":false,"only_admins_can_pause_the_game":true,"autosave_only_on_server":true,"non_blocking_saving":false,"minimum_segment_size":25,"minimum_segment_size_peer_count":20,"maximum_segment_size":100,"maximum_segment_size_peer_count":10}'` ⚙ Set server metadata
  - **Purpose**: Configure server name, description, autosave, pause behavior
  - **Critical Settings**:
    - `"auto_pause": false` - Server continues when no players online
    - `"visibility": {"public": false, "lan": true}` - Not visible on internet
    - `"allow_commands": "admins-only"` - Restrict console commands to admins
  - **Expected Exit**: 0
  - **Output**: `Set factorio.settings to {...}`

- [ ] `npx clusterioctl instance config set clusterio-host-1-instance-1 factorio.sync_adminlist "bidirectional"` ⚙ Enable admin sync
  - **Purpose**: Sync admin list between Clusterio and Factorio
  - **Modes**: 
    - `disabled` - No sync
    - `factorio_to_cluster` - Read from Factorio, write to Clusterio
    - `cluster_to_factorio` - Read from Clusterio, write to Factorio
    - `bidirectional` - Two-way sync (recommended)
  - **Expected Exit**: 0
  - **Output**: `Set factorio.sync_adminlist to bidirectional`

- [ ] If `$FACTORIO_AUTO_START=true`: `npx clusterioctl instance config set clusterio-host-1-instance-1 instance.auto_start true` ⚙ Enable auto-start
  - **Command**: `npx clusterioctl instance config set clusterio-host-1-instance-1 instance.auto_start true`
  - **Purpose**: Automatically start instance when host connects
  - **Behavior**: When host starts, it will automatically launch Factorio server
  - **Alternative**: If false, requires manual `clusterioctl instance start` command
  - **Expected Exit**: 0
  - **Output**: `Set instance.auto_start to true`
  - **Condition**: Only executed if `FACTORIO_AUTO_START=true` in `.env`

### 4.6 Init: Configure Instance 2

**Actions**: (Same as 4.5 but for instance 2)
- [ ] `npx clusterioctl instance config set clusterio-host-2-instance-1 factorio.game_port 34202` ⚙ Set game port
- [ ] `npx clusterioctl instance config set clusterio-host-2-instance-1 factorio.rcon_port 27102` ⚙ Set RCON port
- [ ] `npx clusterioctl instance config set clusterio-host-2-instance-1 factorio.rcon_password "$RCON_PASSWORD"` ⚙ Set RCON password
- [ ] `npx clusterioctl instance config set clusterio-host-2-instance-1 factorio.enable_save_patching true` ⚙ Enable save patching
- [ ] `npx clusterioctl instance config set clusterio-host-2-instance-1 factorio.settings '{"name":"Clusterio Host 2 - Instance 1","description":"...","auto_pause":false}'` ⚙ Set metadata
- [ ] `npx clusterioctl instance config set clusterio-host-2-instance-1 factorio.sync_adminlist "bidirectional"` ⚙ Enable admin sync
- [ ] If `$FACTORIO_AUTO_START=true`: `npx clusterioctl instance config set clusterio-host-2-instance-1 instance.auto_start true` ⚙ Enable auto-start

### 4.7 Init: Create Host Configs

**Host 1**:
- [ ] `test -f /clusterio-hosts/clusterio-host-1/config-host.json` - Check if exists
- [ ] If not exists: `npx clusterioctl host create-config --name clusterio-host-1 --id 1 --generate-token --output /clusterio-hosts/clusterio-host-1/config-host.json` 📦 Create config
- [ ] → Creates `/clusterio-hosts/clusterio-host-1/config-host.json` with authentication token
- [ ] `sed -i "s|http://localhost:8080/|http://clusterio-controller:8080/|" /clusterio-hosts/clusterio-host-1/config-host.json` 🔧 Fix controller URL
- [ ] `npx clusterioctl host config set clusterio-host-1 host.factorio_directory /opt/factorio` ⚙ Set Factorio path

**Host 2**:
- [ ] `test -f /clusterio-hosts/clusterio-host-2/config-host.json` - Check if exists
- [ ] If not exists: `npx clusterioctl host create-config --name clusterio-host-2 --id 2 --generate-token --output /clusterio-hosts/clusterio-host-2/config-host.json` 📦 Create config
- [ ] → Creates `/clusterio-hosts/clusterio-host-2/config-host.json` with authentication token
- [ ] `sed -i "s|http://localhost:8080/|http://clusterio-controller:8080/|" /clusterio-hosts/clusterio-host-2/config-host.json` 🔧 Fix controller URL
- [ ] `npx clusterioctl host config set clusterio-host-2 host.factorio_directory /opt/factorio` ⚙ Set Factorio path

**✓ VALIDATION 3B**: Host configs valid
- [ ] `test -f /clusterio-hosts/clusterio-host-1/config-host.json` - Config 1 exists
- [ ] `test -f /clusterio-hosts/clusterio-host-2/config-host.json` - Config 2 exists
- [ ] `grep -q "clusterio-controller:8080" /clusterio-hosts/clusterio-host-1/config-host.json` - URL correct

### 4.8 Init: Add Plugins

**Actions**:
- [ ] `npx clusterioctl plugin add /usr/lib/node_modules/@clusterio/plugin-global_chat` 📦 Add global_chat
- [ ] `npx clusterioctl plugin add /usr/lib/node_modules/@clusterio/plugin-inventory_sync` 📦 Add inventory_sync
- [ ] `npx clusterioctl plugin add /usr/lib/node_modules/@clusterio/plugin-player_auth` 📦 Add player_auth
- [ ] `npx clusterioctl plugin add /usr/lib/node_modules/@clusterio/plugin-research_sync` 📦 Add research_sync
- [ ] `npx clusterioctl plugin add /usr/lib/node_modules/@clusterio/plugin-statistics_exporter` 📦 Add statistics_exporter
- [ ] `npx clusterioctl plugin add /opt/seed-plugins/surface_export` 📦 Add surface_export (CUSTOM)

**✓ VALIDATION 3C**: Plugin registered
- [ ] `npx clusterioctl plugin list | grep surface_export` - Verify plugin added

### 4.9 Init: Build clusterio_lib

**Actions**:
- [ ] `test -f /usr/lib/node_modules/@clusterio/host/dist/clusterio_lib_2.0.20.zip` - Check if already built
- [ ] If not built: `cd /usr/lib/node_modules/@clusterio/host` - Navigate to package
- [ ] If not built: `npm run build-mod -- --output-dir ./dist` - Build mod
- [ ] → Creates `/usr/lib/node_modules/@clusterio/host/dist/clusterio_lib_2.0.20.zip`

### 4.10 Init: Upload clusterio_lib to Controller

**Actions**:
- [ ] `npx clusterioctl mod list | grep "clusterio_lib.*2.0.20"` - Check if already uploaded
- [ ] If not uploaded: `npx clusterioctl mod upload /usr/lib/node_modules/@clusterio/host/dist/clusterio_lib_2.0.20.zip` 📦 Upload
- [ ] → Creates `/clusterio/mods/clusterio_lib_2.0.20.zip` on controller

### 4.11 Init: Create Mod Pack

**Actions**:
- [ ] `npx clusterioctl mod-pack list` - Get existing mod packs
- [ ] Parse output for mod pack named "my-server-pack"
- [ ] If not exists: `npx clusterioctl mod-pack create "my-server-pack" "2.0"` 📦 Create pack
- [ ] `npx clusterioctl mod-pack list` - Get pack list again
- [ ] Parse output to extract mod pack ID (e.g., "242390647")
- [ ] Store in `$MOD_PACK_ID` variable

### 4.12 Init: Upload Seed Mods (Batch)</

**Actions** (For each .zip file in /opt/seed-mods/):
- [ ] `ls /opt/seed-mods/*.zip` - Scan for mod files (~60 files)
- [ ] For each mod in batches of 15 (parallel):
  - [ ] `basename "$mod_zip"` - Extract filename (e.g., "FactorioSurfaceExport_1.0.35.zip")
  - [ ] `test -f /clusterio/mods/$(basename "$mod_zip")` - Check if already on controller
  - [ ] If not exists: `npx clusterioctl mod upload "$mod_zip"` 📦 Upload mod
  - [ ] If timeout/error: Retry up to 3 times
  - [ ] If upload succeeds: Extract mod name and version from filename
  - [ ] If upload succeeds: `echo "FactorioSurfaceExport:1.0.35" >> /tmp/clusterio_uploaded_mods` - Track success
  - [ ] If upload fails after 3 retries: `echo "FactorioSurfaceExport_1.0.35.zip|error reason" >> /tmp/clusterio_failed_mods` - Track failure
- [ ] Wait for all parallel uploads to complete

**Specific Mods Uploaded**:
- [ ] → `/clusterio/mods/FactorioSurfaceExport_1.0.35.zip` (CRITICAL)
- [ ] → `/clusterio/mods/space-age_2.0.0.zip`
- [ ] → `/clusterio/mods/quality_2.0.0.zip`
- [ ] → `/clusterio/mods/elevated-rails_2.0.0.zip`
- [ ] → `/clusterio/mods/stdlib2_2.0.1.zip`
- [ ] → `/clusterio/mods/flib_0.16.5.zip`
- [ ] → Plus ~54 other mods

**✓ VALIDATION 3D**: FactorioSurfaceExport uploaded
- [ ] `npx clusterioctl mod list | grep "FactorioSurfaceExport.*1.0.35"` - Verify mod on controller
- [ ] If not found: `echo "ERROR: FactorioSurfaceExport 1.0.35 not found in controller mods"; exit 1` - Exit with error

### 4.13 Init: Add Mods to Pack (Batch)

**Actions**:
- [ ] `wc -l /tmp/clusterio_uploaded_mods` - Count successful uploads
- [ ] Read `/tmp/clusterio_uploaded_mods` line by line
- [ ] For each line (format: "mod_name:version"):
  - [ ] Parse mod name (before colon)
  - [ ] Build argument: `--add-mods mod_name:version --enable-mods mod_name`
- [ ] Batch into groups of 20 mods
- [ ] For each batch: `npx clusterioctl mod-pack edit "my-server-pack" --add-mods FactorioSurfaceExport:1.0.35 --enable-mods FactorioSurfaceExport --add-mods stdlib2:2.0.1 --enable-mods stdlib2 ...` ⚙ Add/enable mods

### 4.14 Init: Enable DLC Mods

**Actions**:
- [ ] `npx clusterioctl mod-pack edit "my-server-pack" --add-mods space-age:2.0.0 --enable-mods space-age` ⚙ Enable DLC
- [ ] `npx clusterioctl mod-pack edit "my-server-pack" --add-mods quality:2.0.0 --enable-mods quality` ⚙ Enable DLC
- [ ] `npx clusterioctl mod-pack edit "my-server-pack" --add-mods elevated-rails:2.0.0 --enable-mods elevated-rails` ⚙ Enable DLC

### 4.15 Init: Add Critical Dependencies

**Actions**:
- [ ] `npx clusterioctl mod-pack show "my-server-pack" | grep "clusterio_lib 2.0.20"` - Check if in pack
- [ ] If not in pack: `npx clusterioctl mod-pack edit "my-server-pack" --add-mods clusterio_lib:2.0.20 --enable-mods clusterio_lib` ⚙ Add/enable
- [ ] `npx clusterioctl mod-pack show "my-server-pack" | grep "FactorioSurfaceExport.*1.0.35"` - Check if in pack
- [ ] If not in pack: `npx clusterioctl mod-pack edit "my-server-pack" --add-mods FactorioSurfaceExport:1.0.35 --enable-mods FactorioSurfaceExport` ⚙ Add/enable
- [ ] `npx clusterioctl mod-pack show "my-server-pack" | grep "stdlib2 2.0.1"` - Check if in pack
- [ ] If not in pack: `npx clusterioctl mod-pack edit "my-server-pack" --add-mods stdlib2:2.0.1 --enable-mods stdlib2` ⚙ Add/enable
- [ ] `npx clusterioctl mod-pack show "my-server-pack" | grep "flib 0.16.5"` - Check if in pack
- [ ] If not in pack: `npx clusterioctl mod-pack edit "my-server-pack" --add-mods flib:0.16.5 --enable-mods flib` ⚙ Add/enable

**✓ VALIDATION 3E**: Mod enabled in pack
- [ ] `npx clusterioctl mod-pack show "my-server-pack"` - Get pack contents
- [ ] `grep "FactorioSurfaceExport.*1.0.35"` - Check mod present
- [ ] If not found: `echo "ERROR: FactorioSurfaceExport 1.0.35 not found in mod pack"; exit 1` - Exit with error
- [ ] `grep "FactorioSurfaceExport" | grep "enabled"` - Check mod enabled
- [ ] If not enabled: `echo "ERROR: FactorioSurfaceExport found but NOT enabled"; exit 1` - Exit with error

### 4.16 Init: Assign Mod Pack to Instances

**Actions**:
- [ ] `npx clusterioctl instance config set clusterio-host-1-instance-1 factorio.mod_pack_id "$MOD_PACK_ID"` ⚙ Assign pack to instance 1
- [ ] `npx clusterioctl instance config set clusterio-host-2-instance-1 factorio.mod_pack_id "$MOD_PACK_ID"` ⚙ Assign pack to instance 2

### 4.17 Init: Wait for Hosts to Connect

**Host 1**:
- [ ] Loop up to 90 times (180 seconds):
  - [ ] `npx clusterioctl host list` - Get host status
  - [ ] Parse output for "clusterio-host-1" and "connected" column
  - [ ] If connected=true → Set `HOST1_READY=true`, break loop
  - [ ] If not connected → `sleep 2`, retry
- [ ] If 90 attempts fail → `HOST1_READY=false`, log warning

**Host 2**:
- [ ] Loop up to 90 times (180 seconds):
  - [ ] `npx clusterioctl host list` - Get host status
  - [ ] Parse output for "clusterio-host-2" and "connected" column
  - [ ] If connected=true → Set `HOST2_READY=true`, break loop
  - [ ] If not connected → `sleep 2`, retry
- [ ] If 90 attempts fail → `HOST2_READY=false`, log warning

### 4.18 Init: Assign Instance 1 to Host 1

**Actions** (If `$HOST1_READY = true`):
- [ ] `npx clusterioctl instance assign clusterio-host-1-instance-1 clusterio-host-1` 📦 Assign instance
- [ ] → Clusterio creates directory structure on host
- [ ] → `/clusterio-hosts/clusterio-host-1/instances/clusterio-host-1-instance-1/` created
- [ ] → `/clusterio-hosts/clusterio-host-1/instances/clusterio-host-1-instance-1/mods/` created
- [ ] → `/clusterio-hosts/clusterio-host-1/instances/clusterio-host-1-instance-1/mods/mod-list.json` created
- [ ] → `/clusterio-hosts/clusterio-host-1/instances/clusterio-host-1-instance-1/saves/` created

### 4.19 Init: Seed Saves for Instance 1

**Script Section**: Lines 735-755 of clusterio-init.sh  
**Purpose**: Copy save files to instance directory and select which save to load

**Actions**:
- [ ] `INSTANCE1_SAVES_DIR="${HOSTS_DIR}/clusterio-host-1/instances/clusterio-host-1-instance-1/saves"` - Define save directory path
  - **Full Path**: `/clusterio-hosts/clusterio-host-1/instances/clusterio-host-1-instance-1/saves`
  - **Volume**: Mounted from `clusterio-host-1-data` Docker volume

- [ ] `mkdir -p "${INSTANCE1_SAVES_DIR}"` - Ensure directory exists
  - **Expected Exit**: 0 (always succeeds, creates parent directories if needed)

- [ ] `INSTANCE1_SAVE_NAME="${INSTANCE1_SAVE_NAME:-}"` - Read env variable
  - **Source**: `.env` file variable `INSTANCE1_SAVE_NAME`
  - **Example**: `test.zip` (save with space platform for export testing)
  - **Default Behavior**: If empty, uses newest save file

- [ ] If `$INSTANCE1_SAVE_NAME` is set and file exists:
  ```bash
  cp -n "${SEED_SAVES_DIR}/${INSTANCE1_SAVE_NAME}" "${INSTANCE1_SAVES_DIR}/"
  ```
  - **Source**: `/opt/seed-saves/test.zip` (baked into image)
  - **Destination**: `/clusterio-hosts/clusterio-host-1/instances/.../saves/test.zip`
  - **Flag `-n`**: No-clobber, don't overwrite existing files
  - **Purpose**: Copy only the specified save file
  - **Expected Exit**: 0

- [ ] If `$INSTANCE1_SAVE_NAME` is NOT set:
  ```bash
  cp -n ${SEED_SAVES_DIR}/*.zip "${INSTANCE1_SAVES_DIR}/"
  ```
  - **Source**: All `.zip` files in `/opt/seed-saves/`
  - **Destination**: `/clusterio-hosts/clusterio-host-1/instances/.../saves/`
  - **Purpose**: Copy all available save files
  - **Expected Exit**: 0

- [ ] `chown -R 999:999 "$(dirname "${INSTANCE1_SAVES_DIR}")"` 🔧 Fix ownership for factorio user
  - **User**: `factorio` (uid 999, created during image build)
  - **Purpose**: Factorio process must own files to read/write saves
  - **Applies to**: Entire instance directory and subdirectories
  - **Expected Exit**: 0

- [ ] Select save file to load:
  ```bash
  if [ -n "$INSTANCE1_SAVE_NAME" ] && [ -f "${INSTANCE1_SAVES_DIR}/${INSTANCE1_SAVE_NAME}" ]; then
    SAVE_FILE="${INSTANCE1_SAVES_DIR}/${INSTANCE1_SAVE_NAME}"
  else
    SAVE_FILE=$(ls -t "${INSTANCE1_SAVES_DIR}"/*.zip 2>/dev/null | head -n 1)
  fi
  ```
  - **Logic**:
    1. If `INSTANCE1_SAVE_NAME` is set AND file exists → Use that save
    2. Otherwise → Use newest save file (`ls -t` sorts by modification time)
  - **Example Result**: `SAVE_FILE=/clusterio-hosts/.../saves/test.zip`

- [ ] `touch "$SAVE_FILE"` 🔧 Update timestamp
  - **Purpose**: Mark this save as "newest" so Factorio server loads it by default
  - **Factorio Behavior**: When starting with `--start-server` without filename, loads newest save in `saves/` directory
  - **Expected Exit**: 0
  - **Effect**: File modification time set to current time

**Environment Variable Example** (from `.env`):
```bash
# Instance 1: Should have a platform to export (e.g., test.zip with space platform)
INSTANCE1_SAVE_NAME=test.zip

# Instance 2: Should be empty/minimal for import testing (e.g., MinSeed.zip)
INSTANCE2_SAVE_NAME=MinSeed.zip
```

**Save File Selection Logic Summary**:
| Condition | Selected Save |
|-----------|---------------|
| `INSTANCE1_SAVE_NAME=test.zip` exists | `test.zip` |
| `INSTANCE1_SAVE_NAME=""` | Newest file in `/opt/seed-saves/` |
| `INSTANCE1_SAVE_NAME=missing.zip` (doesn't exist) | Newest file in `/opt/seed-saves/` |

**Typical Save Files** (in `/opt/seed-saves/`):
- `test.zip` - Save with space platform for export testing
- `MinSeed.zip` - Minimal save for import testing (small, fast to load)
- `_autosave1.zip` - Auto-generated save (fallback)

### 4.20 Init: Create Admin List for Instance 1

**Actions**:
- [ ] `mkdir -p /clusterio-hosts/clusterio-host-1/instances/clusterio-host-1-instance-1` - Ensure directory
- [ ] `python3 -c "import json; admins='$FACTORIO_ADMINS'.split(','); print(json.dumps([a.strip() for a in admins]))"` - Convert CSV to JSON array
- [ ] → Write to `/clusterio-hosts/clusterio-host-1/instances/clusterio-host-1-instance-1/server-adminlist.json`
- [ ] `chown 999:999 /clusterio-hosts/clusterio-host-1/instances/clusterio-host-1-instance-1/server-adminlist.json` 🔧 Fix ownership

### 4.21 Init: Enable Mods in Instance 1 mod-list.json

**Actions**:
- [ ] `test -f /clusterio-hosts/clusterio-host-1/instances/clusterio-host-1-instance-1/mods/mod-list.json` - Check if file exists
- [ ] If exists: Run Python script to modify JSON:
  - [ ] `json.load()` - Read existing mod-list.json
  - [ ] Search for `{"name": "clusterio_lib"}` in mods array
  - [ ] If found: Set `"enabled": true`
  - [ ] If not found: Append `{"name": "clusterio_lib", "enabled": true}`
  - [ ] Search for `{"name": "FactorioSurfaceExport"}` in mods array
  - [ ] If found: Set `"enabled": true`
  - [ ] If not found: Append `{"name": "FactorioSurfaceExport", "enabled": true}` 🔥 **CRITICAL**
  - [ ] `json.dump()` - Write modified JSON back to file
- [ ] `chown 999:999 /clusterio-hosts/clusterio-host-1/instances/clusterio-host-1-instance-1/mods/mod-list.json` 🔧 Fix ownership

**✓ VALIDATION 3F**: Mod in mod-list.json (Instance 1)
- [ ] `grep '"FactorioSurfaceExport"' /clusterio-hosts/clusterio-host-1/instances/clusterio-host-1-instance-1/mods/mod-list.json` - Verify present
- [ ] If not found: `echo "ERROR: FactorioSurfaceExport not found in instance 1 mod-list.json"; exit 1` - Exit with error

### 4.22 Init: Assign Instance 2 to Host 2

**Actions** (If `$HOST2_READY = true`):
- [ ] `npx clusterioctl instance assign clusterio-host-2-instance-1 clusterio-host-2` 📦 Assign instance
- [ ] → Clusterio creates directory structure on host
- [ ] → `/clusterio-hosts/clusterio-host-2/instances/clusterio-host-2-instance-1/` created
- [ ] → `/clusterio-hosts/clusterio-host-2/instances/clusterio-host-2-instance-1/mods/` created
- [ ] → `/clusterio-hosts/clusterio-host-2/instances/clusterio-host-2-instance-1/mods/mod-list.json` created
- [ ] → `/clusterio-hosts/clusterio-host-2/instances/clusterio-host-2-instance-1/saves/` created

### 4.23 Init: Seed Saves for Instance 2

**Actions**: (Same as 4.19 for instance 2)
- [ ] `mkdir -p /clusterio-hosts/clusterio-host-2/instances/clusterio-host-2-instance-1/saves`
- [ ] `cp -n /opt/seed-saves/*.zip /clusterio-hosts/clusterio-host-2/instances/clusterio-host-2-instance-1/saves/`
- [ ] `chown -R 999:999 /clusterio-hosts/clusterio-host-2/instances/clusterio-host-2-instance-1`
- [ ] `ls /clusterio-hosts/clusterio-host-2/instances/clusterio-host-2-instance-1/saves/*.zip | head -n 1`
- [ ] `touch "$SAVE_FILE"` 🔧 Update timestamp

### 4.24 Init: Create Admin List for Instance 2

**Actions**: (Same as 4.20 for instance 2)
- [ ] `mkdir -p /clusterio-hosts/clusterio-host-2/instances/clusterio-host-2-instance-1`
- [ ] `python3 -c "import json; admins='$FACTORIO_ADMINS'.split(','); print(json.dumps([a.strip() for a in admins]))"`
- [ ] → Write to `/clusterio-hosts/clusterio-host-2/instances/clusterio-host-2-instance-1/server-adminlist.json`
- [ ] `chown 999:999 /clusterio-hosts/clusterio-host-2/instances/clusterio-host-2-instance-1/server-adminlist.json`

### 4.25 Init: Enable Mods in Instance 2 mod-list.json

**Actions**: (Same as 4.21 for instance 2)
- [ ] `test -f /clusterio-hosts/clusterio-host-2/instances/clusterio-host-2-instance-1/mods/mod-list.json`
- [ ] If exists: Run Python script to modify JSON:
  - [ ] Load, enable clusterio_lib
  - [ ] Enable FactorioSurfaceExport 🔥 **CRITICAL**
  - [ ] Save
- [ ] `chown 999:999 /clusterio-hosts/clusterio-host-2/instances/clusterio-host-2-instance-1/mods/mod-list.json`

**✓ VALIDATION 3F**: Mod in mod-list.json (Instance 2)
- [ ] `grep '"FactorioSurfaceExport"' /clusterio-hosts/clusterio-host-2/instances/clusterio-host-2-instance-1/mods/mod-list.json`
- [ ] If not found: `echo "ERROR: FactorioSurfaceExport not found in instance 2 mod-list.json"; exit 1`

### 4.26 Init: Start All Instances

**Actions**:
- [ ] `npx clusterioctl instance start-all` 📦 Send start command to all instances
- [ ] → Controller sends start message to each host
- [ ] → Hosts begin instance startup process (Phase 5)

### 4.27 Init: Display Summary

**Actions**:
- [ ] `npx clusterioctl --version` - Get Clusterio version
- [ ] `npx clusterioctl instance list --json | grep version` - Get Factorio version
- [ ] `grep version /opt/seed-mods/FactorioSurfaceExport_*/info.json` - Get mod version
- [ ] `grep version /opt/plugins/surface_export_plugin/package.json` - Get plugin version
- [ ] `grep controller_token /clusterio/config-control.json` - Extract admin token
- [ ] Print summary table with versions and URLs
- [ ] **Init script exits** (restart policy: "no", container stops)

**✓ VALIDATION 3G**: Init completed successfully
- [ ] `docker ps -a | grep clusterio-init | grep "Exited (0)"` - Check exit code is 0

---

## PHASE 5: Host Container Startup

### 5.1 Host Containers Start (Parallel with Init)

**Actions** (Both host-1 and host-2 simultaneously):
- [ ] `docker run -d --name clusterio-host-1 ...` - Start host-1 container
- [ ] `docker run -d --name clusterio-host-2 ...` - Start host-2 container
- [ ] `exec /opt/scripts/host-entrypoint.sh` - Run entrypoint for each host

### 5.2 Host: Create Directories

**Actions** (As root user):
- [ ] `mkdir -p /clusterio/logs` → Creates log directory
- [ ] `mkdir -p /clusterio/instances` → Creates instances directory
- [ ] `mkdir -p /clusterio/plugins` → Creates plugins directory
- [ ] `chown -R factorio:factorio /clusterio/logs` 🔧 Set ownership
- [ ] `chown -R factorio:factorio /clusterio/instances` 🔧 Set ownership
- [ ] `chown factorio:factorio /clusterio` 🔧 Set ownership

### 5.3 Host: Sync Surface Export Plugin

**Actions**:
- [ ] `rm -rf /clusterio/plugins/surface_export` - Remove old version (if exists)
- [ ] `mkdir -p /clusterio/plugins` - Ensure directory
- [ ] `cp -R /opt/seed-plugins/surface_export /clusterio/plugins/` - Copy plugin from baked image
- [ ] `chown -R factorio:factorio /clusterio/plugins` 🔧 Set ownership

### 5.4 Host: Seed Plugin List

**Actions**:
- [ ] `test -f /clusterio/plugin-list.json` - Check if already exists
- [ ] If not exists: `cp /opt/seed-plugins/plugin-list.host.json /clusterio/plugin-list.json` - Copy template
- [ ] `chown factorio:factorio /clusterio/plugin-list.json` 🔧 Set ownership

### 5.5 Host: Generate Admin List

**Actions**:
- [ ] `python3` script:
  - [ ] `admins = os.environ.get("FACTORIO_ADMINS", "").split(",")` - Parse env var
  - [ ] `admins = [a.strip() for a in admins if a.strip()]` - Clean list
  - [ ] If empty: `admins = ["admin"]` - Default to admin
  - [ ] `json.dump(admins, fh)` → Write to `/clusterio/server-adminlist.json`
- [ ] `chown factorio:factorio /clusterio/server-adminlist.json` 🔧 Set ownership
- [ ] `ln -sf /clusterio/server-adminlist.json /factorio/server-adminlist.json` - Create symlink
- [ ] `chown -h factorio:factorio /factorio/server-adminlist.json` 🔧 Set symlink ownership

### 5.6 Host: Switch to Factorio User

**Actions**:
- [ ] `su -s /bin/bash factorio` - Switch from root to factorio user (uid 999)
- [ ] All subsequent commands run as factorio user

### 5.7 Host: Wait for Config File

**Actions** (As factorio user):
- [ ] Loop up to 60 times (60 seconds):
  - [ ] `test -f /clusterio/config-host.json` - Check if config exists (created by init script)
  - [ ] If exists → Break loop
  - [ ] If not exists → `sleep 1`, retry
- [ ] If 60 attempts fail → `exit 1` with error

### 5.8 Host: Configure Factorio Paths

**Actions**:
- [ ] `npx clusteriohost config set host.factorio_directory /opt/factorio` ⚙ Set Factorio installation path
- [ ] `npx clusteriohost config set host.instances_directory /clusterio/instances` ⚙ Set instances directory

### 5.9 Host: Start Clusterio Host Service

**Actions**:
- [ ] `exec npx clusteriohost run` - Start Clusterio host
- [ ] Host reads configuration from `/clusterio/config-host.json`
- [ ] Host connects to controller via WebSocket at `ws://clusterio-controller:8080/api/socket`
- [ ] Host authenticates using token from config
- [ ] Controller marks host as "connected"
- [ ] Host waits for instance assignment (already done by init script)
- [ ] Host loads plugin list from `/clusterio/plugin-list.json`
- [ ] Host loads surface_export plugin from `/clusterio/plugins/surface_export`

**✓ VALIDATION 4A**: Host connected
- [ ] `npx clusterioctl host list | grep clusterio-host-1 | grep "connected.*true"` - Verify host 1 connected
- [ ] `npx clusterioctl host list | grep clusterio-host-2 | grep "connected.*true"` - Verify host 2 connected

---

## PHASE 6: Instance Startup

### 6.1 Host Receives Start Command

**Actions** (When init script runs `clusterioctl instance start-all`):
- [ ] Controller sends "start instance" message to host via WebSocket
- [ ] Host receives message for assigned instance (e.g., clusterio-host-1-instance-1)

### 6.2 Host: Sync Mods from Controller

**Actions**:
- [ ] Host queries controller for instance's mod pack ID
- [ ] Controller returns mod pack ID (e.g., "242390647")
- [ ] Host queries controller for mod pack contents
- [ ] Controller returns list of mods with versions (e.g., "FactorioSurfaceExport 1.0.35 enabled")
- [ ] For each mod in pack:
  - [ ] Host checks if mod exists locally: `test -f /clusterio/instances/clusterio-host-1-instance-1/mods/FactorioSurfaceExport_1.0.35.zip`
  - [ ] If not exists: Host requests mod from controller via HTTP: `GET http://clusterio-controller:8080/api/mods/FactorioSurfaceExport_1.0.35.zip`
  - [ ] Controller streams mod file from `/clusterio/mods/FactorioSurfaceExport_1.0.35.zip`
  - [ ] Host saves to `/clusterio/instances/clusterio-host-1-instance-1/mods/FactorioSurfaceExport_1.0.35.zip`
- [ ] Repeat for all ~60+ mods in pack

### 6.3 Host: Generate/Update mod-list.json

**Actions**:
- [ ] Host reads mod pack configuration (list of enabled mods)
- [ ] Host generates mod-list.json structure:
  ```json
  {
    "mods": [
      {"name": "base", "enabled": true},
      {"name": "clusterio_lib", "enabled": true},
      {"name": "FactorioSurfaceExport", "enabled": true},
      {"name": "space-age", "enabled": true},
      ...
    ]
  }
  ```
- [ ] **NOTE**: Init script already modified this file to ensure FactorioSurfaceExport is enabled
- [ ] Host may update file if mod pack changed since instance creation
- [ ] Write to `/clusterio/instances/clusterio-host-1-instance-1/mods/mod-list.json`

**✓ VALIDATION 4B**: mod-list.json correct
- [ ] `cat /clusterio/instances/clusterio-host-1-instance-1/mods/mod-list.json | grep '"FactorioSurfaceExport"'` - Mod present
- [ ] `cat /clusterio/instances/clusterio-host-1-instance-1/mods/mod-list.json | grep '"FactorioSurfaceExport".*"enabled".*true'` - Mod enabled

### 6.4 Host: Launch Factorio Server

**Actions**:
- [ ] Host builds Factorio command line:
  ```bash
  /opt/factorio/bin/x64/factorio \
    --start-server /clusterio/instances/clusterio-host-1-instance-1/saves/save-name.zip \
    --server-settings /clusterio/instances/clusterio-host-1-instance-1/server-settings.json \
    --server-adminlist /clusterio/instances/clusterio-host-1-instance-1/server-adminlist.json \
    --rcon-port 27101 \
    --rcon-password "your-password" \
    --bind 0.0.0.0:34201
  ```
- [ ] `fork()` - Host spawns Factorio as child process
- [ ] Factorio process starts with PID (e.g., 1234)
- [ ] Factorio writes to stdout/stderr (captured by host logs)

### 6.5 Factorio: Load Game

**Actions**:
- [ ] Factorio reads save file from `/clusterio/instances/clusterio-host-1-instance-1/saves/save-name.zip`
- [ ] Factorio decompresses save
- [ ] Factorio loads map data, entities, player data, etc.

### 6.6 Factorio: Load Mods

**Actions**:
- [ ] Factorio reads `/clusterio/instances/clusterio-host-1-instance-1/mods/mod-list.json`
- [ ] For each mod with `"enabled": true`:
  - [ ] Factorio checks if mod zip exists in `mods/` directory
  - [ ] If not exists → Error: "Mod not found"
  - [ ] If exists: Factorio extracts mod info from `info.json` inside zip
  - [ ] Factorio validates mod dependencies
  - [ ] Factorio loads mod's `data.lua` (if present) - Data stage
  - [ ] Factorio loads mod's `control.lua` (if present) - Control stage 🔥 **THIS LOADS OUR CODE**

### 6.7 Factorio: Initialize FactorioSurfaceExport Mod

**Actions** (FactorioSurfaceExport control.lua):
- [ ] `require("scripts.serializer")` - Load serializer module
- [ ] `require("scripts.deserializer")` - Load deserializer module
- [ ] `require("scripts.safety")` - Load safety module
- [ ] `require("scripts.util")` - Load utility module
- [ ] `require("scripts.async-processor")` - Load async processor module
- [ ] If clusterio_lib present: `require("__clusterio_lib__/api")` - Load Clusterio API
- [ ] **VALIDATION LAYER 4**: `script.on_load` fires:
  - [ ] Check if commands registered: `commands.commands["export-platform"]`
  - [ ] If not registered → `log("ERROR: Commands not registered")`
  - [ ] If registered → `log("✓ All commands registered successfully")`
- [ ] `remote.add_interface("FactorioSurfaceExport", {...})` - Register remote interface for Clusterio
- [ ] `commands.add_command("export-platform", {...})` - Register /export-platform command
- [ ] `commands.add_command("import-platform", {...})` - Register /import-platform command
- [ ] `commands.add_command("list-exports", {...})` - Register /list-exports command
- [ ] `commands.add_command("delete-export", {...})` - Register /delete-export command
- [ ] `script.on_event(defines.events.on_tick, AsyncProcessor.process_tick)` - Register tick handler
- [ ] `script.on_configuration_changed(...)` - Register config change handler

### 6.8 Factorio: Server Ready

**Actions**:
- [ ] Factorio binds game server to `0.0.0.0:34201`
- [ ] Factorio binds RCON server to `0.0.0.0:27101`
- [ ] Factorio writes "Server started" to log
- [ ] Factorio begins main game loop (60 ticks per second)
- [ ] Host detects "Server started" in Factorio output
- [ ] Host updates instance status to "running"
- [ ] Controller updates instance status to "running"

**✓ VALIDATION 4C**: Instance running
- [ ] `npx clusterioctl instance list | grep clusterio-host-1-instance-1 | grep "running"` - Check status
- [ ] `docker exec clusterio-host-1 pgrep -a factorio` - Check Factorio process exists

---

## PHASE 7: Runtime Validation

### 7.1 Validate Mod Loaded in Game

**Actions**:
- [ ] `npx clusterioctl instance rcon clusterio-host-1-instance-1 "/c rcon.print(game.active_mods['FactorioSurfaceExport'])"` - Query active mods
- [ ] Factorio executes Lua: `rcon.print(game.active_mods['FactorioSurfaceExport'])`
- [ ] If mod loaded: Returns version string (e.g., "1.0.35")
- [ ] If mod not loaded: Returns `nil`

**✓ VALIDATION 4D**: Mod loaded
- [ ] If result contains version number → Mod loaded successfully
- [ ] If result is "nil" or "NOT_LOADED" → Mod NOT loaded (deployment failed)

### 7.2 Validate Commands Registered

**Actions**:
- [ ] `npx clusterioctl instance rcon clusterio-host-1-instance-1 "/help export-platform"` - Query command help
- [ ] Factorio executes `/help export-platform`
- [ ] If command registered: Returns help text (e.g., "Usage: /export-platform...")
- [ ] If command not registered: Returns "Unknown command"

**✓ VALIDATION 4E**: Commands available
- [ ] If help text returned → Commands registered successfully
- [ ] If "Unknown command" → Commands NOT registered (mod didn't load properly)

### 7.3 Check Mod Self-Validation Logs

**Actions**:
- [ ] `docker exec clusterio-host-1 cat /clusterio/instances/clusterio-host-1-instance-1/factorio-current.log | grep FactorioSurfaceExport` - Read Factorio logs
- [ ] Search for validation messages:
  - [ ] `[FactorioSurfaceExport] ✓ All commands registered successfully` - Success
  - [ ] `[FactorioSurfaceExport] ERROR: Commands not registered` - Failure

**✓ VALIDATION 4F**: Mod self-check passed
- [ ] If success message found → Mod initialization complete
- [ ] If error message found → Investigate mod loading issue

---

## PHASE 8: Ready for Use

### 8.1 Cluster Fully Operational

**State**:
- [✓] Controller running and healthy
- [✓] Init script completed successfully (exit 0)
- [✓] Host-1 running and connected
- [✓] Host-2 running and connected
- [✓] Instance 1 running on Host-1
- [✓] Instance 2 running on Host-2
- [✓] FactorioSurfaceExport mod loaded in both instances
- [✓] Commands `/export-platform`, `/import-platform`, `/list-exports`, `/delete-export` available
- [✓] Async processor running every tick (60 Hz)

### 8.2 Test Export Command

**Actions**:
- [ ] `docker exec clusterio-controller npx clusterioctl instance rcon clusterio-host-1-instance-1 "/export-platform 1"` - Trigger export
- [ ] Factorio receives RCON command
- [ ] FactorioSurfaceExport mod processes command
- [ ] `AsyncProcessor.queue_export(platform_index=1)` - Queue export job
- [ ] Returns immediately: `"QUEUED:export_platform_name_12345_job_1"`
- [ ] Async processor processes job over multiple ticks
- [ ] Every 10 batches: Progress message (e.g., "Processing export: 250/488 entities (51%)")
- [ ] On completion: `"EXPORT_COMPLETE:export_platform_name_12345_job_1"`
- [ ] Clusterio plugin receives export data via remote interface
- [ ] Export stored in controller's platform storage

### 8.3 Test Import Command

**Actions**:
- [ ] `docker exec clusterio-controller npx clusterioctl instance rcon clusterio-host-2-instance-1 "/import-platform platform_name_12345_job_1"` - Trigger import
- [ ] Factorio receives RCON command
- [ ] FactorioSurfaceExport mod processes command
- [ ] Clusterio plugin retrieves export data from storage
- [ ] `AsyncProcessor.queue_import(export_data)` - Queue import job
- [ ] Returns immediately: `"QUEUED:import_job_2"`
- [ ] Async processor creates new platform
- [ ] Async processor places entities over multiple ticks
- [ ] Every 10 batches: Progress message
- [ ] On completion: `"IMPORT_COMPLETE:import_job_2 - Created platform 'platform_name #1'"`
- [ ] New platform visible in game with all entities

### 8.4 Verify No Game Freezing

**Expected Behavior**:
- [ ] During export: Game continues running at 60 FPS (processes 50 entities per tick by default)
- [ ] During import: Game continues running at 60 FPS (processes 50 entities per tick by default)
- [ ] Players can move, build, fight while export/import in progress
- [ ] No "Server not responding" messages
- [ ] Async job completes within reasonable time (488 entities = ~10 ticks = 166ms total)

---

## Summary Checklist
  - `/api/socket` - WebSocket for hosts/ctl
- **State**: Controller now ready to accept host connections and ctl commands

**🔍 VALIDATION POINT 2A (Controller Startup)**:
- Check `/clusterio/database/users.json` exists and contains `admin` user
- Check `/clusterio/config-controller.json` exists
- Verify controller responds: `curl http://localhost:8080/`
- Check: `docker exec clusterio-controller test -f /clusterio/database/users.json && echo "PASS" || echo "FAIL"`

---

## Phase 4: Init Script Execution (Cluster Bootstrap)

### 4.1 Init Container Overview

**Container**: `clusterio-init`  
**Script**: `/docker/clusterio-init.sh` (879 lines)  
**Working Directory**: `/clusterio`  
**Restart Policy**: `no` (one-shot, exits after completion)  
**Volumes**:
- `/clusterio` (controller's persistent data)
- `/clusterio-hosts` (host configs and instance data)

**Purpose**: Complete cluster setup after controller is healthy

### 4.2 Wait for Controller (Lines 372-392)

```bash
max_attempts=30
while [ $attempt -lt $max_attempts ]; do
  if curl -sf "${CONTROLLER_URL}" > /dev/null 2>&1; then
    echo "Controller is ready!"
    break
  fi
  sleep 2
done
```
- **URL**: `http://clusterio-controller:8080/`
- **Max Wait**: 60 seconds (30 attempts × 2s)
- **Failure**: Exit 1 if controller never responds

### 4.3 Check Existing State (Lines 394-420)

```bash
if [ -f "$CONFIG_CONTROL" ]; then
  CONTROL_CONFIG_EXISTS=true
  # Check if instances already exist
  # Check if host configs already exist
fi
```
- **Idempotency**: Skip already-completed steps
- **Checked Files**:
  - `/clusterio/config-control.json` (ctl authentication)
  - Host configs in `/clusterio-hosts/clusterio-host-{1,2}/config-host.json`
  - Instance existence via `clusterioctl instance list`

### 4.4 Create Control Config (Lines 422-435)

```bash
if [ "$CONTROL_CONFIG_EXISTS" = false ]; then
  npx clusteriocontroller bootstrap create-ctl-config admin
fi
npx clusterioctl control-config set control.controller_url "http://clusterio-controller:8080/"
```
- **File Created**: `/clusterio/config-control.json`
- **Contains**: Admin user's authentication token for `clusterioctl` commands
- **Purpose**: Authenticate all subsequent `clusterioctl` commands

**🔍 VALIDATION POINT 3A (Authentication)**:
- Verify `/clusterio/config-control.json` exists
- Test authentication: `npx clusterioctl instance list` should not error with "Unauthorized"
- Check: `docker exec clusterio-init npx clusterioctl instance list 2>&1 | grep -v "Unauthorized"`

### 4.5 Create Instances (Lines 437-472)

**Instance 1**:
```bash
if ! clusterioctl instance list | grep -q "clusterio-host-1-instance-1"; then
  npx clusterioctl instance create clusterio-host-1-instance-1 --id 1
fi
```
- **Name**: `clusterio-host-1-instance-1`
- **Instance ID**: 1
- **State**: Created but not assigned to a host yet

**Instance 2**:
```bash
if ! clusterioctl instance list | grep -q "clusterio-host-2-instance-1"; then
  npx clusterioctl instance create clusterio-host-2-instance-1 --id 2
fi
```
- **Name**: `clusterio-host-2-instance-1`
- **Instance ID**: 2

**Configure Instance Settings** (Lines 474-509):
```bash
# Instance 1
clusterioctl instance config set clusterio-host-1-instance-1 factorio.game_port 34201
clusterioctl instance config set clusterio-host-1-instance-1 factorio.rcon_port 27101
clusterioctl instance config set clusterio-host-1-instance-1 factorio.rcon_password "your-password"
clusterioctl instance config set clusterio-host-1-instance-1 factorio.enable_save_patching true
clusterioctl instance config set clusterio-host-1-instance-1 factorio.settings '{"name":"...","auto_pause":false}'
clusterioctl instance config set clusterio-host-1-instance-1 factorio.sync_adminlist "bidirectional"
clusterioctl instance config set clusterio-host-1-instance-1 instance.auto_start true  # If FACTORIO_AUTO_START=true

# Instance 2 (similar configuration)
```

**Storage**: Instance configs stored in controller's database

### 4.6 Create Host Configs (Lines 511-551)

**Host 1 Config**:
```bash
if [ ! -f "${HOSTS_DIR}/clusterio-host-1/config-host.json" ]; then
  npx clusterioctl host create-config \
    --name clusterio-host-1 \
    --id 1 \
    --generate-token \
    --output "${HOSTS_DIR}/clusterio-host-1/config-host.json"
fi
```
- **File Created**: `/clusterio-hosts/clusterio-host-1/config-host.json`
- **Contains**:
  - Host authentication token
  - Controller URL
  - Host ID and name

**Host 2 Config** (similar):
- **File Created**: `/clusterio-hosts/clusterio-host-2/config-host.json`

**Update Controller URLs** (Lines 541-551):
```bash
# Replace localhost with container DNS name
sed -i "s|http://localhost:8080/|http://clusterio-controller:8080/|" config-host.json
```
- **Purpose**: Hosts connect via Docker network DNS, not localhost

**🔍 VALIDATION POINT 3B (Host Configs)**:
- Verify both host config files exist
- Verify they contain valid authentication tokens
- Check controller URL is `http://clusterio-controller:8080/` (not localhost)

### 4.7 Add Plugins (Lines 553-577)

```bash
declare -a PREINSTALLED_PLUGINS=(
  "global_chat:/usr/lib/node_modules/@clusterio/plugin-global_chat"
  "inventory_sync:/usr/lib/node_modules/@clusterio/plugin-inventory_sync"
  "player_auth:/usr/lib/node_modules/@clusterio/plugin-player_auth"
  "research_sync:/usr/lib/node_modules/@clusterio/plugin-research_sync"
  "statistics_exporter:/usr/lib/node_modules/@clusterio/plugin-statistics_exporter"
  "surface_export:/opt/seed-plugins/surface_export"  # Our custom plugin
)

for plugin_entry in "${PREINSTALLED_PLUGINS[@]}"; do
  npx clusterioctl plugin add "$plugin_path"
done
```
- **Purpose**: Register plugins with controller
- **Critical**: `surface_export` plugin handles platform export/import events

**🔍 VALIDATION POINT 3C (Plugins)**:
- Verify surface_export plugin registered: `clusterioctl plugin list | grep surface_export`

### 4.8 Build and Upload clusterio_lib (Lines 579-599)

```bash
if [ ! -f "/usr/lib/node_modules/@clusterio/host/dist/clusterio_lib_2.0.20.zip" ]; then
  cd /usr/lib/node_modules/@clusterio/host
  npm run build-mod -- --output-dir ./dist
fi

# Upload to controller
npx clusterioctl mod upload /usr/lib/node_modules/@clusterio/host/dist/clusterio_lib_2.0.20.zip
```
- **File Uploaded**: `/clusterio/mods/clusterio_lib_2.0.20.zip`
- **Purpose**: IPC bridge between Factorio Lua and Clusterio Node.js

### 4.9 Create Mod Pack (Lines 601-620)

```bash
MOD_PACK_ID=$(get_mod_pack_id "$MOD_PACK_NAME")
if [ -z "$MOD_PACK_ID" ]; then
  npx clusterioctl mod-pack create "my-server-pack" "2.0"
  MOD_PACK_ID=$(get_mod_pack_id "$MOD_PACK_NAME")
fi
```
- **Mod Pack Name**: `my-server-pack`
- **Factorio Version**: `2.0`
- **Mod Pack ID**: e.g., `242390647` (auto-generated)
- **Storage**: `/clusterio/database/mod-packs/`

### 4.10 Upload Seed Mods (Lines 622-665) 🔥 **CRITICAL FOR MOD LOADING**

**Function**: `seed_mod_pack_mods()` (Lines 142-229)

**Process**:
1. **Scan seed directory**: Find all `.zip` files in `/opt/seed-mods/`
2. **Parallel upload** (batch size 15):
   ```bash
   for mod_zip in *.zip; do
     npx clusterioctl mod upload "$mod_zip" &
   done
   wait
   ```
3. **Extract mod names and versions** from filenames:
   - `FactorioSurfaceExport_1.0.35.zip` → name: `FactorioSurfaceExport`, version: `1.0.35`
4. **Track results**:
   - Success: Append `FactorioSurfaceExport:1.0.35` to `/tmp/clusterio_uploaded_mods`
   - Failure: Append `filename|reason` to `/tmp/clusterio_failed_mods`

**Upload Destinations** (on controller filesystem):
- `/clusterio/mods/FactorioSurfaceExport_1.0.35.zip`
- `/clusterio/mods/space-age_2.0.0.zip`
- `/clusterio/mods/quality_2.0.0.zip`
- `/clusterio/mods/elevated-rails_2.0.0.zip`
- Plus ~60 other mods from seed-data

**🔍 VALIDATION POINT 3D (Mod Upload)**:
- Verify FactorioSurfaceExport uploaded: `ls -lh /clusterio/mods/FactorioSurfaceExport_1.0.35.zip`
- Check mod portal: `clusterioctl mod list | grep FactorioSurfaceExport`
- Expected: `FactorioSurfaceExport  1.0.35  [uploaded timestamp]`

### 4.11 Add Mods to Pack (Lines 667-685) 🔥 **CRITICAL FOR MOD LOADING**

```bash
# Batch add all uploaded mods to pack
while read -r mod_entry; do  # Format: "name:version"
  mod_name="${mod_entry%:*}"
  add_args+=(--add-mods "$mod_entry" --enable-mods "$mod_name")
done < /tmp/clusterio_uploaded_mods

# Apply in chunks of 20 mods
npx clusterioctl mod-pack edit "my-server-pack" "${add_args[@]}"
```

**Key Operations**:
1. `--add-mods FactorioSurfaceExport:1.0.35` → Register mod in pack
2. `--enable-mods FactorioSurfaceExport` → Set enabled=true

**Enable Built-in DLC** (Lines 231-260):
```bash
npx clusterioctl mod-pack edit "$pack_name" \
  --add-mods space-age:2.0.0 --enable-mods space-age
npx clusterioctl mod-pack edit "$pack_name" \
  --add-mods quality:2.0.0 --enable-mods quality
npx clusterioctl mod-pack edit "$pack_name" \
  --add-mods elevated-rails:2.0.0 --enable-mods elevated-rails
```

**Explicit Critical Dependencies** (Lines 262-268):
```bash
add_mod_to_pack_if_missing "clusterio_lib" "2.0.20" "$MOD_PACK_NAME"
add_mod_to_pack_if_missing "FactorioSurfaceExport" "1.0.34" "$MOD_PACK_NAME"  # ❌ HARDCODED OLD VERSION!
add_mod_to_pack_if_missing "stdlib2" "2.0.1" "$MOD_PACK_NAME"
add_mod_to_pack_if_missing "flib" "0.16.5" "$MOD_PACK_NAME"
```

---

## Quick Reference: Critical Files Created

| Phase | File | Purpose |
|-------|------|---------|
| 1.5 | `/opt/seed-mods/FactorioSurfaceExport_1.0.35.zip` | Mod zip baked into image |
| 1.6 | `/usr/lib/node_modules/@clusterio/host/dist/clusterio_lib_2.0.20.zip` | IPC bridge mod |
| 3.2 | `/clusterio/config-controller.json` | Controller configuration |
| 3.3 | `/clusterio/database/users.json` | Admin user credentials |
| 4.3 | `/clusterio/config-control.json` | Ctl authentication token |
| 4.7 | `/clusterio-hosts/clusterio-host-1/config-host.json` | Host 1 auth config |
| 4.7 | `/clusterio-hosts/clusterio-host-2/config-host.json` | Host 2 auth config |
| 4.10 | `/clusterio/mods/FactorioSurfaceExport_1.0.35.zip` | Mod uploaded to controller |
| 4.12 | `/tmp/clusterio_uploaded_mods` | Upload tracking (temp) |
| 4.21 | `/clusterio-hosts/.../mods/mod-list.json` | Instance 1 mod config 🔥 |
| 4.25 | `/clusterio-hosts/.../mods/mod-list.json` | Instance 2 mod config 🔥 |
| 5.3 | `/clusterio/plugins/surface_export/` | Plugin synced to volume |
| 6.2 | `/clusterio-hosts/.../mods/FactorioSurfaceExport_1.0.35.zip` | Mod synced to instance |

---

## Troubleshooting: Command Trace for Common Issues

### Issue: "Commands not registered" or "FactorioSurfaceExport mod not loaded"

**Complete Diagnostic Command Sequence**:

#### 1. Verify Base Image Contains Mod

```powershell
# Check if mod was baked into base image
docker run --rm factorio-surface-export/base:latest ls -lh /opt/seed-mods/ | Select-String "FactorioSurfaceExport"
```
**Expected Output**:
```
-rw-r--r-- 1 root root 107.7K Jan 26 12:00 FactorioSurfaceExport_1.0.35.zip
```
**If Missing**: Rebuild base image with `docker-compose build base`

#### 2. Verify Controller Has Mod File

```powershell
# Check controller filesystem
docker exec clusterio-controller ls -lh /clusterio/mods/ | Select-String "FactorioSurfaceExport"
```
**Expected Output**:
```
-rw-r--r-- 1 factorio factorio 107.7K Jan 26 12:00 FactorioSurfaceExport_1.0.35.zip
```
**If Missing**: Init script failed during mod upload (check init logs)

#### 3. Verify Controller Mod Database

```powershell
# Check Clusterio's mod registry
docker exec clusterio-controller npx clusterioctl --log-level error mod list 2>$null | Select-String "FactorioSurfaceExport"
```
**Expected Output**:
```
FactorioSurfaceExport  1.0.35  2026-01-26 12:00:00
```
**If Missing**: Mod file exists but wasn't registered (upload command failed)

#### 4. Verify Mod in Mod Pack

```powershell
# Get mod pack contents
$packName = "my-server-pack"
docker exec clusterio-controller npx clusterioctl --log-level error mod-pack show $packName 2>$null | Select-String "FactorioSurfaceExport"
```
**Expected Output**:
```
FactorioSurfaceExport  1.0.35  enabled   required: flib, stdlib2
```
**If Missing**: Mod wasn't added to pack (check init script validation points)
**If "disabled"**: Mod in pack but not enabled (run `clusterioctl mod-pack edit --enable-mods FactorioSurfaceExport`)

#### 5. Verify Mod Synced to Host

```powershell
# Check host 1 instance mods directory
docker exec clusterio-host-1 ls -lh /clusterio/instances/clusterio-host-1-instance-1/mods/ | Select-String "FactorioSurfaceExport"
```
**Expected Output**:
```
-rw-r--r-- 1 factorio factorio 107.7K Jan 26 12:01 FactorioSurfaceExport_1.0.35.zip
```
**If Missing**: Instance never started OR mod sync failed (check host logs)

#### 6. Verify Mod in mod-list.json 🔥 **MOST COMMON ISSUE**

```powershell
# Check mod-list.json contents
docker exec clusterio-host-1 cat /clusterio/instances/clusterio-host-1-instance-1/mods/mod-list.json | ConvertFrom-Json | Select-Object -ExpandProperty mods | Where-Object {$_.name -eq "FactorioSurfaceExport"}
```
**Expected Output**:
```json
{
  "name": "FactorioSurfaceExport",
  "enabled": true
}
```
**If Missing**: Init script didn't enable mod in mod-list.json (see Root Cause RC2)
**If `"enabled": false`**: Mod present but disabled

**IMMEDIATE FIX** (if mod is missing or disabled):
```powershell
# Stop instance
docker exec clusterio-controller npx clusterioctl instance stop clusterio-host-1-instance-1

# Manually edit mod-list.json using Python
docker exec clusterio-host-1 python3 -c @"
import json
with open('/clusterio/instances/clusterio-host-1-instance-1/mods/mod-list.json', 'r') as f:
    data = json.load(f)
# Add FactorioSurfaceExport if not present
if not any(mod['name'] == 'FactorioSurfaceExport' for mod in data.get('mods', [])):
    data.setdefault('mods', []).append({'name': 'FactorioSurfaceExport', 'enabled': True})
# Ensure it's enabled
for mod in data.get('mods', []):
    if mod['name'] == 'FactorioSurfaceExport':
        mod['enabled'] = True
with open('/clusterio/instances/clusterio-host-1-instance-1/mods/mod-list.json', 'w') as f:
    json.dump(data, f, indent=2)
"@

# Restart instance
docker exec clusterio-controller npx clusterioctl instance start clusterio-host-1-instance-1

# Wait 20 seconds for Factorio to start
Start-Sleep -Seconds 20
```

#### 7. Verify Mod Loaded in Game (Runtime Check)

```powershell
# Query Factorio's active mods via RCON
docker exec clusterio-controller npx clusterioctl instance rcon clusterio-host-1-instance-1 "/c rcon.print(game.active_mods['FactorioSurfaceExport'] or 'NOT_LOADED')" 2>$null
```
**Expected Output**:
```
1.0.35
```
**If "NOT_LOADED"**: Mod in mod-list.json but Factorio didn't load it
  - **Possible Causes**:
    - Mod dependencies missing (check `flib`, `stdlib2`)
    - Mod syntax error (check Factorio logs)
    - Wrong Factorio version (mod built for 2.0, server running 1.1)

#### 8. Verify Commands Registered

```powershell
# Test command availability
docker exec clusterio-controller npx clusterioctl instance rcon clusterio-host-1-instance-1 "/help export-platform" 2>$null
```
**Expected Output**:
```
/export-platform [platform_name_or_index] - Async export a space platform to JSON.
Exports are saved to storage and can be listed with /list-exports.
The export happens over multiple ticks to avoid server lag.
```
**If "Unknown command"**: Mod loaded but commands not registered
  - **Check Mod Self-Validation Logs** (Layer 4):
    ```powershell
    docker exec clusterio-host-1 cat /clusterio/instances/clusterio-host-1-instance-1/factorio-current.log | Select-String "FactorioSurfaceExport"
    ```
  - **Look For**:
    - `[FactorioSurfaceExport] ✓ All commands registered successfully` - Success
    - `[FactorioSurfaceExport] ERROR: Commands not registered` - Mod didn't initialize properly

#### 9. Check Init Script Exit Code

```powershell
# Verify init container exited successfully
docker ps -a | Select-String "clusterio-init"
```
**Expected Output**:
```
... clusterio-init ... Exited (0) 5 minutes ago
```
**If "Exited (1)"**: Init script failed (check logs)
```powershell
docker logs clusterio-init 2>&1 | Select-String "ERROR"
```

#### 10. Full Validation Check

```powershell
# Run all validation points in sequence
.\tools\validate-cluster.ps1
```
**Expected Output**: All tests pass (exit code 0)

---

### Issue: "Init script exits with error"

**Check Validation Points**:

```powershell
# Get init logs
$logs = docker logs clusterio-init 2>&1 | Out-String

# Check each validation point
$logs | Select-String "✓.*FactorioSurfaceExport.*confirmed on controller"        # 3D
$logs | Select-String "✓.*FactorioSurfaceExport.*confirmed enabled in mod pack" # 3E
$logs | Select-String "✓.*FactorioSurfaceExport confirmed in instance.*mod-list" # 3F
```

**If Validation 3D Fails** (Mod upload):
- **Symptom**: `ERROR: FactorioSurfaceExport not found in controller mods`
- **Cause**: Mod file missing from `/opt/seed-mods/` in base image
- **Fix**: Rebuild base image
  ```powershell
  cd docker
  docker-compose build --no-cache base
  docker-compose up -d
  ```

**If Validation 3E Fails** (Mod pack):
- **Symptom**: `ERROR: FactorioSurfaceExport not enabled in mod pack`
- **Cause**: Hardcoded version mismatch (Line 664 of init script)
- **Fix**: Manually add mod to pack
  ```powershell
  docker exec clusterio-init npx clusterioctl mod-pack edit my-server-pack `
    --add-mods FactorioSurfaceExport:1.0.35 `
    --enable-mods FactorioSurfaceExport
  ```

**If Validation 3F Fails** (mod-list.json):
- **Symptom**: `ERROR: FactorioSurfaceExport not found in instance mod-list.json`
- **Cause**: Init script only enables `clusterio_lib` (RC2)
- **Fix**: See "Verify Mod in mod-list.json" section above

---

### Issue: "Instance won't start" or "Factorio crashes on startup"

**Check Instance Status**:

```powershell
# Get instance status
docker exec clusterio-controller npx clusterioctl instance list
```
**Look For**: Status should be `running`, not `stopped` or `error`

**Check Factorio Logs**:

```powershell
# Get Factorio output
docker exec clusterio-host-1 cat /clusterio/instances/clusterio-host-1-instance-1/factorio-current.log | Select-Object -Last 100
```

**Common Error Patterns**:

1. **"Error while loading mod"**:
   - **Cause**: Mod syntax error, missing dependency, or version mismatch
   - **Solution**: Check mod `info.json` dependencies, ensure `flib` and `stdlib2` present

2. **"Couldn't establish RCON connection"**:
   - **Cause**: RCON port conflict or incorrect password
   - **Solution**: Check `.env` file `HOST1_INSTANCE1_RCON_PORT` and `RCON_PASSWORD`

3. **"Failed to load save"**:
   - **Cause**: Save file corrupted or incompatible with Factorio version
   - **Solution**: Use different save file (update `INSTANCE1_SAVE_NAME` in `.env`)

**Check Host Logs**:

```powershell
# Get Clusterio host output
docker logs clusterio-host-1 2>&1 | Select-Object -Last 50
```

---

### Issue: "Mod pack changes not reflected in instance"

**Scenario**: You updated the mod pack but instance still uses old mods

**Root Cause**: Clusterio doesn't automatically restart instances when mod pack changes

**Solution**:

```powershell
# 1. Stop instance
docker exec clusterio-controller npx clusterioctl instance stop clusterio-host-1-instance-1

# 2. Clear mod-list.json (forces regeneration from mod pack)
docker exec clusterio-host-1 rm /clusterio/instances/clusterio-host-1-instance-1/mods/mod-list.json

# 3. Start instance (will sync mods from updated mod pack)
docker exec clusterio-controller npx clusterioctl instance start clusterio-host-1-instance-1

# 4. Wait for startup
Start-Sleep -Seconds 20

# 5. Verify mod loaded
docker exec clusterio-controller npx clusterioctl instance rcon clusterio-host-1-instance-1 "/c rcon.print(game.active_mods['FactorioSurfaceExport'])"
```

---

### Issue: "Export/import commands work but data not transferred"

**Check Plugin Status**:

```powershell
# Verify surface_export plugin loaded
docker exec clusterio-controller npx clusterioctl plugin list | Select-String "surface_export"
```
**Expected**: `surface_export  enabled  /opt/seed-plugins/surface_export`

**Check Plugin Logs**:

```powershell
# Controller logs (plugin runs here)
docker logs clusterio-controller 2>&1 | Select-String "surface_export"

# Look for export/import messages
docker logs clusterio-controller 2>&1 | Select-String "platform.*export|platform.*import"
```

**Test Export Manually**:

```powershell
# Trigger export via RCON
docker exec clusterio-controller npx clusterioctl instance rcon clusterio-host-1-instance-1 "/export-platform 1"
```
**Expected**: `QUEUED:export_[platform_name]_[timestamp]_job_[id]`

**Check Storage**:

```powershell
# List platform exports in controller storage
docker exec clusterio-controller ls -lh /clusterio/platforms/
```

---

### Performance Diagnostics

**Check Async Processor Performance**:

```powershell
# Export large platform and monitor progress
docker exec clusterio-controller npx clusterioctl instance rcon clusterio-host-1-instance-1 "/export-platform 1"

# Watch for progress messages (every 10 batches)
docker logs -f clusterio-host-1 2>&1 | Select-String "Processing export:|entities"
```

**Expected Output**:
```
Processing export: 50/488 entities (10%)
Processing export: 100/488 entities (20%)
...
Processing export: 488/488 entities (100%)
EXPORT_COMPLETE
```

**If export is slow** (>1 second):
- Check `BATCH_SIZE` in mod code (default: 50 entities/tick)
- Increase batch size for faster exports (may cause frame drops)

---

### Docker Volume Diagnostics

**Check Volume Mounts**:

```powershell
# List Docker volumes
docker volume ls | Select-String "clusterio"
```

**Inspect Volume Contents**:

```powershell
# Check controller volume
docker run --rm -v factoriosurfaceexport_clusterio-controller-data:/data alpine ls -lR /data

# Check host-1 volume
docker run --rm -v factoriosurfaceexport_clusterio-host-1-data:/data alpine ls -lR /data
```

**Reset Everything** (nuclear option):

```powershell
# Stop all containers
docker-compose down

# Remove volumes (DELETES ALL DATA)
docker volume rm factoriosurfaceexport_clusterio-controller-data
docker volume rm factoriosurfaceexport_clusterio-host-1-data
docker volume rm factoriosurfaceexport_clusterio-host-2-data

# Rebuild and start fresh
docker-compose up -d
```

---

## Performance Notes

**Parallel Operations**:
- Mod uploads: 15 concurrent (reduces init time from ~5min to ~1min)
- Host startups: 2 concurrent (host-1 and host-2 start together)
- Instance mods sync: Sequential (but fast due to local network)

**Timing** (Typical):
- Phase 1 (Build): 3-5 minutes (first time), 10-30 seconds (cached)
- Phase 2-3 (Controller start): 15-30 seconds
- Phase 4 (Init script): 60-120 seconds (mod uploads dominate)
- Phase 5 (Host start): 5-10 seconds
- Phase 6 (Instance start): 10-20 seconds per instance
- **Total**: ~2-3 minutes for full cluster deployment

**Async Export/Import** (Once running):
- 488 entities at 50/tick = 10 ticks = 166ms total
- 1000 entities at 100/tick = 10 ticks = 166ms total
- No game freezing, smooth 60 FPS maintained

---

## Validation Summary

| Point | Phase | What | How to Verify |
|-------|-------|------|---------------|
| 1A | Build | Mod baked | `docker run --rm base:latest ls /opt/seed-mods/FactorioSurfaceExport_1.0.35.zip` |
| 2A | Controller | Admin user | `docker exec controller test -f /clusterio/database/users.json && echo OK` |
| 3A | Init | Auth works | `docker exec init npx clusterioctl instance list` (no "Unauthorized") |
| 3B | Init | Host configs | `docker exec init test -f /clusterio-hosts/clusterio-host-1/config-host.json && echo OK` |
| 3C | Init | Plugin added | `docker exec controller npx clusterioctl plugin list | grep surface_export` |
| 3D | Init | Mod uploaded | `docker exec controller npx clusterioctl mod list | grep "FactorioSurfaceExport.*1.0.35"` |
| 3E | Init | Mod in pack | `docker exec controller npx clusterioctl mod-pack show my-server-pack | grep "FactorioSurfaceExport.*enabled"` |
| 3F | Init | Mod in list | `docker exec host-1 grep '"FactorioSurfaceExport"' /clusterio/instances/.../mods/mod-list.json` |
| 3G | Init | Init done | `docker ps -a | grep clusterio-init | grep "Exited (0)"` |
| 4A | Host | Connected | `docker exec controller npx clusterioctl host list | grep "connected.*true"` |
| 4B | Instance | mod-list | `docker exec host-1 grep '"FactorioSurfaceExport".*"enabled".*true' /clusterio/instances/.../mods/mod-list.json` |
| 4C | Instance | Running | `docker exec controller npx clusterioctl instance list | grep "running"` |
| 4D | Runtime | Mod loaded | `docker exec controller npx clusterioctl instance rcon instance-1 "/c rcon.print(game.active_mods['FactorioSurfaceExport'])"` |
| 4E | Runtime | Commands | `docker exec controller npx clusterioctl instance rcon instance-1 "/help export-platform"` |
| 4F | Runtime | Self-check | `docker exec host-1 cat /clusterio/instances/.../factorio-current.log | grep "FactorioSurfaceExport.*commands registered"` |

---

## End of Checklist

**Document Version**: 2.0 (Action-Based)  
**Last Updated**: Implementation of 4-layer validation system  
**Related Documents**:
- [VALIDATION_IMPLEMENTATION.md](VALIDATION_IMPLEMENTATION.md) - Validation layer details
- [tools/validate-cluster.ps1](../tools/validate-cluster.ps1) - Automated validation script

### 4.12 Assign Mod Pack to Instances (Lines 687-693)

```bash
MOD_PACK_ID="242390647"  # Retrieved from controller

npx clusterioctl instance config set clusterio-host-1-instance-1 factorio.mod_pack_id "$MOD_PACK_ID"
npx clusterioctl instance config set clusterio-host-2-instance-1 factorio.mod_pack_id "$MOD_PACK_ID"
```
- **Storage**: Instance config in controller database
- **Purpose**: Tell instances which mods to load

### 4.13 Wait for Host Connections (Lines 695-725)

```bash
# Function: wait_for_host_connection (Lines 340-364)
max_attempts=90  # 180 seconds
while [ $attempt -lt $max_attempts ]; do
  list_output=$(npx clusterioctl host list)
  # Parse for host name and connected=true
  sleep 2
done
```
- **Purpose**: Hosts must be connected before instance assignment
- **Timeout**: 3 minutes per host

### 4.14 Assign Instances to Hosts (Lines 727-855) 🔥 **CRITICAL FOR MOD-LIST.JSON**

**Instance 1 Assignment**:
```bash
npx clusterioctl instance assign clusterio-host-1-instance-1 clusterio-host-1
```
- **Effect**: Clusterio creates instance directory structure on host
- **Directory Created**: `/clusterio/instances/clusterio-host-1-instance-1/`
- **Files Created**:
  - `mods/mod-list.json` 🔥 **This is where mod loading is controlled**
  - `config.ini`
  - `saves/` directory

**Seed Saves** (Lines 735-755):
```bash
INSTANCE1_SAVES_DIR="${HOSTS_DIR}/clusterio-host-1/instances/clusterio-host-1-instance-1/saves"
mkdir -p "${INSTANCE1_SAVES_DIR}"
cp -n ${SEED_SAVES_DIR}/*.zip "${INSTANCE1_SAVES_DIR}/"
chown -R 999:999 "$(dirname "${INSTANCE1_SAVES_DIR}")"

# Mark newest save
SAVE_FILE=$(ls "${INSTANCE1_SAVES_DIR}"/*.zip | head -n 1)
touch "$SAVE_FILE"
```

**Create Admin List** (Lines 757-763):
```bash
INSTANCE1_ADMINLIST="${HOSTS_DIR}/clusterio-host-1/instances/.../server-adminlist.json"
python3 -c "import json; admins=['admin']; json.dump(admins, sys.stdout)" > "${INSTANCE1_ADMINLIST}"
```

**Enable clusterio_lib in mod-list.json** (Lines 765-784) 🔥 **ONLY clusterio_lib IS ENABLED HERE**:
```bash
INSTANCE1_MODLIST="${HOSTS_DIR}/clusterio-host-1/instances/clusterio-host-1-instance-1/mods/mod-list.json"
if [ -f "${INSTANCE1_MODLIST}" ]; then
  python3 <<'PYENABLE1'
import json
with open("${INSTANCE1_MODLIST}", "r") as f:
    mod_list = json.load(f)
for mod in mod_list.get("mods", []):
    if mod["name"] == "clusterio_lib":
        mod["enabled"] = True
        break
else:
    mod_list.setdefault("mods", []).append({"name": "clusterio_lib", "enabled": True})
with open("${INSTANCE1_MODLIST}", "w") as f:
    json.dump(mod_list, f, indent=2)
PYENABLE1
fi
```

**🚨 ROOT CAUSE IDENTIFIED**: 
- Init script ONLY enables `clusterio_lib` in mod-list.json
- Init script does NOT enable `FactorioSurfaceExport` or any other mods
- **Expected Behavior**: Clusterio host should sync mod-list.json from mod pack when instance starts
- **Actual Behavior**: This sync may not happen if instance is already assigned

**🔍 VALIDATION POINT 3F (Instance Files)**:
- Check instance directory exists: `test -d /clusterio-hosts/clusterio-host-1/instances/clusterio-host-1-instance-1/`
- Check mod-list.json exists: `test -f .../mods/mod-list.json`
- **Check mod-list.json contents**:
  ```bash
  cat /clusterio-hosts/clusterio-host-1/instances/clusterio-host-1-instance-1/mods/mod-list.json
  ```
- Expected (CORRECT): All mods from mod pack enabled
- Actual (BUG): Only clusterio_lib enabled

**Instance 2 Assignment**: (Lines 786-833, identical process)

### 4.15 Start All Instances (Lines 857-863)

```bash
npx clusterioctl instance start-all
```
- **Effect**: Send start command to all instances
- **Instance Startup**: Handled by host (Phase 5)

### 4.16 Init Complete (Lines 865-879)

```bash
echo "Cluster initialization complete!"
exit 0
```
- **Container State**: Exits successfully
- **Restart Policy**: `no` (container stops and does not restart)

**🔍 VALIDATION POINT 3G (Init Completion)**:
- Check init container exited successfully: `docker ps -a | grep clusterio-init`
- Expected: Exit code 0
- Check logs: `docker logs clusterio-init 2>&1 | tail -50`

---

## Phase 5: Host Startup

### 5.1 Host Entrypoint (`host-entrypoint.sh`)

**Containers**: `clusterio-host-1`, `clusterio-host-2`  
**Working Directory**: `/clusterio`  
**Initial User**: `root` (switches to `factorio` user later)

**Step 1: Create Directories** (Lines 7-10)
```bash
mkdir -p /clusterio/logs /clusterio/instances /clusterio/plugins
chown -R factorio:factorio /clusterio/logs /clusterio/instances
```

**Step 2: Sync Plugin to Persistent Volume** (Lines 12-18)
```bash
PLUGIN_SRC="/opt/seed-plugins/surface_export"
PLUGIN_DST="/clusterio/plugins/surface_export"
rm -rf "${PLUGIN_DST}"
cp -R "${PLUGIN_SRC}" "${PLUGIN_DST}"
chown -R factorio:factorio /clusterio/plugins
```
- **Purpose**: Copy plugin from baked image to persistent volume
- **Ensures**: Latest plugin code is always used

**Step 3: Seed Plugin List** (Lines 20-26)
```bash
PLUGIN_LIST="/clusterio/plugin-list.json"
PLUGIN_LIST_TEMPLATE="/opt/seed-plugins/plugin-list.host.json"
if [ ! -f "${PLUGIN_LIST}" ]; then
  cp "${PLUGIN_LIST_TEMPLATE}" "${PLUGIN_LIST}"
fi
```

**Step 4: Generate Admin List** (Lines 36-60)
```bash
FACTORIO_ADMINS="${FACTORIO_ADMINS:-admin}"
python3 <<'PY'
import json
admins = ["admin"]  # From env var
with open("/clusterio/server-adminlist.json", "w") as fh:
    json.dump(admins, fh, indent=2)
PY
ln -sf /clusterio/server-adminlist.json /factorio/server-adminlist.json
```

**Step 5: Switch to Factorio User** (Lines 63-93)
```bash
su -s /bin/bash factorio <<'FACTORIO_USER'
  # Wait for host config (created by init service)
  while [ ! -f "/clusterio/config-host.json" ]; do
    sleep 1
  done
  
  # Configure Factorio directory
  npx clusteriohost config set host.factorio_directory /opt/factorio
  npx clusteriohost config set host.instances_directory /clusterio/instances
  
  # Start host
  exec npx clusteriohost run
FACTORIO_USER
```

**🔍 VALIDATION POINT 4A (Host Startup)**:
- Check hosts connected: `clusterioctl host list`
- Expected: Both hosts show `connected: true`
- Check logs: `docker logs clusterio-host-1 2>&1 | grep "Host started"`

### 5.2 Host Runtime Behavior

**When Instance Start Command Received**:

1. **Sync Mods from Controller** (Clusterio automatic):
   - Download mod files from `/clusterio/mods/` (controller) → `/clusterio/instances/.../mods/` (host)
   - **Mods synced**: All mods in the assigned mod pack
   - **Files copied**:
     - `FactorioSurfaceExport_1.0.35.zip`
     - `clusterio_lib_2.0.20.zip`
     - All other mods in pack

2. **Generate mod-list.json** (Clusterio automatic) 🔥 **THIS IS WHERE IT SHOULD HAPPEN**:
   - Read mod pack configuration from controller
   - Create/update `mods/mod-list.json` with enabled mods
   - **Expected Structure**:
     ```json
     {
       "mods": [
         {"name": "base", "enabled": true},
         {"name": "clusterio_lib", "enabled": true},
         {"name": "FactorioSurfaceExport", "enabled": true},
         {"name": "space-age", "enabled": true},
         ...
       ]
     }
     ```

3. **Launch Factorio Server**:
   ```bash
   /opt/factorio/bin/x64/factorio \
     --start-server /clusterio/instances/.../saves/save-name.zip \
     --server-settings /clusterio/instances/.../server-settings.json \
     --rcon-port 27101 \
     --rcon-password "your-password"
   ```

4. **Factorio Loads Mods**:
   - Read `mods/mod-list.json`
   - Load each enabled mod's `control.lua`
   - **If FactorioSurfaceExport enabled**: Register commands `/export-platform`, `/import-platform`, `/list-exports`, etc.
   - **If FactorioSurfaceExport NOT enabled**: Commands not registered

**🔍 VALIDATION POINT 4B (Instance Running)**:
- Check instance status: `clusterioctl instance list`
- Expected: Status `running`
- Check Factorio process: `docker exec clusterio-host-1 pgrep -a factorio`

**🔍 VALIDATION POINT 4C (Mod Loading)** 🔥 **FINAL VALIDATION**:
- Check mod-list.json contents:
  ```bash
  docker exec clusterio-host-1 cat /clusterio/instances/clusterio-host-1-instance-1/mods/mod-list.json
  ```
- Check loaded mods via RCON:
  ```bash
  docker exec clusterio-controller npx clusterioctl instance rcon clusterio-host-1-instance-1 "/c rcon.print(game.active_mods['FactorioSurfaceExport'] or 'NOT LOADED')"
  ```
- Check registered commands:
  ```bash
  docker exec clusterio-controller npx clusterioctl instance rcon clusterio-host-1-instance-1 "/help export-platform"
  ```
- Expected: Command help text
- Actual (if bug present): "Unknown command"

---

## Phase 6: Steady State

### 6.1 Running State

**Controller**: 
- Manages cluster state
- Hosts mod files at `/clusterio/mods/`
- Stores mod pack configurations

**Hosts**:
- Run Factorio server processes
- Sync mods from controller on instance start
- Handle instance lifecycle

**Instances**:
- Factorio game servers
- Load mods from `mods/` directory according to `mods/mod-list.json`
- Respond to RCON commands

### 6.2 Mod Synchronization Flow (Clusterio Automatic)

**Trigger**: Instance start/restart

1. Host queries controller for instance's mod pack ID
2. Host downloads mod pack metadata (list of mods + versions)
3. Host downloads mod `.zip` files if not already present locally
4. Host generates `mod-list.json` from mod pack enabled mods
5. Host starts Factorio server
6. Factorio loads mods from `mod-list.json`

**🚨 OBSERVED BUG**: This flow may not happen correctly if:
- Instance was already assigned when init script enabled only clusterio_lib
- Mod pack was updated after instance was created
- Host doesn't trigger full mod sync on subsequent starts

---

## Validation Strategy: Insertion Points

### Layer 1: Init Script Validation (Prevent Bad Deployments)

**File**: `docker/clusterio-init.sh`

**Insertion Point 3D (After Mod Upload)** - Line ~660:
```bash
# After seed_mod_pack_mods completes
echo "Validating FactorioSurfaceExport upload..."
if ! npx clusterioctl --log-level error mod list 2>/dev/null | grep -q "FactorioSurfaceExport.*${SURFACE_EXPORT_MOD_VERSION}"; then
    echo "ERROR: FactorioSurfaceExport ${SURFACE_EXPORT_MOD_VERSION} not found in controller mods"
    exit 1
fi
```

**Insertion Point 3E (After Mod Pack Edit)** - Line ~693:
```bash
# After add_mod_to_pack_if_missing calls
echo "Validating FactorioSurfaceExport in mod pack..."
PACK_CONTENTS=$(npx clusterioctl --log-level error mod-pack show "$MOD_PACK_NAME" 2>/dev/null)
if ! echo "$PACK_CONTENTS" | grep -q "FactorioSurfaceExport.*${SURFACE_EXPORT_MOD_VERSION}.*enabled"; then
    echo "ERROR: FactorioSurfaceExport ${SURFACE_EXPORT_MOD_VERSION} not enabled in mod pack"
    exit 1
fi
```

**Insertion Point 3F (After Instance Assignment)** - Line ~834:
```bash
# After instance assignment and mod-list.json modification
echo "Validating instance mod-list.json..."
INSTANCE_MODLIST="${HOSTS_DIR}/clusterio-host-1/instances/clusterio-host-1-instance-1/mods/mod-list.json"
if [ -f "${INSTANCE_MODLIST}" ]; then
    if ! grep -q '"name"[[:space:]]*:[[:space:]]*"FactorioSurfaceExport"' "${INSTANCE_MODLIST}"; then
        echo "WARNING: FactorioSurfaceExport not in mod-list.json, adding it..."
        python3 <<'PYADD'
import json
with open("${INSTANCE_MODLIST}", "r") as f:
    mod_list = json.load(f)
mod_list.setdefault("mods", []).append({"name": "FactorioSurfaceExport", "enabled": True})
with open("${INSTANCE_MODLIST}", "w") as f:
    json.dump(mod_list, f, indent=2)
PYADD
    fi
fi
```

### Layer 2: PowerShell Profile Functions (User-Friendly Checks)

**File**: `$PROFILE` (PowerShell profile)

**Function**: `Test-FactorioModLoaded`
```powershell
function Test-FactorioModLoaded {
    param([int]$HostNum = 1, [int]$InstanceNum = 1)
    $instanceName = "clusterio-host-${HostNum}-instance-${InstanceNum}"
    
    # Check instance running
    $status = docker exec clusterio-controller npx clusterioctl instance list 2>$null | Select-String $instanceName
    if (-not $status) {
        Write-Host "❌ Instance $instanceName not found" -ForegroundColor Red
        return $false
    }
    
    # Check mod loaded in game
    $result = docker exec clusterio-controller npx clusterioctl instance rcon $instanceName "/c rcon.print(game.active_mods['FactorioSurfaceExport'] or 'NOT_LOADED')" 2>$null
    if ($result -match "NOT_LOADED") {
        Write-Host "❌ FactorioSurfaceExport NOT loaded in $instanceName" -ForegroundColor Red
        
        # Check mod-list.json
        $modListPath = "/clusterio-hosts/clusterio-host-${HostNum}/instances/${instanceName}/mods/mod-list.json"
        $modList = docker exec clusterio-host-${HostNum} cat $modListPath 2>$null
        if ($modList -match '"FactorioSurfaceExport"') {
            Write-Host "   Mod IS in mod-list.json but not loaded (restart needed?)" -ForegroundColor Yellow
        } else {
            Write-Host "   Mod NOT in mod-list.json (deployment issue!)" -ForegroundColor Red
        }
        return $false
    }
    
    # Extract version
    $version = $result -replace '.*FactorioSurfaceExport.*?(\d+\.\d+\.\d+).*', '$1'
    Write-Host "✓ FactorioSurfaceExport $version loaded in $instanceName" -ForegroundColor Green
    return $true
}
```

**Integration with `rclist` alias**:
```powershell
function rclist {
    docker exec clusterio-controller npx clusterioctl instance list
    Test-FactorioModLoaded -HostNum 1 -InstanceNum 1
    Test-FactorioModLoaded -HostNum 2 -InstanceNum 1
}
```

### Layer 3: E2E Validation Script (Pre-Flight Testing)

**File**: `tools/validate-cluster.ps1`

```powershell
#!/usr/bin/env pwsh
# Comprehensive cluster validation

$ErrorActionPreference = "Stop"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Clusterio Cluster Validation" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

$exitCode = 0

# Test 1: Containers Running
Write-Host "[1/6] Checking containers..." -NoNewline
$containers = @("clusterio-controller", "clusterio-host-1", "clusterio-host-2")
$missingContainers = @()
foreach ($container in $containers) {
    $running = docker ps --filter "name=$container" --filter "status=running" -q
    if (-not $running) {
        $missingContainers += $container
    }
}
if ($missingContainers.Count -eq 0) {
    Write-Host " ✓ PASS" -ForegroundColor Green
} else {
    Write-Host " ✗ FAIL" -ForegroundColor Red
    Write-Host "   Missing: $($missingContainers -join ', ')" -ForegroundColor Red
    $exitCode = 1
}

# Test 2: Mod Exists on Controller
Write-Host "[2/6] Checking mod on controller..." -NoNewline
$modList = docker exec clusterio-controller ls /clusterio/mods/ 2>$null | Select-String "FactorioSurfaceExport"
if ($modList) {
    $version = $modList -replace '.*_(\d+\.\d+\.\d+)\.zip.*', '$1'
    Write-Host " ✓ PASS (v$version)" -ForegroundColor Green
} else {
    Write-Host " ✗ FAIL (mod file not found)" -ForegroundColor Red
    $exitCode = 2
}

# Test 3: Instances Started
Write-Host "[3/6] Checking instances..." -NoNewline
$instances = docker exec clusterio-controller npx clusterioctl instance list 2>$null
$runningInstances = ($instances | Select-String "running" | Measure-Object).Count
if ($runningInstances -ge 2) {
    Write-Host " ✓ PASS ($runningInstances running)" -ForegroundColor Green
} else {
    Write-Host " ✗ FAIL (only $runningInstances running)" -ForegroundColor Red
    $exitCode = 3
}

# Test 4: Mod in mod-list.json
Write-Host "[4/6] Checking mod-list.json..." -NoNewline
$modList1 = docker exec clusterio-host-1 cat /clusterio/instances/clusterio-host-1-instance-1/mods/mod-list.json 2>$null
if ($modList1 -match '"FactorioSurfaceExport"') {
    Write-Host " ✓ PASS" -ForegroundColor Green
} else {
    Write-Host " ✗ FAIL (not in mod-list.json)" -ForegroundColor Red
    $exitCode = 4
}

# Test 5: Mod Loaded in Game
Write-Host "[5/6] Checking mod loaded in game..." -NoNewline
$result = docker exec clusterio-controller npx clusterioctl instance rcon clusterio-host-1-instance-1 "/c rcon.print(game.active_mods['FactorioSurfaceExport'] or 'NOT_LOADED')" 2>$null
if ($result -match "NOT_LOADED") {
    Write-Host " ✗ FAIL (not loaded)" -ForegroundColor Red
    $exitCode = 5
} else {
    $version = $result -replace '.*(\d+\.\d+\.\d+).*', '$1'
    Write-Host " ✓ PASS (v$version)" -ForegroundColor Green
}

# Test 6: Commands Registered
Write-Host "[6/6] Checking commands..." -NoNewline
$help = docker exec clusterio-controller npx clusterioctl instance rcon clusterio-host-1-instance-1 "/help export-platform" 2>$null
if ($help -match "export-platform|Usage:|async") {
    Write-Host " ✓ PASS" -ForegroundColor Green
} else {
    Write-Host " ✗ FAIL (command not registered)" -ForegroundColor Red
    $exitCode = 6
}

Write-Host "`n========================================" -ForegroundColor Cyan
if ($exitCode -eq 0) {
    Write-Host "All tests passed!" -ForegroundColor Green
} else {
    Write-Host "Validation failed with exit code $exitCode" -ForegroundColor Red
}
Write-Host "========================================`n" -ForegroundColor Cyan

exit $exitCode
```

**Usage**:
```powershell
# After deployment
.\tools\validate-cluster.ps1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Validation failed, not proceeding with testing"
    exit 1
}
```

### Layer 4: Mod Self-Check (Runtime Defensive Validation)

**File**: `src/surface_export_mod/control.lua`

**Insertion Point**: After `script.on_load` (Line ~10):
```lua
script.on_load(function()
    -- Verify commands were registered
    local expected_commands = {
        "export-platform",
        "import-platform",
        "list-exports",
        "delete-export"
    }
    
    local missing_commands = {}
    for _, cmd_name in ipairs(expected_commands) do
        if not commands.commands[cmd_name] then
            table.insert(missing_commands, cmd_name)
        end
    end
    
    if #missing_commands > 0 then
        log("[FactorioSurfaceExport] ERROR: Commands not registered: " .. serpent.line(missing_commands))
        log("[FactorioSurfaceExport] This indicates the mod was not loaded properly during on_init/on_configuration_changed")
        
        -- Attempt to re-register (may not work if on_init never ran)
        for _, cmd_name in ipairs(missing_commands) do
            log("[FactorioSurfaceExport] Attempting to register " .. cmd_name)
        end
    else
        log("[FactorioSurfaceExport] All commands registered successfully")
    end
end)
```

---

## Summary: Root Cause Analysis

### Issue
FactorioSurfaceExport v1.0.35 deployed but not available in instances (commands not registered)

### Root Causes Identified

**RC1: Init Script Hardcoded Version** (Line 664):
```bash
add_mod_to_pack_if_missing "FactorioSurfaceExport" "1.0.34" "$MOD_PACK_NAME"
```
- Should use: `"${SURFACE_EXPORT_MOD_VERSION}"`
- Effect: Mod pack may reference old version even if new version uploaded

**RC2: Init Script Only Enables clusterio_lib** (Lines 765-784):
```bash
# Only enables clusterio_lib in mod-list.json
# Does NOT enable FactorioSurfaceExport or other mods
```
- Expected: Clusterio host syncs mod-list.json from mod pack on instance start
- Actual: If instance already assigned, mod-list.json may not be regenerated
- Effect: Old mod-list.json with only clusterio_lib persists

**RC3: Manual Mod Pack Update Timing**:
- User manually updated mod pack after deployment: `--remove-mods FactorioSurfaceExport --add-mods FactorioSurfaceExport:1.0.35`
- Instance was already running at this point
- Clusterio does not automatically restart instances when mod pack changes
- Effect: Instance continues running with old mod-list.json

### Fix Strategy

**Immediate Fix** (Manual):
1. Stop instances: `clusterioctl instance stop-all`
2. Remove old mod-list.json files
3. Start instances: `clusterioctl instance start-all`
4. Clusterio will regenerate mod-list.json from current mod pack

**Permanent Fix** (Code Changes):
1. Fix Line 664 to use `${SURFACE_EXPORT_MOD_VERSION}`
2. Add validation after mod upload (Layer 1)
3. Add validation after mod pack edit (Layer 1)
4. Modify init script to enable ALL mod pack mods in mod-list.json, not just clusterio_lib
5. Add PowerShell helper functions (Layer 2)
6. Create validation script (Layer 3)
7. Add mod self-check logging (Layer 4)

---

## Next Steps

1. **Fix init script** (2 changes):
   - Line 664: Replace hardcoded version
   - Lines 765-834: Enable all mod pack mods in mod-list.json

2. **Add validation layers**:
   - Layer 1: 3 validation points in init script
   - Layer 2: PowerShell profile function
   - Layer 3: Standalone validation script
   - Layer 4: Mod self-check logging

3. **Test fix**:
   - Rebuild base image with fixed mod version
   - Redeploy cluster
   - Run validation script
   - Verify commands available

4. **Document**:
   - Update CLUSTERIO_SETUP.md with validation steps
   - Add troubleshooting section for mod loading issues
