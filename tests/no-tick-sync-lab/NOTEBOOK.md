# No-Tick Sync Lab Notebook

## Purpose

This lab gates PR-0B of the Phase-2 plan: the strict transfer gate relies on a synchronous pass that restores captured inserter hands before validation while machines remain deactivated. The tick meter is only the proxy; the blocking claim is that the pass does not advance crafting progress or move the restored held item before the strict count.

## Runner

Run from the repository root while the local cluster is up:

```powershell
node tests/no-tick-sync-lab/run-pr0b.mjs
```

Reset-only cleanup:

```powershell
node tests/no-tick-sync-lab/run-pr0b.mjs --reset
```

## Required Evidence

- `tick_before == tick_after`.
- `crafting_progress_before == crafting_progress_after`.
- `held_item_after_restore == held_item_after_validation`.
- The held-item delta from empty to one `iron-plate` is marked intentional and comes from `ActiveStateRestoration.restore_held_items_only`.
- `TransferValidation.validate_import(... strict = true, skip_fluid_validation = true)` is called and succeeds.
- Final reset reports zero `storage.no_tick_sync_lab`, zero `no-tick-sync-lab-*` surfaces, and `game.tick_paused == false`.


## 2026-07-07T01:34:55.721Z - PR-0B no-tick sync lab run (run-pr0b.mjs)

```json
{
  "script": "tests/no-tick-sync-lab/run-pr0b.mjs",
  "instance": "clusterio-host-1-instance-1",
  "controller": "surface-export-controller",
  "started": "2026-07-07T01:34:55.666Z",
  "rungs": {},
  "errors": [
    "Error: spawnSync docker EPERM\n    at Object.spawnSync (node:internal/child_process:1143:20)\n    at spawnSync (node:child_process:911:24)\n    at execFileSync (node:child_process:954:15)\n    at rcon (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/no-tick-sync-lab/run-pr0b.mjs:13:9)\n    at lua (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/no-tick-sync-lab/run-pr0b.mjs:34:29)\n    at resetLab (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/no-tick-sync-lab/run-pr0b.mjs:149:17)\n    at file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/no-tick-sync-lab/run-pr0b.mjs:176:26\n    at ModuleJob.run (node:internal/modules/esm/module_job:439:25)\n    at async node:internal/modules/esm/loader:633:26\n    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)",
    "cleanup failed: Error: spawnSync docker EPERM\n    at Object.spawnSync (node:internal/child_process:1143:20)\n    at spawnSync (node:child_process:911:24)\n    at execFileSync (node:child_process:954:15)\n    at rcon (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/no-tick-sync-lab/run-pr0b.mjs:13:9)\n    at lua (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/no-tick-sync-lab/run-pr0b.mjs:34:29)\n    at resetLab (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/no-tick-sync-lab/run-pr0b.mjs:149:17)\n    at file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/no-tick-sync-lab/run-pr0b.mjs:181:30\n    at ModuleJob.run (node:internal/modules/esm/module_job:439:25)\n    at async node:internal/modules/esm/loader:633:26\n    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)"
  ],
  "evaluation": {
    "ok": false,
    "checks": {
      "strict_gate_pass": {
        "ok": false,
        "reasons": [
          "missing required rung result"
        ]
      },
      "cleanup": {
        "ok": false,
        "reasons": [
          "zero_storage=undefined zero_surfaces=undefined game_paused=undefined leftovers=[]"
        ]
      }
    },
    "failures": [
      "strict_gate_pass: missing required rung result",
      "cleanup: zero_storage=undefined zero_surfaces=undefined game_paused=undefined leftovers=[]"
    ]
  },
  "finished": "2026-07-07T01:34:55.721Z"
}
```


## 2026-07-07T01:36:05.514Z - PR-0B no-tick sync lab run (run-pr0b.mjs)

```json
{
  "script": "tests/no-tick-sync-lab/run-pr0b.mjs",
  "instance": "clusterio-host-1-instance-1",
  "controller": "surface-export-controller",
  "started": "2026-07-07T01:35:18.720Z",
  "rungs": {
    "strict_gate_pass": {
      "success": false,
      "error": "[string \"local ok,result=pcall(function() ...\"]:2: Require can't be used outside of control.lua parsing."
    }
  },
  "errors": [],
  "initial_reset": {
    "success": true,
    "deleted": {},
    "zero_storage": true,
    "zero_surfaces": true,
    "leftovers": {},
    "game_paused": false
  },
  "final_reset": {
    "success": true,
    "deleted": {},
    "zero_storage": true,
    "zero_surfaces": true,
    "leftovers": {},
    "game_paused": false
  },
  "evaluation": {
    "ok": false,
    "checks": {
      "strict_gate_pass": {
        "ok": false,
        "reasons": [
          "status missing"
        ]
      },
      "cleanup": {
        "ok": true,
        "reasons": []
      }
    },
    "failures": [
      "strict_gate_pass: status missing"
    ]
  },
  "finished": "2026-07-07T01:36:05.514Z"
}
```


## 2026-07-07T01:49:40.414Z - PR-0B no-tick sync lab run (run-pr0b.mjs)

