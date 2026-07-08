# Fluid Lab — Notebook (append-only)

Isolated fluid-segment experiments on the pinned **2.0.77** engine. Goal: turn the fluid-detach/ghost-buffer
MECHANISM from an unverified hypothesis into measured facts, and decide the destination-hold fluid-fidelity fix
on data. Nothing durable lives in chat — every experiment is a saved script + a notebook entry here.

> **PROMOTED TO GIT on 2026-07-06** after R9/R7 produced durable conclusions. Continue appending every rung result, including failures.

## Why this lab exists (the provenance failure it corrects)

Pitfall #17's BEHAVIORAL rule (inject fluid only after `active=true`) is empirically solid — the 15% transfer
fluid loss was reproducible and the inject-after-activation reorder fixed it, regression-tested since. But its
MECHANISM story ("write lands in a ghost buffer, wiped when the entity rejoins the segment on unfreeze",
citing `FluidSystem::merge_segment()` / `FluidSystem::on_entity_unfrozen`) was never verified — those are
internal closed-source engine symbols no one outside Wube can inspect; the "Factorio API expert analysis" was
an unverifiable consult promoted to "Confirmed by". And the destination-hold CI failure CONTRADICTS the story's
prediction: `delta=20` appears at staged+600 — BEFORE reactivation — while wipe-on-rejoin predicts loss only
AFTER. The mechanism is officially a **[hypothesis]** until this lab settles it.

Known prior facts (controls — verified, do not re-litigate):
- Tank + pipe fluids (1100) survived the full hold cycle in CI — they are NOT in `ACTIVATABLE_ENTITY_TYPES`
  and were never deactivated. Only the deactivated chemical plant's 20 heavy-oil vanished.
