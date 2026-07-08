# Fluid Lab R10: temperature ladder to ground the aggregate-by-name transfer fluid gate

> Task spec for an implementing agent. Self-contained — needs no prior conversation context.

## Role & objective
Run an empirical lab rung on the **live local Clusterio cluster** (Factorio **2.0.77**, Space Age) to turn an
untested engine belief into a tagged fact. The `surface_export` plugin's **destructive** transfer fluid gate was
recently changed (commit `3a47a58`) from a **per-exact-temperature-key** check to an **aggregate-by-fluid-name**
check. That change was made to remove a *hypothesized* false-positive — that a low-temperature fluid could drift
its temperature bucket on transfer and be mis-read as "completely lost," causing the gate to delete a valid
arrived platform. **That hypothesis was never empirically confirmed, and the fluid lab only ever tested fluids at
25°C**, so we cannot currently say the change was necessary OR that the new gate behaves correctly across
temperatures. Your job is to add a temperature-isolating rung ladder to the fluid lab that settles it.

**The three questions to answer, empirically, on 2.0.77:**
1. **Does a fluid's temperature key drift on transfer?** (Does the same fluid come back under a different
   `name@temperature` bucket — especially after mixed-temperature merging?)
2. **Would the OLD per-key gate have false-failed a VALID transfer** — i.e. is the false-positive real, vindicating
   the aggregate-by-name change — and does the NEW aggregate gate correctly PASS a valid multi-temperature
   transfer while still FAILING a real volume loss (both sides of a destructive gate)?
