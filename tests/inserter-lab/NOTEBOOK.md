# Inserter-lab NOTEBOOK — the BUSY/CI non-belt loss (held items / inventories)

Durable record for the busy-platform ~115-item loss that is NOT belt (belt comp=4 vs gate ~115). Parallel to
`tests/belt-lab/NOTEBOOK.md` (belt subsystem, DONE). See plan `we-have-a-few-bright-dawn.md`.

## The problem
Cross-instance transfer of "test" (same seed, same code) loses ~115 items on CI (copper-plate, iron-plate,
railgun-ammo — railgun-ammo EXACTLY 47 every run) but 0 locally. Belt is ruled out (comp=4). Two opposed
hypotheses: H-REAL (held-item restore fails on dest) vs H-PHANTOM (export over-counts `expected` on a moving
platform — held items/inventories scanned non-atomically, unlike belts' Pitfall #16 atomic scan).

## D3 (2026-06-27) — set_stack TRUNCATES + the bool LIES (confirmed); capacity-mismatch RULED OUT
`tests/inserter-lab/probe_setstack.lua` on 2.0.76:
- railgun-ammo stack_size=**10**, iron-plate stack_size=100, bulk_inserter_capacity_bonus=**11** (hand cap ~12).
- `held_stack.set_stack({name, count=47})` (with the inserter briefly active, mimicking restore_held_items_only):
    bulk + railgun-ammo  -> held=**10** (truncated to stack_size 10), ok=**true**
    bulk + iron-plate    -> held=**12** (truncated to hand capacity 12), ok=true
    fast + railgun-ammo  -> held=4,  ok=true
    bulk + railgun BLOCKED drop-target (full chest) -> held=10 (target irrelevant; set_stack is synchronous)
  => `set_stack` silently TRUNCATES to min(item stack_size, hand capacity) and ALWAYS returns ok=true (the bool
     lies — restore_inserter_held trusting it reports held.count "restored" when fewer landed).
- **Capacity mismatch RULED OUT:** host-1 and host-2 BOTH have bulk_cap=11, inserter_stack=3. So set_stack of a
  source-captured count (<= source hand cap == dest hand cap) FITS on the dest — no truncation-from-mismatch.
- **Therefore** the truncation bug only loses items if the EXPORT recorded a count LARGER than a hand can
  physically hold (a hand can't hold 47 railgun-ammo at cap ~10/12). That points at H-PHANTOM (export
  over-count) OR a multi-inserter sum — must ground with D1.

## Source categorization (host-1 'test', live)
railgun-ammo: **held=81** (across multiple bulk inserters, each <=10), inventories(turrets)=338, ground=0.
So inserters DO hold railgun-ammo. The 47 loss is a subset — D1 decides real (dest short) vs phantom (expected
inflated).

## NEXT: D1+D2 — ground clone_physical vs expected vs dest_physical (decisive). Then Fix A or B.

## ROOT CAUSE (2026-06-27) — held items UNDER-restored; held loss == gate loss EXACTLY
D1+D2 on CI: [CI-DIAG-EXPORT-SUMMARY] total_abs_diff=0 (export EXACT, H-PHANTOM refuted) and [CI-DIAG]
held_failed=0 (no tracked bucket). But [CI-DIAG-SRC-HELD] vs [CI-DIAG-DEST-HELD] nailed it:
    railgun-ammo: src-held 80 -> dest-held 33 = lost 47  == gate loss 47
    copper-plate: src-held 68 -> dest-held 24 = lost 44  == gate loss 44
    iron-plate:   src-held 52 -> dest-held 20 = lost 32  == gate loss 32
The gate loss EXACTLY equals the held-item shortfall for every item => the busy loss IS inserter held items
being UNDER-restored, silently (held_failed=0).

MECHANISM: deserializer (`deserializer.lua:617-628`) set_stacks the held item on a freshly-created DEACTIVATED
inserter. On a deactivated inserter the bulk-inserter capacity isn't active, so set_stack seats only ~base hand
amount (D3: a non-bulk/deactivated hand takes ~4; a briefly-ACTIVE bulk inserter takes the full stack 10). The
hand is left PARTIALLY filled (valid_for_read=TRUE). Then `restore_held_items_only` (the pre-gate recovery)
SKIPS it because its guard is `not entity.held_stack.valid_for_read` (EMPTY hands only) -> partial hands never
topped up -> dest short -> gate fails, no bucket.

LOCAL vs CI EXPLAINED: locally the deserializer set_stack leaves the hand EMPTY (set_stack "silently fails on a
SETTLED-deactivated inserter") -> recovery pass fires (empty) -> full restore -> 0 loss. On CI (fresher state)
it leaves the hand PARTIAL -> recovery skips -> loss. Same code, state-dependent.

FIX A (Phase E): make held-item restore top up ANY hand whose count < captured (empty OR partial), via a
brief active toggle + set_stack the FULL captured count (verify by physical read-back, the bool lies). Likely
in `restore_held_items_only` (change the guard from "empty" to "count < captured"; clear + set_stack full).
Lab-test the top-up on a partially-filled bulk inserter first.

## FIX A ATTEMPT 1 FAILED — set_stack briefly-active does NOT seat items on CI inserters
Top-up fix (trigger on partial hands, briefly active + set_stack full count) deployed. CI result:
[CI-DIAG] held_failed=269 (was 0 — now VISIBLE), but [CI-DIAG-DEST-HELD] railgun-ammo STILL 33 (src 80). So
set_stack ran but added NOTHING on the real inserters. Lab + local: set_stack briefly-active reaches full (402
restored locally). CI: 269 failed. SAME code — the inserter ENTITY STATE differs (local clone settled vs CI
clone fresh), and set_stack on CI's inserters under-fills even briefly-active.
- The held loss is actually ~269 (the fix made it visible); the gate's ~147 is just the per-item-over-tol subset.
- This is the validation-timing-trilemma resurfacing: held items can't be reliably set pre-gate on these
  inserters. Candidate causes to probe: inserter_stack_size_override capping the hand; bulk capacity needing a
  TICK (not a synchronous toggle) to recompute; filter/pickup state. NEXT: advisor + probe override/tick.

## REPRO ATTEMPT via /plugin-import-file — does NOT reproduce; loss is ENVIRONMENT/PATH-driven, not payload
Captured the FAILING CI artifacts (added CI artifact upload): debug_source_platform (payload), debug_
destination_platform (failed dest state), host-2 save. Static JSON diff: dest inserters hold ~1 vs source 8/6/2
(257 lost across 42 inserters); inserters created with CORRECT legendary quality + correct held quality. A
fresh ACTIVE inserter, and the real dest inserter, both take set_stack(8)->8 and .count=8->8 fine.
- Fixed a real bug to enable replay: `/plugin-import-file` threw `No field named 'instance.directory'` —
  `this.cfg("instance.directory")` → `this.instance.path("script-output", filename)` (instance.ts).
- Replayed the EXACT CI payload locally via /plugin-import-file: railgun held restored to 78 across 19 inserters
  (dist 2/4/6/8 = the SOURCE counts) = ~100% CORRECT. So SAME PAYLOAD → local restores FULLY, CI under-restores.
  => NOT payload-driven. It's the import EXECUTION ENVIRONMENT (timing? whether the inserter has ticked to
  initialize bulk capacity? paused state?), or /plugin-import-file (non-transfer) takes a different path than a
  TRANSFER (which keeps entities deactivated through the gate).
- D3/lab never reproduces either. The ONLY faithful failed state we have is the CI host-2 SAVE (world.zip).
NEXT: load the CI save to inspect the actual failed inserters + run the activation test (active=true + step tick
→ do held items recover? = gate-timing vs real loss). OR ship the gate-side fix (skip held at gate, restore
post-activation where set_stack works). Advisor consult pending.


## 2026-07-10T06:09:15.764Z - B1-B4 inserter lab

Predictions: B1 held 8; B2 force sync raises bonus; B3 no residual; B4 open.

```json
{
  "script": "tests/inserter-lab/run-b1-b4.mjs",
  "started": "2026-07-10T06:08:15.154Z",
  "sections": [
    "b1",
    "b2",
    "b3",
    "b4"
  ],
  "predictions": {
    "b1": "researched-force control preserves held 8",
    "b2": "Phase-0 raises bonus-0 destination entity force",
    "b3": "pre-gate top-up leaves no physical residual",
    "b4": "OPEN"
  },
  "rungs": {
    "b1": {
      "success": true,
      "control": {
        "success": true,
        "kind": "control",
        "prediction": "full hand of 8 physically survives; adversarial destination bonus is raised before restore",
        "force_setup": null,
        "setup": {
          "success": true,
          "error": "nil",
          "name": "inserter-lab-b-control-1783663700627",
          "index": 33,
          "platform_force": "player",
          "entity_force": "player",
          "force_bonus": 11,
          "held": 8,
          "tick": 426788,
          "game_paused": false,
          "platform_paused": false
        },
        "source_physical": {
          "success": true,
          "name": "inserter-lab-b-control-1783663700627",
          "tick": 426832,
          "game_paused": false,
          "platform_paused": false,
          "platform_force": "player",
          "entity_force": "player",
          "force_bonus": 11,
          "held": 8,
          "physical_iron_plate": 8,
          "active": true
        },
        "transfer": {
          "success": true,
          "job_id": "014_inserter-lab-b-control-1783663700627",
          "tick": 426910
        },
        "destination_physical": {
          "success": true,
          "name": "inserter-lab-b-control-1783663700627",
          "tick": 370864,
          "game_paused": false,
          "platform_paused": false,
          "platform_force": "player",
          "entity_force": "player",
          "force_bonus": 11,
          "held": 8,
          "physical_iron_plate": 8,
          "active": true
        },
        "force_sync_confirmed": null,
        "full_hand_confirmed": true,
        "physical_total_confirmed": true
      }
    },
    "b2": {
      "success": true,
      "adversarial": {
        "success": true,
        "kind": "adversarial",
        "prediction": "full hand of 8 physically survives; adversarial destination bonus is raised before restore",
        "force_setup": {
          "source": {
            "success": true,
            "name": "inserter-lab-b-force-1783663722996",
            "bonus": 11,
            "force_count": 4
          },
          "destination": {
            "success": true,
            "name": "inserter-lab-b-force-1783663722996",
            "bonus": 0,
            "force_count": 4
          }
        },
        "setup": {
          "success": true,
          "error": "nil",
          "name": "inserter-lab-b-adversarial-1783663722996",
          "index": 34,
          "platform_force": "player",
          "entity_force": "inserter-lab-b-force-1783663722996",
          "force_bonus": 11,
          "held": 8,
          "tick": 427208,
          "game_paused": false,
          "platform_paused": false
        },
        "source_physical": {
          "success": true,
          "name": "inserter-lab-b-adversarial-1783663722996",
          "tick": 427249,
          "game_paused": false,
          "platform_paused": false,
          "platform_force": "player",
          "entity_force": "inserter-lab-b-force-1783663722996",
          "force_bonus": 11,
          "held": 8,
          "physical_iron_plate": 8,
          "active": true
        },
        "transfer": {
          "success": true,
          "job_id": "015_inserter-lab-b-adversarial-1783663722996",
          "tick": 427328
        },
        "destination_physical": {
          "success": true,
          "name": "inserter-lab-b-adversarial-1783663722996",
          "tick": 372400,
          "game_paused": false,
          "platform_paused": false,
          "platform_force": "player",
          "entity_force": "inserter-lab-b-force-1783663722996",
          "force_bonus": 11,
          "held": 8,
          "physical_iron_plate": 8,
          "active": true
        },
        "force_sync_confirmed": true,
        "full_hand_confirmed": true,
        "physical_total_confirmed": true
      }
    },
    "b3": {
      "success": true,
      "adversarial": {
        "success": true,
        "kind": "adversarial",
        "prediction": "full hand of 8 physically survives; adversarial destination bonus is raised before restore",
        "force_setup": {
          "source": {
            "success": true,
            "name": "inserter-lab-b-force-1783663722996",
            "bonus": 11,
            "force_count": 4
          },
          "destination": {
            "success": true,
            "name": "inserter-lab-b-force-1783663722996",
            "bonus": 0,
            "force_count": 4
          }
        },
        "setup": {
          "success": true,
          "error": "nil",
          "name": "inserter-lab-b-adversarial-1783663722996",
          "index": 34,
          "platform_force": "player",
          "entity_force": "inserter-lab-b-force-1783663722996",
          "force_bonus": 11,
          "held": 8,
          "tick": 427208,
          "game_paused": false,
          "platform_paused": false
        },
        "source_physical": {
          "success": true,
          "name": "inserter-lab-b-adversarial-1783663722996",
          "tick": 427249,
          "game_paused": false,
          "platform_paused": false,
          "platform_force": "player",
          "entity_force": "inserter-lab-b-force-1783663722996",
          "force_bonus": 11,
          "held": 8,
          "physical_iron_plate": 8,
          "active": true
        },
        "transfer": {
          "success": true,
          "job_id": "015_inserter-lab-b-adversarial-1783663722996",
          "tick": 427328
        },
        "destination_physical": {
          "success": true,
          "name": "inserter-lab-b-adversarial-1783663722996",
          "tick": 372400,
          "game_paused": false,
          "platform_paused": false,
          "platform_force": "player",
          "entity_force": "inserter-lab-b-force-1783663722996",
          "force_bonus": 11,
          "held": 8,
          "physical_iron_plate": 8,
          "active": true
        },
        "force_sync_confirmed": true,
        "full_hand_confirmed": true,
        "physical_total_confirmed": true
      }
    },
    "b4": {
      "success": true,
      "prediction": "OPEN: measurement decides whether seated over-capacity hands survive or eject",
      "setup": {
        "success": true,
        "name": "inserter-lab-b-b4-1783663747098",
        "force": "inserter-lab-b-force-1783663747098",
        "before": {
          "label": "bonus 11 seated",
          "tick": 427547,
          "game_paused": false,
          "bonus": 11,
          "held": 8,
          "ground": 0,
          "total": 8
        }
      },
      "lowered": {
        "success": true,
        "tick": 427588,
        "game_paused": false,
        "bonus": 0,
        "held": 8,
        "ground": 0,
        "total": 8
      },
      "after_lower_elapsed": {
        "success": true,
        "tick": 427707,
        "game_paused": false,
        "bonus": 0,
        "held": 8,
        "ground": 0,
        "total": 8
      },
      "reset_technology_effects": {
        "success": true,
        "tick": 427751,
        "game_paused": false,
        "bonus": 0,
        "held": 8,
        "ground": 0,
        "total": 8
      },
      "after_reset_elapsed": {
        "success": true,
        "tick": 427870,
        "game_paused": false,
        "bonus": 0,
        "held": 8,
        "ground": 0,
        "total": 8
      },
      "verdict": "seated hand survives bonus drop"
    }
  },
  "errors": [],
  "initial_reset": {
    "baseline": {
      "source": 3,
      "destination": 3
    },
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "exports": {},
        "records": {},
        "tick": 426518,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "deleted": {},
        "exports": {},
        "records": {},
        "tick": 369244,
        "force_count": 3
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 426629,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "lab_forces": 0,
        "forces": {},
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 369355,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "lab_forces": 0,
        "forces": {},
        "force_count": 3
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 426709,
      "force_count": 3
    },
    "destination": {
      "success": true,
      "tick": 369437,
      "force_count": 3
    }
  },
  "final_reset": {
    "baseline": {
      "source": 3,
      "destination": 3
    },
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "inserter-lab-b-b4-1783663747098"
        ],
        "exports": [
          "014_inserter-lab-b-control-1783663700627",
          "015_inserter-lab-b-adversarial-1783663722996"
        ],
        "records": {},
        "tick": 427911,
        "force_count": 5
      },
      "destination": {
        "success": true,
        "deleted": [
          "platform-1",
          "platform-2"
        ],
        "exports": {},
        "records": {},
        "tick": 372843,
        "force_count": 4
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 428019,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "lab_forces": 0,
        "forces": {},
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 372952,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "lab_forces": 0,
        "forces": {},
        "force_count": 3
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T06:09:15.764Z"
}
```


## 2026-07-10T06:11:23.677Z - B1-B4 inserter lab

Predictions: B1 held 8; B2 force sync raises bonus; B3 no residual; B4 open.

```json
{
  "script": "tests/inserter-lab/run-b1-b4.mjs",
  "started": "2026-07-10T06:10:23.153Z",
  "sections": [
    "b1",
    "b2",
    "b3",
    "b4"
  ],
  "predictions": {
    "b1": "researched-force control preserves held 8",
    "b2": "Phase-0 raises bonus-0 destination entity force",
    "b3": "pre-gate top-up leaves no physical residual",
    "b4": "OPEN"
  },
  "rungs": {
    "b1": {
      "success": true,
      "control": {
        "success": true,
        "kind": "control",
        "prediction": "full hand of 8 physically survives; adversarial destination bonus is raised before restore",
        "force_setup": null,
        "setup": {
          "success": true,
          "error": "nil",
          "name": "inserter-lab-b-control-1783663828575",
          "index": 38,
          "platform_force": "player",
          "entity_force": "player",
          "force_bonus": 11,
          "held": 8,
          "tick": 432740,
          "game_paused": false,
          "platform_paused": false
        },
        "source_physical": {
          "success": true,
          "name": "inserter-lab-b-control-1783663828575",
          "tick": 432783,
          "game_paused": false,
          "platform_paused": false,
          "platform_force": "player",
          "entity_force": "player",
          "force_bonus": 11,
          "held": 8,
          "physical_iron_plate": 8,
          "active": true
        },
        "transfer": {
          "success": true,
          "job_id": "016_inserter-lab-b-control-1783663828575",
          "tick": 432862
        },
        "destination_physical": {
          "success": true,
          "name": "inserter-lab-b-control-1783663828575",
          "tick": 378993,
          "game_paused": false,
          "platform_paused": false,
          "platform_force": "player",
          "entity_force": "player",
          "force_bonus": 11,
          "held": 8,
          "physical_iron_plate": 8,
          "active": true
        },
        "force_sync_confirmed": null,
        "full_hand_confirmed": true,
        "physical_total_confirmed": true
      }
    },
    "b2": {
      "success": true,
      "adversarial": {
        "success": true,
        "kind": "adversarial",
        "prediction": "full hand of 8 physically survives; adversarial destination bonus is raised before restore",
        "force_setup": {
          "source": {
            "success": true,
            "name": "inserter-lab-b-force-1783663850505",
            "bonus": 11,
            "force_count": 4
          },
          "destination": {
            "success": true,
            "name": "inserter-lab-b-force-1783663850505",
            "bonus": 0,
            "force_count": 4
          }
        },
        "setup": {
          "success": true,
          "error": "nil",
          "name": "inserter-lab-b-adversarial-1783663850505",
          "index": 39,
          "platform_force": "player",
          "entity_force": "inserter-lab-b-force-1783663850505",
          "force_bonus": 11,
          "held": 8,
          "tick": 433161,
          "game_paused": false,
          "platform_paused": false
        },
        "source_physical": {
          "success": true,
          "name": "inserter-lab-b-adversarial-1783663850505",
          "tick": 433201,
          "game_paused": false,
          "platform_paused": false,
          "platform_force": "player",
          "entity_force": "inserter-lab-b-force-1783663850505",
          "force_bonus": 11,
          "held": 8,
          "physical_iron_plate": 8,
          "active": true
        },
        "transfer": {
          "success": true,
          "job_id": "017_inserter-lab-b-adversarial-1783663850505",
          "tick": 433280
        },
        "destination_physical": {
          "success": true,
          "name": "inserter-lab-b-adversarial-1783663850505",
          "tick": 380556,
          "game_paused": false,
          "platform_paused": false,
          "platform_force": "player",
          "entity_force": "inserter-lab-b-force-1783663850505",
          "force_bonus": 11,
          "held": 8,
          "physical_iron_plate": 8,
          "active": true
        },
        "force_sync_confirmed": true,
        "full_hand_confirmed": true,
        "physical_total_confirmed": true
      }
    },
    "b3": {
      "success": true,
      "adversarial": {
        "success": true,
        "kind": "adversarial",
        "prediction": "full hand of 8 physically survives; adversarial destination bonus is raised before restore",
        "force_setup": {
          "source": {
            "success": true,
            "name": "inserter-lab-b-force-1783663850505",
            "bonus": 11,
            "force_count": 4
          },
          "destination": {
            "success": true,
            "name": "inserter-lab-b-force-1783663850505",
            "bonus": 0,
            "force_count": 4
          }
        },
        "setup": {
          "success": true,
          "error": "nil",
          "name": "inserter-lab-b-adversarial-1783663850505",
          "index": 39,
          "platform_force": "player",
          "entity_force": "inserter-lab-b-force-1783663850505",
          "force_bonus": 11,
          "held": 8,
          "tick": 433161,
          "game_paused": false,
          "platform_paused": false
        },
        "source_physical": {
          "success": true,
          "name": "inserter-lab-b-adversarial-1783663850505",
          "tick": 433201,
          "game_paused": false,
          "platform_paused": false,
          "platform_force": "player",
          "entity_force": "inserter-lab-b-force-1783663850505",
          "force_bonus": 11,
          "held": 8,
          "physical_iron_plate": 8,
          "active": true
        },
        "transfer": {
          "success": true,
          "job_id": "017_inserter-lab-b-adversarial-1783663850505",
          "tick": 433280
        },
        "destination_physical": {
          "success": true,
          "name": "inserter-lab-b-adversarial-1783663850505",
          "tick": 380556,
          "game_paused": false,
          "platform_paused": false,
          "platform_force": "player",
          "entity_force": "inserter-lab-b-force-1783663850505",
          "force_bonus": 11,
          "held": 8,
          "physical_iron_plate": 8,
          "active": true
        },
        "force_sync_confirmed": true,
        "full_hand_confirmed": true,
        "physical_total_confirmed": true
      }
    },
    "b4": {
      "success": true,
      "prediction": "OPEN: measurement decides whether seated over-capacity hands survive or eject",
      "setup": {
        "success": true,
        "name": "inserter-lab-b-b4-1783663875020",
        "force": "inserter-lab-b-force-1783663875020",
        "before": {
          "label": "bonus 11 seated",
          "tick": 433497,
          "game_paused": false,
          "bonus": 11,
          "held": 8,
          "ground": 0,
          "total": 8
        }
      },
      "lowered": {
        "success": true,
        "tick": 433536,
        "game_paused": false,
        "bonus": 0,
        "held": 8,
        "ground": 0,
        "total": 8
      },
      "after_lower_elapsed": {
        "success": true,
        "tick": 433653,
        "game_paused": false,
        "bonus": 0,
        "held": 8,
        "ground": 0,
        "total": 8
      },
      "reset_technology_effects": {
        "success": true,
        "tick": 433697,
        "game_paused": false,
        "bonus": 0,
        "held": 8,
        "ground": 0,
        "total": 8
      },
      "after_reset_elapsed": {
        "success": true,
        "tick": 433817,
        "game_paused": false,
        "bonus": 0,
        "held": 8,
        "ground": 0,
        "total": 8
      },
      "verdict": "seated hand survives bonus drop"
    }
  },
  "errors": [],
  "initial_reset": {
    "baseline": {
      "source": 3,
      "destination": 3
    },
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "exports": {},
        "records": {},
        "tick": 432471,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "deleted": {},
        "exports": {},
        "records": {},
        "tick": 377404,
        "force_count": 3
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 432582,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "lab_forces": 0,
        "forces": {},
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 377514,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "lab_forces": 0,
        "forces": {},
        "force_count": 3
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 432662,
      "force_count": 3
    },
    "destination": {
      "success": true,
      "tick": 377595,
      "force_count": 3
    }
  },
  "final_reset": {
    "baseline": {
      "source": 3,
      "destination": 3
    },
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "inserter-lab-b-b4-1783663875020"
        ],
        "exports": [
          "016_inserter-lab-b-control-1783663828575",
          "017_inserter-lab-b-adversarial-1783663850505"
        ],
        "records": {},
        "tick": 433859,
        "force_count": 5
      },
      "destination": {
        "success": true,
        "deleted": [
          "platform-1",
          "platform-2"
        ],
        "exports": {},
        "records": {},
        "tick": 380998,
        "force_count": 4
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 433969,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "lab_forces": 0,
        "forces": {},
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 381108,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "lab_forces": 0,
        "forces": {},
        "force_count": 3
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T06:11:23.677Z"
}
```


## 2026-07-18T19:35:49.751Z — B6 activation-refutation rung (Factorio 2.0.77)

Runner: `tests/inserter-lab/run-b6-deactivated-setstack.mjs` on clusterio-host-1-instance-1 (player force bonuses at run: bulk 11, stack 3).

- **B6a fresh-inactive**: bulk set_stack(8) → held 8; plain set_stack(4) → held 4.
- **B6b settled-inactive** (312 elapsed ticks, still inactive=true): bulk set_stack(8) → held 8.
- **B6c bonus-0 A/B** (temp force, bonus 0): INACTIVE → 1, ACTIVE → 1.

**VERDICT: ACTIVATION-INDEPENDENT** — set_stack seating does not depend on entity.active in any tested condition; the capacity clamp is purely force-bonus-governed. SUPERSEDES: the D3/MECHANISM entry ('on a deactivated inserter the bulk capacity isn't active'), the LOCAL-vs-CI 'silently fails on a SETTLED-deactivated inserter' attribution, and FIX A ATTEMPT 1's settled-vs-fresh entity-state hypothesis — the un-isolated variable in all three was the FORCE BONUS, never activation. The real historical held phantom: the deserializer's held restore was DEAD CODE (stranded behind restore_inventories' has_inventories early-return), so held items were never attempted at all; on CI the Pitfall #29 bonus clamp shortened what the recovery pass then seated.

Residual [hypothesis]: not yet reproduced in the exact import context (import-created entities on a paused platform); the inserter-held-capacity baked-fixture batch covers that end-to-end.

Zero-leftover: platform deleted=true, post-run {"success":true,"leftover_platforms":0,"probe_storage":false,"probe_force":false,"tick":544076}.

<details><summary>Raw results JSON</summary>

```json
{
  "script": "tests/inserter-lab/run-b6-deactivated-setstack.mjs",
  "started": "2026-07-18T19:35:38.307Z",
  "errors": [],
  "base_version": "2.0.77",
  "setup": {
    "success": true,
    "surface": 2,
    "player_bulk_bonus": 11,
    "player_stack_bonus": 3
  },
  "fresh": {
    "success": true,
    "tick": 543598,
    "bulk_ok": true,
    "bulk_held": 8,
    "plain_ok": true,
    "plain_held": 4
  },
  "settled": {
    "success": true,
    "elapsed_ticks": 312,
    "bulk_ok": true,
    "bulk_held": 8,
    "still_inactive": true
  },
  "bonus0": {
    "success": true,
    "force_bonus": 0,
    "inactive_held": 1,
    "active_held": 1,
    "inactive_ok": true,
    "active_ok": true
  },
  "verdict": "ACTIVATION-INDEPENDENT",
  "cleanup": {
    "success": true,
    "deleted": true
  },
  "zero": {
    "success": true,
    "leftover_platforms": 0,
    "probe_storage": false,
    "probe_force": false,
    "tick": 544076
  },
  "zero_ok": true,
  "finished": "2026-07-18T19:35:49.751Z"
}
```
</details>

## 2026-07-18T22:55:21.799Z — B7 held-item capacity batch (bake gate, RED)

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
  ],
  "destBonusBefore": 11
}
```
</details>

## 2026-07-18T22:57:29.638Z — B7 held-item capacity batch (bake gate, RED)

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
  ],
  "destBonusBefore": 11
}
```
</details>

