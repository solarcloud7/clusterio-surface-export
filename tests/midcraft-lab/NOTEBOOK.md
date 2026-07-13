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


## 2026-07-12T20:13:28.452Z - MC1 mid-craft pipeline run

Question: does the crafting_progress restore write TAKE on a fresh deactivated machine, and does the engine then complete the craft producing outputs exactly once?
Measured reality: NONE (instrument failure)

```json
{
  "script": "tests/midcraft-lab/run-mc1.mjs",
  "instance": "clusterio-host-1-instance-1",
  "started": "2026-07-12T20:13:17.163Z",
  "sections": [
    "mc1"
  ],
  "status": "UNVALIDATED-UNTIL-EXECUTED",
  "question": "does the crafting_progress restore write TAKE on a fresh deactivated machine, and does the engine then complete the craft producing outputs exactly once?",
  "rungs": {},
  "errors": [
    "Error: MC1 instrument failure: fixture exhausted (both crafts completed) before a mid-craft freeze landed — shorten the slice: [{\"success\":true,\"tick\":184924,\"game_paused\":false,\"platform_paused\":false,\"active\":false,\"status\":60,\"no_power\":false,\"low_power\":false,\"crafting_progress\":0.966666666666668,\"input_plates\":2,\"output_gears\":0},{\"success\":true,\"tick\":185041,\"game_paused\":false,\"platform_paused\":false,\"active\":false,\"status\":60,\"no_power\":false,\"low_power\":false,\"crafting_progress\":0,\"input_plates\":0,\"output_gears\":2}]\n    at driveToMidCraft (file:///C:/Users/Solar/AppData/Local/Temp/claude/C--Users-Solar-source-FactorioSurfaceExport/3377b11d-8be9-44f4-b352-fe8637faa4a7/scratchpad/state-dim/tests/midcraft-lab/run-mc1.mjs:149:10)\n    at runMC1 (file:///C:/Users/Solar/AppData/Local/Temp/claude/C--Users-Solar-source-FactorioSurfaceExport/3377b11d-8be9-44f4-b352-fe8637faa4a7/scratchpad/state-dim/tests/midcraft-lab/run-mc1.mjs:225:16)\n    at main (file:///C:/Users/Solar/AppData/Local/Temp/claude/C--Users-Solar-source-FactorioSurfaceExport/3377b11d-8be9-44f4-b352-fe8637faa4a7/scratchpad/state-dim/tests/midcraft-lab/run-mc1.mjs:370:53)\n    at file:///C:/Users/Solar/AppData/Local/Temp/claude/C--Users-Solar-source-FactorioSurfaceExport/3377b11d-8be9-44f4-b352-fe8637faa4a7/scratchpad/state-dim/tests/midcraft-lab/run-mc1.mjs:386:6\n    at ModuleJob.run (node:internal/modules/esm/module_job:439:25)\n    at async node:internal/modules/esm/loader:633:26\n    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)"
  ],
  "initial_reset": {
    "cleanup": {
      "success": true,
      "deleted": {},
      "records": {},
      "tick": 184603
    },
    "zero": {
      "success": true,
      "tick": 184713,
      "zero_surfaces": true,
      "surfaces": {},
      "zero_storage": true,
      "defer_flag_clear": true,
      "game_paused": false,
      "destination_holds": 0,
      "locked_platforms": 0,
      "committed_source_transfer_tombstones": 0,
      "lab_platform_exports": 0
    },
    "ok": true
  },
  "prior_config": {
    "success": true,
    "debug_mode": true,
    "had_debug": true,
    "defer": false
  },
  "final_reset": {
    "cleanup": {
      "success": true,
      "deleted": [
        "platform-2"
      ],
      "records": {},
      "tick": 185093
    },
    "zero": {
      "success": true,
      "tick": 185204,
      "zero_surfaces": true,
      "surfaces": {},
      "zero_storage": true,
      "defer_flag_clear": true,
      "game_paused": false,
      "destination_holds": 0,
      "locked_platforms": 0,
      "committed_source_transfer_tombstones": 0,
      "lab_platform_exports": 0
    },
    "ok": true
  },
  "finished": "2026-07-12T20:13:28.452Z"
}
```


