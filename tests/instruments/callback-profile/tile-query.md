# Tile query comparison contract

Run `node tests/instruments/callback-profile/tile-query.mjs` on idle local hosts.
This read-only instrument compares the old full query plus Lua exclusions with
`{name={"out-of-map","empty-space"}, invert=true}` on each existing named pad:
`lab-transfer-fixture-v1`, `lab-omnibus-state-v1`, `oneofeach-fixture-v1`.
Both scans run without a simulation update between them. No surfaces, cargo,
configuration, locks or pause states are changed; no cleanup mutations are required.

Required invariant: identical complete sets of `(x,y,tile name)`, including multiplicity.
No helper may repair a mismatch. Array order and profiler values are observations,
not tile-set invariants. Independent offline comparison retains both full projections.

Factorio 2.1.17 documents TileSearchFilters.name as a tile name/name array and
invert as boolean: https://lua-api.factorio.com/latest/concepts/TileSearchFilters.html
(page reported 2.1.17 when checked 2026-09-09). The instrument reads existing
LuaSurface.count_tiles_filtered/find_tiles_filtered, LuaTile.name/position,
LuaProfiler.stop and rendered output; runtime behavior still requires this comparison.

Bounds: at most three existing pads and two paired samples each, alternating first
algorithm; at most 1,048,576 generated tiles and 65,536 retained tiles per pad;
32 KiB command, 16 MiB response and 20 seconds per RCON command. Preflight uses the
shared idle-lease guard, including its completed-receipt exception. Stop on refusal,
missing profiler output, mismatched tiles, changed engine pin, or output bounds.
Full projections, raw durations and observer SHA-256 are saved in ignored ci-artifacts.
Analyze again without the cluster using `--analyze <artifact>`.

The profiler includes query plus projection for each algorithm, excluding equality
checks. Results are paired local elapsed measurements, not exclusive CPU time or a
universal speedup. Only apply the candidate to production after parity passes; then
run the existing transfer/recovery acceptance fixture with exact physical cargo.

## Read-only comparison — 2026-09-09

`ci-artifacts/tile-query-mttm3os6.json` retained six paired samples on Factorio
2.1.17, alternating which algorithm ran first. Exact tile-name/coordinate multisets
matched in all six. No world mutations occurred.

| Existing pad | Tiles returned by old query | Tiles retained | Old scan | Filtered scan |
|---|---:|---:|---:|---:|
| `lab-transfer-fixture-v1` | 229,376 | 4,350 | 103.55–146.43 ms | 4.65–6.18 ms |
| `lab-omnibus-state-v1` | 262,144 | 12,339 | 125.66–137.32 ms | 18.30–49.47 ms |
| `oneofeach-fixture-v1` | 331,776 | 33,264 | 238.97–243.51 ms | 77.06–90.29 ms |

The filtered implementation was applied only after these comparisons passed.
This removes work spent returning and examining excluded tiles. It does not batch
the remaining query or projection; the largest measured candidate still took
90.29 ms. Two samples per pad do not establish an overhead percentage or a general
latency bound. The retained projection uses flattened coordinates for offline
comparison; the production payload retains its existing `position` shape.

## Deployed transfer acceptance

After save-preserving deployment, `ci-artifacts/transfer-cleanup-mttm92lt.json`
passed baseline transfer and injected source-deletion failure followed by recovery.
Both preserved exact physical cargo, belt sides and fluids. Replay checks and
fixture cleanup passed. Existing worlds and player positions matched predeploy
snapshots; no save reset was used.

The six-entity/425-tile fixture recorded `tile_scan` execution of **0.74 ms** and
**1.76 ms**, with total source preparation **1.06 ms** and **2.74 ms**. Earlier
instrumented samples of the same fixture measured tile scans of **89.14–117.84 ms**.
These deployed samples complement the paired read-only comparison; they are not
controlled measurements of whole-operation latency or a frame-budget guarantee.
Destination starter-pack readings were **46.74 ms** and **37.18 ms**; that path was
unchanged.

Browser assertions matched 178 displayed timing rows and 117 raw Lua timing records
(including skipped stages) across both downloaded diagnostics. All required
preparation children were present and complete; no browser runtime errors occurred.
The Lua scanner regression and 51 lifecycle smoke tests passed. Exact readings and
implementation hashes remain in the acceptance artifacts.