## 2026-07-18T23:02:03.511Z — B7 held-item capacity batch (bake gate, RED)

Runner: `tests/lab-gallery/run-golden-batch.mjs` against the committed golden pair loaded via Clusterio-native save assignment (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}.

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
  "destBonusBefore": 0,
  "sourceFingerprint": {
    "success": true,
    "platformIndex": 16,
    "surfaceIndex": 13,
    "heldCount": 8,
    "heldName": "railgun-ammo",
    "heldQuality": "normal",
    "active": false,
    "destructible": false,
    "forceBonus": 11
  }
}
```
</details>

## 2026-07-18T23:04:51.734Z — B7 held-item capacity batch (bake gate, GREEN)

Runner: `tests/lab-gallery/run-golden-batch.mjs` against the committed golden pair loaded via Clusterio-native save assignment (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}.

**Adversarial dest** — loaded golden destination bulk_inserter_capacity_bonus = 0 (asserted 0, never forced). **Source fingerprint** reproduced from the save-loaded world: bulk-inserter at (40.5,-122.5) held 8 railgun-ammo (legendary), inactive+indestructible, source force bonus 11.

**Transfer** — production `/transfer-platform 16` reached terminal validation_success=true (/clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_lab-omnibus-state-v1_9267412.json). INDEPENDENT physical destination reads: force bonus RAISED 0 -> 11 (raise-only), hand physically seats 8 railgun-ammo at legendary, forceDataMismatches recorded ({"force":"player","property":"bulk_inserter_capacity_bonus","source":11,"destination":0,"synced_to":11}), source deleted. GREEN.

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
  "destBonusBefore": 0,
  "sourceFingerprint": {
    "success": true,
    "platformIndex": 16,
    "surfaceIndex": 13,
    "heldCount": 8,
    "heldName": "railgun-ammo",
    "heldQuality": "legendary",
    "active": false,
    "destructible": false,
    "forceBonus": 11
  },
  "transferCommand": {
    "platformIndex": 16,
    "out": "═══════════════════════════════════════"
  },
  "importResultPath": "/clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_lab-omnibus-state-v1_9267412.json",
  "destBonusAfter": 11,
  "destInserter": {
    "success": true,
    "platformIndex": 19,
    "surfaceIndex": 2,
    "heldCount": 8,
    "heldName": "railgun-ammo",
    "heldQuality": "legendary",
    "active": false,
    "destructible": true,
    "forceBonus": 11
  },
  "forceDataMismatch": {
    "force": "player",
    "property": "bulk_inserter_capacity_bonus",
    "source": 11,
    "destination": 0,
    "synced_to": 11
  },
  "verdict": "GREEN"
}
```
</details>