```json
{
  "script": "tests/no-tick-sync-lab/run-pr0b.mjs",
  "instance": "clusterio-host-1-instance-1",
  "controller": "surface-export-controller",
  "started": "2026-07-07T01:49:08.090Z",
  "rungs": {
    "strict_gate_pass": {
      "status": "passed",
      "surface": "no-tick-sync-lab-181738",
      "tick_before": 181738,
      "tick_after": 181738,
      "game_paused": false,
      "machine_active_after": false,
      "inserter_active_after": false,
      "crafting_progress_before": 0.42000000000000004,
      "crafting_progress_after": 0.42000000000000004,
      "held_item_after_restore": {
        "name": "iron-plate",
        "count": 1,
        "quality": "normal"
      },
      "held_item_after_validation": {
        "name": "iron-plate",
        "count": 1,
        "quality": "normal"
      },
      "held_item_intentional_restore": true,
      "restored": 1,
      "failed": 0,
      "validation_called": true,
      "validation_success": true,
      "validation": {
        "itemCountMatch": true,
        "fluidCountMatch": true,
        "entityCount": 115,
        "expectedItemCounts": {
          "iron-plate": 1
        },
        "actualItemCounts": {
          "iron-plate": 1
        },
        "expectedFluidCounts": {},
        "actualFluidCounts": {},
        "entityTypeBreakdown": {
          "cuttlepop": 21,
          "fish": 19,
          "iron-stromatolite": 6,
          "ashland-lichen-tree": 5,
          "sunnycomb": 8,
          "big-demolisher-corpse": 1,
          "lithium-iceberg-huge": 4,
          "lithium-iceberg-big": 31,
          "maraxsis-mollusk-husk": 1,
          "stingfrond": 3,
          "big-sand-rock-underwater": 3,
          "assembling-machine-1": 1,
          "fulgoran-ruin-attractor": 1,
          "water-cane": 7,
          "big-volcanic-rock": 2,
          "big-fulgora-rock": 1,
          "inserter": 1
        },
        "itemTypesExpected": 1,
        "itemTypesActual": 1,
        "fluidTypesExpected": 0,
        "fluidTypesActual": 0,
        "totalExpectedItems": 1,
        "totalActualItems": 1,
        "totalExpectedFluids": 0,
        "totalActualFluids": 0,
        "itemLossByType": {},
        "totalItemLoss": 0
      }
    }
  },
  "errors": [],
  "initial_reset": {
    "success": true,
    "deleted": {},
    "zero_storage": true,
    "zero_surfaces": true,
    "leftovers": {},
    "game_paused": false
  },
  "final_reset": {
    "success": true,
    "deleted": [
      {
        "name": "no-tick-sync-lab-181738",
        "ok": true,
        "error": "nil"
      }
    ],
    "zero_storage": true,
    "zero_surfaces": false,
    "leftovers": [
      "no-tick-sync-lab-181738"
    ],
    "game_paused": false
  },
  "evaluation": {
    "ok": false,
    "checks": {
      "strict_gate_pass": {
        "ok": true,
        "reasons": []
      },
      "cleanup": {
        "ok": false,
        "reasons": [
          "zero_storage=true zero_surfaces=false game_paused=false leftovers=[\"no-tick-sync-lab-181738\"]"
        ]
      }
    },
    "failures": [
      "cleanup: zero_storage=true zero_surfaces=false game_paused=false leftovers=[\"no-tick-sync-lab-181738\"]"
    ]
  },
  "finished": "2026-07-07T01:49:40.414Z"
}
```


## 2026-07-07T01:51:54.450Z - PR-0B no-tick sync lab run (run-pr0b.mjs)

