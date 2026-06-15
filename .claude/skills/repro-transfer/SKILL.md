---
name: repro-transfer
description: Reproduce a Factorio platform transfer (export → controller route → import → validation) end-to-end on the LOCAL docker cluster, instead of relying on CI. Use to run/test/smoke a transfer or diagnose any transfer/import/validation failure. Local repro is the default; do not parse CI logs unless explicitly asked.
---

# repro-transfer — reproduce a platform transfer locally

Drive the full transfer pipeline against the running local cluster and see exactly where it stalls. Faster and more debuggable than CI. **Debug locally first** — do not parse CI logs unless asked.

Paths below are relative to the repo root. The driver is `tools/repro-transfer.ps1`.

## Run it (the driver — start here)

One command clones a real platform, transfers it across instances, waits for the destination success signal, and exits 0 (PASS) / 1 (FAIL):

```powershell
./tools/repro-transfer.ps1
```

Verified PASS output (this is what success looks like — ~30s, the `test` platform is 1359 entities):
```
  OK  clone queued (1359 entities)
  OK  clone complete
  OK  clone at index 7
  OK  transfer initiated
  OK  import-result present (3s)
  PASS  transfer completed — 'reprotest_<stamp>' is on clusterio-host-1-instance-1. ... validation_received: Validation: SUCCESS
  OK  cleaned up
```
Options: `-SourceHost 2` (host holding `test`), `-SourcePlatform test`, `-TimeoutSec 150`, `-KeepResult` (don't delete the transferred platform afterward).

If it exits 1, the line tells you the failing layer; then read the logs (next section).

## Preconditions
```powershell
docker ps --format "{{.Names}}: {{.Status}}"        # controller + host-1 + host-2 healthy
./tools/rcon.ps1 11 "/sc rcon.print(remote.interfaces['surface_export'] ~= nil)"   # -> true
```
After a host plugin (`*.ts`) change, rebuild dist in-container and restart hosts so the new module loads:
```powershell
docker exec surface-export-host-1 sh -c 'cd /clusterio/external_plugins/surface_export && npx tsc -p tsconfig.node.json'
docker restart surface-export-host-1 surface-export-host-2
```

## When it FAILS — find the layer
```powershell
./tools/check-cluster-logs.ps1 -Grep "transfer_created|import_started|validation|transfer_completed|sendRequest|Error handling|rollback"
```
(Use the `/cluster-logs` skill for the full log map.) Happy path in the aggregated cluster log:
`Auto-transfer requested` → `Transfer initiated: <id>` → `transfer_created` → `import_started` → `validation_received: Validation: SUCCESS` → `transfer_completed`.

Where it stops = the layer at fault:
- Stops after **export stored**, no `transfer_created` → the instance never sent `TransferPlatformRequest`. Check the host JSON log for `Error handling export completion: … reading 'sendRequest'` — the unbound-method footgun (CLAUDE.md Pitfall #26).
- `import_started` then `validation_timeout` (120s) → destination import never emitted validation. Read host-2's host JSON log + factorio log.
- `validation_received: FAILED` → real item/fluid mismatch. Read `[Loss Analysis]` / `[Validation]` in the destination factorio log.

## What the driver does (manual equivalent, for one-off control)
1. Clone a realistic source by NAME (async): `remote.call('surface_export','clone_platform','test','<newname>')` on the source host, then wait for `storage.async_jobs` to drain. Prefer the real `test` platform (host-2, ~1359 entities, has a schedule) — a hub-only stub has no schedule and hits a benign `Index out of bounds` on unlock/rollback that is NOT representative.
2. `./tools/transfer-platform.ps1 -PlatformIndex <idx> -Direction 2to1` (or `/transfer-platform <idx> <destId>`). If "already locked" from a prior run: `./tools/rcon.ps1 21 "/unlock-platform <name>"`.
3. Poll the destination success signal (what CI's integration test waits on):
   `docker exec surface-export-host-1 sh -c 'ls /clusterio/data/instances/clusterio-host-1-instance-1/script-output/debug_import_result_*.json'`
   (`/clusterio/data/instances/…`, NOT `/clusterio/instances/…`. Requires `debug_mode`, default true on fresh saves.)

## Gotchas
- **Never `npm install`/`npm install --include=dev`/`npm prune` in the plugin dir while the cluster is up.** The plugin lists `@clusterio/*` as peer+dev deps; npm 7+ auto-installs peers, dropping a 2nd `@clusterio/lib` into the shared bind-mounted `node_modules` → `clusterioctl` dies with `Attempt to import duplicate copy of @clusterio/lib` (and this driver hangs on its RCON calls). Recover: `docker exec surface-export-host-1 sh -c 'rm -rf /clusterio/external_plugins/surface_export/node_modules/@clusterio'`. To build locally use `npx tsc` (above), not `npm install`.
- A successful transfer **deletes the source and creates on the destination**; the driver cleans up its own clone afterward unless `-KeepResult`.
- `game.delete_surface(platform.surface)` is the only reliable platform delete (Pitfall #19) — `platform.destroy()` is a no-op.

## Reference
- Reading logs: the **`/cluster-logs`** skill. CLAUDE.md → "Export/Import Workflow Notes", Pitfalls #19, #26.