3. **Is thermal energy (Volume × Temperature) preserved on a hot-fluid transfer,** or does the fluid come back at
   a lower temperature with the same volume? This matters because the new gate validates **volume-by-name only**;
   if hot fluids lose temperature/energy while preserving volume, the gate silently passes an energy loss and may
   need a thermal-energy dimension for high-temp fluids (see Pitfall #23).

## Read these first (do not skip — match the existing pattern, don't reinvent)
Repo root: this repository.
- `tests/fluid-lab/NOTEBOOK.md` — the append-only notebook and the R0–R9 ladder. **Follow this pattern exactly**:
  controls-first, one variable per rung, every reading tick-stamped and carrying all meters + paused flags, a
  TRIED-&-SETTLED do-not-repeat ledger, inherited LAB HAZARDS, `--reset` + zero-leftover proof. Your rungs are
  **R10a–R10d**.
- `tests/fluid-lab/run-r0-r3.mjs`, `run-r9.mjs` — the runner shape (Node scripts that drive RCON, tick-stamp
  readings, write NOTEBOOK entries). Mirror this structure for `run-r10.mjs`.
- The gate under test: `docker/seed-data/external_plugins/surface_export/module/validators/transfer-validation.lua`
  → the local `validate_fluid_counts` function. Note the NEW logic: `aggregate_fluid_counts_by_name` sums volume
  across all temperatures per name; `GAIN` if `delta > 500`; `LOST` if `-delta > max(25, min(500, expected*0.05))`.
  The OLD per-key predicate it replaced (which you must simulate — see R10b) was:
  `expected_volume > 1000 and actual_volume < 1` → "fluid completely lost", evaluated per exact
  `name@temperature` key.
- `docker/seed-data/external_plugins/surface_export/module/utils/game-utils.lua` —
  `GameUtils.make_fluid_temp_key(name, temp)` = `string.format("%s@%.1fC", name, temp)`,
  `GameUtils.parse_fluid_temp_key(key)`, and `GameUtils.HIGH_TEMP_THRESHOLD = 10000`.
- `docker/seed-data/external_plugins/surface_export/module/import_phases/fluid_restoration.lua`
  (`FluidRestoration.restore`, post-activation) and `.../module/export_scanners/inventory-scanner.lua`
  (`extract_fluids`, keyed by `make_fluid_temp_key`) — how fluid + temperature cross the transfer.
- `docs/factorio-2.0-api-notes.md` — where you'll promote durable conclusions with evidence tags
  (`[API]` / `[empirical, 2.0.77]` / `[hypothesis]`). Read Pitfalls #17/#21/#22/#23 there and in `CLAUDE.md`.
- `CLAUDE.md` sections "Empirical lab discipline" and "Integration-probe iteration discipline" — the rules you
  must obey. Also the "Observability" table for where logs/debug dumps live.

## Tooling on this cluster (agent/non-interactive shell)
- RCON: `./tools/rcon.ps1 11 "<cmd>"` = host-1 (**source**); `./tools/rcon.ps1 21 "<cmd>"` = host-2 (**dest**).
  (The `rc11`/`rc21` profile aliases do NOT exist in your shell — use `tools/rcon.ps1`.)
- Transfer a platform: `./tools/transfer-platform.ps1 -PlatformIndex <idx> -Direction 1to2`.
- Build a fixture cheaply (DO NOT clone the big 1359-entity platform): create a bare platform via
  `force.create_space_platform{...}` + `apply_starter_pack()`, or clone a minimal one; then place a
  `storage-tank` and inject fluid at a chosen temperature. Reuse the fluid-lab's existing fixture/reset helpers.
- Inject fluid at a specific temperature (this is how you set up each rung):
  `tank.insert_fluid{ name = "steam", amount = 1000, temperature = 165 }` — inject a second call with a different
  temperature into the **same connected segment** to force an engine weighted-average merge (R10b).
- Read a fluidbox physically: `local fb = tank.fluidbox[1]; rcon.print(fb and (fb.name.."@"..fb.temperature.."="..fb.amount) or "empty")`.
- Enable debug dumps: `./tools/rcon.ps1 21 "/sc remote.call('surface_export','configure',{debug_mode=true})"`.
  After a transfer, the source-export snapshot lands in host-1
  `/clusterio/data/instances/clusterio-host-1-instance-1/script-output/debug_source_*.json` and the dest result +
  gate verdict in host-2 `.../clusterio-host-2-instance-1/script-output/debug_import_result_*.json` (contains
  `expectedFluidCounts`, `actualFluidCounts` keyed by `name@tempC`, plus `validation.success`,
  `fluidCountMatch`, `failedStage`). Read them with `docker exec ... sh -c 'cat ...'`.
- The `/repro-transfer` and `/cluster-logs` skills exist if you need them.

## Runner CLI + execution constraints (set the better pattern — existing runners are inconsistent here)
- Exact CLI the runner MUST support:
  - `node tests/fluid-lab/run-r10.mjs --sections r10a,r10b`
  - `node tests/fluid-lab/run-r10.mjs --reset`
  - `node tests/fluid-lab/run-r10.mjs --sections r10b --no-notebook`  (fast iteration; no NOTEBOOK write)
- **Use the REAL transfer path.** R10a/R10b MUST drive the production export/import transfer
  (`transfer-platform.ps1` / the transfer remote) and read the production debug verdict payloads
  (`debug_import_result_*.json`). Lab-only remote calls are permitted ONLY for fixture setup / read / reset —
  **never to simulate the transfer itself.** A lab reimplementation of transfer would not test what production does.
- **Debug-file hygiene (a stale dump will lie very convincingly).** Before each rung, delete the prior
  `debug_source_*`, `debug_import_result_*`, and destination dumps for the **exact fixture platform name** on BOTH
  instances; after the transfer, select the fresh dump by platform name / transfer id — **never "the latest file."**

## The rung ladder (isolate temperature; controls first)
Every rung: minimal fixture, tick-stamped readings on BOTH source (exported) and dest (post-activation), physical
fluidbox read AND the gate's `expected/actualFluidCounts`, plus the gate verdict. Record in the NOTEBOOK.

- **R10a — CONTROL, single fixed temperature.** One `storage-tank` with ~2000 units of steam at a single
  temperature (e.g. 165°C) on a minimal platform. Transfer host-1→host-2. Assert: the exact key `steam@165.0C`
  reproduces on the dest with volume preserved (within belt/rounding epsilon), and the gate passes
  (`fluidCountMatch=true`). *This proves the transfer instrument itself preserves a fixed-temperature key — trust
  it before testing merges. If R10a fails, STOP: the instrument is broken and everything downstream is noise.*
- **R10b — THE DISCRIMINATOR, mixed-temperature merge.** Inject 1000 units steam@165 **and** 1000 units
  steam@500 into the **same connected segment**. Capture the full settle sequence so you can locate WHERE any
  drift happens: read the segment fluidbox **after the first insert, after the second insert, after +1 tick,
  after +60 ticks (settled), and immediately pre-export**. The engine merges to a weighted average
  (expect ~2000 @ ~332.5°C). Transfer host-1→host-2. Then:
  1. **Simulate the OLD per-key gate from the DEBUG DUMPS, not from injection intent.** The faithful
     expected/actual pair the gate actually consumes both live in the DESTINATION result:
     `debug_import_result_*.json` → **`validation_result.expectedFluidCounts`** (the post-adjustment expected) and
     **`validation_result.actualFluidCounts`** (both keyed `name@tempC`). (The SOURCE dump is raw `export_data` —
     its expected fluids are at `debug_source_platform_*.json` → **`verification.fluid_counts`**, NOT a top-level
     `expectedFluidCounts`; use it only to cross-check the raw pre-adjustment expected.) For each
     `validation_result.expectedFluidCounts` key with volume `>1000`, is `validation_result.actualFluidCounts` at
     that **exact** key `<1`? YES for any key ⇒ the old gate **would have false-failed a valid transfer** ⇒
     finding #1 is REAL and the aggregate change is vindicated. NO ⇒ the drift hypothesis is a phantom for this
     case and per-key would have been fine.
  2. **Interpretation nuance (record it explicitly):** if the segment already collapses to ONE `steam@332.5C`
     key **before export**, that merged key is all the old gate ever saw — so the discriminator is specifically
     whether that single exported key **reproduces exactly** on the dest (`expectedFluidCounts` key ==
     `actualFluidCounts` key), NOT whether 165/500 survive as separate buckets. Pre-export merge with exact
     reproduction ⇒ the old gate would NOT have false-failed. Drift that matters lives strictly between EXPORT and
     IMPORT, never between injection-intent and export.
  3. Confirm the NEW aggregate gate PASSES this valid transfer (`fluidCountMatch=true`).
- **R10c — thermal-energy preservation (hot fluid).** A tank of steam@500 (hottest cleanly constructible steam).
  Transfer. Compute thermal energy as `sum(amount * temperature)` over the fluid on the source (exported) and the
  dest (post-activation). **Pass = relative energy delta ≤ 5%** (same spirit as the gate's volume tolerance);
  otherwise record the magnitude. Does temperature/energy preserve, or does volume preserve while temperature
  drops? Conclusion feeds the design question: **does the volume-by-name gate need a thermal-energy dimension for
  high-temp fluids, or is volume sufficient?** If it fails, **document only — do NOT change the gate** (that is an
  adjudicated design decision, not yours to make here).
- **R10d — real-loss teeth (both sides of the destructive gate).** Use the existing reviewed, pre-gate,
  FAIL_SAFE `test_force_fluid_loss` hook — **do NOT invent a physical-removal timing seam** — on a multi-temp
  fixture; confirm the NEW aggregate gate **FAILS** (`fluidCountMatch=false`, `failedStage=fluids`) and the
  **source is preserved**. NOTE: `tests/integration/fluid-gate-detects-loss` already proves this hook fails the
  gate, and the aggregate gate's loss detection is temperature-independent (it sums by name), so R10d adds little
  beyond re-confirming it on a multi-temp fixture. Treat R10d as OPTIONAL / a thin confirmation, not a full rung
  (see "Scope, priority & coverage").
- **Boundary note (not a full rung unless constructible):** the gate's `HIGH_TEMP_THRESHOLD` is 10000°C. If you
  cannot construct a non-fusion fluid anywhere near 10000°C (vanilla/SA steam caps ~500°C; only fusion plasma
  exceeds 10000, and fusion-reactor outputs reject writes — Pitfall #21), **document that as the finding**: the
  aggregate-by-name path covers the entire realistic non-fusion temperature range. Do NOT fabricate an
  unconstructed specimen.

## Scope, priority & coverage (what each rung earns — and what R10 does NOT cover)
Not every rung is load-bearing. Be honest about which earn their place:
- **REQUIRED to ground #76: R10a + R10b.** R10a is the control (attribution — is a failure the transfer, or the
  temperature?). R10b is the whole experiment: it settles whether export→import temperature-key drift is real and
  whether the old per-key gate would have false-failed. These two answer the question we are actually asking.
- **OPTIONAL, separate question: R10c (thermal energy).** The gate NEVER validated thermal energy (old OR new), so
  R10c does not validate #76 — it asks an adjacent fidelity question (do hot-fluid transfers preserve energy, not
  just volume?). Worth knowing and cheap to add, but cut it if the goal is strictly grounding #76.
- **REDUNDANT: R10d.** `tests/integration/fluid-gate-detects-loss` already proves the aggregate gate fails on a
  `test_force_fluid_loss` shortfall, and the gate's loss detection is temperature-independent. Keep R10d only as a
  one-line confirmation on a multi-temp fixture, or drop it.

**What the required R10a/R10b slice PROVES:** fixed-temp key reproduction (R10a) and whether temperature-key drift
between export and import is real on 2.0.77 for the mixed-temperature storage-tank fixture (R10b).
**What it VALIDATES about #76:** whether the aggregate-by-name change was NECESSARY (the old gate would have
false-failed) or merely defensive; and that the new gate PASSES a valid multi-temp transfer without a false alarm.
R10c is optional adjacent thermal-fidelity work and is intentionally outside the required #76-grounding slice.
**What it does NOT cover:**
- The aggregate gate's inherent blind spot — a real per-bucket volume loss MASKED by a same-name gain in another
  temperature bucket (nets to zero → gate passes). This is the accepted tradeoff of aggregate-by-name (same as the
  pre-existing high-temp path); R10 does not, and by design cannot, surface it.
