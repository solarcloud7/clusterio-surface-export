# E2E Test Guide — surface_export platform transfer

A hands-on, repeatable procedure to validate the surface_export plugin end-to-end on the local 2-host
Docker cluster: **export → controller route → import → validation → source cleanup**, plus the gateway,
passenger, upload-import, and failure paths.

This complements [QUICK_START.md](QUICK_START.md) (the happy-path *usage* intro) — this is the *QA/validation*
checklist. The single source of truth for "does it all work" is the automated suite in §3; the manual sections
exist to inspect, debug, or demo individual flows.

> **Shell note (agents / non-interactive):** the `rc11`/`rc21` profile aliases are interactive-only. Use
> `./tools/rcon.ps1 11 "<cmd>"` (host-1) and `./tools/rcon.ps1 21 "<cmd>"` (host-2). All commands below assume
> repo root and PowerShell 7 (`pwsh`).

---

## 0. What "pass" means

A transfer is **correct** when, on the destination, all of the following hold and the source platform is gone:
- **Entity count** equals the source (failed placements are tallied, not silently dropped).
- **Total items** and **total fluids** are preserved within the strict gate tolerance (`max(20, 1.5%)` per
  item type — the irreducible belt-restoration floor).
- **Schedule** (records + interrupts + wait conditions) is preserved.
- The validation **gate passed** (`validation_success = true`) — this is the authoritative loss check.
- On failure, the source is **unlocked/rolled back**, never deleted (two-phase commit).

---

## 1. Prerequisites — bring the cluster up

```pwsh
docker volume create factorio-client          # one-time
docker compose up -d                            # or: ./tools/deploy-cluster.ps1 -SkipIncrement -KeepData
./tools/show-cluster-status.ps1                 # controller healthy + both instances running
```

Expect: `surface-export-controller`, `surface-export-host-1`, `surface-export-host-2` all **Up (healthy)**,
and both instances `running`.

If you changed plugin code first:
- **TS only:** `./tools/build-plugin.ps1 node -RestartHosts` (controller changes also need `-RestartController`)
- **Lua / full:** `./tools/patch-and-reset.ps1` (rebuilds + resets saves to re-patch Lua + restarts)

---

## 2. Smoke test — plugin loaded, debug on

```pwsh
# Remote interface is registered (must print 'true'):
./tools/rcon.ps1 11 "/sc rcon.print(remote.interfaces['surface_export'] ~= nil)"

# Debug mode on BOTH instances (writes debug_*.json artifacts used for inspection):
./tools/rcon.ps1 11 "/sc remote.call('surface_export','configure',{debug_mode=true})"
./tools/rcon.ps1 21 "/sc remote.call('surface_export','configure',{debug_mode=true})"

# Source platforms exist on host-1 (the seed 'test' platform = ~1359 entities):
./tools/rcon.ps1 11 "/list-platforms"
```

> Note the per-force **unique index** from `/list-platforms` — it is the key for every command below
> (names can collide; the index never does).

---

## 3. Automated suite — the fastest full E2E (do this first)

One auto-discovering runner drives every `tests/integration/*` scenario against the live cluster. This *is*
the CI step, so a green run here ≈ a green PR.

```pwsh
node tools/run-integration-tests.mjs --list           # see all scenarios
node tools/run-integration-tests.mjs                  # run the FULL suite (~3–4 min)
node tools/run-integration-tests.mjs --only platform-roundtrip   # one scenario
node tools/run-integration-tests.mjs --only 'fidelity|gate'      # regex filter
```

Expect the summary to end `N/N passed`. Scenarios cover: `platform-roundtrip`, `transfer-fidelity`,
`gate-detects-loss`, `ground-item-fidelity`, `failed-entity-loss`, `active-state-roundtrip`,
`force-bonus-sync`, `gateway-transfer`, `gateway-guard`, `passenger-evacuate`, `name-collision-delete`,
`rollback`, `engine-invariants`, `version-dispatch`, `entity-roundtrip`.

