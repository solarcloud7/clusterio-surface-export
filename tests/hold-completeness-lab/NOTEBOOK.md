# Hold-Completeness Lab — Notebook (append-only)

Purpose: Phase-0 gate for Phase 2 transfer wiring. The destination-hold primitive has proven item/fluid fidelity, but Phase 2 will hold platforms for a bounded compensation window. This lab measures whether a held platform remains fully non-live for the remaining axes that matter to users and the no-duplicates contract.

Required rungs:

- PR-0A / spoilage: live control must show spoilage movement; held drift must be no worse than live-control drift.
- PR-0A / damage: live control must show asteroid movement or damage exposure; held drift must be no worse than live-control drift, with zero platform damage.
- PR-0A / cargo pods: live control must show pod progress; a staged held platform must be pod-free, pod cargo must remain on the platform, and the notebook must label the constructed pod state exactly. The current live overflow specimen is `awaiting_launch`.

Discipline:

- Append every run, including failures and unconstructible specimens.
- Every reading records `game.tick`, `game.tick_paused`, and `platform_paused` where applicable.
- The runner must reset lab storage and delete lab platforms, then prove zero leftovers.
- UNEXPLAINED is not fixed; unconstructible is not a pass for the wiring gate.
- Meter lesson: the not-live contract is not frozen time. The evaluator accepts held drift only when it is no worse than the live control, with zero platform damage and nothing leaving the platform.

Command:

```powershell
node tests/hold-completeness-lab/run-pr0a.mjs
node tests/hold-completeness-lab/run-pr0a.mjs --reset
```

*(append experiment entries below — script name, date, raw JSON, verdict)*


## 2026-07-06T23:40:20.676Z - PR-0A hold-completeness lab run (run-pr0a.mjs)

```json
{
  "script": "tests/hold-completeness-lab/run-pr0a.mjs",
  "instance": "clusterio-host-1-instance-1",
  "controller": "surface-export-controller",
  "started": "2026-07-06T23:39:54.678Z",
  "rungs": {
    "spoilage": {
      "status": "passed",
      "live_changed": true,
      "held_changed": true,
      "setup": {
        "status": "setup",
        "item": "yumako",
        "transfer_id": "hold-completeness-lab-spoilage-4449164",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-spoilage-4449164",
            "force_name": "player",
            "platform_index": 77,
            "platform_name": "hold-completeness-lab-spoilage-held-4449164",
            "surface_index": 8,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "26773": false
            },
            "deactivated_count": 0,
            "held_tick": 4449164
          }
        },
        "live_seed": {
          "ok_stack": true,
          "stack_error": "nil",
          "ok_spoil": true,
          "spoil_error": "nil"
        },
        "held_seed": {
          "ok_stack": true,
          "stack_error": "nil",
          "ok_spoil": true,
          "spoil_error": "nil"
        },
        "live_before": {
          "label": "spoilage live before",
          "tick": 4449164,
          "game_paused": false,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": false,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.95,
            "spoil_error": "0.95"
          }
        },
        "held_before": {
          "label": "spoilage held before",
          "tick": 4449164,
          "game_paused": false,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": true,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.95,
            "spoil_error": "0.95"
          }
        }
      },
      "after": {
        "live_after": {
          "label": "spoilage live after",
          "tick": 4449327,
          "game_paused": true,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": false,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.9507546296296298,
            "spoil_error": "0.95075462962963"
          }
        },
        "held_after": {
          "label": "spoilage held after",
          "tick": 4449327,
          "game_paused": true,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": true,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.9507546296296298,
            "spoil_error": "0.95075462962963"
          }
        }
      }
    },
    "damage": {
      "status": "passed",
      "live_changed": true,
      "held_changed": true,
      "setup": {
        "status": "setup",
        "asteroid": "small-metallic-asteroid",
        "transfer_id": "hold-completeness-lab-damage-4449327",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-damage-4449327",
            "force_name": "player",
            "platform_index": 79,
            "platform_name": "hold-completeness-lab-damage-held-4449327",
            "surface_index": 10,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "26777": false
            },
            "deactivated_count": 0,
            "held_tick": 4449327
          }
        },
        "live_before": {
          "label": "damage live before",
          "tick": 4449327,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": true,
          "target_health": 350,
          "platform_paused": false,
          "asteroid_health": 100,
          "asteroid_position": {
            "x": 3218,
            "y": 100
          }
        },
        "held_before": {
          "label": "damage held before",
          "tick": 4449327,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": true,
          "target_health": 350,
          "platform_paused": true,
          "asteroid_health": 100,
          "asteroid_position": {
            "x": 3258,
            "y": 100
          }
        }
      },
      "after": {
        "live_after": {
          "label": "damage live after",
          "tick": 4449397,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": false,
          "target_health": 350,
          "platform_paused": false
        },
        "held_after": {
          "label": "damage held after",
          "tick": 4449397,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": false,
          "target_health": 350,
          "platform_paused": true
        }
      }
    },
    "cargo_pods": {
      "status": "passed",
      "live_changed": true,
      "held_changed": true,
      "overflow_preserved": true,
      "setup": {
        "status": "setup",
        "transfer_id": "hold-completeness-lab-cargo-4449397",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-cargo-4449397",
            "force_name": "player",
            "platform_index": 81,
            "platform_name": "hold-completeness-lab-cargo-held-4449397",
            "surface_index": 12,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "26783": false
            },
            "deactivated_count": 0,
            "held_tick": 4449397
          }
        },
        "live_hub_full": true,
        "held_hub_full": true,
        "live_before": {
          "label": "cargo live before",
          "tick": 4449397,
          "game_paused": true,
          "pod_valid": true,
          "hub_valid": true,
          "state": "awaiting_launch",
          "platform_paused": false,
          "pod_items": [
            {
              "name": "copper-plate",
              "quality": "normal",
              "count": 100
            }
          ],
          "hub_copper": 0,
          "hub_iron": 5900,
          "ground_copper": 0
        },
        "held_before": {
          "label": "cargo held before",
          "tick": 4449397,
          "game_paused": true,
          "pod_valid": true,
          "hub_valid": true,
          "state": "awaiting_launch",
          "platform_paused": true,
          "pod_items": [
            {
              "name": "copper-plate",
              "quality": "normal",
              "count": 100
            }
          ],
          "hub_copper": 0,
          "hub_iron": 5900,
          "ground_copper": 0
        },
        "pod_errors": {}
      },
      "after": {
        "live_after": {
          "label": "cargo live after",
          "tick": 4449487,
          "game_paused": true,
          "pod_valid": true,
          "hub_valid": true,
          "state": "ascending",
          "platform_paused": false,
          "pod_items": [
            {
              "name": "copper-plate",
              "quality": "normal",
              "count": 100
            }
          ],
          "hub_copper": 0,
          "hub_iron": 5900,
          "ground_copper": 0
        },
        "held_after": {
          "label": "cargo held after",
          "tick": 4449487,
          "game_paused": true,
          "pod_valid": true,
          "hub_valid": true,
          "state": "ascending",
          "platform_paused": true,
          "pod_items": [
            {
              "name": "copper-plate",
              "quality": "normal",
              "count": 100
            }
          ],
          "hub_copper": 0,
          "hub_iron": 5900,
          "ground_copper": 0
        }
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
  "install": {
    "success": true,
    "base": "2.0.77",
    "tick": 4449072
  },
  "final_reset": {
    "success": true,
    "deleted": [
      {
        "name": "hold-completeness-lab-spoilage-live-4449164",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-spoilage-held-4449164",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-damage-live-4449327",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-damage-held-4449327",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-cargo-live-4449397",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-cargo-held-4449397",
        "ok": true
      }
    ],
    "zero_storage": true,
    "zero_surfaces": false,
    "leftovers": [
      "hold-completeness-lab-spoilage-live-4449164",
      "hold-completeness-lab-spoilage-held-4449164",
      "hold-completeness-lab-damage-live-4449327",
      "hold-completeness-lab-damage-held-4449327",
      "hold-completeness-lab-cargo-live-4449397",
      "hold-completeness-lab-cargo-held-4449397"
    ],
    "game_paused": false
  },
  "evaluation": {
    "ok": false,
    "checks": {
      "spoilage": {
        "ok": false,
        "reason": "held specimen changed while destination hold was active"
      },
      "damage": {
        "ok": false,
        "reason": "held specimen changed while destination hold was active"
      },
      "cargo_pods": {
        "ok": false,
        "reason": "held specimen changed while destination hold was active"
      },
      "cleanup": {
        "ok": false,
        "reason": "zero_storage=true zero_surfaces=false game_paused=false leftovers=[\"hold-completeness-lab-spoilage-live-4449164\",\"hold-completeness-lab-spoilage-held-4449164\",\"hold-completeness-lab-damage-live-4449327\",\"hold-completeness-lab-damage-held-4449327\",\"hold-completeness-lab-cargo-live-4449397\",\"hold-completeness-lab-cargo-held-4449397\"]"
      }
    },
    "failures": [
      "spoilage: held specimen changed while destination hold was active",
      "damage: held specimen changed while destination hold was active",
      "cargo_pods: held specimen changed while destination hold was active",
      "cleanup: zero_storage=true zero_surfaces=false game_paused=false leftovers=[\"hold-completeness-lab-spoilage-live-4449164\",\"hold-completeness-lab-spoilage-held-4449164\",\"hold-completeness-lab-damage-live-4449327\",\"hold-completeness-lab-damage-held-4449327\",\"hold-completeness-lab-cargo-live-4449397\",\"hold-completeness-lab-cargo-held-4449397\"]"
    ]
  },
  "finished": "2026-07-06T23:40:20.676Z"
}
```


## 2026-07-06T23:43:22.425Z - PR-0A hold-completeness lab run (run-pr0a.mjs)

```json
{
  "script": "tests/hold-completeness-lab/run-pr0a.mjs",
  "instance": "clusterio-host-1-instance-1",
  "controller": "surface-export-controller",
  "started": "2026-07-06T23:42:23.501Z",
  "rungs": {
    "spoilage": {
      "status": "passed",
      "live_changed": true,
      "held_changed": true,
      "setup": {
        "status": "setup",
        "item": "yumako",
        "transfer_id": "hold-completeness-lab-spoilage-4457178",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-spoilage-4457178",
            "force_name": "player",
            "platform_index": 83,
            "platform_name": "hold-completeness-lab-spoilage-held-4457178",
            "surface_index": 8,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "26787": false
            },
            "deactivated_count": 0,
            "held_tick": 4457178
          }
        },
        "live_seed": {
          "ok_stack": true,
          "stack_error": "nil",
          "ok_spoil": true,
          "spoil_error": "nil"
        },
        "held_seed": {
          "ok_stack": true,
          "stack_error": "nil",
          "ok_spoil": true,
          "spoil_error": "nil"
        },
        "live_before": {
          "label": "spoilage live before",
          "tick": 4457178,
          "game_paused": false,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": false,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.95,
            "spoil_error": "0.95"
          }
        },
        "held_before": {
          "label": "spoilage held before",
          "tick": 4457178,
          "game_paused": false,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": true,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.95,
            "spoil_error": "0.95"
          }
        }
      },
      "after": {
        "live_after": {
          "label": "spoilage live after",
          "tick": 4457350,
          "game_paused": true,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": false,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.9507962962962961,
            "spoil_error": "0.9507962962963"
          }
        },
        "held_after": {
          "label": "spoilage held after",
          "tick": 4457350,
          "game_paused": true,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": true,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.9507962962962961,
            "spoil_error": "0.9507962962963"
          }
        }
      }
    },
    "damage": {
      "status": "passed",
      "live_changed": true,
      "held_changed": true,
      "setup": {
        "status": "setup",
        "asteroid": "small-metallic-asteroid",
        "transfer_id": "hold-completeness-lab-damage-4457350",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-damage-4457350",
            "force_name": "player",
            "platform_index": 85,
            "platform_name": "hold-completeness-lab-damage-held-4457350",
            "surface_index": 10,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "26791": false
            },
            "deactivated_count": 0,
            "held_tick": 4457350
          }
        },
        "live_before": {
          "label": "damage live before",
          "tick": 4457350,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": true,
          "target_health": 350,
          "platform_paused": false,
          "asteroid_health": 100,
          "asteroid_position": {
            "x": 3458,
            "y": 100
          }
        },
        "held_before": {
          "label": "damage held before",
          "tick": 4457350,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": true,
          "target_health": 350,
          "platform_paused": true,
          "asteroid_health": 100,
          "asteroid_position": {
            "x": 3498,
            "y": 100
          }
        }
      },
      "after": {
        "live_after": {
          "label": "damage live after",
          "tick": 4457451,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": false,
          "target_health": 350,
          "platform_paused": false
        },
        "held_after": {
          "label": "damage held after",
          "tick": 4457451,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": false,
          "target_health": 350,
          "platform_paused": true
        }
      }
    },
    "cargo_pods": {
      "status": "passed",
      "live_changed": true,
      "held_changed": true,
      "overflow_preserved": true,
      "setup": {
        "status": "setup",
        "transfer_id": "hold-completeness-lab-cargo-4457451",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-cargo-4457451",
            "force_name": "player",
            "platform_index": 87,
            "platform_name": "hold-completeness-lab-cargo-held-4457451",
            "surface_index": 12,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "26797": false
            },
            "deactivated_count": 0,
            "held_tick": 4457451
          }
        },
        "live_hub_full": true,
        "held_hub_full": true,
        "live_before": {
          "label": "cargo live before",
          "tick": 4457451,
          "game_paused": true,
          "pod_valid": true,
          "hub_valid": true,
          "state": "awaiting_launch",
          "platform_paused": false,
          "pod_items": [
            {
              "name": "copper-plate",
              "quality": "normal",
              "count": 100
            }
          ],
          "hub_copper": 0,
          "hub_iron": 5900,
          "ground_copper": 0
        },
        "held_before": {
          "label": "cargo held before",
          "tick": 4457451,
          "game_paused": true,
          "pod_valid": true,
          "hub_valid": true,
          "state": "awaiting_launch",
          "platform_paused": true,
          "pod_items": [
            {
              "name": "copper-plate",
              "quality": "normal",
              "count": 100
            }
          ],
          "hub_copper": 0,
          "hub_iron": 5900,
          "ground_copper": 0
        },
        "pod_errors": {}
      },
      "after": {
        "live_after": {
          "label": "cargo live after",
          "tick": 4457569,
          "game_paused": true,
          "pod_valid": true,
          "hub_valid": true,
          "state": "ascending",
          "platform_paused": false,
          "pod_items": [
            {
              "name": "copper-plate",
              "quality": "normal",
              "count": 100
            }
          ],
          "hub_copper": 0,
          "hub_iron": 5900,
          "ground_copper": 0
        },
        "held_after": {
          "label": "cargo held after",
          "tick": 4457569,
          "game_paused": true,
          "pod_valid": true,
          "hub_valid": true,
          "state": "ascending",
          "platform_paused": true,
          "pod_items": [
            {
              "name": "copper-plate",
              "quality": "normal",
              "count": 100
            }
          ],
          "hub_copper": 0,
          "hub_iron": 5900,
          "ground_copper": 0
        }
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
  "install": {
    "success": true,
    "base": "2.0.77",
    "tick": 4457091
  },
  "final_reset": {
    "success": true,
    "deleted": [
      {
        "name": "hold-completeness-lab-spoilage-live-4457178",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-spoilage-held-4457178",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-damage-live-4457350",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-damage-held-4457350",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-cargo-live-4457451",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-cargo-held-4457451",
        "ok": true
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
    "ok": false,
    "checks": {
      "spoilage": {
        "ok": false,
        "reason": "held specimen changed while destination hold was active"
      },
      "damage": {
        "ok": false,
        "reason": "held specimen changed while destination hold was active"
      },
      "cargo_pods": {
        "ok": false,
        "reason": "held specimen changed while destination hold was active"
      },
      "cleanup": {
        "ok": true
      }
    },
    "failures": [
      "spoilage: held specimen changed while destination hold was active",
      "damage: held specimen changed while destination hold was active",
      "cargo_pods: held specimen changed while destination hold was active"
    ]
  },
  "finished": "2026-07-06T23:43:22.425Z"
}
```


## 2026-07-07T00:02:48.037Z - PR-0A hold-completeness lab run (run-pr0a.mjs)