```json
{
  "script": "tests/no-tick-sync-lab/run-pr0b.mjs",
  "instance": "clusterio-host-1-instance-1",
  "controller": "surface-export-controller",
  "started": "2026-07-07T01:50:45.003Z",
  "rungs": {
    "strict_gate_pass": {
      "status": "passed",
      "surface": "no-tick-sync-lab-187755",
      "tick_before": 187755,
      "tick_after": 187755,
      "game_paused": false,
      "machine_active_after": false,
      "inserter_active_after": false,
      "crafting_progress_before": 0.42000000000000004,
      "crafting_progress_after": 0.42000000000000004,
      "held_item_after_restore": {
        "name": "iron-plate",
        "count": 1,
        "quality": "normal"
      },
      "held_item_after_validation": {
        "name": "iron-plate",
        "count": 1,
        "quality": "normal"
      },
      "held_item_intentional_restore": true,
      "restored": 1,
      "failed": 0,
      "validation_called": true,
      "validation_success": true,
      "validation": {
        "itemCountMatch": true,
        "fluidCountMatch": true,
        "entityCount": 115,
        "expectedItemCounts": {
          "iron-plate": 1
        },
        "actualItemCounts": {
          "iron-plate": 1
        },
        "expectedFluidCounts": {},
        "actualFluidCounts": {},
        "entityTypeBreakdown": {
          "cuttlepop": 21,
          "fish": 19,
          "iron-stromatolite": 6,
          "ashland-lichen-tree": 5,
          "sunnycomb": 8,
          "big-demolisher-corpse": 1,
          "lithium-iceberg-huge": 4,
          "lithium-iceberg-big": 31,
          "maraxsis-mollusk-husk": 1,
          "stingfrond": 3,
          "big-sand-rock-underwater": 3,
          "assembling-machine-1": 1,
          "fulgoran-ruin-attractor": 1,
          "water-cane": 7,
          "big-volcanic-rock": 2,
          "big-fulgora-rock": 1,
          "inserter": 1
        },
        "itemTypesExpected": 1,
        "itemTypesActual": 1,
        "fluidTypesExpected": 0,
        "fluidTypesActual": 0,
        "totalExpectedItems": 1,
        "totalActualItems": 1,
        "totalExpectedFluids": 0,
        "totalActualFluids": 0,
        "itemLossByType": {},
        "totalItemLoss": 0
      }
    }
  },
  "errors": [],
  "initial_reset": {
    "success": true,
    "deleted": {},
    "zero_storage": true,
    "zero_surfaces": true,
    "leftovers": {},
    "game_paused": false,
    "post_tick": {
      "success": true,
      "deleted": {},
      "zero_storage": true,
      "zero_surfaces": true,
      "leftovers": {},
      "game_paused": false
    }
  },
  "final_reset": {
    "success": true,
    "deleted": [
      {
        "name": "no-tick-sync-lab-187755",
        "ok": true,
        "error": "nil"
      }
    ],
    "zero_storage": true,
    "zero_surfaces": true,
    "leftovers": {},
    "game_paused": false,
    "post_tick": {
      "success": true,
      "deleted": {},
      "zero_storage": true,
      "zero_surfaces": true,
      "leftovers": {},
      "game_paused": false
    }
  },
  "evaluation": {
    "ok": true,
    "checks": {
      "strict_gate_pass": {
        "ok": true,
        "reasons": []
      },
      "cleanup": {
        "ok": true,
        "reasons": []
      }
    },
    "failures": []
  },
  "finished": "2026-07-07T01:51:54.450Z"
}
```


## 2026-07-10T06:09:28.818Z - B5 craft-without-a-tick run

Prediction: no crafting progress or inventory change without an elapsed tick.

```json
{
  "script": "tests/no-tick-sync-lab/run-b5.mjs",
  "started": "2026-07-10T06:09:15.822Z",
  "sections": [
    "b5"
  ],
  "prediction": "B5: no crafting progress or inventory change without an elapsed tick",
  "rungs": {
    "b5": {
      "success": true,
      "prediction": "no change inside one execution; progress resumes only after elapsed ticks",
      "setup": {
        "setup": {
          "success": true,
          "name": "no-tick-sync-lab-b5-1783663759481",
          "tick": 428336,
          "unit_number": 19955
        },
        "mid_craft": {
          "success": true,
          "tick": 428415,
          "game_paused": false,
          "active": true,
          "status": 1,
          "crafting_progress": 0.4062500000000001,
          "input_count": 9,
          "output_count": 0,
          "fuel_count": 9,
          "entity_ore_count": 9,
          "entity_plate_count": 0
        },
        "frozen": {
          "success": true,
          "tick": 428456,
          "game_paused": false,
          "active": false,
          "status": 60,
          "crafting_progress": 0.619791666666666,
          "input_count": 9,
          "output_count": 0,
          "fuel_count": 9,
          "entity_ore_count": 9,
          "entity_plate_count": 0
        }
      },
      "synchronous": {
        "success": true,
        "before": {
          "tick": 428494,
          "crafting_progress": 0.619791666666666,
          "input_count": 9,
          "output_count": 0
        },
        "after": {
          "tick": 428494,
          "game_paused": false,
          "active": true,
          "crafting_progress": 0.619791666666666,
          "input_count": 9,
          "output_count": 0,
          "entity_ore_count": 9,
          "entity_plate_count": 0
        }
      },
      "plus1": {
        "requested_ticks": 1,
        "observed_elapsed_ticks": 81,
        "read": {
          "success": true,
          "tick": 428575,
          "game_paused": false,
          "active": true,
          "status": 1,
          "crafting_progress": 0.04166666666666458,
          "input_count": 8,
          "output_count": 1,
          "fuel_count": 9,
          "entity_ore_count": 8,
          "entity_plate_count": 1
        }
      },
      "plus60": {
        "requested_additional_ticks": 59,
        "observed_elapsed_ticks": 158,
        "read": {
          "success": true,
          "tick": 428652,
          "game_paused": false,
          "active": true,
          "status": 1,
          "crafting_progress": 0.44270833333333126,
          "input_count": 8,
          "output_count": 1,
          "fuel_count": 9,
          "entity_ore_count": 8,
          "entity_plate_count": 1
        }
      },
      "step_tick_limitation": "/step-tick ignores its count and only unpauses; observed elapsed ticks are reported",
      "same_execution_unchanged": true,
      "resumed_after_ticks": true
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 428101
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 373034
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 428257,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 373189,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      }
    },
    "ok": true
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "no-tick-sync-lab-b5-1783663759481"
        ],
        "tick": 428693
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 373625
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 428851,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 373785,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T06:09:28.818Z"
}
```


