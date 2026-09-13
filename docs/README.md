# Documentation

Start with the [project overview and verification limits](../README.md). These references describe the current implementation, commands, and recorded evidence.

| Reference | Purpose |
|---|---|
| [Docker setup](../docker/README.md) | Local cluster, preserving saves, and Steam client mod sync |
| [Transfer walkthrough](QUICK_START.md) | Start a transfer and inspect its outcome |
| [Commands](commands-reference.md) | In-game, RCON, and remote interfaces |
| [Export/import flow](EXPORT_IMPORT_FLOW.md) | Message routes and restoration boundaries |
| [Batching and timing](async-processing.md) | Tick scheduling, synchronous limits, profiler measurements, and acceptance evidence |
| [Upload sessions and job status](upload-job-status.md) | Buffer ownership, queue observation, protocol bounds, and disposable acceptance |
| [Handoff and recovery](TRANSFER_2PC.md) | Transfer ordering, receipts, startup reconciliation, and save recovery |
| [Troubleshooting](ENGINEERING_FAQ.md) | Failure states and diagnostic interpretation |
| [Transfer logs](TRANSFER_LOGS.md) | Audit records and inspection |
| [Configuration](CONFIGURATION.md) | Registered settings, defaults, ownership, and restart behavior |
| [Gateways](GATEWAYS.md) | In-game routes, passenger handling, and the web canvas |
| [Testing](testing.md) | Fixture contracts, physical oracles, and live-test rules |
| [CI](CI_CD.md) | Checks, integration environment, and publishing |
| [Lint guards](lint-guards.md) | Static correctness checks |
| [Clusterio core development](clusterio-core-dev.md) | Testing changes to the sibling Clusterio checkout |

Runtime entry points live under [the plugin directory](../docker/seed-data/external_plugins/surface_export/): `index.ts` registers configuration and messages, `controller.ts` coordinates transfers, `instance.ts` bridges RCON and Lua, `control.ts` exposes the CLI, `web/` contains the UI, and `module/control.lua` is the save-patched entry point.
