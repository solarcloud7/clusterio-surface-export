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
- Serialized side — **ADJUDICATED 2026-07-09 (boundary stop, verified against code):** the
  `debug_source_platform_*.json` dump is written ONLY when `job.destination_instance_id` is set (transfers —
  `export-pipeline.lua` `if job.destination_instance_id then DebugExport.export_source_platform(...)`), so an
  export-only run has no dump. **Read `storage.platform_exports[<export_id>].verification` instead** — it is the
  SAME table by reference (`job.export_data.verification`, attached after the atomic belt scan) kept as a
  plaintext top-level sibling of the compressed payload ("must be accessible without decompression"), and the
  uncompressed-fallback record resolves `.verification` identically. Conditions: (1) record provenance in
  evidence — `export_id`, `record.tick`, `record.stats.started_tick`, runner-observed completion tick, entity
  count (this doubles as the multi-tick-span proof); (2) keep fixtures small so the RCON JSON print of the
  verification table stays well under the ~8KB response comfort zone (or print per-name lines); (3) cite the
  equivalence in the NOTEBOOK (export-pipeline.lua verification attach + plaintext-sibling store); (4) **the
  zero-leftover contract gains a 7th check for this lab: no lab-created `storage.platform_exports` entries remain**
  (delete them in cleanup — the standard 6 fields do not cover this layer).

## Runner build (Style B — copy `tests/fluid-lab/run-r10.mjs`)
- New: `tests/gate-drift-lab/run-lab-a.mjs`. Change constants: `notebook`, `fixturePrefix="gate-drift-a"`,
  `parseSections` allowlist `["control","fluidflow","beltflow","freeze0"]`, global table name.
- **Reuse unchanged** (per the scaffolding map): `rcon`/`lua`/`lastLine`/`stepTick`/`luaString`/`safeName`/
  `scriptOutput`/`listDebugFiles`/`readJsonFile`/`removeDebugFilesForName`/`getInstanceId`, and the transfer/dump
  layer — BUT LAB-A does NOT need a two-instance transfer for the drift measurement; it exports on host-1 and
  reads the stored export's `verification` table (see the adjudicated Measurement-API note above — the debug
  dump is transfer-only) + a same-tick physical census. (A transfer is only needed if we also want the dest side.)
  So this is closer to a Style-A single-instance export probe reading `storage.platform_exports`.
- Rewrite the install Lua: `mk` bare platform; build the flowing fixture (offshore/pump/pipe/tank + belt loop);
  a `census(platform)` helper returning `{fluid_by_name, item_by_name, tick}` using the dedup above; a
  `flowing_segment_probe` for step 0/precondition 3.
- **Cleanup/zero-leftover: keep the 6-field `cleanupAll`** (`zero_surfaces, zero_storage, game_paused,
  destination_holds, locked_platforms, committed_source_transfer_tombstones`) on BOTH instances; `--reset` branch.
- Sections: `freeze0` (step-0 fluid-flow-while-locked probe), `control` (static exact), `fluidflow`, `beltflow`.

## Pass / decision (what LAB-A concludes)
**THE CONTRACT (owner, 2026-07-08): 100% parity before and after — totals per item (name,quality) and per fluid
name are CONSERVED. A gate tolerance is only ever acceptable for a PROVEN measurement/timing artifact (e.g. the
craft-window read effect), never for real material loss. Real loss is a BUG to fix, not a number to tolerate.**
- **No drift (residual ≈ 0):** the gates go near-exact — float-epsilon + a **complete-loss floor**; delete the
  20/500/5% band. Strong, clean result.