## 2026-07-10T06:11:36.620Z - B5 craft-without-a-tick run

Prediction: no crafting progress or inventory change without an elapsed tick.

```json
{
  "script": "tests/no-tick-sync-lab/run-b5.mjs",
  "started": "2026-07-10T06:11:23.736Z",
  "sections": [
    "b5"
  ],
  "prediction": "B5: no crafting progress or inventory change without an elapsed tick",
  "rungs": {
    "b5": {
      "success": true,
      "prediction": "no change inside one execution; progress resumes only after elapsed ticks",
      "setup": {
        "setup": {
          "success": true,
          "name": "no-tick-sync-lab-b5-1783663887377",
          "tick": 434285,
          "unit_number": 19988
        },
        "mid_craft": {
          "success": true,
          "tick": 434365,
          "game_paused": false,
          "active": true,
          "status": 1,
          "crafting_progress": 0.41145833333333337,
          "input_count": 9,
          "output_count": 0,
          "fuel_count": 9,
          "entity_ore_count": 9,
          "entity_plate_count": 0
        },
        "frozen": {
          "success": true,
          "tick": 434403,
          "game_paused": false,
          "active": false,
          "status": 60,
          "crafting_progress": 0.6093749999999993,
          "input_count": 9,
          "output_count": 0,
          "fuel_count": 9,
          "entity_ore_count": 9,
          "entity_plate_count": 0
        }
      },
      "synchronous": {
        "success": true,
        "before": {
          "tick": 434441,
          "crafting_progress": 0.6093749999999993,
          "input_count": 9,
          "output_count": 0
        },
        "after": {
          "tick": 434441,
          "game_paused": false,
          "active": true,
          "crafting_progress": 0.6093749999999993,
          "input_count": 9,
          "output_count": 0,
          "entity_ore_count": 9,
          "entity_plate_count": 0
        }
      },
      "plus1": {
        "requested_ticks": 1,
        "observed_elapsed_ticks": 79,
        "read": {
          "success": true,
          "tick": 434520,
          "game_paused": false,
          "active": true,
          "status": 1,
          "crafting_progress": 0.02083333333333125,
          "input_count": 8,
          "output_count": 1,
          "fuel_count": 9,
          "entity_ore_count": 8,
          "entity_plate_count": 1
        }
      },
      "plus60": {
        "requested_additional_ticks": 59,
        "observed_elapsed_ticks": 159,
        "read": {
          "success": true,
          "tick": 434600,
          "game_paused": false,
          "active": true,
          "status": 1,
          "crafting_progress": 0.43749999999999795,
          "input_count": 8,
          "output_count": 1,
          "fuel_count": 9,
          "entity_ore_count": 8,
          "entity_plate_count": 1
        }
      },
      "step_tick_limitation": "/step-tick ignores its count and only unpauses; observed elapsed ticks are reported",
      "same_execution_unchanged": true,
      "resumed_after_ticks": true
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 434050
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 381190
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 434206,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 381344,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      }
    },
    "ok": true
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "no-tick-sync-lab-b5-1783663887377"
        ],
        "tick": 434639
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 381776
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 434794,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 381933,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T06:11:36.620Z"
}
```


## 2026-07-18T22:55:21.799Z — B8 no-tick baked-pair batch (bake gate, RED)

Runner: `tests/lab-gallery/run-golden-batch.mjs` against the committed golden pair loaded via Clusterio-native save assignment (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}.

**Errors:**
- Error: loaded golden destination bulk_inserter_capacity_bonus is 11, expected 0 (the under-researched adversarial state) — batch cannot discriminate the fix
    at b7AssertAdversarialDest (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/inserter-lab/run-b7-held-capacity-batch.mjs:103:9)
    at main (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/lab-gallery/run-golden-batch.mjs:117:4)

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/lab-gallery/run-golden-batch.mjs",
  "instanceIds": {
    "1": 2119131471,
    "2": 234487481
  },
  "preBatchSaves": {
    "1": "test1.zip",
    "2": "test2.zip"
  },
  "restored": {
    "1": "test1.zip",
    "2": "test2.zip",
    "zeroLeftovers": true
  },
  "finished": "2026-07-18T22:55:21.799Z",
  "green": false,
  "errors": [
    "Error: loaded golden destination bulk_inserter_capacity_bonus is 11, expected 0 (the under-researched adversarial state) — batch cannot discriminate the fix\n    at b7AssertAdversarialDest (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/inserter-lab/run-b7-held-capacity-batch.mjs:103:9)\n    at main (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/lab-gallery/run-golden-batch.mjs:117:4)"
  ]
}
```
</details>

## 2026-07-18T22:57:29.638Z — B8 no-tick baked-pair batch (bake gate, RED)

Runner: `tests/lab-gallery/run-golden-batch.mjs` against the committed golden pair loaded via Clusterio-native save assignment (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}.

**Errors:**
- Error: loaded golden destination bulk_inserter_capacity_bonus is 11, expected 0 (the under-researched adversarial state) — batch cannot discriminate the fix
    at b7AssertAdversarialDest (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/inserter-lab/run-b7-held-capacity-batch.mjs:103:9)
    at main (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/lab-gallery/run-golden-batch.mjs:117:4)

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/lab-gallery/run-golden-batch.mjs",
  "instanceIds": {
    "1": 2119131471,
    "2": 234487481
  },
  "preBatchSaves": {
    "1": "test1.zip",
    "2": "test2.zip"
  },
  "restored": {
    "1": "test1.zip",
    "2": "test2.zip",
    "zeroLeftovers": true
  },
  "finished": "2026-07-18T22:57:29.638Z",
  "green": false,
  "errors": [
    "Error: loaded golden destination bulk_inserter_capacity_bonus is 11, expected 0 (the under-researched adversarial state) — batch cannot discriminate the fix\n    at b7AssertAdversarialDest (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/inserter-lab/run-b7-held-capacity-batch.mjs:103:9)\n    at main (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/lab-gallery/run-golden-batch.mjs:117:4)"
  ]
}
```
</details>

