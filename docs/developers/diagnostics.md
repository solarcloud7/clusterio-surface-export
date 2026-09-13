# Diagnose a running cluster

Start with the operation ID, time, participant instances and actual loaded
versions. Retain the original evidence before restarting or changing settings.

## Logs and status

From the repository root:

```powershell
./tools/clusterio/show-cluster-status.ps1
./tools/clusterio/check-cluster-logs.ps1 -Grep 'error|transfer|validation'
node tools/clusterio/read-cluster-logs.mjs 'error|transfer|validation' 20 2000
./tools/clusterio/rcon.ps1 11 '/list-platforms'
./tools/clusterio/rcon.ps1 21 '/list-platforms'
```

The Node log reader takes a pattern, maximum displayed matches per source, and
raw lines searched. A bounded empty window does not prove nothing happened.
Plugin JSON logs, engine logs and container stdout are distinct sources:

| Source | Location inside its container |
|---|---|
| Aggregated Clusterio logs | Controller: `/clusterio/logs/cluster/cluster-*.log` |
| Host and instance plugin logs | Host: `/clusterio/logs/host/host-*.log` |
| Factorio engine and Lua output | Host: `/clusterio/data/instances/<instance>/factorio-current.log` |
| Lua diagnostic files | Instance `script-output/` directory |

`docker logs` alone need not include every plugin record. Restart and container
recreation have different log-retention effects; inspect the configured logging
driver and persistent files rather than assuming either source is complete.

## Saved diagnostics

```text
node tools/tests/testkit/cli.mjs blackbox explain <bundle.json>
node tools/tests/testkit/cli.mjs log <transferId> --list
node tools/tests/testkit/cli.mjs api LuaEntity.disabled_by_script
```

The black-box explainer reads recorded item/fluid differences, timing and available
replay information. It does not read documentation, identify a root cause from a
signature, or authorize a retry. Preserve the original bundle. An empty cargo diff
does not prove entity restoration succeeded.

The API lookup checks the vendored schema at its recorded version. It answers
member availability, not whether a whole reconstruction algorithm works. A real
member can still be invalid for a particular entity subtype.

## Client symptoms and pauses

On Windows, inspect `%APPDATA%/Factorio/factorio-current.log` and
`factorio-previous.log`; a client restart rotates these files. Narrow the time
window and retain connection-state changes, disconnects and desync reports.
Missing latency-change messages alone do not establish stable latency.

Client and server log timestamps use separate process clocks. Tick observations
can help identify an event in the same running world but are not elapsed seconds
and must not be compared across unrelated saves/instances. A blocked RCON request
cannot report progress while its callback is blocked. Profiler boundaries and the
[tick recorder](../../tests/instruments/tick-watch/README.md) can measure elapsed
gaps after execution resumes. Neither measures rendered client FPS.

For **Error loading module**, inspect browser console/network failures and the
controller's advertised bundle before rebuilding. Confirm plugin registration,
dependency identity and emitted assets. Use the [deployment workflow](workflow.md)
for publication; do not install dependencies into the live mount as a diagnostic
shortcut.
