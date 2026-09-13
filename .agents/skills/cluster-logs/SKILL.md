---
name: cluster-logs
description: Inspect bounded Clusterio plugin and Factorio logs for errors, transfer results and recovery state.
---

# Read cluster logs

Use checked-in readers before constructing shell pipelines:

```powershell
./tools/clusterio/check-cluster-logs.ps1 -Grep 'error|transfer|validation'
node tools/clusterio/read-cluster-logs.mjs 'error|transfer|validation' 20 2000
```

The Node arguments are a pattern, displayed matches per source and raw lines
searched. No matches describes only that bounded window. Read failures remain
unavailable, not evidence of no error.

Aggregated JSON logs live on the controller under `/clusterio/logs/cluster/`.
Host logs live under `/clusterio/logs/host/`; engine/Lua output is in each instance's
`factorio-current.log`. Container stdout need not include every plugin record.
Restart and recreation have different retention effects; do not claim a restart
universally erases `docker logs`.

Use `tools/clusterio/rcon.ps1` instead of personal aliases. Resolve the intended
deployment's container names, which differ from Clusterio hostnames. Keep tokens
out of reports. [Diagnostics](../../../docs/developers/diagnostics.md) maintains
the human log map.