The remaining sections reproduce individual flows **manually** for inspection/demo/debugging.

---

## 4. Manual happy-path transfer (host-1 → host-2)

```pwsh
# Pick a source index from /list-platforms (e.g. the 'test' platform). Then:
./tools/transfer-platform.ps1 -PlatformIndex <idx> -Direction 1to2
```

This wraps the full `/transfer-platform` workflow (lock → export → route → import → validate → delete source
**or** rollback) and prints post-transfer state. Watch progress in chat/logs:

```pwsh
# Source side (host-1):  export progress + "Export Complete"
# Dest side  (host-2):  import progress + "Import Complete"
./tools/rcon.ps1 21 "/list-platforms"     # platform now on host-2
./tools/rcon.ps1 11 "/list-platforms"     # gone from host-1 (deleted on success)
```

For a clean repeatable source, clone the seed platform first (so you keep the original):

```pwsh
# clone_platform(source_index, dest_name) — source keyed on UNIQUE index, 2 args
./tools/rcon.ps1 11 "/sc remote.call('surface_export','clone_platform', <test_idx>, 'e2e-demo')"
```

---

## 5. Validation & fidelity — prove conservation independently

Don't trust only the validator's self-report — cross-check with a **physical count**.

```pwsh
# A) The gate's authoritative result (JSON) for the imported platform on host-2:
./tools/rcon.ps1 21 "/sc rcon.print(remote.call('surface_export','get_validation_result_json','<platform_name>'))"
#    look for: validation_success=true, totalItemLoss≈0, expectedItemCounts == actualItemCounts, entityCount matches
```

The conclusive artifact is the on-disk import result (debug_mode on):

```bash
docker exec surface-export-host-2 sh -c 'ls -t /clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_*.json | head -1'
# Inspect: validation_success, totalExpectedItems == totalActualItems, totalItemLoss:0, itemLossByType:{},
#          entityCount, failedEntityLosses (should be absent/empty), forceDataMismatches (raise-only warnings)
```

> **Fidelity is solved** (proven 0-loss). A flaky *held-item* count is a measurement artifact, not loss —
> held items cycle belt↔hand and are craftable, so dst-held ≠ src-held at zero loss. Trust
> `totalItemLoss`/`expected==actual` + entity count, not a raw held sub-count. `get_item_count` is itself a
> complete physical meter (it includes belt + held items).

---

## 6. Export-only + upload-import (no source delete)

```pwsh
# Export to controller storage only (source stays put, then unlocks):
./tools/rcon.ps1 11 "/export-platform <idx>"
./tools/rcon.ps1 11 "/sc rcon.print(remote.call('surface_export','list_exports_json'))"

# Export to a disk file:
./tools/rcon.ps1 11 "/export-platform-file <idx>"   # lands in host-1 script-output/

# Re-import a JSON file onto host-2 (chunks automatically; no source deleted):
./tools/rcon.ps1 21 "/plugin-import-file <filename> <new_platform_name>"
```

Or use the **web UI** (§11) → Manual Transfer "Export JSON" / "Import JSON", or the Exports tab.

---

## 7. Gateway transfer (Phase 1a)

```pwsh
# Park a platform at a gateway, then:
./tools/rcon.ps1 11 "/gateway-transfer <idx> <dest_instance_id>"   # arrives paused at the gateway, hop stripped
# Or open the on-arrival chooser GUI (Model A):
./tools/rcon.ps1 11 "/gateway-gui <idx>"
```

Automated coverage: `--only 'gateway'` (`gateway-transfer`, `gateway-guard`).

---

## 8. Passenger evacuate (no hard block)

A transfer is **not** blocked when players/character bodies are aboard — they're **evacuated to Nauvis** at the
sole source-delete chokepoint before teardown. Validate via the suite:

```pwsh
node tools/run-integration-tests.mjs --only passenger-evacuate
```

