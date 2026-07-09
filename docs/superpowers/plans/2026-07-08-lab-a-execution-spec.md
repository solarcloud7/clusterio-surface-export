# LAB-A execution spec — export-scan drift (the P0 keystone)

> Detailed, code-grounded build/run spec for LAB-A from the test-suite design
> (`2026-07-08-empirical-test-suite-design.md`). LAB-A grounds the source-delete gate thresholds the whole system
> rests on; its result calibrates the #76 fluid-gate fix, so it runs first. **Prerequisite: Docker Desktop engine
> running + `docker compose up -d` healthy (both instances running).** Cluster was DOWN at authoring.

## The question
Do item and fluid **totals** drift during the multi-tick export scan on a **flowing** platform — i.e. is any loss
tolerance even needed on the validation gates, and if so, what is the true residual? Grounds GATE-1/2/3/4 (the
guessed 20/1.5%/500/25/5% thresholds) and answers the belt real-vs-phantom question (BELT-3).

## CODE-GROUNDED REFINEMENT (from reading `core/export-pipeline.lua` + `export_scanners/inventory-scanner.lua`)
The export captures belts and fluids **differently** — this asymmetry IS the crux:
- **Belts → atomic single-tick scan.** `process_batch` sets `EntityHandlers.skip_belt_items = true` during the
  multi-tick async loop (export-pipeline.lua:298); belt items are then captured in ONE tick in
  `ExportPipeline.complete()` (`extract_belt_items` over all tracked belt entities, :362-384). This is the
  Pitfall-#16 "rolling snapshot" fix. **So for belts, LAB-A tests whether that fix WORKS** (atomic serialized
  total == single-tick physical count), not whether raw multi-tick drift exists.
- **Fluids → captured INLINE across the multi-tick batch loop**, deduped by segment id.
  `InventoryScanner.fluid_segment_cache = job.fluid_segment_cache` is set during `process_batch`
  (export-pipeline.lua:299) and `extract_fluids` accumulates per-segment at the weighted-average temperature,
  writing `cache[seg_id]` the first time a segment is seen (inventory-scanner.lua:302-355). **Fluids did NOT get
  the atomic treatment belts got.** So the genuinely-open question is: does a FLOWING fluid network drift across
  those multi-tick batches — e.g. fluid moving between segments so a segment captured in batch 1 differs from its
  state in batch 5, or a segment's `seg_id` changing mid-scan — producing a serialized total that matches no
  single tick? That drift is exactly what the fluid gate tolerance was invented to absorb.

**Consequence for the design:** LAB-A's fluid arm is the load-bearing one (unproven path); the belt arm is a
fix-validation. Keep both, but the fluid measurement is where the gate calibration comes from.