## 2026-07-12T20:14:43.181Z - MC1 mid-craft pipeline run

Question: does the crafting_progress restore write TAKE on a fresh deactivated machine, and does the engine then complete the craft producing outputs exactly once?
Measured reality: NONE (instrument failure)

```json
{
  "script": "tests/midcraft-lab/run-mc1.mjs",
  "instance": "clusterio-host-1-instance-1",
  "started": "2026-07-12T20:14:30.866Z",
  "sections": [
    "mc1"
  ],
  "status": "UNVALIDATED-UNTIL-EXECUTED",
  "question": "does the crafting_progress restore write TAKE on a fresh deactivated machine, and does the engine then complete the craft producing outputs exactly once?",
  "rungs": {},
  "errors": [
    "Error: MC1 clone failed: {\"success\":false,\"error\":\"Failed to start import job: Failed to restore platform schedule: Failed to assign base platform.schedule: Index out of bounds.\"}\n    at runMC1 (file:///C:/Users/Solar/AppData/Local/Temp/claude/C--Users-Solar-source-FactorioSurfaceExport/3377b11d-8be9-44f4-b352-fe8637faa4a7/scratchpad/state-dim/tests/midcraft-lab/run-mc1.mjs:234:28)\n    at main (file:///C:/Users/Solar/AppData/Local/Temp/claude/C--Users-Solar-source-FactorioSurfaceExport/3377b11d-8be9-44f4-b352-fe8637faa4a7/scratchpad/state-dim/tests/midcraft-lab/run-mc1.mjs:370:53)\n    at file:///C:/Users/Solar/AppData/Local/Temp/claude/C--Users-Solar-source-FactorioSurfaceExport/3377b11d-8be9-44f4-b352-fe8637faa4a7/scratchpad/state-dim/tests/midcraft-lab/run-mc1.mjs:386:6\n    at ModuleJob.run (node:internal/modules/esm/module_job:439:25)\n    at async node:internal/modules/esm/loader:633:26\n    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)"
  ],
  "initial_reset": {
    "cleanup": {
      "success": true,
      "deleted": {},
      "records": {},
      "tick": 188870
    },
    "zero": {
      "success": true,
      "tick": 188982,
      "zero_surfaces": true,
      "surfaces": {},
      "zero_storage": true,
      "defer_flag_clear": true,
      "game_paused": false,
      "destination_holds": 0,
      "locked_platforms": 0,
      "committed_source_transfer_tombstones": 0,
      "lab_platform_exports": 0
    },
    "ok": true
  },
  "prior_config": {
    "success": true,
    "debug_mode": true,
    "had_debug": true,
    "defer": false
  },
  "final_reset": {
    "cleanup": {
      "success": true,
      "deleted": [
        "platform-2"
      ],
      "records": [
        "export:midcraft-lab-src-1783887274574_189354"
      ],
      "tick": 189407
    },
    "zero": {
      "success": true,
      "tick": 189519,
      "zero_surfaces": true,
      "surfaces": {},
      "zero_storage": true,
      "defer_flag_clear": true,
      "game_paused": false,
      "destination_holds": 0,
      "locked_platforms": 0,
      "committed_source_transfer_tombstones": 0,
      "lab_platform_exports": 0
    },
    "ok": true
  },
  "finished": "2026-07-12T20:14:43.181Z"
}
```


## 2026-07-12T20:16:02.974Z - MC1 mid-craft pipeline run

Question: does the crafting_progress restore write TAKE on a fresh deactivated machine, and does the engine then complete the craft producing outputs exactly once?
Measured reality: RESUME-CLEAN

