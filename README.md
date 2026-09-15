# Clusterio Surface Export

Transfer Factorio Space Age platforms between Clusterio instances. The project
contains a TypeScript plugin, a save-patched Lua module and the gateway mod.

Install the plugin package into Clusterio and add the
[gateway mod](https://mods.factorio.com/mod/surfexp_gateways) to its mod pack.
Use the [installation guide](docs/admins/deployment.md#release-availability)
to install the compatible `0.11.0-beta.2` release explicitly. This repository's Docker
setup is for development and acceptance tests. Use [Clusterio](https://github.com/clusterio/clusterio#installation) or
[clusterio-docker](https://github.com/solarcloud7/clusterio-docker) to host the cluster.

**Status: development / pre-production.** Bounded transfer/recovery, coordinated
volume restoration and packaged fresh-install fixtures pass. Upgrade compatibility,
broader disaster recovery and supported operating limits remain open. The root
Docker cluster is a development environment.

## Start here

- [Use gateways and transfer platforms](docs/users/transfers.md)
- [Read outcomes and audit evidence](docs/users/transaction-logs.md)
- [Install and update the Clusterio plugin](docs/admins/deployment.md)
- [Configure the plugin](docs/admins/configuration.md)
- [Back up and recover worlds](docs/admins/recovery.md)
- [Set up development](docs/developers/setup.md)
- [Build, test and contribute](docs/developers/workflow.md)
- [Understand Clusterio integration](docs/developers/clusterio-integration.md)

The [documentation index](docs/README.md) also covers queues, batching, validation,
timing and recovery records for technical readers.

## What it does

The plugin captures supported entity state, tiles, inventories, belt items, fluids
and connections. It restores them in stages, validates destination cargo and
coordinates source deletion and destination release. Standalone export/import and
explicit snapshot recovery create copies and have different ownership behavior.

Gateways shows queued and active operations. Transaction Logs retains summaries,
audit evidence and measured timings according to configured limits. Controller
settings and per-instance batching/diagnostic settings have separate owners.

Lua runs synchronously inside each callback. Jobs share deterministic work limits
and yield at selected boundaries; native codec calls and large individual work
units can still stall simulation. Ticks and measured milliseconds are separate.
See [batching](docs/technical/batching.md) and [timing](docs/technical/timing.md).

## Verification and limits

The recorded package and consumer acceptance used **0.10.281**, Clusterio
**2.0.0-alpha.27** and Factorio Space Age **2.1.17**. Those results identify
historically tested artifacts, not a certification of every later source revision
or a statement about the currently published release. The current seed runtime and
dependency pins are in their configuration; the Docker image revision is in
[.env.example](.env.example).

| Area | Retained evidence and limits |
|---|---|
| Transfer recovery | [Manual fixtures](tests/manual/transfer-reliability/README.md) cover their save-policy, lost-reply and crash boundaries with independent cargo checks. Original failures remain recorded. |
| Destination save rollback | The [original rollback case](tests/manual/transfer-reliability/README.md#destination-save-rollback) left a missing platform. Explicit snapshot restoration is a separate import, not automatic repair of that old outcome. |
| Backup/restore | [Docker acceptance fixture](tests/manual/production-profile/README.md) restored all twelve resolved stores into fresh resources on the same machine/image pair, then checked cargo, history, settings, authentication, assets and another transfer. Mixed generations and off-host disaster recovery remain separate cases. |
| Installation | [Package acceptance](tests/manual/package-install/README.md) and [consumer installation](tests/manual/consumer-install/README.md) record exact bytes, fresh worlds and native checks. Fresh installation is not proof of historical upgrade or code-rollback compatibility. |
| Performance | [Retained experiments](tests/README.md) identify fixture sizes and measured boundaries. There is no general no-lag, platform-size or transfer-duration guarantee. |

Do not treat an unavailable status as permission to replay an import or unlock a
protected source. Follow [recovery](docs/admins/recovery.md) and preserve both worlds
and their matching journals before intervention.

## Repository map

| Path | Purpose |
|---|---|
| [Plugin](docker/seed-data/external_plugins/surface_export/) | Controller, instance bridge, CLI, web UI and Lua module |
| [Gateway mod](docker/seed-data/mods-src/surfexp_gateways/) | Factorio prototypes and graphics |
| [Tools](tools/) | Build, deployment, diagnostics and test helpers |
| [Tests](tests/) | Regressions, fixtures and retained experiments |
| [Documentation](docs/README.md) | Human guides by task and audience |

Use [Issues](https://github.com/solarcloud7/clusterio-surface-export/issues/new/choose)
for actionable bugs, [Discussions](https://github.com/solarcloud7/clusterio-surface-export/discussions)
for questions, and [private reporting](SECURITY.md) for security concerns.
See [contributing](docs/developers/contributing.md).

## License

[MIT](LICENSE.md).
