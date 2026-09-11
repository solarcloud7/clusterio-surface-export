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
node tools/clusterio/read-cluster-logs.mjs 'error|transfer|validation' 20 2000
docker compose logs --tail 100
```

The log reader arguments are a regular expression, the maximum matches to display per
source, and the number of raw lines to search. No matches only describes that bounded
window. Logs and downloaded diagnostics can contain player or platform information;
review them before sharing.

## Supervised alpha

This is an operating recommendation for a monitored development cluster, not a
production Compose profile. The controller HTTP port is published on all interfaces
by default, the seed instances enable public visibility and debug mode, and plugin
source is writable in the containers. Decide access restrictions before inviting
testers; a localhost URL does not restrict who can reach the published port.

Use these settings explicitly and verify them after the required instance restart:

| Scope | Setting | Alpha starting point |
|---|---|---|
| Instance | `surface_export.max_concurrent_jobs` | `1`: one shared import/export job step per tick, not a millisecond cap |
| Controller | `surface_export.max_inflight_transfers_per_instance` | `1` for serial admission; `2` is the locally exercised overlap configuration, still experimental |
| Instance | `surface_export.sectioned_codec` | `false`: keep the experimental codec off |
| Instance | `surface_export.belt_trace` | `false` outside a targeted investigation |
| Instance | `surface_export.profile_batches` | `false`; phase totals remain available |
| Instance | `surface_export.debug_destination_snapshot` | `false`; avoid the optional full success scan |
| Instance | `surface_export.debug_mode` | Review explicitly: plugin and seed defaults are `true`; do not assume a production diagnostic default |

Controller Settings does not expose every experimental setting. Instance settings
belong to the instance configuration. See [configuration ownership](../docs/config-survey.md).
Changing a setting is separate from proving its behavior; this guide does not change
the running cluster's configuration.

### What has been exercised

The pinned acceptance environment is Factorio 2.1.17 with Space Age and Clusterio
2.0.0-alpha.27. The [manual acceptance notes](../tests/manual/transfer-reliability/README.md)
retain exact runs and independent cargo/settings comparisons. Blueprint comparisons
cover 1,830 visible entities across three fixtures, not every runtime entity property.
Three opposing transfers passed with admission capacity two and one shared Lua step;
lost deletion/release replies also passed with controller restart.

Those fixture sizes are observations, not supported maximums. There is no certified
mod compatibility list, maximum platform size, maximum callback duration or FPS/UPS
guarantee. One large inventory or belt group and native codec work remain indivisible.
Measure each representative world before expanding the alpha.

### Installation and upgrade evidence

The [CI workflow](../.github/workflows/ci.yml) tests development setup and, on release
tags or manual dispatch, installation/recovery of the exact tarball that publishing
will consume. The [consumer acceptance report](../tests/manual/consumer-install/evidence/accepted-0.10.281.json)
also records a fresh upstream installation, new saves, real locale/icons, browser UI
and physical cargo recovery. Neither test published the package or migrated an older
release. The [packaged profile](production/README.md) supplies the separate deployment
path; this page's root Compose instructions remain for development.

Before an external release, retain the package version/hash, image digests, mod-pack
versions and configuration, then retain evidence for these paths in a disposable environment:

1. Install the exact release artifact and verify login, locale/icons, plugin UI and a
   transfer with independent cargo comparison.
2. Upgrade a previous supported version with existing saves and an unresolved handoff;
   verify world identity, recovery and retained transaction details.
3. Exercise a compatible code rollback. Do not substitute an older world or journal
   to roll back code; doing so changes transfer authority and needs reconciliation.

### Incident and backup procedure

For a failed or uncertain transfer, stop issuing new transfers involving those
instances. Preserve the canonical operation ID, diagnostic report, failed stage,
source/destination identities and the cleanup or rollback acknowledgement. Repair
availability first; the retained recovery worker retries every 30 seconds when both
instances are online. A timeout is not permission to force-unlock or delete a copy.
Follow the [operator recovery contract](../docs/TRANSFER_2PC.md#startup-and-operator-recovery)
when identity or journal reconciliation refuses.

A backup must include controller data (including recovery intents and payloads),
both hosts' data (including instance retirement journals and saves), configuration,
token material and the controller static volume. Preserve secrets privately and
record the code/image/mod versions. The running volumes are listed in Compose;
pre-deploy saves alone omit external transfer authority.

The [coordinated restore report](../tests/manual/transfer-reliability/evidence/backup-restore-2.1.17.json)
passed a stopped, same-runtime seven-volume restore with completed history and an
uncertain transfer. Original volume contents were erased, restored archives compared,
and independent cargo/recovery observations retained. This covers that lab's volume
set. Full host rebuild, off-host transport, mixed generations, and the packaged
profile's volume set still require acceptance. Do not restore a partial backup set
and assume the passing coordinated drill applies.
