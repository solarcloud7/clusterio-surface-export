---
name: cluster-logs
description: Find what actually happened in the local Clusterio cluster — plugin errors, transfer traces, validation results, instance crashes. Use whenever debugging the surface_export plugin or a Factorio instance locally, BEFORE looking at CI. Defeats the #1 gotcha that `docker logs` does NOT show plugin (this.logger) output.
---

# cluster-logs — read the cluster's logs from where they actually live

**The trap this skill exists to defeat:** a plugin's `this.logger.info/error(...)` output (controller AND instance/host plugins) does **NOT** reliably appear in `docker logs`. `docker logs surface-export-host-1 | grep surface_export` returns **nothing**. The logs are JSON files on disk. Always look in the files; never conclude "no logs / no error" from `docker logs` alone.

## Do this first

```powershell
# One command dumps everything from the right places (plugin JSON logs + factorio + status):
./tools/check-cluster-logs.ps1
# Hunting a specific failure? Filter the aggregated plugin log:
./tools/check-cluster-logs.ps1 -Grep "sendRequest|handleRequest|undefined|error|fail"
```

If that surfaces the answer, you're done. The sections below are for targeted follow-up.

## Where each log actually lives

| Want | Location (in container) | Command |
|---|---|---|
| **Everything, aggregated** (controller + every host + every instance plugin `this.logger`). Best single source to trace a cross-instance transfer end-to-end. | controller: `/clusterio/logs/cluster/cluster-*.log` (JSON, date-rotated UTC) | `docker exec surface-export-controller sh -c "cat /clusterio/logs/cluster/cluster-*.log" \| grep -aoE '"message":"[^"]*"'` |
| **One host's plugin logs** | host: `/clusterio/logs/host/host-*.log` (JSON) | `docker exec surface-export-host-1 sh -c "cat /clusterio/logs/host/host-*.log" \| grep -aoE '"message":"[^"]*"'` |
| **Controller-origin only** | `docker logs surface-export-controller` (controller `this.logger` DOES appear; host/instance do NOT) | `docker logs --tail 300 surface-export-controller 2>&1 \| grep surface_export` |
| **Factorio engine + Lua `log()`/`[Script]`** | host: `/clusterio/data/instances/<instance>/factorio-current.log` | `docker exec surface-export-host-1 sh -c "tail -200 /clusterio/data/instances/clusterio-host-1-instance-1/factorio-current.log"` |

Notes:
- Container clock is **UTC** — don't compute the date filename host-side; glob `*-*.log`.
- The on-disk files **persist across container restarts** (until date-rotation); `docker logs` loses pre-restart output. Prefer the files after any restart.
- JSON shape: `{"instance_id":…,"level":"info|error|server","message":"…","plugin":"surface_export","timestamp":…}`. `level":"server"` lines are mirrored Factorio output.

## RCON from a non-interactive shell

The `rc11`/`rc21`/`rclist` profile aliases are **not** available to an agent. Use:
```powershell
./tools/rcon.ps1 11 "/list-platforms"      # host-1/instance-1
./tools/rcon.ps1 21 "/list-surfaces"       # host-2/instance-1
```

## Reference
- CLAUDE.md → "Observability — WHERE EACH LOG ACTUALLY LIVES" and Pitfall #26.
- Prometheus metrics are live at `http://localhost:8080/metrics` (controller).