```json
{
  "script": "tests/hold-completeness-lab/run-pr0a.mjs",
  "instance": "clusterio-host-1-instance-1",
  "controller": "surface-export-controller",
  "started": "2026-07-07T00:02:10.422Z",
  "rungs": {
    "spoilage": {
      "status": "passed",
      "live_changed": true,
      "held_changed": true,
      "live_drift": 0.0007546296296297994,
      "held_drift": 0.0007546296296297994,
      "platform_damage": 0,
      "nothing_left_platform": true,
      "setup": {
        "status": "setup",
        "item": "yumako",
        "transfer_id": "hold-completeness-lab-spoilage-177835",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-spoilage-177835",
            "force_name": "player",
            "platform_index": 4,
            "platform_name": "hold-completeness-lab-spoilage-held-177835",
            "surface_index": 8,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "14296": false
            },
            "deactivated_count": 0,
            "pod_completion": {
              "descending": 0,
              "ascending": 0,
              "items_recovered": 0
            },
            "held_tick": 177835
          }
        },
        "live_seed": {
          "ok_stack": true,
          "stack_error": "nil",
          "ok_spoil": true,
          "spoil_error": "nil"
        },
        "held_seed": {
          "ok_stack": true,
          "stack_error": "nil",
          "ok_spoil": true,
          "spoil_error": "nil"
        },
        "live_before": {
          "label": "spoilage live before",
          "tick": 177835,
          "game_paused": false,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": false,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.95,
            "spoil_error": "0.95"
          }
        },
        "held_before": {
          "label": "spoilage held before",
          "tick": 177835,
          "game_paused": false,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": true,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.95,
            "spoil_error": "0.95"
          }
        }
      },
      "after": {
        "live_after": {
          "label": "spoilage live after",
          "tick": 177998,
          "game_paused": true,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": false,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.9507546296296298,
            "spoil_error": "0.95075462962963"
          }
        },
        "held_after": {
          "label": "spoilage held after",
          "tick": 177998,
          "game_paused": true,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": true,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.9507546296296298,
            "spoil_error": "0.95075462962963"
          }
        }
      }
    },
    "damage": {
      "status": "passed",
      "live_changed": true,
      "held_changed": true,
      "live_drift": 2,
      "held_drift": 2,
      "platform_damage": 0,
      "nothing_left_platform": true,
      "setup": {
        "status": "setup",
        "asteroid": "small-metallic-asteroid",
        "transfer_id": "hold-completeness-lab-damage-177998",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-damage-177998",
            "force_name": "player",
            "platform_index": 6,
            "platform_name": "hold-completeness-lab-damage-held-177998",
            "surface_index": 10,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "14300": false
            },
            "deactivated_count": 0,
            "pod_completion": {
              "descending": 0,
              "ascending": 0,
              "items_recovered": 0
            },
            "held_tick": 177998
          }
        },
        "live_before": {
          "label": "damage live before",
          "tick": 177998,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": true,
          "target_health": 350,
          "platform_paused": false,
          "asteroid_health": 100,
          "asteroid_position": {
            "x": 298,
            "y": 100
          }
        },
        "held_before": {
          "label": "damage held before",
          "tick": 177998,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": true,
          "target_health": 350,
          "platform_paused": true,
          "asteroid_health": 100,
          "asteroid_position": {
            "x": 338,
            "y": 100
          }
        }
      },
      "after": {
        "live_after": {
          "label": "damage live after",
          "tick": 178094,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": false,
          "target_health": 350,
          "platform_paused": false
        },
        "held_after": {
          "label": "damage held after",
          "tick": 178094,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": false,
          "target_health": 350,
          "platform_paused": true
        }
      }
    },
    "cargo_pods": {
      "status": "passed",
      "live_changed": true,
      "held_changed": false,
      "live_drift": 4,
      "held_drift": 0,
      "platform_damage": 0,
      "staged_pod_free": false,
      "nothing_left_platform": true,
      "overflow_preserved": true,
      "setup": {
        "success": false,
        "error": "LuaEntity API call when LuaEntity was invalid."
      },
      "after": {
        "live_after": {
          "label": "cargo live after",
          "tick": 178164,
          "game_paused": true,
          "pod_valid": true,
          "hub_valid": true,
          "platform_paused": false,
          "state": "ascending",
          "pod_items": [
            {
              "name": "copper-plate",
              "quality": "normal",
              "count": 100
            }
          ],
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 1,
          "ground_copper": 0,
          "ground_copper_items": 0
        },
        "held_after": {
          "label": "cargo held after",
          "tick": 178164,
          "game_paused": true,
          "pod_valid": false,
          "hub_valid": false
        }
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
  "install": {
    "success": true,
    "base": "2.0.77",
    "tick": 177752
  },
  "final_reset": {
    "success": true,
    "deleted": [
      {
        "name": "hold-completeness-lab-spoilage-live-177835",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-spoilage-held-177835",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-damage-live-177998",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-damage-held-177998",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-cargo-live-178094",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-cargo-held-178094",
        "ok": true
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
    "ok": false,
    "checks": {
      "spoilage": {
        "ok": true,
        "reasons": []
      },
      "damage": {
        "ok": true,
        "reasons": []
      },
      "cargo_pods": {
        "ok": false,
        "reasons": [
          "staged platform was not pod-free after DestinationHold.stage()"
        ]
      },
      "cleanup": {
        "ok": true,
        "reasons": []
      }
    },
    "failures": [
      "cargo_pods: staged platform was not pod-free after DestinationHold.stage()"
    ]
  },
  "finished": "2026-07-07T00:02:48.037Z"
}
```


## 2026-07-07T00:06:12.162Z - PR-0A hold-completeness lab run (run-pr0a.mjs)

```json
{
  "script": "tests/hold-completeness-lab/run-pr0a.mjs",
  "instance": "clusterio-host-1-instance-1",
  "controller": "surface-export-controller",
  "started": "2026-07-07T00:05:37.793Z",
  "rungs": {
    "spoilage": {
      "status": "passed",
      "live_changed": true,
      "held_changed": true,
      "live_drift": 0.0008009259259259549,
      "held_drift": 0.0008009259259259549,
      "platform_damage": 0,
      "nothing_left_platform": true,
      "setup": {
        "status": "setup",
        "item": "yumako",
        "transfer_id": "hold-completeness-lab-spoilage-188328",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-spoilage-188328",
            "force_name": "player",
            "platform_index": 10,
            "platform_name": "hold-completeness-lab-spoilage-held-188328",
            "surface_index": 8,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "14310": false
            },
            "deactivated_count": 0,
            "pod_completion": {
              "descending": 0,
              "ascending": 0,
              "items_recovered": 0
            },
            "held_tick": 188328
          }
        },
        "live_seed": {
          "ok_stack": true,
          "stack_error": "nil",
          "ok_spoil": true,
          "spoil_error": "nil"
        },
        "held_seed": {
          "ok_stack": true,
          "stack_error": "nil",
          "ok_spoil": true,
          "spoil_error": "nil"
        },
        "live_before": {
          "label": "spoilage live before",
          "tick": 188328,
          "game_paused": false,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": false,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.95,
            "spoil_error": "0.95"
          }
        },
        "held_before": {
          "label": "spoilage held before",
          "tick": 188328,
          "game_paused": false,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": true,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.95,
            "spoil_error": "0.95"
          }
        }
      },
      "after": {
        "live_after": {
          "label": "spoilage live after",
          "tick": 188501,
          "game_paused": true,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": false,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.9508009259259259,
            "spoil_error": "0.95080092592593"
          }
        },
        "held_after": {
          "label": "spoilage held after",
          "tick": 188501,
          "game_paused": true,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": true,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.9508009259259259,
            "spoil_error": "0.95080092592593"
          }
        }
      }
    },
    "damage": {
      "status": "passed",
      "live_changed": true,
      "held_changed": true,
      "live_drift": 2,
      "held_drift": 2,
      "platform_damage": 0,
      "nothing_left_platform": true,
      "setup": {
        "status": "setup",
        "asteroid": "small-metallic-asteroid",
        "transfer_id": "hold-completeness-lab-damage-188501",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-damage-188501",
            "force_name": "player",
            "platform_index": 12,
            "platform_name": "hold-completeness-lab-damage-held-188501",
            "surface_index": 10,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "14314": false
            },
            "deactivated_count": 0,
            "pod_completion": {
              "descending": 0,
              "ascending": 0,
              "items_recovered": 0
            },
            "held_tick": 188501
          }
        },
        "live_before": {
          "label": "damage live before",
          "tick": 188501,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": true,
          "target_health": 350,
          "platform_paused": false,
          "asteroid_health": 100,
          "asteroid_position": {
            "x": 538,
            "y": 100
          }
        },
        "held_before": {
          "label": "damage held before",
          "tick": 188501,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": true,
          "target_health": 350,
          "platform_paused": true,
          "asteroid_health": 100,
          "asteroid_position": {
            "x": 578,
            "y": 100
          }
        }
      },
      "after": {
        "live_after": {
          "label": "damage live after",
          "tick": 188581,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": false,
          "target_health": 350,
          "platform_paused": false
        },
        "held_after": {
          "label": "damage held after",
          "tick": 188581,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": false,
          "target_health": 350,
          "platform_paused": true
        }
      }
    },
    "cargo_pods": {
      "status": "passed",
      "live_changed": true,
      "held_changed": false,
      "live_drift": 1,
      "held_drift": 0,
      "platform_damage": 0,
      "staged_pod_free": true,
      "nothing_left_platform": true,
      "overflow_preserved": true,
      "setup": {
        "status": "setup",
        "transfer_id": "hold-completeness-lab-cargo-188581",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-cargo-188581",
            "force_name": "player",
            "platform_index": 14,
            "platform_name": "hold-completeness-lab-cargo-held-188581",
            "surface_index": 12,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "14320": false
            },
            "deactivated_count": 0,
            "pod_completion": {
              "descending": 0,
              "ascending": 0,
              "items_recovered": 0
            },
            "held_tick": 188581
          }
        },
        "expected_copper": 100,
        "live_hub_full": true,
        "held_hub_full": true,
        "live_before": {
          "label": "cargo live before",
          "tick": 188581,
          "game_paused": true,
          "pod_valid": true,
          "hub_valid": true,
          "platform_paused": false,
          "state": "awaiting_launch",
          "pod_items": [
            {
              "name": "copper-plate",
              "quality": "normal",
              "count": 100
            }
          ],
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 1,
          "ground_copper": 0,
          "ground_copper_items": 0
        },
        "held_before": {
          "label": "cargo held after stage",
          "tick": 188581,
          "game_paused": true,
          "pod_valid": false,
          "hub_valid": true,
          "platform_paused": true,
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 0,
          "ground_copper": 100,
          "ground_copper_items": 100
        },
        "held_after_stage": {
          "label": "cargo held after stage",
          "tick": 188581,
          "game_paused": true,
          "pod_valid": false,
          "hub_valid": true,
          "platform_paused": true,
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 0,
          "ground_copper": 100,
          "ground_copper_items": 100
        },
        "pod_errors": {}
      },
      "after": {
        "live_after": {
          "label": "cargo live after",
          "tick": 188697,
          "game_paused": true,
          "pod_valid": true,
          "hub_valid": true,
          "platform_paused": false,
          "state": "ascending",
          "pod_items": [
            {
              "name": "copper-plate",
              "quality": "normal",
              "count": 100
            }
          ],
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 1,
          "ground_copper": 0,
          "ground_copper_items": 0
        },
        "held_after": {
          "label": "cargo held after",
          "tick": 188697,
          "game_paused": true,
          "pod_valid": false,
          "hub_valid": true,
          "platform_paused": true,
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 0,
          "ground_copper": 100,
          "ground_copper_items": 100
        }
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
  "install": {
    "success": true,
    "base": "2.0.77",
    "tick": 188252
  },
  "final_reset": {
    "success": true,
    "deleted": [
      {
        "name": "hold-completeness-lab-spoilage-live-188328",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-spoilage-held-188328",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-damage-live-188501",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-damage-held-188501",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-cargo-live-188581",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-cargo-held-188581",
        "ok": true
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
      "spoilage": {
        "ok": true,
        "reasons": []
      },
      "damage": {
        "ok": true,
        "reasons": []
      },
      "cargo_pods": {
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
  "finished": "2026-07-07T00:06:12.162Z"
}
```


## 2026-07-07T00:23:42.055Z - PR-0A hold-completeness lab run (run-pr0a.mjs)

```json
{
  "script": "tests/hold-completeness-lab/run-pr0a.mjs",
  "instance": "clusterio-host-1-instance-1",
  "controller": "surface-export-controller",
  "started": "2026-07-07T00:23:15.781Z",
  "rungs": {
    "spoilage": {
      "status": "passed",
      "live_changed": true,
      "held_changed": true,
      "live_drift": 0.0006620370370371553,
      "held_drift": 0.0006620370370371553,
      "platform_damage": 0,
      "nothing_left_platform": true,
      "setup": {
        "status": "setup",
        "item": "yumako",
        "transfer_id": "hold-completeness-lab-spoilage-176642",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-spoilage-176642",
            "force_name": "player",
            "platform_index": 4,
            "platform_name": "hold-completeness-lab-spoilage-held-176642",
            "surface_index": 8,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "14296": false
            },
            "deactivated_count": 0,
            "pod_completion": {
              "descending": 0,
              "ascending": 0,
              "items_recovered": 0
            },
            "held_tick": 176642
          }
        },
        "live_seed": {
          "ok_stack": true,
          "stack_error": "nil",
          "ok_spoil": true,
          "spoil_error": "nil"
        },
        "held_seed": {
          "ok_stack": true,
          "stack_error": "nil",
          "ok_spoil": true,
          "spoil_error": "nil"
        },
        "live_before": {
          "label": "spoilage live before",
          "tick": 176642,
          "game_paused": false,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": false,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.95,
            "spoil_error": "0.95"
          }
        },
        "held_before": {
          "label": "spoilage held before",
          "tick": 176642,
          "game_paused": false,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": true,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.95,
            "spoil_error": "0.95"
          }
        }
      },
      "after": {
        "live_after": {
          "label": "spoilage live after",
          "tick": 176785,
          "game_paused": true,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": false,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.9506620370370371,
            "spoil_error": "0.95066203703704"
          }
        },
        "held_after": {
          "label": "spoilage held after",
          "tick": 176785,
          "game_paused": true,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": true,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.9506620370370371,
            "spoil_error": "0.95066203703704"
          }
        }
      }
    },
    "damage": {
      "status": "passed",
      "live_changed": true,
      "held_changed": true,
      "live_drift": 2,
      "held_drift": 2,
      "platform_damage": 0,
      "nothing_left_platform": true,
      "held_asteroid_contained": false,
      "asteroid_terminal_matches_live": true,
      "setup": {
        "status": "setup",
        "asteroid": "small-metallic-asteroid",
        "transfer_id": "hold-completeness-lab-damage-176785",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-damage-176785",
            "force_name": "player",
            "platform_index": 6,
            "platform_name": "hold-completeness-lab-damage-held-176785",
            "surface_index": 10,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "14300": false
            },
            "deactivated_count": 0,
            "pod_completion": {
              "descending": 0,
              "ascending": 0,
              "items_recovered": 0
            },
            "held_tick": 176785
          }
        },
        "live_before": {
          "label": "damage live before",
          "tick": 176785,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": true,
          "target_health": 350,
          "platform_paused": false,
          "asteroid_health": 100,
          "asteroid_position": {
            "x": 298,
            "y": 100
          },
          "asteroid_surface_index": 9
        },
        "held_before": {
          "label": "damage held before",
          "tick": 176785,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": true,
          "target_health": 350,
          "platform_paused": true,
          "asteroid_health": 100,
          "asteroid_position": {
            "x": 338,
            "y": 100
          },
          "asteroid_surface_index": 10
        }
      },
      "after": {
        "live_after": {
          "label": "damage live after",
          "tick": 176866,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": false,
          "target_health": 350,
          "platform_paused": false
        },
        "held_after": {
          "label": "damage held after",
          "tick": 176866,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": false,
          "target_health": 350,
          "platform_paused": true
        }
      }
    },
    "cargo_pods": {
      "status": "passed",
      "live_changed": true,
      "held_changed": false,
      "live_drift": 1,
      "held_drift": 0,
      "platform_damage": 0,
      "staged_pod_free": true,
      "nothing_left_platform": true,
      "overflow_preserved": true,
      "setup": {
        "status": "setup",
        "transfer_id": "hold-completeness-lab-cargo-176866",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-cargo-176866",
            "force_name": "player",
            "platform_index": 8,
            "platform_name": "hold-completeness-lab-cargo-held-176866",
            "surface_index": 12,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "14306": false
            },
            "deactivated_count": 0,
            "pod_completion": {
              "descending": 0,
              "ascending": 0,
              "items_recovered": 100
            },
            "held_tick": 176866
          }
        },
        "expected_copper": 100,
        "live_hub_full": true,
        "held_hub_full": true,
        "live_before": {
          "label": "cargo live before",
          "tick": 176866,
          "game_paused": true,
          "pod_valid": true,
          "hub_valid": true,
          "platform_paused": false,
          "state": "awaiting_launch",
          "pod_items": [
            {
              "name": "copper-plate",
              "quality": "normal",
              "count": 100
            }
          ],
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 1,
          "ground_copper": 0,
          "ground_copper_items": 0
        },
        "held_before": {
          "label": "cargo held after stage",
          "tick": 176866,
          "game_paused": true,
          "pod_valid": false,
          "hub_valid": true,
          "platform_paused": true,
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 0,
          "ground_copper": 100,
          "ground_copper_items": 100
        },
        "held_after_stage": {
          "label": "cargo held after stage",
          "tick": 176866,
          "game_paused": true,
          "pod_valid": false,
          "hub_valid": true,
          "platform_paused": true,
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 0,
          "ground_copper": 100,
          "ground_copper_items": 100
        },
        "pod_errors": {}
      },
      "after": {
        "live_after": {
          "label": "cargo live after",
          "tick": 176925,
          "game_paused": true,
          "pod_valid": true,
          "hub_valid": true,
          "platform_paused": false,
          "state": "ascending",
          "pod_items": [
            {
              "name": "copper-plate",
              "quality": "normal",
              "count": 100
            }
          ],
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 1,
          "ground_copper": 0,
          "ground_copper_items": 0
        },
        "held_after": {
          "label": "cargo held after",
          "tick": 176925,
          "game_paused": true,
          "pod_valid": false,
          "hub_valid": true,
          "platform_paused": true,
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 0,
          "ground_copper": 100,
          "ground_copper_items": 100
        }
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
  "install": {
    "success": true,
    "base": "2.0.77",
    "tick": 176568
  },
  "final_reset": {
    "success": true,
    "deleted": [
      {
        "name": "hold-completeness-lab-spoilage-live-176642",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-spoilage-held-176642",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-damage-live-176785",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-damage-held-176785",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-cargo-live-176866",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-cargo-held-176866",
        "ok": true
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
      "spoilage": {
        "ok": true,
        "reasons": []
      },
      "damage": {
        "ok": true,
        "reasons": []
      },
      "cargo_pods": {
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
  "finished": "2026-07-07T00:23:42.055Z"
}
```


