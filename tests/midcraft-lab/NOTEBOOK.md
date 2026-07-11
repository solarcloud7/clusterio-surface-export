# Mid-Craft Lab Notebook

> **STATUS: UNVALIDATED.** The MC1 runner was AUTHORED on 2026-07-11 by a worktree agent with NO cluster
> access and has NEVER been executed. Nothing below is an empirical result until a run is appended.
> Append-only from here: never edit or delete a recorded run.

## Purpose

Factorio consumes ingredients at craft START, so a machine mid-craft holds value in NO inventory — the
consumed inputs exist only as `crafting_progress`. The serializer exports `crafting_progress`
(`export_scanners/entity-handlers.lua:82,136`) and the deserializer writes it back via
`SIMPLE_RESTORE_RULES` (`core/deserializer.lua:76`). Two things have never been measured:

1. Does that write TAKE on a freshly created, deactivated machine that never consumed ingredients?
2. If it takes, does the engine then complete the craft on activation, producing outputs **exactly once**?

This decides whether mid-craft embodied value survives a transfer, silently vanishes, or is duplicated.
Per the lab-before-design rule, this is a **[hypothesis]** until the rung's predictions are tested.

## The three candidate realities (MC1 PASS/FAIL table)

Fixture: one `assembling-machine-1`, recipe `iron-gear-wheel` (2 plates -> 1 gear), script-fed exactly
4 iron plates, frozen mid-craft (2 plates consumed by the in-flight craft, 2 in input). "Embodied" =
input plates + 2×output gears + 2×(a craft is in flight), in iron-plate equivalents.

| Reality      | Criterion (measured, derived — never hardcoded)     | Meaning                                                       |
|--------------|------------------------------------------------------|---------------------------------------------------------------|
| RESUME-CLEAN | embodied delta == 0                                   | in-flight craft completes exactly once; inputs consumed once   |
| RESET-LOSS   | embodied delta == -2                                  | progress dropped; the 2 already-consumed plates' value vanished |
| PHANTOM-GAIN | embodied delta > 0                                    | outputs appear AND inputs not consumed — item creation         |

Anything else is **UNCLASSIFIED** (recorded honestly, runner exits non-zero). RESET-LOSS and
PHANTOM-GAIN are valid *findings*, not runner failures — the runner exits 0 on any clean measurement.

**MEASUREMENT ONLY.** MC1 makes no code change regardless of outcome. The adjudicated fix
(refund-not-resume) belongs to the closer if RESET-LOSS or PHANTOM-GAIN is measured, and
`tests/integration/midcraft-roundtrip` is then flipped to `$EXPECTED_BEHAVIOR = 'refund'`.

## Instrument

- Same-instance `remote.call('surface_export','clone_platform', <index>, <dest>)` — runs the FULL
  export+import pipeline with no cross-instance transmission.
- The registered, non-destructive `test_defer_clone_activation` debug flag
  (`interfaces/remote/configure.lua`) leaves the clone DEACTIVATED so the frozen destination census has
  zero crafting confound. Disarmed in the runner's cleanup on every exit path; prior
  `debug_mode`/flag state captured first and restored.
- Shutter for the source: `machine.active` toggle (activate → ~220 ms of real ticks → deactivate+read in
  ONE Lua execution). `platform.paused` is NOT trusted as a simulation freeze (belts move on locked
  platforms — Pitfall #16, atomic belt scan); the entity-active shutter is the same instrument the import
  pipeline itself uses (Pitfall #15, entity activation before validation).

## Runner

Run from the repository root while the local cluster is up:

```powershell
node tests/midcraft-lab/run-mc1.mjs                # run MC1
node tests/midcraft-lab/run-mc1.mjs --reset        # cleanup only
node tests/midcraft-lab/run-mc1.mjs --sections mc1 # explicit (only mc1 exists)
```

## Required evidence for a conclusive run

- Controls first: setup read-asserts the recipe write took (`got=='iron-gear-wheel'`) and exactly 4
  plates inserted (write-assert hazard).
- Source frozen reading tick-stamped, machine `active=false`, `0.05 < crafting_progress < 0.95`
  (the ACHIEVED progress is read, never assumed to be 0.5).
- Dest frozen reading: `active=false` (defer flag held — otherwise instrument failure), plus whether the
  progress write took (`|dest - src| < 0.01`).
- Dest final reading: >=120 elapsed ticks post-activation, two consecutive identical readings, machine
  NOT `no_power`/`low_power`, and evidence it actually ran (an inert machine is instrument failure, not
  RESET-LOSS).
- Exactly one reality row `measured: true`; `in_flight_gear_completed` reported.
- Final reset: zero `midcraft-lab-*` surfaces, `storage.midcraft_lab == nil`, defer flag cleared,
  prefix-scoped export/job-result records purged, game unpaused. Global registry counts
  (destination_holds, locked_platforms, tombstones) are REPORTED but only prefix-scoped leftovers
  hard-fail (shared cluster — other work may be in flight).

## Inherited lab hazards

- `platform.destroy()` is a no-op / drifted semantics — removal via `game.delete_surface` only
  (Pitfall #19); deletion is deferred to end of tick, so the zero-check polls after a sleep.
- Recipe-enable + write-assert: never assume `set_recipe`/insert took; read back.
- on_tick clobber: keep no live state in `storage` beyond the one `storage.midcraft_lab` record.
- `/step-tick` ignores its count and only unpauses (no-tick-sync-lab B5) — elapsed ticks are always
  measured from tick stamps, never requested counts.
- Power: an assembling machine needs electricity; the fixture ships an `electric-energy-interface` with
  a pre-filled buffer, and `no_power`/`low_power` status is checked at every load-bearing reading so a
  dead grid can never masquerade as RESET-LOSS.

## TRIED & SETTLED (do-not-repeat ledger)

*(empty — no runs yet)*

## Runs (append-only)

*(none — the runner has never been executed; the closer appends the first run here)*