- `get_fluid_segment_id(i) == nil` for isolated fluidboxes → read `fluidbox[i]` directly (Pitfall #22, empirical).
- Fusion-reactor OUTPUT fluidboxes reject writes (Pitfall #21, empirical).
- Segment dedup: count each `seg_id` once or you double-count (api-notes, empirical).

## THE QUESTION LADDER (each rung isolates one variable; record every rung below, incl. failures)

**R0 — Meter baseline (trust the instrument first).** On ACTIVE entities (chem plant w/ recipe, pump, boiler,
thruster; controls: tank, pipe), write known fluid amounts, verify write-acceptance by immediate read-back via
BOTH meters (segment-contents path AND direct `fluidbox[i]`). The meters must agree on active entities or
everything downstream is noise.

**R1 — Deactivation timeline (THE discriminating experiment for the ghost-buffer hypothesis).**
Plant with verified 20 heavy-oil → `active=false` → read IMMEDIATELY (both meters + `get_fluid_segment_id`)
→ +60 ticks → read → `active=true` → read → +60 ticks → read.
Discriminates four worlds:
  (a) loss-at-deactivation — immediate reads drop to 0 everywhere;
  (b) shadow-while-held — direct `fluidbox[i]` still shows 20 while detached, segment path shows 0; post-
      reactivation decides whether the shadow merges back or is wiped;
  (c) wipe-at-rejoin (the original hypothesis) — 20 readable while held, gone after reactivation;
  (d) no loss — the CI delta has a different cause entirely (meter artifact → re-examine R0).
Repeat with `frozen=true` instead of `active=false` (Pitfall #17 names both — they may differ!).

**R2 — Write-while-inactive (the original import scenario, isolated).** Deactivated plant → write 20 →
read back immediately (both meters) → reactivate → read. Where does the write land, and does it survive?

**R3 — `platform.paused` interaction (decides the hold-fix DESIGN).** Paused platform, plant stays ACTIVE
with verified fluid → 600 ticks → read → unpause → read. If pause alone preserves active-entity fluids (and
the hold probe already proved pause stops crafting/belts over 600 ticks), the hold could EXEMPT fluid-bearing
entities from deactivation — a far simpler fix than snapshot/reinject. R1+R3 together pick the design:
  - R3 shows pause-preserves + R1 shows deactivation-loses → fix = deactivation exemption for fluid-holders
    (with an unpause-race argument recorded) OR snapshot/reinject; choose on simplicity + not-live proof.
  - R1 shows shadow-then-wipe → snapshot at stage (pre-deactivation reading) + reinject after reactivation
    (the import pipeline's proven pattern).

**R4 — Segment topology on detach.** Segment pipe—pump—pipe—tank with known contents → deactivate the pump →
does the segment split? total before/after, per-member reads → reactivate → merge behavior, total again.
Tests the "merge favors the larger segment" sub-claim directly.

**R5 (optional) — save/reload while inactive-with-fluid.** Only if R1 finds a held-state shadow: does the
shadow survive a save/load cycle? (The hold's restart path depends on it.)

## ⚠️ LAB HAZARDS (inherited from belt-lab — cost a crash-loop + patch-and-reset to learn)

**NEVER `script.on_event(defines.events.on_tick, fn)` from `/sc` on the live dev cluster** — `/sc` runs in the
level context and CLOBBERS the production async-processor's on_tick handler; the cascade ends in a save that
crash-loops on load (see belt-lab NOTEBOOK for the full post-mortem). Use tick-stamped polling reads instead.
Also: never `platform.destroy()` (no-op, Pitfall #19) — clean up via `game.delete_surface`; run on an isolated
test platform (bare `create_space_platform` + starter pack is enough — no clone needed for these rungs);
`/sc` fluid writes need the recipe ENABLED on the force first (`force.recipes[...].enabled = true`) and the
write VERIFIED by read-back, or you reproduce the silent-rejection blind spot that hid the CI failure locally.

## TRIED & SETTLED (the empirical DO-NOT-REPEAT ledger — consult before trying anything)

| Claim / approach | Verdict | Evidence |
|---|---|---|
| Original destination-hold CI `delta=20` | ⚠️ UNEXPLAINED — eliminated by fixture determinism; root cause never isolated. Candidates: fresh-force recipe-less write path, meter staleness. Instrumented probe self-diagnoses on recurrence. | CI runs 28765920597 / 28800842207 / 28802133085 failed with `fluids 1120→1100 delta=20`; hardened run 28814951121 green with asserted `machine_fluids=40`. |
| Tank/pipe (non-activatable) fluids survive the hold cycle | ✅ OBSERVED (CI, 3 runs) | same runs: 1100 stable across stage→restart→go-live |
| Local force silently rejected the original plant heavy-oil write when fixture setup did not assert recipe/write acceptance | ✅ OBSERVED — the local-green blind spot fixed by fixture determinism | local probe runs measured 1100 pre-stage vs CI's 1120; hardened fixture enables `heavy-oil-cracking`, probes every fluidbox, and asserts positive machine fluid. |

*(append experiment entries below — script name, date, raw numbers, verdict)*


## 2026-07-06T17:46:32.528Z - R0-R3 fluid-lab run (run-r0-r3.mjs)

```json
{
  "script": "tests/fluid-lab/run-r0-r3.mjs",
  "instance": "clusterio-host-1-instance-1",
  "controller": "surface-export-controller",
  "started": "2026-07-06T17:45:45.094Z",
  "rungs": {
    "R0": {
      "success": true,
      "rung": "R0",
      "platform": 29,
      "rows": [
        {
          "label": "chemical-plant",
          "create_ok": true,
          "create_error": "[LuaEntity: chemical-plant at [gps=1115.5,100.5,platform-2]]",
          "recipe_ok": true,
          "recipe_error": "nil",
          "write": {
            "accepted": true,
            "box": 1,
            "fluid": "water",
            "amount": 20,
            "attempts": [
              {
                "box": 1,
                "fluid": "heavy-oil",
                "ok": true,
                "error": "nil"
              },
              {
                "box": 1,
                "fluid": "water",
                "ok": true,
                "error": "nil",
                "read": {
                  "name": "water",
                  "amount": 20
                }
              }
            ]
          },
          "read": {
            "label": "R0:chemical-plant",
            "tick": 3261836,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "chemical-plant",
            "type": "assembling-machine",
            "active": true,
            "direct_total": 20,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 20,
                  "temperature": 25
                },
                "segment_error": "nil"
              },
              {
                "index": 2,
                "direct_error": "nil",
                "segment_error": "nil"
              },
              {
                "index": 3,
                "direct_error": "nil",
                "segment_error": "nil"
              }
            ]
          }
        },
        {
          "label": "pump",
          "create_ok": true,
          "create_error": "[LuaEntity: pump at [gps=1118.5,100.0,platform-2]]",
          "write": {
            "accepted": true,
            "box": 1,
            "fluid": "heavy-oil",
            "amount": 30,
            "attempts": [
              {
                "box": 1,
                "fluid": "heavy-oil",
                "ok": true,
                "error": "nil",
                "read": {
                  "name": "heavy-oil",
                  "amount": 30
                }
              }
            ]
          },
          "read": {
            "label": "R0:pump",
            "tick": 3261836,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "pump",
            "type": "pump",
            "active": true,
            "direct_total": 30,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "heavy-oil",
                  "amount": 30,
                  "temperature": 25
                },
                "segment_error": "nil"
              }
            ]
          }
        },
        {
          "label": "boiler",
          "create_ok": true,
          "create_error": "[LuaEntity: boiler at [gps=1121.5,100.0,platform-2]]",
          "write": {
            "accepted": true,
            "box": 1,
            "fluid": "water",
            "amount": 30,
            "attempts": [
              {
                "box": 1,
                "fluid": "heavy-oil",
                "ok": true,
                "error": "nil"
              },
              {
                "box": 1,
                "fluid": "water",
                "ok": true,
                "error": "nil",
                "read": {
                  "name": "water",
                  "amount": 30
                }
              }
            ]
          },
          "read": {
            "label": "R0:boiler",
            "tick": 3261836,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "boiler",
            "type": "boiler",
            "active": true,
            "direct_total": 30,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 30,
                  "temperature": 25
                },
                "segment_id": 620,
                "segment_error": "620",
                "segment_contents": {}
              },
              {
                "index": 2,
                "direct_error": "nil",
                "segment_error": "nil"
              }
            ]
          }
        },
        {
          "label": "thruster",
          "create_ok": true,
          "create_error": "[LuaEntity: thruster at [gps=1124.0,100.5,platform-2]]",
          "write": {
            "accepted": true,
            "box": 1,
            "fluid": "thruster-fuel",
            "amount": 30,
            "attempts": [
              {
                "box": 1,
                "fluid": "heavy-oil",
                "ok": true,
                "error": "nil"
              },
              {
                "box": 1,
                "fluid": "water",
                "ok": true,
                "error": "nil"
              },
              {
                "box": 1,
                "fluid": "crude-oil",
                "ok": true,
                "error": "nil"
              },
              {
                "box": 1,
                "fluid": "steam",
                "ok": true,
                "error": "nil"
              },
              {
                "box": 1,
                "fluid": "thruster-fuel",
                "ok": true,
                "error": "nil",
                "read": {
                  "name": "thruster-fuel",
                  "amount": 30
                }
              }
            ]
          },
          "read": {
            "label": "R0:thruster",
            "tick": 3261836,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "thruster",
            "type": "thruster",
            "active": true,
            "direct_total": 30,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "thruster-fuel",
                  "amount": 30,
                  "temperature": 25
                },
                "segment_id": 621,
                "segment_error": "621",
                "segment_contents": {}
              },
              {
                "index": 2,
                "direct_error": "nil",
                "segment_id": 622,
                "segment_error": "622",
                "segment_contents": {}
              }
            ]
          }
        },
        {
          "label": "storage-tank",
          "create_ok": true,
          "create_error": "[LuaEntity: storage-tank at [gps=1115.5,105.5,platform-2]]",
          "write": {
            "accepted": true,
            "box": 1,
            "fluid": "heavy-oil",
            "amount": 30,
            "attempts": [
              {
                "box": 1,
                "fluid": "heavy-oil",
                "ok": true,
                "error": "nil",
                "read": {
                  "name": "heavy-oil",
                  "amount": 30
                }
              }
            ]
          },
          "read": {
            "label": "R0:storage-tank",
            "tick": 3261836,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 30,
            "segment_total": 30,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "heavy-oil",
                  "amount": 30,
                  "temperature": 25
                },
                "segment_id": 623,
                "segment_error": "623",
                "segment_contents": {
                  "heavy-oil": 30
                }
              }
            ]
          }
        },
        {
          "label": "pipe",
          "create_ok": true,
          "create_error": "[LuaEntity: pipe at [gps=1119.5,105.5,platform-2]]",
          "write": {
            "accepted": true,
            "box": 1,
            "fluid": "heavy-oil",
            "amount": 30,
            "attempts": [
              {
                "box": 1,
                "fluid": "heavy-oil",
                "ok": true,
                "error": "nil",
                "read": {
                  "name": "heavy-oil",
                  "amount": 30
                }
              }
            ]
          },
          "read": {
            "label": "R0:pipe",
            "tick": 3261836,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 30,
            "segment_total": 30,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "heavy-oil",
                  "amount": 30,
                  "temperature": 25
                },
                "segment_id": 624,
                "segment_error": "624",
                "segment_contents": {
                  "heavy-oil": 30
                }
              }
            ]
          }
        }
      ]
    },
    "R1_active_setup": {
      "success": true,
      "rung": "R1",
      "case": "active_false",
      "setup": {
        "platform": 30,
        "unit_number": 25251,
        "recipe_ok": true,
        "recipe_error": "nil",
        "write": {
          "accepted": true,
          "box": 2,
          "fluid": "heavy-oil",
          "amount": 20,
          "attempts": [
            {
              "box": 1,
              "fluid": "heavy-oil",
              "ok": true,
              "error": "nil"
            },
            {
              "box": 2,
              "fluid": "heavy-oil",
              "ok": true,
              "error": "nil",
              "read": {
                "name": "heavy-oil",
                "amount": 20
              }
            }
          ]
        },
        "read": {
          "label": "r1_active:setup",
          "tick": 3261927,
          "game_paused": false,
          "platform_paused": false,
          "valid": true,
          "name": "chemical-plant",
          "type": "assembling-machine",
          "active": true,
          "direct_total": 20,
          "segment_total": 0,
          "boxes": [
            {
              "index": 1,
              "direct_error": "nil",
              "segment_error": "nil"
            },
            {
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 20,
                "temperature": 25
              },
              "segment_error": "nil"
            },
            {
              "index": 3,
              "direct_error": "nil",
              "segment_error": "nil"
            }
          ]
        }
      }
    },
    "R1_active_set_false": {
      "success": true,
      "rung": "R1",
      "case": "active_false",
      "action": "active=false",
      "read": {
        "label": "R1 active=false immediate",
        "tick": 3262006,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_active_immediate": {
      "success": true,
      "rung": "R1",
      "case": "active_false",
      "action": "immediate reread",
      "read": {
        "label": "R1 active=false immediate reread",
        "tick": 3262072,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_active_plus60": {
      "success": true,
      "rung": "R1",
      "case": "active_false",
      "action": "+60",
      "read": {
        "label": "R1 active=false +60",
        "tick": 3262241,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_active_set_true": {
      "success": true,
      "rung": "R1",
      "case": "active_false",
      "action": "active=true",
      "read": {
        "label": "R1 active=true immediate",
        "tick": 3262316,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_active_true_plus60": {
      "success": true,
      "rung": "R1",
      "case": "active_false",
      "action": "active=true +60",
      "read": {
        "label": "R1 active=true +60",
        "tick": 3262456,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_frozen_setup": {
      "success": true,
      "rung": "R1",
      "case": "frozen_true",
      "setup": {
        "platform": 31,
        "unit_number": 25253,
        "recipe_ok": true,
        "recipe_error": "nil",
        "write": {
          "accepted": true,
          "box": 2,
          "fluid": "heavy-oil",
          "amount": 20,
          "attempts": [
            {
              "box": 1,
              "fluid": "heavy-oil",
              "ok": true,
              "error": "nil"
            },
            {
              "box": 2,
              "fluid": "heavy-oil",
              "ok": true,
              "error": "nil",
              "read": {
                "name": "heavy-oil",
                "amount": 20
              }
            }
          ]
        },
        "read": {
          "label": "r1_frozen:setup",
          "tick": 3262534,
          "game_paused": false,
          "platform_paused": false,
          "valid": true,
          "name": "chemical-plant",
          "type": "assembling-machine",
          "active": true,
          "direct_total": 20,
          "segment_total": 0,
          "boxes": [
            {
              "index": 1,
              "direct_error": "nil",
              "segment_error": "nil"
            },
            {
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 20,
                "temperature": 25
              },
              "segment_error": "nil"
            },
            {
              "index": 3,
              "direct_error": "nil",
              "segment_error": "nil"
            }
          ]
        }
      }
    },
    "R1_frozen_set_true": {
      "success": false,
      "error": "LuaEntity::frozen is read only.",
      "rung": "R1",
      "case": "frozen_true",
      "action": "frozen=true",
      "read": {
        "label": "R1 frozen=true immediate",
        "tick": 3262596,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_frozen_plus60": {
      "success": true,
      "rung": "R1",
      "case": "frozen_true",
      "action": "frozen +60",
      "read": {
        "label": "R1 frozen=true +60",
        "tick": 3262720,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_frozen_set_false": {
      "success": false,
      "error": "LuaEntity::frozen is read only.",
      "rung": "R1",
      "case": "frozen_true",
      "action": "frozen=false",
      "read": {
        "label": "R1 frozen=false immediate",
        "tick": 3262792,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_frozen_false_plus60": {
      "success": true,
      "rung": "R1",
      "case": "frozen_true",
      "action": "unfrozen +60",
      "read": {
        "label": "R1 frozen=false +60",
        "tick": 3262923,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R2": {
      "success": true,
      "rung": "R2",
      "platform": 32,
      "recipe_ok": true,
      "recipe_error": "nil",
      "before": {
        "label": "R2 before write inactive",
        "tick": 3263072,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 0,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      },
      "write": {
        "accepted": true,
        "box": 2,
        "fluid": "heavy-oil",
        "amount": 20,
        "attempts": [
          {
            "box": 1,
            "fluid": "heavy-oil",
            "ok": true,
            "error": "nil"
          },
          {
            "box": 2,
            "fluid": "heavy-oil",
            "ok": true,
            "error": "nil",
            "read": {
              "name": "heavy-oil",
              "amount": 20
            }
          }
        ]
      },
      "after_write": {
        "label": "R2 after write inactive",
        "tick": 3263072,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      },
      "after_active": {
        "label": "R2 after active=true",
        "tick": 3263072,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R3_setup": {
      "success": true,
      "rung": "R3",
      "setup": {
        "platform": 33,
        "unit_number": 25257,
        "recipe_ok": true,
        "recipe_error": "nil",
        "write": {
          "accepted": true,
          "box": 2,
          "fluid": "heavy-oil",
          "amount": 20,
          "attempts": [
            {
              "box": 1,
              "fluid": "heavy-oil",
              "ok": true,
              "error": "nil"
            },
            {
              "box": 2,
              "fluid": "heavy-oil",
              "ok": true,
              "error": "nil",
              "read": {
                "name": "heavy-oil",
                "amount": 20
              }
            }
          ]
        },
        "read": {
          "label": "r3:setup",
          "tick": 3263270,
          "game_paused": false,
          "platform_paused": true,
          "valid": true,
          "name": "chemical-plant",
          "type": "assembling-machine",
          "active": true,
          "direct_total": 20,
          "segment_total": 0,
          "boxes": [
            {
              "index": 1,
              "direct_error": "nil",
              "segment_error": "nil"
            },
            {
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 20,
                "temperature": 25
              },
              "segment_error": "nil"
            },
            {
              "index": 3,
              "direct_error": "nil",
              "segment_error": "nil"
            }
          ]
        }
      }
    },
    "R3_plus600": {
      "success": true,
      "rung": "R3",
      "action": "platform paused +600",
      "read": {
        "label": "R3 paused +600",
        "tick": 3263518,
        "game_paused": false,
        "platform_paused": true,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R3_unpause": {
      "success": true,
      "rung": "R3",
      "action": "platform unpaused",
      "read": {
        "label": "R3 after unpause",
        "tick": 3263618,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    }
  },
  "errors": [],
  "initial_reset": {
    "success": true,
    "deleted": {},
    "zero_storage": true,
    "leftovers": {},
    "zero_surfaces": true,
    "game_paused": false
  },
  "install": {
    "success": true,
    "base": "2.0.77",
    "tick": 3261709
  },
  "final_reset": {
    "success": true,
    "deleted": [
      {
        "name": "fluid-lab-r0-3261836",
        "ok": true,
        "error": "nil"
      },
      {
        "name": "fluid-lab-r1_active-3261927",
        "ok": true,
        "error": "nil"
      },
      {
        "name": "fluid-lab-r1_frozen-3262534",
        "ok": true,
        "error": "nil"
      },
      {
        "name": "fluid-lab-r2-3263072",
        "ok": true,
        "error": "nil"
      },
      {
        "name": "fluid-lab-r3-3263270",
        "ok": true,
        "error": "nil"
      }
    ],
    "zero_storage": true,
    "leftovers": [
      "fluid-lab-r0-3261836",
      "fluid-lab-r1_active-3261927",
      "fluid-lab-r1_frozen-3262534",
      "fluid-lab-r2-3263072",
      "fluid-lab-r3-3263270"
    ],
    "zero_surfaces": false,
    "game_paused": false
  },
  "finished": "2026-07-06T17:46:32.528Z"
}
```


## 2026-07-06T17:50:13.891Z - R0-R3 fluid-lab run (run-r0-r3.mjs)

```json
{
  "script": "tests/fluid-lab/run-r0-r3.mjs",
  "instance": "clusterio-host-1-instance-1",
  "controller": "surface-export-controller",
  "started": "2026-07-06T17:49:35.260Z",
  "rungs": {
    "R0": {
      "success": true,
      "rung": "R0",
      "platform": 34,
      "rows": [
        {
          "label": "chemical-plant",
          "create_ok": true,
          "create_error": "[LuaEntity: chemical-plant at [gps=1290.5,100.5,platform-2]]",
          "recipe_ok": true,
          "recipe_error": "nil",
          "write": {
            "accepted": true,
            "box": 1,
            "fluid": "water",
            "amount": 20,
            "attempts": [
              {
                "box": 1,
                "fluid": "heavy-oil",
                "ok": true,
                "error": "nil"
              },
              {
                "box": 1,
                "fluid": "water",
                "ok": true,
                "error": "nil",
                "read": {
                  "name": "water",
                  "amount": 20
                }
              }
            ]
          },
          "read": {
            "label": "R0:chemical-plant",
            "tick": 3274064,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "chemical-plant",
            "type": "assembling-machine",
            "active": true,
            "direct_total": 20,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 20,
                  "temperature": 25
                },
                "segment_error": "nil"
              },
              {
                "index": 2,
                "direct_error": "nil",
                "segment_error": "nil"
              },
              {
                "index": 3,
                "direct_error": "nil",
                "segment_error": "nil"
              }
            ]
          }
        },
        {
          "label": "pump",
          "create_ok": true,
          "create_error": "[LuaEntity: pump at [gps=1293.5,100.0,platform-2]]",
          "write": {
            "accepted": true,
            "box": 1,
            "fluid": "heavy-oil",
            "amount": 30,
            "attempts": [
              {
                "box": 1,
                "fluid": "heavy-oil",
                "ok": true,
                "error": "nil",
                "read": {
                  "name": "heavy-oil",
                  "amount": 30
                }
              }
            ]
          },
          "read": {
            "label": "R0:pump",
            "tick": 3274064,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "pump",
            "type": "pump",
            "active": true,
            "direct_total": 30,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "heavy-oil",
                  "amount": 30,
                  "temperature": 25
                },
                "segment_error": "nil"
              }
            ]
          }
        },
        {
          "label": "boiler",
          "create_ok": true,
          "create_error": "[LuaEntity: boiler at [gps=1296.5,100.0,platform-2]]",
          "write": {
            "accepted": true,
            "box": 1,
            "fluid": "water",
            "amount": 30,
            "attempts": [
              {
                "box": 1,
                "fluid": "heavy-oil",
                "ok": true,
                "error": "nil"
              },
              {
                "box": 1,
                "fluid": "water",
                "ok": true,
                "error": "nil",
                "read": {
                  "name": "water",
                  "amount": 30
                }
              }
            ]
          },
          "read": {
            "label": "R0:boiler",
            "tick": 3274064,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "boiler",
            "type": "boiler",
            "active": true,
            "direct_total": 30,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 30,
                  "temperature": 25
                },
                "segment_id": 625,
                "segment_error": "625",
                "segment_contents": {}
              },
              {
                "index": 2,
                "direct_error": "nil",
                "segment_error": "nil"
              }
            ]
          }
        },
        {
          "label": "thruster",
          "create_ok": true,
          "create_error": "[LuaEntity: thruster at [gps=1299.0,100.5,platform-2]]",
          "write": {
            "accepted": true,
            "box": 1,
            "fluid": "thruster-fuel",
            "amount": 30,
            "attempts": [
              {
                "box": 1,
                "fluid": "heavy-oil",
                "ok": true,
                "error": "nil"
              },
              {
                "box": 1,
                "fluid": "water",
                "ok": true,
                "error": "nil"
              },
              {
                "box": 1,
                "fluid": "crude-oil",
                "ok": true,
                "error": "nil"
              },
              {
                "box": 1,
                "fluid": "steam",
                "ok": true,
                "error": "nil"
              },
              {
                "box": 1,
                "fluid": "thruster-fuel",
                "ok": true,
                "error": "nil",
                "read": {
                  "name": "thruster-fuel",
                  "amount": 30
                }
              }
            ]
          },
          "read": {
            "label": "R0:thruster",
            "tick": 3274064,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "thruster",
            "type": "thruster",
            "active": true,
            "direct_total": 30,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "thruster-fuel",
                  "amount": 30,
                  "temperature": 25
                },
                "segment_id": 626,
                "segment_error": "626",
                "segment_contents": {}
              },
              {
                "index": 2,
                "direct_error": "nil",
                "segment_id": 627,
                "segment_error": "627",
                "segment_contents": {}
              }
            ]
          }
        },
        {
          "label": "storage-tank",
          "create_ok": true,
          "create_error": "[LuaEntity: storage-tank at [gps=1290.5,105.5,platform-2]]",
          "write": {
            "accepted": true,
            "box": 1,
            "fluid": "heavy-oil",
            "amount": 30,
            "attempts": [
              {
                "box": 1,
                "fluid": "heavy-oil",
                "ok": true,
                "error": "nil",
                "read": {
                  "name": "heavy-oil",
                  "amount": 30
                }
              }
            ]
          },
          "read": {
            "label": "R0:storage-tank",
            "tick": 3274064,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 30,
            "segment_total": 30,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "heavy-oil",
                  "amount": 30,
                  "temperature": 25
                },
                "segment_id": 628,
                "segment_error": "628",
                "segment_contents": {
                  "heavy-oil": 30
                }
              }
            ]
          }
        },
        {
          "label": "pipe",
          "create_ok": true,
          "create_error": "[LuaEntity: pipe at [gps=1294.5,105.5,platform-2]]",
          "write": {
            "accepted": true,
            "box": 1,
            "fluid": "heavy-oil",
            "amount": 30,
            "attempts": [
              {
                "box": 1,
                "fluid": "heavy-oil",
                "ok": true,
                "error": "nil",
                "read": {
                  "name": "heavy-oil",
                  "amount": 30
                }
              }
            ]
          },
          "read": {
            "label": "R0:pipe",
            "tick": 3274064,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 30,
            "segment_total": 30,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "heavy-oil",
                  "amount": 30,
                  "temperature": 25
                },
                "segment_id": 629,
                "segment_error": "629",
                "segment_contents": {
                  "heavy-oil": 30
                }
              }
            ]
          }
        }
      ]
    },
    "R1_active_setup": {
      "success": true,
      "rung": "R1",
      "case": "active_false",
      "setup": {
        "platform": 35,
        "unit_number": 25266,
        "recipe_ok": true,
        "recipe_error": "nil",
        "write": {
          "accepted": true,
          "box": 2,
          "fluid": "heavy-oil",
          "amount": 20,
          "attempts": [
            {
              "box": 1,
              "fluid": "heavy-oil",
              "ok": true,
              "error": "nil"
            },
            {
              "box": 2,
              "fluid": "heavy-oil",
              "ok": true,
              "error": "nil",
              "read": {
                "name": "heavy-oil",
                "amount": 20
              }
            }
          ]
        },
        "read": {
          "label": "r1_active:setup",
          "tick": 3274146,
          "game_paused": false,
          "platform_paused": false,
          "valid": true,
          "name": "chemical-plant",
          "type": "assembling-machine",
          "active": true,
          "direct_total": 20,
          "segment_total": 0,
          "boxes": [
            {
              "index": 1,
              "direct_error": "nil",
              "segment_error": "nil"
            },
            {
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 20,
                "temperature": 25
              },
              "segment_error": "nil"
            },
            {
              "index": 3,
              "direct_error": "nil",
              "segment_error": "nil"
            }
          ]
        }
      }
    },
    "R1_active_set_false": {
      "success": true,
      "rung": "R1",
      "case": "active_false",
      "action": "active=false",
      "read": {
        "label": "R1 active=false immediate",
        "tick": 3274215,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_active_immediate": {
      "success": true,
      "rung": "R1",
      "case": "active_false",
      "action": "immediate reread",
      "read": {
        "label": "R1 active=false immediate reread",
        "tick": 3274291,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_active_plus60": {
      "success": true,
      "rung": "R1",
      "case": "active_false",
      "action": "+60",
      "read": {
        "label": "R1 active=false +60",
        "tick": 3274450,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_active_set_true": {
      "success": true,
      "rung": "R1",
      "case": "active_false",
      "action": "active=true",
      "read": {
        "label": "R1 active=true immediate",
        "tick": 3274530,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_active_true_plus60": {
      "success": true,
      "rung": "R1",
      "case": "active_false",
      "action": "active=true +60",
      "read": {
        "label": "R1 active=true +60",
        "tick": 3274707,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_frozen_setup": {
      "success": true,
      "rung": "R1",
      "case": "frozen_true",
      "setup": {
        "platform": 36,
        "unit_number": 25268,
        "recipe_ok": true,
        "recipe_error": "nil",
        "write": {
          "accepted": true,
          "box": 2,
          "fluid": "heavy-oil",
          "amount": 20,
          "attempts": [
            {
              "box": 1,
              "fluid": "heavy-oil",
              "ok": true,
              "error": "nil"
            },
            {
              "box": 2,
              "fluid": "heavy-oil",
              "ok": true,
              "error": "nil",
              "read": {
                "name": "heavy-oil",
                "amount": 20
              }
            }
          ]
        },
        "read": {
          "label": "r1_frozen:setup",
          "tick": 3274781,
          "game_paused": false,
          "platform_paused": false,
          "valid": true,
          "name": "chemical-plant",
          "type": "assembling-machine",
          "active": true,
          "direct_total": 20,
          "segment_total": 0,
          "boxes": [
            {
              "index": 1,
              "direct_error": "nil",
              "segment_error": "nil"
            },
            {
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 20,
                "temperature": 25
              },
              "segment_error": "nil"
            },
            {
              "index": 3,
              "direct_error": "nil",
              "segment_error": "nil"
            }
          ]
        }
      }
    },
    "R1_frozen_set_true": {
      "success": false,
      "error": "LuaEntity::frozen is read only.",
      "rung": "R1",
      "case": "frozen_true",
      "action": "frozen=true",
      "read": {
        "label": "R1 frozen=true immediate",
        "tick": 3274860,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_frozen_plus60": {
      "success": true,
      "rung": "R1",
      "case": "frozen_true",
      "action": "frozen +60",
      "read": {
        "label": "R1 frozen=true +60",
        "tick": 3275020,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_frozen_set_false": {
      "success": false,
      "error": "LuaEntity::frozen is read only.",
      "rung": "R1",
      "case": "frozen_true",
      "action": "frozen=false",
      "read": {
        "label": "R1 frozen=false immediate",
        "tick": 3275089,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R1_frozen_false_plus60": {
      "success": true,
      "rung": "R1",
      "case": "frozen_true",
      "action": "unfrozen +60",
      "read": {
        "label": "R1 frozen=false +60",
        "tick": 3275206,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R2": {
      "success": true,
      "rung": "R2",
      "platform": 37,
      "recipe_ok": true,
      "recipe_error": "nil",
      "before": {
        "label": "R2 before write inactive",
        "tick": 3275271,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 0,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      },
      "write": {
        "accepted": true,
        "box": 2,
        "fluid": "heavy-oil",
        "amount": 20,
        "attempts": [
          {
            "box": 1,
            "fluid": "heavy-oil",
            "ok": true,
            "error": "nil"
          },
          {
            "box": 2,
            "fluid": "heavy-oil",
            "ok": true,
            "error": "nil",
            "read": {
              "name": "heavy-oil",
              "amount": 20
            }
          }
        ]
      },
      "after_write": {
        "label": "R2 after write inactive",
        "tick": 3275271,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      },
      "after_active": {
        "label": "R2 after active=true",
        "tick": 3275271,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R3_setup": {
      "success": true,
      "rung": "R3",
      "setup": {
        "platform": 38,
        "unit_number": 25272,
        "recipe_ok": true,
        "recipe_error": "nil",
        "write": {
          "accepted": true,
          "box": 2,
          "fluid": "heavy-oil",
          "amount": 20,
          "attempts": [
            {
              "box": 1,
              "fluid": "heavy-oil",
              "ok": true,
              "error": "nil"
            },
            {
              "box": 2,
              "fluid": "heavy-oil",
              "ok": true,
              "error": "nil",
              "read": {
                "name": "heavy-oil",
                "amount": 20
              }
            }
          ]
        },
        "read": {
          "label": "r3:setup",
          "tick": 3275340,
          "game_paused": false,
          "platform_paused": true,
          "valid": true,
          "name": "chemical-plant",
          "type": "assembling-machine",
          "active": true,
          "direct_total": 20,
          "segment_total": 0,
          "boxes": [
            {
              "index": 1,
              "direct_error": "nil",
              "segment_error": "nil"
            },
            {
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 20,
                "temperature": 25
              },
              "segment_error": "nil"
            },
            {
              "index": 3,
              "direct_error": "nil",
              "segment_error": "nil"
            }
          ]
        }
      }
    },
    "R3_plus600": {
      "success": true,
      "rung": "R3",
      "action": "platform paused +600",
      "read": {
        "label": "R3 paused +600",
        "tick": 3275512,
        "game_paused": false,
        "platform_paused": true,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    },
    "R3_unpause": {
      "success": true,
      "rung": "R3",
      "action": "platform unpaused",
      "read": {
        "label": "R3 after unpause",
        "tick": 3275580,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct_error": "nil",
            "segment_error": "nil"
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            },
            "segment_error": "nil"
          },
          {
            "index": 3,
            "direct_error": "nil",
            "segment_error": "nil"
          }
        ]
      }
    }
  },
  "errors": [],
  "initial_reset": {
    "success": true,
    "deleted": {
      "success": true,
      "deleted": {},
      "zero_storage": true,
      "leftovers": {},
      "zero_surfaces": true,
      "game_paused": false
    },
    "check": {
      "success": true,
      "zero_storage": true,
      "leftovers": {},
      "zero_surfaces": true,
      "game_paused": false
    },
    "zero_storage": true,
    "zero_surfaces": true,
    "leftovers": {},
    "game_paused": false
  },
  "install": {
    "success": true,
    "base": "2.0.77",
    "tick": 3274000
  },
  "final_reset": {
    "success": true,
    "deleted": {
      "success": true,
      "deleted": [
        {
          "name": "fluid-lab-r0-3274064",
          "ok": true,
          "error": "nil"
        },
        {
          "name": "fluid-lab-r1_active-3274146",
          "ok": true,
          "error": "nil"
        },
        {
          "name": "fluid-lab-r1_frozen-3274781",
          "ok": true,
          "error": "nil"
        },
        {
          "name": "fluid-lab-r2-3275271",
          "ok": true,
          "error": "nil"
        },
        {
          "name": "fluid-lab-r3-3275340",
          "ok": true,
          "error": "nil"
        }
      ],
      "zero_storage": true,
      "leftovers": [
        "fluid-lab-r0-3274064",
        "fluid-lab-r1_active-3274146",
        "fluid-lab-r1_frozen-3274781",
        "fluid-lab-r2-3275271",
        "fluid-lab-r3-3275340"
      ],
      "zero_surfaces": false,
      "game_paused": false
    },
    "check": {
      "success": true,
      "zero_storage": true,
      "leftovers": {},
      "zero_surfaces": true,
      "game_paused": false
    },
    "zero_storage": true,
    "zero_surfaces": true,
    "leftovers": {},
    "game_paused": false
  },
  "finished": "2026-07-06T17:50:13.891Z"
}
```

## 2026-07-06 — R0-R3 conclusion (2.0.77, run-r0-r3.mjs)

- R0: active meters were logged for chemical plant, pump, boiler, thruster, storage tank, and pipe. Tank/pipe segment contents agreed with direct reads; several machine/prototype fluidboxes reported direct fluid while `get_fluid_segment_contents(i)` was empty or `get_fluid_segment_id(i)` was nil, so direct proxy reads remain required for isolated/local buffers.
- R1 active=false: chemical plant `heavy-oil-cracking` input was explicitly enabled and heavy-oil write was read back before proceeding. The isolated heavy-oil buffer stayed at 20 immediately after `active=false`, after +60 ticks, after `active=true`, and after another +60 ticks. This does not support loss-at-deactivation or wipe-at-rejoin for this isolated buffer on 2.0.77.
- R1 frozen=true: direct `LuaEntity.frozen` writes failed (`LuaEntity::frozen is read only.`), so the frozen half of R1 is inconclusive via this lab method.
- R2: writing 20 heavy oil while the plant was inactive read back immediately and survived immediate reactivation.
- R3: paused platform with the plant left active preserved the 20 heavy-oil buffer over +600 ticks and after unpause. This supports the simpler destination-hold design candidate: keep fluid-bearing entities active, rely on `platform.paused` + hidden state for hold behavior, and prove no unpause race, rather than defaulting to snapshot/reinject.
- Cleanup: first run recorded a same-command cleanup-check failure; reset action was added. Clean rerun ended with `zero_storage=true`, `zero_surfaces=true`, `game_paused=false`.


## 2026-07-06T18:08:08.161Z - R6-R8 fluid-lab run (run-r6-r8.mjs)

```json
{
  "script": "tests/fluid-lab/run-r6-r8.mjs",
  "instance": "clusterio-host-1-instance-1",
  "controller": "surface-export-controller",
  "started": "2026-07-06T18:07:35.322Z",
  "rungs": {
    "R6_setup": {
      "success": true,
      "rung": "R6",
      "swallowed_set_recipe": {
        "ok": true,
        "error": "nil"
      },
      "write_box1": {
        "ok": true,
        "error": "nil"
      },
      "read": {
        "label": "R6 immediate after recipe-less write",
        "tick": 3334067,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          }
        ]
      }
    },
    "R6_immediate_reread": {
      "success": true,
      "rung": "R6",
      "action": "immediate reread",
      "read": {
        "label": "R6 immediate reread",
        "tick": 3334151,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          }
        ]
      }
    },
    "R6_plus60": {
      "success": true,
      "rung": "R6",
      "action": "+60 no hold",
      "read": {
        "label": "R6 +60",
        "tick": 3334269,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          }
        ]
      }
    },
    "R6_plus600": {
      "success": true,
      "rung": "R6",
      "action": "+600 no hold",
      "read": {
        "label": "R6 +600",
        "tick": 3334410,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          }
        ]
      }
    },
    "R6b_setup": {
      "success": true,
      "rung": "R6b",
      "platform": 40,
      "recipe_ok": true,
      "recipe_error": "nil",
      "write": {
        "accepted": true,
        "box": 2,
        "amount": 20,
        "attempts": [
          {
            "box": 1,
            "ok": true
          },
          {
            "box": 2,
            "ok": true,
            "read": {
              "name": "heavy-oil",
              "amount": 20
            }
          }
        ]
      },
      "read": {
        "label": "R6b setup",
        "tick": 3334493,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "R6b_stage": {
      "success": true,
      "rung": "R6b",
      "action": "real destination_hold stage",
      "remote": {
        "success": true,
        "hold": {
          "transfer_id": "fluid-lab-r6b-3334597",
          "force_name": "player",
          "platform_index": 40,
          "platform_name": "fluid-lab-r6b-3334493",
          "surface_index": 8,
          "original_hidden": false,
          "original_paused": false,
          "active_states": {
            "25275": false,
            "25276": true
          },
          "deactivated_count": 1,
          "held_tick": 3334597
        }
      },
      "read": {
        "label": "R6b after stage",
        "tick": 3334597,
        "game_paused": false,
        "platform_paused": true,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "R6b_staged_plus600": {
      "success": true,
      "rung": "R6b",
      "action": "stage +600",
      "read": {
        "label": "R6b stage +600",
        "tick": 3334818,
        "game_paused": false,
        "platform_paused": true,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "R6b_go_live": {
      "success": true,
      "rung": "R6b",
      "action": "real destination_hold go_live",
      "remote": {
        "success": true,
        "result": {
          "transfer_id": "fluid-lab-r6b-3334597",
          "platform_name": "fluid-lab-r6b-3334493",
          "platform_index": 40,
          "surface_index": 8,
          "restored_count": 1,
          "kept_inactive_count": 1
        }
      },
      "read": {
        "label": "R6b after go_live",
        "tick": 3334916,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "R7_setup": {
      "success": false,
      "rung": "R7",
      "platform": 41,
      "write": {
        "accepted": true,
        "box": 2,
        "amount": 20,
        "attempts": [
          {
            "box": 1,
            "ok": true
          },
          {
            "box": 2,
            "ok": true,
            "read": {
              "name": "heavy-oil",
              "amount": 20
            }
          }
        ]
      },
      "segmented": false,
      "plant": {
        "label": "R7 setup",
        "tick": 3335022,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      },
      "tank": {
        "label": "R7 tank setup",
        "tick": 3335022,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "storage-tank",
        "type": "storage-tank",
        "direct_total": 0,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1,
            "segment_id": 633,
            "segment_contents": {}
          }
        ]
      },
      "pipe_count": 12
    },
    "R7_skipped": {
      "success": false,
      "reason": "could not create a segment-connected heavy-oil chemical-plant fluidbox; see R7_setup"
    },
    "R8": {
      "success": true,
      "rung": "R8",
      "frozenAssignments": [],
      "note": "rg -n \"\\\\.frozen\\\\s*=\" docker/seed-data/external_plugins/surface_export/module returned no sites",
      "importCompletionMentionsFrozen": true
    }
  },
  "errors": [],
  "initial_reset": {
    "success": true,
    "deleted": {
      "success": true,
      "deleted": {},
      "game_paused": false
    },
    "check": {
      "success": true,
      "zero_storage": true,
      "zero_surfaces": true,
      "leftovers": {},
      "game_paused": false
    },
    "zero_storage": true,
    "zero_surfaces": true,
    "leftovers": {},
    "game_paused": false
  },
  "install": {
    "success": true,
    "base": "2.0.77",
    "tick": 3333995
  },
  "restore_recipe_and_reset": {
    "success": true,
    "restored_solid_fuel_enabled": true
  },
  "final_reset": {
    "success": true,
    "deleted": {
      "success": true,
      "deleted": [
        {
          "name": "fluid-lab-r6-3334067",
          "ok": true
        },
        {
          "name": "fluid-lab-r6b-3334493",
          "ok": true
        },
        {
          "name": "fluid-lab-r7-3335022",
          "ok": true
        }
      ],
      "game_paused": false
    },
    "check": {
      "success": true,
      "zero_storage": true,
      "zero_surfaces": true,
      "leftovers": {},
      "game_paused": false
    },
    "zero_storage": true,
    "zero_surfaces": true,
    "leftovers": {},
    "game_paused": false
  },
  "finished": "2026-07-06T18:08:08.161Z"
}
```

## 2026-07-06 — R6-R8 conclusion (2.0.77, run-r6-r8.mjs)

- R6: faithfully recreated the recipe-disabled fixture path locally (`solid-fuel-from-heavy-oil.enabled=false`, pcall-swallowed `set_recipe`, box-1 heavy-oil write). The recipe-less plant read back 20 heavy oil immediately, on immediate reread, after +60 ticks, and after +600 ticks with no hold. This does **not** reproduce the CI evaporation locally and does not solve the mystery as fixture-only by itself.
- R6b: with `heavy-oil-cracking` enabled and write asserted, the real `surface_export.destination_hold_json` remote preserved 20 heavy oil through `stage`, staged +600, and `go_live` on the current loaded primitive. This exonerates the local hold path for the deterministic isolated-buffer fixture.
- R7: first attempt at `plant piped to tank` failed to create a segment-connected chemical-plant heavy-oil box. The plant heavy-oil box stayed `get_fluid_segment_id == nil`; adjacent pipe/tank had their own empty segments. A follow-up prototype-position/brute-force probe also failed to make the chemical-plant input report a segment id. R7 remains **not answered** for segment-connected members; the premise may need a different entity/topology (for example pump/tank) or a better prototype-derived fixture.
- R8: `rg -n "\.frozen\s*=" docker/seed-data/external_plugins/surface_export/module` found no production assignment sites. Direct lab writes to `LuaEntity.frozen` failed as read-only on 2.0.77; promoted to api-notes.
- Cleanup: R6-R8 run ended with `zero_storage=true`, `zero_surfaces=true`, `game_paused=false`, and restored `solid-fuel-from-heavy-oil.enabled` to its prior value.

Decision status: no primitive design change yet. R6 did not reproduce the CI loss; R6b preserved via the real hold remote; R7 is still open because the segment-connected topology was not successfully armed.


## 2026-07-06T18:28:13.459Z - R9 fluid-lab run (run-r9.mjs)

```json
{
  "script": "tests/fluid-lab/run-r9.mjs",
  "started": "2026-07-06T18:27:53.275Z",
  "rungs": {
    "setup": {
      "success": true,
      "rung": "R9",
      "action": "fixture under paused game",
      "recipe_ok": true,
      "recipe_error": "nil",
      "attempts": [
        {
          "box": 1,
          "ok": true,
          "error": "nil"
        },
        {
          "box": 2,
          "ok": true,
          "error": "nil",
          "read": {
            "name": "heavy-oil",
            "amount": 20
          }
        }
      ],
      "read": {
        "label": "R9 pre-read",
        "tick": 3401632,
        "game_paused": true,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "stage": {
      "success": true,
      "rung": "R9",
      "action": "real stage",
      "remote": {
        "success": true,
        "hold": {
          "transfer_id": "fluid-lab-r9-3401632",
          "force_name": "player",
          "platform_index": 63,
          "platform_name": "fluid-lab-r9-3401632",
          "surface_index": 7,
          "original_hidden": false,
          "original_paused": false,
          "active_states": {
            "25356": false,
            "25357": true
          },
          "deactivated_count": 1,
          "held_tick": 3401632
        }
      },
      "read": {
        "label": "R9 after stage",
        "tick": 3401632,
        "game_paused": true,
        "platform_paused": true,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "staged_plus600": {
      "success": true,
      "rung": "R9",
      "action": "stage +600 ensure-paused",
      "read": {
        "label": "R9 stage +600",
        "tick": 3401710,
        "game_paused": false,
        "platform_paused": true,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "go_live": {
      "success": true,
      "rung": "R9",
      "action": "real go_live",
      "remote": {
        "success": true,
        "result": {
          "transfer_id": "fluid-lab-r9-3401632",
          "platform_name": "fluid-lab-r9-3401632",
          "platform_index": 63,
          "surface_index": 7,
          "restored_count": 1,
          "kept_inactive_count": 1
        }
      },
      "read": {
        "label": "R9 after go_live",
        "tick": 3401770,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "go_live_plus60": {
      "success": true,
      "rung": "R9",
      "action": "go_live +60 ensure-paused",
      "read": {
        "label": "R9 go_live +60",
        "tick": 3401902,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "unpaused_plus120": {
      "success": true,
      "rung": "R9",
      "action": "unpaused +120 staleness check",
      "read": {
        "label": "R9 unpaused +120",
        "tick": 3402129,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
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
    "tick": 3401550,
    "game_paused": false
  },
  "final_reset": {
    "success": true,
    "deleted": [
      {
        "name": "fluid-lab-r9-3401632",
        "ok": true
      }
    ],
    "zero_storage": true,
    "zero_surfaces": false,
    "leftovers": [
      "fluid-lab-r9-3401632"
    ],
    "game_paused": false
  },
  "finished": "2026-07-06T18:28:13.459Z"
}
```


## 2026-07-06T18:29:48.665Z - R9 fluid-lab run (run-r9.mjs)

```json
{
  "script": "tests/fluid-lab/run-r9.mjs",
  "started": "2026-07-06T18:29:21.811Z",
  "rungs": {
    "setup": {
      "success": true,
      "rung": "R9",
      "action": "fixture under paused game",
      "recipe_ok": true,
      "recipe_error": "nil",
      "attempts": [
        {
          "box": 1,
          "ok": true,
          "error": "nil"
        },
        {
          "box": 2,
          "ok": true,
          "error": "nil",
          "read": {
            "name": "heavy-oil",
            "amount": 20
          }
        }
      ],
      "read": {
        "label": "R9 pre-read",
        "tick": 3406584,
        "game_paused": true,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "stage": {
      "success": true,
      "rung": "R9",
      "action": "real stage",
      "remote": {
        "success": true,
        "hold": {
          "transfer_id": "fluid-lab-r9-3406584",
          "force_name": "player",
          "platform_index": 64,
          "platform_name": "fluid-lab-r9-3406584",
          "surface_index": 7,
          "original_hidden": false,
          "original_paused": false,
          "active_states": {
            "25358": false,
            "25359": true
          },
          "deactivated_count": 1,
          "held_tick": 3406584
        }
      },
      "read": {
        "label": "R9 after stage",
        "tick": 3406584,
        "game_paused": true,
        "platform_paused": true,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "staged_plus600": {
      "success": true,
      "rung": "R9",
      "action": "stage +600 ensure-paused",
      "read": {
        "label": "R9 stage +600",
        "tick": 3406661,
        "game_paused": false,
        "platform_paused": true,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "go_live": {
      "success": true,
      "rung": "R9",
      "action": "real go_live",
      "remote": {
        "success": true,
        "result": {
          "transfer_id": "fluid-lab-r9-3406584",
          "platform_name": "fluid-lab-r9-3406584",
          "platform_index": 64,
          "surface_index": 7,
          "restored_count": 1,
          "kept_inactive_count": 1
        }
      },
      "read": {
        "label": "R9 after go_live",
        "tick": 3406739,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "go_live_plus60": {
      "success": true,
      "rung": "R9",
      "action": "go_live +60 ensure-paused",
      "read": {
        "label": "R9 go_live +60",
        "tick": 3406874,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "unpaused_plus120": {
      "success": true,
      "rung": "R9",
      "action": "unpaused +120 staleness check",
      "read": {
        "label": "R9 unpaused +120",
        "tick": 3407128,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
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
      "zero_storage": true,
      "zero_surfaces": true,
      "leftovers": {},
      "game_paused": false,
      "tick": 3406449
    },
    "tick": 3406449
  },
  "install": {
    "success": true,
    "tick": 3406517,
    "game_paused": false
  },
  "final_reset": {
    "success": true,
    "deleted": [
      {
        "name": "fluid-lab-r9-3406584",
        "ok": true
      }
    ],
    "zero_storage": true,
    "zero_surfaces": true,
    "leftovers": {},
    "game_paused": false,
    "post_tick": {
      "success": true,
      "zero_storage": true,
      "zero_surfaces": true,
      "leftovers": {},
      "game_paused": false,
      "tick": 3407372
    },
    "tick": 3407372
  },
  "finished": "2026-07-06T18:29:48.665Z"
}
```


## 2026-07-06T18:30:51.378Z - R9 fluid-lab run (run-r9.mjs)

```json
{
  "script": "tests/fluid-lab/run-r9.mjs",
  "started": "2026-07-06T18:30:21.809Z",
  "rungs": {
    "setup": {
      "success": true,
      "rung": "R9",
      "action": "fixture under paused game",
      "recipe_ok": true,
      "recipe_error": "nil",
      "attempts": [
        {
          "box": 1,
          "ok": true,
          "error": "nil"
        },
        {
          "box": 2,
          "ok": true,
          "error": "nil",
          "read": {
            "name": "heavy-oil",
            "amount": 20
          }
        }
      ],
      "read": {
        "label": "R9 pre-read",
        "tick": 3409597,
        "game_paused": true,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "stage": {
      "success": true,
      "rung": "R9",
      "action": "real stage",
      "remote": {
        "success": true,
        "hold": {
          "transfer_id": "fluid-lab-r9-3409597",
          "force_name": "player",
          "platform_index": 65,
          "platform_name": "fluid-lab-r9-3409597",
          "surface_index": 7,
          "original_hidden": false,
          "original_paused": false,
          "active_states": {
            "25360": false,
            "25361": true
          },
          "deactivated_count": 1,
          "held_tick": 3409597
        }
      },
      "read": {
        "label": "R9 after stage",
        "tick": 3409597,
        "game_paused": true,
        "platform_paused": true,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "staged_plus600": {
      "success": true,
      "rung": "R9",
      "action": "stage +600 ensure-paused",
      "read": {
        "label": "R9 stage +600",
        "tick": 3409667,
        "game_paused": true,
        "platform_paused": true,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "go_live": {
      "success": true,
      "rung": "R9",
      "action": "real go_live",
      "remote": {
        "success": true,
        "result": {
          "transfer_id": "fluid-lab-r9-3409597",
          "platform_name": "fluid-lab-r9-3409597",
          "platform_index": 65,
          "surface_index": 7,
          "restored_count": 1,
          "kept_inactive_count": 1
        }
      },
      "read": {
        "label": "R9 after go_live",
        "tick": 3409667,
        "game_paused": true,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "go_live_plus60": {
      "success": true,
      "rung": "R9",
      "action": "go_live +60 ensure-paused",
      "read": {
        "label": "R9 go_live +60",
        "tick": 3409750,
        "game_paused": true,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
      }
    },
    "unpaused_plus120": {
      "success": true,
      "rung": "R9",
      "action": "unpaused +120 staleness check",
      "read": {
        "label": "R9 unpaused +120",
        "tick": 3409914,
        "game_paused": false,
        "platform_paused": false,
        "valid": true,
        "name": "chemical-plant",
        "type": "assembling-machine",
        "active": true,
        "direct_total": 20,
        "segment_total": 0,
        "boxes": [
          {
            "index": 1
          },
          {
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 20,
              "temperature": 25
            }
          },
          {
            "index": 3
          }
        ]
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
      "zero_storage": true,
      "zero_surfaces": true,
      "leftovers": {},
      "game_paused": false,
      "tick": 3409419
    },
    "tick": 3409419
  },
  "install": {
    "success": true,
    "tick": 3409521,
    "game_paused": false
  },
  "final_reset": {
    "success": true,
    "deleted": [
      {
        "name": "fluid-lab-r9-3409597",
        "ok": true
      }
    ],
    "zero_storage": true,
    "zero_surfaces": true,
    "leftovers": {},
    "game_paused": false,
    "post_tick": {
      "success": true,
      "zero_storage": true,
      "zero_surfaces": true,
      "leftovers": {},
      "game_paused": false,
      "tick": 3410114
    },
    "tick": 3410114
  },
  "finished": "2026-07-06T18:30:51.378Z"
}
```


## 2026-07-06T18:31:13.500Z - R7 pump fluid-lab run (run-r7-pump.mjs)

```json
{
  "script": "tests/fluid-lab/run-r7-pump.mjs",
  "started": "2026-07-06T18:31:02.809Z",
  "rungs": {
    "setup": {
      "success": false,
      "rung": "R7-pump",
      "attempts": [
        {
          "direction": "north",
          "platform": 66,
          "segmented": false,
          "pump": {
            "label": "R7 pump setup north",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "pump",
            "type": "pump",
            "active": true,
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1
              }
            ]
          },
          "tank": {
            "label": "R7 tank setup north",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 100,
            "segment_total": 100,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "heavy-oil",
                  "amount": 100,
                  "temperature": 25
                },
                "segment_id": 659,
                "segment_contents": {
                  "heavy-oil": 100
                }
              }
            ]
          },
          "in_pipe": {
            "label": "R7 in_pipe setup north",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 657,
                "segment_contents": {}
              }
            ]
          },
          "out_pipe": {
            "label": "R7 out_pipe setup north",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 658,
                "segment_contents": {}
              }
            ]
          }
        },
        {
          "direction": "east",
          "platform": 67,
          "segmented": false,
          "pump": {
            "label": "R7 pump setup east",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "pump",
            "type": "pump",
            "active": true,
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1
              }
            ]
          },
          "tank": {
            "label": "R7 tank setup east",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 100,
            "segment_total": 100,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "heavy-oil",
                  "amount": 100,
                  "temperature": 25
                },
                "segment_id": 662,
                "segment_contents": {
                  "heavy-oil": 100
                }
              }
            ]
          },
          "in_pipe": {
            "label": "R7 in_pipe setup east",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 660,
                "segment_contents": {}
              }
            ]
          },
          "out_pipe": {
            "label": "R7 out_pipe setup east",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 661,
                "segment_contents": {}
              }
            ]
          }
        },
        {
          "direction": "south",
          "platform": 68,
          "segmented": false,
          "pump": {
            "label": "R7 pump setup south",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "pump",
            "type": "pump",
            "active": true,
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1
              }
            ]
          },
          "tank": {
            "label": "R7 tank setup south",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 100,
            "segment_total": 100,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "heavy-oil",
                  "amount": 100,
                  "temperature": 25
                },
                "segment_id": 665,
                "segment_contents": {
                  "heavy-oil": 100
                }
              }
            ]
          },
          "in_pipe": {
            "label": "R7 in_pipe setup south",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 663,
                "segment_contents": {}
              }
            ]
          },
          "out_pipe": {
            "label": "R7 out_pipe setup south",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 664,
                "segment_contents": {}
              }
            ]
          }
        },
        {
          "direction": "west",
          "platform": 69,
          "segmented": false,
          "pump": {
            "label": "R7 pump setup west",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "pump",
            "type": "pump",
            "active": true,
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1
              }
            ]
          },
          "tank": {
            "label": "R7 tank setup west",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 100,
            "segment_total": 100,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "heavy-oil",
                  "amount": 100,
                  "temperature": 25
                },
                "segment_id": 668,
                "segment_contents": {
                  "heavy-oil": 100
                }
              }
            ]
          },
          "in_pipe": {
            "label": "R7 in_pipe setup west",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 666,
                "segment_contents": {}
              }
            ]
          },
          "out_pipe": {
            "label": "R7 out_pipe setup west",
            "tick": 3411013,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 667,
                "segment_contents": {}
              }
            ]
          }
        }
      ]
    }
  },
  "errors": [
    "Error: No pump segment topology armed: {\"success\":false,\"rung\":\"R7-pump\",\"attempts\":[{\"direction\":\"north\",\"platform\":66,\"segmented\":false,\"pump\":{\"label\":\"R7 pump setup north\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"pump\",\"type\":\"pump\",\"active\":true,\"direct_total\":0,\"segment_total\":0,\"boxes\":[{\"index\":1}]},\"tank\":{\"label\":\"R7 tank setup north\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"storage-tank\",\"type\":\"storage-tank\",\"direct_total\":100,\"segment_total\":100,\"boxes\":[{\"index\":1,\"direct\":{\"name\":\"heavy-oil\",\"amount\":100,\"temperature\":25},\"segment_id\":659,\"segment_contents\":{\"heavy-oil\":100}}]},\"in_pipe\":{\"label\":\"R7 in_pipe setup north\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"pipe\",\"type\":\"pipe\",\"direct_total\":0,\"segment_total\":0,\"boxes\":[{\"index\":1,\"segment_id\":657,\"segment_contents\":{}}]},\"out_pipe\":{\"label\":\"R7 out_pipe setup north\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"pipe\",\"type\":\"pipe\",\"direct_total\":0,\"segment_total\":0,\"boxes\":[{\"index\":1,\"segment_id\":658,\"segment_contents\":{}}]}},{\"direction\":\"east\",\"platform\":67,\"segmented\":false,\"pump\":{\"label\":\"R7 pump setup east\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"pump\",\"type\":\"pump\",\"active\":true,\"direct_total\":0,\"segment_total\":0,\"boxes\":[{\"index\":1}]},\"tank\":{\"label\":\"R7 tank setup east\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"storage-tank\",\"type\":\"storage-tank\",\"direct_total\":100,\"segment_total\":100,\"boxes\":[{\"index\":1,\"direct\":{\"name\":\"heavy-oil\",\"amount\":100,\"temperature\":25},\"segment_id\":662,\"segment_contents\":{\"heavy-oil\":100}}]},\"in_pipe\":{\"label\":\"R7 in_pipe setup east\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"pipe\",\"type\":\"pipe\",\"direct_total\":0,\"segment_total\":0,\"boxes\":[{\"index\":1,\"segment_id\":660,\"segment_contents\":{}}]},\"out_pipe\":{\"label\":\"R7 out_pipe setup east\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"pipe\",\"type\":\"pipe\",\"direct_total\":0,\"segment_total\":0,\"boxes\":[{\"index\":1,\"segment_id\":661,\"segment_contents\":{}}]}},{\"direction\":\"south\",\"platform\":68,\"segmented\":false,\"pump\":{\"label\":\"R7 pump setup south\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"pump\",\"type\":\"pump\",\"active\":true,\"direct_total\":0,\"segment_total\":0,\"boxes\":[{\"index\":1}]},\"tank\":{\"label\":\"R7 tank setup south\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"storage-tank\",\"type\":\"storage-tank\",\"direct_total\":100,\"segment_total\":100,\"boxes\":[{\"index\":1,\"direct\":{\"name\":\"heavy-oil\",\"amount\":100,\"temperature\":25},\"segment_id\":665,\"segment_contents\":{\"heavy-oil\":100}}]},\"in_pipe\":{\"label\":\"R7 in_pipe setup south\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"pipe\",\"type\":\"pipe\",\"direct_total\":0,\"segment_total\":0,\"boxes\":[{\"index\":1,\"segment_id\":663,\"segment_contents\":{}}]},\"out_pipe\":{\"label\":\"R7 out_pipe setup south\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"pipe\",\"type\":\"pipe\",\"direct_total\":0,\"segment_total\":0,\"boxes\":[{\"index\":1,\"segment_id\":664,\"segment_contents\":{}}]}},{\"direction\":\"west\",\"platform\":69,\"segmented\":false,\"pump\":{\"label\":\"R7 pump setup west\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"pump\",\"type\":\"pump\",\"active\":true,\"direct_total\":0,\"segment_total\":0,\"boxes\":[{\"index\":1}]},\"tank\":{\"label\":\"R7 tank setup west\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"storage-tank\",\"type\":\"storage-tank\",\"direct_total\":100,\"segment_total\":100,\"boxes\":[{\"index\":1,\"direct\":{\"name\":\"heavy-oil\",\"amount\":100,\"temperature\":25},\"segment_id\":668,\"segment_contents\":{\"heavy-oil\":100}}]},\"in_pipe\":{\"label\":\"R7 in_pipe setup west\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"pipe\",\"type\":\"pipe\",\"direct_total\":0,\"segment_total\":0,\"boxes\":[{\"index\":1,\"segment_id\":666,\"segment_contents\":{}}]},\"out_pipe\":{\"label\":\"R7 out_pipe setup west\",\"tick\":3411013,\"game_paused\":false,\"valid\":true,\"name\":\"pipe\",\"type\":\"pipe\",\"direct_total\":0,\"segment_total\":0,\"boxes\":[{\"index\":1,\"segment_id\":667,\"segment_contents\":{}}]}}]}\n    at file:///C:/Users/Solar/source/FactorioSurfaceExport/tests/fluid-lab/run-r7-pump.mjs:129:42\n    at ModuleJob.run (node:internal/modules/esm/module_job:439:25)\n    at async node:internal/modules/esm/loader:633:26\n    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)"
  ],
  "initial_reset": {
    "success": true,
    "deleted": {},
    "zero_storage": true,
    "zero_surfaces": true,
    "leftovers": {},
    "game_paused": false,
    "post_tick": {
      "success": true,
      "zero_storage": true,
      "zero_surfaces": true,
      "leftovers": {},
      "game_paused": false,
      "tick": 3410945
    },
    "tick": 3410945
  },
  "final_reset": {
    "success": true,
    "deleted": [
      {
        "name": "fluid-lab-r7pump-north-3411013",
        "ok": true,
        "error": "nil"
      },
      {
        "name": "fluid-lab-r7pump-east-3411013",
        "ok": true,
        "error": "nil"
      },
      {
        "name": "fluid-lab-r7pump-south-3411013",
        "ok": true,
        "error": "nil"
      },
      {
        "name": "fluid-lab-r7pump-west-3411013",
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
      "zero_storage": true,
      "zero_surfaces": true,
      "leftovers": {},
      "game_paused": false,
      "tick": 3411284
    },
    "tick": 3411284
  },
  "finished": "2026-07-06T18:31:13.500Z"
}
```

## 2026-07-06 - R9/R7 decision-gate summary

- R9 reproduced the CI probe cadence locally with the game paused at fixture creation, pre-read, real `destination_hold_json` stage, +600 held ticks, go-live, and +60 post-go-live read. Every paused read recorded `game_paused=true`, `platform_paused`, direct machine fluid, segment contents, and tick. The chemical plant's direct heavy-oil buffer stayed `20` from pre-read through stage, +600, go-live, +60, and the unpaused +120 settle read. Local R9 did **not** reproduce the CI `20`-fluid delta.
- R9's staleness discriminator had nothing to recover: the direct meter never dropped, and the segment meter stayed `0` because the plant buffer is isolated (`segment_id=nil`). This supports the current smallest-change path: deterministic fixture + explicit direct-machine meter hardening, primitive untouched, pending CI self-report (R9b).
- R7 pump specimen attempt: pump-pipe-tank setup did not produce a non-nil segment ID on the pump fluidbox. Adjacent pipes and tanks reported segment IDs, but the pump's own fluidbox did not. A focused sanity check with pump + two adjacent pipes, reread after ticks, showed the same result: pipes had segments, pump did not.
- Negative domain finding: on this 2.0.77 cluster, the tested activatable fluid entities (`assembling-machine` chemical plant and `pump`) do not expose non-nil fluid segment IDs on their own fluidboxes. Pipes/tanks expose segments but are not activatable. The historical Pitfall-17 ghost-buffer explanation remains unproven for the current engine surface; treat it as a hazard note until a real specimen reproduces it.


## 2026-07-06T18:40:11.973Z - R7 pump fluid-lab run (run-r7-pump.mjs)

```json
{
  "script": "tests/fluid-lab/run-r7-pump.mjs",
  "started": "2026-07-06T18:40:03.878Z",
  "rungs": {
    "setup": {
      "success": false,
      "rung": "R7-pump",
      "attempts": [
        {
          "direction": "north",
          "platform": 72,
          "segmented": false,
          "pump": {
            "label": "R7 pump setup north",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "pump",
            "type": "pump",
            "active": true,
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1
              }
            ]
          },
          "tank": {
            "label": "R7 tank setup north",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 100,
            "segment_total": 100,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "heavy-oil",
                  "amount": 100,
                  "temperature": 25
                },
                "segment_id": 745,
                "segment_contents": {
                  "heavy-oil": 100
                }
              }
            ]
          },
          "in_pipe": {
            "label": "R7 in_pipe setup north",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 743,
                "segment_contents": {}
              }
            ]
          },
          "out_pipe": {
            "label": "R7 out_pipe setup north",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 744,
                "segment_contents": {}
              }
            ]
          }
        },
        {
          "direction": "east",
          "platform": 73,
          "segmented": false,
          "pump": {
            "label": "R7 pump setup east",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "pump",
            "type": "pump",
            "active": true,
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1
              }
            ]
          },
          "tank": {
            "label": "R7 tank setup east",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 100,
            "segment_total": 100,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "heavy-oil",
                  "amount": 100,
                  "temperature": 25
                },
                "segment_id": 748,
                "segment_contents": {
                  "heavy-oil": 100
                }
              }
            ]
          },
          "in_pipe": {
            "label": "R7 in_pipe setup east",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 746,
                "segment_contents": {}
              }
            ]
          },
          "out_pipe": {
            "label": "R7 out_pipe setup east",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 747,
                "segment_contents": {}
              }
            ]
          }
        },
        {
          "direction": "south",
          "platform": 74,
          "segmented": false,
          "pump": {
            "label": "R7 pump setup south",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "pump",
            "type": "pump",
            "active": true,
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1
              }
            ]
          },
          "tank": {
            "label": "R7 tank setup south",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 100,
            "segment_total": 100,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "heavy-oil",
                  "amount": 100,
                  "temperature": 25
                },
                "segment_id": 751,
                "segment_contents": {
                  "heavy-oil": 100
                }
              }
            ]
          },
          "in_pipe": {
            "label": "R7 in_pipe setup south",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 749,
                "segment_contents": {}
              }
            ]
          },
          "out_pipe": {
            "label": "R7 out_pipe setup south",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 750,
                "segment_contents": {}
              }
            ]
          }
        },
        {
          "direction": "west",
          "platform": 75,
          "segmented": false,
          "pump": {
            "label": "R7 pump setup west",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "pump",
            "type": "pump",
            "active": true,
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1
              }
            ]
          },
          "tank": {
            "label": "R7 tank setup west",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 100,
            "segment_total": 100,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "heavy-oil",
                  "amount": 100,
                  "temperature": 25
                },
                "segment_id": 754,
                "segment_contents": {
                  "heavy-oil": 100
                }
              }
            ]
          },
          "in_pipe": {
            "label": "R7 in_pipe setup west",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 752,
                "segment_contents": {}
              }
            ]
          },
          "out_pipe": {
            "label": "R7 out_pipe setup west",
            "tick": 3437681,
            "game_paused": false,
            "valid": true,
            "name": "pipe",
            "type": "pipe",
            "direct_total": 0,
            "segment_total": 0,
            "boxes": [
              {
                "index": 1,
                "segment_id": 753,
                "segment_contents": {}
              }
            ]
          }
        }
      ]
    },
    "verdict": {
      "success": true,
      "rung": "R7-pump",
      "verdict": "no activatable pump fluidbox with non-nil segment_id found",
      "note": "Adjacent pipes/tanks reported segments; pump own fluidbox did not. This is recorded as negative domain data, not a harness failure."
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
      "zero_storage": true,
      "zero_surfaces": true,
      "leftovers": {},
      "game_paused": false,
      "tick": 3437626
    },
    "tick": 3437626
  },
  "final_reset": {
    "success": true,
    "deleted": [
      {
        "name": "fluid-lab-r7pump-north-3437681",
        "ok": true,
        "error": "nil"
      },
      {
        "name": "fluid-lab-r7pump-east-3437681",
        "ok": true,
        "error": "nil"
      },
      {
        "name": "fluid-lab-r7pump-south-3437681",
        "ok": true,
        "error": "nil"
      },
      {
        "name": "fluid-lab-r7pump-west-3437681",
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
      "zero_storage": true,
      "zero_surfaces": true,
      "leftovers": {},
      "game_paused": false,
      "tick": 3437867
    },
    "tick": 3437867
  },
  "finished": "2026-07-06T18:40:11.973Z"
}
```


## 2026-07-08T19:18:10.771Z - R10 fluid-lab run (run-r10.mjs; sections=r10a,r10b)

```json
{
  "script": "tests/fluid-lab/run-r10.mjs",
  "started": "2026-07-08T19:17:43.547Z",
  "sections": [
    "r10a",
    "r10b"
  ],
  "no_notebook": false,
  "source": {
    "host": 1,
    "instance": "clusterio-host-1-instance-1"
  },
  "dest": {
    "host": 2,
    "instance": "clusterio-host-2-instance-1"
  },
  "rungs": {
    "r10a": {
      "success": true,
      "rung": "R10a",
      "platform": "fluid-lab-r10a-1783538269993",
      "setup": {
        "success": true,
        "platform": {
          "name": "fluid-lab-r10a-1783538269993",
          "index": 8
        },
        "inserted": 2000,
        "read": {
          "label": "R10a after insert",
          "tick": 3269917,
          "game_paused": false,
          "platform_paused": false,
          "valid": true,
          "name": "storage-tank",
          "type": "storage-tank",
          "direct_total": 2000,
          "segment_total": 2000,
          "boxes": [
            {
              "index": 1,
              "direct": {
                "name": "steam",
                "amount": 2000,
                "temperature": 165
              },
              "segment_id": 48,
              "segment_contents": {
                "steam": 2000
              }
            }
          ]
        }
      },
      "transfer": {
        "dest_instance_id": 1351385547,
        "command": "/transfer-platform 8 1351385547",
        "output": "═══════════════════════════════════════\n🚀 Transfer Platform: fluid-lab-r10a-1783538269993\n═══════════════════════════════════════\nDestination: Instance 1351385547\nPlatform: [8] fluid-lab-r10a-1783538269993\n\n[1/2] Locking + queueing export...\n[2/2] ✓ Export queued: 005_fluid-lab-r10a-1783538269993\n⏳ Exporting asynchronously (this may take a while)...\n\nThe transfer will continue automatically:\n  1. Export completes → Sent to controller\n  2. Controller → Sends to destination instance\n  3. Destination imports → Validates counts\n  4. On success → Source deleted automatically\n  5. On failure → Source unlocked automatically\n\n💡 Use /list-platforms to track progress\n═══════════════════════════════════════",
        "debug": {
          "import_result_file": "/clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_fluid-lab-r10a-1783538269993_3203220.json",
          "source_file": "/clusterio/data/instances/clusterio-host-1-instance-1/script-output/debug_source_platform_fluid-lab-r10a-1783538269993_3269997.json",
          "import_result_keys": [
            "duration_seconds",
            "platform_name",
            "total_entities",
            "transfer_id",
            "validation_result",
            "validation_success"
          ],
          "validation_result_keys": [
            "actualFluidCounts",
            "actualItemCounts",
            "entityCount",
            "entityTypeBreakdown",
            "expectedFluidCounts",
            "expectedItemCounts",
            "fluidCountMatch",
            "fluidReconciliation",
            "fluidTypesActual",
            "fluidTypesExpected",
            "itemCountMatch",
            "itemLossByType",
            "itemTypesActual",
            "itemTypesExpected",
            "postActivation",
            "reportedEntityCount",
            "success",
            "totalActualFluids",
            "totalActualItems",
            "totalExpectedFluids",
            "totalExpectedItems",
            "totalItemLoss"
          ],
          "source_debug_keys": [
            "entities",
            "force_data",
            "force_name",
            "frozen_states",
            "platform",
            "platform_name",
            "stats",
            "tick",
            "tiles",
            "timestamp",
            "verification"
          ],
          "source_verification_keys": [
            "fluid_counts",
            "item_counts"
          ],
          "validation": {
            "validation_success": true,
            "itemCountMatch": true,
            "fluidCountMatch": true,
            "failedStage": null,
            "expectedFluidCounts": {
              "steam@165.0C": 2000
            },
            "actualFluidCounts": {
              "steam@165.0C": 2000
            },
            "totalExpectedFluids": 2000,
            "totalActualFluids": 2000,
            "fluidReconciliation": {
              "highTempThreshold": 10000,
              "rawFluidDelta": 0,
              "reconciledFluidLoss": 0,
              "lowTempLoss": 0,
              "highTempReconciledLoss": 0,
              "fluidPreservedPct": 100,
              "highTempAggregates": {}
            }
          },
          "source_verification": {
            "fluid_counts": {
              "steam@165.0C": 2000
            },
            "item_counts": {
              "space-platform-foundation": 10
            }
          },
          "source_platform": {
            "name": "fluid-lab-r10a-1783538269993",
            "index": 8,
            "paused": false,
            "schedule_records": 1
          }
        },
        "dest_read": {
          "success": true,
          "platform": {
            "name": "fluid-lab-r10a-1783538269993",
            "index": 8,
            "paused": false
          },
          "read": {
            "label": "dest post-transfer fluid-lab-r10a-1783538269993",
            "tick": 3203446,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 2000,
            "segment_total": 2000,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "steam",
                  "amount": 2000,
                  "temperature": 165
                },
                "segment_id": 157,
                "segment_contents": {
                  "steam": 2000
                }
              }
            ]
          }
        }
      },
      "gate": {
        "validation_success": true,
        "fluidCountMatch": true,
        "failedStage": null,
        "expectedFluidCounts": {
          "steam@165.0C": 2000
        },
        "actualFluidCounts": {
          "steam@165.0C": 2000
        },
        "totalExpectedFluids": 2000,
        "totalActualFluids": 2000,
        "fluidReconciliation": {
          "highTempThreshold": 10000,
          "rawFluidDelta": 0,
          "reconciledFluidLoss": 0,
          "lowTempLoss": 0,
          "highTempReconciledLoss": 0,
          "fluidPreservedPct": 100,
          "highTempAggregates": {}
        },
        "sourceVerificationFluidCounts": {
          "steam@165.0C": 2000
        }
      },
      "assertions": {
        "expected_key": "steam@165.0C",
        "expected_volume": 2000,
        "actual_volume": 2000,
        "key_reproduced": true,
        "volume_delta": 0,
        "gate_passed": true
      },
      "conclusion": "R10a PASS: fixed steam@165.0C key reproduced through real transfer and the composite fluid gate passed."
    },
    "r10b": {
      "success": true,
      "rung": "R10b",
      "platform": "fluid-lab-r10b-1783538276845",
      "setup": {
        "success": true,
        "platform": {
          "name": "fluid-lab-r10b-1783538276845",
          "index": 9
        },
        "inserted1": 1000,
        "inserted2": 1000,
        "after_first": {
          "label": "R10b after first insert",
          "tick": 3270275,
          "game_paused": false,
          "platform_paused": false,
          "valid": true,
          "name": "storage-tank",
          "type": "storage-tank",
          "direct_total": 1000,
          "segment_total": 1000,
          "boxes": [
            {
              "index": 1,
              "direct": {
                "name": "steam",
                "amount": 1000,
                "temperature": 165
              },
              "segment_id": 49,
              "segment_contents": {
                "steam": 1000
              }
            }
          ]
        },
        "after_second": {
          "label": "R10b after second insert",
          "tick": 3270275,
          "game_paused": false,
          "platform_paused": false,
          "valid": true,
          "name": "storage-tank",
          "type": "storage-tank",
          "direct_total": 2000,
          "segment_total": 2000,
          "boxes": [
            {
              "index": 1,
              "direct": {
                "name": "steam",
                "amount": 2000,
                "temperature": 332.5
              },
              "segment_id": 49,
              "segment_contents": {
                "steam": 2000
              }
            }
          ]
        },
        "after_plus1": {
          "success": true,
          "platform": {
            "name": "fluid-lab-r10b-1783538276845",
            "index": 9,
            "paused": false
          },
          "read": {
            "label": "R10b +1 tick",
            "tick": 3270346,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 2000,
            "segment_total": 2000,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "steam",
                  "amount": 2000,
                  "temperature": 332.5
                },
                "segment_id": 49,
                "segment_contents": {
                  "steam": 2000
                }
              }
            ]
          }
        },
        "after_plus60": {
          "success": true,
          "platform": {
            "name": "fluid-lab-r10b-1783538276845",
            "index": 9,
            "paused": false
          },
          "read": {
            "label": "R10b +60 ticks",
            "tick": 3270414,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 2000,
            "segment_total": 2000,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "steam",
                  "amount": 2000,
                  "temperature": 332.5
                },
                "segment_id": 49,
                "segment_contents": {
                  "steam": 2000
                }
              }
            ]
          }
        },
        "pre_export": {
          "success": true,
          "platform": {
            "name": "fluid-lab-r10b-1783538276845",
            "index": 9,
            "paused": false
          },
          "read": {
            "label": "R10b pre-export",
            "tick": 3270447,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 2000,
            "segment_total": 2000,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "steam",
                  "amount": 2000,
                  "temperature": 332.5
                },
                "segment_id": 49,
                "segment_contents": {
                  "steam": 2000
                }
              }
            ]
          }
        }
      },
      "transfer": {
        "dest_instance_id": 1351385547,
        "command": "/transfer-platform 9 1351385547",
        "output": "═══════════════════════════════════════\n🚀 Transfer Platform: fluid-lab-r10b-1783538276845\n═══════════════════════════════════════\nDestination: Instance 1351385547\nPlatform: [9] fluid-lab-r10b-1783538276845\n\n[1/2] Locking + queueing export...\n[2/2] ✓ Export queued: 006_fluid-lab-r10b-1783538276845\n⏳ Exporting asynchronously (this may take a while)...\n\nThe transfer will continue automatically:\n  1. Export completes → Sent to controller\n  2. Controller → Sends to destination instance\n  3. Destination imports → Validates counts\n  4. On success → Source deleted automatically\n  5. On failure → Source unlocked automatically\n\n💡 Use /list-platforms to track progress\n═══════════════════════════════════════",
        "debug": {
          "import_result_file": "/clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_fluid-lab-r10b-1783538276845_3203762.json",
          "source_file": "/clusterio/data/instances/clusterio-host-1-instance-1/script-output/debug_source_platform_fluid-lab-r10b-1783538276845_3270525.json",
          "import_result_keys": [
            "duration_seconds",
            "platform_name",
            "total_entities",
            "transfer_id",
            "validation_result",
            "validation_success"
          ],
          "validation_result_keys": [
            "actualFluidCounts",
            "actualItemCounts",
            "entityCount",
            "entityTypeBreakdown",
            "expectedFluidCounts",
            "expectedItemCounts",
            "fluidCountMatch",
            "fluidReconciliation",
            "fluidTypesActual",
            "fluidTypesExpected",
            "itemCountMatch",
            "itemLossByType",
            "itemTypesActual",
            "itemTypesExpected",
            "postActivation",
            "reportedEntityCount",
            "success",
            "totalActualFluids",
            "totalActualItems",
            "totalExpectedFluids",
            "totalExpectedItems",
            "totalItemLoss"
          ],
          "source_debug_keys": [
            "entities",
            "force_data",
            "force_name",
            "frozen_states",
            "platform",
            "platform_name",
            "stats",
            "tick",
            "tiles",
            "timestamp",
            "verification"
          ],
          "source_verification_keys": [
            "fluid_counts",
            "item_counts"
          ],
          "validation": {
            "validation_success": true,
            "itemCountMatch": true,
            "fluidCountMatch": true,
            "failedStage": null,
            "expectedFluidCounts": {
              "steam@332.5C": 2000
            },
            "actualFluidCounts": {
              "steam@332.5C": 2000
            },
            "totalExpectedFluids": 2000,
            "totalActualFluids": 2000,
            "fluidReconciliation": {
              "highTempThreshold": 10000,
              "rawFluidDelta": 0,
              "reconciledFluidLoss": 0,
              "lowTempLoss": 0,
              "highTempReconciledLoss": 0,
              "fluidPreservedPct": 100,
              "highTempAggregates": {}
            }
          },
          "source_verification": {
            "fluid_counts": {
              "steam@332.5C": 2000
            },
            "item_counts": {
              "space-platform-foundation": 10
            }
          },
          "source_platform": {
            "name": "fluid-lab-r10b-1783538276845",
            "index": 9,
            "paused": false,
            "schedule_records": 1
          }
        },
        "dest_read": {
          "success": true,
          "platform": {
            "name": "fluid-lab-r10b-1783538276845",
            "index": 9,
            "paused": false
          },
          "read": {
            "label": "dest post-transfer fluid-lab-r10b-1783538276845",
            "tick": 3203987,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 2000,
            "segment_total": 2000,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "steam",
                  "amount": 2000,
                  "temperature": 332.5
                },
                "segment_id": 158,
                "segment_contents": {
                  "steam": 2000
                }
              }
            ]
          }
        }
      },
      "gate": {
        "validation_success": true,
        "fluidCountMatch": true,
        "failedStage": null,
        "expectedFluidCounts": {
          "steam@332.5C": 2000
        },
        "actualFluidCounts": {
          "steam@332.5C": 2000
        },
        "totalExpectedFluids": 2000,
        "totalActualFluids": 2000,
        "fluidReconciliation": {
          "highTempThreshold": 10000,
          "rawFluidDelta": 0,
          "reconciledFluidLoss": 0,
          "lowTempLoss": 0,
          "highTempReconciledLoss": 0,
          "fluidPreservedPct": 100,
          "highTempAggregates": {}
        },
        "sourceVerificationFluidCounts": {
          "steam@332.5C": 2000
        }
      },
      "old_gate_simulation": {
        "would_false_fail": false,
        "false_fail_keys": []
      },
      "aggregates": {
        "expectedByName": {
          "steam": 2000
        },
        "actualByName": {
          "steam": 2000
        }
      },
      "source_cross_check": {
        "verification_fluid_counts": {
          "steam@332.5C": 2000
        },
        "matches_import_expected": true
      },
      "assertions": {
        "new_gate_passed_valid_transfer": true,
        "old_gate_would_false_fail": false
      },
      "conclusion": "R10b PASS: valid mixed-temp transfer passed; old exact-key gate would NOT have false-failed this measured export/import pair, so #76 is defensive for this case rather than proven necessary."
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 3269559,
        "game_paused": false
      },
      "dest": {
        "success": true,
        "deleted": {},
        "tick": 3202797,
        "game_paused": false
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 3269705,
        "game_paused": false,
        "zero_surfaces": true,
        "leftovers": {},
        "zero_storage": true,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0
      },
      "dest": {
        "success": true,
        "tick": 3202944,
        "game_paused": false,
        "zero_surfaces": true,
        "leftovers": {},
        "zero_storage": true,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 3269773,
      "base": "2.0.77"
    },
    "dest": {
      "success": true,
      "tick": 3203011,
      "base": "2.0.77"
    }
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 3270793,
        "game_paused": false
      },
      "dest": {
        "success": true,
        "deleted": [
          {
            "name": "fluid-lab-r10a-1783538269993",
            "ok": true
          },
          {
            "name": "fluid-lab-r10b-1783538276845",
            "ok": true
          }
        ],
        "tick": 3204055,
        "game_paused": false
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 3270938,
        "game_paused": false,
        "zero_surfaces": true,
        "leftovers": {},
        "zero_storage": true,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0
      },
      "dest": {
        "success": true,
        "tick": 3204198,
        "game_paused": false,
        "zero_surfaces": true,
        "leftovers": {},
        "zero_storage": true,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0
      }
    },
    "ok": true
  },
  "finished": "2026-07-08T19:18:10.771Z"
}
```


## 2026-07-08T19:18:46.992Z - R10 fluid-lab run (run-r10.mjs; sections=r10a,r10b)

```json
{
  "script": "tests/fluid-lab/run-r10.mjs",
  "started": "2026-07-08T19:18:19.919Z",
  "sections": [
    "r10a",
    "r10b"
  ],
  "no_notebook": false,
  "source": {
    "host": 1,
    "instance": "clusterio-host-1-instance-1"
  },
  "dest": {
    "host": 2,
    "instance": "clusterio-host-2-instance-1"
  },
  "rungs": {
    "r10a": {
      "success": true,
      "rung": "R10a",
      "platform": "fluid-lab-r10a-1783538306364",
      "setup": {
        "success": true,
        "platform": {
          "name": "fluid-lab-r10a-1783538306364",
          "index": 10
        },
        "inserted": 2000,
        "read": {
          "label": "R10a after insert",
          "tick": 3271861,
          "game_paused": false,
          "platform_paused": false,
          "valid": true,
          "name": "storage-tank",
          "type": "storage-tank",
          "direct_total": 2000,
          "segment_total": 2000,
          "boxes": [
            {
              "index": 1,
              "direct": {
                "name": "steam",
                "amount": 2000,
                "temperature": 165
              },
              "segment_id": 50,
              "segment_contents": {
                "steam": 2000
              }
            }
          ]
        }
      },
      "transfer": {
        "dest_instance_id": 1351385547,
        "command": "/transfer-platform 10 1351385547",
        "output": "═══════════════════════════════════════\n🚀 Transfer Platform: fluid-lab-r10a-1783538306364\n═══════════════════════════════════════\nDestination: Instance 1351385547\nPlatform: [10] fluid-lab-r10a-1783538306364\n\n[1/2] Locking + queueing export...\n[2/2] ✓ Export queued: 007_fluid-lab-r10a-1783538306364\n⏳ Exporting asynchronously (this may take a while)...\n\nThe transfer will continue automatically:\n  1. Export completes → Sent to controller\n  2. Controller → Sends to destination instance\n  3. Destination imports → Validates counts\n  4. On success → Source deleted automatically\n  5. On failure → Source unlocked automatically\n\n💡 Use /list-platforms to track progress\n═══════════════════════════════════════",
        "debug": {
          "import_result_file": "/clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_fluid-lab-r10a-1783538306364_3205180.json",
          "source_file": "/clusterio/data/instances/clusterio-host-1-instance-1/script-output/debug_source_platform_fluid-lab-r10a-1783538306364_3271944.json",
          "import_result_keys": [
            "duration_seconds",
            "platform_name",
            "total_entities",
            "transfer_id",
            "validation_result",
            "validation_success"
          ],
          "validation_result_keys": [
            "actualFluidCounts",
            "actualItemCounts",
            "entityCount",
            "entityTypeBreakdown",
            "expectedFluidCounts",
            "expectedItemCounts",
            "fluidCountMatch",
            "fluidReconciliation",
            "fluidTypesActual",
            "fluidTypesExpected",
            "itemCountMatch",
            "itemLossByType",
            "itemTypesActual",
            "itemTypesExpected",
            "postActivation",
            "reportedEntityCount",
            "success",
            "totalActualFluids",
            "totalActualItems",
            "totalExpectedFluids",
            "totalExpectedItems",
            "totalItemLoss"
          ],
          "source_debug_keys": [
            "entities",
            "force_data",
            "force_name",
            "frozen_states",
            "platform",
            "platform_name",
            "stats",
            "tick",
            "tiles",
            "timestamp",
            "verification"
          ],
          "source_verification_keys": [
            "fluid_counts",
            "item_counts"
          ],
          "validation": {
            "validation_success": true,
            "itemCountMatch": true,
            "fluidCountMatch": true,
            "failedStage": null,
            "expectedFluidCounts": {
              "steam@165.0C": 2000
            },
            "actualFluidCounts": {
              "steam@165.0C": 2000
            },
            "totalExpectedFluids": 2000,
            "totalActualFluids": 2000,
            "fluidReconciliation": {
              "highTempThreshold": 10000,
              "rawFluidDelta": 0,
              "reconciledFluidLoss": 0,
              "lowTempLoss": 0,
              "highTempReconciledLoss": 0,
              "fluidPreservedPct": 100,
              "highTempAggregates": {}
            }
          },
          "source_verification": {
            "fluid_counts": {
              "steam@165.0C": 2000
            },
            "item_counts": {
              "space-platform-foundation": 10
            }
          },
          "source_platform": {
            "name": "fluid-lab-r10a-1783538306364",
            "index": 10,
            "paused": false,
            "schedule_records": 1
          }
        },
        "dest_read": {
          "success": true,
          "platform": {
            "name": "fluid-lab-r10a-1783538306364",
            "index": 10,
            "paused": false
          },
          "read": {
            "label": "dest post-transfer fluid-lab-r10a-1783538306364",
            "tick": 3205407,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 2000,
            "segment_total": 2000,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "steam",
                  "amount": 2000,
                  "temperature": 165
                },
                "segment_id": 159,
                "segment_contents": {
                  "steam": 2000
                }
              }
            ]
          }
        }
      },
      "gate": {
        "validation_success": true,
        "fluidCountMatch": true,
        "failedStage": null,
        "expectedFluidCounts": {
          "steam@165.0C": 2000
        },
        "actualFluidCounts": {
          "steam@165.0C": 2000
        },
        "totalExpectedFluids": 2000,
        "totalActualFluids": 2000,
        "fluidReconciliation": {
          "highTempThreshold": 10000,
          "rawFluidDelta": 0,
          "reconciledFluidLoss": 0,
          "lowTempLoss": 0,
          "highTempReconciledLoss": 0,
          "fluidPreservedPct": 100,
          "highTempAggregates": {}
        },
        "sourceVerificationFluidCounts": {
          "steam@165.0C": 2000
        }
      },
      "assertions": {
        "expected_key": "steam@165.0C",
        "expected_volume": 2000,
        "actual_volume": 2000,
        "key_reproduced": true,
        "volume_delta": 0,
        "gate_passed": true
      },
      "conclusion": "R10a PASS: fixed steam@165.0C key reproduced through real transfer and the composite fluid gate passed."
    },
    "r10b": {
      "success": true,
      "rung": "R10b",
      "platform": "fluid-lab-r10b-1783538313161",
      "setup": {
        "success": true,
        "platform": {
          "name": "fluid-lab-r10b-1783538313161",
          "index": 11
        },
        "inserted1": 1000,
        "inserted2": 1000,
        "after_first": {
          "label": "R10b after first insert",
          "tick": 3272223,
          "game_paused": false,
          "platform_paused": false,
          "valid": true,
          "name": "storage-tank",
          "type": "storage-tank",
          "direct_total": 1000,
          "segment_total": 1000,
          "boxes": [
            {
              "index": 1,
              "direct": {
                "name": "steam",
                "amount": 1000,
                "temperature": 165
              },
              "segment_id": 51,
              "segment_contents": {
                "steam": 1000
              }
            }
          ]
        },
        "after_second": {
          "label": "R10b after second insert",
          "tick": 3272223,
          "game_paused": false,
          "platform_paused": false,
          "valid": true,
          "name": "storage-tank",
          "type": "storage-tank",
          "direct_total": 2000,
          "segment_total": 2000,
          "boxes": [
            {
              "index": 1,
              "direct": {
                "name": "steam",
                "amount": 2000,
                "temperature": 332.5
              },
              "segment_id": 51,
              "segment_contents": {
                "steam": 2000
              }
            }
          ]
        },
        "after_plus1": {
          "success": true,
          "platform": {
            "name": "fluid-lab-r10b-1783538313161",
            "index": 11,
            "paused": false
          },
          "read": {
            "label": "R10b +1 tick",
            "tick": 3272290,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 2000,
            "segment_total": 2000,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "steam",
                  "amount": 2000,
                  "temperature": 332.5
                },
                "segment_id": 51,
                "segment_contents": {
                  "steam": 2000
                }
              }
            ]
          }
        },
        "after_plus60": {
          "success": true,
          "platform": {
            "name": "fluid-lab-r10b-1783538313161",
            "index": 11,
            "paused": false
          },
          "read": {
            "label": "R10b +60 ticks",
            "tick": 3272354,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 2000,
            "segment_total": 2000,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "steam",
                  "amount": 2000,
                  "temperature": 332.5
                },
                "segment_id": 51,
                "segment_contents": {
                  "steam": 2000
                }
              }
            ]
          }
        },
        "pre_export": {
          "success": true,
          "platform": {
            "name": "fluid-lab-r10b-1783538313161",
            "index": 11,
            "paused": false
          },
          "read": {
            "label": "R10b pre-export",
            "tick": 3272387,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 2000,
            "segment_total": 2000,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "steam",
                  "amount": 2000,
                  "temperature": 332.5
                },
                "segment_id": 51,
                "segment_contents": {
                  "steam": 2000
                }
              }
            ]
          }
        }
      },
      "transfer": {
        "dest_instance_id": 1351385547,
        "command": "/transfer-platform 11 1351385547",
        "output": "═══════════════════════════════════════\n🚀 Transfer Platform: fluid-lab-r10b-1783538313161\n═══════════════════════════════════════\nDestination: Instance 1351385547\nPlatform: [11] fluid-lab-r10b-1783538313161\n\n[1/2] Locking + queueing export...\n[2/2] ✓ Export queued: 008_fluid-lab-r10b-1783538313161\n⏳ Exporting asynchronously (this may take a while)...\n\nThe transfer will continue automatically:\n  1. Export completes → Sent to controller\n  2. Controller → Sends to destination instance\n  3. Destination imports → Validates counts\n  4. On success → Source deleted automatically\n  5. On failure → Source unlocked automatically\n\n💡 Use /list-platforms to track progress\n═══════════════════════════════════════",
        "debug": {
          "import_result_file": "/clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_fluid-lab-r10b-1783538313161_3205720.json",
          "source_file": "/clusterio/data/instances/clusterio-host-1-instance-1/script-output/debug_source_platform_fluid-lab-r10b-1783538313161_3272464.json",
          "import_result_keys": [
            "duration_seconds",
            "platform_name",
            "total_entities",
            "transfer_id",
            "validation_result",
            "validation_success"
          ],
          "validation_result_keys": [
            "actualFluidCounts",
            "actualItemCounts",
            "entityCount",
            "entityTypeBreakdown",
            "expectedFluidCounts",
            "expectedItemCounts",
            "fluidCountMatch",
            "fluidReconciliation",
            "fluidTypesActual",
            "fluidTypesExpected",
            "itemCountMatch",
            "itemLossByType",
            "itemTypesActual",
            "itemTypesExpected",
            "postActivation",
            "reportedEntityCount",
            "success",
            "totalActualFluids",
            "totalActualItems",
            "totalExpectedFluids",
            "totalExpectedItems",
            "totalItemLoss"
          ],
          "source_debug_keys": [
            "entities",
            "force_data",
            "force_name",
            "frozen_states",
            "platform",
            "platform_name",
            "stats",
            "tick",
            "tiles",
            "timestamp",
            "verification"
          ],
          "source_verification_keys": [
            "fluid_counts",
            "item_counts"
          ],
          "validation": {
            "validation_success": true,
            "itemCountMatch": true,
            "fluidCountMatch": true,
            "failedStage": null,
            "expectedFluidCounts": {
              "steam@332.5C": 2000
            },
            "actualFluidCounts": {
              "steam@332.5C": 2000
            },
            "totalExpectedFluids": 2000,
            "totalActualFluids": 2000,
            "fluidReconciliation": {
              "highTempThreshold": 10000,
              "rawFluidDelta": 0,
              "reconciledFluidLoss": 0,
              "lowTempLoss": 0,
              "highTempReconciledLoss": 0,
              "fluidPreservedPct": 100,
              "highTempAggregates": {}
            }
          },
          "source_verification": {
            "fluid_counts": {
              "steam@332.5C": 2000
            },
            "item_counts": {
              "space-platform-foundation": 10
            }
          },
          "source_platform": {
            "name": "fluid-lab-r10b-1783538313161",
            "index": 11,
            "paused": false,
            "schedule_records": 1
          }
        },
        "dest_read": {
          "success": true,
          "platform": {
            "name": "fluid-lab-r10b-1783538313161",
            "index": 11,
            "paused": false
          },
          "read": {
            "label": "dest post-transfer fluid-lab-r10b-1783538313161",
            "tick": 3205946,
            "game_paused": false,
            "platform_paused": false,
            "valid": true,
            "name": "storage-tank",
            "type": "storage-tank",
            "direct_total": 2000,
            "segment_total": 2000,
            "boxes": [
              {
                "index": 1,
                "direct": {
                  "name": "steam",
                  "amount": 2000,
                  "temperature": 332.5
                },
                "segment_id": 160,
                "segment_contents": {
                  "steam": 2000
                }
              }
            ]
          }
        }
      },
      "gate": {
        "validation_success": true,
        "fluidCountMatch": true,
        "failedStage": null,
        "expectedFluidCounts": {
          "steam@332.5C": 2000
        },
        "actualFluidCounts": {
          "steam@332.5C": 2000
        },
        "totalExpectedFluids": 2000,
        "totalActualFluids": 2000,
        "fluidReconciliation": {
          "highTempThreshold": 10000,
          "rawFluidDelta": 0,
          "reconciledFluidLoss": 0,
          "lowTempLoss": 0,
          "highTempReconciledLoss": 0,
          "fluidPreservedPct": 100,
          "highTempAggregates": {}
        },
        "sourceVerificationFluidCounts": {
          "steam@332.5C": 2000
        }
      },
      "old_gate_simulation": {
        "would_false_fail": false,
        "false_fail_keys": []
      },
      "aggregates": {
        "expectedByName": {
          "steam": 2000
        },
        "actualByName": {
          "steam": 2000
        }
      },
      "source_cross_check": {
        "verification_fluid_counts": {
          "steam@332.5C": 2000
        },
        "matches_import_expected": true
      },
      "assertions": {
        "new_gate_passed_valid_transfer": true,
        "old_gate_would_false_fail": false
      },
      "conclusion": "R10b PASS: valid mixed-temp transfer passed; old exact-key gate would NOT have false-failed this measured export/import pair, so #76 is defensive for this case rather than proven necessary."
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 3271499,
        "game_paused": false
      },
      "dest": {
        "success": true,
        "deleted": {},
        "tick": 3204761,
        "game_paused": false
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 3271640,
        "game_paused": false,
        "zero_surfaces": true,
        "leftovers": {},
        "zero_storage": true,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0
      },
      "dest": {
        "success": true,
        "tick": 3204903,
        "game_paused": false,
        "zero_surfaces": true,
        "leftovers": {},
        "zero_storage": true,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 3271709,
      "base": "2.0.77"
    },
    "dest": {
      "success": true,
      "tick": 3204972,
      "base": "2.0.77"
    }
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 3272729,
        "game_paused": false
      },
      "dest": {
        "success": true,
        "deleted": [
          {
            "name": "fluid-lab-r10a-1783538306364",
            "ok": true
          },
          {
            "name": "fluid-lab-r10b-1783538313161",
            "ok": true
          }
        ],
        "tick": 3206009,
        "game_paused": false
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 3272871,
        "game_paused": false,
        "zero_surfaces": true,
        "leftovers": {},
        "zero_storage": true,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0
      },
      "dest": {
        "success": true,
        "tick": 3206154,
        "game_paused": false,
        "zero_surfaces": true,
        "leftovers": {},
        "zero_storage": true,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0
      }
    },
    "ok": true
  },
  "finished": "2026-07-08T19:18:46.992Z"
}
```

## 2026-07-08 - R10a/R10b conclusion summary

R10a/R10b were run twice consecutively via `node tests/fluid-lab/run-r10.mjs --sections r10a,r10b` after one focused `--no-notebook` shakeout pass. Both evidence passes ended with host-1 and host-2 zero-leftover checks green: no lab surfaces, `storage.fluid_lab` cleared, `storage.destination_holds=0`, `storage.locked_platforms=0`, `storage.committed_source_transfer_tombstones=0`, and `game.tick_paused=false`.

Conclusions:
- R10a: fixed `steam@165.0C = 2000` reproduced exactly through the real transfer path; new composite gate passed.
- R10b: `1000` steam at `165C` + `1000` steam at `500C` equilibrated in the storage-tank segment before export to `steam@332.5C = 2000`; source verification, destination expected, destination actual, direct meter, and segment meter all matched.
- Old-gate simulation: no false-fail in this measured R10b case. #76 remains defensive for this case, not proven necessary by R10b.
- R10c/R10d were not run.