## 2026-07-18T23:02:03.511Z — B8 no-tick baked-pair batch (bake gate, RED)

Runner: `tests/lab-gallery/run-golden-batch.mjs` against the committed golden pair loaded via Clusterio-native save assignment (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}.

**Fingerprint** reproduced from the save-loaded world: assembling-machine-1 at (39.5,-108.5) crafting_progress 0.42000000000000004 (iron-gear-wheel, 4 plates, inactive), inserter at (42.5,-108.5) inactive empty-handed, both indestructible.

**Run 1 (normal, fresh seating)** — tick 9263924==9263924, crafting_progress 0.42000000000000004 unchanged, input 4 unchanged, seated_full=true (restored 1/failed 0), both inactive.

**Run 2 (game.tick_paused, strongest form)** — game_paused=true, tick 9263960==9263960, crafting_progress 0.42000000000000004 EXACTLY unchanged, input 4 unchanged, hand STAYS full ({"name":"iron-plate","count":1,"quality":"normal"}, restored 0 idempotent), both inactive. Golden world unpaused after: true. GREEN.

**Errors:**
- Error: source held quality 'normal', expected 'legendary'
    at b7TransferSection (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/inserter-lab/run-b7-held-capacity-batch.mjs:119:44)
    at main (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/lab-gallery/run-golden-batch.mjs:126:10)

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/lab-gallery/run-golden-batch.mjs",
  "instanceIds": {
    "1": 2119131471,
    "2": 234487481
  },
  "preBatchSaves": {
    "1": "test1.zip",
    "2": "test2.zip"
  },
  "restored": {
    "1": "test1.zip",
    "2": "test2.zip",
    "zeroLeftovers": true
  },
  "finished": "2026-07-18T23:02:03.511Z",
  "green": false,
  "errors": [
    "Error: source held quality 'normal', expected 'legendary'\n    at b7TransferSection (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/inserter-lab/run-b7-held-capacity-batch.mjs:119:44)\n    at main (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/lab-gallery/run-golden-batch.mjs:126:10)"
  ],
  "fingerprint": {
    "success": true,
    "platformIndex": 16,
    "progress": 0.42000000000000004,
    "recipe": "iron-gear-wheel",
    "inputPlates": 4,
    "assemblerActive": false,
    "inserterActive": false,
    "inserterHandEmpty": true,
    "heldCount": 0,
    "allIndestructible": true
  },
  "run1": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9263924,
    "tick_after": 9263924,
    "game_paused": false,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 1,
    "failed": 0,
    "seated_full": true
  },
  "tickPauseRestored": true,
  "run2": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9263960,
    "tick_after": 9263960,
    "game_paused": true,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_before": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 0,
    "failed": 0,
    "seated_full": false
  },
  "verdict": "GREEN"
}
```
</details>

## 2026-07-18T23:04:51.734Z — B8 no-tick baked-pair batch (bake gate, GREEN)

Runner: `tests/lab-gallery/run-golden-batch.mjs` against the committed golden pair loaded via Clusterio-native save assignment (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}.

**Fingerprint** reproduced from the save-loaded world: assembling-machine-1 at (39.5,-108.5) crafting_progress 0.42000000000000004 (iron-gear-wheel, 4 plates, inactive), inserter at (42.5,-108.5) inactive empty-handed, both indestructible.

**Run 1 (normal, fresh seating)** — tick 9265144==9265144, crafting_progress 0.42000000000000004 unchanged, input 4 unchanged, seated_full=true (restored 1/failed 0), both inactive.

**Run 2 (game.tick_paused, strongest form)** — game_paused=true, tick 9265180==9265180, crafting_progress 0.42000000000000004 EXACTLY unchanged, input 4 unchanged, hand STAYS full ({"name":"iron-plate","count":1,"quality":"normal"}, restored 0 idempotent), both inactive. Golden world unpaused after: true. GREEN.

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/lab-gallery/run-golden-batch.mjs",
  "instanceIds": {
    "1": 2119131471,
    "2": 234487481
  },
  "preBatchSaves": {
    "1": "test1.zip",
    "2": "test2.zip"
  },
  "restored": {
    "1": "test1.zip",
    "2": "test2.zip",
    "zeroLeftovers": true
  },
  "finished": "2026-07-18T23:04:51.734Z",
  "green": true,
  "errors": [],
  "fingerprint": {
    "success": true,
    "platformIndex": 16,
    "progress": 0.42000000000000004,
    "recipe": "iron-gear-wheel",
    "inputPlates": 4,
    "assemblerActive": false,
    "inserterActive": false,
    "inserterHandEmpty": true,
    "heldCount": 0,
    "allIndestructible": true
  },
  "run1": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9265144,
    "tick_after": 9265144,
    "game_paused": false,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 1,
    "failed": 0,
    "seated_full": true
  },
  "tickPauseRestored": true,
  "run2": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9265180,
    "tick_after": 9265180,
    "game_paused": true,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_before": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 0,
    "failed": 0,
    "seated_full": false
  },
  "verdict": "GREEN"
}
```
</details>

