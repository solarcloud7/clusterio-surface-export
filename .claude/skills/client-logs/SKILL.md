---
name: client-logs
description: Inspect Factorio client disconnect, freeze and desync evidence alongside instance logs.
---

# Client evidence

Inspect both `%APPDATA%/Factorio/factorio-current.log` and
`factorio-previous.log`; client launch rotates them. Use `$env:APPDATA` in
PowerShell. Record the actual version rather than assuming an old pin.

Narrow the time window, cap long lines and retain connection-state changes,
latency observations, disconnects and desyncs. Do not exclude all Verbose lines:
they can contain latency observations. Missing latency messages alone do not
prove stable latency. A disconnect state is an observation, not a diagnosis.

Client/server timestamps are separate clocks. Exact tick observations can help
associate events in the same world, but their difference is not elapsed seconds.
Do not divide it by 60 to report measured latency or lost time.

RCON cannot return fresh progress while its execution is blocked. This does not
make server-side measurement impossible: profiler boundaries and tick-entry
recordings can measure gaps after execution resumes. The existing
`tests/instruments/tick-watch/` harness captures local server/client cadence, not
rendered FPS. Use its preconditions and a consenting client for live work.

See [diagnostics](../../../docs/developers/diagnostics.md) and the `cluster-logs`
skill. Preserve original evidence; do not infer a mechanism from an old incident
or a quiet server log.
