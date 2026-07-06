# Hold-Completeness Lab — Notebook (append-only)

Purpose: Phase-0 gate for Phase 2 transfer wiring. The destination-hold primitive has proven item/fluid fidelity, but Phase 2 will hold platforms for a bounded compensation window. This lab measures whether a held platform remains fully non-live for the remaining axes that matter to users and the no-duplicates contract.

Required rungs:

- PR-0A / spoilage: live control must show spoilage movement while the held specimen stays stable.
- PR-0A / damage: live control must show asteroid collision or damage exposure while the held specimen stays stable.
- PR-0A / cargo pods: live control must show descending pod progress while the held specimen stays stable, including the descending-pod overflow branch.

Discipline:

- Append every run, including failures and unconstructible specimens.
- Every reading records `game.tick`, `game.tick_paused`, and `platform_paused` where applicable.
- The runner must reset lab storage and delete lab platforms, then prove zero leftovers.
- UNEXPLAINED is not fixed; unconstructible is not a pass for the wiring gate.

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