## 2026-07-18T23:05:54.276Z — B8 no-tick baked-pair batch (bake gate, GREEN)

Runner: `tests/lab-gallery/run-golden-batch.mjs` against the committed golden pair loaded via Clusterio-native save assignment (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}.

**Fingerprint** reproduced from the save-loaded world: assembling-machine-1 at (39.5,-108.5) crafting_progress 0.42000000000000004 (iron-gear-wheel, 4 plates, inactive), inserter at (42.5,-108.5) inactive empty-handed, both indestructible.

**Run 1 (normal, fresh seating)** — tick 9265211==9265211, crafting_progress 0.42000000000000004 unchanged, input 4 unchanged, seated_full=true (restored 1/failed 0), both inactive.

**Run 2 (game.tick_paused, strongest form)** — game_paused=true, tick 9265255==9265255, crafting_progress 0.42000000000000004 EXACTLY unchanged, input 4 unchanged, hand STAYS full ({"name":"iron-plate","count":1,"quality":"normal"}, restored 0 idempotent), both inactive. Golden world unpaused after: true. GREEN.

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/lab-gallery/run-golden-batch.mjs",
  "instanceIds": {
    "1": 2119131471,
    "2": 234487481
  },
  "preBatchSaves": {
    "1": "test1.zip",
    "2": "test2.zip"
  },
  "restored": {
    "1": "test1.zip",
    "2": "test2.zip",
    "zeroLeftovers": true
  },
  "finished": "2026-07-18T23:05:54.276Z",
  "green": true,
  "errors": [],
  "fingerprint": {
    "success": true,
    "platformIndex": 16,
    "progress": 0.42000000000000004,
    "recipe": "iron-gear-wheel",
    "inputPlates": 4,
    "assemblerActive": false,
    "inserterActive": false,
    "inserterHandEmpty": true,
    "heldCount": 0,
    "allIndestructible": true
  },
  "run1": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9265211,
    "tick_after": 9265211,
    "game_paused": false,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 1,
    "failed": 0,
    "seated_full": true
  },
  "tickPauseRestored": true,
  "run2": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9265255,
    "tick_after": 9265255,
    "game_paused": true,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_before": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 0,
    "failed": 0,
    "seated_full": false
  },
  "verdict": "GREEN"
}
```
</details>

## 2026-07-18T23:48:53.198Z — B8 no-tick baked-pair batch (bake gate, GREEN)

Runner: `tests/lab-gallery/run-golden-batch.mjs` against the committed golden pair loaded via Clusterio-native save assignment (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}.

**Fingerprint** reproduced from the save-loaded world: assembling-machine-1 at (39.5,-108.5) crafting_progress 0.42000000000000004 (iron-gear-wheel, 4 plates, inactive), inserter at (42.5,-108.5) inactive empty-handed, both indestructible.

**Run 1 (normal, fresh seating)** — tick 9265685==9265685, crafting_progress 0.42000000000000004 unchanged, input 4 unchanged, seated_full=true (restored 1/failed 0), both inactive.

**Run 2 (game.tick_paused, strongest form)** — game_paused=true, tick 9265745==9265745, crafting_progress 0.42000000000000004 EXACTLY unchanged, input 4 unchanged, hand STAYS full ({"name":"iron-plate","count":1,"quality":"normal"}, restored 0 idempotent), both inactive. Golden world unpaused after: true. GREEN.

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/lab-gallery/run-golden-batch.mjs",
  "instanceIds": {
    "1": 2119131471,
    "2": 234487481
  },
  "preBatchSaves": {
    "1": "test1.zip",
    "2": "test2.zip"
  },
  "restored": {
    "1": "test1.zip",
    "2": "test2.zip",
    "zeroLeftovers": true
  },
  "finished": "2026-07-18T23:48:53.198Z",
  "green": true,
  "errors": [],
  "fingerprint": {
    "success": true,
    "platformIndex": 16,
    "progress": 0.42000000000000004,
    "recipe": "iron-gear-wheel",
    "inputPlates": 4,
    "assemblerActive": false,
    "inserterActive": false,
    "inserterHandEmpty": true,
    "heldCount": 0,
    "allIndestructible": true
  },
  "run1": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9265685,
    "tick_after": 9265685,
    "game_paused": false,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 1,
    "failed": 0,
    "seated_full": true
  },
  "tickPauseRestored": true,
  "run2": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9265745,
    "tick_after": 9265745,
    "game_paused": true,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_before": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 0,
    "failed": 0,
    "seated_full": false
  },
  "verdict": "GREEN"
}
```
</details>