## 2026-07-07T01:00:27.476Z - PR-0A hold-completeness lab run (run-pr0a.mjs)

```json
{
  "script": "tests/hold-completeness-lab/run-pr0a.mjs",
  "instance": "clusterio-host-1-instance-1",
  "controller": "surface-export-controller",
  "started": "2026-07-07T00:59:39.053Z",
  "rungs": {
    "spoilage": {
      "status": "passed",
      "live_changed": true,
      "held_changed": true,
      "live_drift": 0.0008148148148148238,
      "held_drift": 0.0008148148148148238,
      "platform_damage": 0,
      "nothing_left_platform": true,
      "setup": {
        "status": "setup",
        "item": "yumako",
        "transfer_id": "hold-completeness-lab-spoilage-177080",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-spoilage-177080",
            "force_name": "player",
            "platform_index": 4,
            "platform_name": "hold-completeness-lab-spoilage-held-177080",
            "surface_index": 8,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "14296": false
            },
            "deactivated_count": 0,
            "pod_completion": {
              "descending": 0,
              "ascending": 0,
              "items_recovered": 0
            },
            "held_tick": 177080
          }
        },
        "live_seed": {
          "ok_stack": true,
          "stack_error": "nil",
          "ok_spoil": true,
          "spoil_error": "nil"
        },
        "held_seed": {
          "ok_stack": true,
          "stack_error": "nil",
          "ok_spoil": true,
          "spoil_error": "nil"
        },
        "live_before": {
          "label": "spoilage live before",
          "tick": 177080,
          "game_paused": false,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": false,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.95,
            "spoil_error": "0.95"
          }
        },
        "held_before": {
          "label": "spoilage held before",
          "tick": 177080,
          "game_paused": false,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": true,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.95,
            "spoil_error": "0.95"
          }
        }
      },
      "after": {
        "live_after": {
          "label": "spoilage live after",
          "tick": 177256,
          "game_paused": true,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": false,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.9508148148148148,
            "spoil_error": "0.95081481481481"
          }
        },
        "held_after": {
          "label": "spoilage held after",
          "tick": 177256,
          "game_paused": true,
          "valid": true,
          "entity": "steel-chest",
          "platform_paused": true,
          "stack": {
            "name": "yumako",
            "count": 1,
            "spoil_percent": 0.9508148148148148,
            "spoil_error": "0.95081481481481"
          }
        }
      }
    },
    "damage": {
      "status": "passed",
      "live_changed": true,
      "held_changed": true,
      "live_drift": 2,
      "held_drift": 2,
      "platform_damage": 0,
      "nothing_left_platform": true,
      "held_asteroid_contained": false,
      "asteroid_terminal_matches_live": true,
      "setup": {
        "status": "setup",
        "asteroid": "small-metallic-asteroid",
        "transfer_id": "hold-completeness-lab-damage-177256",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-damage-177256",
            "force_name": "player",
            "platform_index": 6,
            "platform_name": "hold-completeness-lab-damage-held-177256",
            "surface_index": 10,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "14300": false
            },
            "deactivated_count": 0,
            "pod_completion": {
              "descending": 0,
              "ascending": 0,
              "items_recovered": 0
            },
            "held_tick": 177256
          }
        },
        "live_before": {
          "label": "damage live before",
          "tick": 177256,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": true,
          "target_health": 350,
          "platform_paused": false,
          "asteroid_health": 100,
          "asteroid_position": {
            "x": 298,
            "y": 100
          },
          "asteroid_surface_index": 9
        },
        "held_before": {
          "label": "damage held before",
          "tick": 177256,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": true,
          "target_health": 350,
          "platform_paused": true,
          "asteroid_health": 100,
          "asteroid_position": {
            "x": 338,
            "y": 100
          },
          "asteroid_surface_index": 10
        }
      },
      "after": {
        "live_after": {
          "label": "damage live after",
          "tick": 177358,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": false,
          "target_health": 350,
          "platform_paused": false
        },
        "held_after": {
          "label": "damage held after",
          "tick": 177358,
          "game_paused": true,
          "target_valid": true,
          "asteroid_valid": false,
          "target_health": 350,
          "platform_paused": true
        }
      }
    },
    "cargo_pods": {
      "status": "passed",
      "live_changed": true,
      "held_changed": false,
      "live_drift": 1,
      "held_drift": 0,
      "platform_damage": 0,
      "staged_pod_free": true,
      "nothing_left_platform": true,
      "overflow_preserved": true,
      "setup": {
        "status": "setup",
        "transfer_id": "hold-completeness-lab-cargo-177358",
        "stage": {
          "success": true,
          "hold": {
            "transfer_id": "hold-completeness-lab-cargo-177358",
            "force_name": "player",
            "platform_index": 8,
            "platform_name": "hold-completeness-lab-cargo-held-177358",
            "surface_index": 12,
            "original_hidden": false,
            "original_paused": false,
            "active_states": {
              "14306": false
            },
            "deactivated_count": 0,
            "pod_completion": {
              "descending": 0,
              "ascending": 0,
              "items_recovered": 100
            },
            "held_tick": 177358
          }
        },
        "expected_copper": 100,
        "live_hub_full": true,
        "held_hub_full": true,
        "live_before": {
          "label": "cargo live before",
          "tick": 177358,
          "game_paused": true,
          "pod_valid": true,
          "hub_valid": true,
          "platform_paused": false,
          "state": "awaiting_launch",
          "pod_items": [
            {
              "name": "copper-plate",
              "quality": "normal",
              "count": 100
            }
          ],
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 1,
          "ground_copper": 0,
          "ground_copper_items": 0
        },
        "held_before": {
          "label": "cargo held after stage",
          "tick": 177358,
          "game_paused": true,
          "pod_valid": false,
          "hub_valid": true,
          "platform_paused": true,
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 0,
          "ground_copper": 100,
          "ground_copper_items": 100
        },
        "held_after_stage": {
          "label": "cargo held after stage",
          "tick": 177358,
          "game_paused": true,
          "pod_valid": false,
          "hub_valid": true,
          "platform_paused": true,
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 0,
          "ground_copper": 100,
          "ground_copper_items": 100
        },
        "pod_errors": {}
      },
      "after": {
        "live_after": {
          "label": "cargo live after",
          "tick": 177544,
          "game_paused": true,
          "pod_valid": true,
          "hub_valid": true,
          "platform_paused": false,
          "state": "ascending",
          "pod_items": [
            {
              "name": "copper-plate",
              "quality": "normal",
              "count": 100
            }
          ],
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 1,
          "ground_copper": 0,
          "ground_copper_items": 0
        },
        "held_after": {
          "label": "cargo held after",
          "tick": 177544,
          "game_paused": true,
          "pod_valid": false,
          "hub_valid": true,
          "platform_paused": true,
          "hub_copper": 0,
          "hub_iron": 5900,
          "pod_count": 0,
          "ground_copper": 100,
          "ground_copper_items": 100
        }
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
  "install": {
    "success": true,
    "base": "2.0.77",
    "tick": 176941
  },
  "final_reset": {
    "success": true,
    "deleted": [
      {
        "name": "hold-completeness-lab-spoilage-live-177080",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-spoilage-held-177080",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-damage-live-177256",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-damage-held-177256",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-cargo-live-177358",
        "ok": true
      },
      {
        "name": "hold-completeness-lab-cargo-held-177358",
        "ok": true
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
      "spoilage": {
        "ok": true,
        "reasons": []
      },
      "damage": {
        "ok": true,
        "reasons": []
      },
      "cargo_pods": {
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
  "finished": "2026-07-07T01:00:27.476Z"
}
```


## 2026-07-19T07:04:20.985Z — hold-buffer-pairs batch (card 3 bake gate, RED)

Runner: `tests/hold-completeness-lab/run-hold-buffer-pairs.mjs` against the committed golden pair (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}. Window 5000 ms (owner contract).

**spoil** — live drift 0.0009768518518519231, held drift 0.0009768518518519231 (law: held <= live); held stack survived; hold discarded clean (holds=0).

**damage** — hold-attributable damage 0; held asteroid contained=false; hold discarded clean (holds=0).

