# Documentation

Start with the [project overview and production gates](../README.md). Keep implementation details in the references below rather than copying configuration tables or timing estimates between guides.

| Reference | Purpose |
|---|---|
| [Docker setup](../docker/README.md) | Local cluster, preserving saves, and Steam client mod sync |
| [Transfer walkthrough](QUICK_START.md) | Start a transfer and inspect its outcome |
| [Commands](commands-reference.md) | In-game, RCON, and remote interfaces |
| [Export/import flow](EXPORT_IMPORT_FLOW.md) | Message routes and restoration boundaries |
| [Batching and timing](async-processing.md) | Tick scheduling, synchronous limits, profiler measurements, and acceptance evidence |
| [Upload sessions and job status](upload-job-status.md) | Buffer ownership, queue observation, protocol bounds, and disposable acceptance |
| [Durability and commit protocol](TRANSFER_2PC.md) | Shipped recovery safeguards and the pending commit protocol |
| [Engineering FAQ](ENGINEERING_FAQ.md) | Failure scenarios and unresolved decisions |
| [Transfer logs](TRANSFER_LOGS.md) | Audit records and inspection |
| [Configuration](config-survey.md) | Configuration ownership and wiring |
| [Testing](testing.md) | Fixture contracts, physical oracles, and live-test rules |
| [CI](CI_CD.md) | Checks, integration environment, and publishing |
| [Lint guards](lint-guards.md) | Static correctness checks |
| [Clusterio core development](clusterio-core-dev.md) | Testing changes to the sibling Clusterio checkout |

Design references: [gateway behavior](GATEWAY_TRANSFER_PRD.md), [gateway canvas](CANVAS_UI_PRD.md), and [connected-client checks](l2-client-session-script.md). These include planned behavior; consult the implementation status before treating a design as shipped.

Runtime entry points live under [the plugin directory](../docker/seed-data/external_plugins/surface_export/): `index.ts` registers configuration and messages, `controller.ts` coordinates transfers, `instance.ts` bridges RCON and Lua, `control.ts` exposes the CLI, `web/` contains the UI, and `module/control.lua` is the save-patched entry point.
