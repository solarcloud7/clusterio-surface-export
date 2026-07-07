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
