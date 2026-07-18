# census-lab NOTEBOOK (append-only)

Phase 0 of the paired-reads epic. Measures the **wall-clock cost of a full physical surface census**
(items + fluids) at production scale, so the later implementation has a MEASURED stall budget instead of
an assumed one. Append-only: never rewrite a banked entry; each run appends a new tick-stamped section.

## Question

How many milliseconds does one full-surface `SurfaceCounter.count_items` + `count_fluids` pass cost at
1,359 entities (the `test` platform on host-1), and what per-entity / per-batch / per-atomic-tick budget
does that imply for Phase 2?

## Instrument

- **Timing is Node-side wall clock.** LuaProfiler is display-only and cannot be read numerically
  (Pitfall #24, LuaProfiler serialization). `process.hrtime.bigint()` brackets each RCON round-trip
  (`docker exec` -> `clusterioctl` -> `/sc`).
- **Baseline** = a bare `/sc rcon.print(1)` averaged over 5 runs — the fixed docker+npx+RCON overhead.
- **Multiplier regression.** Each census runs 1x, 10x, ... Nx in ONE `/sc` execution. Wall(m) ~=
  overhead + m*census_cost, so a least-squares slope over the multipliers isolates the pure per-census
  engine cost from the ~1-2 s exec overhead. The regression intercept should ~= the baseline mean
  (a built-in instrument cross-check).
- **Census loop is INLINED in the `/sc` string.** `SurfaceCounter` (module/validators/surface-counter.lua)
  is a save-patched internal module, unreachable from an RCON console command. The inline loop faithfully
  mirrors it: items = `find_entities_filtered({})` -> per-entity `get_item_count()` + belt transport lines
  + inserter `held_stack` + ground `item-entity`; fluids = the same two-pass (temps, then
  segment-deduplicated contents) as `count_fluids`.

## Controls first (lab discipline)

1. **Baseline** round-trip (empty command).
2. **0-entity fixture** census — a starter-pack-minimal platform (`create_space_platform` +
   `apply_starter_pack`, actual entity count recorded, typically ~10-30, not literally 0). Establishes the
   fixed per-census overhead at small N before the production reading.
3. **Production reading** — the 1,359-entity `test` platform (read-only; never mutated).

## LAB HAZARDS (inherited + local)

- **`platform.destroy()` is a lint-blocked no-op** (Pitfall #19). The fixture is torn down with
  `game.delete_surface` only.
- **`get_item_count()` is a LOWER BOUND** on the real SurfaceCounter cost. Production uses
  `InventoryScanner.extract_all_inventories` (iterates every inventory index, allocates per-slot tables);
  `get_item_count()` is one cheaper engine call. Every measured number here is a FLOOR — the real cost is
  higher, so the derived budget is optimistic and must carry margin.
- **The `test` platform is on a live, unpaused instance**, so machines craft and belts move between
  samples. Item/fluid TOTALS drift slightly across samples — expected, and irrelevant: this rung measures
  TIME, not conservation. Entity count is stable.
- **on_tick clobber** — this runner installs no on_tick handler and mutates no production state; the only
  state created is the fixture, deleted in a guaranteed `finally`.

## TRIED & SETTLED (do not repeat)

- LuaProfiler read-back — impossible (display-only). Node-side wall clock is the only instrument.
- Requiring `SurfaceCounter` from `/sc` — unreachable (save-patched module path). Inline the loop.

## Runner

`node tests/census-lab/run-r1-stall-budget.mjs` (append this NOTEBOOK) /
`--no-notebook` (debug) / `--reset` (delete lab fixtures only) /
`--multipliers=1,10,50,100 --samples=5`.

---
<!-- runner appends banked run sections below -->


## 2026-07-13T04:11:56.655Z — R1 stall-budget census (tick 1011805, Factorio 2.0.77)

Instrument: Node `process.hrtime.bigint()` around each RCON round-trip; slope of wall-time vs in-execution multiplier isolates per-census engine cost. Census loop inlined in `/sc` (mirrors surface-counter.lua). Multipliers 1,10,50,100, 5 samples each.

**Baseline** (bare `/sc rcon.print(1)`, 5x): median 576.37 ms, mean 642.3 ms. Raw: 925.51, 557.9, 576.37, 550.76, 600.95 ms.

**CAVEAT — measured cost is a LOWER BOUND.** The inline loop uses `get_item_count()` (one engine call); production `SurfaceCounter` uses `InventoryScanner.extract_all_inventories` (iterates every inventory index + allocates per-slot tables). Real cost is higher; the derived budget is optimistic — keep margin.

### Control A — baseline round-trip (above). Control B — 0-entity fixture (starter-pack minimal, actual 1 entities)

Fixture items:

| mult | clean | median ms | min ms | mean ms | tick(last) | total(last) | ents |
|---|---|---|---|---|---|---|---|
| 1 | 5/5 | 559.31 | 545.08 | 572.02 | 1012049 | 10 | 1 |
| 10 | 5/5 | 583.04 | 550.27 | 585.57 | 1012225 | 10 | 1 |
| 50 | 5/5 | 619.99 | 570.22 | 613.22 | 1012408 | 10 | 1 |
| 100 | 5/5 | 590.34 | 554.01 | 585.26 | 1012582 | 10 | 1 |

Fixture fluids:

| mult | clean | median ms | min ms | mean ms | tick(last) | total(last) | ents |
|---|---|---|---|---|---|---|---|
| 1 | 5/5 | 556.23 | 538.59 | 564.82 | 1012750 | 0 | 1 |
| 10 | 5/5 | 557.68 | 543.92 | 567.36 | 1012918 | 0 | 1 |
| 50 | 5/5 | 592.85 | 557.51 | 582.67 | 1013090 | 0 | 1 |
| 100 | 5/5 | 593.22 | 574.69 | 609.77 | 1013270 | 0 | 1 |

Fixture per-census: items 0.2823 ms, fluids 0.4123 ms (slope fits: items intercept 576.81 ms, fluids intercept 558.4 ms — cross-check vs baseline 576.37 ms).

### Reading — 1,359-entity `test` platform (surface 2, 1359 entities)

Items:

| mult | clean | median ms | min ms | mean ms | tick(last) | total(last) | ents |
|---|---|---|---|---|---|---|---|
| 1 | 5/5 | 609.33 | 592.85 | 604.1 | 1013448 | 51748 | 1359 |
| 10 | 5/5 | 614.2 | 592.51 | 626.22 | 1013636 | 51703 | 1359 |
| 50 | 5/5 | 870.4 | 863.28 | 876.34 | 1013831 | 51763 | 1359 |
| 100 | 5/5 | 1190.83 | 1159.35 | 1199.48 | 1014022 | 51769 | 1359 |

Fluids:

| mult | clean | median ms | min ms | mean ms | tick(last) | total(last) | ents |
|---|---|---|---|---|---|---|---|
| 1 | 5/5 | 584.47 | 552.87 | 579.47 | 1014199 | 144430.00369895 | 1359 |
| 10 | 5/5 | 624.36 | 607.53 | 624.08 | 1014381 | 144370.01792264 | 1359 |
| 50 | 5/5 | 860.31 | 826.37 | 864.62 | 1014570 | 144370.00163734 | 1359 |
| 100 | 5/5 | 1193.79 | 1112.61 | 1194.9 | 1014760 | 144310.00342262 | 1359 |

Slope fits (per-census ms | round-trip intercept ms | two-point ms):
- test items:  6.0683 | 576.94 | 5.8737
- test fluids: 6.1904 | 566.57 | 6.1547

### Conclusion — banked `[empirical, 2.0.77]`

- **Per-census full census (items + fluids) @ 1359 entities = 12.2587 ms** = **73.55% of one 16.67 ms / 60 UPS frame.**
- Per-census @ 1 entities (fixture): items 0.2823 ms, fluids 0.4123 ms, full 0.6946 ms.
- **Per-entity cost** (2-point slope, fixture N=1 -> test N=1359): items 0.0043 ms, fluids 0.0043 ms, **full 0.0085 ms/entity.**
- Fixed per-census overhead (find_entities + loop setup): 0.6861 ms.
- **Projected added cost per async batch (~100 entities): 1.5376 ms** (9.23% of a frame).
- Projected added cost for the atomic belt tick (one full census): 12.2587 ms.

**Headline (data-driven, honest):** one full synchronous census is **12.2587 ms = 73.55% of a 16.67 ms / 60 UPS frame** at 1359 entities — as a FLOOR. It nearly fills a frame, and real production cost is higher (get_item_count under-counts). A full census is therefore **not** a free per-tick operation at scale; it is a bounded one-shot stall.

**Method note — a single census cannot be timed directly through RCON; the multiplier method is not optional.** The individual 1x and 10x readings sit BELOW the round-trip jitter floor: the items 1x and 10x sample minimums are ~592 ms (essentially identical), and the baseline samples alone span 551-925 ms — a single ~6 ms census is lost in that noise. The per-census figure therefore rests on the **clean, constant marginal cost across the high multipliers**, not on the (noise-dominated) low-mult points: items rises **6.40 ms/census on both 10->50 (256.2/40) and 50->100 (320.4/50)**. That the marginal is constant across three points is the real robustness evidence (GC is not super-linear in this range); the intercept ~= baseline (566-577 vs 576 ms) confirms the low-mult readings are pure round-trip floor. Timing below the exec noise floor is exactly why this rung uses a multiplier slope.

**Proposed Phase-2 acceptance budget** (anchored to the 16.67 ms / 60 UPS frame — the real stall constraint):
1. **Per async batch (~100 entities): AFFORDABLE.** Added paired-read cost 1.5376 ms floor (9.23% of a frame) — comfortably **<= 10% of a batch's 16.67 ms tick budget** (~1.67 ms). Budget: added per-batch census cost <= 1.67 ms; a batch-amortized paired read is the cheap, safe design.
2. **Atomic-tick full census: EXPENSIVE — treat as a bounded one-shot stall.** The added atomic-tick census (~12.2587 ms floor) roughly matches or exceeds a single frame on its own, so it cannot hide inside a normal tick. Budget: the added atomic-tick census must **not exceed the existing atomic belt-scan tick cost** (which is already an accepted one-shot stall). Phase-2 cross-check: MEASURE the current belt-scan tick cost and require added-census <= it; do NOT invent that number here.
Rationale: the brief's two proposed thresholds survive re-expression in measured units, but the measurement REVISES the intuition — the per-batch path is cheap (9.23% of a frame) while a full atomic-tick census is 73.55% of a frame FLOOR. The design lever this hands Phase 2: prefer batch-amortized paired reads; if an atomic full census is unavoidable, bound it against the existing belt-scan stall rather than the frame. Both budgets are provisional until re-checked against the real belt-scan cost and the heavier production census path.

### Zero-leftover proof
Fixture deleted: ["census-lab-probe-1011873"]. Post-run: zero_fixtures=true, async_jobs=0, game_paused=false (tick 1014833).

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/census-lab/run-r1-stall-budget.mjs",
  "started": "2026-07-13T04:10:54.314Z",
  "multipliers": [
    1,
    10,
    50,
    100
  ],
  "samples": 5,
  "errors": [],
  "baseline": {
    "samples_ms": [
      925.51,
      557.9,
      576.37,
      550.76,
      600.95
    ],
    "median_ms": 576.37,
    "mean_ms": 642.3
  },
  "resolved_tick": 1011805,
  "base_version": "2.0.77",
  "test": {
    "surface": 2,
    "index": 2,
    "ents": 1359
  },
  "fixture": {
    "name": "census-lab-probe-1011873",
    "index": 4,
    "surface": 7,
    "ents": 1
  },
  "readings": {
    "fixture": {
      "items": {
        "per_multiplier": [
          {
            "multiplier": 1,
            "samples": [
              {
                "sample": 1,
                "ms": 566.82,
                "ok": true,
                "clean": true,
                "tick": 1011910,
                "total": 10,
                "count": 1,
                "last": "1011910|10|1",
                "err": null
              },
              {
                "sample": 2,
                "ms": 559.31,
                "ok": true,
                "clean": true,
                "tick": 1011944,
                "total": 10,
                "count": 1,
                "last": "1011944|10|1",
                "err": null
              },
              {
                "sample": 3,
                "ms": 546.31,
                "ok": true,
                "clean": true,
                "tick": 1011977,
                "total": 10,
                "count": 1,
                "last": "1011977|10|1",
                "err": null
              },
              {
                "sample": 4,
                "ms": 642.56,
                "ok": true,
                "clean": true,
                "tick": 1012016,
                "total": 10,
                "count": 1,
                "last": "1012016|10|1",
                "err": null
              },
              {
                "sample": 5,
                "ms": 545.08,
                "ok": true,
                "clean": true,
                "tick": 1012049,
                "total": 10,
                "count": 1,
                "last": "1012049|10|1",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 559.31,
            "min_ms": 545.08,
            "mean_ms": 572.02
          },
          {
            "multiplier": 10,
            "samples": [
              {
                "sample": 1,
                "ms": 580.73,
                "ok": true,
                "clean": true,
                "tick": 1012084,
                "total": 10,
                "count": 1,
                "last": "1012084|10|1",
                "err": null
              },
              {
                "sample": 2,
                "ms": 583.04,
                "ok": true,
                "clean": true,
                "tick": 1012119,
                "total": 10,
                "count": 1,
                "last": "1012119|10|1",
                "err": null
              },
              {
                "sample": 3,
                "ms": 597.82,
                "ok": true,
                "clean": true,
                "tick": 1012155,
                "total": 10,
                "count": 1,
                "last": "1012155|10|1",
                "err": null
              },
              {
                "sample": 4,
                "ms": 550.27,
                "ok": true,
                "clean": true,
                "tick": 1012188,
                "total": 10,
                "count": 1,
                "last": "1012188|10|1",
                "err": null
              },
              {
                "sample": 5,
                "ms": 616,
                "ok": true,
                "clean": true,
                "tick": 1012225,
                "total": 10,
                "count": 1,
                "last": "1012225|10|1",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 583.04,
            "min_ms": 550.27,
            "mean_ms": 585.57
          },
          {
            "multiplier": 50,
            "samples": [
              {
                "sample": 1,
                "ms": 570.22,
                "ok": true,
                "clean": true,
                "tick": 1012259,
                "total": 10,
                "count": 1,
                "last": "1012259|10|1",
                "err": null
              },
              {
                "sample": 2,
                "ms": 584.32,
                "ok": true,
                "clean": true,
                "tick": 1012294,
                "total": 10,
                "count": 1,
                "last": "1012294|10|1",
                "err": null
              },
              {
                "sample": 3,
                "ms": 637.82,
                "ok": true,
                "clean": true,
                "tick": 1012332,
                "total": 10,
                "count": 1,
                "last": "1012332|10|1",
                "err": null
              },
              {
                "sample": 4,
                "ms": 653.77,
                "ok": true,
                "clean": true,
                "tick": 1012371,
                "total": 10,
                "count": 1,
                "last": "1012371|10|1",
                "err": null
              },
              {
                "sample": 5,
                "ms": 619.99,
                "ok": true,
                "clean": true,
                "tick": 1012408,
                "total": 10,
                "count": 1,
                "last": "1012408|10|1",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 619.99,
            "min_ms": 570.22,
            "mean_ms": 613.22
          },
          {
            "multiplier": 100,
            "samples": [
              {
                "sample": 1,
                "ms": 604.61,
                "ok": true,
                "clean": true,
                "tick": 1012444,
                "total": 10,
                "count": 1,
                "last": "1012444|10|1",
                "err": null
              },
              {
                "sample": 2,
                "ms": 554.01,
                "ok": true,
                "clean": true,
                "tick": 1012477,
                "total": 10,
                "count": 1,
                "last": "1012477|10|1",
                "err": null
              },
              {
                "sample": 3,
                "ms": 572.64,
                "ok": true,
                "clean": true,
                "tick": 1012511,
                "total": 10,
                "count": 1,
                "last": "1012511|10|1",
                "err": null
              },
              {
                "sample": 4,
                "ms": 590.34,
                "ok": true,
                "clean": true,
                "tick": 1012546,
                "total": 10,
                "count": 1,
                "last": "1012546|10|1",
                "err": null
              },
              {
                "sample": 5,
                "ms": 604.71,
                "ok": true,
                "clean": true,
                "tick": 1012582,
                "total": 10,
                "count": 1,
                "last": "1012582|10|1",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 590.34,
            "min_ms": 554.01,
            "mean_ms": 585.26
          }
        ],
        "fit": {
          "slope_ms": 0.2823,
          "intercept_ms": 576.81,
          "points": 4,
          "two_point_ms": 0.3134
        }
      },
      "fluids": {
        "per_multiplier": [
          {
            "multiplier": 1,
            "samples": [
              {
                "sample": 1,
                "ms": 632.93,
                "ok": true,
                "clean": true,
                "tick": 1012620,
                "total": 0,
                "count": 1,
                "last": "1012620|0|1",
                "err": null
              },
              {
                "sample": 2,
                "ms": 538.59,
                "ok": true,
                "clean": true,
                "tick": 1012652,
                "total": 0,
                "count": 1,
                "last": "1012652|0|1",
                "err": null
              },
              {
                "sample": 3,
                "ms": 556.23,
                "ok": true,
                "clean": true,
                "tick": 1012685,
                "total": 0,
                "count": 1,
                "last": "1012685|0|1",
                "err": null
              },
              {
                "sample": 4,
                "ms": 556.45,
                "ok": true,
                "clean": true,
                "tick": 1012718,
                "total": 0,
                "count": 1,
                "last": "1012718|0|1",
                "err": null
              },
              {
                "sample": 5,
                "ms": 539.9,
                "ok": true,
                "clean": true,
                "tick": 1012750,
                "total": 0,
                "count": 1,
                "last": "1012750|0|1",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 556.23,
            "min_ms": 538.59,
            "mean_ms": 564.82
          },
          {
            "multiplier": 10,
            "samples": [
              {
                "sample": 1,
                "ms": 574.58,
                "ok": true,
                "clean": true,
                "tick": 1012784,
                "total": 0,
                "count": 1,
                "last": "1012784|0|1",
                "err": null
              },
              {
                "sample": 2,
                "ms": 555.27,
                "ok": true,
                "clean": true,
                "tick": 1012817,
                "total": 0,
                "count": 1,
                "last": "1012817|0|1",
                "err": null
              },
              {
                "sample": 3,
                "ms": 543.92,
                "ok": true,
                "clean": true,
                "tick": 1012849,
                "total": 0,
                "count": 1,
                "last": "1012849|0|1",
                "err": null
              },
              {
                "sample": 4,
                "ms": 605.34,
                "ok": true,
                "clean": true,
                "tick": 1012885,
                "total": 0,
                "count": 1,
                "last": "1012885|0|1",
                "err": null
              },
              {
                "sample": 5,
                "ms": 557.68,
                "ok": true,
                "clean": true,
                "tick": 1012918,
                "total": 0,
                "count": 1,
                "last": "1012918|0|1",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 557.68,
            "min_ms": 543.92,
            "mean_ms": 567.36
          },
          {
            "multiplier": 50,
            "samples": [
              {
                "sample": 1,
                "ms": 609.87,
                "ok": true,
                "clean": true,
                "tick": 1012954,
                "total": 0,
                "count": 1,
                "last": "1012954|0|1",
                "err": null
              },
              {
                "sample": 2,
                "ms": 592.85,
                "ok": true,
                "clean": true,
                "tick": 1012989,
                "total": 0,
                "count": 1,
                "last": "1012989|0|1",
                "err": null
              },
              {
                "sample": 3,
                "ms": 557.51,
                "ok": true,
                "clean": true,
                "tick": 1013022,
                "total": 0,
                "count": 1,
                "last": "1013022|0|1",
                "err": null
              },
              {
                "sample": 4,
                "ms": 557.65,
                "ok": true,
                "clean": true,
                "tick": 1013055,
                "total": 0,
                "count": 1,
                "last": "1013055|0|1",
                "err": null
              },
              {
                "sample": 5,
                "ms": 595.45,
                "ok": true,
                "clean": true,
                "tick": 1013090,
                "total": 0,
                "count": 1,
                "last": "1013090|0|1",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 592.85,
            "min_ms": 557.51,
            "mean_ms": 582.67
          },
          {
            "multiplier": 100,
            "samples": [
              {
                "sample": 1,
                "ms": 574.69,
                "ok": true,
                "clean": true,
                "tick": 1013124,
                "total": 0,
                "count": 1,
                "last": "1013124|0|1",
                "err": null
              },
              {
                "sample": 2,
                "ms": 593.12,
                "ok": true,
                "clean": true,
                "tick": 1013159,
                "total": 0,
                "count": 1,
                "last": "1013159|0|1",
                "err": null
              },
              {
                "sample": 3,
                "ms": 593.22,
                "ok": true,
                "clean": true,
                "tick": 1013194,
                "total": 0,
                "count": 1,
                "last": "1013194|0|1",
                "err": null
              },
              {
                "sample": 4,
                "ms": 681.48,
                "ok": true,
                "clean": true,
                "tick": 1013234,
                "total": 0,
                "count": 1,
                "last": "1013234|0|1",
                "err": null
              },
              {
                "sample": 5,
                "ms": 606.35,
                "ok": true,
                "clean": true,
                "tick": 1013270,
                "total": 0,
                "count": 1,
                "last": "1013270|0|1",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 593.22,
            "min_ms": 574.69,
            "mean_ms": 609.77
          }
        ],
        "fit": {
          "slope_ms": 0.4123,
          "intercept_ms": 558.4,
          "points": 4,
          "two_point_ms": 0.3736
        }
      }
    },
    "test": {
      "items": {
        "per_multiplier": [
          {
            "multiplier": 1,
            "samples": [
              {
                "sample": 1,
                "ms": 613.56,
                "ok": true,
                "clean": true,
                "tick": 1013306,
                "total": 51739,
                "count": 1359,
                "last": "1013306|51739|1359",
                "err": null
              },
              {
                "sample": 2,
                "ms": 609.73,
                "ok": true,
                "clean": true,
                "tick": 1013342,
                "total": 51755,
                "count": 1359,
                "last": "1013342|51755|1359",
                "err": null
              },
              {
                "sample": 3,
                "ms": 595.05,
                "ok": true,
                "clean": true,
                "tick": 1013377,
                "total": 51771,
                "count": 1359,
                "last": "1013377|51771|1359",
                "err": null
              },
              {
                "sample": 4,
                "ms": 592.85,
                "ok": true,
                "clean": true,
                "tick": 1013412,
                "total": 51755,
                "count": 1359,
                "last": "1013412|51755|1359",
                "err": null
              },
              {
                "sample": 5,
                "ms": 609.33,
                "ok": true,
                "clean": true,
                "tick": 1013448,
                "total": 51748,
                "count": 1359,
                "last": "1013448|51748|1359",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 609.33,
            "min_ms": 592.85,
            "mean_ms": 604.1
          },
          {
            "multiplier": 10,
            "samples": [
              {
                "sample": 1,
                "ms": 642.72,
                "ok": true,
                "clean": true,
                "tick": 1013484,
                "total": 51739,
                "count": 1359,
                "last": "1013484|51739|1359",
                "err": null
              },
              {
                "sample": 2,
                "ms": 592.51,
                "ok": true,
                "clean": true,
                "tick": 1013520,
                "total": 51729,
                "count": 1359,
                "last": "1013520|51729|1359",
                "err": null
              },
              {
                "sample": 3,
                "ms": 614.2,
                "ok": true,
                "clean": true,
                "tick": 1013558,
                "total": 51717,
                "count": 1359,
                "last": "1013558|51717|1359",
                "err": null
              },
              {
                "sample": 4,
                "ms": 613.17,
                "ok": true,
                "clean": true,
                "tick": 1013596,
                "total": 51719,
                "count": 1359,
                "last": "1013596|51719|1359",
                "err": null
              },
              {
                "sample": 5,
                "ms": 668.51,
                "ok": true,
                "clean": true,
                "tick": 1013636,
                "total": 51703,
                "count": 1359,
                "last": "1013636|51703|1359",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 614.2,
            "min_ms": 592.51,
            "mean_ms": 626.22
          },
          {
            "multiplier": 50,
            "samples": [
              {
                "sample": 1,
                "ms": 904.22,
                "ok": true,
                "clean": true,
                "tick": 1013674,
                "total": 51703,
                "count": 1359,
                "last": "1013674|51703|1359",
                "err": null
              },
              {
                "sample": 2,
                "ms": 863.28,
                "ok": true,
                "clean": true,
                "tick": 1013713,
                "total": 51701,
                "count": 1359,
                "last": "1013713|51701|1359",
                "err": null
              },
              {
                "sample": 3,
                "ms": 868.89,
                "ok": true,
                "clean": true,
                "tick": 1013753,
                "total": 51699,
                "count": 1359,
                "last": "1013753|51699|1359",
                "err": null
              },
              {
                "sample": 4,
                "ms": 874.91,
                "ok": true,
                "clean": true,
                "tick": 1013793,
                "total": 51744,
                "count": 1359,
                "last": "1013793|51744|1359",
                "err": null
              },
              {
                "sample": 5,
                "ms": 870.4,
                "ok": true,
                "clean": true,
                "tick": 1013831,
                "total": 51763,
                "count": 1359,
                "last": "1013831|51763|1359",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 870.4,
            "min_ms": 863.28,
            "mean_ms": 876.34
          },
          {
            "multiplier": 100,
            "samples": [
              {
                "sample": 1,
                "ms": 1190.83,
                "ok": true,
                "clean": true,
                "tick": 1013870,
                "total": 51763,
                "count": 1359,
                "last": "1013870|51763|1359",
                "err": null
              },
              {
                "sample": 2,
                "ms": 1183.3,
                "ok": true,
                "clean": true,
                "tick": 1013909,
                "total": 51719,
                "count": 1359,
                "last": "1013909|51719|1359",
                "err": null
              },
              {
                "sample": 3,
                "ms": 1238.71,
                "ok": true,
                "clean": true,
                "tick": 1013949,
                "total": 51757,
                "count": 1359,
                "last": "1013949|51757|1359",
                "err": null
              },
              {
                "sample": 4,
                "ms": 1225.23,
                "ok": true,
                "clean": true,
                "tick": 1013985,
                "total": 51750,
                "count": 1359,
                "last": "1013985|51750|1359",
                "err": null
              },
              {
                "sample": 5,
                "ms": 1159.35,
                "ok": true,
                "clean": true,
                "tick": 1014022,
                "total": 51769,
                "count": 1359,
                "last": "1014022|51769|1359",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 1190.83,
            "min_ms": 1159.35,
            "mean_ms": 1199.48
          }
        ],
        "fit": {
          "slope_ms": 6.0683,
          "intercept_ms": 576.94,
          "points": 4,
          "two_point_ms": 5.8737
        }
      },
      "fluids": {
        "per_multiplier": [
          {
            "multiplier": 1,
            "samples": [
              {
                "sample": 1,
                "ms": 591.2,
                "ok": true,
                "clean": true,
                "tick": 1014061,
                "total": 144430.00131619,
                "count": 1359,
                "last": "1014061|144430.00131619|1359",
                "err": null
              },
              {
                "sample": 2,
                "ms": 584.47,
                "ok": true,
                "clean": true,
                "tick": 1014097,
                "total": 144430.00130188,
                "count": 1359,
                "last": "1014097|144430.00130188|1359",
                "err": null
              },
              {
                "sample": 3,
                "ms": 590.42,
                "ok": true,
                "clean": true,
                "tick": 1014132,
                "total": 144420.0073539,
                "count": 1359,
                "last": "1014132|144420.0073539|1359",
                "err": null
              },
              {
                "sample": 4,
                "ms": 552.87,
                "ok": true,
                "clean": true,
                "tick": 1014165,
                "total": 144430.00502396,
                "count": 1359,
                "last": "1014165|144430.00502396|1359",
                "err": null
              },
              {
                "sample": 5,
                "ms": 578.37,
                "ok": true,
                "clean": true,
                "tick": 1014199,
                "total": 144430.00369895,
                "count": 1359,
                "last": "1014199|144430.00369895|1359",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 584.47,
            "min_ms": 552.87,
            "mean_ms": 579.47
          },
          {
            "multiplier": 10,
            "samples": [
              {
                "sample": 1,
                "ms": 624.36,
                "ok": true,
                "clean": true,
                "tick": 1014234,
                "total": 144420.00362611,
                "count": 1359,
                "last": "1014234|144420.00362611|1359",
                "err": null
              },
              {
                "sample": 2,
                "ms": 621.84,
                "ok": true,
                "clean": true,
                "tick": 1014270,
                "total": 144430.00455582,
                "count": 1359,
                "last": "1014270|144430.00455582|1359",
                "err": null
              },
              {
                "sample": 3,
                "ms": 626.22,
                "ok": true,
                "clean": true,
                "tick": 1014307,
                "total": 144430.00112474,
                "count": 1359,
                "last": "1014307|144430.00112474|1359",
                "err": null
              },
              {
                "sample": 4,
                "ms": 607.53,
                "ok": true,
                "clean": true,
                "tick": 1014343,
                "total": 144430.00218427,
                "count": 1359,
                "last": "1014343|144430.00218427|1359",
                "err": null
              },
              {
                "sample": 5,
                "ms": 640.43,
                "ok": true,
                "clean": true,
                "tick": 1014381,
                "total": 144370.01792264,
                "count": 1359,
                "last": "1014381|144370.01792264|1359",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 624.36,
            "min_ms": 607.53,
            "mean_ms": 624.08
          },
          {
            "multiplier": 50,
            "samples": [
              {
                "sample": 1,
                "ms": 846.49,
                "ok": true,
                "clean": true,
                "tick": 1014418,
                "total": 144370.00133324,
                "count": 1359,
                "last": "1014418|144370.00133324|1359",
                "err": null
              },
              {
                "sample": 2,
                "ms": 918.22,
                "ok": true,
                "clean": true,
                "tick": 1014456,
                "total": 144370.00306237,
                "count": 1359,
                "last": "1014456|144370.00306237|1359",
                "err": null
              },
              {
                "sample": 3,
                "ms": 871.71,
                "ok": true,
                "clean": true,
                "tick": 1014495,
                "total": 144370.00254238,
                "count": 1359,
                "last": "1014495|144370.00254238|1359",
                "err": null
              },
              {
                "sample": 4,
                "ms": 860.31,
                "ok": true,
                "clean": true,
                "tick": 1014533,
                "total": 144360.00390661,
                "count": 1359,
                "last": "1014533|144360.00390661|1359",
                "err": null
              },
              {
                "sample": 5,
                "ms": 826.37,
                "ok": true,
                "clean": true,
                "tick": 1014570,
                "total": 144370.00163734,
                "count": 1359,
                "last": "1014570|144370.00163734|1359",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 860.31,
            "min_ms": 826.37,
            "mean_ms": 864.62
          },
          {
            "multiplier": 100,
            "samples": [
              {
                "sample": 1,
                "ms": 1193.79,
                "ok": true,
                "clean": true,
                "tick": 1014606,
                "total": 144370.00088012,
                "count": 1359,
                "last": "1014606|144370.00088012|1359",
                "err": null
              },
              {
                "sample": 2,
                "ms": 1292.59,
                "ok": true,
                "clean": true,
                "tick": 1014644,
                "total": 144370.00083721,
                "count": 1359,
                "last": "1014644|144370.00083721|1359",
                "err": null
              },
              {
                "sample": 3,
                "ms": 1242.32,
                "ok": true,
                "clean": true,
                "tick": 1014684,
                "total": 144350.01461756,
                "count": 1359,
                "last": "1014684|144350.01461756|1359",
                "err": null
              },
              {
                "sample": 4,
                "ms": 1133.18,
                "ok": true,
                "clean": true,
                "tick": 1014722,
                "total": 144370.00427234,
                "count": 1359,
                "last": "1014722|144370.00427234|1359",
                "err": null
              },
              {
                "sample": 5,
                "ms": 1112.61,
                "ok": true,
                "clean": true,
                "tick": 1014760,
                "total": 144310.00342262,
                "count": 1359,
                "last": "1014760|144310.00342262|1359",
                "err": null
              }
            ],
            "clean_count": 5,
            "median_ms": 1193.79,
            "min_ms": 1112.61,
            "mean_ms": 1194.9
          }
        ],
        "fit": {
          "slope_ms": 6.1904,
          "intercept_ms": 566.57,
          "points": 4,
          "two_point_ms": 6.1547
        }
      }
    }
  },
  "derived": {
    "fixture_entities": 1,
    "test_entities": 1359,
    "per_census_ms": {
      "fixture": {
        "items": 0.2823,
        "fluids": 0.4123,
        "full": 0.6946
      },
      "test": {
        "items": 6.0683,
        "fluids": 6.1904,
        "full": 12.2587
      }
    },
    "full_atomic_census_ms": 12.2587,
    "full_atomic_census_pct_of_tick": 73.55,
    "per_entity_ms": {
      "items": 0.0043,
      "fluids": 0.0043,
      "full": 0.0085
    },
    "fixed_overhead_ms": 0.6861,
    "projected_per_batch_ms": {
      "batch_entities": 100,
      "added_ms": 1.5376,
      "pct_of_tick": 9.23
    }
  },
  "cleanup": {
    "success": true,
    "deleted": [
      "census-lab-probe-1011873"
    ],
    "tick": 1014799
  },
  "zero": {
    "success": true,
    "tick": 1014833,
    "zero_fixtures": true,
    "fixtures": {},
    "async_jobs": 0,
    "game_paused": false
  },
  "zero_ok": true,
  "finished": "2026-07-13T04:11:56.655Z"
}
```
</details>

## 2026-07-18 — R2 fusion-commensurability (bake gate): TWO CONSECUTIVE FULL GREENS

**Runner**: `tests/census-lab/run-r2-fusion-commensurability.mjs` — the first certified single-use
baked-fixture batch (docs/lab-tests.md lifecycle) and the owning runner of the
`census-fusion-shared-plasma` fixture. Golden pair loaded onto the live cluster via Clusterio-native
save assignment (host-1 = golden source, host-2 = golden destination); pre-batch saves recorded and
restored (`test1.zip` / `test2.zip`); zero leftovers proven against the filesystem both runs.

**Evidence runs** (identical physical results, reported once per probe rule 8):
- Run 1 finished 2026-07-18T06:12:33Z — Variant A GREEN, Variant B GREEN.
- Run 2 finished 2026-07-18T06:13:36Z — Variant A GREEN, Variant B GREEN; additionally exercised the
  controller settled-record replacement live (`Replacing settled transfer record (status=completed)`
  for the recycled deterministic export ID, twice).

**Variant A (law)**: fingerprint reproduced EXACTLY from the save-loaded world (coolant
990.0000005960464, plasma segment 5.033337473869324, all frozen+indestructible). Production
`/transfer-platform` reached `validation_success=true` (debug_import_result on host-2). INDEPENDENT
physical destination census: 3 entities, 4 fusion-power-cells, fluids
`{fluoroketone-cold: 990.0000005960464, fluoroketone-hot: 4.9666619300842285}` — coolant exact at
1e-6, **fusion-plasma ABSENT** (engine-owned: never serialized, never restored, and its absence
failed nothing). Source deleted; zero census-abort artifacts.

**Variant B (teeth)**: golden pair reloaded (the reset — no cleanup of the consumed fixture),
fingerprint reproduced, `test_force_census_omission` armed (pre-gate fail-safe hook). Transfer
ABORTED with `reason=source_census_mismatch` and EXACTLY ONE attributed row — the reactor at (0,0),
`delta {fusion-power-cell: -4}` — bundle `failure_black_box_census_lab-census-fusion-v1_*.json`;
source preserved (3 entities), destination never contacted (no import work), hook consumed.

**Three production bugs found and fixed by this rung** (the fixture is the first schedule-less
platform ever production-transferred):
1. **Schedule-less platforms could not transfer** — `{current=1, records={}}` round-trips and the
   empty-records assignment is engine-rejected ("Index out of bounds"), hard-failing BOTH the import
   queue (destination deleted before the job existed — silently) AND the source unlock's schedule
   restore (rollback stuck, source stranded locked). Fix: `PlatformSchedule.apply` skips the base
   assignment on empty records (nothing-to-apply is success).
2. **A settled transfer blocked its own retry** — terminal records stay in `activeTransfers` and the
   dedupe short-circuited on ANY existing entry, reporting success while doing nothing. Golden-save
   batches expose it (reload resets the Lua export counter → identical export IDs). Fix: dedupe only
   on an ALLOWLIST of live states (transporting / awaiting_validation / awaiting_completion) — a
   terminal-status blocklist missed `cleanup_failed` on its first attempt; allowlist polarity is the
   law here.
3. **A queue failure was silent** — the chunk remote returned `ERROR:<reason>` but `sendChunkedJson`
   never read RCON replies and logged "import queued" over a dead import (only symptom: 120 s
   validation timeout). Fix: the chunk template prints its status and the sender throws on `ERROR:`.
   First-draft hazard, measured: `sendRcon(cmd, true)` means EXPECT-EMPTY and fails on any healthy
   non-empty reply — read the reply without the flag instead.

**Runner-methodology lessons banked** (each measured, each now encoded in the runner):
- Capture golden-session `factorio-current.log` BEFORE restore — the restart rotates the evidence.
- Deterministic worlds regenerate IDENTICAL debug filenames; "new paths only" detectors go blind on
  the second run — detect via mtime-vs-marker (`find -newer`).
- Golden reload order is STOP → COPY → START: stopping exit-saves the mutated world over a
  pre-copied pristine zip.
- Prove save cleanup against the FILESYSTEM; the controller's `save list` is a cache.
- The runner's own first-draft fluid meter used the blind segment read and measured coolant 0 — the
  buffer-class fixture caught its own instrument. The meter now mirrors
  `FluidOwnership.effective_segment_contents` (segment contents; local proxy when the segment reads
  empty). No Lua `--` comments in flattened one-line templates.

**Also observed, not chased tonight**: the local host-1 `test1.zip` world has ZERO platforms — the
1359-entity `test` platform is absent from the whole autosave lineage predating this batch (R1
resolved it 2026-07-17; likely lost in a roll-forward save reset). Local fidelity runners that clone
`test` need it re-imported. CI is unaffected (bakes its own).

**Addendum (same day) — adversarial /code-review pass and re-certification.** The five-angle review
of the fix set surfaced three CONFIRMED-class defects in the first-draft fixes, each corrected and
re-evidenced:
1. The retry dedupe's allowlist FALL-THROUGH re-ran settled records — but `cleanup_failed`/`error`
   (and `completed`) mean the destination holds a committed copy, so a same-ID re-run DUPLICATES
   (Pitfall #31 class). Hardened semantics: live states dedupe; ONLY `failed` (destination provably
   discarded) is replaceable; completed/cleanup_failed/error/UNKNOWN statuses REFUSE loudly —
   fail-safe polarity for a source-deleting path is "block the retry", never "re-run it".
2. The `ERROR:` substring check missed raw Lua THROWS (whose RCON text lacks the token) — the old
   expectEmpty flag caught those. Hardened: strict per-chunk token protocol (`CHUNK_OK:` /
   `JOB_QUEUED:` prefixes only; anything else throws).
3. `--sections=variant-b` displaced the live saves without arming the restore finalizer. Hardened:
   displacing sections auto-append restore; variant-b sets the displaced flag.
The refusal semantics make deterministic same-ID retries impossible by design, so the runner now
offsets `storage.async_job_id_counter` after each golden load (instrumentation-level only) —
collision-free IDs per run without weakening the production guard. The prior two greens were demoted
to development evidence; the CERTIFYING evidence is two consecutive full greens on the hardened
build (2026-07-18, runs `r2-final1`/`r2-final2`): identical physical results (coolant
990.0000005960464 exact, plasma absent, `fusion-power-cell: -4` single attributed row on Variant B),
clean restores, zero leftovers.