## Preconditions to determine DURING the build (don't assume)
1. **Does export freeze fluid flow?** The export runs on a locked platform. Belts keep moving (can't be
   deactivated — Pitfall #16). Do fluid segments still equalize/flow while the platform's entities are
   frozen/deactivated? Read `surface-lock.lua` lock/freeze + probe: on a locked platform, sample a flowing
   segment tick-to-tick — does it change? **If fluids are fully frozen during export, drift is impossible and the
   fluid tolerance is unneeded (a strong result).** If they still move, drift is possible. This is LAB-A step 0
   (the fluid analog of "belts can't be deactivated").
2. **Force a MULTI-TICK export.** A tiny fixture exports in 1-2 ticks → no window for drift → false "no drift."
   Ensure `/export-sync-mode off` (multi-tick, the default) AND enough entities that the batch loop spans several
   ticks (or shrink batch size). Confirm the export actually took N>1 ticks (log `started_tick` vs completion).
3. **Segment-id stability.** `extract_fluids` keys the dedup on `get_fluid_segment_id(i)`; if a flowing network's
   seg_id churns mid-scan, dedup can double-count or miss. Probe seg_id stability tick-to-tick on the flowing
   fixture.

## Experimental design (controls-first)
- **Control (static) — trust the instrument:** a `storage-tank` (fluid) + a settled belt with items, no flow.
  Export → the serialized total (`debug_source_platform_*.json` `verification.fluid_counts` / `item_counts`) must
  **exactly equal** an independent single-tick physical census taken at export time. If not, STOP — the
  instrument/serialization is wrong and everything downstream is noise. (R10 already showed a static tank exact;
  this re-confirms with a belt too.)
- **Experiment (flowing):** offshore-pump/boiler + pipes + PUMPS moving fluid across ≥2 segments, AND a running
  belt loop with items, sized to force a multi-tick export. Export → capture:
  - `serialized_total` per fluid-name and per item-name (from the debug dump `verification`),
  - `physical_at_scan_start` and `physical_at_scan_end` (single-tick census each), taken via the plugin's own
    counters so it's apples-to-apples.
- **Residual = max over names of |serialized − physical|**, reported separately for fluids (the open path) and
  items/belts (the fix-validation).

## Measurement API (verified this session against 2.0.76 docs + plugin usage)
- Physical item census: `LuaEntity.get_item_count(name)` over `surface.find_entities_filtered({})` incl.
  transport-belts `[plugin-proven — destination-hold/run-tests.ps1 Get-Metrics:361]`.
- Physical fluid census: walk fluidboxes, dedup by `get_fluid_segment_id(i)`, sum `get_fluid_segment_contents(i)`
  (nil for isolated → read `fluidbox[i]` proxy) `[plugin-proven — inventory-scanner extract_fluids; run-r10.mjs
  read_entity:195]`. Reuse the SAME dedup the export uses so the comparison is exact.
- Belt item positions (for drift diagnosis): `LuaTransportLine.get_detailed_contents()` / `get_line_item_position`
  `[doc-verified 2.0.76]` — sharper than manual reads.
- Serialized side: read `debug_source_platform_*.json` `verification.{fluid_counts,item_counts}` (enable
  `debug_mode=true`; dumps land in `script-output/`) `[plugin-proven — run-r10.mjs waitForDebugResult/compactDebugDump]`.

## Runner build (Style B — copy `tests/fluid-lab/run-r10.mjs`)
- New: `tests/gate-drift-lab/run-lab-a.mjs`. Change constants: `notebook`, `fixturePrefix="gate-drift-a"`,
  `parseSections` allowlist `["control","fluidflow","beltflow","freeze0"]`, global table name.
- **Reuse unchanged** (per the scaffolding map): `rcon`/`lua`/`lastLine`/`stepTick`/`luaString`/`safeName`/
  `scriptOutput`/`listDebugFiles`/`readJsonFile`/`removeDebugFilesForName`/`getInstanceId`, and the transfer/dump
  layer — BUT LAB-A does NOT need a two-instance transfer for the drift measurement; it exports on host-1 and
  reads the source dump + a same-tick physical census. (A transfer is only needed if we also want the dest side.)
  So this is closer to a Style-A single-instance export probe that reads the debug_source dump.
- Rewrite the install Lua: `mk` bare platform; build the flowing fixture (offshore/pump/pipe/tank + belt loop);
  a `census(platform)` helper returning `{fluid_by_name, item_by_name, tick}` using the dedup above; a
  `flowing_segment_probe` for step 0/precondition 3.
- **Cleanup/zero-leftover: keep the 6-field `cleanupAll`** (`zero_surfaces, zero_storage, game_paused,
  destination_holds, locked_platforms, committed_source_transfer_tombstones`) on BOTH instances; `--reset` branch.
- Sections: `freeze0` (step-0 fluid-flow-while-locked probe), `control` (static exact), `fluidflow`, `beltflow`.

## Pass / decision (what LAB-A concludes)
- **No drift (residual ≈ 0):** the gates can go near-exact — float-epsilon + a **complete-loss floor**; delete the
  20/500/5% band. Strong, clean result.
- **Drift = D on fluids:** (a) if giving fluids the same **atomic single-tick scan** belts have removes it → fix
  the measurement (the belt precedent), then near-exact gate; (b) else set each fluid/item gate floor to ~3×D,
  **measured** (like the item gate's belt floor, Pitfall #28) + complete-loss floor.
- Either branch: this is the number that calibrates the #76 fluid gate fix. Do NOT hand-pick a threshold — LAB-A
  produces it.

## Discipline / done criteria
Controls-first (static must read exact before believing any flowing number) · force multi-tick + confirm it ·
tick-stamped readings · **two clean passes** · `--reset` two-instance zero-leftover · append NOTEBOOK incl.
negatives/UNEXPLAINED · on conclusion promote to `docs/factorio-2.0-api-notes.md` with `[empirical, 2.0.77]` and
correct the guessed constants in `transfer-validation.lua` + the claims in CLAUDE.md/AGENTS.md. `/di-change`
before any gate change LAB-A motivates. **Never claim done on one pass; never delete a claim before its rung lands.**

## Immediate blocker
Docker Desktop engine not running → cluster down. Start Docker Desktop, then `docker compose up -d`, poll
controller health + both instances `running` (do NOT touch the `atlas-*` cluster), then build + run.
