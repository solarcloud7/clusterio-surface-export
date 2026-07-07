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
