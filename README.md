# Clusterio Surface Export

Transfer Factorio Space Age platforms between Clusterio instances. The project contains a TypeScript plugin, a save-patched Lua module, and the gateway mod.

**Status: development / pre-production.** Local transfer and rollback fixtures pass, but crash-safe commit ordering and a production operating profile remain unfinished. The included Docker cluster is a development environment.

## What it does

- Captures supported entity state, tiles, inventories, belt items, fluids, and connections.
- Restores entities and belt groups in batches, with yields between safe import phases.
- Checks destination item quantities by item and quality, and fluid quantities through the transfer validation gate. A failed check triggers recovery; item loss is not an acceptable tolerance.
- Shows transfer progress on the gateway map and retains transaction summaries, detailed audit evidence, and measured timings according to configured limits.
- Exposes controller retention and timeout settings in the Settings tab; batching and diagnostics are configured per instance.

Lua work runs synchronously within each callback. Source belt capture, serialization, tiles, and other individual phases can still stall the simulation. Tick counts and measured milliseconds are separate signals. See [batching and timing](docs/async-processing.md) for boundaries and measured fixture results; there is no general no-lag or transfer-time guarantee.

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
node tools/clusterio/read-cluster-logs.mjs --help

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

## Before production

Readiness review: 2026-09-08. These are remaining acceptance gates, not guarantees supplied by the existing green tests.

| Priority | Work | Why it matters / acceptance evidence | Effort |
|---|---|---|---|
| Blocking | Establish crash durability and backup reconciliation | Destination activation now follows acknowledged source deletion; refusal, replay and controller restart fixtures pass. Prove recovery through abrupt process loss and older-save restoration, including expired intents and receipts. [Current protocol and pending work](docs/TRANSFER_2PC.md). | Large |
| Blocking | Define a production deployment profile | Compose currently mounts writable source, patches static caching for development, exposes HTTP, and seeds debug-enabled public instances. Define immutable artifacts, intended exposure/authentication, and diagnostic defaults. | Medium |
| Blocking | Exercise backup and restore | Restore controller state, artifacts, tokens, and paired instance saves after a simulated loss; document the recovery point and reconcile in-flight transfers. Local pre-deploy saves alone do not establish this. | Medium |
| Before broader rollout | Bound and measure expensive callbacks | Phase yields are verified, but individual phases remain synchronous. Test representative large platforms and publish measured limits for supported sizes/mods. | Medium |
| Release gate | Test the exact release artifact and upgrade path | Run full CI plus fresh-install, preserved-save upgrade, and rollback checks against the version being shipped. Publishing already waits for both CI jobs; a published version alone is not production acceptance. | Medium |

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