## 2026-07-18T23:50:31.945Z — B8 no-tick baked-pair batch (bake gate, GREEN)

Runner: `tests/lab-gallery/run-golden-batch.mjs` against the committed golden pair loaded via Clusterio-native save assignment (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}.

**Fingerprint** reproduced from the save-loaded world: assembling-machine-1 at (39.5,-108.5) crafting_progress 0.42000000000000004 (iron-gear-wheel, 4 plates, inactive), inserter at (42.5,-108.5) inactive empty-handed, both indestructible.

**Run 1 (normal, fresh seating)** — tick 9265640==9265640, crafting_progress 0.42000000000000004 unchanged, input 4 unchanged, seated_full=true (restored 1/failed 0), both inactive.

**Run 2 (game.tick_paused, strongest form)** — game_paused=true, tick 9265725==9265725, crafting_progress 0.42000000000000004 EXACTLY unchanged, input 4 unchanged, hand STAYS full ({"name":"iron-plate","count":1,"quality":"normal"}, restored 0 idempotent), both inactive. Golden world unpaused after: true. GREEN.

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/lab-gallery/run-golden-batch.mjs",
  "instanceIds": {
    "1": 2119131471,
    "2": 234487481
  },
  "preBatchSaves": {
    "1": "test1.zip",
    "2": "test2.zip"
  },
  "restored": {
    "1": "test1.zip",
    "2": "test2.zip",
    "zeroLeftovers": true
  },
  "finished": "2026-07-18T23:50:31.945Z",
  "green": true,
  "errors": [],
  "fingerprint": {
    "success": true,
    "platformIndex": 16,
    "progress": 0.42000000000000004,
    "recipe": "iron-gear-wheel",
    "inputPlates": 4,
    "assemblerActive": false,
    "inserterActive": false,
    "inserterHandEmpty": true,
    "heldCount": 0,
    "allIndestructible": true
  },
  "run1": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9265640,
    "tick_after": 9265640,
    "game_paused": false,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 1,
    "failed": 0,
    "seated_full": true
  },
  "tickPauseRestored": true,
  "run2": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9265725,
    "tick_after": 9265725,
    "game_paused": true,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_before": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 0,
    "failed": 0,
    "seated_full": false
  },
  "verdict": "GREEN"
}
```
</details>

## 2026-07-19T00:15:20.898Z — B8 no-tick baked-pair batch (bake gate, GREEN)

Runner: `tests/lab-gallery/run-golden-batch.mjs` against the committed golden pair loaded via Clusterio-native save assignment (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}.

**Fingerprint** reproduced from the save-loaded world: assembling-machine-1 at (13.5,27.5) crafting_progress 0.42000000000000004 (iron-gear-wheel, 4 plates, inactive), inserter at (16.5,27.5) inactive empty-handed, both indestructible.

**Run 1 (normal, fresh seating)** — tick 9265251==9265251, crafting_progress 0.42000000000000004 unchanged, input 4 unchanged, seated_full=true (restored 1/failed 0), both inactive.

**Run 2 (game.tick_paused, strongest form)** — game_paused=true, tick 9265291==9265291, crafting_progress 0.42000000000000004 EXACTLY unchanged, input 4 unchanged, hand STAYS full ({"name":"iron-plate","count":1,"quality":"normal"}, restored 0 idempotent), both inactive. Golden world unpaused after: true. GREEN.

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/lab-gallery/run-golden-batch.mjs",
  "instanceIds": {
    "1": 2119131471,
    "2": 234487481
  },
  "preBatchSaves": {
    "1": "test1.zip",
    "2": "test2.zip"
  },
  "restored": {
    "1": "test1.zip",
    "2": "test2.zip",
    "zeroLeftovers": true
  },
  "finished": "2026-07-19T00:15:20.898Z",
  "green": true,
  "errors": [],
  "fingerprint": {
    "success": true,
    "platformIndex": 16,
    "progress": 0.42000000000000004,
    "recipe": "iron-gear-wheel",
    "inputPlates": 4,
    "assemblerActive": false,
    "inserterActive": false,
    "inserterHandEmpty": true,
    "heldCount": 0,
    "allIndestructible": true
  },
  "run1": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9265251,
    "tick_after": 9265251,
    "game_paused": false,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 1,
    "failed": 0,
    "seated_full": true
  },
  "tickPauseRestored": true,
  "run2": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9265291,
    "tick_after": 9265291,
    "game_paused": true,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_before": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 0,
    "failed": 0,
    "seated_full": false
  },
  "verdict": "GREEN"
}
```
</details>