**Errors:**
- Error: pod LAW violated: held copper dropped below 100 (stage=0, after=0) — cargo left the platform
    at file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/hold-completeness-lab/run-hold-buffer-pairs.mjs:326:12
    at runPair (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/hold-completeness-lab/run-hold-buffer-pairs.mjs:192:3)
    at async main (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/hold-completeness-lab/run-hold-buffer-pairs.mjs:307:4)

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/hold-completeness-lab/run-hold-buffer-pairs.mjs",
  "started": "2026-07-19T07:03:18.207Z",
  "sections": [
    "preflight",
    "load",
    "spoil",
    "damage",
    "pod",
    "restore"
  ],
  "errors": [
    "Error: pod LAW violated: held copper dropped below 100 (stage=0, after=0) — cargo left the platform\n    at file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/hold-completeness-lab/run-hold-buffer-pairs.mjs:326:12\n    at runPair (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/hold-completeness-lab/run-hold-buffer-pairs.mjs:192:3)\n    at async main (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/hold-completeness-lab/run-hold-buffer-pairs.mjs:307:4)"
  ],
  "instanceIds": {
    "1": 2119131471,
    "2": 234487481
  },
  "preBatchSaves": {
    "1": "test1.zip",
    "2": "test2.zip"
  },
  "lease": "clean",
  "goldenLoaded": true,
  "spoil": {
    "pair": "spoil",
    "fingerprint": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9508958333333334
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9508958333333334
      }
    },
    "before": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9509861111111111
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9509861111111111
      }
    },
    "transferId": "hold-buffer-spoil-1784444618033",
    "stage": {
      "success": true,
      "hold": {
        "transfer_id": "hold-buffer-spoil-1784444618033",
        "force_name": "player",
        "platform_index": 20,
        "platform_name": "lab-hold-spoil-held-v1",
        "surface_index": 12,
        "original_hidden": false,
        "original_paused": false,
        "active_states": {
          "16247": false
        },
        "deactivated_count": 0,
        "pod_completion": {
          "descending": 0,
          "ascending": 0,
          "items_recovered": 0
        },
        "held_tick": 9265386
      }
    },
    "afterStage": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9512592592592594
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9512592592592594
      }
    },
    "after": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.951962962962963
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.951962962962963
      }
    },
    "liveDrift": 0.0009768518518519231,
    "heldDrift": 0.0009768518518519231,
    "discard": {
      "success": true,
      "discard": {
        "success": true,
        "result": {
          "transfer_id": "hold-buffer-spoil-1784444618033",
          "platform_name": "lab-hold-spoil-held-v1",
          "platform_index": 20,
          "surface_index": 12,
          "deleted": true
        }
      },
      "holds": 0
    },
    "verdict": "GREEN"
  },
  "damage": {
    "pair": "damage",
    "fingerprint": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 14
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 15
      }
    },
    "before": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 14
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 15
      }
    },
    "preWindow": {
      "success": true,
      "woke": 2
    },
    "transferId": "hold-buffer-damage-1784444629063",
    "stage": {
      "success": true,
      "hold": {
        "transfer_id": "hold-buffer-damage-1784444629063",
        "force_name": "player",
        "platform_index": 22,
        "platform_name": "lab-hold-damage-held-v1",
        "surface_index": 15,
        "original_hidden": false,
        "original_paused": false,
        "active_states": {
          "16252": false
        },
        "deactivated_count": 0,
        "pod_completion": {
          "descending": 0,
          "ascending": 0,
          "items_recovered": 0
        },
        "held_tick": 9265983
      }
    },
    "afterStage": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      }
    },
    "after": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      }
    },
    "platformDamage": 0,
    "heldAsteroidContained": false,
    "discard": {
      "success": true,
      "discard": {
        "success": true,
        "result": {
          "transfer_id": "hold-buffer-damage-1784444629063",
          "platform_name": "lab-hold-damage-held-v1",
          "platform_index": 22,
          "surface_index": 15,
          "deleted": true
        }
      },
      "holds": 0
    },
    "verdict": "GREEN"
  },
  "pod": {
    "pair": "pod",
    "fingerprint": {
      "success": true,
      "live": {
        "pods": 1,
        "podCopper": 100,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 100
      },
      "held": {
        "pods": 1,
        "podCopper": 100,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 100
      }
    },
    "before": {
      "success": true,
      "live": {
        "pods": 1,
        "podCopper": 100,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 100
      },
      "held": {
        "pods": 1,
        "podCopper": 100,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 100
      }
    },
    "transferId": "hold-buffer-pod-1784444639618",
    "stage": {
      "success": true,
      "hold": {
        "transfer_id": "hold-buffer-pod-1784444639618",
        "force_name": "player",
        "platform_index": 24,
        "platform_name": "lab-hold-pod-held-v1",
        "surface_index": 17,
        "original_hidden": false,
        "original_paused": false,
        "active_states": {
          "16257": false
        },
        "deactivated_count": 0,
        "pod_completion": {
          "descending": 0,
          "ascending": 1,
          "items_recovered": 0
        },
        "held_tick": 9266549
      }
    },
    "afterStage": {
      "success": true,
      "live": {
        "pods": 1,
        "podCopper": 100,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 100
      },
      "held": {
        "pods": 0,
        "podCopper": 0,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 0
      }
    },
    "after": {
      "success": true,
      "live": {
        "pods": 1,
        "podCopper": 100,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 100
      },
      "held": {
        "pods": 0,
        "podCopper": 0,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 0
      }
    },
    "stagedPodFree": true,
    "discard": {
      "success": true,
      "discard": {
        "success": true,
        "result": {
          "transfer_id": "hold-buffer-pod-1784444639618",
          "platform_name": "lab-hold-pod-held-v1",
          "platform_index": 24,
          "surface_index": 17,
          "deleted": true
        }
      },
      "holds": 0
    }
  },
  "goldenSessionLogTails": {
    "1": "   0.016 Loading mod core 0.0.0 (data.lua)\n   0.025 Loading mod base 2.0.77 (data.lua)\n   0.125 Loading mod elevated-rails 2.0.77 (data.lua)\n   0.137 Loading mod FluidMustFlow 1.4.4 (data.lua)\n   0.143 Loading mod quality 2.0.77 (data.lua)\n   0.152 Loading mod SpidertronEnhancements 1.10.8 (data.lua)\n   0.157 Loading mod space-age 2.0.77 (data.lua)\n   0.273 Loading mod SpidertronPatrols 2.6.3 (data.lua)\n   0.283 Loading mod surfexp_gateways 0.3.1 (data.lua)\n   0.291 Loading mod maraxsis 1.31.6 (data.lua)\n   0.341 Loading mod base 2.0.77 (data-updates.lua)\n   0.358 Loading mod quality 2.0.77 (data-updates.lua)\n   0.392 Loading mod SpidertronEnhancements 1.10.8 (data-updates.lua)\n   0.413 Loading mod space-age 2.0.77 (data-updates.lua)\n   0.427 Loading mod SpidertronPatrols 2.6.3 (data-updates.lua)\n   0.446 Loading mod maraxsis 1.31.6 (data-updates.lua)\n   0.468 Loading mod SpidertronEnhancements 1.10.8 (data-final-fixes.lua)\n   0.487 Loading mod SpidertronPatrols 2.6.3 (data-final-fixes.lua)\n   0.500 Loading mod maraxsis 1.31.6 (data-final-fixes.lua)\n   0.572 Checksum for core: 4187927925\n   0.572 Checksum of base: 1879415942\n   0.572 Checksum of elevated-rails: 70351106\n   0.572 Checksum of FluidMustFlow: 2741802744\n   0.572 Checksum of quality: 1142589254\n   0.572 Checksum of SpidertronEnhancements: 2802774701\n   0.572 Checksum of space-age: 1510664043\n   0.572 Checksum of SpidertronPatrols: 1814447366\n   0.572 Checksum of surfexp_gateways: 3113003946\n   0.572 Checksum of maraxsis: 2814018477\n   0.858 Prototype list checksum: 2702547635\n   0.920 Info PlayerData.cpp:64: Local player-data.json available, timestamp 1784444608\n   0.920 Info PlayerData.cpp:71: Cloud player-data.json unavailable\n   0.921 Info GlobalContext.cpp:1300: Resetting config.\n   0.921 Factorio initialised\n   0.922 Info ServerSynchronizer.cpp:22: nextHeartbeatSequenceNumber(0) initialized Synchronizer nextTickClosureTick(0).\n   0.922 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(Ready) to(PreparedToHostGame)\n   0.922 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(PreparedToHostGame) to(CreatingGame)\n   0.922 Loading map /clusterio/data/instances/clusterio-host-1-instance-1/saves/lab-holdbuf-golden-source.zip: 1325018 bytes.\n   0.932 Loading level.dat: 12364642 bytes.\n   0.932 Info Scenario.cpp:154: Map version 2.0.77-0\n   1.002 Blueprint storage \"blueprint-storage-2.dat\" was not found, trying to load previous version storage \"blueprint-storage.dat\"\n   1.003 Loading script.dat: 44018 bytes.\n   1.017 Checksum for script __level__/control.lua: 2401794522\n   1.018 Checksum for script __FluidMustFlow__/control.lua: 2342970735\n   1.021 Checksum for script __SpidertronEnhancements__/control.lua: 3957523864\n   1.025 Checksum for script __SpidertronPatrols__/control.lua: 591379248\n   1.029 Script @__maraxsis__/lib/events.lua:52: Finalized 67 events for maraxsis\n   1.029 Checksum for script __maraxsis__/control.lua: 2868601269\n   1.032 Info UDPSocket.cpp:38: Opening socket at (IP ADDR:({0.0.0.0:34100}))\n   1.032 Hosting game at IP ADDR:({0.0.0.0:34100})\n   1.032 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/generate-server-padlock-2?api_version=6\n   1.196 Info AuthServerConnector.cpp:112: Obtained serverPadlock for serverHash (SHR1d6IJHgg6i4fBfs0MAnnSmusGvLqH) from the auth server.\n   1.196 Info ServerMultiplayerManager.cpp:808: updateTick(9931228) changing state from(CreatingGame) to(InGame)\n   1.365 Info ServerRouter.cpp:668: Asking pingpong servers (pingpong1.factorio.com:34197, pingpong2.factorio.com:34197, pingpong3.factorio.com:34197, pingpong4.factorio.com:34197) for own address\n   1.365 Info UDPSocket.cpp:50: Opening socket for broadcast\n   1.365 Info RemoteCommandProcessor.cpp:126: Starting RCON interface at IP ADDR:({0.0.0.0:62578})\n   1.365 Info CommandLineMultiplayer.cpp:292: Maximum segment size = 100; minimum segment size = 25; maximum-segment-size peer count = 10; minimum-segment-size peer count = 20\n   1.366 Info RemoteCommandProcessor.cpp:245: New RCON connection from IP ADDR:({127.0.0.1:34310})\n   1.383 Script @__level__/modules/surface_export/core/gateway.lua:61: [Gateway] discover_and_unlock: 12 gateway/force unlocks\n   1.383 Script @__level__/modules/surface_export/control.lua:92: [Surface Export] Connected to Clusterio controller\n   1.399 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:64926}), expected IP ADDR:({209.236.82.227:58377}))\n   1.399 Script @__level__/modules/surface_export/control.lua:96: [Surface Export] Instance configuration updated\n   1.400 Warning ServerMultiplayerManager.cpp:654: Determining own address has failed. Best guess: IP ADDR:({209.236.82.227:58377})\n   1.400 Info AuthServerConnector.cpp:620: Performing TLS check.\n   1.400 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/tls-check/success\n   1.449 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=50, max_concurrent_jobs=3, show_progress=true, debug_mode=true\n   1.466 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:56318}), expected IP ADDR:({209.236.82.227:58377}))\n   1.466 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:80: [FactorioSurfaceExport] Gateway config updated: 0 gateway(s)\n   1.466 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=unchanged, max_concurrent_jobs=unchanged, show_progress=nil, debug_mode=nil\n   1.516 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:49492}), expected IP ADDR:({209.236.82.227:58377}))\n   1.749 Info AuthServerConnector.cpp:653: TLS check success.\n   2.214 Info MatchingServer.cpp:129: Matching server game `961257` has been created.\n   2.216 Info ServerMultiplayerManager.cpp:738: Matching server connection resumed\n   9.633 Script @__level__/modules/surface_export/core/destination-hold.lua:184: [DestinationHold] staged transfer hold-buffer-spoil-1784444618033 on platform 'lab-hold-spoil-held-v1' (idx=20, surface=12, deactivated=0, pods=0/0, recovered=0)\n  19.273 Script @__level__/modules/surface_export/core/destination-hold.lua:239: [DestinationHold] discarded transfer hold-buffer-spoil-1784444618033 platform 'lab-hold-spoil-held-v1' (deleted=true)\n  22.923 Script @__level__/modules/surface_export/core/destination-hold.lua:184: [DestinationHold] staged transfer hold-buffer-damage-1784444629063 on platform 'lab-hold-damage-held-v1' (idx=22, surface=15, deactivated=0, pods=0/0, recovered=0)\n  29.273 Script @__level__/modules/surface_export/core/destination-hold.lua:239: [DestinationHold] discarded transfer hold-buffer-damage-1784444629063 platform 'lab-hold-damage-held-v1' (deleted=true)\n  32.357 Script @__level__/modules/surface_export/utils/surface-lock.lua:223: [SurfaceLock] Completed 0 descending pods (recovered 0 items), 1 ascending pods\n  32.357 Script @__level__/modules/surface_export/core/destination-hold.lua:184: [DestinationHold] staged transfer hold-buffer-pod-1784444639618 on platform 'lab-hold-pod-held-v1' (idx=24, surface=17, deactivated=0, pods=0/1, recovered=0)\n  38.806 Script @__level__/modules/surface_export/core/destination-hold.lua:239: [DestinationHold] discarded transfer hold-buffer-pod-1784444639618 platform 'lab-hold-pod-held-v1' (deleted=true)\n",
    "2": "   0.007 Info ModManager.cpp:449: FeatureFlag space-travel = true\n   0.007 Info ModManager.cpp:449: FeatureFlag spoiling = true\n   0.009 Loading mod settings FluidMustFlow 1.4.4 (settings.lua)\n   0.011 Loading mod settings SpidertronEnhancements 1.10.8 (settings.lua)\n   0.012 Loading mod settings SpidertronPatrols 2.6.3 (settings.lua)\n   0.013 Loading mod settings maraxsis 1.31.6 (settings.lua)\n   0.014 Loading mod settings maraxsis 1.31.6 (settings-updates.lua)\n   0.016 Loading mod core 0.0.0 (data.lua)\n   0.025 Loading mod base 2.0.77 (data.lua)\n   0.111 Loading mod elevated-rails 2.0.77 (data.lua)\n   0.124 Loading mod FluidMustFlow 1.4.4 (data.lua)\n   0.130 Loading mod quality 2.0.77 (data.lua)\n   0.137 Loading mod SpidertronEnhancements 1.10.8 (data.lua)\n   0.142 Loading mod space-age 2.0.77 (data.lua)\n   0.241 Loading mod SpidertronPatrols 2.6.3 (data.lua)\n   0.252 Loading mod surfexp_gateways 0.3.1 (data.lua)\n   0.259 Loading mod maraxsis 1.31.6 (data.lua)\n   0.299 Loading mod base 2.0.77 (data-updates.lua)\n   0.313 Loading mod quality 2.0.77 (data-updates.lua)\n   0.335 Loading mod SpidertronEnhancements 1.10.8 (data-updates.lua)\n   0.347 Loading mod space-age 2.0.77 (data-updates.lua)\n   0.356 Loading mod SpidertronPatrols 2.6.3 (data-updates.lua)\n   0.369 Loading mod maraxsis 1.31.6 (data-updates.lua)\n   0.384 Loading mod SpidertronEnhancements 1.10.8 (data-final-fixes.lua)\n   0.399 Loading mod SpidertronPatrols 2.6.3 (data-final-fixes.lua)\n   0.410 Loading mod maraxsis 1.31.6 (data-final-fixes.lua)\n   0.482 Checksum for core: 4187927925\n   0.483 Checksum of base: 1879415942\n   0.483 Checksum of elevated-rails: 70351106\n   0.483 Checksum of FluidMustFlow: 2741802744\n   0.483 Checksum of quality: 1142589254\n   0.483 Checksum of SpidertronEnhancements: 2802774701\n   0.483 Checksum of space-age: 1510664043\n   0.483 Checksum of SpidertronPatrols: 1814447366\n   0.483 Checksum of surfexp_gateways: 3113003946\n   0.483 Checksum of maraxsis: 2814018477\n   0.810 Prototype list checksum: 2702547635\n   0.871 Info PlayerData.cpp:64: Local player-data.json available, timestamp 1784444609\n   0.871 Info PlayerData.cpp:71: Cloud player-data.json unavailable\n   0.872 Info GlobalContext.cpp:1300: Resetting config.\n   0.872 Factorio initialised\n   0.872 Info ServerSynchronizer.cpp:22: nextHeartbeatSequenceNumber(0) initialized Synchronizer nextTickClosureTick(0).\n   0.872 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(Ready) to(PreparedToHostGame)\n   0.872 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(PreparedToHostGame) to(CreatingGame)\n   0.872 Loading map /clusterio/data/instances/clusterio-host-2-instance-1/saves/lab-holdbuf-golden-dest.zip: 550461 bytes.\n   0.881 Loading level.dat: 3081268 bytes.\n   0.881 Info Scenario.cpp:154: Map version 2.0.77-0\n   0.895 Blueprint storage \"blueprint-storage-2.dat\" was not found, trying to load previous version storage \"blueprint-storage.dat\"\n   0.895 Loading script.dat: 44023 bytes.\n   0.908 Checksum for script __level__/control.lua: 2401794522\n   0.909 Checksum for script __FluidMustFlow__/control.lua: 2342970735\n   0.912 Checksum for script __SpidertronEnhancements__/control.lua: 3957523864\n   0.916 Checksum for script __SpidertronPatrols__/control.lua: 591379248\n   0.920 Script @__maraxsis__/lib/events.lua:52: Finalized 67 events for maraxsis\n   0.920 Checksum for script __maraxsis__/control.lua: 2868601269\n   0.922 Info UDPSocket.cpp:38: Opening socket at (IP ADDR:({0.0.0.0:34200}))\n   0.922 Hosting game at IP ADDR:({0.0.0.0:34200})\n   0.922 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/generate-server-padlock-2?api_version=6\n   1.081 Info AuthServerConnector.cpp:112: Obtained serverPadlock for serverHash (vN4iOZQSB6dc7ckoWoO3SIIgDIvGWHRn) from the auth server.\n   1.081 Info ServerMultiplayerManager.cpp:808: updateTick(9933208) changing state from(CreatingGame) to(InGame)\n   1.088 Info ServerRouter.cpp:668: Asking pingpong servers (pingpong1.factorio.com:34197, pingpong2.factorio.com:34197, pingpong3.factorio.com:34197, pingpong4.factorio.com:34197) for own address\n   1.088 Info UDPSocket.cpp:50: Opening socket for broadcast\n   1.089 Info RemoteCommandProcessor.cpp:126: Starting RCON interface at IP ADDR:({0.0.0.0:62071})\n   1.089 Info CommandLineMultiplayer.cpp:292: Maximum segment size = 100; minimum segment size = 25; maximum-segment-size peer count = 10; minimum-segment-size peer count = 20\n   1.089 Info RemoteCommandProcessor.cpp:245: New RCON connection from IP ADDR:({127.0.0.1:51958})\n   1.106 Script @__level__/modules/surface_export/core/gateway.lua:61: [Gateway] discover_and_unlock: 12 gateway/force unlocks\n   1.106 Script @__level__/modules/surface_export/control.lua:92: [Surface Export] Connected to Clusterio controller\n   1.122 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:61735}), expected IP ADDR:({209.236.82.227:63444}))\n   1.122 Script @__level__/modules/surface_export/control.lua:96: [Surface Export] Instance configuration updated\n   1.123 Warning ServerMultiplayerManager.cpp:654: Determining own address has failed. Best guess: IP ADDR:({209.236.82.227:63444})\n   1.123 Info AuthServerConnector.cpp:620: Performing TLS check.\n   1.123 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/tls-check/success\n   1.173 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=50, max_concurrent_jobs=3, show_progress=true, debug_mode=true\n   1.189 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:64927}), expected IP ADDR:({209.236.82.227:63444}))\n   1.189 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:80: [FactorioSurfaceExport] Gateway config updated: 0 gateway(s)\n   1.189 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=unchanged, max_concurrent_jobs=unchanged, show_progress=nil, debug_mode=nil\n   1.239 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:61734}), expected IP ADDR:({209.236.82.227:63444}))\n   1.267 Info AuthServerConnector.cpp:653: TLS check success.\n   1.783 Info MatchingServer.cpp:129: Matching server game `961258` has been created.\n   1.789 Info ServerMultiplayerManager.cpp:738: Matching server connection resumed\n"
  },
  "restored": {
    "1": "test1.zip",
    "2": "test2.zip",
    "zeroLeftovers": true
  },
  "finished": "2026-07-19T07:04:20.985Z",
  "green": false
}
```
</details>

## 2026-07-19T07:06:21.669Z — hold-buffer-pairs batch (card 3 bake gate, RED)

Runner: `tests/hold-completeness-lab/run-hold-buffer-pairs.mjs` against the committed golden pair (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}. Window 5000 ms (owner contract).

**spoil** — live drift 0.0009583333333333943, held drift 0.0009583333333333943 (law: held <= live); held stack survived; hold discarded clean (holds=0).

**damage** — hold-attributable damage 0; held asteroid contained=false; hold discarded clean (holds=0).

**Errors:**
- Error: pod LAW violated: held copper dropped below 100 (stage=0, after=0) — cargo left the platform
    at runPair.unpause (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/hold-completeness-lab/run-hold-buffer-pairs.mjs:330:12)
    at runPair (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/hold-completeness-lab/run-hold-buffer-pairs.mjs:196:3)
    at async main (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/hold-completeness-lab/run-hold-buffer-pairs.mjs:311:4)

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/hold-completeness-lab/run-hold-buffer-pairs.mjs",
  "started": "2026-07-19T07:05:21.529Z",
  "sections": [
    "preflight",
    "load",
    "spoil",
    "damage",
    "pod",
    "restore"
  ],
  "errors": [
    "Error: pod LAW violated: held copper dropped below 100 (stage=0, after=0) — cargo left the platform\n    at runPair.unpause (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/hold-completeness-lab/run-hold-buffer-pairs.mjs:330:12)\n    at runPair (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/hold-completeness-lab/run-hold-buffer-pairs.mjs:196:3)\n    at async main (file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/hold-completeness-lab/run-hold-buffer-pairs.mjs:311:4)"
  ],
  "instanceIds": {
    "1": 2119131471,
    "2": 234487481
  },
  "preBatchSaves": {
    "1": "test1.zip",
    "2": "test2.zip"
  },
  "lease": "clean",
  "goldenLoaded": true,
  "spoil": {
    "pair": "spoil",
    "fingerprint": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9508703703703704
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9508703703703704
      }
    },
    "before": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9509606481481482
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9509606481481482
      }
    },
    "transferId": "hold-buffer-spoil-1784444739798",
    "stage": {
      "success": true,
      "hold": {
        "transfer_id": "hold-buffer-spoil-1784444739798",
        "force_name": "player",
        "platform_index": 20,
        "platform_name": "lab-hold-spoil-held-v1",
        "surface_index": 12,
        "original_hidden": false,
        "original_paused": false,
        "active_states": {
          "16247": false
        },
        "deactivated_count": 0,
        "pod_completion": {
          "descending": 0,
          "ascending": 0,
          "items_recovered": 0
        },
        "held_tick": 9265367
      }
    },
    "afterStage": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.951212962962963
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.951212962962963
      }
    },
    "after": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9519189814814816
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9519189814814816
      }
    },
    "liveDrift": 0.0009583333333333943,
    "heldDrift": 0.0009583333333333943,
    "discard": {
      "success": true,
      "discard": {
        "success": true,
        "result": {
          "transfer_id": "hold-buffer-spoil-1784444739798",
          "platform_name": "lab-hold-spoil-held-v1",
          "platform_index": 20,
          "surface_index": 12,
          "deleted": true
        }
      },
      "holds": 0
    },
    "verdict": "GREEN"
  },
  "damage": {
    "pair": "damage",
    "fingerprint": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 14
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 15
      }
    },
    "before": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 14
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 15
      }
    },
    "preWindow": {
      "success": true,
      "woke": 2
    },
    "transferId": "hold-buffer-damage-1784444750891",
    "stage": {
      "success": true,
      "hold": {
        "transfer_id": "hold-buffer-damage-1784444750891",
        "force_name": "player",
        "platform_index": 22,
        "platform_name": "lab-hold-damage-held-v1",
        "surface_index": 15,
        "original_hidden": false,
        "original_paused": false,
        "active_states": {
          "16252": false
        },
        "deactivated_count": 0,
        "pod_completion": {
          "descending": 0,
          "ascending": 0,
          "items_recovered": 0
        },
        "held_tick": 9265964
      }
    },
    "afterStage": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      }
    },
    "after": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      }
    },
    "platformDamage": 0,
    "heldAsteroidContained": false,
    "discard": {
      "success": true,
      "discard": {
        "success": true,
        "result": {
          "transfer_id": "hold-buffer-damage-1784444750891",
          "platform_name": "lab-hold-damage-held-v1",
          "platform_index": 22,
          "surface_index": 15,
          "deleted": true
        }
      },
      "holds": 0
    },
    "verdict": "GREEN"
  },
  "pod": {
    "pair": "pod",
    "fingerprint": {
      "success": true,
      "live": {
        "pods": 1,
        "podCopper": 100,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 100
      },
      "held": {
        "pods": 1,
        "podCopper": 100,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 100
      }
    },
    "before": {
      "success": true,
      "live": {
        "pods": 1,
        "podCopper": 100,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 100
      },
      "held": {
        "pods": 1,
        "podCopper": 100,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 100
      }
    },
    "transferId": "hold-buffer-pod-1784444760577",
    "stage": {
      "success": true,
      "hold": {
        "transfer_id": "hold-buffer-pod-1784444760577",
        "force_name": "player",
        "platform_index": 24,
        "platform_name": "lab-hold-pod-held-v1",
        "surface_index": 17,
        "original_hidden": false,
        "original_paused": true,
        "active_states": {
          "16257": false
        },
        "deactivated_count": 0,
        "pod_completion": {
          "descending": 0,
          "ascending": 1,
          "items_recovered": 0
        },
        "held_tick": 9266488
      }
    },
    "afterStage": {
      "success": true,
      "live": {
        "pods": 1,
        "podCopper": 100,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 100
      },
      "held": {
        "pods": 0,
        "podCopper": 0,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 0
      }
    },
    "after": {
      "success": true,
      "live": {
        "pods": 1,
        "podCopper": 100,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 100
      },
      "held": {
        "pods": 0,
        "podCopper": 0,
        "hubCopper": 0,
        "groundCopper": 0,
        "totalCopper": 0
      }
    },
    "stagedPodFree": true,
    "discard": {
      "success": true,
      "discard": {
        "success": true,
        "result": {
          "transfer_id": "hold-buffer-pod-1784444760577",
          "platform_name": "lab-hold-pod-held-v1",
          "platform_index": 24,
          "surface_index": 17,
          "deleted": true
        }
      },
      "holds": 0
    }
  },
  "goldenSessionLogTails": {
    "1": "   0.019 Loading mod core 0.0.0 (data.lua)\n   0.028 Loading mod base 2.0.77 (data.lua)\n   0.120 Loading mod elevated-rails 2.0.77 (data.lua)\n   0.132 Loading mod FluidMustFlow 1.4.4 (data.lua)\n   0.138 Loading mod quality 2.0.77 (data.lua)\n   0.146 Loading mod SpidertronEnhancements 1.10.8 (data.lua)\n   0.150 Loading mod space-age 2.0.77 (data.lua)\n   0.248 Loading mod SpidertronPatrols 2.6.3 (data.lua)\n   0.260 Loading mod surfexp_gateways 0.3.1 (data.lua)\n   0.267 Loading mod maraxsis 1.31.6 (data.lua)\n   0.310 Loading mod base 2.0.77 (data-updates.lua)\n   0.319 Loading mod quality 2.0.77 (data-updates.lua)\n   0.331 Loading mod SpidertronEnhancements 1.10.8 (data-updates.lua)\n   0.339 Loading mod space-age 2.0.77 (data-updates.lua)\n   0.347 Loading mod SpidertronPatrols 2.6.3 (data-updates.lua)\n   0.355 Loading mod maraxsis 1.31.6 (data-updates.lua)\n   0.365 Loading mod SpidertronEnhancements 1.10.8 (data-final-fixes.lua)\n   0.375 Loading mod SpidertronPatrols 2.6.3 (data-final-fixes.lua)\n   0.382 Loading mod maraxsis 1.31.6 (data-final-fixes.lua)\n   0.448 Checksum for core: 4187927925\n   0.448 Checksum of base: 1879415942\n   0.448 Checksum of elevated-rails: 70351106\n   0.448 Checksum of FluidMustFlow: 2741802744\n   0.448 Checksum of quality: 1142589254\n   0.448 Checksum of SpidertronEnhancements: 2802774701\n   0.448 Checksum of space-age: 1510664043\n   0.448 Checksum of SpidertronPatrols: 1814447366\n   0.448 Checksum of surfexp_gateways: 3113003946\n   0.448 Checksum of maraxsis: 2814018477\n   0.739 Prototype list checksum: 2702547635\n   0.792 Info PlayerData.cpp:64: Local player-data.json available, timestamp 1784444732\n   0.792 Info PlayerData.cpp:71: Cloud player-data.json unavailable\n   0.793 Info GlobalContext.cpp:1300: Resetting config.\n   0.793 Factorio initialised\n   0.793 Info ServerSynchronizer.cpp:22: nextHeartbeatSequenceNumber(0) initialized Synchronizer nextTickClosureTick(0).\n   0.793 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(Ready) to(PreparedToHostGame)\n   0.793 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(PreparedToHostGame) to(CreatingGame)\n   0.794 Loading map /clusterio/data/instances/clusterio-host-1-instance-1/saves/lab-holdbuf-golden-source.zip: 1325018 bytes.\n   0.802 Loading level.dat: 12364642 bytes.\n   0.802 Info Scenario.cpp:154: Map version 2.0.77-0\n   0.870 Blueprint storage \"blueprint-storage-2.dat\" was not found, trying to load previous version storage \"blueprint-storage.dat\"\n   0.871 Loading script.dat: 44018 bytes.\n   0.883 Checksum for script __level__/control.lua: 2401794522\n   0.883 Checksum for script __FluidMustFlow__/control.lua: 2342970735\n   0.886 Checksum for script __SpidertronEnhancements__/control.lua: 3957523864\n   0.889 Checksum for script __SpidertronPatrols__/control.lua: 591379248\n   0.893 Script @__maraxsis__/lib/events.lua:52: Finalized 67 events for maraxsis\n   0.893 Checksum for script __maraxsis__/control.lua: 2868601269\n   0.895 Info UDPSocket.cpp:38: Opening socket at (IP ADDR:({0.0.0.0:34100}))\n   0.895 Hosting game at IP ADDR:({0.0.0.0:34100})\n   0.895 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/generate-server-padlock-2?api_version=6\n   1.226 Info AuthServerConnector.cpp:112: Obtained serverPadlock for serverHash (IoX2o80BQSb2GTs5CdGLIMtWuu9AtccE) from the auth server.\n   1.226 Info ServerMultiplayerManager.cpp:808: updateTick(9931228) changing state from(CreatingGame) to(InGame)\n   1.230 Info ServerRouter.cpp:668: Asking pingpong servers (pingpong1.factorio.com:34197, pingpong2.factorio.com:34197, pingpong3.factorio.com:34197, pingpong4.factorio.com:34197) for own address\n   1.230 Info UDPSocket.cpp:50: Opening socket for broadcast\n   1.230 Info RemoteCommandProcessor.cpp:126: Starting RCON interface at IP ADDR:({0.0.0.0:63608})\n   1.230 Info CommandLineMultiplayer.cpp:292: Maximum segment size = 100; minimum segment size = 25; maximum-segment-size peer count = 10; minimum-segment-size peer count = 20\n   1.231 Info RemoteCommandProcessor.cpp:245: New RCON connection from IP ADDR:({127.0.0.1:45950})\n   1.247 Script @__level__/modules/surface_export/core/gateway.lua:61: [Gateway] discover_and_unlock: 12 gateway/force unlocks\n   1.247 Script @__level__/modules/surface_export/control.lua:92: [Surface Export] Connected to Clusterio controller\n   1.264 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:64926}), expected IP ADDR:({209.236.82.227:58377}))\n   1.264 Script @__level__/modules/surface_export/control.lua:96: [Surface Export] Instance configuration updated\n   1.264 Warning ServerMultiplayerManager.cpp:654: Determining own address has failed. Best guess: IP ADDR:({209.236.82.227:58377})\n   1.264 Info AuthServerConnector.cpp:620: Performing TLS check.\n   1.264 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/tls-check/success\n   1.314 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=50, max_concurrent_jobs=3, show_progress=true, debug_mode=true\n   1.330 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:56318}), expected IP ADDR:({209.236.82.227:58377}))\n   1.331 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:80: [FactorioSurfaceExport] Gateway config updated: 0 gateway(s)\n   1.331 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=unchanged, max_concurrent_jobs=unchanged, show_progress=nil, debug_mode=nil\n   1.380 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:49492}), expected IP ADDR:({209.236.82.227:58377}))\n   1.400 Info AuthServerConnector.cpp:653: TLS check success.\n   1.865 Info MatchingServer.cpp:129: Matching server game `961270` has been created.\n   1.880 Info ServerMultiplayerManager.cpp:738: Matching server connection resumed\n   9.181 Script @__level__/modules/surface_export/core/destination-hold.lua:184: [DestinationHold] staged transfer hold-buffer-spoil-1784444739798 on platform 'lab-hold-spoil-held-v1' (idx=20, surface=12, deactivated=0, pods=0/0, recovered=0)\n  15.447 Script @__level__/modules/surface_export/core/destination-hold.lua:239: [DestinationHold] discarded transfer hold-buffer-spoil-1784444739798 platform 'lab-hold-spoil-held-v1' (deleted=true)\n  19.131 Script @__level__/modules/surface_export/core/destination-hold.lua:184: [DestinationHold] staged transfer hold-buffer-damage-1784444750891 on platform 'lab-hold-damage-held-v1' (idx=22, surface=15, deactivated=0, pods=0/0, recovered=0)\n  28.750 Script @__level__/modules/surface_export/core/destination-hold.lua:239: [DestinationHold] discarded transfer hold-buffer-damage-1784444750891 platform 'lab-hold-damage-held-v1' (deleted=true)\n  31.200 Script @__level__/modules/surface_export/utils/surface-lock.lua:223: [SurfaceLock] Completed 0 descending pods (recovered 0 items), 1 ascending pods\n  31.200 Script @__level__/modules/surface_export/core/destination-hold.lua:184: [DestinationHold] staged transfer hold-buffer-pod-1784444760577 on platform 'lab-hold-pod-held-v1' (idx=24, surface=17, deactivated=0, pods=0/1, recovered=0)\n  37.633 Script @__level__/modules/surface_export/core/destination-hold.lua:239: [DestinationHold] discarded transfer hold-buffer-pod-1784444760577 platform 'lab-hold-pod-held-v1' (deleted=true)\n",
    "2": "   0.008 Info ModManager.cpp:449: FeatureFlag space-travel = true\n   0.008 Info ModManager.cpp:449: FeatureFlag spoiling = true\n   0.009 Loading mod settings FluidMustFlow 1.4.4 (settings.lua)\n   0.010 Loading mod settings SpidertronEnhancements 1.10.8 (settings.lua)\n   0.011 Loading mod settings SpidertronPatrols 2.6.3 (settings.lua)\n   0.012 Loading mod settings maraxsis 1.31.6 (settings.lua)\n   0.013 Loading mod settings maraxsis 1.31.6 (settings-updates.lua)\n   0.015 Loading mod core 0.0.0 (data.lua)\n   0.023 Loading mod base 2.0.77 (data.lua)\n   0.111 Loading mod elevated-rails 2.0.77 (data.lua)\n   0.134 Loading mod FluidMustFlow 1.4.4 (data.lua)\n   0.141 Loading mod quality 2.0.77 (data.lua)\n   0.150 Loading mod SpidertronEnhancements 1.10.8 (data.lua)\n   0.155 Loading mod space-age 2.0.77 (data.lua)\n   0.261 Loading mod SpidertronPatrols 2.6.3 (data.lua)\n   0.271 Loading mod surfexp_gateways 0.3.1 (data.lua)\n   0.279 Loading mod maraxsis 1.31.6 (data.lua)\n   0.307 Loading mod base 2.0.77 (data-updates.lua)\n   0.315 Loading mod quality 2.0.77 (data-updates.lua)\n   0.330 Loading mod SpidertronEnhancements 1.10.8 (data-updates.lua)\n   0.338 Loading mod space-age 2.0.77 (data-updates.lua)\n   0.346 Loading mod SpidertronPatrols 2.6.3 (data-updates.lua)\n   0.355 Loading mod maraxsis 1.31.6 (data-updates.lua)\n   0.365 Loading mod SpidertronEnhancements 1.10.8 (data-final-fixes.lua)\n   0.375 Loading mod SpidertronPatrols 2.6.3 (data-final-fixes.lua)\n   0.382 Loading mod maraxsis 1.31.6 (data-final-fixes.lua)\n   0.449 Checksum for core: 4187927925\n   0.449 Checksum of base: 1879415942\n   0.449 Checksum of elevated-rails: 70351106\n   0.449 Checksum of FluidMustFlow: 2741802744\n   0.449 Checksum of quality: 1142589254\n   0.449 Checksum of SpidertronEnhancements: 2802774701\n   0.449 Checksum of space-age: 1510664043\n   0.449 Checksum of SpidertronPatrols: 1814447366\n   0.449 Checksum of surfexp_gateways: 3113003946\n   0.449 Checksum of maraxsis: 2814018477\n   0.776 Prototype list checksum: 2702547635\n   0.833 Info PlayerData.cpp:64: Local player-data.json available, timestamp 1784444733\n   0.833 Info PlayerData.cpp:71: Cloud player-data.json unavailable\n   0.833 Info GlobalContext.cpp:1300: Resetting config.\n   0.834 Factorio initialised\n   0.834 Info ServerSynchronizer.cpp:22: nextHeartbeatSequenceNumber(0) initialized Synchronizer nextTickClosureTick(0).\n   0.834 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(Ready) to(PreparedToHostGame)\n   0.834 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(PreparedToHostGame) to(CreatingGame)\n   0.834 Loading map /clusterio/data/instances/clusterio-host-2-instance-1/saves/lab-holdbuf-golden-dest.zip: 550461 bytes.\n   0.842 Loading level.dat: 3081268 bytes.\n   0.842 Info Scenario.cpp:154: Map version 2.0.77-0\n   0.856 Blueprint storage \"blueprint-storage-2.dat\" was not found, trying to load previous version storage \"blueprint-storage.dat\"\n   0.856 Loading script.dat: 44023 bytes.\n   0.869 Checksum for script __level__/control.lua: 2401794522\n   0.870 Checksum for script __FluidMustFlow__/control.lua: 2342970735\n   0.873 Checksum for script __SpidertronEnhancements__/control.lua: 3957523864\n   0.878 Checksum for script __SpidertronPatrols__/control.lua: 591379248\n   0.882 Script @__maraxsis__/lib/events.lua:52: Finalized 67 events for maraxsis\n   0.882 Checksum for script __maraxsis__/control.lua: 2868601269\n   0.884 Info UDPSocket.cpp:38: Opening socket at (IP ADDR:({0.0.0.0:34200}))\n   0.884 Hosting game at IP ADDR:({0.0.0.0:34200})\n   0.884 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/generate-server-padlock-2?api_version=6\n   1.033 Info AuthServerConnector.cpp:112: Obtained serverPadlock for serverHash (hbrx8SGF8fFLQ4LvueIIzRCUvC8mPXwM) from the auth server.\n   1.033 Info ServerMultiplayerManager.cpp:808: updateTick(9933208) changing state from(CreatingGame) to(InGame)\n   1.038 Info ServerRouter.cpp:668: Asking pingpong servers (pingpong1.factorio.com:34197, pingpong2.factorio.com:34197, pingpong3.factorio.com:34197, pingpong4.factorio.com:34197) for own address\n   1.038 Info UDPSocket.cpp:50: Opening socket for broadcast\n   1.039 Info RemoteCommandProcessor.cpp:126: Starting RCON interface at IP ADDR:({0.0.0.0:53089})\n   1.039 Info CommandLineMultiplayer.cpp:292: Maximum segment size = 100; minimum segment size = 25; maximum-segment-size peer count = 10; minimum-segment-size peer count = 20\n   1.039 Info RemoteCommandProcessor.cpp:245: New RCON connection from IP ADDR:({127.0.0.1:34046})\n   1.056 Script @__level__/modules/surface_export/core/gateway.lua:61: [Gateway] discover_and_unlock: 12 gateway/force unlocks\n   1.056 Script @__level__/modules/surface_export/control.lua:92: [Surface Export] Connected to Clusterio controller\n   1.072 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:63444}), expected IP ADDR:({209.236.82.227:61735}))\n   1.072 Script @__level__/modules/surface_export/control.lua:96: [Surface Export] Instance configuration updated\n   1.072 Warning ServerMultiplayerManager.cpp:654: Determining own address has failed. Best guess: IP ADDR:({209.236.82.227:61735})\n   1.072 Info AuthServerConnector.cpp:620: Performing TLS check.\n   1.073 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/tls-check/success\n   1.122 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=50, max_concurrent_jobs=3, show_progress=true, debug_mode=true\n   1.139 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:64927}), expected IP ADDR:({209.236.82.227:61735}))\n   1.139 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:80: [FactorioSurfaceExport] Gateway config updated: 0 gateway(s)\n   1.139 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=unchanged, max_concurrent_jobs=unchanged, show_progress=nil, debug_mode=nil\n   1.189 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:61734}), expected IP ADDR:({209.236.82.227:61735}))\n   1.237 Info AuthServerConnector.cpp:653: TLS check success.\n   1.758 Info MatchingServer.cpp:129: Matching server game `961271` has been created.\n   1.772 Info ServerMultiplayerManager.cpp:738: Matching server connection resumed\n"
  },
  "restored": {
    "1": "test1.zip",
    "2": "test2.zip",
    "zeroLeftovers": true
  },
  "finished": "2026-07-19T07:06:21.669Z",
  "green": false
}
```
</details>

