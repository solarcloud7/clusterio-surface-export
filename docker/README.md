# Local Clusterio development cluster

The root Compose file starts one controller and two hosts using pinned images from the Clusterio Docker project. It mounts this checkout's plugin source and seeds test instances. This is a development setup; see [production readiness](../README.md#before-production) for remaining operating requirements.

## First startup

Run from the canonical checkout with Docker Desktop and PowerShell 7:

```powershell
Copy-Item .env.example .env
# Edit .env: set INIT_CLUSTERIO_ADMIN and any required Factorio credentials.
docker volume create factorio-client-2117
./tools/clusterio/build-plugin.ps1 -Target all
./tools/surface-export/build-gateway-mod.ps1 -SkipClientSync
docker compose pull
docker compose up -d
node tools/clusterio/ci-await-seeding.mjs
node tools/tests/cluster-readiness.mjs --runtime
```

Do not overwrite an existing `.env`. The instance versions are pinned in their `instance.json` files; the container release is pinned separately by `CLUSTERIO_IMAGE_TAG` in `.env.example`.

The external `factorio-client-2117` volume belongs to this cluster. Keep that name for this checkout; use a different name for another cluster on the same Docker host. Host 1 provisions the graphical client used for icon/locale export; host 2 skips that client. Factorio credentials are required for the client download.

Access the controller at [localhost:8080](http://localhost:8080). The local admin-token helper is `tools/clusterio/get-admin-token.ps1`; treat its output as a credential.

## Update without resetting saves

```powershell
# Web bundle only
./tools/clusterio/deploy.ps1 -Scope artifacts -Target web -RestartController

# Save-patched Lua only
./tools/clusterio/deploy.ps1 -Scope lua -KeepSaves

# Rebuild plugin/web and patch the existing saves
./tools/clusterio/deploy.ps1 -Scope plugin -KeepSaves
```

The preserving reload creates pre-deploy saves, stops/restarts the affected instances, and checks their versions, platform/surface counts, and player positions. Use the isolated build helper; installing packages in the live plugin mount can introduce a second Clusterio library and break runtime commands.

`deploy.ps1 -Scope cluster`, Lua/plugin deployment without `-KeepSaves`, and `docker compose down -v` are reset paths. Reserve them for disposable test clusters. Local Docker volumes and pre-deploy saves are not an off-host backup.

## Steam client mods

The offline sync tool copies this checkout's seed archives into the local Factorio client. It does not resolve the live controller's mod pack or prove that unrelated client mods are compatible.

```powershell
# Copy seed mods; explicitly prune only versions that shadow the selected seeds
./tools/clusterio/sync-client-mods.ps1 -PruneShadowing

# Build and sync the gateway mod; optionally remove its old client versions
./tools/surface-export/build-gateway-mod.ps1 -PruneOldClientVersions
```

Duplicate seed versions are accepted only when filename-last and numeric-newest select the same archive. Divergent selection is refused before copying or pruning. General sync preserves the client's mod list; the gateway builder updates only its gateway entry. Restart Factorio after changing client mods.

## Paths and diagnostics

| Path | Purpose |
|---|---|
| `docker/seed-data/external_plugins/surface_export/` | Plugin source and built artifacts mounted by the containers |
| `docker/seed-data/mods-src/surfexp_gateways/` | Gateway mod source |
| `docker/seed-data/mods/` | Locally built/downloaded mod archives |
| `docker/seed-data/hosts/<host>/<instance>/` | Seed instance configuration and saves |
| `docker/seed-data/lab-saves/` | Paired test fixtures; not the running world |

Running state is in the named volumes declared by [docker-compose.yml](../docker-compose.yml). Container names are `surface-export-controller`, `surface-export-host-1`, and `surface-export-host-2`; `clusterio-host-*` names are hostnames, not Docker container names.

```powershell
./tools/clusterio/show-cluster-status.ps1
node tools/clusterio/read-cluster-logs.mjs --help
docker compose logs --tail 100
```