```json
{
  "script": "tests/midcraft-lab/run-mc1.mjs",
  "instance": "clusterio-host-1-instance-1",
  "started": "2026-07-12T20:15:43.160Z",
  "sections": [
    "mc1"
  ],
  "status": "UNVALIDATED-UNTIL-EXECUTED",
  "question": "does the crafting_progress restore write TAKE on a fresh deactivated machine, and does the engine then complete the craft producing outputs exactly once?",
  "rungs": {
    "mc1": {
      "success": true,
      "measured_reality": "RESUME-CLEAN",
      "pass_fail_table": {
        "RESUME-CLEAN": {
          "criteria": "embodied delta == 0: outputs +1 exactly from the in-flight craft, physical inputs consumed once",
          "measured": true
        },
        "RESET-LOSS": {
          "criteria": "embodied delta == -2: progress dropped, the 2 already-consumed plates' value vanished, the in-flight output never appears",
          "measured": false
        },
        "PHANTOM-GAIN": {
          "criteria": "embodied delta > 0: outputs appear AND inputs not consumed -> item creation",
          "measured": false
        }
      },
      "embodied": {
        "source_frozen": 4,
        "dest_final": 4,
        "delta": 0
      },
      "progress_write_took_on_frozen_dest": false,
      "in_flight_gear_completed": 1,
      "setup": {
        "success": true,
        "recipe": "iron-gear-wheel",
        "inserted": 4,
        "index": 6,
        "machine_productivity": 0,
        "recipe_productivity": 0,
        "surface": 7,
        "tick": 193272,
        "machine_active": false
      },
      "drive_slices": 1,
      "source_frozen": {
        "success": true,
        "tick": 193431,
        "game_paused": false,
        "platform_paused": false,
        "active": false,
        "status": 60,
        "no_power": false,
        "low_power": false,
        "crafting_progress": 0.8666666666666677,
        "input_plates": 2,
        "output_gears": 0
      },
      "defer_armed": {
        "success": true,
        "tick": 193479
      },
      "clone": {
        "success": true,
        "job_id": "import_2",
        "platform_name": "midcraft-lab-dst-1783887346942",
        "source_platform": "midcraft-lab-src-1783887346942",
        "entity_count": 4,
        "message": "Clone job started - use /step-tick to process"
      },
      "job_wait": {
        "success": true,
        "tick": 193584,
        "done": true
      },
      "dest_frozen": {
        "success": true,
        "tick": 193698,
        "game_paused": false,
        "platform_paused": true,
        "active": false,
        "status": 60,
        "no_power": false,
        "low_power": false,
        "crafting_progress": 0.8833333333333344,
        "input_plates": 2,
        "output_gears": 0
      },
      "activation": {
        "success": true,
        "tick": 193748
      },
      "settled": {
        "polls": 2,
        "elapsed_ticks": 220,
        "read": {
          "success": true,
          "tick": 193968,
          "game_paused": false,
          "platform_paused": false,
          "active": true,
          "status": 26,
          "no_power": false,
          "low_power": false,
          "crafting_progress": 0,
          "input_plates": 0,
          "output_gears": 2
        }
      },
      "note": "MEASUREMENT ONLY — no code change either way; refund-not-resume is the closer's adjudicated fix if RESET-LOSS or PHANTOM-GAIN"
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "success": true,
      "deleted": {},
      "records": {},
      "tick": 193055
    },
    "zero": {
      "success": true,
      "tick": 193166,
      "zero_surfaces": true,
      "surfaces": {},
      "zero_storage": true,
      "defer_flag_clear": true,
      "game_paused": false,
      "destination_holds": 0,
      "locked_platforms": 0,
      "committed_source_transfer_tombstones": 0,
      "lab_platform_exports": 0
    },
    "ok": true
  },
  "prior_config": {
    "success": true,
    "debug_mode": true,
    "had_debug": true,
    "defer": false
  },
  "final_reset": {
    "cleanup": {
      "success": true,
      "deleted": [
        "platform-2",
        "platform-3"
      ],
      "records": [
        "export:midcraft-lab-src-1783887346942_193529",
        "job_result:import_2"
      ],
      "tick": 194023
    },
    "zero": {
      "success": true,
      "tick": 194132,
      "zero_surfaces": true,
      "surfaces": {},
      "zero_storage": true,
      "defer_flag_clear": true,
      "game_paused": false,
      "destination_holds": 0,
      "locked_platforms": 0,
      "committed_source_transfer_tombstones": 0,
      "lab_platform_exports": 0
    },
    "ok": true
  },
  "finished": "2026-07-12T20:16:02.974Z"
}
```
