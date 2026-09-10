# Clusterio Surface Export

Transfer Factorio Space Age platforms between Clusterio instances. The project contains a TypeScript plugin, a save-patched Lua module, and the gateway mod.

**Status: development / pre-production.** Bounded transfer, rollback, lost-reply and source-restart fixtures pass. Coordinated backup restoration and a production operating profile remain release gates. The included Docker cluster is a development environment.

## What it does

- Captures supported entity state, tiles, inventories, belt items, fluids, and connections.
- Restores entities and belt groups in batches, with yields between safe import phases.
- Checks destination item quantities by item and quality, and fluid quantities through the transfer validation gate. A failed check triggers recovery; item loss is not an acceptable tolerance.
- Shows transfer progress on the gateway map and retains transaction summaries, detailed audit evidence, and measured timings according to configured limits.
- Exposes controller retention and timeout settings in the Settings tab; batching and diagnostics are configured per instance.

Lua work runs synchronously within each callback. Import and export jobs share a tick budget, and tiles and several restoration phases yield between batches. Native JSON/compression calls, large belt groups and other indivisible work can still stall the simulation. Tick counts and measured milliseconds are separate signals. See [batching and timing](docs/async-processing.md) for boundaries and measured fixture results; there is no general no-lag or transfer-time guarantee.

## Local development

Use the canonical checkout with Docker Desktop and PowerShell 7. The current seed instances pin Factorio **2.1.17**; package dependencies pin Clusterio **2.0.0-alpha.27**. The container image tag is pinned separately in [.env.example](.env.example).

Follow [Docker setup](docker/README.md) for first startup and client-mod synchronization. Once the cluster is running:

```powershell
# Web-only changes
./tools/clusterio/deploy.ps1 -Scope artifacts -Target web -RestartController

# Lua changes: back up and reload the current saves
./tools/clusterio/deploy.ps1 -Scope lua -KeepSaves

# Plugin + web + Lua changes, preserving current saves
./tools/clusterio/deploy.ps1 -Scope plugin -KeepSaves

# Read cluster logs
node tools/clusterio/read-cluster-logs.mjs 'error|transfer|validation' 20 2000

# List the integration suites before choosing a live test
node tools/tests/run-integration-tests.mjs --list
```

Use the isolated build helper instead of installing dependencies into the live bind-mounted plugin directory. Save-preserving reload creates local pre-deploy saves and checks the resulting world; it is not an off-host backup service. Destructive reset commands belong only on disposable development/test clusters.

## Use

Open **Surface Export -> Gateways**, select a platform, and confirm its destination. The controller queues overlapping requests. Follow the operation in **Transaction Logs**, including its validation evidence and cleanup or rollback result.

The in-game command is `/transfer-platform <platform_index> <destination_instance_id>`. Use actual instance IDs, not host numbers. See the [transfer walkthrough](docs/QUICK_START.md) and [command reference](docs/commands-reference.md).

Export/import can also create independent copies; it is distinct from a transfer that removes the source after destination validation.

## Checks

```powershell
./tools/clusterio/build-plugin.ps1 -Target lint
./tools/clusterio/build-plugin.ps1 -Target test
npm test
lua tests/lua/import-phase-yields.lua
```

Run build/deploy/browser workflows sequentially; they share a checkout lock. Live suites can transfer or reset fixtures, so use their documented prerequisites. See [tests](tests/README.md), [testing contracts](docs/testing.md), and [CI](docs/CI_CD.md).

For manually triggered, automated reply-loss, crash, save-rollback and callback-cost experiments,
run `npm run test:manual:transfers -- --list`. The [manual Docker lab](tests/manual/transfer-reliability/README.md)
creates a disposable cluster and preserves the live development cluster. These cases do not run in ordinary CI.

## Before production

Readiness review: main after PR #306. Its fast, gallery and integration checks passed. Local runtime-version and advertised web-bundle checks also passed after syncing the canonical checkout. These checks do not prove a packaged release or a coordinated disaster restore.

For a supervised alpha, use the [operating profile and incident procedure](docker/README.md#supervised-alpha). Broader rollout still needs the following acceptance evidence.

| Priority | Work | Why it matters / acceptance evidence | Effort |
|---|---|---|---|
| Blocking | Complete crash durability and backup reconciliation | Lost replies, controller restart, abrupt source-host loss and earlier source-save restoration have bounded passing fixtures. Restoring older controller/journal state together with worlds, destination rollback after release, missing journals and receipt eviction still need acceptance evidence. [Current protocol and limits](docs/TRANSFER_2PC.md). | Large |
| Blocking | Define a production deployment profile | Compose currently mounts writable source, patches static caching for development, exposes HTTP, and seeds debug-enabled public instances. Define immutable artifacts, intended exposure/authentication, and diagnostic defaults. | Medium |
| Blocking | Extend backup and restore acceptance | The [quiesced volume restore drill](tests/manual/transfer-reliability/backup-restore.md) passes with completed history and an uncertain transfer. It erases/restores all seven lab volumes and checks exact cargo and recovery. Full host rebuild, mixed backup generations and off-host backup handling remain untested. Local pre-deploy saves alone do not establish these. | Medium |
| Before broader rollout | Bound and measure expensive callbacks | Phase yields are verified, but individual phases remain synchronous. Test representative large platforms and publish measured limits for supported sizes/mods. | Medium |
| Release gate | Test the exact release artifact and upgrade path | CI boots a fresh development cluster from checkout artifacts; local save-preserving deployment is also exercised. Repeat installation, upgrade and compatible rollback using the exact packaged release. Publishing waits for fast checks and both integration matrix legs; a published version alone is not production acceptance. | Medium |

## Repository map

| Path | Purpose |
|---|---|
| [Plugin](docker/seed-data/external_plugins/surface_export/) | Controller, instance bridge, CLI, web UI, shared types, and Lua module |
| [Gateway mod](docker/seed-data/mods-src/surfexp_gateways/) | Factorio prototypes and gateway graphics |
| [Tools](tools/) | Build, deployment, diagnostics, and test helpers |
| [Tests](tests/) | Unit tests, live regressions, retained experiments, and fixtures |
| [Documentation](docs/README.md) | Focused reference index |

## Troubleshooting

- **Validation failed:** inspect the failed stage and item/entity/fluid evidence in Transaction Logs. Preserve the diagnostic report; do not dismiss item differences as expected loss.
- **Cleanup failed:** inspect both instances before retrying. The destination may already exist while the source remains. Follow the [recovery contract](docs/TRANSFER_2PC.md).
- **Jobs do not advance:** check that the instance is running and game ticks are advancing. A paused simulation cannot process tick-batched jobs.
- **Old web UI or Lua code:** use the matching deployment command above; web builds and save-patched Lua have separate reload paths.

## License

[MIT](LICENSE.md).