## 2026-07-19T07:15:37.272Z — hold-buffer-pairs batch (card 3 bake gate, GREEN)

Runner: `tests/hold-completeness-lab/run-hold-buffer-pairs.mjs` against the committed golden pair (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}. Window 5000 ms (owner contract).

**spoil** — live drift 0.0009722222222221522, held drift 0.0009722222222221522 (law: held <= live); held stack survived; hold discarded clean (holds=0).

**damage** — hold-attributable damage 0; held asteroid contained=false; hold discarded clean (holds=0).

**pod** — staged pod-free=true; held copper retained stage=100 after=100 (>=100 law); live control kept its pod; hold discarded clean (holds=0).

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/hold-completeness-lab/run-hold-buffer-pairs.mjs",
  "started": "2026-07-19T07:14:37.627Z",
  "sections": [
    "preflight",
    "load",
    "spoil",
    "damage",
    "pod",
    "restore"
  ],
  "errors": [],
  "instanceIds": {
    "1": 2119131471,
    "2": 234487481
  },
  "preBatchSaves": {
    "1": "test1.zip",
    "2": "test2.zip"
  },
  "lease": "clean",
  "goldenLoaded": true,
  "spoil": {
    "pair": "spoil",
    "fingerprint": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9508402777777778
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9508402777777778
      }
    },
    "before": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9509305555555556
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9509305555555556
      }
    },
    "transferId": "hold-buffer-spoil-1784445296816",
    "stage": {
      "success": true,
      "hold": {
        "transfer_id": "hold-buffer-spoil-1784445296816",
        "force_name": "player",
        "platform_index": 20,
        "platform_name": "lab-hold-spoil-held-v1",
        "surface_index": 12,
        "original_hidden": false,
        "original_paused": false,
        "active_states": {
          "16247": false
        },
        "deactivated_count": 0,
        "pod_completion": {
          "descending": 0,
          "ascending": 0,
          "items_recovered": 0
        },
        "held_tick": 9265403
      }
    },
    "afterStage": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9511875
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9511875
      }
    },
    "after": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9519027777777778
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9519027777777778
      }
    },
    "liveDrift": 0.0009722222222221522,
    "heldDrift": 0.0009722222222221522,
    "discard": {
      "success": true,
      "discard": {
        "success": true,
        "result": {
          "transfer_id": "hold-buffer-spoil-1784445296816",
          "platform_name": "lab-hold-spoil-held-v1",
          "platform_index": 20,
          "surface_index": 12,
          "deleted": true
        }
      },
      "holds": 0
    },
    "verdict": "GREEN"
  },
  "damage": {
    "pair": "damage",
    "fingerprint": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 14
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 15
      }
    },
    "before": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 14
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 15
      }
    },
    "preWindow": {
      "success": true,
      "woke": 2
    },
    "transferId": "hold-buffer-damage-1784445307986",
    "stage": {
      "success": true,
      "hold": {
        "transfer_id": "hold-buffer-damage-1784445307986",
        "force_name": "player",
        "platform_index": 22,
        "platform_name": "lab-hold-damage-held-v1",
        "surface_index": 15,
        "original_hidden": false,
        "original_paused": false,
        "active_states": {
          "16252": false
        },
        "deactivated_count": 0,
        "pod_completion": {
          "descending": 0,
          "ascending": 0,
          "items_recovered": 0
        },
        "held_tick": 9266010
      }
    },
    "afterStage": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      }
    },
    "after": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      }
    },
    "platformDamage": 0,
    "heldAsteroidContained": false,
    "discard": {
      "success": true,
      "discard": {
        "success": true,
        "result": {
          "transfer_id": "hold-buffer-damage-1784445307986",
          "platform_name": "lab-hold-damage-held-v1",
          "platform_index": 22,
          "surface_index": 15,
          "deleted": true
        }
      },
      "holds": 0
    },
    "verdict": "GREEN"
  },
  "pod": {
    "pair": "pod",
    "fingerprint": {
      "success": true,
      "live": {
        "pods": 0,
        "podCopper": 0,
        "hubCopper": 0,
        "hubIron": 5900,
        "groundCopper": 0,
        "totalCopper": 0
      },
      "held": {
        "pods": 0,
        "podCopper": 0,
        "hubCopper": 0,
        "hubIron": 5900,
        "groundCopper": 0,
        "totalCopper": 0
      }
    },
    "transferId": "hold-buffer-pod-1784445317205",
    "created": {
      "live": {
        "state": "awaiting_launch",
        "copper": 100
      },
      "held": {
        "state": "awaiting_launch",
        "copper": 100
      }
    },
    "stage": {
      "success": true,
      "hold": {
        "transfer_id": "hold-buffer-pod-1784445317205",
        "force_name": "player",
        "platform_index": 24,
        "platform_name": "lab-hold-pod-held-v1",
        "surface_index": 17,
        "original_hidden": false,
        "original_paused": true,
        "active_states": {
          "16257": false
        },
        "deactivated_count": 0,
        "pod_completion": {
          "descending": 0,
          "ascending": 0,
          "items_recovered": 100
        },
        "held_tick": 9266505
      }
    },
    "afterStage": {
      "success": true,
      "live": {
        "pods": 1,
        "podCopper": 100,
        "podState": "ascending",
        "hubCopper": 0,
        "hubIron": 5900,
        "groundCopper": 0,
        "totalCopper": 100
      },
      "held": {
        "pods": 0,
        "podCopper": 0,
        "hubCopper": 0,
        "hubIron": 5900,
        "groundCopper": 100,
        "totalCopper": 100
      }
    },
    "after": {
      "success": true,
      "live": {
        "pods": 1,
        "podCopper": 100,
        "podState": "ascending",
        "hubCopper": 0,
        "hubIron": 5900,
        "groundCopper": 0,
        "totalCopper": 100
      },
      "held": {
        "pods": 0,
        "podCopper": 0,
        "hubCopper": 0,
        "hubIron": 5900,
        "groundCopper": 100,
        "totalCopper": 100
      }
    },
    "stagedPodFree": true,
    "discard": {
      "success": true,
      "discard": {
        "success": true,
        "result": {
          "transfer_id": "hold-buffer-pod-1784445317205",
          "platform_name": "lab-hold-pod-held-v1",
          "platform_index": 24,
          "surface_index": 17,
          "deleted": true
        }
      },
      "holds": 0
    },
    "verdict": "GREEN"
  },
  "goldenSessionLogTails": {
    "1": "   0.016 Loading mod core 0.0.0 (data.lua)\n   0.024 Loading mod base 2.0.77 (data.lua)\n-140462613.187 Loading mod elevated-rails 2.0.77 (data.lua)\n-140462613.199 Loading mod FluidMustFlow 1.4.4 (data.lua)\n-140462613.205 Loading mod quality 2.0.77 (data.lua)\n-140462613.214 Loading mod SpidertronEnhancements 1.10.8 (data.lua)\n-140462613.219 Loading mod space-age 2.0.77 (data.lua)\n   3.593 Loading mod SpidertronPatrols 2.6.3 (data.lua)\n   3.603 Loading mod surfexp_gateways 0.3.1 (data.lua)\n   3.612 Loading mod maraxsis 1.31.6 (data.lua)\n   3.668 Loading mod base 2.0.77 (data-updates.lua)\n   3.677 Loading mod quality 2.0.77 (data-updates.lua)\n   3.692 Loading mod SpidertronEnhancements 1.10.8 (data-updates.lua)\n   3.701 Loading mod space-age 2.0.77 (data-updates.lua)\n   3.710 Loading mod SpidertronPatrols 2.6.3 (data-updates.lua)\n   3.721 Loading mod maraxsis 1.31.6 (data-updates.lua)\n   3.733 Loading mod SpidertronEnhancements 1.10.8 (data-final-fixes.lua)\n   3.746 Loading mod SpidertronPatrols 2.6.3 (data-final-fixes.lua)\n   3.754 Loading mod maraxsis 1.31.6 (data-final-fixes.lua)\n   3.828 Checksum for core: 4187927925\n   3.828 Checksum of base: 1879415942\n   3.828 Checksum of elevated-rails: 70351106\n   3.828 Checksum of FluidMustFlow: 2741802744\n   3.828 Checksum of quality: 1142589254\n   3.828 Checksum of SpidertronEnhancements: 2802774701\n   3.828 Checksum of space-age: 1510664043\n   3.828 Checksum of SpidertronPatrols: 1814447366\n   3.828 Checksum of surfexp_gateways: 3113003946\n   3.828 Checksum of maraxsis: 2814018477\n   4.128 Prototype list checksum: 2702547635\n   4.193 Info PlayerData.cpp:64: Local player-data.json available, timestamp 1784445286\n   4.193 Info PlayerData.cpp:71: Cloud player-data.json unavailable\n   4.194 Info GlobalContext.cpp:1300: Resetting config.\n   4.194 Factorio initialised\n   4.194 Info ServerSynchronizer.cpp:22: nextHeartbeatSequenceNumber(0) initialized Synchronizer nextTickClosureTick(0).\n   4.194 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(Ready) to(PreparedToHostGame)\n   4.194 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(PreparedToHostGame) to(CreatingGame)\n   4.194 Loading map /clusterio/data/instances/clusterio-host-1-instance-1/saves/lab-holdbuf-golden-source.zip: 1434523 bytes.\n   4.203 Loading level.dat: 12686600 bytes.\n   4.204 Info Scenario.cpp:154: Map version 2.0.77-0\n   4.276 Blueprint storage \"blueprint-storage-2.dat\" was not found, trying to load previous version storage \"blueprint-storage.dat\"\n   4.276 Loading script.dat: 44018 bytes.\n   4.291 Checksum for script __level__/control.lua: 2401794522\n   4.292 Checksum for script __FluidMustFlow__/control.lua: 2342970735\n   4.294 Checksum for script __SpidertronEnhancements__/control.lua: 3957523864\n   4.298 Checksum for script __SpidertronPatrols__/control.lua: 591379248\n   4.303 Script @__maraxsis__/lib/events.lua:52: Finalized 67 events for maraxsis\n   4.303 Checksum for script __maraxsis__/control.lua: 2868601269\n   4.306 Info UDPSocket.cpp:38: Opening socket at (IP ADDR:({0.0.0.0:34100}))\n   4.306 Hosting game at IP ADDR:({0.0.0.0:34100})\n   4.306 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/generate-server-padlock-2?api_version=6\n   4.449 Info AuthServerConnector.cpp:112: Obtained serverPadlock for serverHash (5AJpEz5IuGjQEdPZOwFK55UrFeVhQQOl) from the auth server.\n   4.449 Info ServerMultiplayerManager.cpp:808: updateTick(9931278) changing state from(CreatingGame) to(InGame)\n   4.649 Info ServerRouter.cpp:668: Asking pingpong servers (pingpong1.factorio.com:34197, pingpong2.factorio.com:34197, pingpong3.factorio.com:34197, pingpong4.factorio.com:34197) for own address\n   4.649 Info UDPSocket.cpp:50: Opening socket for broadcast\n   4.649 Info RemoteCommandProcessor.cpp:126: Starting RCON interface at IP ADDR:({0.0.0.0:52371})\n   4.649 Info CommandLineMultiplayer.cpp:292: Maximum segment size = 100; minimum segment size = 25; maximum-segment-size peer count = 10; minimum-segment-size peer count = 20\n   4.650 Info RemoteCommandProcessor.cpp:245: New RCON connection from IP ADDR:({127.0.0.1:35976})\n   4.666 Script @__level__/modules/surface_export/core/gateway.lua:61: [Gateway] discover_and_unlock: 12 gateway/force unlocks\n   4.667 Script @__level__/modules/surface_export/control.lua:92: [Surface Export] Connected to Clusterio controller\n   4.683 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:64015}), expected IP ADDR:({209.236.82.227:56031}))\n   4.683 Script @__level__/modules/surface_export/control.lua:96: [Surface Export] Instance configuration updated\n   4.683 Warning ServerMultiplayerManager.cpp:654: Determining own address has failed. Best guess: IP ADDR:({209.236.82.227:56031})\n   4.683 Info AuthServerConnector.cpp:620: Performing TLS check.\n   4.683 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/tls-check/success\n   4.733 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=50, max_concurrent_jobs=3, show_progress=true, debug_mode=true\n   4.750 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:54461}), expected IP ADDR:({209.236.82.227:56031}))\n   4.750 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:80: [FactorioSurfaceExport] Gateway config updated: 0 gateway(s)\n   4.750 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=unchanged, max_concurrent_jobs=unchanged, show_progress=nil, debug_mode=nil\n   4.783 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:52745}), expected IP ADDR:({209.236.82.227:56031}))\n   4.826 Info AuthServerConnector.cpp:653: TLS check success.\n   5.321 Info MatchingServer.cpp:129: Matching server game `961317` has been created.\n   5.333 Info ServerMultiplayerManager.cpp:738: Matching server connection resumed\n  12.367 Script @__level__/modules/surface_export/core/destination-hold.lua:184: [DestinationHold] staged transfer hold-buffer-spoil-1784445296816 on platform 'lab-hold-spoil-held-v1' (idx=20, surface=12, deactivated=0, pods=0/0, recovered=0)\n  18.766 Script @__level__/modules/surface_export/core/destination-hold.lua:239: [DestinationHold] discarded transfer hold-buffer-spoil-1784445296816 platform 'lab-hold-spoil-held-v1' (deleted=true)\n  22.483 Script @__level__/modules/surface_export/core/destination-hold.lua:184: [DestinationHold] staged transfer hold-buffer-damage-1784445307986 on platform 'lab-hold-damage-held-v1' (idx=22, surface=15, deactivated=0, pods=0/0, recovered=0)\n  28.933 Script @__level__/modules/surface_export/core/destination-hold.lua:239: [DestinationHold] discarded transfer hold-buffer-damage-1784445307986 platform 'lab-hold-damage-held-v1' (deleted=true)\n  30.734 Script @__level__/modules/surface_export/utils/surface-lock.lua:223: [SurfaceLock] Completed 0 descending pods (recovered 100 items), 0 ascending pods\n  30.734 Script @__level__/modules/surface_export/core/destination-hold.lua:184: [DestinationHold] staged transfer hold-buffer-pod-1784445317205 on platform 'lab-hold-pod-held-v1' (idx=24, surface=17, deactivated=0, pods=0/0, recovered=100)\n  40.481 Script @__level__/modules/surface_export/core/destination-hold.lua:239: [DestinationHold] discarded transfer hold-buffer-pod-1784445317205 platform 'lab-hold-pod-held-v1' (deleted=true)\n",
    "2": "   0.009 Info ModManager.cpp:449: FeatureFlag space-travel = true\n   0.009 Info ModManager.cpp:449: FeatureFlag spoiling = true\n   0.010 Loading mod settings FluidMustFlow 1.4.4 (settings.lua)\n   0.011 Loading mod settings SpidertronEnhancements 1.10.8 (settings.lua)\n   0.012 Loading mod settings SpidertronPatrols 2.6.3 (settings.lua)\n   0.013 Loading mod settings maraxsis 1.31.6 (settings.lua)\n   0.014 Loading mod settings maraxsis 1.31.6 (settings-updates.lua)\n   0.016 Loading mod core 0.0.0 (data.lua)\n   0.024 Loading mod base 2.0.77 (data.lua)\n   0.100 Loading mod elevated-rails 2.0.77 (data.lua)\n   0.113 Loading mod FluidMustFlow 1.4.4 (data.lua)\n   0.119 Loading mod quality 2.0.77 (data.lua)\n   0.127 Loading mod SpidertronEnhancements 1.10.8 (data.lua)\n   0.132 Loading mod space-age 2.0.77 (data.lua)\n   0.249 Loading mod SpidertronPatrols 2.6.3 (data.lua)\n   0.259 Loading mod surfexp_gateways 0.3.1 (data.lua)\n   0.266 Loading mod maraxsis 1.31.6 (data.lua)\n   0.294 Loading mod base 2.0.77 (data-updates.lua)\n   0.302 Loading mod quality 2.0.77 (data-updates.lua)\n   0.315 Loading mod SpidertronEnhancements 1.10.8 (data-updates.lua)\n   0.324 Loading mod space-age 2.0.77 (data-updates.lua)\n   0.332 Loading mod SpidertronPatrols 2.6.3 (data-updates.lua)\n   0.340 Loading mod maraxsis 1.31.6 (data-updates.lua)\n   0.350 Loading mod SpidertronEnhancements 1.10.8 (data-final-fixes.lua)\n   0.361 Loading mod SpidertronPatrols 2.6.3 (data-final-fixes.lua)\n   0.370 Loading mod maraxsis 1.31.6 (data-final-fixes.lua)\n   0.444 Checksum for core: 4187927925\n   0.444 Checksum of base: 1879415942\n   0.444 Checksum of elevated-rails: 70351106\n   0.444 Checksum of FluidMustFlow: 2741802744\n   0.444 Checksum of quality: 1142589254\n   0.444 Checksum of SpidertronEnhancements: 2802774701\n   0.444 Checksum of space-age: 1510664043\n   0.444 Checksum of SpidertronPatrols: 1814447366\n   0.444 Checksum of surfexp_gateways: 3113003946\n   0.444 Checksum of maraxsis: 2814018477\n   0.760 Prototype list checksum: 2702547635\n   0.809 Info PlayerData.cpp:64: Local player-data.json available, timestamp 1784445288\n   0.809 Info PlayerData.cpp:71: Cloud player-data.json unavailable\n   0.810 Info GlobalContext.cpp:1300: Resetting config.\n   0.810 Factorio initialised\n   0.810 Info ServerSynchronizer.cpp:22: nextHeartbeatSequenceNumber(0) initialized Synchronizer nextTickClosureTick(0).\n   0.810 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(Ready) to(PreparedToHostGame)\n   0.810 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(PreparedToHostGame) to(CreatingGame)\n   0.810 Loading map /clusterio/data/instances/clusterio-host-2-instance-1/saves/lab-holdbuf-golden-dest.zip: 550461 bytes.\n   0.819 Loading level.dat: 3081268 bytes.\n   0.819 Info Scenario.cpp:154: Map version 2.0.77-0\n   0.833 Blueprint storage \"blueprint-storage-2.dat\" was not found, trying to load previous version storage \"blueprint-storage.dat\"\n   0.833 Loading script.dat: 44023 bytes.\n   0.847 Checksum for script __level__/control.lua: 2401794522\n   0.847 Checksum for script __FluidMustFlow__/control.lua: 2342970735\n   0.850 Checksum for script __SpidertronEnhancements__/control.lua: 3957523864\n   0.853 Checksum for script __SpidertronPatrols__/control.lua: 591379248\n   0.858 Script @__maraxsis__/lib/events.lua:52: Finalized 67 events for maraxsis\n   0.858 Checksum for script __maraxsis__/control.lua: 2868601269\n   0.860 Info UDPSocket.cpp:38: Opening socket at (IP ADDR:({0.0.0.0:34200}))\n   0.860 Hosting game at IP ADDR:({0.0.0.0:34200})\n   0.860 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/generate-server-padlock-2?api_version=6\n   1.043 Info AuthServerConnector.cpp:112: Obtained serverPadlock for serverHash (XCxvl7VHsdykPeFKeGbHlhsjiz9ZdwxL) from the auth server.\n   1.043 Info ServerMultiplayerManager.cpp:808: updateTick(9933208) changing state from(CreatingGame) to(InGame)\n   1.048 Info ServerRouter.cpp:668: Asking pingpong servers (pingpong1.factorio.com:34197, pingpong2.factorio.com:34197, pingpong3.factorio.com:34197, pingpong4.factorio.com:34197) for own address\n   1.048 Info UDPSocket.cpp:50: Opening socket for broadcast\n   1.049 Info RemoteCommandProcessor.cpp:126: Starting RCON interface at IP ADDR:({0.0.0.0:63323})\n   1.049 Info CommandLineMultiplayer.cpp:292: Maximum segment size = 100; minimum segment size = 25; maximum-segment-size peer count = 10; minimum-segment-size peer count = 20\n   1.050 Info RemoteCommandProcessor.cpp:245: New RCON connection from IP ADDR:({127.0.0.1:44486})\n   1.066 Script @__level__/modules/surface_export/core/gateway.lua:61: [Gateway] discover_and_unlock: 12 gateway/force unlocks\n   1.066 Script @__level__/modules/surface_export/control.lua:92: [Surface Export] Connected to Clusterio controller\n   1.082 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:63444}), expected IP ADDR:({209.236.82.227:50481}))\n   1.082 Script @__level__/modules/surface_export/control.lua:96: [Surface Export] Instance configuration updated\n   1.082 Warning ServerMultiplayerManager.cpp:654: Determining own address has failed. Best guess: IP ADDR:({209.236.82.227:50481})\n   1.082 Info AuthServerConnector.cpp:620: Performing TLS check.\n   1.082 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/tls-check/success\n   1.133 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=50, max_concurrent_jobs=3, show_progress=true, debug_mode=true\n   1.149 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:64927}), expected IP ADDR:({209.236.82.227:50481}))\n   1.149 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:80: [FactorioSurfaceExport] Gateway config updated: 0 gateway(s)\n   1.149 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=unchanged, max_concurrent_jobs=unchanged, show_progress=nil, debug_mode=nil\n   1.199 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:50482}), expected IP ADDR:({209.236.82.227:50481}))\n   1.263 Info AuthServerConnector.cpp:653: TLS check success.\n   1.729 Info MatchingServer.cpp:129: Matching server game `961318` has been created.\n   1.732 Info ServerMultiplayerManager.cpp:738: Matching server connection resumed\n"
  },
  "restored": {
    "1": "test1.zip",
    "2": "test2.zip",
    "zeroLeftovers": true
  },
  "finished": "2026-07-19T07:15:37.272Z",
  "green": true
}
```
</details>

## 2026-07-19T07:16:50.688Z — hold-buffer-pairs batch (card 3 bake gate, GREEN)

Runner: `tests/hold-completeness-lab/run-hold-buffer-pairs.mjs` against the committed golden pair (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}. Window 5000 ms (owner contract).

**spoil** — live drift 0.0009699074074074332, held drift 0.0009699074074074332 (law: held <= live); held stack survived; hold discarded clean (holds=0).

**damage** — hold-attributable damage 0; held asteroid contained=false; hold discarded clean (holds=0).

**pod** — staged pod-free=true; held copper retained stage=100 after=100 (>=100 law); live control kept its pod; hold discarded clean (holds=0).

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/hold-completeness-lab/run-hold-buffer-pairs.mjs",
  "started": "2026-07-19T07:15:51.551Z",
  "sections": [
    "preflight",
    "load",
    "spoil",
    "damage",
    "pod",
    "restore"
  ],
  "errors": [],
  "instanceIds": {
    "1": 2119131471,
    "2": 234487481
  },
  "preBatchSaves": {
    "1": "test1.zip",
    "2": "test2.zip"
  },
  "lease": "clean",
  "goldenLoaded": true,
  "spoil": {
    "pair": "spoil",
    "fingerprint": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9508587962962963
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9508587962962963
      }
    },
    "before": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9509467592592593
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9509467592592593
      }
    },
    "transferId": "hold-buffer-spoil-1784445369695",
    "stage": {
      "success": true,
      "hold": {
        "transfer_id": "hold-buffer-spoil-1784445369695",
        "force_name": "player",
        "platform_index": 20,
        "platform_name": "lab-hold-spoil-held-v1",
        "surface_index": 12,
        "original_hidden": false,
        "original_paused": false,
        "active_states": {
          "16247": false
        },
        "deactivated_count": 0,
        "pod_completion": {
          "descending": 0,
          "ascending": 0,
          "items_recovered": 0
        },
        "held_tick": 9265410
      }
    },
    "afterStage": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9511967592592592
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9511967592592592
      }
    },
    "after": {
      "success": true,
      "live": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9519166666666667
      },
      "held": {
        "chest": true,
        "item": "bioflux",
        "count": 1,
        "spoil": 0.9519166666666667
      }
    },
    "liveDrift": 0.0009699074074074332,
    "heldDrift": 0.0009699074074074332,
    "discard": {
      "success": true,
      "discard": {
        "success": true,
        "result": {
          "transfer_id": "hold-buffer-spoil-1784445369695",
          "platform_name": "lab-hold-spoil-held-v1",
          "platform_index": 20,
          "surface_index": 12,
          "deleted": true
        }
      },
      "holds": 0
    },
    "verdict": "GREEN"
  },
  "damage": {
    "pair": "damage",
    "fingerprint": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 14
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 15
      }
    },
    "before": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 14
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": true,
        "asteroidName": "small-metallic-asteroid",
        "asteroidSurface": 15
      }
    },
    "preWindow": {
      "success": true,
      "woke": 2
    },
    "transferId": "hold-buffer-damage-1784445381089",
    "stage": {
      "success": true,
      "hold": {
        "transfer_id": "hold-buffer-damage-1784445381089",
        "force_name": "player",
        "platform_index": 22,
        "platform_name": "lab-hold-damage-held-v1",
        "surface_index": 15,
        "original_hidden": false,
        "original_paused": false,
        "active_states": {
          "16252": false
        },
        "deactivated_count": 0,
        "pod_completion": {
          "descending": 0,
          "ascending": 0,
          "items_recovered": 0
        },
        "held_tick": 9266028
      }
    },
    "afterStage": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      }
    },
    "after": {
      "success": true,
      "live": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      },
      "held": {
        "chest": true,
        "health": 350,
        "healthFull": true,
        "destructible": true,
        "asteroidValid": false
      }
    },
    "platformDamage": 0,
    "heldAsteroidContained": false,
    "discard": {
      "success": true,
      "discard": {
        "success": true,
        "result": {
          "transfer_id": "hold-buffer-damage-1784445381089",
          "platform_name": "lab-hold-damage-held-v1",
          "platform_index": 22,
          "surface_index": 15,
          "deleted": true
        }
      },
      "holds": 0
    },
    "verdict": "GREEN"
  },
  "pod": {
    "pair": "pod",
    "fingerprint": {
      "success": true,
      "live": {
        "pods": 0,
        "podCopper": 0,
        "hubCopper": 0,
        "hubIron": 5900,
        "groundCopper": 0,
        "totalCopper": 0
      },
      "held": {
        "pods": 0,
        "podCopper": 0,
        "hubCopper": 0,
        "hubIron": 5900,
        "groundCopper": 0,
        "totalCopper": 0
      }
    },
    "transferId": "hold-buffer-pod-1784445390214",
    "created": {
      "live": {
        "state": "awaiting_launch",
        "copper": 100
      },
      "held": {
        "state": "awaiting_launch",
        "copper": 100
      }
    },
    "stage": {
      "success": true,
      "hold": {
        "transfer_id": "hold-buffer-pod-1784445390214",
        "force_name": "player",
        "platform_index": 24,
        "platform_name": "lab-hold-pod-held-v1",
        "surface_index": 17,
        "original_hidden": false,
        "original_paused": true,
        "active_states": {
          "16257": false
        },
        "deactivated_count": 0,
        "pod_completion": {
          "descending": 0,
          "ascending": 0,
          "items_recovered": 100
        },
        "held_tick": 9266516
      }
    },
    "afterStage": {
      "success": true,
      "live": {
        "pods": 1,
        "podCopper": 100,
        "podState": "ascending",
        "hubCopper": 0,
        "hubIron": 5900,
        "groundCopper": 0,
        "totalCopper": 100
      },
      "held": {
        "pods": 0,
        "podCopper": 0,
        "hubCopper": 0,
        "hubIron": 5900,
        "groundCopper": 100,
        "totalCopper": 100
      }
    },
    "after": {
      "success": true,
      "live": {
        "pods": 1,
        "podCopper": 100,
        "podState": "ascending",
        "hubCopper": 0,
        "hubIron": 5900,
        "groundCopper": 0,
        "totalCopper": 100
      },
      "held": {
        "pods": 0,
        "podCopper": 0,
        "hubCopper": 0,
        "hubIron": 5900,
        "groundCopper": 100,
        "totalCopper": 100
      }
    },
    "stagedPodFree": true,
    "discard": {
      "success": true,
      "discard": {
        "success": true,
        "result": {
          "transfer_id": "hold-buffer-pod-1784445390214",
          "platform_name": "lab-hold-pod-held-v1",
          "platform_index": 24,
          "surface_index": 17,
          "deleted": true
        }
      },
      "holds": 0
    },
    "verdict": "GREEN"
  },
  "goldenSessionLogTails": {
    "1": "   0.016 Loading mod core 0.0.0 (data.lua)\n   0.026 Loading mod base 2.0.77 (data.lua)\n   0.120 Loading mod elevated-rails 2.0.77 (data.lua)\n   0.133 Loading mod FluidMustFlow 1.4.4 (data.lua)\n   0.140 Loading mod quality 2.0.77 (data.lua)\n   0.150 Loading mod SpidertronEnhancements 1.10.8 (data.lua)\n   0.156 Loading mod space-age 2.0.77 (data.lua)\n   0.263 Loading mod SpidertronPatrols 2.6.3 (data.lua)\n   0.273 Loading mod surfexp_gateways 0.3.1 (data.lua)\n   0.279 Loading mod maraxsis 1.31.6 (data.lua)\n   0.328 Loading mod base 2.0.77 (data-updates.lua)\n   0.337 Loading mod quality 2.0.77 (data-updates.lua)\n   0.353 Loading mod SpidertronEnhancements 1.10.8 (data-updates.lua)\n   0.364 Loading mod space-age 2.0.77 (data-updates.lua)\n   0.372 Loading mod SpidertronPatrols 2.6.3 (data-updates.lua)\n   0.383 Loading mod maraxsis 1.31.6 (data-updates.lua)\n   0.395 Loading mod SpidertronEnhancements 1.10.8 (data-final-fixes.lua)\n   0.407 Loading mod SpidertronPatrols 2.6.3 (data-final-fixes.lua)\n   0.416 Loading mod maraxsis 1.31.6 (data-final-fixes.lua)\n   0.483 Checksum for core: 4187927925\n   0.483 Checksum of base: 1879415942\n   0.483 Checksum of elevated-rails: 70351106\n   0.483 Checksum of FluidMustFlow: 2741802744\n   0.483 Checksum of quality: 1142589254\n   0.483 Checksum of SpidertronEnhancements: 2802774701\n   0.483 Checksum of space-age: 1510664043\n   0.483 Checksum of SpidertronPatrols: 1814447366\n   0.483 Checksum of surfexp_gateways: 3113003946\n   0.483 Checksum of maraxsis: 2814018477\n   0.760 Prototype list checksum: 2702547635\n   0.818 Info PlayerData.cpp:64: Local player-data.json available, timestamp 1784445362\n   0.818 Info PlayerData.cpp:71: Cloud player-data.json unavailable\n   0.818 Info GlobalContext.cpp:1300: Resetting config.\n   0.819 Factorio initialised\n   0.819 Info ServerSynchronizer.cpp:22: nextHeartbeatSequenceNumber(0) initialized Synchronizer nextTickClosureTick(0).\n   0.819 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(Ready) to(PreparedToHostGame)\n   0.819 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(PreparedToHostGame) to(CreatingGame)\n   0.819 Loading map /clusterio/data/instances/clusterio-host-1-instance-1/saves/lab-holdbuf-golden-source.zip: 1434523 bytes.\n   0.827 Loading level.dat: 12686600 bytes.\n   0.827 Info Scenario.cpp:154: Map version 2.0.77-0\n   0.897 Blueprint storage \"blueprint-storage-2.dat\" was not found, trying to load previous version storage \"blueprint-storage.dat\"\n   0.898 Loading script.dat: 44018 bytes.\n   0.912 Checksum for script __level__/control.lua: 2401794522\n   0.912 Checksum for script __FluidMustFlow__/control.lua: 2342970735\n   0.914 Checksum for script __SpidertronEnhancements__/control.lua: 3957523864\n   0.918 Checksum for script __SpidertronPatrols__/control.lua: 591379248\n   0.922 Script @__maraxsis__/lib/events.lua:52: Finalized 67 events for maraxsis\n   0.922 Checksum for script __maraxsis__/control.lua: 2868601269\n   0.924 Info UDPSocket.cpp:38: Opening socket at (IP ADDR:({0.0.0.0:34100}))\n   0.924 Hosting game at IP ADDR:({0.0.0.0:34100})\n   0.924 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/generate-server-padlock-2?api_version=6\n   1.072 Info AuthServerConnector.cpp:112: Obtained serverPadlock for serverHash (qHjCPwLdxwIoteGurDjYWdcGNZMdmeZ7) from the auth server.\n   1.072 Info ServerMultiplayerManager.cpp:808: updateTick(9931278) changing state from(CreatingGame) to(InGame)\n   1.078 Info ServerRouter.cpp:668: Asking pingpong servers (pingpong1.factorio.com:34197, pingpong2.factorio.com:34197, pingpong3.factorio.com:34197, pingpong4.factorio.com:34197) for own address\n   1.078 Info UDPSocket.cpp:50: Opening socket for broadcast\n   1.078 Info RemoteCommandProcessor.cpp:126: Starting RCON interface at IP ADDR:({0.0.0.0:60276})\n   1.078 Info CommandLineMultiplayer.cpp:292: Maximum segment size = 100; minimum segment size = 25; maximum-segment-size peer count = 10; minimum-segment-size peer count = 20\n   1.079 Info RemoteCommandProcessor.cpp:245: New RCON connection from IP ADDR:({127.0.0.1:59358})\n   1.096 Script @__level__/modules/surface_export/core/gateway.lua:61: [Gateway] discover_and_unlock: 12 gateway/force unlocks\n   1.096 Script @__level__/modules/surface_export/control.lua:92: [Surface Export] Connected to Clusterio controller\n   1.112 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:64015}), expected IP ADDR:({209.236.82.227:56031}))\n   1.112 Script @__level__/modules/surface_export/control.lua:96: [Surface Export] Instance configuration updated\n   1.112 Warning ServerMultiplayerManager.cpp:654: Determining own address has failed. Best guess: IP ADDR:({209.236.82.227:56031})\n   1.112 Info AuthServerConnector.cpp:620: Performing TLS check.\n   1.112 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/tls-check/success\n   1.162 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=50, max_concurrent_jobs=3, show_progress=true, debug_mode=true\n   1.179 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:54461}), expected IP ADDR:({209.236.82.227:56031}))\n   1.179 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:80: [FactorioSurfaceExport] Gateway config updated: 0 gateway(s)\n   1.179 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=unchanged, max_concurrent_jobs=unchanged, show_progress=nil, debug_mode=nil\n   1.212 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:52745}), expected IP ADDR:({209.236.82.227:56031}))\n   1.250 Info AuthServerConnector.cpp:653: TLS check success.\n   1.778 Info MatchingServer.cpp:129: Matching server game `961329` has been created.\n   1.779 Info ServerMultiplayerManager.cpp:738: Matching server connection resumed\n   8.912 Script @__level__/modules/surface_export/core/destination-hold.lua:184: [DestinationHold] staged transfer hold-buffer-spoil-1784445369695 on platform 'lab-hold-spoil-held-v1' (idx=20, surface=12, deactivated=0, pods=0/0, recovered=0)\n  15.329 Script @__level__/modules/surface_export/core/destination-hold.lua:239: [DestinationHold] discarded transfer hold-buffer-spoil-1784445369695 platform 'lab-hold-spoil-held-v1' (deleted=true)\n  19.212 Script @__level__/modules/surface_export/core/destination-hold.lua:184: [DestinationHold] staged transfer hold-buffer-damage-1784445381089 on platform 'lab-hold-damage-held-v1' (idx=22, surface=15, deactivated=0, pods=0/0, recovered=0)\n  28.930 Script @__level__/modules/surface_export/core/destination-hold.lua:239: [DestinationHold] discarded transfer hold-buffer-damage-1784445381089 platform 'lab-hold-damage-held-v1' (deleted=true)\n  30.681 Script @__level__/modules/surface_export/utils/surface-lock.lua:223: [SurfaceLock] Completed 0 descending pods (recovered 100 items), 0 ascending pods\n  30.681 Script @__level__/modules/surface_export/core/destination-hold.lua:184: [DestinationHold] staged transfer hold-buffer-pod-1784445390214 on platform 'lab-hold-pod-held-v1' (idx=24, surface=17, deactivated=0, pods=0/0, recovered=100)\n  37.147 Script @__level__/modules/surface_export/core/destination-hold.lua:239: [DestinationHold] discarded transfer hold-buffer-pod-1784445390214 platform 'lab-hold-pod-held-v1' (deleted=true)\n",
    "2": "   0.007 Info ModManager.cpp:449: FeatureFlag space-travel = true\n   0.007 Info ModManager.cpp:449: FeatureFlag spoiling = true\n   0.008 Loading mod settings FluidMustFlow 1.4.4 (settings.lua)\n   0.010 Loading mod settings SpidertronEnhancements 1.10.8 (settings.lua)\n   0.011 Loading mod settings SpidertronPatrols 2.6.3 (settings.lua)\n   0.012 Loading mod settings maraxsis 1.31.6 (settings.lua)\n   0.013 Loading mod settings maraxsis 1.31.6 (settings-updates.lua)\n   0.015 Loading mod core 0.0.0 (data.lua)\n   0.022 Loading mod base 2.0.77 (data.lua)\n   0.099 Loading mod elevated-rails 2.0.77 (data.lua)\n   0.111 Loading mod FluidMustFlow 1.4.4 (data.lua)\n   0.116 Loading mod quality 2.0.77 (data.lua)\n   0.124 Loading mod SpidertronEnhancements 1.10.8 (data.lua)\n   0.129 Loading mod space-age 2.0.77 (data.lua)\n   0.250 Loading mod SpidertronPatrols 2.6.3 (data.lua)\n   0.263 Loading mod surfexp_gateways 0.3.1 (data.lua)\n   0.271 Loading mod maraxsis 1.31.6 (data.lua)\n   0.299 Loading mod base 2.0.77 (data-updates.lua)\n   0.306 Loading mod quality 2.0.77 (data-updates.lua)\n   0.319 Loading mod SpidertronEnhancements 1.10.8 (data-updates.lua)\n   0.329 Loading mod space-age 2.0.77 (data-updates.lua)\n   0.337 Loading mod SpidertronPatrols 2.6.3 (data-updates.lua)\n   0.345 Loading mod maraxsis 1.31.6 (data-updates.lua)\n   0.355 Loading mod SpidertronEnhancements 1.10.8 (data-final-fixes.lua)\n   0.366 Loading mod SpidertronPatrols 2.6.3 (data-final-fixes.lua)\n   0.376 Loading mod maraxsis 1.31.6 (data-final-fixes.lua)\n   0.443 Checksum for core: 4187927925\n   0.443 Checksum of base: 1879415942\n   0.443 Checksum of elevated-rails: 70351106\n   0.443 Checksum of FluidMustFlow: 2741802744\n   0.443 Checksum of quality: 1142589254\n   0.443 Checksum of SpidertronEnhancements: 2802774701\n   0.443 Checksum of space-age: 1510664043\n   0.443 Checksum of SpidertronPatrols: 1814447366\n   0.443 Checksum of surfexp_gateways: 3113003946\n   0.443 Checksum of maraxsis: 2814018477\n   0.743 Prototype list checksum: 2702547635\n   0.803 Info PlayerData.cpp:64: Local player-data.json available, timestamp 1784445364\n   0.803 Info PlayerData.cpp:71: Cloud player-data.json unavailable\n   0.804 Info GlobalContext.cpp:1300: Resetting config.\n   0.804 Factorio initialised\n   0.804 Info ServerSynchronizer.cpp:22: nextHeartbeatSequenceNumber(0) initialized Synchronizer nextTickClosureTick(0).\n   0.804 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(Ready) to(PreparedToHostGame)\n   0.804 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(PreparedToHostGame) to(CreatingGame)\n   0.804 Loading map /clusterio/data/instances/clusterio-host-2-instance-1/saves/lab-holdbuf-golden-dest.zip: 550461 bytes.\n   0.812 Loading level.dat: 3081268 bytes.\n   0.812 Info Scenario.cpp:154: Map version 2.0.77-0\n   0.829 Blueprint storage \"blueprint-storage-2.dat\" was not found, trying to load previous version storage \"blueprint-storage.dat\"\n   0.829 Loading script.dat: 44023 bytes.\n   0.842 Checksum for script __level__/control.lua: 2401794522\n   0.843 Checksum for script __FluidMustFlow__/control.lua: 2342970735\n   0.845 Checksum for script __SpidertronEnhancements__/control.lua: 3957523864\n   0.849 Checksum for script __SpidertronPatrols__/control.lua: 591379248\n   0.854 Script @__maraxsis__/lib/events.lua:52: Finalized 67 events for maraxsis\n   0.854 Checksum for script __maraxsis__/control.lua: 2868601269\n   0.856 Info UDPSocket.cpp:38: Opening socket at (IP ADDR:({0.0.0.0:34200}))\n   0.857 Hosting game at IP ADDR:({0.0.0.0:34200})\n   0.857 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/generate-server-padlock-2?api_version=6\n   1.002 Info AuthServerConnector.cpp:112: Obtained serverPadlock for serverHash (ov6QWgUKkMKBdy54kTUEd97TVK3eatfq) from the auth server.\n   1.002 Info ServerMultiplayerManager.cpp:808: updateTick(9933208) changing state from(CreatingGame) to(InGame)\n   1.006 Info ServerRouter.cpp:668: Asking pingpong servers (pingpong1.factorio.com:34197, pingpong2.factorio.com:34197, pingpong3.factorio.com:34197, pingpong4.factorio.com:34197) for own address\n   1.006 Info UDPSocket.cpp:50: Opening socket for broadcast\n   1.006 Info RemoteCommandProcessor.cpp:126: Starting RCON interface at IP ADDR:({0.0.0.0:62002})\n   1.006 Info CommandLineMultiplayer.cpp:292: Maximum segment size = 100; minimum segment size = 25; maximum-segment-size peer count = 10; minimum-segment-size peer count = 20\n   1.007 Info RemoteCommandProcessor.cpp:245: New RCON connection from IP ADDR:({127.0.0.1:34440})\n   1.024 Script @__level__/modules/surface_export/core/gateway.lua:61: [Gateway] discover_and_unlock: 12 gateway/force unlocks\n   1.024 Script @__level__/modules/surface_export/control.lua:92: [Surface Export] Connected to Clusterio controller\n   1.040 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:63444}), expected IP ADDR:({209.236.82.227:50481}))\n   1.040 Script @__level__/modules/surface_export/control.lua:96: [Surface Export] Instance configuration updated\n   1.040 Warning ServerMultiplayerManager.cpp:654: Determining own address has failed. Best guess: IP ADDR:({209.236.82.227:50481})\n   1.040 Info AuthServerConnector.cpp:620: Performing TLS check.\n   1.040 Info HttpSharedState.cpp:57: Downloading https://auth.factorio.com/tls-check/success\n   1.090 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=50, max_concurrent_jobs=3, show_progress=true, debug_mode=true\n   1.107 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:64927}), expected IP ADDR:({209.236.82.227:50481}))\n   1.107 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:80: [FactorioSurfaceExport] Gateway config updated: 0 gateway(s)\n   1.107 Script @__level__/modules/surface_export/interfaces/remote/configure.lua:86: [FactorioSurfaceExport] Configuration updated: batch_size=unchanged, max_concurrent_jobs=unchanged, show_progress=nil, debug_mode=nil\n   1.157 Warning ServerRouter.cpp:543: Received own address message reply with conflicting address (got IP ADDR:({209.236.82.227:50482}), expected IP ADDR:({209.236.82.227:50481}))\n   1.186 Info AuthServerConnector.cpp:653: TLS check success.\n   1.654 Info MatchingServer.cpp:129: Matching server game `961331` has been created.\n   1.657 Info ServerMultiplayerManager.cpp:738: Matching server connection resumed\n"
  },
  "restored": {
    "1": "test1.zip",
    "2": "test2.zip",
    "zeroLeftovers": true
  },
  "finished": "2026-07-19T07:16:50.688Z",
  "green": true
}
```
</details>