- **Drift = D > 0:** D must be **root-caused before it may become anything**:
  - *Measurement artifact* (snapshot inconsistency — serialized total matches no single tick): **fix the meter** —
    give fluids the same atomic single-tick scan belts have (the Pitfall #16 belt precedent); then near-exact gate.
  - *Real material loss on restore*: a **bug** — file it, fix it, regression-lock it. The gate does NOT get a
    tolerance to paper over it.
  - Only a residual that is proven-artifact AND proven-irreducible may become a gate floor, sized to the
    measurement (like the item gate's belt floor claims to be — which is exactly the claim LAB-A checks), and a
    **complete-loss floor lands regardless of every branch** (no type/name may ever vanish entirely and pass).
- Either branch: this produces the number that calibrates the #76 fluid gate fix. Do NOT hand-pick a threshold —
  LAB-A produces it, and the contract above bounds what it may be used for.

## Execution clarifications (adjudicated 2026-07-09, on the implementer's pre-execution plan)
1. **Span bar:** the flowing sections require an **observed export span ≥5 ticks** (add entities / shrink batch
   size until reached), or report why unattainable — ">1 tick" under-powers the drift window.
2. **freeze0 under the REAL lock:** observe under the production lock/freeze state the export pipeline actually
   applies (ideally sampling during an actual export scan window), never a mere `platform.paused`; record the
   mechanism used in evidence.
3. **Atomic censuses:** each physical census = ONE `/sc` invocation computing and printing all totals within a
   single tick — never assembled across multiple RCON round-trips (that would recreate the rolling-snapshot
   problem the lab exists to measure).
4. Accepted from the implementer's plan: section order `control → freeze0 → fluidflow → beltflow` (stricter
   controls-first than the brief); LAB-A-prefix-only deletion of `storage.platform_exports` records.

## Adjudication 3 (2026-07-09): the flowing-fixture pump stall
The static control PASSED exactly (146-tick export, fluid residual 0, item residual 0 — instrument proven). The
flowing prerequisite failed: a powered, `active=true` pump moved nothing between two connected segments across
three grounded layouts. Ruling — **no fourth layout guess; one DIAGNOSTIC-ONLY pass, then one evidence-grounded
change**:
1. **Read `pump.status`** and map it against `defines.entity_status` (`working` / `no_power` /
   `no_fluid_source` / `disabled` / …) — the engine names the cause directly; this read was missing from all
   three attempts.
2. **Read `prototypes.entity["pump"].surface_conditions`** vs the platform surface's properties — Space Age can
   prototype-restrict an entity from FUNCTIONING on platforms even when script-placed (matches the observed
   symptom exactly). Also read the live `pump.fluidbox.get_pipe_connections(1)` (flow direction + target
   positions) and assert direction against `defines.direction.east` **by the define, not a numeric literal**
   (2.0 uses 16-way directions; a hardcoded old-style value silently snaps).
3. Then **at most ONE change**, dictated by those reads. If the pump is surface-restricted or still stalls:
   **sanctioned fallback mechanism** — machine-driven flow via the fluid-lab R9-proven fixture (chemical plant +
   `heavy-oil-cracking`, buffer-energized; proven on this cluster at 2.0.77). Scientifically valid for LAB-A:
   crafting-driven fluid movement during the scan IS the real-world drift condition (the fluid craft-window);
   the pump was merely the cleaner conserved-total isolate. If the fallback also fails → full stop, escalate.
4. **Bank the evidence now**: append the NOTEBOOK with the control-exact result + the three-layout failure
   ledger (honest negatives seed this lab's TRIED-&-SETTLED table). No api-notes promotion and no commit until
   the flowing arm concludes.

## Discipline / done criteria
Controls-first (static must read exact before believing any flowing number) · force multi-tick + confirm it ·
tick-stamped readings · **two clean passes** · `--reset` two-instance zero-leftover · append NOTEBOOK incl.
negatives/UNEXPLAINED · on conclusion promote to `docs/factorio-2.0-api-notes.md` with `[empirical, 2.0.77]` and
correct the guessed constants in `transfer-validation.lua` + the claims in CLAUDE.md/AGENTS.md. `/di-change`
before any gate change LAB-A motivates. **Never claim done on one pass; never delete a claim before its rung lands.**

## Immediate blocker
Docker Desktop engine not running → cluster down. Start Docker Desktop, then `docker compose up -d`, poll
controller health + both instances `running` (do NOT touch the `atlas-*` cluster), then build + run.