(Manual connected-player verification is tracked separately.)

---

## 9. Failure / edge cases (the safety net)

```pwsh
# Strict gate DETECTS real loss + preserves the source (must FAIL the gate, NOT delete source):
node tools/run-integration-tests.mjs --only gate-detects-loss

# Mid-flight rollback (session closed / import fails → source unlocked, not deleted):
node tools/run-integration-tests.mjs --only rollback

# Failed-entity loss attribution (mod-mismatch placements tallied, not silently dropped):
node tools/run-integration-tests.mjs --only failed-entity-loss

# Name-collision delete (platforms with same name → keyed on unique index, correct one deleted):
node tools/run-integration-tests.mjs --only name-collision-delete
```

Manual lock/rollback inspection:

```pwsh
./tools/rcon.ps1 11 "/lock-status"                  # show locked platforms
./tools/rcon.ps1 11 "/unlock-platform <name_or_index>"
```

---

## 10. Persistence & observability

```pwsh
# In-game transaction dashboard (history + per-phase timing):
./tools/rcon.ps1 11 "/transaction-dashboard 25"

# Controller persistence files (written atomically via safeOutputFile — should be valid JSON, no *.tmp):
docker exec surface-export-controller sh -c 'ls -la /clusterio/data/database/surface_export_*.json'

# Trace a transfer end-to-end (the aggregated JSON logs docker logs hides):
./tools/check-cluster-logs.ps1
./tools/check-cluster-logs.ps1 -Grep "transfer|validation|fail"

# Prometheus metrics:
docker exec surface-export-controller sh -c 'curl -s http://localhost:8080/metrics | grep ^surface_export_'
```

Log homes (see [CLAUDE.md](../CLAUDE.md) "Observability"): controller `/clusterio/logs/cluster/cluster-*.log`
(best single stream for a cross-instance transfer), host `/clusterio/logs/host/host-*.log`, Factorio
`/clusterio/data/instances/<instance>/factorio-current.log`, debug dumps in that instance's `script-output/`.

---

## 11. Web UI walkthrough

1. Open `http://localhost:8080` → **Surface Export** page (auth: `./tools/get-admin-token.ps1` for the
   login token).
2. **Manual Transfer** tab — platform tree; per-platform **Export JSON**, per-instance **Import JSON**;
   drag a platform to start a transfer.
3. **Exports** tab — stored exports; download / upload-import.
4. **Transaction Logs** tab — mixed transfer/export/import history, validation display, phase waterfall;
   deep-link `?tab=logs`.
5. Confirm Entities-tab icons render (not `?` placeholders) — requires export-data (CLAUDE.md Pitfall #27).

---

## 12. Cleanup / reset

```pwsh
# Remove a leftover test platform on an instance:
./tools/rcon.ps1 21 "/sc local p=game.forces['player'].platforms[<idx>]; if p then game.delete_surface(p.surface) end"

# Full clean re-seed (wipes runtime state back to the seed saves):
./tools/patch-and-reset.ps1
# Hard wipe (volumes):  docker compose down -v   then   docker compose up -d
```

---

## Quick reference

| Goal | Command |
|------|---------|
| Full E2E (all scenarios) | `node tools/run-integration-tests.mjs` |
| One scenario | `node tools/run-integration-tests.mjs --only <regex>` |
| Manual transfer | `./tools/transfer-platform.ps1 -PlatformIndex <idx> -Direction 1to2` |
| RCON (host-1 / host-2) | `./tools/rcon.ps1 11 "<cmd>"` / `./tools/rcon.ps1 21 "<cmd>"` |
| List platforms | `./tools/rcon.ps1 11 "/list-platforms"` |
| Validation result | `remote.call('surface_export','get_validation_result_json', <name>)` |
| Trace a failure | `./tools/check-cluster-logs.ps1 -Grep "..."` |
| Reset cluster | `./tools/patch-and-reset.ps1` |