## 2026-07-19T00:16:14.189Z — B8 no-tick baked-pair batch (bake gate, GREEN)

Runner: `tests/lab-gallery/run-golden-batch.mjs` against the committed golden pair loaded via Clusterio-native save assignment (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}.

**Fingerprint** reproduced from the save-loaded world: assembling-machine-1 at (13.5,27.5) crafting_progress 0.42000000000000004 (iron-gear-wheel, 4 plates, inactive), inserter at (16.5,27.5) inactive empty-handed, both indestructible.

**Run 1 (normal, fresh seating)** — tick 9265247==9265247, crafting_progress 0.42000000000000004 unchanged, input 4 unchanged, seated_full=true (restored 1/failed 0), both inactive.

**Run 2 (game.tick_paused, strongest form)** — game_paused=true, tick 9265285==9265285, crafting_progress 0.42000000000000004 EXACTLY unchanged, input 4 unchanged, hand STAYS full ({"name":"iron-plate","count":1,"quality":"normal"}, restored 0 idempotent), both inactive. Golden world unpaused after: true. GREEN.

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/lab-gallery/run-golden-batch.mjs",
  "instanceIds": {
    "1": 2119131471,
    "2": 234487481
  },
  "preBatchSaves": {
    "1": "test1.zip",
    "2": "test2.zip"
  },
  "restored": {
    "1": "test1.zip",
    "2": "test2.zip",
    "zeroLeftovers": true
  },
  "finished": "2026-07-19T00:16:14.189Z",
  "green": true,
  "errors": [],
  "fingerprint": {
    "success": true,
    "platformIndex": 16,
    "progress": 0.42000000000000004,
    "recipe": "iron-gear-wheel",
    "inputPlates": 4,
    "assemblerActive": false,
    "inserterActive": false,
    "inserterHandEmpty": true,
    "heldCount": 0,
    "allIndestructible": true
  },
  "run1": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9265247,
    "tick_after": 9265247,
    "game_paused": false,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 1,
    "failed": 0,
    "seated_full": true
  },
  "tickPauseRestored": true,
  "run2": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9265285,
    "tick_after": 9265285,
    "game_paused": true,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_before": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 0,
    "failed": 0,
    "seated_full": false
  },
  "verdict": "GREEN"
}
```
</details>

## 2026-07-19T02:14:11.859Z — B8 no-tick baked-pair batch (bake gate, GREEN)

Runner: `tests/lab-gallery/run-golden-batch.mjs` against the committed golden pair loaded via Clusterio-native save assignment (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}.

**Fingerprint** reproduced from the save-loaded world: assembling-machine-1 at (13.5,27.5) crafting_progress 0.42000000000000004 (iron-gear-wheel, 4 plates, inactive), inserter at (16.5,27.5) inactive empty-handed, both indestructible.

**Run 1 (normal, fresh seating)** — tick 9265206==9265206, crafting_progress 0.42000000000000004 unchanged, input 4 unchanged, seated_full=true (restored 1/failed 0), both inactive.

**Run 2 (game.tick_paused, strongest form)** — game_paused=true, tick 9265243==9265243, crafting_progress 0.42000000000000004 EXACTLY unchanged, input 4 unchanged, hand STAYS full ({"name":"iron-plate","count":1,"quality":"normal"}, restored 0 idempotent), both inactive. Golden world unpaused after: true. GREEN.

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/lab-gallery/run-golden-batch.mjs",
  "instanceIds": {
    "1": 2119131471,
    "2": 234487481
  },
  "preBatchSaves": {
    "1": "test1.zip",
    "2": "test2.zip"
  },
  "restored": {
    "1": "test1.zip",
    "2": "test2.zip",
    "zeroLeftovers": true
  },
  "finished": "2026-07-19T02:14:11.859Z",
  "green": true,
  "errors": [],
  "fingerprint": {
    "success": true,
    "platformIndex": 16,
    "progress": 0.42000000000000004,
    "recipe": "iron-gear-wheel",
    "inputPlates": 4,
    "assemblerActive": false,
    "inserterActive": false,
    "inserterHandEmpty": true,
    "heldCount": 0,
    "allIndestructible": true
  },
  "run1": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9265206,
    "tick_after": 9265206,
    "game_paused": false,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 1,
    "failed": 0,
    "seated_full": true
  },
  "tickPauseRestored": true,
  "run2": {
    "status": "measured",
    "mode": "measure_baked",
    "platform": "lab-omnibus-state-v1",
    "tick_before": 9265243,
    "tick_after": 9265243,
    "game_paused": true,
    "crafting_progress_before": 0.42000000000000004,
    "crafting_progress_after": 0.42000000000000004,
    "input_count_before": 4,
    "input_count_after": 4,
    "machine_active_after": false,
    "inserter_active_after": false,
    "held_before": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "held_after": {
      "name": "iron-plate",
      "count": 1,
      "quality": "normal"
    },
    "restored": 0,
    "failed": 0,
    "seated_full": false
  },
  "verdict": "GREEN"
}
```
</details>