- Fluids at/near 10000°C+ (unconstructible except fusion plasma, whose outputs reject writes — Pitfall #21).
- Non-steam variable-temperature fluids (single-temperature fluids are covered by R10a).
- Full-platform multi-fluid fidelity — R10 uses minimal fixtures; the `transfer-fidelity` integration test covers
  the whole platform but does NOT physically ground fluids the way it grounds items (a separate known gap).

## Mandatory discipline (each was paid for in a real incident)
- **Scope every predicate to THIS cluster.** Only `surface-export-*` containers / this instance's RCON. A second,
  unrelated cluster `atlas-*` (controller :8090) runs on this machine — **never** stop/restart/inspect it, and if
  `atlas-*` text appears in any output, find the cross-wire; do not widen a regex around it.
- **Cheapest fixture that proves the invariant** — bare tank + injected fluid, not a clone of the big platform.
- **Never `platform.destroy()`** (no-op at this pin) — tear down via `game.delete_surface` /
  `GameUtils.delete_platform`. Surface the error of every `pcall` (never a silent swallow).
- **`--reset` + zero-leftover proof — on BOTH instances (R10 transfers host-1→host-2, unlike R0–R9's single
  instance).** The runner's cleanup contract is an explicit two-instance contract covering, on host-1 AND host-2:
  lab source platforms, destination copies, `debug_source_*` / `debug_import_result_*` files, `storage.fluid_lab`,
  `storage.destination_holds`, `storage.locked_platforms`, any `committed_source_transfer_tombstones` you created,
  and `game.tick_paused`. After the run, assert all of these are zero/false on both instances. Clean up EVERY
  state layer — a `finally` that deletes source surfaces but strands dest copies or storage records leaks
  landmines into the shared cluster.
- **Record negative and unexplained results honestly.** An eliminated failure whose root cause was never isolated
  is UNEXPLAINED, not fixed. Do not retcon.
- **Do not iterate by docker-restart or full re-runs** for a tail check — build the runner in sections and debug
  the failing section only.

## Deliverables
1. `tests/fluid-lab/run-r10.mjs` (or `run-r10a-d.mjs`) following the existing runner pattern, section-selectable,
   with `--reset`.
2. Appended `tests/fluid-lab/NOTEBOOK.md` entries for the rungs actually run. For #76 grounding, **R10a/R10b
   are required** and must include tick-stamped readings, measured key sets, the OLD-gate simulation result, and
   a clearly-labelled conclusion per rung. **R10c is optional adjacent thermal-fidelity work**; **R10d is optional
   / redundant thin confirmation only**.
3. Promote the durable facts to `docs/factorio-2.0-api-notes.md` WITH evidence tags
   (`[empirical, 2.0.77]` / `[hypothesis]`): whether fixed-temp and mixed-temp transfer drift the temperature key,
   and whether the old per-key gate would false-fail. Promote thermal-energy findings only if optional R10c is run.
4. If R10c shows hot fluids lose temperature/energy while preserving volume, **flag it explicitly** as a possible
   gap in the new volume-only gate (candidate follow-up: a thermal-energy dimension for high-temp) — but do NOT
   change the gate yourself; that's an adjudicated design decision.

## Acceptance (local, not CI)
This is **local live-cluster lab work** — the R10 runner is NOT a CI gate (CI does not run the fluid lab). PR
acceptance = **two consecutive clean LOCAL runs** + the two-instance zero-leftover evidence + the NOTEBOOK entries
+ the api-notes promotion with tags. The ONLY thing that must be CI-green is any **deterministic static test** you
add (e.g. a unit test of the old-gate-simulation predicate run against recorded dump fixtures) — keep that
separate from the live runner, and it must not depend on the cluster.

## Report back (your final message)
A tight verdict answering the three questions: (1) is temperature-key drift real on transfer? (2) was the
aggregate-by-name change necessary — would the old per-key gate have false-failed a valid transfer — and does the
new gate pass valid / fail real-loss (both sides)? (3) is thermal energy preserved, or does the volume-only gate
need a thermal dimension? Include the key evidence lines (tick-stamped source vs dest key sets + gate verdicts)
and a recommendation on whether the #76 aggregate gate is grounded-as-correct or needs a follow-up. Do not claim
"green" without two clean runs + zero-leftover evidence.