## 2026-07-18T23:05:54.276Z — B7 held-item capacity batch (bake gate, GREEN)

Runner: `tests/lab-gallery/run-golden-batch.mjs` against the committed golden pair loaded via Clusterio-native save assignment (instances {"1":2119131471,"2":234487481}); pre-batch saves {"1":"test1.zip","2":"test2.zip"}, restored {"1":"test1.zip","2":"test2.zip","zeroLeftovers":true}.

**Adversarial dest** — loaded golden destination bulk_inserter_capacity_bonus = 0 (asserted 0, never forced). **Source fingerprint** reproduced from the save-loaded world: bulk-inserter at (40.5,-122.5) held 8 railgun-ammo (legendary), inactive+indestructible, source force bonus 11.

**Transfer** — production `/transfer-platform 16` reached terminal validation_success=true (/clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_lab-omnibus-state-v1_9267463.json). INDEPENDENT physical destination reads: force bonus RAISED 0 -> 11 (raise-only), hand physically seats 8 railgun-ammo at legendary, forceDataMismatches recorded ({"force":"player","property":"bulk_inserter_capacity_bonus","source":11,"destination":0,"synced_to":11}), source deleted. GREEN.

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
  "destBonusBefore": 0,
  "sourceFingerprint": {
    "success": true,
    "platformIndex": 16,
    "surfaceIndex": 13,
    "heldCount": 8,
    "heldName": "railgun-ammo",
    "heldQuality": "legendary",
    "active": false,
    "destructible": false,
    "forceBonus": 11
  },
  "transferCommand": {
    "platformIndex": 16,
    "out": "═══════════════════════════════════════"
  },
  "importResultPath": "/clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_lab-omnibus-state-v1_9267463.json",
  "destBonusAfter": 11,
  "destInserter": {
    "success": true,
    "platformIndex": 19,
    "surfaceIndex": 2,
    "heldCount": 8,
    "heldName": "railgun-ammo",
    "heldQuality": "legendary",
    "active": false,
    "destructible": true,
    "forceBonus": 11
  },
  "forceDataMismatch": {
    "force": "player",
    "property": "bulk_inserter_capacity_bonus",
    "source": 11,
    "destination": 0,
    "synced_to": 11
  },
  "verdict": "GREEN"
}
```
</details>