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


## 2026-07-10T04:59:16.973Z - R11 frozen-injection lab (sections=r11a,r11b,r11c,r11d)

Prediction: **zero fluid loss and zero fluid gain at every rung**.

```json
{
  "script": "tests/fluid-lab/run-r11.mjs",
  "started": "2026-07-10T04:58:38.116Z",
  "sections": [
    "r11a",
    "r11b",
    "r11c",
    "r11d"
  ],
  "prediction": "ZERO fluid loss and ZERO fluid gain at every R11 rung",
  "epsilon": 0.000001,
  "rungs": {
    "r11a": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "cases": [
        {
          "machines": false,
          "name": "fluid-lab-r11-a-control-1783659526620",
          "setup": {
            "success": true,
            "inserted": 2000,
            "platform": 4,
            "read": {
              "success": true,
              "label": "same-tick frozen",
              "tick": 180096,
              "game_paused": false,
              "platform_paused": true,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 15654,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 114,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15657,
                  "index": 1,
                  "segment_id": 115,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15656,
                  "index": 1,
                  "segment_id": 115
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15655,
                  "index": 1,
                  "segment_id": 115
                }
              ],
              "entity_states": {}
            }
          },
          "activation": {
            "success": true,
            "tick": 180157,
            "changed": 0,
            "read": {
              "success": true,
              "label": "activation same tick",
              "tick": 180157,
              "game_paused": false,
              "platform_paused": false,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 15654,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 114,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15657,
                  "index": 1,
                  "segment_id": 115,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15656,
                  "index": 1,
                  "segment_id": 115
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15655,
                  "index": 1,
                  "segment_id": 115
                }
              ],
              "entity_states": {}
            }
          },
          "after": {
            "success": true,
            "label": "activation +60",
            "tick": 180270,
            "game_paused": false,
            "platform_paused": false,
            "totals": {
              "water": 2000
            },
            "boxes": [
              {
                "entity": "storage-tank",
                "type": "storage-tank",
                "unit_number": 15654,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 2000,
                  "temperature": 25
                },
                "segment_id": 114,
                "segment_contents": {
                  "water": 2000
                }
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 15657,
                "index": 1,
                "segment_id": 115,
                "segment_contents": {}
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 15656,
                "index": 1,
                "segment_id": 115
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 15655,
                "index": 1,
                "segment_id": 115
              }
            ],
            "entity_states": {}
          },
          "activation_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          },
          "after_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          }
        },
        {
          "machines": true,
          "name": "fluid-lab-r11-a-machines-1783659530182",
          "setup": {
            "success": true,
            "inserted": 2000,
            "platform": 5,
            "read": {
              "success": true,
              "label": "same-tick frozen",
              "tick": 180316,
              "game_paused": false,
              "platform_paused": true,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 15659,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 116,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15662,
                  "index": 1,
                  "segment_id": 117,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15661,
                  "index": 1,
                  "segment_id": 117
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15660,
                  "index": 1,
                  "segment_id": 117
                },
                {
                  "entity": "pump",
                  "type": "pump",
                  "unit_number": 15663,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 15664,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 15664,
                  "index": 2
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 15664,
                  "index": 3
                }
              ],
              "entity_states": [
                {
                  "entity": "pump",
                  "unit_number": 15663,
                  "active": false,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                },
                {
                  "entity": "chemical-plant",
                  "unit_number": 15664,
                  "active": false,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                }
              ]
            }
          },
          "activation": {
            "success": true,
            "tick": 180370,
            "changed": 2,
            "read": {
              "success": true,
              "label": "activation same tick",
              "tick": 180370,
              "game_paused": false,
              "platform_paused": false,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 15659,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 116,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15662,
                  "index": 1,
                  "segment_id": 117,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15661,
                  "index": 1,
                  "segment_id": 117
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15660,
                  "index": 1,
                  "segment_id": 117
                },
                {
                  "entity": "pump",
                  "type": "pump",
                  "unit_number": 15663,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 15664,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 15664,
                  "index": 2
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 15664,
                  "index": 3
                }
              ],
              "entity_states": [
                {
                  "entity": "pump",
                  "unit_number": 15663,
                  "active": true,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                },
                {
                  "entity": "chemical-plant",
                  "unit_number": 15664,
                  "active": true,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                }
              ]
            }
          },
          "after": {
            "success": true,
            "label": "activation +60",
            "tick": 180492,
            "game_paused": false,
            "platform_paused": false,
            "totals": {
              "water": 2000
            },
            "boxes": [
              {
                "entity": "storage-tank",
                "type": "storage-tank",
                "unit_number": 15659,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 2000,
                  "temperature": 25
                },
                "segment_id": 116,
                "segment_contents": {
                  "water": 2000
                }
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 15662,
                "index": 1,
                "segment_id": 117,
                "segment_contents": {}
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 15661,
                "index": 1,
                "segment_id": 117
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 15660,
                "index": 1,
                "segment_id": 117
              },
              {
                "entity": "pump",
                "type": "pump",
                "unit_number": 15663,
                "index": 1
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 15664,
                "index": 1
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 15664,
                "index": 2
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 15664,
                "index": 3
              }
            ],
            "entity_states": [
              {
                "entity": "pump",
                "unit_number": 15663,
                "active": true,
                "frozen": {
                  "ok": true,
                  "value": false
                }
              },
              {
                "entity": "chemical-plant",
                "unit_number": 15664,
                "active": true,
                "frozen": {
                  "ok": true,
                  "value": false
                }
              }
            ]
          },
          "activation_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          },
          "after_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          }
        }
      ]
    },
    "r11b": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-b-1783659533654",
      "setup": {
        "success": true,
        "platform": 6,
        "writes": [
          {
            "entity": "storage-tank",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 98.81422919034958,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 98.81422919034958,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "pump",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 60,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 60,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 2,
            "write": {
              "accepted": true,
              "fluid": "heavy-oil",
              "amount": 80,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true
                },
                {
                  "fluid": "heavy-oil",
                  "ok": true,
                  "read": {
                    "name": "heavy-oil",
                    "amount": 80,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 3,
            "write": {
              "accepted": true,
              "fluid": "light-oil",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true
                },
                {
                  "fluid": "heavy-oil",
                  "ok": true
                },
                {
                  "fluid": "light-oil",
                  "ok": true,
                  "read": {
                    "name": "light-oil",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "boiler",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "boiler",
            "index": 2,
            "write": {
              "accepted": true,
              "fluid": "steam",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true,
                  "read": {
                    "name": "steam",
                    "amount": 100,
                    "temperature": 165
                  }
                }
              ]
            }
          }
        ],
        "read": {
          "success": true,
          "label": "R11b frozen same tick",
          "tick": 180544,
          "game_paused": false,
          "platform_paused": true,
          "totals": {
            "water": 260,
            "heavy-oil": 80,
            "light-oil": 100,
            "steam": 100
          },
          "boxes": [
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 15666,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 98.81422919034958,
                "temperature": 25
              },
              "segment_id": 118,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15669,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 118
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15667,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 118
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 15670,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15668,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 118
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15671,
              "index": 1,
              "segment_id": 119,
              "segment_contents": {}
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15672,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 60,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15672,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 80,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15672,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15673,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 120,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15673,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 100,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 15670,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 15672,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 15673,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "activation": {
        "success": true,
        "tick": 180597,
        "changed": 3,
        "read": {
          "success": true,
          "label": "R11b activation same tick",
          "tick": 180597,
          "game_paused": false,
          "platform_paused": false,
          "totals": {
            "water": 260,
            "heavy-oil": 80,
            "light-oil": 100,
            "steam": 100
          },
          "boxes": [
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 15666,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 98.81422919034958,
                "temperature": 25
              },
              "segment_id": 118,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15669,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 118
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15667,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 118
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 15670,
              "index": 1
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15668,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 118
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15671,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 119,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15672,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 60,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15672,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 80,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15672,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15673,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 120,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15673,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 100,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 15670,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 15672,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 15673,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "after": {
        "success": true,
        "label": "R11b activation +60",
        "tick": 180694,
        "game_paused": false,
        "platform_paused": false,
        "totals": {
          "water": 260,
          "heavy-oil": 80,
          "light-oil": 100,
          "steam": 100
        },
        "boxes": [
          {
            "entity": "storage-tank",
            "type": "storage-tank",
            "unit_number": 15666,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 98.81422919034958,
              "temperature": 25
            },
            "segment_id": 118,
            "segment_contents": {
              "water": 100
            }
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 15669,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 118
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 15667,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 118
          },
          {
            "entity": "pump",
            "type": "pump",
            "unit_number": 15670,
            "index": 1
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 15668,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 118
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 15671,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 100,
              "temperature": 25
            },
            "segment_id": 119,
            "segment_contents": {
              "water": 100
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 15672,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 60,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 15672,
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 80,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 15672,
            "index": 3,
            "direct": {
              "name": "light-oil",
              "amount": 100,
              "temperature": 25
            }
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 15673,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 100,
              "temperature": 25
            },
            "segment_id": 120,
            "segment_contents": {}
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 15673,
            "index": 2,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 165
            }
          }
        ],
        "entity_states": [
          {
            "entity": "pump",
            "unit_number": 15670,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "chemical-plant",
            "unit_number": 15672,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "boiler",
            "unit_number": 15673,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          }
        ]
      },
      "immediate_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 260,
            "actual": 260,
            "delta": 0
          }
        ]
      },
      "settled_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 260,
            "actual": 260,
            "delta": 0
          }
        ]
      }
    },
    "r11c": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-c-1783659536788",
      "import_state_replication": {
        "entity_creation": "module/import_phases/entity_creation.lua:69 creates through Deserializer; lines 78-91 immediately set active=false for transfer entities",
        "platform_pause": "module/core/import-pipeline.lua:240-245 pauses the transfer platform immediately after creation"
      },
      "setup": {
        "success": true,
        "platform": 7,
        "rows": [
          {
            "name": "pipe",
            "type": "pipe",
            "activatable": false,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 180748
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 180748
            }
          },
          {
            "name": "storage-tank",
            "type": "storage-tank",
            "activatable": false,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 180748
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 180748
            }
          },
          {
            "name": "pump",
            "type": "pump",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 180748
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 180748
            }
          },
          {
            "name": "chemical-plant",
            "type": "assembling-machine",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 180748
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 2,
                "write": {
                  "accepted": true,
                  "fluid": "heavy-oil",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true
                    },
                    {
                      "fluid": "heavy-oil",
                      "ok": true,
                      "read": {
                        "name": "heavy-oil",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 3,
                "write": {
                  "accepted": true,
                  "fluid": "light-oil",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true
                    },
                    {
                      "fluid": "heavy-oil",
                      "ok": true
                    },
                    {
                      "fluid": "light-oil",
                      "ok": true,
                      "read": {
                        "name": "light-oil",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 180748
            }
          },
          {
            "name": "boiler",
            "type": "boiler",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 180748
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 2,
                "write": {
                  "accepted": true,
                  "fluid": "steam",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true,
                      "read": {
                        "name": "steam",
                        "amount": 50,
                        "temperature": 165
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 180748
            }
          }
        ],
        "read": {
          "success": true,
          "label": "R11c before first activation",
          "tick": 180748,
          "game_paused": false,
          "platform_paused": true,
          "totals": {
            "water": 200,
            "heavy-oil": 50,
            "light-oil": 50,
            "steam": 50
          },
          "boxes": [
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15675,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 121,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 15676,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 122,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 15677,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15678,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15678,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15678,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15679,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 123,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15679,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 50,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 15677,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 15678,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 15679,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "activation": {
        "success": true,
        "tick": 180805,
        "changed": 3,
        "read": {
          "success": true,
          "label": "R11c activation same tick",
          "tick": 180805,
          "game_paused": false,
          "platform_paused": false,
          "totals": {
            "water": 200,
            "heavy-oil": 50,
            "light-oil": 50,
            "steam": 50
          },
          "boxes": [
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15675,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 121,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 15676,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 122,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 15677,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15678,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15678,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15678,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15679,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 123,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15679,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 50,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 15677,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 15678,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 15679,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "after": {
        "success": true,
        "label": "R11c activation +60",
        "tick": 180903,
        "game_paused": false,
        "platform_paused": false,
        "totals": {
          "water": 200,
          "heavy-oil": 50,
          "light-oil": 50,
          "steam": 50
        },
        "boxes": [
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 15675,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 121,
            "segment_contents": {
              "water": 50
            }
          },
          {
            "entity": "storage-tank",
            "type": "storage-tank",
            "unit_number": 15676,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 122,
            "segment_contents": {
              "water": 50
            }
          },
          {
            "entity": "pump",
            "type": "pump",
            "unit_number": 15677,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 15678,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 15678,
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 15678,
            "index": 3,
            "direct": {
              "name": "light-oil",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 15679,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 123,
            "segment_contents": {}
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 15679,
            "index": 2,
            "direct": {
              "name": "steam",
              "amount": 50,
              "temperature": 165
            }
          }
        ],
        "entity_states": [
          {
            "entity": "pump",
            "unit_number": 15677,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "chemical-plant",
            "unit_number": 15678,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "boiler",
            "unit_number": 15679,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          }
        ]
      },
      "immediate_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 200,
            "actual": 200,
            "delta": 0
          }
        ]
      },
      "settled_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 200,
            "actual": 200,
            "delta": 0
          }
        ]
      }
    },
    "r11d": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-d-1783659540034",
      "seed": {
        "success": true,
        "index": 2,
        "count": 1
      },
      "clone": {
        "success": true,
        "tick": 180999,
        "remote": {
          "success": true,
          "job_id": "import_3",
          "platform_name": "fluid-lab-r11-d-1783659540034",
          "source_platform": "test",
          "entity_count": 1359,
          "message": "Clone job started - use /step-tick to process"
        }
      },
      "clone_index": 8,
      "armed": {
        "success": true,
        "tick": 123330
      },
      "transfer_output": "═══════════════════════════════════════\n🚀 Transfer Platform: fluid-lab-r11-d-1783659540034\n═══════════════════════════════════════\nDestination: Instance 1351385547\nPlatform: [8] fluid-lab-r11-d-1783659540034\n\n[1/2] Locking + queueing export...\n[2/2] ✓ Export queued: 004_fluid-lab-r11-d-1783659540034\n⏳ Exporting asynchronously (this may take a while)...\n\nThe transfer will continue automatically:\n  1. Export completes → Sent to controller\n  2. Controller → Sends to destination instance\n  3. Destination imports → Validates counts\n  4. On success → Source deleted automatically\n  5. On failure → Source unlocked automatically\n\n💡 Use /list-platforms to track progress\n═══════════════════════════════════════",
      "wall_ms": 6691,
      "debug_file": "/clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_fluid-lab-r11-d-1783659540034_123530.json",
      "validation_success": true,
      "failed_stage": null,
      "hook_log": {
        "needle": "[Import][TEST][R11] Frozen fluid injection measured for fluid-lab-r11-d-1783659540034",
        "found": true,
        "line": "95.860 Script @__level__/modules/surface_export/core/import-completion.lua:358: [Import][TEST][R11] Frozen fluid injection measured for fluid-lab-r11-d-1783659540034 at tick 123530"
      },
      "measurement": {
        "hook_consumed": true,
        "platform_name": "fluid-lab-r11-d-1783659540034",
        "injection_started_tick": 123530,
        "frozen_census_tick": 123530,
        "platform_paused": true,
        "expected_by_name": {
          "molten-iron": 1041.3721179962158,
          "thruster-fuel": 37180.338448643684,
          "thruster-oxidizer": 37239.10695910454,
          "water": 52739.19101476669,
          "fluoroketone-cold": 223.25008112192154,
          "fluoroketone-hot": 0.06601643562316895,
          "fusion-plasma": 80,
          "molten-copper": 1885
        },
        "expected_raw": {
          "molten-iron@1500.0C": 1041.3721179962158,
          "thruster-fuel@25.0C": 37180.338448643684,
          "thruster-oxidizer@25.0C": 37239.10695910454,
          "water@15.0C": 52739.19101476669,
          "fluoroketone-cold@-150.0C": 223.25008112192154,
          "fluoroketone-hot@180.0C": 0.06601643562316895,
          "fusion-plasma@1081309.3C": 0,
          "fusion-plasma@1167510.5C": 0,
          "molten-copper@1100.0C": 1885,
          "fusion-plasma@1954769.6C": 10,
          "fusion-plasma@1167509.5C": 10,
          "fusion-plasma@1081321.8C": 10,
          "fusion-plasma@1079336.5C": 10,
          "fusion-plasma@1163717.6C": 10,
          "fusion-plasma@1957761.4C": 10,
          "fusion-plasma@1163716.9C": 10,
          "fusion-plasma@1079374.3C": 10
        },
        "frozen_actual_raw": {
          "fluoroketone-hot@180.0C": 0.06601643562316895,
          "fusion-plasma@1081309.3C": 10,
          "fusion-plasma@1167510.5C": 10,
          "fluoroketone-cold@-150.0C": 223.25008112192154,
          "fusion-plasma@1081321.8C": 10,
          "fusion-plasma@1167509.5C": 10,
          "molten-iron@1500.0C": 1041.3721179962158,
          "water@15.0C": 52739.19101476669,
          "molten-copper@1100.0C": 1885,
          "thruster-fuel@25.0C": 37180.338448643684,
          "thruster-oxidizer@25.0C": 37239.10695910454,
          "fusion-plasma@1079336.5C": 10,
          "fusion-plasma@1163717.6C": 10,
          "fusion-plasma@1079374.3C": 10,
          "fusion-plasma@1163716.9C": 10
        },
        "frozen_actual_by_name": {
          "fluoroketone-hot": 0.06601643562316895,
          "fusion-plasma": 80,
          "fluoroketone-cold": 223.25008112192154,
          "molten-iron": 1041.3721179962158,
          "water": 52739.19101476669,
          "molten-copper": 1885,
          "thruster-fuel": 37180.338448643684,
          "thruster-oxidizer": 37239.10695910454
        },
        "frozen_actual_total": 130388.32463806868,
        "write_rejected": {
          "fusion-plasma": 20
        },
        "activation_census_tick": 123530,
        "post_activation_actual_by_name": {
          "fluoroketone-hot": 0.06601643562316895,
          "fusion-plasma": 80,
          "fluoroketone-cold": 223.25008112192154,
          "molten-iron": 1041.3721179962158,
          "water": 52739.19101476669,
          "molten-copper": 1885,
          "thruster-fuel": 37180.338448643684,
          "thruster-oxidizer": 37239.10695910454
        },
        "post_activation_actual_raw": {
          "fluoroketone-hot@180.0C": 0.06601643562316895,
          "fusion-plasma@1081309.3C": 10,
          "fusion-plasma@1167510.5C": 10,
          "fluoroketone-cold@-150.0C": 223.25008112192154,
          "fusion-plasma@1081321.8C": 10,
          "fusion-plasma@1167509.5C": 10,
          "molten-iron@1500.0C": 1041.3721179962158,
          "water@15.0C": 52739.19101476669,
          "molten-copper@1100.0C": 1885,
          "thruster-fuel@25.0C": 37180.338448643684,
          "thruster-oxidizer@25.0C": 37239.10695910454,
          "fusion-plasma@1079336.5C": 10,
          "fusion-plasma@1163717.6C": 10,
          "fusion-plasma@1079374.3C": 10,
          "fusion-plasma@1163716.9C": 10
        },
        "post_activation_actual_total": 130388.32463806868
      },
      "frozen_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "fluoroketone-cold",
            "expected": 223.25008112192154,
            "actual": 223.25008112192154,
            "delta": 0
          },
          {
            "name": "fluoroketone-hot",
            "expected": 0.06601643562316895,
            "actual": 0.06601643562316895,
            "delta": 0
          },
          {
            "name": "fusion-plasma",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "molten-copper",
            "expected": 1885,
            "actual": 1885,
            "delta": 0
          },
          {
            "name": "molten-iron",
            "expected": 1041.3721179962158,
            "actual": 1041.3721179962158,
            "delta": 0
          },
          {
            "name": "thruster-fuel",
            "expected": 37180.338448643684,
            "actual": 37180.338448643684,
            "delta": 0
          },
          {
            "name": "thruster-oxidizer",
            "expected": 37239.10695910454,
            "actual": 37239.10695910454,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 52739.19101476669,
            "actual": 52739.19101476669,
            "delta": 0
          }
        ]
      },
      "post_activation_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "fluoroketone-cold",
            "expected": 223.25008112192154,
            "actual": 223.25008112192154,
            "delta": 0
          },
          {
            "name": "fluoroketone-hot",
            "expected": 0.06601643562316895,
            "actual": 0.06601643562316895,
            "delta": 0
          },
          {
            "name": "fusion-plasma",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "molten-copper",
            "expected": 1885,
            "actual": 1885,
            "delta": 0
          },
          {
            "name": "molten-iron",
            "expected": 1041.3721179962158,
            "actual": 1041.3721179962158,
            "delta": 0
          },
          {
            "name": "thruster-fuel",
            "expected": 37180.338448643684,
            "actual": 37180.338448643684,
            "delta": 0
          },
          {
            "name": "thruster-oxidizer",
            "expected": 37239.10695910454,
            "actual": 37239.10695910454,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 52739.19101476669,
            "actual": 52739.19101476669,
            "delta": 0
          }
        ]
      }
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 179668
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 121882
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 179890,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 122095,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 179995,
      "base": "2.0.77"
    },
    "destination": {
      "success": true,
      "tick": 122197,
      "base": "2.0.77"
    }
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "fluid-lab-r11-a-control-1783659526620",
          "fluid-lab-r11-a-machines-1783659530182",
          "fluid-lab-r11-b-1783659533654",
          "fluid-lab-r11-c-1783659536788"
        ],
        "tick": 181639
      },
      "destination": {
        "success": true,
        "deleted": [
          "fluid-lab-r11-d-1783659540034"
        ],
        "tick": 123928
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 181836,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 124120,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T04:59:16.973Z"
}
```


## 2026-07-10T05:00:00.445Z - R11 frozen-injection lab (sections=r11a,r11b,r11c,r11d)

Prediction: **zero fluid loss and zero fluid gain at every rung**.

```json
{
  "script": "tests/fluid-lab/run-r11.mjs",
  "started": "2026-07-10T04:59:22.599Z",
  "sections": [
    "r11a",
    "r11b",
    "r11c",
    "r11d"
  ],
  "prediction": "ZERO fluid loss and ZERO fluid gain at every R11 rung",
  "epsilon": 0.000001,
  "rungs": {
    "r11a": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "cases": [
        {
          "machines": false,
          "name": "fluid-lab-r11-a-control-1783659570221",
          "setup": {
            "success": true,
            "inserted": 2000,
            "platform": 9,
            "read": {
              "success": true,
              "label": "same-tick frozen",
              "tick": 182779,
              "game_paused": false,
              "platform_paused": true,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 17039,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 194,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17042,
                  "index": 1,
                  "segment_id": 195,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17041,
                  "index": 1,
                  "segment_id": 195
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17040,
                  "index": 1,
                  "segment_id": 195
                }
              ],
              "entity_states": {}
            }
          },
          "activation": {
            "success": true,
            "tick": 182837,
            "changed": 0,
            "read": {
              "success": true,
              "label": "activation same tick",
              "tick": 182837,
              "game_paused": false,
              "platform_paused": false,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 17039,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 194,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17042,
                  "index": 1,
                  "segment_id": 195,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17041,
                  "index": 1,
                  "segment_id": 195
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17040,
                  "index": 1,
                  "segment_id": 195
                }
              ],
              "entity_states": {}
            }
          },
          "after": {
            "success": true,
            "label": "activation +60",
            "tick": 182940,
            "game_paused": false,
            "platform_paused": false,
            "totals": {
              "water": 2000
            },
            "boxes": [
              {
                "entity": "storage-tank",
                "type": "storage-tank",
                "unit_number": 17039,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 2000,
                  "temperature": 25
                },
                "segment_id": 194,
                "segment_contents": {
                  "water": 2000
                }
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 17042,
                "index": 1,
                "segment_id": 195,
                "segment_contents": {}
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 17041,
                "index": 1,
                "segment_id": 195
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 17040,
                "index": 1,
                "segment_id": 195
              }
            ],
            "entity_states": {}
          },
          "activation_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          },
          "after_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          }
        },
        {
          "machines": true,
          "name": "fluid-lab-r11-a-machines-1783659573493",
          "setup": {
            "success": true,
            "inserted": 2000,
            "platform": 10,
            "read": {
              "success": true,
              "label": "same-tick frozen",
              "tick": 182994,
              "game_paused": false,
              "platform_paused": true,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 17044,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 196,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17047,
                  "index": 1,
                  "segment_id": 197,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17046,
                  "index": 1,
                  "segment_id": 197
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17045,
                  "index": 1,
                  "segment_id": 197
                },
                {
                  "entity": "pump",
                  "type": "pump",
                  "unit_number": 17048,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 17049,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 17049,
                  "index": 2
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 17049,
                  "index": 3
                }
              ],
              "entity_states": [
                {
                  "entity": "pump",
                  "unit_number": 17048,
                  "active": false,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                },
                {
                  "entity": "chemical-plant",
                  "unit_number": 17049,
                  "active": false,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                }
              ]
            }
          },
          "activation": {
            "success": true,
            "tick": 183051,
            "changed": 2,
            "read": {
              "success": true,
              "label": "activation same tick",
              "tick": 183051,
              "game_paused": false,
              "platform_paused": false,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 17044,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 196,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17047,
                  "index": 1,
                  "segment_id": 197,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17046,
                  "index": 1,
                  "segment_id": 197
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17045,
                  "index": 1,
                  "segment_id": 197
                },
                {
                  "entity": "pump",
                  "type": "pump",
                  "unit_number": 17048,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 17049,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 17049,
                  "index": 2
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 17049,
                  "index": 3
                }
              ],
              "entity_states": [
                {
                  "entity": "pump",
                  "unit_number": 17048,
                  "active": true,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                },
                {
                  "entity": "chemical-plant",
                  "unit_number": 17049,
                  "active": true,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                }
              ]
            }
          },
          "after": {
            "success": true,
            "label": "activation +60",
            "tick": 183150,
            "game_paused": false,
            "platform_paused": false,
            "totals": {
              "water": 2000
            },
            "boxes": [
              {
                "entity": "storage-tank",
                "type": "storage-tank",
                "unit_number": 17044,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 2000,
                  "temperature": 25
                },
                "segment_id": 196,
                "segment_contents": {
                  "water": 2000
                }
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 17047,
                "index": 1,
                "segment_id": 197,
                "segment_contents": {}
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 17046,
                "index": 1,
                "segment_id": 197
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 17045,
                "index": 1,
                "segment_id": 197
              },
              {
                "entity": "pump",
                "type": "pump",
                "unit_number": 17048,
                "index": 1
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 17049,
                "index": 1
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 17049,
                "index": 2
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 17049,
                "index": 3
              }
            ],
            "entity_states": [
              {
                "entity": "pump",
                "unit_number": 17048,
                "active": true,
                "frozen": {
                  "ok": true,
                  "value": false
                }
              },
              {
                "entity": "chemical-plant",
                "unit_number": 17049,
                "active": true,
                "frozen": {
                  "ok": true,
                  "value": false
                }
              }
            ]
          },
          "activation_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          },
          "after_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          }
        }
      ]
    },
    "r11b": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-b-1783659576772",
      "setup": {
        "success": true,
        "platform": 11,
        "writes": [
          {
            "entity": "storage-tank",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 98.81422919034958,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 98.81422919034958,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "pump",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 60,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 60,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 2,
            "write": {
              "accepted": true,
              "fluid": "heavy-oil",
              "amount": 80,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true
                },
                {
                  "fluid": "heavy-oil",
                  "ok": true,
                  "read": {
                    "name": "heavy-oil",
                    "amount": 80,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 3,
            "write": {
              "accepted": true,
              "fluid": "light-oil",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true
                },
                {
                  "fluid": "heavy-oil",
                  "ok": true
                },
                {
                  "fluid": "light-oil",
                  "ok": true,
                  "read": {
                    "name": "light-oil",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "boiler",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "boiler",
            "index": 2,
            "write": {
              "accepted": true,
              "fluid": "steam",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true,
                  "read": {
                    "name": "steam",
                    "amount": 100,
                    "temperature": 165
                  }
                }
              ]
            }
          }
        ],
        "read": {
          "success": true,
          "label": "R11b frozen same tick",
          "tick": 183207,
          "game_paused": false,
          "platform_paused": true,
          "totals": {
            "water": 260,
            "heavy-oil": 80,
            "light-oil": 100,
            "steam": 100
          },
          "boxes": [
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 17051,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 98.81422919034958,
                "temperature": 25
              },
              "segment_id": 198,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17054,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 198
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17052,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 198
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 17055,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17053,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 198
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17056,
              "index": 1,
              "segment_id": 199,
              "segment_contents": {}
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17057,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 60,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17057,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 80,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17057,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17058,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 200,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17058,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 100,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 17055,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 17057,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 17058,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "activation": {
        "success": true,
        "tick": 183258,
        "changed": 3,
        "read": {
          "success": true,
          "label": "R11b activation same tick",
          "tick": 183258,
          "game_paused": false,
          "platform_paused": false,
          "totals": {
            "water": 260,
            "heavy-oil": 80,
            "light-oil": 100,
            "steam": 100
          },
          "boxes": [
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 17051,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 98.81422919034958,
                "temperature": 25
              },
              "segment_id": 198,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17054,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 198
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17052,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 198
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 17055,
              "index": 1
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17053,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 198
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17056,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 199,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17057,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 60,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17057,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 80,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17057,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17058,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 200,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17058,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 100,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 17055,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 17057,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 17058,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "after": {
        "success": true,
        "label": "R11b activation +60",
        "tick": 183349,
        "game_paused": false,
        "platform_paused": false,
        "totals": {
          "water": 260,
          "heavy-oil": 80,
          "light-oil": 100,
          "steam": 100
        },
        "boxes": [
          {
            "entity": "storage-tank",
            "type": "storage-tank",
            "unit_number": 17051,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 98.81422919034958,
              "temperature": 25
            },
            "segment_id": 198,
            "segment_contents": {
              "water": 100
            }
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 17054,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 198
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 17052,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 198
          },
          {
            "entity": "pump",
            "type": "pump",
            "unit_number": 17055,
            "index": 1
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 17053,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 198
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 17056,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 100,
              "temperature": 25
            },
            "segment_id": 199,
            "segment_contents": {
              "water": 100
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 17057,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 60,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 17057,
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 80,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 17057,
            "index": 3,
            "direct": {
              "name": "light-oil",
              "amount": 100,
              "temperature": 25
            }
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 17058,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 100,
              "temperature": 25
            },
            "segment_id": 200,
            "segment_contents": {}
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 17058,
            "index": 2,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 165
            }
          }
        ],
        "entity_states": [
          {
            "entity": "pump",
            "unit_number": 17055,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "chemical-plant",
            "unit_number": 17057,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "boiler",
            "unit_number": 17058,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          }
        ]
      },
      "immediate_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 260,
            "actual": 260,
            "delta": 0
          }
        ]
      },
      "settled_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 260,
            "actual": 260,
            "delta": 0
          }
        ]
      }
    },
    "r11c": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-c-1783659579974",
      "import_state_replication": {
        "entity_creation": "module/import_phases/entity_creation.lua:69 creates through Deserializer; lines 78-91 immediately set active=false for transfer entities",
        "platform_pause": "module/core/import-pipeline.lua:240-245 pauses the transfer platform immediately after creation"
      },
      "setup": {
        "success": true,
        "platform": 12,
        "rows": [
          {
            "name": "pipe",
            "type": "pipe",
            "activatable": false,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 183403
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 183403
            }
          },
          {
            "name": "storage-tank",
            "type": "storage-tank",
            "activatable": false,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 183403
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 183403
            }
          },
          {
            "name": "pump",
            "type": "pump",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 183403
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 183403
            }
          },
          {
            "name": "chemical-plant",
            "type": "assembling-machine",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 183403
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 2,
                "write": {
                  "accepted": true,
                  "fluid": "heavy-oil",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true
                    },
                    {
                      "fluid": "heavy-oil",
                      "ok": true,
                      "read": {
                        "name": "heavy-oil",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 3,
                "write": {
                  "accepted": true,
                  "fluid": "light-oil",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true
                    },
                    {
                      "fluid": "heavy-oil",
                      "ok": true
                    },
                    {
                      "fluid": "light-oil",
                      "ok": true,
                      "read": {
                        "name": "light-oil",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 183403
            }
          },
          {
            "name": "boiler",
            "type": "boiler",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 183403
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 2,
                "write": {
                  "accepted": true,
                  "fluid": "steam",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true,
                      "read": {
                        "name": "steam",
                        "amount": 50,
                        "temperature": 165
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 183403
            }
          }
        ],
        "read": {
          "success": true,
          "label": "R11c before first activation",
          "tick": 183403,
          "game_paused": false,
          "platform_paused": true,
          "totals": {
            "water": 200,
            "heavy-oil": 50,
            "light-oil": 50,
            "steam": 50
          },
          "boxes": [
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17060,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 201,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 17061,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 202,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 17062,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17063,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17063,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17063,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17064,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 203,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17064,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 50,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 17062,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 17063,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 17064,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "activation": {
        "success": true,
        "tick": 183457,
        "changed": 3,
        "read": {
          "success": true,
          "label": "R11c activation same tick",
          "tick": 183457,
          "game_paused": false,
          "platform_paused": false,
          "totals": {
            "water": 200,
            "heavy-oil": 50,
            "light-oil": 50,
            "steam": 50
          },
          "boxes": [
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17060,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 201,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 17061,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 202,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 17062,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17063,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17063,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17063,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17064,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 203,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17064,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 50,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 17062,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 17063,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 17064,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "after": {
        "success": true,
        "label": "R11c activation +60",
        "tick": 183554,
        "game_paused": false,
        "platform_paused": false,
        "totals": {
          "water": 200,
          "heavy-oil": 50,
          "light-oil": 50,
          "steam": 50
        },
        "boxes": [
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 17060,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 201,
            "segment_contents": {
              "water": 50
            }
          },
          {
            "entity": "storage-tank",
            "type": "storage-tank",
            "unit_number": 17061,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 202,
            "segment_contents": {
              "water": 50
            }
          },
          {
            "entity": "pump",
            "type": "pump",
            "unit_number": 17062,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 17063,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 17063,
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 17063,
            "index": 3,
            "direct": {
              "name": "light-oil",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 17064,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 203,
            "segment_contents": {}
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 17064,
            "index": 2,
            "direct": {
              "name": "steam",
              "amount": 50,
              "temperature": 165
            }
          }
        ],
        "entity_states": [
          {
            "entity": "pump",
            "unit_number": 17062,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "chemical-plant",
            "unit_number": 17063,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "boiler",
            "unit_number": 17064,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          }
        ]
      },
      "immediate_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 200,
            "actual": 200,
            "delta": 0
          }
        ]
      },
      "settled_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 200,
            "actual": 200,
            "delta": 0
          }
        ]
      }
    },
    "r11d": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-d-1783659583093",
      "seed": {
        "success": true,
        "index": 2,
        "count": 1
      },
      "clone": {
        "success": true,
        "tick": 183653,
        "remote": {
          "success": true,
          "job_id": "import_5",
          "platform_name": "fluid-lab-r11-d-1783659583093",
          "source_platform": "test",
          "entity_count": 1359,
          "message": "Clone job started - use /step-tick to process"
        }
      },
      "clone_index": 13,
      "armed": {
        "success": true,
        "tick": 126082
      },
      "transfer_output": "═══════════════════════════════════════\n🚀 Transfer Platform: fluid-lab-r11-d-1783659583093\n═══════════════════════════════════════\nDestination: Instance 1351385547\nPlatform: [13] fluid-lab-r11-d-1783659583093\n\n[1/2] Locking + queueing export...\n[2/2] ✓ Export queued: 006_fluid-lab-r11-d-1783659583093\n⏳ Exporting asynchronously (this may take a while)...\n\nThe transfer will continue automatically:\n  1. Export completes → Sent to controller\n  2. Controller → Sends to destination instance\n  3. Destination imports → Validates counts\n  4. On success → Source deleted automatically\n  5. On failure → Source unlocked automatically\n\n💡 Use /list-platforms to track progress\n═══════════════════════════════════════",
      "wall_ms": 6842,
      "debug_file": "/clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_fluid-lab-r11-d-1783659583093_126290.json",
      "validation_success": true,
      "failed_stage": null,
      "hook_log": {
        "needle": "[Import][TEST][R11] Frozen fluid injection measured for fluid-lab-r11-d-1783659583093",
        "found": true,
        "line": "138.437 Script @__level__/modules/surface_export/core/import-completion.lua:358: [Import][TEST][R11] Frozen fluid injection measured for fluid-lab-r11-d-1783659583093 at tick 126290"
      },
      "measurement": {
        "hook_consumed": true,
        "platform_name": "fluid-lab-r11-d-1783659583093",
        "injection_started_tick": 126290,
        "frozen_census_tick": 126290,
        "platform_paused": true,
        "expected_by_name": {
          "thruster-fuel": 37207.93553030491,
          "thruster-oxidizer": 37266.64660573006,
          "water": 52741.08721733093,
          "fluoroketone-cold": 225.74026292562485,
          "molten-iron": 20,
          "fluoroketone-hot": 7.822311580181122,
          "fusion-plasma": 80,
          "molten-copper": 1865
        },
        "expected_raw": {
          "thruster-fuel@25.0C": 37207.93553030491,
          "thruster-oxidizer@25.0C": 37266.64660573006,
          "water@15.0C": 52741.08721733093,
          "fluoroketone-cold@-150.0C": 225.74026292562485,
          "molten-iron@1500.0C": 20,
          "fluoroketone-hot@180.0C": 7.822311580181122,
          "fusion-plasma@1078000.1C": 0,
          "fusion-plasma@1133709.0C": 0,
          "molten-copper@1100.0C": 1865,
          "fusion-plasma@1987980.5C": 10,
          "fusion-plasma@1133708.9C": 10,
          "fusion-plasma@1078011.1C": 10,
          "fusion-plasma@1076037.0C": 10,
          "fusion-plasma@1130066.0C": 10,
          "fusion-plasma@1988620.3C": 10,
          "fusion-plasma@1130065.1C": 10,
          "fusion-plasma@1076067.4C": 10
        },
        "frozen_actual_raw": {
          "fluoroketone-hot@180.0C": 7.822311580181122,
          "fusion-plasma@1078000.1C": 10,
          "fusion-plasma@1133709.0C": 10,
          "fluoroketone-cold@-150.0C": 225.74026292562485,
          "fusion-plasma@1078011.1C": 10,
          "fusion-plasma@1133708.9C": 10,
          "molten-iron@1500.0C": 20,
          "water@15.0C": 52741.08721733093,
          "molten-copper@1100.0C": 1865,
          "thruster-fuel@25.0C": 37207.93553030491,
          "thruster-oxidizer@25.0C": 37266.64660573006,
          "fusion-plasma@1076037.0C": 10,
          "fusion-plasma@1130066.0C": 10,
          "fusion-plasma@1076067.4C": 10,
          "fusion-plasma@1130065.1C": 10
        },
        "frozen_actual_by_name": {
          "fluoroketone-hot": 7.822311580181122,
          "fusion-plasma": 80,
          "fluoroketone-cold": 225.74026292562485,
          "molten-iron": 20,
          "water": 52741.08721733093,
          "molten-copper": 1865,
          "thruster-fuel": 37207.93553030491,
          "thruster-oxidizer": 37266.64660573006
        },
        "frozen_actual_total": 129414.2319278717,
        "write_rejected": {
          "fusion-plasma": 20
        },
        "activation_census_tick": 126290,
        "post_activation_actual_by_name": {
          "fluoroketone-hot": 7.822311580181122,
          "fusion-plasma": 80,
          "fluoroketone-cold": 225.74026292562485,
          "molten-iron": 20,
          "water": 52741.08721733093,
          "molten-copper": 1865,
          "thruster-fuel": 37207.93553030491,
          "thruster-oxidizer": 37266.64660573006
        },
        "post_activation_actual_raw": {
          "fluoroketone-hot@180.0C": 7.822311580181122,
          "fusion-plasma@1078000.1C": 10,
          "fusion-plasma@1133709.0C": 10,
          "fluoroketone-cold@-150.0C": 225.74026292562485,
          "fusion-plasma@1078011.1C": 10,
          "fusion-plasma@1133708.9C": 10,
          "molten-iron@1500.0C": 20,
          "water@15.0C": 52741.08721733093,
          "molten-copper@1100.0C": 1865,
          "thruster-fuel@25.0C": 37207.93553030491,
          "thruster-oxidizer@25.0C": 37266.64660573006,
          "fusion-plasma@1076037.0C": 10,
          "fusion-plasma@1130066.0C": 10,
          "fusion-plasma@1076067.4C": 10,
          "fusion-plasma@1130065.1C": 10
        },
        "post_activation_actual_total": 129414.2319278717
      },
      "frozen_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "fluoroketone-cold",
            "expected": 225.74026292562485,
            "actual": 225.74026292562485,
            "delta": 0
          },
          {
            "name": "fluoroketone-hot",
            "expected": 7.822311580181122,
            "actual": 7.822311580181122,
            "delta": 0
          },
          {
            "name": "fusion-plasma",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "molten-copper",
            "expected": 1865,
            "actual": 1865,
            "delta": 0
          },
          {
            "name": "molten-iron",
            "expected": 20,
            "actual": 20,
            "delta": 0
          },
          {
            "name": "thruster-fuel",
            "expected": 37207.93553030491,
            "actual": 37207.93553030491,
            "delta": 0
          },
          {
            "name": "thruster-oxidizer",
            "expected": 37266.64660573006,
            "actual": 37266.64660573006,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 52741.08721733093,
            "actual": 52741.08721733093,
            "delta": 0
          }
        ]
      },
      "post_activation_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "fluoroketone-cold",
            "expected": 225.74026292562485,
            "actual": 225.74026292562485,
            "delta": 0
          },
          {
            "name": "fluoroketone-hot",
            "expected": 7.822311580181122,
            "actual": 7.822311580181122,
            "delta": 0
          },
          {
            "name": "fusion-plasma",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "molten-copper",
            "expected": 1865,
            "actual": 1865,
            "delta": 0
          },
          {
            "name": "molten-iron",
            "expected": 20,
            "actual": 20,
            "delta": 0
          },
          {
            "name": "thruster-fuel",
            "expected": 37207.93553030491,
            "actual": 37207.93553030491,
            "delta": 0
          },
          {
            "name": "thruster-oxidizer",
            "expected": 37266.64660573006,
            "actual": 37266.64660573006,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 52741.08721733093,
            "actual": 52741.08721733093,
            "delta": 0
          }
        ]
      }
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 182386
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 124674
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 182581,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 124870,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 182681,
      "base": "2.0.77"
    },
    "destination": {
      "success": true,
      "tick": 124969,
      "base": "2.0.77"
    }
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "fluid-lab-r11-a-control-1783659570221",
          "fluid-lab-r11-a-machines-1783659573493",
          "fluid-lab-r11-b-1783659576772",
          "fluid-lab-r11-c-1783659579974"
        ],
        "tick": 184314
      },
      "destination": {
        "success": true,
        "deleted": [
          "fluid-lab-r11-d-1783659583093"
        ],
        "tick": 126700
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 184508,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 126885,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T05:00:00.445Z"
}
```

## 2026-07-10 - R11 frozen-world injection conclusion

Prediction: **zero fluid loss and zero fluid gain at every rung**.

Two consecutive full runs of `run-r11.mjs --sections r11a,r11b,r11c,r11d` completed at
`2026-07-10T04:59:16.973Z` and `2026-07-10T05:00:00.445Z`. Both ended with the seven-field
zero-leftover check green on host-1 and host-2: no R11 surfaces, no `storage.fluid_lab`, game unpaused,
zero destination holds, zero locked platforms, zero committed source tombstones, and zero R11
`storage.platform_exports` records.

- R11a: the 2,000-water pipe/tank control and the machine-present variant both retained exact totals in
  the frozen census, the same-tick activation census, and after 60 ticks.
- R11b: pump, pipes, chemical plant, and boiler accepted every intended fluidbox write while inactive.
  Water, heavy oil, light oil, and steam totals were exact immediately after activation and after 60 ticks.
- R11c: pipe, storage tank, pump, chemical plant, and boiler all accepted writes before first activation;
  no class needed the synchronous active-toggle fallback. This reproduces the import state documented in
  `module/import_phases/entity_creation.lua:69,78-91` (Deserializer creation followed immediately by
  `active=false` for transfer entities) and `module/core/import-pipeline.lua:240-245` (the transfer platform
  is paused immediately after creation).
- R11d: the one-shot unique-name hook positively fired in the destination Factorio log on both runs and
  called production `FluidRestoration.restore()` while the 1,359-entity clone remained paused/deactivated.
  All eight aggregate fluid names matched exactly at the frozen census and the same-tick post-activation
  census (`max |delta| = 0`, comparison epsilon `1e-6`). Full-precision raw temperature-keyed values were
  retained in the records. Each run measured 20 fusion-plasma units rejected by engine-managed output
  fluidboxes; subtracting those writes left 80 plasma restored and counted exactly.

Conclusion: on Factorio 2.0.77, the production restoration routine conserved every tested ordinary and
high-temperature fluid exactly when invoked in the frozen destination world. The historical pre-activation
loss did not reproduce in any isolated class or the real large-platform path. This is evidence for the next
gate-design adjudication, not a production ordering or validator change.


## 2026-07-10T05:03:56.146Z - R11 frozen-injection lab (sections=r11a,r11b,r11c,r11d)

Prediction: **zero fluid loss and zero fluid gain at every rung**.

```json
{
  "script": "tests/fluid-lab/run-r11.mjs",
  "started": "2026-07-10T05:03:18.788Z",
  "sections": [
    "r11a",
    "r11b",
    "r11c",
    "r11d"
  ],
  "prediction": "ZERO fluid loss and ZERO fluid gain at every R11 rung",
  "epsilon": 0.000001,
  "rungs": {
    "r11a": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "cases": [
        {
          "machines": false,
          "name": "fluid-lab-r11-a-control-1783659806383",
          "setup": {
            "success": true,
            "inserted": 2000,
            "platform": 3,
            "read": {
              "success": true,
              "label": "same-tick frozen",
              "tick": 178530,
              "game_paused": false,
              "platform_paused": true,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 14296,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 44,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 14299,
                  "index": 1,
                  "segment_id": 45,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 14298,
                  "index": 1,
                  "segment_id": 45
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 14297,
                  "index": 1,
                  "segment_id": 45
                }
              ],
              "entity_states": {}
            }
          },
          "activation": {
            "success": true,
            "tick": 178586,
            "changed": 0,
            "read": {
              "success": true,
              "label": "activation same tick",
              "tick": 178586,
              "game_paused": false,
              "platform_paused": false,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 14296,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 44,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 14299,
                  "index": 1,
                  "segment_id": 45,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 14298,
                  "index": 1,
                  "segment_id": 45
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 14297,
                  "index": 1,
                  "segment_id": 45
                }
              ],
              "entity_states": {}
            }
          },
          "after": {
            "success": true,
            "label": "activation +60",
            "tick": 178679,
            "game_paused": false,
            "platform_paused": false,
            "totals": {
              "water": 2000
            },
            "boxes": [
              {
                "entity": "storage-tank",
                "type": "storage-tank",
                "unit_number": 14296,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 2000,
                  "temperature": 25
                },
                "segment_id": 44,
                "segment_contents": {
                  "water": 2000
                }
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 14299,
                "index": 1,
                "segment_id": 45,
                "segment_contents": {}
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 14298,
                "index": 1,
                "segment_id": 45
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 14297,
                "index": 1,
                "segment_id": 45
              }
            ],
            "entity_states": {}
          },
          "activation_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          },
          "after_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          }
        },
        {
          "machines": true,
          "name": "fluid-lab-r11-a-machines-1783659809420",
          "setup": {
            "success": true,
            "inserted": 2000,
            "platform": 4,
            "read": {
              "success": true,
              "label": "same-tick frozen",
              "tick": 178726,
              "game_paused": false,
              "platform_paused": true,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 14301,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 46,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 14304,
                  "index": 1,
                  "segment_id": 47,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 14303,
                  "index": 1,
                  "segment_id": 47
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 14302,
                  "index": 1,
                  "segment_id": 47
                },
                {
                  "entity": "pump",
                  "type": "pump",
                  "unit_number": 14305,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 14306,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 14306,
                  "index": 2
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 14306,
                  "index": 3
                }
              ],
              "entity_states": [
                {
                  "entity": "pump",
                  "unit_number": 14305,
                  "active": false,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                },
                {
                  "entity": "chemical-plant",
                  "unit_number": 14306,
                  "active": false,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                }
              ]
            }
          },
          "activation": {
            "success": true,
            "tick": 178779,
            "changed": 2,
            "read": {
              "success": true,
              "label": "activation same tick",
              "tick": 178779,
              "game_paused": false,
              "platform_paused": false,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 14301,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 46,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 14304,
                  "index": 1,
                  "segment_id": 47,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 14303,
                  "index": 1,
                  "segment_id": 47
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 14302,
                  "index": 1,
                  "segment_id": 47
                },
                {
                  "entity": "pump",
                  "type": "pump",
                  "unit_number": 14305,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 14306,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 14306,
                  "index": 2
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 14306,
                  "index": 3
                }
              ],
              "entity_states": [
                {
                  "entity": "pump",
                  "unit_number": 14305,
                  "active": true,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                },
                {
                  "entity": "chemical-plant",
                  "unit_number": 14306,
                  "active": true,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                }
              ]
            }
          },
          "after": {
            "success": true,
            "label": "activation +60",
            "tick": 178873,
            "game_paused": false,
            "platform_paused": false,
            "totals": {
              "water": 2000
            },
            "boxes": [
              {
                "entity": "storage-tank",
                "type": "storage-tank",
                "unit_number": 14301,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 2000,
                  "temperature": 25
                },
                "segment_id": 46,
                "segment_contents": {
                  "water": 2000
                }
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 14304,
                "index": 1,
                "segment_id": 47,
                "segment_contents": {}
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 14303,
                "index": 1,
                "segment_id": 47
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 14302,
                "index": 1,
                "segment_id": 47
              },
              {
                "entity": "pump",
                "type": "pump",
                "unit_number": 14305,
                "index": 1
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 14306,
                "index": 1
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 14306,
                "index": 2
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 14306,
                "index": 3
              }
            ],
            "entity_states": [
              {
                "entity": "pump",
                "unit_number": 14305,
                "active": true,
                "frozen": {
                  "ok": true,
                  "value": false
                }
              },
              {
                "entity": "chemical-plant",
                "unit_number": 14306,
                "active": true,
                "frozen": {
                  "ok": true,
                  "value": false
                }
              }
            ]
          },
          "activation_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          },
          "after_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          }
        }
      ]
    },
    "r11b": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-b-1783659812449",
      "setup": {
        "success": true,
        "platform": 5,
        "writes": [
          {
            "entity": "storage-tank",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 98.81422919034958,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 98.81422919034958,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "pump",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 60,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 60,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 2,
            "write": {
              "accepted": true,
              "fluid": "heavy-oil",
              "amount": 80,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true
                },
                {
                  "fluid": "heavy-oil",
                  "ok": true,
                  "read": {
                    "name": "heavy-oil",
                    "amount": 80,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 3,
            "write": {
              "accepted": true,
              "fluid": "light-oil",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true
                },
                {
                  "fluid": "heavy-oil",
                  "ok": true
                },
                {
                  "fluid": "light-oil",
                  "ok": true,
                  "read": {
                    "name": "light-oil",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "boiler",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "boiler",
            "index": 2,
            "write": {
              "accepted": true,
              "fluid": "steam",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true,
                  "read": {
                    "name": "steam",
                    "amount": 100,
                    "temperature": 165
                  }
                }
              ]
            }
          }
        ],
        "read": {
          "success": true,
          "label": "R11b frozen same tick",
          "tick": 178918,
          "game_paused": false,
          "platform_paused": true,
          "totals": {
            "water": 260,
            "heavy-oil": 80,
            "light-oil": 100,
            "steam": 100
          },
          "boxes": [
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 14308,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 98.81422919034958,
                "temperature": 25
              },
              "segment_id": 48,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 14311,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 48
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 14309,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 48
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 14312,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 14310,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 48
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 14313,
              "index": 1,
              "segment_id": 49,
              "segment_contents": {}
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 14314,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 60,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 14314,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 80,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 14314,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 14315,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 50,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 14315,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 100,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 14312,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 14314,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 14315,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "activation": {
        "success": true,
        "tick": 178970,
        "changed": 3,
        "read": {
          "success": true,
          "label": "R11b activation same tick",
          "tick": 178970,
          "game_paused": false,
          "platform_paused": false,
          "totals": {
            "water": 260,
            "heavy-oil": 80,
            "light-oil": 100,
            "steam": 100
          },
          "boxes": [
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 14308,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 98.81422919034958,
                "temperature": 25
              },
              "segment_id": 48,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 14311,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 48
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 14309,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 48
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 14312,
              "index": 1
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 14310,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 48
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 14313,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 49,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 14314,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 60,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 14314,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 80,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 14314,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 14315,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 50,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 14315,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 100,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 14312,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 14314,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 14315,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "after": {
        "success": true,
        "label": "R11b activation +60",
        "tick": 179059,
        "game_paused": false,
        "platform_paused": false,
        "totals": {
          "water": 260,
          "heavy-oil": 80,
          "light-oil": 100,
          "steam": 100
        },
        "boxes": [
          {
            "entity": "storage-tank",
            "type": "storage-tank",
            "unit_number": 14308,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 98.81422919034958,
              "temperature": 25
            },
            "segment_id": 48,
            "segment_contents": {
              "water": 100
            }
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 14311,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 48
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 14309,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 48
          },
          {
            "entity": "pump",
            "type": "pump",
            "unit_number": 14312,
            "index": 1
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 14310,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 48
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 14313,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 100,
              "temperature": 25
            },
            "segment_id": 49,
            "segment_contents": {
              "water": 100
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 14314,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 60,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 14314,
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 80,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 14314,
            "index": 3,
            "direct": {
              "name": "light-oil",
              "amount": 100,
              "temperature": 25
            }
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 14315,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 100,
              "temperature": 25
            },
            "segment_id": 50,
            "segment_contents": {}
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 14315,
            "index": 2,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 165
            }
          }
        ],
        "entity_states": [
          {
            "entity": "pump",
            "unit_number": 14312,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "chemical-plant",
            "unit_number": 14314,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "boiler",
            "unit_number": 14315,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          }
        ]
      },
      "immediate_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 260,
            "actual": 260,
            "delta": 0
          }
        ]
      },
      "settled_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 260,
            "actual": 260,
            "delta": 0
          }
        ]
      }
    },
    "r11c": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-c-1783659815353",
      "import_state_replication": {
        "entity_creation": "module/import_phases/entity_creation.lua:69 creates through Deserializer; lines 78-91 immediately set active=false for transfer entities",
        "platform_pause": "module/core/import-pipeline.lua:240-245 pauses the transfer platform immediately after creation"
      },
      "setup": {
        "success": true,
        "platform": 6,
        "rows": [
          {
            "name": "pipe",
            "type": "pipe",
            "activatable": false,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 179107
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 179107
            }
          },
          {
            "name": "storage-tank",
            "type": "storage-tank",
            "activatable": false,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 179107
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 179107
            }
          },
          {
            "name": "pump",
            "type": "pump",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 179107
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 179107
            }
          },
          {
            "name": "chemical-plant",
            "type": "assembling-machine",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 179107
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 2,
                "write": {
                  "accepted": true,
                  "fluid": "heavy-oil",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true
                    },
                    {
                      "fluid": "heavy-oil",
                      "ok": true,
                      "read": {
                        "name": "heavy-oil",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 3,
                "write": {
                  "accepted": true,
                  "fluid": "light-oil",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true
                    },
                    {
                      "fluid": "heavy-oil",
                      "ok": true
                    },
                    {
                      "fluid": "light-oil",
                      "ok": true,
                      "read": {
                        "name": "light-oil",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 179107
            }
          },
          {
            "name": "boiler",
            "type": "boiler",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 179107
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 2,
                "write": {
                  "accepted": true,
                  "fluid": "steam",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true,
                      "read": {
                        "name": "steam",
                        "amount": 50,
                        "temperature": 165
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 179107
            }
          }
        ],
        "read": {
          "success": true,
          "label": "R11c before first activation",
          "tick": 179107,
          "game_paused": false,
          "platform_paused": true,
          "totals": {
            "water": 200,
            "heavy-oil": 50,
            "light-oil": 50,
            "steam": 50
          },
          "boxes": [
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 14317,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 51,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 14318,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 52,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 14319,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 14320,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 14320,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 14320,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 14321,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 53,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 14321,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 50,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 14319,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 14320,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 14321,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "activation": {
        "success": true,
        "tick": 179157,
        "changed": 3,
        "read": {
          "success": true,
          "label": "R11c activation same tick",
          "tick": 179157,
          "game_paused": false,
          "platform_paused": false,
          "totals": {
            "water": 200,
            "heavy-oil": 50,
            "light-oil": 50,
            "steam": 50
          },
          "boxes": [
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 14317,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 51,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 14318,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 52,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 14319,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 14320,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 14320,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 14320,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 14321,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 53,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 14321,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 50,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 14319,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 14320,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 14321,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "after": {
        "success": true,
        "label": "R11c activation +60",
        "tick": 179269,
        "game_paused": false,
        "platform_paused": false,
        "totals": {
          "water": 200,
          "heavy-oil": 50,
          "light-oil": 50,
          "steam": 50
        },
        "boxes": [
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 14317,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 51,
            "segment_contents": {
              "water": 50
            }
          },
          {
            "entity": "storage-tank",
            "type": "storage-tank",
            "unit_number": 14318,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 52,
            "segment_contents": {
              "water": 50
            }
          },
          {
            "entity": "pump",
            "type": "pump",
            "unit_number": 14319,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 14320,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 14320,
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 14320,
            "index": 3,
            "direct": {
              "name": "light-oil",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 14321,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 53,
            "segment_contents": {}
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 14321,
            "index": 2,
            "direct": {
              "name": "steam",
              "amount": 50,
              "temperature": 165
            }
          }
        ],
        "entity_states": [
          {
            "entity": "pump",
            "unit_number": 14319,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "chemical-plant",
            "unit_number": 14320,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "boiler",
            "unit_number": 14321,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          }
        ]
      },
      "immediate_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 200,
            "actual": 200,
            "delta": 0
          }
        ]
      },
      "settled_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 200,
            "actual": 200,
            "delta": 0
          }
        ]
      }
    },
    "r11d": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-d-1783659818631",
      "seed": {
        "success": true,
        "index": 2,
        "count": 1
      },
      "clone": {
        "success": true,
        "tick": 179364,
        "remote": {
          "success": true,
          "job_id": "import_1",
          "platform_name": "fluid-lab-r11-d-1783659818631",
          "source_platform": "test",
          "entity_count": 1359,
          "message": "Clone job started - use /step-tick to process"
        }
      },
      "clone_index": 7,
      "armed": {
        "success": true,
        "tick": 121678
      },
      "transfer_output": "═══════════════════════════════════════\n🚀 Transfer Platform: fluid-lab-r11-d-1783659818631\n═══════════════════════════════════════\nDestination: Instance 1351385547\nPlatform: [7] fluid-lab-r11-d-1783659818631\n\n[1/2] Locking + queueing export...\n[2/2] ✓ Export queued: 002_fluid-lab-r11-d-1783659818631\n⏳ Exporting asynchronously (this may take a while)...\n\nThe transfer will continue automatically:\n  1. Export completes → Sent to controller\n  2. Controller → Sends to destination instance\n  3. Destination imports → Validates counts\n  4. On success → Source deleted automatically\n  5. On failure → Source unlocked automatically\n\n💡 Use /list-platforms to track progress\n═══════════════════════════════════════",
      "wall_ms": 6786,
      "debug_file": "/clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_fluid-lab-r11-d-1783659818631_121885.json",
      "validation_success": true,
      "failed_stage": null,
      "hook_log": {
        "needle": "[Import][TEST][R11] Frozen fluid injection measured for fluid-lab-r11-d-1783659818631",
        "found": true,
        "line": "69.253 Script @__level__/modules/surface_export/core/import-completion.lua:364: [Import][TEST][R11] Frozen fluid injection measured for fluid-lab-r11-d-1783659818631 at tick 121885"
      },
      "measurement": {
        "hook_consumed": true,
        "platform_name": "fluid-lab-r11-d-1783659818631",
        "injection_started_tick": 121885,
        "frozen_census_tick": 121885,
        "platform_paused": true,
        "expected_by_name": {
          "molten-iron": 2331.4420278668404,
          "thruster-fuel": 37177.8046015501,
          "thruster-oxidizer": 37236.57823801041,
          "water": 52709.01258826256,
          "fluoroketone-cold": 223.314648270607,
          "fluoroketone-hot": 9.601849794387817,
          "fusion-plasma": 80,
          "molten-copper": 1828.7102613449097
        },
        "expected_raw": {
          "molten-iron@1500.0C": 2331.4420278668404,
          "thruster-fuel@25.0C": 37177.8046015501,
          "thruster-oxidizer@25.0C": 37236.57823801041,
          "water@15.0C": 52709.01258826256,
          "fluoroketone-cold@-150.0C": 223.314648270607,
          "fluoroketone-hot@180.0C": 9.601849794387817,
          "fusion-plasma@1082979.8C": 10,
          "fusion-plasma@1172655.5C": 10,
          "molten-copper@1100.0C": 1828.7102613449097,
          "fusion-plasma@1961957.1C": 10,
          "fusion-plasma@1172653.9C": 10,
          "fusion-plasma@1082998.4C": 10,
          "fusion-plasma@1081099.4C": 10,
          "fusion-plasma@1168906.3C": 10,
          "fusion-plasma@1963242.0C": 10,
          "fusion-plasma@1168903.8C": 10,
          "fusion-plasma@1081159.5C": 10
        },
        "frozen_actual_raw": {
          "fluoroketone-hot@180.0C": 9.601849794387817,
          "fusion-plasma@1082979.8C": 10,
          "fusion-plasma@1172655.5C": 10,
          "fluoroketone-cold@-150.0C": 223.314648270607,
          "fusion-plasma@1082998.4C": 10,
          "fusion-plasma@1172653.9C": 10,
          "molten-iron@1500.0C": 2331.4420278668404,
          "molten-copper@1100.0C": 1828.7102613449097,
          "thruster-fuel@25.0C": 37177.8046015501,
          "thruster-oxidizer@25.0C": 37236.57823801041,
          "fusion-plasma@1081099.4C": 10,
          "fusion-plasma@1168906.3C": 10,
          "fusion-plasma@1081159.5C": 10,
          "fusion-plasma@1168903.8C": 10,
          "water@15.0C": 52709.01258826256
        },
        "frozen_actual_by_name": {
          "fluoroketone-hot": 9.601849794387817,
          "fusion-plasma": 80,
          "fluoroketone-cold": 223.314648270607,
          "molten-iron": 2331.4420278668404,
          "molten-copper": 1828.7102613449097,
          "thruster-fuel": 37177.8046015501,
          "thruster-oxidizer": 37236.57823801041,
          "water": 52709.01258826256
        },
        "frozen_actual_total": 131596.4642150998,
        "write_rejected": {
          "fusion-plasma": 20
        },
        "activation_census_tick": 121885,
        "post_activation_actual_by_name": {
          "fluoroketone-hot": 9.601849794387817,
          "fusion-plasma": 80,
          "fluoroketone-cold": 223.314648270607,
          "molten-iron": 2331.4420278668404,
          "molten-copper": 1828.7102613449097,
          "thruster-fuel": 37177.8046015501,
          "thruster-oxidizer": 37236.57823801041,
          "water": 52709.01258826256
        },
        "post_activation_actual_raw": {
          "fluoroketone-hot@180.0C": 9.601849794387817,
          "fusion-plasma@1082979.8C": 10,
          "fusion-plasma@1172655.5C": 10,
          "fluoroketone-cold@-150.0C": 223.314648270607,
          "fusion-plasma@1082998.4C": 10,
          "fusion-plasma@1172653.9C": 10,
          "molten-iron@1500.0C": 2331.4420278668404,
          "molten-copper@1100.0C": 1828.7102613449097,
          "thruster-fuel@25.0C": 37177.8046015501,
          "thruster-oxidizer@25.0C": 37236.57823801041,
          "fusion-plasma@1081099.4C": 10,
          "fusion-plasma@1168906.3C": 10,
          "fusion-plasma@1081159.5C": 10,
          "fusion-plasma@1168903.8C": 10,
          "water@15.0C": 52709.01258826256
        },
        "post_activation_actual_total": 131596.4642150998
      },
      "frozen_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "fluoroketone-cold",
            "expected": 223.314648270607,
            "actual": 223.314648270607,
            "delta": 0
          },
          {
            "name": "fluoroketone-hot",
            "expected": 9.601849794387817,
            "actual": 9.601849794387817,
            "delta": 0
          },
          {
            "name": "fusion-plasma",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "molten-copper",
            "expected": 1828.7102613449097,
            "actual": 1828.7102613449097,
            "delta": 0
          },
          {
            "name": "molten-iron",
            "expected": 2331.4420278668404,
            "actual": 2331.4420278668404,
            "delta": 0
          },
          {
            "name": "thruster-fuel",
            "expected": 37177.8046015501,
            "actual": 37177.8046015501,
            "delta": 0
          },
          {
            "name": "thruster-oxidizer",
            "expected": 37236.57823801041,
            "actual": 37236.57823801041,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 52709.01258826256,
            "actual": 52709.01258826256,
            "delta": 0
          }
        ]
      },
      "post_activation_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "fluoroketone-cold",
            "expected": 223.314648270607,
            "actual": 223.314648270607,
            "delta": 0
          },
          {
            "name": "fluoroketone-hot",
            "expected": 9.601849794387817,
            "actual": 9.601849794387817,
            "delta": 0
          },
          {
            "name": "fusion-plasma",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "molten-copper",
            "expected": 1828.7102613449097,
            "actual": 1828.7102613449097,
            "delta": 0
          },
          {
            "name": "molten-iron",
            "expected": 2331.4420278668404,
            "actual": 2331.4420278668404,
            "delta": 0
          },
          {
            "name": "thruster-fuel",
            "expected": 37177.8046015501,
            "actual": 37177.8046015501,
            "delta": 0
          },
          {
            "name": "thruster-oxidizer",
            "expected": 37236.57823801041,
            "actual": 37236.57823801041,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 52709.01258826256,
            "actual": 52709.01258826256,
            "delta": 0
          }
        ]
      }
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 178148
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 120337
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 178337,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 120529,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 178437,
      "base": "2.0.77"
    },
    "destination": {
      "success": true,
      "tick": 120626,
      "base": "2.0.77"
    }
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "fluid-lab-r11-a-control-1783659806383",
          "fluid-lab-r11-a-machines-1783659809420",
          "fluid-lab-r11-b-1783659812449",
          "fluid-lab-r11-c-1783659815353"
        ],
        "tick": 180010
      },
      "destination": {
        "success": true,
        "deleted": [
          "fluid-lab-r11-d-1783659818631"
        ],
        "tick": 122289
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 180225,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 122508,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T05:03:56.146Z"
}
```


## 2026-07-10T05:04:48.166Z - R11 frozen-injection lab (sections=r11a,r11b,r11c,r11d)

Prediction: **zero fluid loss and zero fluid gain at every rung**.

```json
{
  "script": "tests/fluid-lab/run-r11.mjs",
  "started": "2026-07-10T05:04:08.945Z",
  "sections": [
    "r11a",
    "r11b",
    "r11c",
    "r11d"
  ],
  "prediction": "ZERO fluid loss and ZERO fluid gain at every R11 rung",
  "epsilon": 0.000001,
  "rungs": {
    "r11a": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "cases": [
        {
          "machines": false,
          "name": "fluid-lab-r11-a-control-1783659858333",
          "setup": {
            "success": true,
            "inserted": 2000,
            "platform": 8,
            "read": {
              "success": true,
              "label": "same-tick frozen",
              "tick": 181760,
              "game_paused": false,
              "platform_paused": true,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 15681,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 124,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15684,
                  "index": 1,
                  "segment_id": 125,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15683,
                  "index": 1,
                  "segment_id": 125
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15682,
                  "index": 1,
                  "segment_id": 125
                }
              ],
              "entity_states": {}
            }
          },
          "activation": {
            "success": true,
            "tick": 181822,
            "changed": 0,
            "read": {
              "success": true,
              "label": "activation same tick",
              "tick": 181822,
              "game_paused": false,
              "platform_paused": false,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 15681,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 124,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15684,
                  "index": 1,
                  "segment_id": 125,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15683,
                  "index": 1,
                  "segment_id": 125
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15682,
                  "index": 1,
                  "segment_id": 125
                }
              ],
              "entity_states": {}
            }
          },
          "after": {
            "success": true,
            "label": "activation +60",
            "tick": 181932,
            "game_paused": false,
            "platform_paused": false,
            "totals": {
              "water": 2000
            },
            "boxes": [
              {
                "entity": "storage-tank",
                "type": "storage-tank",
                "unit_number": 15681,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 2000,
                  "temperature": 25
                },
                "segment_id": 124,
                "segment_contents": {
                  "water": 2000
                }
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 15684,
                "index": 1,
                "segment_id": 125,
                "segment_contents": {}
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 15683,
                "index": 1,
                "segment_id": 125
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 15682,
                "index": 1,
                "segment_id": 125
              }
            ],
            "entity_states": {}
          },
          "activation_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          },
          "after_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          }
        },
        {
          "machines": true,
          "name": "fluid-lab-r11-a-machines-1783659861927",
          "setup": {
            "success": true,
            "inserted": 2000,
            "platform": 9,
            "read": {
              "success": true,
              "label": "same-tick frozen",
              "tick": 181990,
              "game_paused": false,
              "platform_paused": true,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 15686,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 126,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15689,
                  "index": 1,
                  "segment_id": 127,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15688,
                  "index": 1,
                  "segment_id": 127
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15687,
                  "index": 1,
                  "segment_id": 127
                },
                {
                  "entity": "pump",
                  "type": "pump",
                  "unit_number": 15690,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 15691,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 15691,
                  "index": 2
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 15691,
                  "index": 3
                }
              ],
              "entity_states": [
                {
                  "entity": "pump",
                  "unit_number": 15690,
                  "active": false,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                },
                {
                  "entity": "chemical-plant",
                  "unit_number": 15691,
                  "active": false,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                }
              ]
            }
          },
          "activation": {
            "success": true,
            "tick": 182052,
            "changed": 2,
            "read": {
              "success": true,
              "label": "activation same tick",
              "tick": 182052,
              "game_paused": false,
              "platform_paused": false,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 15686,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 2000,
                    "temperature": 25
                  },
                  "segment_id": 126,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15689,
                  "index": 1,
                  "segment_id": 127,
                  "segment_contents": {}
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15688,
                  "index": 1,
                  "segment_id": 127
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 15687,
                  "index": 1,
                  "segment_id": 127
                },
                {
                  "entity": "pump",
                  "type": "pump",
                  "unit_number": 15690,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 15691,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 15691,
                  "index": 2
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 15691,
                  "index": 3
                }
              ],
              "entity_states": [
                {
                  "entity": "pump",
                  "unit_number": 15690,
                  "active": true,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                },
                {
                  "entity": "chemical-plant",
                  "unit_number": 15691,
                  "active": true,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                }
              ]
            }
          },
          "after": {
            "success": true,
            "label": "activation +60",
            "tick": 182167,
            "game_paused": false,
            "platform_paused": false,
            "totals": {
              "water": 2000
            },
            "boxes": [
              {
                "entity": "storage-tank",
                "type": "storage-tank",
                "unit_number": 15686,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 2000,
                  "temperature": 25
                },
                "segment_id": 126,
                "segment_contents": {
                  "water": 2000
                }
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 15689,
                "index": 1,
                "segment_id": 127,
                "segment_contents": {}
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 15688,
                "index": 1,
                "segment_id": 127
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 15687,
                "index": 1,
                "segment_id": 127
              },
              {
                "entity": "pump",
                "type": "pump",
                "unit_number": 15690,
                "index": 1
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 15691,
                "index": 1
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 15691,
                "index": 2
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 15691,
                "index": 3
              }
            ],
            "entity_states": [
              {
                "entity": "pump",
                "unit_number": 15690,
                "active": true,
                "frozen": {
                  "ok": true,
                  "value": false
                }
              },
              {
                "entity": "chemical-plant",
                "unit_number": 15691,
                "active": true,
                "frozen": {
                  "ok": true,
                  "value": false
                }
              }
            ]
          },
          "activation_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          },
          "after_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          }
        }
      ]
    },
    "r11b": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-b-1783659865590",
      "setup": {
        "success": true,
        "platform": 10,
        "writes": [
          {
            "entity": "storage-tank",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 98.81422919034958,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 98.81422919034958,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "pump",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 60,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 60,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 2,
            "write": {
              "accepted": true,
              "fluid": "heavy-oil",
              "amount": 80,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true
                },
                {
                  "fluid": "heavy-oil",
                  "ok": true,
                  "read": {
                    "name": "heavy-oil",
                    "amount": 80,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 3,
            "write": {
              "accepted": true,
              "fluid": "light-oil",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true
                },
                {
                  "fluid": "heavy-oil",
                  "ok": true
                },
                {
                  "fluid": "light-oil",
                  "ok": true,
                  "read": {
                    "name": "light-oil",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "boiler",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "boiler",
            "index": 2,
            "write": {
              "accepted": true,
              "fluid": "steam",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true,
                  "read": {
                    "name": "steam",
                    "amount": 100,
                    "temperature": 165
                  }
                }
              ]
            }
          }
        ],
        "read": {
          "success": true,
          "label": "R11b frozen same tick",
          "tick": 182221,
          "game_paused": false,
          "platform_paused": true,
          "totals": {
            "water": 260,
            "heavy-oil": 80,
            "light-oil": 100,
            "steam": 100
          },
          "boxes": [
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 15693,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 98.81422919034958,
                "temperature": 25
              },
              "segment_id": 128,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15696,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 128
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15694,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 128
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 15697,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15695,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 128
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15698,
              "index": 1,
              "segment_id": 129,
              "segment_contents": {}
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15699,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 60,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15699,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 80,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15699,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15700,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 130,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15700,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 100,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 15697,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 15699,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 15700,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "activation": {
        "success": true,
        "tick": 182283,
        "changed": 3,
        "read": {
          "success": true,
          "label": "R11b activation same tick",
          "tick": 182283,
          "game_paused": false,
          "platform_paused": false,
          "totals": {
            "water": 260,
            "heavy-oil": 80,
            "light-oil": 100,
            "steam": 100
          },
          "boxes": [
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 15693,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 98.81422919034958,
                "temperature": 25
              },
              "segment_id": 128,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15696,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 128
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15694,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 128
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 15697,
              "index": 1
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15695,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 128
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15698,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 129,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15699,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 60,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15699,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 80,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15699,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15700,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 130,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15700,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 100,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 15697,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 15699,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 15700,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "after": {
        "success": true,
        "label": "R11b activation +60",
        "tick": 182387,
        "game_paused": false,
        "platform_paused": false,
        "totals": {
          "water": 260,
          "heavy-oil": 80,
          "light-oil": 100,
          "steam": 100
        },
        "boxes": [
          {
            "entity": "storage-tank",
            "type": "storage-tank",
            "unit_number": 15693,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 98.81422919034958,
              "temperature": 25
            },
            "segment_id": 128,
            "segment_contents": {
              "water": 100
            }
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 15696,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 128
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 15694,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 128
          },
          {
            "entity": "pump",
            "type": "pump",
            "unit_number": 15697,
            "index": 1
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 15695,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 128
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 15698,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 100,
              "temperature": 25
            },
            "segment_id": 129,
            "segment_contents": {
              "water": 100
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 15699,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 60,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 15699,
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 80,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 15699,
            "index": 3,
            "direct": {
              "name": "light-oil",
              "amount": 100,
              "temperature": 25
            }
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 15700,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 100,
              "temperature": 25
            },
            "segment_id": 130,
            "segment_contents": {}
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 15700,
            "index": 2,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 165
            }
          }
        ],
        "entity_states": [
          {
            "entity": "pump",
            "unit_number": 15697,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "chemical-plant",
            "unit_number": 15699,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "boiler",
            "unit_number": 15700,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          }
        ]
      },
      "immediate_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 260,
            "actual": 260,
            "delta": 0
          }
        ]
      },
      "settled_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 260,
            "actual": 260,
            "delta": 0
          }
        ]
      }
    },
    "r11c": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-c-1783659869019",
      "import_state_replication": {
        "entity_creation": "module/import_phases/entity_creation.lua:69 creates through Deserializer; lines 78-91 immediately set active=false for transfer entities",
        "platform_pause": "module/core/import-pipeline.lua:240-245 pauses the transfer platform immediately after creation"
      },
      "setup": {
        "success": true,
        "platform": 11,
        "rows": [
          {
            "name": "pipe",
            "type": "pipe",
            "activatable": false,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 182438
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 182438
            }
          },
          {
            "name": "storage-tank",
            "type": "storage-tank",
            "activatable": false,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 182438
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 182438
            }
          },
          {
            "name": "pump",
            "type": "pump",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 182438
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 182438
            }
          },
          {
            "name": "chemical-plant",
            "type": "assembling-machine",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 182438
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 2,
                "write": {
                  "accepted": true,
                  "fluid": "heavy-oil",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true
                    },
                    {
                      "fluid": "heavy-oil",
                      "ok": true,
                      "read": {
                        "name": "heavy-oil",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 3,
                "write": {
                  "accepted": true,
                  "fluid": "light-oil",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true
                    },
                    {
                      "fluid": "heavy-oil",
                      "ok": true
                    },
                    {
                      "fluid": "light-oil",
                      "ok": true,
                      "read": {
                        "name": "light-oil",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 182438
            }
          },
          {
            "name": "boiler",
            "type": "boiler",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 182438
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 2,
                "write": {
                  "accepted": true,
                  "fluid": "steam",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true,
                      "read": {
                        "name": "steam",
                        "amount": 50,
                        "temperature": 165
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 182438
            }
          }
        ],
        "read": {
          "success": true,
          "label": "R11c before first activation",
          "tick": 182438,
          "game_paused": false,
          "platform_paused": true,
          "totals": {
            "water": 200,
            "heavy-oil": 50,
            "light-oil": 50,
            "steam": 50
          },
          "boxes": [
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15702,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 131,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 15703,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 132,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 15704,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15705,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15705,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15705,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15706,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 133,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15706,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 50,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 15704,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 15705,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 15706,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "activation": {
        "success": true,
        "tick": 182492,
        "changed": 3,
        "read": {
          "success": true,
          "label": "R11c activation same tick",
          "tick": 182492,
          "game_paused": false,
          "platform_paused": false,
          "totals": {
            "water": 200,
            "heavy-oil": 50,
            "light-oil": 50,
            "steam": 50
          },
          "boxes": [
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 15702,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 131,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 15703,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 132,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 15704,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15705,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15705,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 15705,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15706,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 133,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 15706,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 50,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 15704,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 15705,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 15706,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "after": {
        "success": true,
        "label": "R11c activation +60",
        "tick": 182596,
        "game_paused": false,
        "platform_paused": false,
        "totals": {
          "water": 200,
          "heavy-oil": 50,
          "light-oil": 50,
          "steam": 50
        },
        "boxes": [
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 15702,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 131,
            "segment_contents": {
              "water": 50
            }
          },
          {
            "entity": "storage-tank",
            "type": "storage-tank",
            "unit_number": 15703,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 132,
            "segment_contents": {
              "water": 50
            }
          },
          {
            "entity": "pump",
            "type": "pump",
            "unit_number": 15704,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 15705,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 15705,
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 15705,
            "index": 3,
            "direct": {
              "name": "light-oil",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 15706,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 133,
            "segment_contents": {}
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 15706,
            "index": 2,
            "direct": {
              "name": "steam",
              "amount": 50,
              "temperature": 165
            }
          }
        ],
        "entity_states": [
          {
            "entity": "pump",
            "unit_number": 15704,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "chemical-plant",
            "unit_number": 15705,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "boiler",
            "unit_number": 15706,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          }
        ]
      },
      "immediate_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 200,
            "actual": 200,
            "delta": 0
          }
        ]
      },
      "settled_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 200,
            "actual": 200,
            "delta": 0
          }
        ]
      }
    },
    "r11d": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-d-1783659872287",
      "seed": {
        "success": true,
        "index": 2,
        "count": 1
      },
      "clone": {
        "success": true,
        "tick": 182691,
        "remote": {
          "success": true,
          "job_id": "import_3",
          "platform_name": "fluid-lab-r11-d-1783659872287",
          "source_platform": "test",
          "entity_count": 1359,
          "message": "Clone job started - use /step-tick to process"
        }
      },
      "clone_index": 12,
      "armed": {
        "success": true,
        "tick": 125070
      },
      "transfer_output": "═══════════════════════════════════════\n🚀 Transfer Platform: fluid-lab-r11-d-1783659872287\n═══════════════════════════════════════\nDestination: Instance 1351385547\nPlatform: [12] fluid-lab-r11-d-1783659872287\n\n[1/2] Locking + queueing export...\n[2/2] ✓ Export queued: 004_fluid-lab-r11-d-1783659872287\n⏳ Exporting asynchronously (this may take a while)...\n\nThe transfer will continue automatically:\n  1. Export completes → Sent to controller\n  2. Controller → Sends to destination instance\n  3. Destination imports → Validates counts\n  4. On success → Source deleted automatically\n  5. On failure → Source unlocked automatically\n\n💡 Use /list-platforms to track progress\n═══════════════════════════════════════",
      "wall_ms": 6503,
      "debug_file": "/clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_fluid-lab-r11-d-1783659872287_125257.json",
      "validation_success": true,
      "failed_stage": null,
      "hook_log": {
        "needle": "[Import][TEST][R11] Frozen fluid injection measured for fluid-lab-r11-d-1783659872287",
        "found": true,
        "line": "122.022 Script @__level__/modules/surface_export/core/import-completion.lua:364: [Import][TEST][R11] Frozen fluid injection measured for fluid-lab-r11-d-1783659872287 at tick 125257"
      },
      "measurement": {
        "hook_consumed": true,
        "platform_name": "fluid-lab-r11-d-1783659872287",
        "injection_started_tick": 125257,
        "frozen_census_tick": 125257,
        "platform_paused": true,
        "expected_by_name": {
          "molten-iron": 2204.686939716339,
          "thruster-fuel": 34129.08937370777,
          "thruster-oxidizer": 34188.99511098862,
          "water": 52987.509983778,
          "fluoroketone-cold": 229.73599302768707,
          "fluoroketone-hot": 8.98644632101059,
          "fusion-plasma": 80,
          "molten-copper": 1765
        },
        "expected_raw": {
          "molten-iron@1500.0C": 2204.686939716339,
          "thruster-fuel@25.0C": 34129.08937370777,
          "thruster-oxidizer@25.0C": 34188.99511098862,
          "water@15.0C": 52987.509983778,
          "fluoroketone-cold@-150.0C": 229.73599302768707,
          "fluoroketone-hot@180.0C": 8.98644632101059,
          "fusion-plasma@1080571.9C": 10,
          "fusion-plasma@1177711.4C": 10,
          "molten-copper@1100.0C": 1765,
          "fusion-plasma@1947419.4C": 10,
          "fusion-plasma@1177710.8C": 10,
          "fusion-plasma@1080582.1C": 10,
          "fusion-plasma@1078515.5C": 10,
          "fusion-plasma@1173900.9C": 10,
          "fusion-plasma@1948321.6C": 10,
          "fusion-plasma@1173899.9C": 10,
          "fusion-plasma@1078549.4C": 10
        },
        "frozen_actual_raw": {
          "fluoroketone-hot@180.0C": 8.98644632101059,
          "fusion-plasma@1080571.9C": 10,
          "fusion-plasma@1177711.4C": 10,
          "fluoroketone-cold@-150.0C": 229.73599302768707,
          "fusion-plasma@1080582.1C": 10,
          "fusion-plasma@1177710.8C": 10,
          "molten-iron@1500.0C": 2204.686939716339,
          "molten-copper@1100.0C": 1765,
          "thruster-fuel@25.0C": 34129.08937370777,
          "thruster-oxidizer@25.0C": 34188.99511098862,
          "fusion-plasma@1078515.5C": 10,
          "fusion-plasma@1173900.9C": 10,
          "fusion-plasma@1078549.4C": 10,
          "fusion-plasma@1173899.9C": 10,
          "water@15.0C": 52987.509983778
        },
        "frozen_actual_by_name": {
          "fluoroketone-hot": 8.98644632101059,
          "fusion-plasma": 80,
          "fluoroketone-cold": 229.73599302768707,
          "molten-iron": 2204.686939716339,
          "molten-copper": 1765,
          "thruster-fuel": 34129.08937370777,
          "thruster-oxidizer": 34188.99511098862,
          "water": 52987.509983778
        },
        "frozen_actual_total": 125594.00384753942,
        "write_rejected": {
          "fusion-plasma": 20
        },
        "activation_census_tick": 125257,
        "post_activation_actual_by_name": {
          "fluoroketone-hot": 8.98644632101059,
          "fusion-plasma": 80,
          "fluoroketone-cold": 229.73599302768707,
          "molten-iron": 2204.686939716339,
          "molten-copper": 1765,
          "thruster-fuel": 34129.08937370777,
          "thruster-oxidizer": 34188.99511098862,
          "water": 52987.509983778
        },
        "post_activation_actual_raw": {
          "fluoroketone-hot@180.0C": 8.98644632101059,
          "fusion-plasma@1080571.9C": 10,
          "fusion-plasma@1177711.4C": 10,
          "fluoroketone-cold@-150.0C": 229.73599302768707,
          "fusion-plasma@1080582.1C": 10,
          "fusion-plasma@1177710.8C": 10,
          "molten-iron@1500.0C": 2204.686939716339,
          "molten-copper@1100.0C": 1765,
          "thruster-fuel@25.0C": 34129.08937370777,
          "thruster-oxidizer@25.0C": 34188.99511098862,
          "fusion-plasma@1078515.5C": 10,
          "fusion-plasma@1173900.9C": 10,
          "fusion-plasma@1078549.4C": 10,
          "fusion-plasma@1173899.9C": 10,
          "water@15.0C": 52987.509983778
        },
        "post_activation_actual_total": 125594.00384753942
      },
      "frozen_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "fluoroketone-cold",
            "expected": 229.73599302768707,
            "actual": 229.73599302768707,
            "delta": 0
          },
          {
            "name": "fluoroketone-hot",
            "expected": 8.98644632101059,
            "actual": 8.98644632101059,
            "delta": 0
          },
          {
            "name": "fusion-plasma",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "molten-copper",
            "expected": 1765,
            "actual": 1765,
            "delta": 0
          },
          {
            "name": "molten-iron",
            "expected": 2204.686939716339,
            "actual": 2204.686939716339,
            "delta": 0
          },
          {
            "name": "thruster-fuel",
            "expected": 34129.08937370777,
            "actual": 34129.08937370777,
            "delta": 0
          },
          {
            "name": "thruster-oxidizer",
            "expected": 34188.99511098862,
            "actual": 34188.99511098862,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 52987.509983778,
            "actual": 52987.509983778,
            "delta": 0
          }
        ]
      },
      "post_activation_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "fluoroketone-cold",
            "expected": 229.73599302768707,
            "actual": 229.73599302768707,
            "delta": 0
          },
          {
            "name": "fluoroketone-hot",
            "expected": 8.98644632101059,
            "actual": 8.98644632101059,
            "delta": 0
          },
          {
            "name": "fusion-plasma",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "molten-copper",
            "expected": 1765,
            "actual": 1765,
            "delta": 0
          },
          {
            "name": "molten-iron",
            "expected": 2204.686939716339,
            "actual": 2204.686939716339,
            "delta": 0
          },
          {
            "name": "thruster-fuel",
            "expected": 34129.08937370777,
            "actual": 34129.08937370777,
            "delta": 0
          },
          {
            "name": "thruster-oxidizer",
            "expected": 34188.99511098862,
            "actual": 34188.99511098862,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 52987.509983778,
            "actual": 52987.509983778,
            "delta": 0
          }
        ]
      }
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 181296
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 123581
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 181530,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 123812,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 181646,
      "base": "2.0.77"
    },
    "destination": {
      "success": true,
      "tick": 123930,
      "base": "2.0.77"
    }
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "fluid-lab-r11-a-control-1783659858333",
          "fluid-lab-r11-a-machines-1783659861927",
          "fluid-lab-r11-b-1783659865590",
          "fluid-lab-r11-c-1783659869019"
        ],
        "tick": 183303
      },
      "destination": {
        "success": true,
        "deleted": [
          "fluid-lab-r11-d-1783659872287"
        ],
        "tick": 125642
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 183477,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 125820,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T05:04:48.166Z"
}
```

## 2026-07-10 - R11 final-instrument evidence addendum

The first two green full runs above were followed by a line-read correction to the diagnostic only:
`expected_raw` now copies the serialized table before the production fusion-rejection adjustment instead of
retaining a mutable reference. No restoration or comparison behavior changed. The two consecutive evidence
passes on that final instrument completed at `2026-07-10T05:03:56.146Z` and
`2026-07-10T05:04:48.166Z`.

Both final passes had no errors, exact frozen and post-activation aggregate comparisons (`max |delta| = 0`),
positive hook-consumption log evidence, and both-instance seven-field cleanup. The untouched serialized raw
records contained 100 fusion-plasma; production restoration reported 20 engine-rejected output units, and the
adjusted expected 80 matched both physical censuses exactly. These final two passes are the acceptance evidence.


## 2026-07-10T05:07:38.649Z - R11 frozen-injection lab (sections=r11a,r11b,r11c,r11d)

Prediction: **zero fluid loss and zero fluid gain at every rung**.

```json
{
  "script": "tests/fluid-lab/run-r11.mjs",
  "started": "2026-07-10T05:07:02.231Z",
  "sections": [
    "r11a",
    "r11b",
    "r11c",
    "r11d"
  ],
  "prediction": "ZERO fluid loss and ZERO fluid gain at every R11 rung",
  "epsilon": 0.000001,
  "rungs": {
    "r11a": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "cases": [
        {
          "machines": false,
          "name": "fluid-lab-r11-a-control-1783660030287",
          "setup": {
            "success": true,
            "inserted": 2000,
            "tank_segment": 207,
            "member_segment": 207,
            "shared_segment": true,
            "platform": 15,
            "read": {
              "success": true,
              "label": "same-tick frozen",
              "tick": 192676,
              "game_paused": false,
              "platform_paused": true,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 17079,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 1976.2845849394798,
                    "temperature": 25
                  },
                  "segment_id": 207,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17082,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 207
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17080,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 207
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17081,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 207
                }
              ],
              "entity_states": {}
            }
          },
          "activation": {
            "success": true,
            "tick": 192727,
            "changed": 0,
            "read": {
              "success": true,
              "label": "activation same tick",
              "tick": 192727,
              "game_paused": false,
              "platform_paused": false,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 17079,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 1976.2845849394798,
                    "temperature": 25
                  },
                  "segment_id": 207,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17082,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 207
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17080,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 207
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17081,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 207
                }
              ],
              "entity_states": {}
            }
          },
          "after": {
            "success": true,
            "label": "activation +60",
            "tick": 192817,
            "game_paused": false,
            "platform_paused": false,
            "totals": {
              "water": 2000
            },
            "boxes": [
              {
                "entity": "storage-tank",
                "type": "storage-tank",
                "unit_number": 17079,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 1976.2845849394798,
                  "temperature": 25
                },
                "segment_id": 207,
                "segment_contents": {
                  "water": 2000
                }
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 17082,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 7.905138313770294,
                  "temperature": 25
                },
                "segment_id": 207
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 17080,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 7.905138313770294,
                  "temperature": 25
                },
                "segment_id": 207
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 17081,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 7.905138313770294,
                  "temperature": 25
                },
                "segment_id": 207
              }
            ],
            "entity_states": {}
          },
          "activation_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          },
          "after_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          }
        },
        {
          "machines": true,
          "name": "fluid-lab-r11-a-machines-1783660033202",
          "setup": {
            "success": true,
            "inserted": 2000,
            "tank_segment": 208,
            "member_segment": 208,
            "shared_segment": true,
            "platform": 16,
            "read": {
              "success": true,
              "label": "same-tick frozen",
              "tick": 192864,
              "game_paused": false,
              "platform_paused": true,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 17084,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 1976.2845849394798,
                    "temperature": 25
                  },
                  "segment_id": 208,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17087,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 208
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17085,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 208
                },
                {
                  "entity": "pump",
                  "type": "pump",
                  "unit_number": 17088,
                  "index": 1
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17086,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 208
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17089,
                  "index": 1,
                  "segment_id": 209,
                  "segment_contents": {}
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 17090,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 17090,
                  "index": 2
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 17090,
                  "index": 3
                }
              ],
              "entity_states": [
                {
                  "entity": "pump",
                  "unit_number": 17088,
                  "active": false,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                },
                {
                  "entity": "chemical-plant",
                  "unit_number": 17090,
                  "active": false,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                }
              ]
            }
          },
          "activation": {
            "success": true,
            "tick": 192912,
            "changed": 2,
            "read": {
              "success": true,
              "label": "activation same tick",
              "tick": 192912,
              "game_paused": false,
              "platform_paused": false,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 17084,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 1976.2845849394798,
                    "temperature": 25
                  },
                  "segment_id": 208,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17087,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 208
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17085,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 208
                },
                {
                  "entity": "pump",
                  "type": "pump",
                  "unit_number": 17088,
                  "index": 1
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17086,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 208
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 17089,
                  "index": 1,
                  "segment_id": 209,
                  "segment_contents": {}
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 17090,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 17090,
                  "index": 2
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 17090,
                  "index": 3
                }
              ],
              "entity_states": [
                {
                  "entity": "pump",
                  "unit_number": 17088,
                  "active": true,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                },
                {
                  "entity": "chemical-plant",
                  "unit_number": 17090,
                  "active": true,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                }
              ]
            }
          },
          "after": {
            "success": true,
            "label": "activation +60",
            "tick": 193004,
            "game_paused": false,
            "platform_paused": false,
            "totals": {
              "water": 2000
            },
            "boxes": [
              {
                "entity": "storage-tank",
                "type": "storage-tank",
                "unit_number": 17084,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 1976.2845849394798,
                  "temperature": 25
                },
                "segment_id": 208,
                "segment_contents": {
                  "water": 2000
                }
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 17087,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 7.905138313770294,
                  "temperature": 25
                },
                "segment_id": 208
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 17085,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 7.905138313770294,
                  "temperature": 25
                },
                "segment_id": 208
              },
              {
                "entity": "pump",
                "type": "pump",
                "unit_number": 17088,
                "index": 1
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 17086,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 7.905138313770294,
                  "temperature": 25
                },
                "segment_id": 208
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 17089,
                "index": 1,
                "segment_id": 209,
                "segment_contents": {}
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 17090,
                "index": 1
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 17090,
                "index": 2
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 17090,
                "index": 3
              }
            ],
            "entity_states": [
              {
                "entity": "pump",
                "unit_number": 17088,
                "active": true,
                "frozen": {
                  "ok": true,
                  "value": false
                }
              },
              {
                "entity": "chemical-plant",
                "unit_number": 17090,
                "active": true,
                "frozen": {
                  "ok": true,
                  "value": false
                }
              }
            ]
          },
          "activation_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          },
          "after_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          }
        }
      ]
    },
    "r11b": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-b-1783660036121",
      "setup": {
        "success": true,
        "platform": 17,
        "writes": [
          {
            "entity": "storage-tank",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 98.81422919034958,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 98.81422919034958,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "pump",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 60,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 60,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 2,
            "write": {
              "accepted": true,
              "fluid": "heavy-oil",
              "amount": 80,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true
                },
                {
                  "fluid": "heavy-oil",
                  "ok": true,
                  "read": {
                    "name": "heavy-oil",
                    "amount": 80,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 3,
            "write": {
              "accepted": true,
              "fluid": "light-oil",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true
                },
                {
                  "fluid": "heavy-oil",
                  "ok": true
                },
                {
                  "fluid": "light-oil",
                  "ok": true,
                  "read": {
                    "name": "light-oil",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "boiler",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "boiler",
            "index": 2,
            "write": {
              "accepted": true,
              "fluid": "steam",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true,
                  "read": {
                    "name": "steam",
                    "amount": 100,
                    "temperature": 165
                  }
                }
              ]
            }
          }
        ],
        "read": {
          "success": true,
          "label": "R11b frozen same tick",
          "tick": 193052,
          "game_paused": false,
          "platform_paused": true,
          "totals": {
            "water": 260,
            "heavy-oil": 80,
            "light-oil": 100,
            "steam": 100
          },
          "boxes": [
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 17092,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 98.81422919034958,
                "temperature": 25
              },
              "segment_id": 210,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17095,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 210
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17093,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 210
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 17096,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17094,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 210
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17097,
              "index": 1,
              "segment_id": 211,
              "segment_contents": {}
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17098,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 60,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17098,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 80,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17098,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17099,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 212,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17099,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 100,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 17096,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 17098,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 17099,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "activation": {
        "success": true,
        "tick": 193109,
        "changed": 3,
        "read": {
          "success": true,
          "label": "R11b activation same tick",
          "tick": 193109,
          "game_paused": false,
          "platform_paused": false,
          "totals": {
            "water": 260,
            "heavy-oil": 80,
            "light-oil": 100,
            "steam": 100
          },
          "boxes": [
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 17092,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 98.81422919034958,
                "temperature": 25
              },
              "segment_id": 210,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17095,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 210
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17093,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 210
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 17096,
              "index": 1
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17094,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 210
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17097,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 211,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17098,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 60,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17098,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 80,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17098,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17099,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 212,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17099,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 100,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 17096,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 17098,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 17099,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "after": {
        "success": true,
        "label": "R11b activation +60",
        "tick": 193207,
        "game_paused": false,
        "platform_paused": false,
        "totals": {
          "water": 260,
          "heavy-oil": 80,
          "light-oil": 100,
          "steam": 100
        },
        "boxes": [
          {
            "entity": "storage-tank",
            "type": "storage-tank",
            "unit_number": 17092,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 98.81422919034958,
              "temperature": 25
            },
            "segment_id": 210,
            "segment_contents": {
              "water": 100
            }
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 17095,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 210
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 17093,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 210
          },
          {
            "entity": "pump",
            "type": "pump",
            "unit_number": 17096,
            "index": 1
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 17094,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 210
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 17097,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 100,
              "temperature": 25
            },
            "segment_id": 211,
            "segment_contents": {
              "water": 100
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 17098,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 60,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 17098,
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 80,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 17098,
            "index": 3,
            "direct": {
              "name": "light-oil",
              "amount": 100,
              "temperature": 25
            }
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 17099,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 100,
              "temperature": 25
            },
            "segment_id": 212,
            "segment_contents": {}
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 17099,
            "index": 2,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 165
            }
          }
        ],
        "entity_states": [
          {
            "entity": "pump",
            "unit_number": 17096,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "chemical-plant",
            "unit_number": 17098,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "boiler",
            "unit_number": 17099,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          }
        ]
      },
      "immediate_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 260,
            "actual": 260,
            "delta": 0
          }
        ]
      },
      "settled_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 260,
            "actual": 260,
            "delta": 0
          }
        ]
      }
    },
    "r11c": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-c-1783660039293",
      "import_state_replication": {
        "entity_creation": "module/import_phases/entity_creation.lua:69 creates through Deserializer; lines 78-91 immediately set active=false for transfer entities",
        "platform_pause": "module/core/import-pipeline.lua:240-245 pauses the transfer platform immediately after creation"
      },
      "setup": {
        "success": true,
        "platform": 18,
        "rows": [
          {
            "name": "pipe",
            "type": "pipe",
            "activatable": false,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 193252
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 193252
            }
          },
          {
            "name": "storage-tank",
            "type": "storage-tank",
            "activatable": false,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 193252
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 193252
            }
          },
          {
            "name": "pump",
            "type": "pump",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 193252
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 193252
            }
          },
          {
            "name": "chemical-plant",
            "type": "assembling-machine",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 193252
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 2,
                "write": {
                  "accepted": true,
                  "fluid": "heavy-oil",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true
                    },
                    {
                      "fluid": "heavy-oil",
                      "ok": true,
                      "read": {
                        "name": "heavy-oil",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 3,
                "write": {
                  "accepted": true,
                  "fluid": "light-oil",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true
                    },
                    {
                      "fluid": "heavy-oil",
                      "ok": true
                    },
                    {
                      "fluid": "light-oil",
                      "ok": true,
                      "read": {
                        "name": "light-oil",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 193252
            }
          },
          {
            "name": "boiler",
            "type": "boiler",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 193252
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 2,
                "write": {
                  "accepted": true,
                  "fluid": "steam",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true,
                      "read": {
                        "name": "steam",
                        "amount": 50,
                        "temperature": 165
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 193252
            }
          }
        ],
        "read": {
          "success": true,
          "label": "R11c before first activation",
          "tick": 193252,
          "game_paused": false,
          "platform_paused": true,
          "totals": {
            "water": 200,
            "heavy-oil": 50,
            "light-oil": 50,
            "steam": 50
          },
          "boxes": [
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17101,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 213,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 17102,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 214,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 17103,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17104,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17104,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17104,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17105,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 215,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17105,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 50,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 17103,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 17104,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 17105,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "activation": {
        "success": true,
        "tick": 193302,
        "changed": 3,
        "read": {
          "success": true,
          "label": "R11c activation same tick",
          "tick": 193302,
          "game_paused": false,
          "platform_paused": false,
          "totals": {
            "water": 200,
            "heavy-oil": 50,
            "light-oil": 50,
            "steam": 50
          },
          "boxes": [
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 17101,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 213,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 17102,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 214,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 17103,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17104,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17104,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 17104,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17105,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 215,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 17105,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 50,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 17103,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 17104,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 17105,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "after": {
        "success": true,
        "label": "R11c activation +60",
        "tick": 193391,
        "game_paused": false,
        "platform_paused": false,
        "totals": {
          "water": 200,
          "heavy-oil": 50,
          "light-oil": 50,
          "steam": 50
        },
        "boxes": [
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 17101,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 213,
            "segment_contents": {
              "water": 50
            }
          },
          {
            "entity": "storage-tank",
            "type": "storage-tank",
            "unit_number": 17102,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 214,
            "segment_contents": {
              "water": 50
            }
          },
          {
            "entity": "pump",
            "type": "pump",
            "unit_number": 17103,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 17104,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 17104,
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 17104,
            "index": 3,
            "direct": {
              "name": "light-oil",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 17105,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 215,
            "segment_contents": {}
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 17105,
            "index": 2,
            "direct": {
              "name": "steam",
              "amount": 50,
              "temperature": 165
            }
          }
        ],
        "entity_states": [
          {
            "entity": "pump",
            "unit_number": 17103,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "chemical-plant",
            "unit_number": 17104,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "boiler",
            "unit_number": 17105,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          }
        ]
      },
      "immediate_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 200,
            "actual": 200,
            "delta": 0
          }
        ]
      },
      "settled_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 200,
            "actual": 200,
            "delta": 0
          }
        ]
      }
    },
    "r11d": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-d-1783660042166",
      "seed": {
        "success": true,
        "index": 2,
        "count": 1
      },
      "clone": {
        "success": true,
        "tick": 193482,
        "remote": {
          "success": true,
          "job_id": "import_5",
          "platform_name": "fluid-lab-r11-d-1783660042166",
          "source_platform": "test",
          "entity_count": 1359,
          "message": "Clone job started - use /step-tick to process"
        }
      },
      "clone_index": 19,
      "armed": {
        "success": true,
        "tick": 135935
      },
      "transfer_output": "═══════════════════════════════════════\n🚀 Transfer Platform: fluid-lab-r11-d-1783660042166\n═══════════════════════════════════════\nDestination: Instance 1351385547\nPlatform: [19] fluid-lab-r11-d-1783660042166\n\n[1/2] Locking + queueing export...\n[2/2] ✓ Export queued: 006_fluid-lab-r11-d-1783660042166\n⏳ Exporting asynchronously (this may take a while)...\n\nThe transfer will continue automatically:\n  1. Export completes → Sent to controller\n  2. Controller → Sends to destination instance\n  3. Destination imports → Validates counts\n  4. On success → Source deleted automatically\n  5. On failure → Source unlocked automatically\n\n💡 Use /list-platforms to track progress\n═══════════════════════════════════════",
      "wall_ms": 6845,
      "debug_file": "/clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_fluid-lab-r11-d-1783660042166_136144.json",
      "validation_success": true,
      "failed_stage": null,
      "hook_log": {
        "needle": "[Import][TEST][R11] Frozen fluid injection measured for fluid-lab-r11-d-1783660042166",
        "found": true,
        "line": "292.417 Script @__level__/modules/surface_export/core/import-completion.lua:364: [Import][TEST][R11] Frozen fluid injection measured for fluid-lab-r11-d-1783660042166 at tick 136144"
      },
      "measurement": {
        "hook_consumed": true,
        "platform_name": "fluid-lab-r11-d-1783660042166",
        "injection_started_tick": 136144,
        "frozen_census_tick": 136144,
        "platform_paused": true,
        "expected_by_name": {
          "molten-iron": 2311.302008152008,
          "thruster-fuel": 37187.916553378105,
          "thruster-oxidizer": 37246.66960835457,
          "water": 52729.72016096115,
          "fluoroketone-cold": 229.92952769994736,
          "fluoroketone-hot": 5.8176186084747314,
          "fusion-plasma": 80,
          "molten-copper": 2063.7102615833282
        },
        "expected_raw": {
          "molten-iron@1500.0C": 2311.302008152008,
          "thruster-fuel@25.0C": 37187.916553378105,
          "thruster-oxidizer@25.0C": 37246.66960835457,
          "water@15.0C": 52729.72016096115,
          "fluoroketone-cold@-150.0C": 229.92952769994736,
          "fluoroketone-hot@180.0C": 5.8176186084747314,
          "fusion-plasma@1074137.4C": 10,
          "fusion-plasma@1186487.6C": 20,
          "molten-copper@1100.0C": 2063.7102615833282,
          "fusion-plasma@1921452.3C": 10,
          "fusion-plasma@1074139.3C": 10,
          "fusion-plasma@1071537.3C": 10,
          "fusion-plasma@1182302.9C": 10,
          "fusion-plasma@1922198.1C": 10,
          "fusion-plasma@1182302.6C": 10,
          "fusion-plasma@1071542.9C": 10
        },
        "frozen_actual_raw": {
          "fluoroketone-hot@180.0C": 5.8176186084747314,
          "fusion-plasma@1074137.4C": 10,
          "fusion-plasma@1186487.6C": 20,
          "fluoroketone-cold@-150.0C": 229.92952769994736,
          "fusion-plasma@1074139.3C": 10,
          "molten-iron@1500.0C": 2311.302008152008,
          "molten-copper@1100.0C": 2063.7102615833282,
          "thruster-fuel@25.0C": 37187.916553378105,
          "thruster-oxidizer@25.0C": 37246.66960835457,
          "fusion-plasma@1071537.3C": 10,
          "fusion-plasma@1182302.9C": 10,
          "fusion-plasma@1071542.9C": 10,
          "fusion-plasma@1182302.6C": 10,
          "water@15.0C": 52729.72016096115
        },
        "frozen_actual_by_name": {
          "fluoroketone-hot": 5.8176186084747314,
          "fusion-plasma": 80,
          "fluoroketone-cold": 229.92952769994736,
          "molten-iron": 2311.302008152008,
          "molten-copper": 2063.7102615833282,
          "thruster-fuel": 37187.916553378105,
          "thruster-oxidizer": 37246.66960835457,
          "water": 52729.72016096115
        },
        "frozen_actual_total": 131855.06573873758,
        "write_rejected": {
          "fusion-plasma": 20
        },
        "activation_census_tick": 136144,
        "post_activation_actual_by_name": {
          "fluoroketone-hot": 5.8176186084747314,
          "fusion-plasma": 80,
          "fluoroketone-cold": 229.92952769994736,
          "molten-iron": 2311.302008152008,
          "molten-copper": 2063.7102615833282,
          "thruster-fuel": 37187.916553378105,
          "thruster-oxidizer": 37246.66960835457,
          "water": 52729.72016096115
        },
        "post_activation_actual_raw": {
          "fluoroketone-hot@180.0C": 5.8176186084747314,
          "fusion-plasma@1074137.4C": 10,
          "fusion-plasma@1186487.6C": 20,
          "fluoroketone-cold@-150.0C": 229.92952769994736,
          "fusion-plasma@1074139.3C": 10,
          "molten-iron@1500.0C": 2311.302008152008,
          "molten-copper@1100.0C": 2063.7102615833282,
          "thruster-fuel@25.0C": 37187.916553378105,
          "thruster-oxidizer@25.0C": 37246.66960835457,
          "fusion-plasma@1071537.3C": 10,
          "fusion-plasma@1182302.9C": 10,
          "fusion-plasma@1071542.9C": 10,
          "fusion-plasma@1182302.6C": 10,
          "water@15.0C": 52729.72016096115
        },
        "post_activation_actual_total": 131855.06573873758
      },
      "frozen_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "fluoroketone-cold",
            "expected": 229.92952769994736,
            "actual": 229.92952769994736,
            "delta": 0
          },
          {
            "name": "fluoroketone-hot",
            "expected": 5.8176186084747314,
            "actual": 5.8176186084747314,
            "delta": 0
          },
          {
            "name": "fusion-plasma",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "molten-copper",
            "expected": 2063.7102615833282,
            "actual": 2063.7102615833282,
            "delta": 0
          },
          {
            "name": "molten-iron",
            "expected": 2311.302008152008,
            "actual": 2311.302008152008,
            "delta": 0
          },
          {
            "name": "thruster-fuel",
            "expected": 37187.916553378105,
            "actual": 37187.916553378105,
            "delta": 0
          },
          {
            "name": "thruster-oxidizer",
            "expected": 37246.66960835457,
            "actual": 37246.66960835457,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 52729.72016096115,
            "actual": 52729.72016096115,
            "delta": 0
          }
        ]
      },
      "post_activation_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "fluoroketone-cold",
            "expected": 229.92952769994736,
            "actual": 229.92952769994736,
            "delta": 0
          },
          {
            "name": "fluoroketone-hot",
            "expected": 5.8176186084747314,
            "actual": 5.8176186084747314,
            "delta": 0
          },
          {
            "name": "fusion-plasma",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "molten-copper",
            "expected": 2063.7102615833282,
            "actual": 2063.7102615833282,
            "delta": 0
          },
          {
            "name": "molten-iron",
            "expected": 2311.302008152008,
            "actual": 2311.302008152008,
            "delta": 0
          },
          {
            "name": "thruster-fuel",
            "expected": 37187.916553378105,
            "actual": 37187.916553378105,
            "delta": 0
          },
          {
            "name": "thruster-oxidizer",
            "expected": 37246.66960835457,
            "actual": 37246.66960835457,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 52729.72016096115,
            "actual": 52729.72016096115,
            "delta": 0
          }
        ]
      }
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 192283
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 134627
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 192488,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 134833,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 192585,
      "base": "2.0.77"
    },
    "destination": {
      "success": true,
      "tick": 134926,
      "base": "2.0.77"
    }
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "fluid-lab-r11-a-control-1783660030287",
          "fluid-lab-r11-a-machines-1783660033202",
          "fluid-lab-r11-b-1783660036121",
          "fluid-lab-r11-c-1783660039293"
        ],
        "tick": 194129
      },
      "destination": {
        "success": true,
        "deleted": [
          "fluid-lab-r11-d-1783660042166"
        ],
        "tick": 136540
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 194305,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 136719,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T05:07:38.649Z"
}
```


## 2026-07-10T05:08:25.511Z - R11 frozen-injection lab (sections=r11a,r11b,r11c,r11d)

Prediction: **zero fluid loss and zero fluid gain at every rung**.

```json
{
  "script": "tests/fluid-lab/run-r11.mjs",
  "started": "2026-07-10T05:07:49.812Z",
  "sections": [
    "r11a",
    "r11b",
    "r11c",
    "r11d"
  ],
  "prediction": "ZERO fluid loss and ZERO fluid gain at every R11 rung",
  "epsilon": 0.000001,
  "rungs": {
    "r11a": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "cases": [
        {
          "machines": false,
          "name": "fluid-lab-r11-a-control-1783660077058",
          "setup": {
            "success": true,
            "inserted": 2000,
            "tank_segment": 286,
            "member_segment": 286,
            "shared_segment": true,
            "platform": 20,
            "read": {
              "success": true,
              "label": "same-tick frozen",
              "tick": 195581,
              "game_paused": false,
              "platform_paused": true,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 18465,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 1976.2845849394798,
                    "temperature": 25
                  },
                  "segment_id": 286,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 18468,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 286
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 18466,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 286
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 18467,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 286
                }
              ],
              "entity_states": {}
            }
          },
          "activation": {
            "success": true,
            "tick": 195630,
            "changed": 0,
            "read": {
              "success": true,
              "label": "activation same tick",
              "tick": 195630,
              "game_paused": false,
              "platform_paused": false,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 18465,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 1976.2845849394798,
                    "temperature": 25
                  },
                  "segment_id": 286,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 18468,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 286
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 18466,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 286
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 18467,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 286
                }
              ],
              "entity_states": {}
            }
          },
          "after": {
            "success": true,
            "label": "activation +60",
            "tick": 195722,
            "game_paused": false,
            "platform_paused": false,
            "totals": {
              "water": 2000
            },
            "boxes": [
              {
                "entity": "storage-tank",
                "type": "storage-tank",
                "unit_number": 18465,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 1976.2845849394798,
                  "temperature": 25
                },
                "segment_id": 286,
                "segment_contents": {
                  "water": 2000
                }
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 18468,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 7.905138313770294,
                  "temperature": 25
                },
                "segment_id": 286
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 18466,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 7.905138313770294,
                  "temperature": 25
                },
                "segment_id": 286
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 18467,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 7.905138313770294,
                  "temperature": 25
                },
                "segment_id": 286
              }
            ],
            "entity_states": {}
          },
          "activation_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          },
          "after_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          }
        },
        {
          "machines": true,
          "name": "fluid-lab-r11-a-machines-1783660080036",
          "setup": {
            "success": true,
            "inserted": 2000,
            "tank_segment": 287,
            "member_segment": 287,
            "shared_segment": true,
            "platform": 21,
            "read": {
              "success": true,
              "label": "same-tick frozen",
              "tick": 195766,
              "game_paused": false,
              "platform_paused": true,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 18470,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 1976.2845849394798,
                    "temperature": 25
                  },
                  "segment_id": 287,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 18473,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 287
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 18471,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 287
                },
                {
                  "entity": "pump",
                  "type": "pump",
                  "unit_number": 18474,
                  "index": 1
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 18472,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 287
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 18475,
                  "index": 1,
                  "segment_id": 288,
                  "segment_contents": {}
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 18476,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 18476,
                  "index": 2
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 18476,
                  "index": 3
                }
              ],
              "entity_states": [
                {
                  "entity": "pump",
                  "unit_number": 18474,
                  "active": false,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                },
                {
                  "entity": "chemical-plant",
                  "unit_number": 18476,
                  "active": false,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                }
              ]
            }
          },
          "activation": {
            "success": true,
            "tick": 195814,
            "changed": 2,
            "read": {
              "success": true,
              "label": "activation same tick",
              "tick": 195814,
              "game_paused": false,
              "platform_paused": false,
              "totals": {
                "water": 2000
              },
              "boxes": [
                {
                  "entity": "storage-tank",
                  "type": "storage-tank",
                  "unit_number": 18470,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 1976.2845849394798,
                    "temperature": 25
                  },
                  "segment_id": 287,
                  "segment_contents": {
                    "water": 2000
                  }
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 18473,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 287
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 18471,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 287
                },
                {
                  "entity": "pump",
                  "type": "pump",
                  "unit_number": 18474,
                  "index": 1
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 18472,
                  "index": 1,
                  "direct": {
                    "name": "water",
                    "amount": 7.905138313770294,
                    "temperature": 25
                  },
                  "segment_id": 287
                },
                {
                  "entity": "pipe",
                  "type": "pipe",
                  "unit_number": 18475,
                  "index": 1,
                  "segment_id": 288,
                  "segment_contents": {}
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 18476,
                  "index": 1
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 18476,
                  "index": 2
                },
                {
                  "entity": "chemical-plant",
                  "type": "assembling-machine",
                  "unit_number": 18476,
                  "index": 3
                }
              ],
              "entity_states": [
                {
                  "entity": "pump",
                  "unit_number": 18474,
                  "active": true,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                },
                {
                  "entity": "chemical-plant",
                  "unit_number": 18476,
                  "active": true,
                  "frozen": {
                    "ok": true,
                    "value": false
                  }
                }
              ]
            }
          },
          "after": {
            "success": true,
            "label": "activation +60",
            "tick": 195903,
            "game_paused": false,
            "platform_paused": false,
            "totals": {
              "water": 2000
            },
            "boxes": [
              {
                "entity": "storage-tank",
                "type": "storage-tank",
                "unit_number": 18470,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 1976.2845849394798,
                  "temperature": 25
                },
                "segment_id": 287,
                "segment_contents": {
                  "water": 2000
                }
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 18473,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 7.905138313770294,
                  "temperature": 25
                },
                "segment_id": 287
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 18471,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 7.905138313770294,
                  "temperature": 25
                },
                "segment_id": 287
              },
              {
                "entity": "pump",
                "type": "pump",
                "unit_number": 18474,
                "index": 1
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 18472,
                "index": 1,
                "direct": {
                  "name": "water",
                  "amount": 7.905138313770294,
                  "temperature": 25
                },
                "segment_id": 287
              },
              {
                "entity": "pipe",
                "type": "pipe",
                "unit_number": 18475,
                "index": 1,
                "segment_id": 288,
                "segment_contents": {}
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 18476,
                "index": 1
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 18476,
                "index": 2
              },
              {
                "entity": "chemical-plant",
                "type": "assembling-machine",
                "unit_number": 18476,
                "index": 3
              }
            ],
            "entity_states": [
              {
                "entity": "pump",
                "unit_number": 18474,
                "active": true,
                "frozen": {
                  "ok": true,
                  "value": false
                }
              },
              {
                "entity": "chemical-plant",
                "unit_number": 18476,
                "active": true,
                "frozen": {
                  "ok": true,
                  "value": false
                }
              }
            ]
          },
          "activation_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          },
          "after_compare": {
            "exact": true,
            "epsilon": 0.000001,
            "max_abs_delta": 0,
            "classification": "exact",
            "rows": [
              {
                "name": "water",
                "expected": 2000,
                "actual": 2000,
                "delta": 0
              }
            ]
          }
        }
      ]
    },
    "r11b": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-b-1783660082860",
      "setup": {
        "success": true,
        "platform": 22,
        "writes": [
          {
            "entity": "storage-tank",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 98.81422919034958,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 98.81422919034958,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "pump",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 60,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 60,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 2,
            "write": {
              "accepted": true,
              "fluid": "heavy-oil",
              "amount": 80,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true
                },
                {
                  "fluid": "heavy-oil",
                  "ok": true,
                  "read": {
                    "name": "heavy-oil",
                    "amount": 80,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "chemical-plant",
            "index": 3,
            "write": {
              "accepted": true,
              "fluid": "light-oil",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true
                },
                {
                  "fluid": "heavy-oil",
                  "ok": true
                },
                {
                  "fluid": "light-oil",
                  "ok": true,
                  "read": {
                    "name": "light-oil",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "boiler",
            "index": 1,
            "write": {
              "accepted": true,
              "fluid": "water",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true,
                  "read": {
                    "name": "water",
                    "amount": 100,
                    "temperature": 25
                  }
                }
              ]
            }
          },
          {
            "entity": "boiler",
            "index": 2,
            "write": {
              "accepted": true,
              "fluid": "steam",
              "amount": 100,
              "attempts": [
                {
                  "fluid": "water",
                  "ok": true
                },
                {
                  "fluid": "steam",
                  "ok": true,
                  "read": {
                    "name": "steam",
                    "amount": 100,
                    "temperature": 165
                  }
                }
              ]
            }
          }
        ],
        "read": {
          "success": true,
          "label": "R11b frozen same tick",
          "tick": 195951,
          "game_paused": false,
          "platform_paused": true,
          "totals": {
            "water": 260,
            "heavy-oil": 80,
            "light-oil": 100,
            "steam": 100
          },
          "boxes": [
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 18478,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 98.81422919034958,
                "temperature": 25
              },
              "segment_id": 289,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 18481,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 289
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 18479,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 289
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 18482,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 18480,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 289
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 18483,
              "index": 1,
              "segment_id": 290,
              "segment_contents": {}
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 18484,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 60,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 18484,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 80,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 18484,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 18485,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 291,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 18485,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 100,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 18482,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 18484,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 18485,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "activation": {
        "success": true,
        "tick": 195999,
        "changed": 3,
        "read": {
          "success": true,
          "label": "R11b activation same tick",
          "tick": 195999,
          "game_paused": false,
          "platform_paused": false,
          "totals": {
            "water": 260,
            "heavy-oil": 80,
            "light-oil": 100,
            "steam": 100
          },
          "boxes": [
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 18478,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 98.81422919034958,
                "temperature": 25
              },
              "segment_id": 289,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 18481,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 289
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 18479,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 289
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 18482,
              "index": 1
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 18480,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 0.3952568769454956,
                "temperature": 25
              },
              "segment_id": 289
            },
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 18483,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 290,
              "segment_contents": {
                "water": 100
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 18484,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 60,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 18484,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 80,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 18484,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 100,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 18485,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 100,
                "temperature": 25
              },
              "segment_id": 291,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 18485,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 100,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 18482,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 18484,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 18485,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "after": {
        "success": true,
        "label": "R11b activation +60",
        "tick": 196091,
        "game_paused": false,
        "platform_paused": false,
        "totals": {
          "water": 260,
          "heavy-oil": 80,
          "light-oil": 100,
          "steam": 100
        },
        "boxes": [
          {
            "entity": "storage-tank",
            "type": "storage-tank",
            "unit_number": 18478,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 98.81422919034958,
              "temperature": 25
            },
            "segment_id": 289,
            "segment_contents": {
              "water": 100
            }
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 18481,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 289
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 18479,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 289
          },
          {
            "entity": "pump",
            "type": "pump",
            "unit_number": 18482,
            "index": 1
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 18480,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 0.3952568769454956,
              "temperature": 25
            },
            "segment_id": 289
          },
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 18483,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 100,
              "temperature": 25
            },
            "segment_id": 290,
            "segment_contents": {
              "water": 100
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 18484,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 60,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 18484,
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 80,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 18484,
            "index": 3,
            "direct": {
              "name": "light-oil",
              "amount": 100,
              "temperature": 25
            }
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 18485,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 100,
              "temperature": 25
            },
            "segment_id": 291,
            "segment_contents": {}
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 18485,
            "index": 2,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 165
            }
          }
        ],
        "entity_states": [
          {
            "entity": "pump",
            "unit_number": 18482,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "chemical-plant",
            "unit_number": 18484,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "boiler",
            "unit_number": 18485,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          }
        ]
      },
      "immediate_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 260,
            "actual": 260,
            "delta": 0
          }
        ]
      },
      "settled_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 100,
            "actual": 100,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 260,
            "actual": 260,
            "delta": 0
          }
        ]
      }
    },
    "r11c": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-c-1783660085795",
      "import_state_replication": {
        "entity_creation": "module/import_phases/entity_creation.lua:69 creates through Deserializer; lines 78-91 immediately set active=false for transfer entities",
        "platform_pause": "module/core/import-pipeline.lua:240-245 pauses the transfer platform immediately after creation"
      },
      "setup": {
        "success": true,
        "platform": 23,
        "rows": [
          {
            "name": "pipe",
            "type": "pipe",
            "activatable": false,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 196134
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 196134
            }
          },
          {
            "name": "storage-tank",
            "type": "storage-tank",
            "activatable": false,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 196134
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 196134
            }
          },
          {
            "name": "pump",
            "type": "pump",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 196134
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 196134
            }
          },
          {
            "name": "chemical-plant",
            "type": "assembling-machine",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 196134
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 2,
                "write": {
                  "accepted": true,
                  "fluid": "heavy-oil",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true
                    },
                    {
                      "fluid": "heavy-oil",
                      "ok": true,
                      "read": {
                        "name": "heavy-oil",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 3,
                "write": {
                  "accepted": true,
                  "fluid": "light-oil",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true
                    },
                    {
                      "fluid": "heavy-oil",
                      "ok": true
                    },
                    {
                      "fluid": "light-oil",
                      "ok": true,
                      "read": {
                        "name": "light-oil",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 196134
            }
          },
          {
            "name": "boiler",
            "type": "boiler",
            "activatable": true,
            "before": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 196134
            },
            "writes": [
              {
                "index": 1,
                "write": {
                  "accepted": true,
                  "fluid": "water",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true,
                      "read": {
                        "name": "water",
                        "amount": 50,
                        "temperature": 25
                      }
                    }
                  ]
                }
              },
              {
                "index": 2,
                "write": {
                  "accepted": true,
                  "fluid": "steam",
                  "amount": 50,
                  "attempts": [
                    {
                      "fluid": "water",
                      "ok": true
                    },
                    {
                      "fluid": "steam",
                      "ok": true,
                      "read": {
                        "name": "steam",
                        "amount": 50,
                        "temperature": 165
                      }
                    }
                  ]
                }
              }
            ],
            "accepted": true,
            "fallback_used": false,
            "after": {
              "frozen": {
                "ok": true,
                "value": false
              },
              "tick": 196134
            }
          }
        ],
        "read": {
          "success": true,
          "label": "R11c before first activation",
          "tick": 196134,
          "game_paused": false,
          "platform_paused": true,
          "totals": {
            "water": 200,
            "heavy-oil": 50,
            "light-oil": 50,
            "steam": 50
          },
          "boxes": [
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 18487,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 292,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 18488,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 293,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 18489,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 18490,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 18490,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 18490,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 18491,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 294,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 18491,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 50,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 18489,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 18490,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 18491,
              "active": false,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "activation": {
        "success": true,
        "tick": 196186,
        "changed": 3,
        "read": {
          "success": true,
          "label": "R11c activation same tick",
          "tick": 196186,
          "game_paused": false,
          "platform_paused": false,
          "totals": {
            "water": 200,
            "heavy-oil": 50,
            "light-oil": 50,
            "steam": 50
          },
          "boxes": [
            {
              "entity": "pipe",
              "type": "pipe",
              "unit_number": 18487,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 292,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "storage-tank",
              "type": "storage-tank",
              "unit_number": 18488,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 293,
              "segment_contents": {
                "water": 50
              }
            },
            {
              "entity": "pump",
              "type": "pump",
              "unit_number": 18489,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 18490,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 18490,
              "index": 2,
              "direct": {
                "name": "heavy-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "chemical-plant",
              "type": "assembling-machine",
              "unit_number": 18490,
              "index": 3,
              "direct": {
                "name": "light-oil",
                "amount": 50,
                "temperature": 25
              }
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 18491,
              "index": 1,
              "direct": {
                "name": "water",
                "amount": 50,
                "temperature": 25
              },
              "segment_id": 294,
              "segment_contents": {}
            },
            {
              "entity": "boiler",
              "type": "boiler",
              "unit_number": 18491,
              "index": 2,
              "direct": {
                "name": "steam",
                "amount": 50,
                "temperature": 165
              }
            }
          ],
          "entity_states": [
            {
              "entity": "pump",
              "unit_number": 18489,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "chemical-plant",
              "unit_number": 18490,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            },
            {
              "entity": "boiler",
              "unit_number": 18491,
              "active": true,
              "frozen": {
                "ok": true,
                "value": false
              }
            }
          ]
        }
      },
      "after": {
        "success": true,
        "label": "R11c activation +60",
        "tick": 196302,
        "game_paused": false,
        "platform_paused": false,
        "totals": {
          "water": 200,
          "heavy-oil": 50,
          "light-oil": 50,
          "steam": 50
        },
        "boxes": [
          {
            "entity": "pipe",
            "type": "pipe",
            "unit_number": 18487,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 292,
            "segment_contents": {
              "water": 50
            }
          },
          {
            "entity": "storage-tank",
            "type": "storage-tank",
            "unit_number": 18488,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 293,
            "segment_contents": {
              "water": 50
            }
          },
          {
            "entity": "pump",
            "type": "pump",
            "unit_number": 18489,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 18490,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 18490,
            "index": 2,
            "direct": {
              "name": "heavy-oil",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "chemical-plant",
            "type": "assembling-machine",
            "unit_number": 18490,
            "index": 3,
            "direct": {
              "name": "light-oil",
              "amount": 50,
              "temperature": 25
            }
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 18491,
            "index": 1,
            "direct": {
              "name": "water",
              "amount": 50,
              "temperature": 25
            },
            "segment_id": 294,
            "segment_contents": {}
          },
          {
            "entity": "boiler",
            "type": "boiler",
            "unit_number": 18491,
            "index": 2,
            "direct": {
              "name": "steam",
              "amount": 50,
              "temperature": 165
            }
          }
        ],
        "entity_states": [
          {
            "entity": "pump",
            "unit_number": 18489,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "chemical-plant",
            "unit_number": 18490,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          },
          {
            "entity": "boiler",
            "unit_number": 18491,
            "active": true,
            "frozen": {
              "ok": true,
              "value": false
            }
          }
        ]
      },
      "immediate_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 200,
            "actual": 200,
            "delta": 0
          }
        ]
      },
      "settled_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "heavy-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "light-oil",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "steam",
            "expected": 50,
            "actual": 50,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 200,
            "actual": 200,
            "delta": 0
          }
        ]
      }
    },
    "r11d": {
      "success": true,
      "prediction": "zero loss and zero gain",
      "name": "fluid-lab-r11-d-1783660089105",
      "seed": {
        "success": true,
        "index": 2,
        "count": 1
      },
      "clone": {
        "success": true,
        "tick": 196403,
        "remote": {
          "success": true,
          "job_id": "import_7",
          "platform_name": "fluid-lab-r11-d-1783660089105",
          "source_platform": "test",
          "entity_count": 1359,
          "message": "Clone job started - use /step-tick to process"
        }
      },
      "clone_index": 24,
      "armed": {
        "success": true,
        "tick": 138927
      },
      "transfer_output": "═══════════════════════════════════════\n🚀 Transfer Platform: fluid-lab-r11-d-1783660089105\n═══════════════════════════════════════\nDestination: Instance 1351385547\nPlatform: [24] fluid-lab-r11-d-1783660089105\n\n[1/2] Locking + queueing export...\n[2/2] ✓ Export queued: 008_fluid-lab-r11-d-1783660089105\n⏳ Exporting asynchronously (this may take a while)...\n\nThe transfer will continue automatically:\n  1. Export completes → Sent to controller\n  2. Controller → Sends to destination instance\n  3. Destination imports → Validates counts\n  4. On success → Source deleted automatically\n  5. On failure → Source unlocked automatically\n\n💡 Use /list-platforms to track progress\n═══════════════════════════════════════",
      "wall_ms": 6361,
      "debug_file": "/clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_fluid-lab-r11-d-1783660089105_139106.json",
      "validation_success": true,
      "failed_stage": null,
      "hook_log": {
        "needle": "[Import][TEST][R11] Frozen fluid injection measured for fluid-lab-r11-d-1783660089105",
        "found": true,
        "line": "338.356 Script @__level__/modules/surface_export/core/import-completion.lua:364: [Import][TEST][R11] Frozen fluid injection measured for fluid-lab-r11-d-1783660089105 at tick 139106"
      },
      "measurement": {
        "hook_consumed": true,
        "platform_name": "fluid-lab-r11-d-1783660089105",
        "injection_started_tick": 139106,
        "frozen_census_tick": 139106,
        "platform_paused": true,
        "expected_by_name": {
          "molten-iron": 2308.875861823559,
          "thruster-fuel": 34126.50438582897,
          "thruster-oxidizer": 34187.28570342064,
          "water": 52987.4376475811,
          "fluoroketone-cold": 229.22423404455185,
          "fluoroketone-hot": 8.846314251422882,
          "fusion-plasma": 80,
          "molten-copper": 1943.7102615833282
        },
        "expected_raw": {
          "molten-iron@1500.0C": 2308.875861823559,
          "thruster-fuel@25.0C": 34126.50438582897,
          "thruster-oxidizer@25.0C": 34187.28570342064,
          "water@15.0C": 52987.4376475811,
          "fluoroketone-cold@-150.0C": 229.22423404455185,
          "fluoroketone-hot@180.0C": 8.846314251422882,
          "fusion-plasma@1073447.5C": 10,
          "fusion-plasma@1181850.9C": 20,
          "molten-copper@1100.0C": 1943.7102615833282,
          "fusion-plasma@1959391.1C": 10,
          "fusion-plasma@1073448.5C": 10,
          "fusion-plasma@1070755.6C": 10,
          "fusion-plasma@1177594.8C": 10,
          "fusion-plasma@1962191.4C": 10,
          "fusion-plasma@1177594.4C": 10,
          "fusion-plasma@1070759.1C": 10
        },
        "frozen_actual_raw": {
          "fluoroketone-hot@180.0C": 8.846314251422882,
          "fusion-plasma@1073447.5C": 10,
          "fusion-plasma@1181850.9C": 20,
          "fluoroketone-cold@-150.0C": 229.22423404455185,
          "fusion-plasma@1073448.5C": 10,
          "molten-iron@1500.0C": 2308.875861823559,
          "molten-copper@1100.0C": 1943.7102615833282,
          "thruster-fuel@25.0C": 34126.50438582897,
          "thruster-oxidizer@25.0C": 34187.28570342064,
          "fusion-plasma@1070755.6C": 10,
          "fusion-plasma@1177594.8C": 10,
          "fusion-plasma@1070759.1C": 10,
          "fusion-plasma@1177594.4C": 10,
          "water@15.0C": 52987.4376475811
        },
        "frozen_actual_by_name": {
          "fluoroketone-hot": 8.846314251422882,
          "fusion-plasma": 80,
          "fluoroketone-cold": 229.22423404455185,
          "molten-iron": 2308.875861823559,
          "molten-copper": 1943.7102615833282,
          "thruster-fuel": 34126.50438582897,
          "thruster-oxidizer": 34187.28570342064,
          "water": 52987.4376475811
        },
        "frozen_actual_total": 125871.88440853357,
        "write_rejected": {
          "fusion-plasma": 20
        },
        "activation_census_tick": 139106,
        "post_activation_actual_by_name": {
          "fluoroketone-hot": 8.846314251422882,
          "fusion-plasma": 80,
          "fluoroketone-cold": 229.22423404455185,
          "molten-iron": 2308.875861823559,
          "molten-copper": 1943.7102615833282,
          "thruster-fuel": 34126.50438582897,
          "thruster-oxidizer": 34187.28570342064,
          "water": 52987.4376475811
        },
        "post_activation_actual_raw": {
          "fluoroketone-hot@180.0C": 8.846314251422882,
          "fusion-plasma@1073447.5C": 10,
          "fusion-plasma@1181850.9C": 20,
          "fluoroketone-cold@-150.0C": 229.22423404455185,
          "fusion-plasma@1073448.5C": 10,
          "molten-iron@1500.0C": 2308.875861823559,
          "molten-copper@1100.0C": 1943.7102615833282,
          "thruster-fuel@25.0C": 34126.50438582897,
          "thruster-oxidizer@25.0C": 34187.28570342064,
          "fusion-plasma@1070755.6C": 10,
          "fusion-plasma@1177594.8C": 10,
          "fusion-plasma@1070759.1C": 10,
          "fusion-plasma@1177594.4C": 10,
          "water@15.0C": 52987.4376475811
        },
        "post_activation_actual_total": 125871.88440853357
      },
      "frozen_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "fluoroketone-cold",
            "expected": 229.22423404455185,
            "actual": 229.22423404455185,
            "delta": 0
          },
          {
            "name": "fluoroketone-hot",
            "expected": 8.846314251422882,
            "actual": 8.846314251422882,
            "delta": 0
          },
          {
            "name": "fusion-plasma",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "molten-copper",
            "expected": 1943.7102615833282,
            "actual": 1943.7102615833282,
            "delta": 0
          },
          {
            "name": "molten-iron",
            "expected": 2308.875861823559,
            "actual": 2308.875861823559,
            "delta": 0
          },
          {
            "name": "thruster-fuel",
            "expected": 34126.50438582897,
            "actual": 34126.50438582897,
            "delta": 0
          },
          {
            "name": "thruster-oxidizer",
            "expected": 34187.28570342064,
            "actual": 34187.28570342064,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 52987.4376475811,
            "actual": 52987.4376475811,
            "delta": 0
          }
        ]
      },
      "post_activation_compare": {
        "exact": true,
        "epsilon": 0.000001,
        "max_abs_delta": 0,
        "classification": "exact",
        "rows": [
          {
            "name": "fluoroketone-cold",
            "expected": 229.22423404455185,
            "actual": 229.22423404455185,
            "delta": 0
          },
          {
            "name": "fluoroketone-hot",
            "expected": 8.846314251422882,
            "actual": 8.846314251422882,
            "delta": 0
          },
          {
            "name": "fusion-plasma",
            "expected": 80,
            "actual": 80,
            "delta": 0
          },
          {
            "name": "molten-copper",
            "expected": 1943.7102615833282,
            "actual": 1943.7102615833282,
            "delta": 0
          },
          {
            "name": "molten-iron",
            "expected": 2308.875861823559,
            "actual": 2308.875861823559,
            "delta": 0
          },
          {
            "name": "thruster-fuel",
            "expected": 34126.50438582897,
            "actual": 34126.50438582897,
            "delta": 0
          },
          {
            "name": "thruster-oxidizer",
            "expected": 34187.28570342064,
            "actual": 34187.28570342064,
            "delta": 0
          },
          {
            "name": "water",
            "expected": 52987.4376475811,
            "actual": 52987.4376475811,
            "delta": 0
          }
        ]
      }
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 195221
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 137631
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 195395,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 137808,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 195485,
      "base": "2.0.77"
    },
    "destination": {
      "success": true,
      "tick": 137898,
      "base": "2.0.77"
    }
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "fluid-lab-r11-a-control-1783660077058",
          "fluid-lab-r11-a-machines-1783660080036",
          "fluid-lab-r11-b-1783660082860",
          "fluid-lab-r11-c-1783660085795"
        ],
        "tick": 197018
      },
      "destination": {
        "success": true,
        "deleted": [
          "fluid-lab-r11-d-1783660089105"
        ],
        "tick": 139509
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 197215,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 139696,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T05:08:25.511Z"
}
```

## 2026-07-10 - R11 shared-segment fixture correction and final evidence

A final scope audit found that the earlier R11a tank and pipe run had distinct segment IDs, so those R11a
records proved isolated segments rather than the specified shared segment. The runner was corrected to inject
through a pipe member and to require the pipe and tank to report the same non-nil segment ID. The corrected
focused run passed, with both members reporting segment `204` and conserving 2,000 water exactly.

The definitive consecutive full passes completed at `2026-07-10T05:07:38.649Z` and
`2026-07-10T05:08:25.511Z`. In both, corrected R11a asserted shared segment identity in both variants; R11b
and R11c conserved every fluid exactly without fallback; and R11d retained positive hook/log proof, untouched
raw serialized values, exact frozen and post-activation comparisons, and the measured 100 raw / 20 rejected /
80 restored fusion-plasma accounting. Both passes ended with both-instance seven-field zero-leftover evidence.
These are the final acceptance passes for the committed runner.


## 2026-07-10T06:09:39.563Z - R12 / LAB-B6 temperature grounding

Predictions stated before execution: unequal-volume temperature merges volume-weighted with exact volume conservation; key stability is measured without presuming the 10,000C threshold.

```json
{
  "script": "tests/fluid-lab/run-r12.mjs",
  "started": "2026-07-10T06:09:28.869Z",
  "sections": [
    "b6a",
    "b6b"
  ],
  "predictions": {
    "b6a": "volume-weighted merge with exact volume conservation",
    "b6b": "measure key stability without presuming 10,000C"
  },
  "rungs": {
    "b6a": {
      "success": true,
      "prediction": "2000 steam at 416.25C; water control clamps and cannot carry the requested temperatures",
      "water_control": [
        {
          "asked": 165,
          "read": 100,
          "tick": 429192
        },
        {
          "asked": 500,
          "read": 100,
          "tick": 429192
        }
      ],
      "before": {
        "a": {
          "label": "isolated A",
          "tick": 429192,
          "game_paused": false,
          "direct": {
            "name": "steam",
            "amount": 500,
            "temperature": 165
          },
          "segment_id": 409,
          "segment_contents": {
            "steam": 500
          }
        },
        "b": {
          "label": "isolated B",
          "tick": 429192,
          "game_paused": false,
          "direct": {
            "name": "steam",
            "amount": 1500,
            "temperature": 500
          },
          "segment_id": 410,
          "segment_contents": {
            "steam": 1500
          }
        }
      },
      "topology_same_tick": {
        "label": "connector same tick",
        "tick": 429192,
        "game_paused": false,
        "direct": {
          "name": "steam",
          "amount": 3.9292730689048767,
          "temperature": 416.25
        },
        "segment_id": 409,
        "segment_contents": {
          "steam": 2000
        }
      },
      "merged": {
        "label": "merged after elapsed tick",
        "tick": 429244,
        "game_paused": false,
        "direct": {
          "name": "steam",
          "amount": 3.9292730689048767,
          "temperature": 416.25
        },
        "segment_id": 409,
        "segment_contents": {
          "steam": 2000
        }
      },
      "verdict": "volume-weighted temperature and volume conservation confirmed"
    },
    "b6b": {
      "success": true,
      "prediction": "identify the first engine-read key instability or collision without assuming a threshold",
      "rows": [
        {
          "asked": 9999,
          "tick": 429283,
          "game_paused": false,
          "direct": {
            "name": "steam",
            "amount": 100,
            "temperature": 5000
          },
          "key": "steam@5000.0C"
        },
        {
          "asked": 10001,
          "tick": 429283,
          "game_paused": false,
          "direct": {
            "name": "steam",
            "amount": 100,
            "temperature": 5000
          },
          "key": "steam@5000.0C"
        },
        {
          "asked": 100000,
          "tick": 429283,
          "game_paused": false,
          "direct": {
            "name": "steam",
            "amount": 100,
            "temperature": 5000
          },
          "key": "steam@5000.0C"
        },
        {
          "asked": 1000000,
          "tick": 429283,
          "game_paused": false,
          "direct": {
            "name": "steam",
            "amount": 100,
            "temperature": 5000
          },
          "key": "steam@5000.0C"
        },
        {
          "asked": 10000000,
          "tick": 429283,
          "game_paused": false,
          "direct": {
            "name": "steam",
            "amount": 100,
            "temperature": 5000
          },
          "key": "steam@5000.0C"
        }
      ],
      "reread": {
        "success": true,
        "rows": [
          {
            "tick": 429401,
            "asked_index": 1,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 5000
            },
            "key": "steam@5000.0C"
          },
          {
            "tick": 429401,
            "asked_index": 2,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 5000
            },
            "key": "steam@5000.0C"
          },
          {
            "tick": 429401,
            "asked_index": 3,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 5000
            },
            "key": "steam@5000.0C"
          },
          {
            "tick": 429401,
            "asked_index": 4,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 5000
            },
            "key": "steam@5000.0C"
          },
          {
            "tick": 429401,
            "asked_index": 5,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 5000
            },
            "key": "steam@5000.0C"
          }
        ]
      },
      "stable": true,
      "collisions": [
        "steam@5000.0C",
        "steam@5000.0C",
        "steam@5000.0C",
        "steam@5000.0C"
      ],
      "verdict": "keys stable through 5000C at %.1f formatting"
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 428934
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 373868
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 429034,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 373967,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 429114
    },
    "destination": {
      "success": true,
      "tick": 374047
    }
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "fluid-lab-r12-merge-1783663772929",
          "fluid-lab-r12-keys-1783663774348"
        ],
        "tick": 429440
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 374374
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 429538,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 374470,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T06:09:39.563Z"
}
```


## 2026-07-10T06:11:47.346Z - R12 / LAB-B6 temperature grounding

Predictions stated before execution: unequal-volume temperature merges volume-weighted with exact volume conservation; key stability is measured without presuming the 10,000C threshold.

```json
{
  "script": "tests/fluid-lab/run-r12.mjs",
  "started": "2026-07-10T06:11:36.673Z",
  "sections": [
    "b6a",
    "b6b"
  ],
  "predictions": {
    "b6a": "volume-weighted merge with exact volume conservation",
    "b6b": "measure key stability without presuming 10,000C"
  },
  "rungs": {
    "b6a": {
      "success": true,
      "prediction": "2000 steam at 416.25C; water control clamps and cannot carry the requested temperatures",
      "water_control": [
        {
          "asked": 165,
          "read": 100,
          "tick": 435134
        },
        {
          "asked": 500,
          "read": 100,
          "tick": 435134
        }
      ],
      "before": {
        "a": {
          "label": "isolated A",
          "tick": 435134,
          "game_paused": false,
          "direct": {
            "name": "steam",
            "amount": 500,
            "temperature": 165
          },
          "segment_id": 420,
          "segment_contents": {
            "steam": 500
          }
        },
        "b": {
          "label": "isolated B",
          "tick": 435134,
          "game_paused": false,
          "direct": {
            "name": "steam",
            "amount": 1500,
            "temperature": 500
          },
          "segment_id": 421,
          "segment_contents": {
            "steam": 1500
          }
        }
      },
      "topology_same_tick": {
        "label": "connector same tick",
        "tick": 435134,
        "game_paused": false,
        "direct": {
          "name": "steam",
          "amount": 3.9292730689048767,
          "temperature": 416.25
        },
        "segment_id": 420,
        "segment_contents": {
          "steam": 2000
        }
      },
      "merged": {
        "label": "merged after elapsed tick",
        "tick": 435189,
        "game_paused": false,
        "direct": {
          "name": "steam",
          "amount": 3.9292730689048767,
          "temperature": 416.25
        },
        "segment_id": 420,
        "segment_contents": {
          "steam": 2000
        }
      },
      "verdict": "volume-weighted temperature and volume conservation confirmed"
    },
    "b6b": {
      "success": true,
      "prediction": "identify the first engine-read key instability or collision without assuming a threshold",
      "rows": [
        {
          "asked": 9999,
          "tick": 435227,
          "game_paused": false,
          "direct": {
            "name": "steam",
            "amount": 100,
            "temperature": 5000
          },
          "key": "steam@5000.0C"
        },
        {
          "asked": 10001,
          "tick": 435227,
          "game_paused": false,
          "direct": {
            "name": "steam",
            "amount": 100,
            "temperature": 5000
          },
          "key": "steam@5000.0C"
        },
        {
          "asked": 100000,
          "tick": 435227,
          "game_paused": false,
          "direct": {
            "name": "steam",
            "amount": 100,
            "temperature": 5000
          },
          "key": "steam@5000.0C"
        },
        {
          "asked": 1000000,
          "tick": 435227,
          "game_paused": false,
          "direct": {
            "name": "steam",
            "amount": 100,
            "temperature": 5000
          },
          "key": "steam@5000.0C"
        },
        {
          "asked": 10000000,
          "tick": 435227,
          "game_paused": false,
          "direct": {
            "name": "steam",
            "amount": 100,
            "temperature": 5000
          },
          "key": "steam@5000.0C"
        }
      ],
      "reread": {
        "success": true,
        "rows": [
          {
            "tick": 435343,
            "asked_index": 1,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 5000
            },
            "key": "steam@5000.0C"
          },
          {
            "tick": 435343,
            "asked_index": 2,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 5000
            },
            "key": "steam@5000.0C"
          },
          {
            "tick": 435343,
            "asked_index": 3,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 5000
            },
            "key": "steam@5000.0C"
          },
          {
            "tick": 435343,
            "asked_index": 4,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 5000
            },
            "key": "steam@5000.0C"
          },
          {
            "tick": 435343,
            "asked_index": 5,
            "direct": {
              "name": "steam",
              "amount": 100,
              "temperature": 5000
            },
            "key": "steam@5000.0C"
          }
        ]
      },
      "stable": true,
      "collisions": [
        "steam@5000.0C",
        "steam@5000.0C",
        "steam@5000.0C",
        "steam@5000.0C"
      ],
      "verdict": "keys stable through 5000C at %.1f formatting"
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 434876
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 382017
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 434978,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 382116,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 435055
    },
    "destination": {
      "success": true,
      "tick": 382194
    }
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "fluid-lab-r12-merge-1783663900713",
          "fluid-lab-r12-keys-1783663902196"
        ],
        "tick": 435381
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 382519
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 435478,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      },
      "destination": {
        "success": true,
        "tick": 382617,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T06:11:47.346Z"
}
```
## 2026-07-11 - R13 T1 original anomaly (hard-stop record)

Prediction: total fusion-plasma V and VxT would conserve across a real transfer. The steam control would
conserve exactly.

The source census was frozen and pre-export at tick `1058548`. The destination census labeled "frozen" was
actually taken after the production transfer had completed its synchronous gate and activation path, at tick
`994742`; the runner then re-paused the platform. It therefore did **not** measure pre-activation state, and the
elapsed ticks from go-live were not instrumented. Plasma readings came from fusion-generator local buffers and
fusion-reactor output fluidboxes; no passive pipe/tank plasma holder existed. This is the confound T1b isolates.

Measured total fusion plasma: volume `100 -> 99.99038809537888`; VxT
`125899506.25 -> 139043269.49285108` (`+10.439884662257028%`). Steam at `165C` remained exact:
volume `1000 -> 1000`, VxT `165000 -> 165000`. The anomaly is not classified as transfer loss; current
hypothesis is post-activation regeneration in engine-managed plasma outputs (Pitfall #21, fusion output fluid
temperature is engine-managed).


## 2026-07-11T18:12:43.727Z - T1c plasma decomposition

Predictions stated before execution: R0 precision sweep; R1 isolated ownership stable and plumbed engine mechanics; R2 honest residual classification.

```json
{
  "script": "tests/fluid-lab/run-t1c.mjs",
  "started": "2026-07-11T18:12:06.052Z",
  "sections": [
    "r0",
    "r1",
    "r2"
  ],
  "predictions": {
    "r0": "same-tick precision sweep",
    "r1": "isolated stable; plumbed segment mechanics",
    "r2": "recompute prior residual"
  },
  "rungs": {
    "r0": {
      "success": true,
      "prediction": "same-tick float precision error grows with magnitude",
      "rows": [
        {
          "tick": 1923785,
          "written": 1000000,
          "read": 1000000,
          "error": 0,
          "amount": 100
        },
        {
          "tick": 1923785,
          "written": 1234567,
          "read": 1234567,
          "error": 0,
          "amount": 100
        },
        {
          "tick": 1923785,
          "written": 1252651,
          "read": 1252651,
          "error": 0,
          "amount": 100
        },
        {
          "tick": 1923785,
          "written": 2000000,
          "read": 2000000,
          "error": 0,
          "amount": 100
        },
        {
          "tick": 1923785,
          "written": 5000000,
          "read": 5000000,
          "error": 0,
          "amount": 100
        }
      ]
    },
    "r1": {
      "success": true,
      "prediction": "isolated ownership stable; plumbed shares reactor segment",
      "fixture": {
        "success": true,
        "tick": 1923939,
        "isolated": {
          "x": -12.5,
          "y": -36.5,
          "nearby_fluidboxes": 0,
          "read": {
            "amount": 100,
            "temp": 1234567
          }
        },
        "plumbed": {
          "x": -4.5,
          "y": -5.5
        },
        "reactor_output_segment": 3612,
        "plumbed_segment": 3646
      },
      "before": {
        "success": true,
        "label": "source frozen",
        "tick": 1924014,
        "isolated": {
          "entity": "pipe",
          "tick": 1924014,
          "direct": {
            "name": "fusion-plasma",
            "amount": 100,
            "temp": 1234567,
            "energy": 123456700
          },
          "segment_id": 3645,
          "segment": {
            "fusion-plasma": 100
          }
        },
        "plumbed": {
          "entity": "pipe",
          "tick": 1924014,
          "segment_id": 3646,
          "segment": {}
        }
      },
      "after": {
        "success": true,
        "label": "destination frozen",
        "tick": 1866463,
        "isolated": {
          "entity": "pipe",
          "tick": 1866463,
          "direct": {
            "name": "fusion-plasma",
            "amount": 100,
            "temp": 1234567,
            "energy": 123456700
          },
          "segment_id": 3181,
          "segment": {
            "fusion-plasma": 100
          }
        },
        "plumbed": {
          "entity": "pipe",
          "tick": 1866463,
          "segment_id": 3185,
          "segment": {}
        }
      },
      "isolated": {
        "source": {
          "name": "fusion-plasma",
          "amount": 100,
          "temp": 1234567,
          "energy": 123456700
        },
        "destination": {
          "name": "fusion-plasma",
          "amount": 100,
          "temp": 1234567,
          "energy": 123456700
        },
        "volume_delta": 0,
        "energy_delta": 0
      },
      "plumbed_same_segment_source": false
    },
    "r2": {
      "success": true,
      "prediction": "quantization explains the prior residual or residual remains UNEXPLAINED",
      "raw_delta": 681796.25,
      "quantization_adjustment": 0,
      "residual": 681796.25,
      "classification": "UNEXPLAINED"
    }
  },
  "errors": [],
  "initial_reset": {
    "source": {
      "success": true,
      "surfaces": 0,
      "storage": false,
      "game_paused": false,
      "holds": 0,
      "locks": 0,
      "jobs": 0,
      "tombstones": 0
    },
    "destination": {
      "success": true,
      "surfaces": 0,
      "storage": false,
      "game_paused": false,
      "holds": 0,
      "locks": 0,
      "jobs": 0,
      "tombstones": 0
    },
    "ok": true
  },
  "final_reset": {
    "source": {
      "success": true,
      "surfaces": 0,
      "storage": false,
      "game_paused": false,
      "holds": 0,
      "locks": 0,
      "jobs": 0,
      "tombstones": 0
    },
    "destination": {
      "success": true,
      "surfaces": 0,
      "storage": false,
      "game_paused": false,
      "holds": 0,
      "locks": 0,
      "jobs": 0,
      "tombstones": 0
    },
    "ok": true
  },
  "finished": "2026-07-11T18:12:43.727Z"
}
```


## 2026-07-11T18:13:20.232Z - T1c plasma decomposition

Predictions stated before execution: R0 precision sweep; R1 isolated ownership stable and plumbed engine mechanics; R2 honest residual classification.

```json
{
  "script": "tests/fluid-lab/run-t1c.mjs",
  "started": "2026-07-11T18:12:43.776Z",
  "sections": [
    "r0",
    "r1",
    "r2"
  ],
  "predictions": {
    "r0": "same-tick precision sweep",
    "r1": "isolated stable; plumbed segment mechanics",
    "r2": "recompute prior residual"
  },
  "rungs": {
    "r0": {
      "success": true,
      "prediction": "same-tick float precision error grows with magnitude",
      "rows": [
        {
          "tick": 1924683,
          "written": 1000000,
          "read": 1000000,
          "error": 0,
          "amount": 100
        },
        {
          "tick": 1924683,
          "written": 1234567,
          "read": 1234567,
          "error": 0,
          "amount": 100
        },
        {
          "tick": 1924683,
          "written": 1252651,
          "read": 1252651,
          "error": 0,
          "amount": 100
        },
        {
          "tick": 1924683,
          "written": 2000000,
          "read": 2000000,
          "error": 0,
          "amount": 100
        },
        {
          "tick": 1924683,
          "written": 5000000,
          "read": 5000000,
          "error": 0,
          "amount": 100
        }
      ]
    },
    "r1": {
      "success": true,
      "prediction": "isolated ownership stable; plumbed shares reactor segment",
      "fixture": {
        "success": true,
        "tick": 1924837,
        "isolated": {
          "x": -12.5,
          "y": -36.5,
          "nearby_fluidboxes": 0,
          "read": {
            "amount": 100,
            "temp": 1234567
          }
        },
        "plumbed": {
          "x": -4.5,
          "y": -5.5
        },
        "reactor_output_segment": 3685,
        "plumbed_segment": 3719
      },
      "before": {
        "success": true,
        "label": "source frozen",
        "tick": 1924910,
        "isolated": {
          "entity": "pipe",
          "tick": 1924910,
          "direct": {
            "name": "fusion-plasma",
            "amount": 100,
            "temp": 1234567,
            "energy": 123456700
          },
          "segment_id": 3718,
          "segment": {
            "fusion-plasma": 100
          }
        },
        "plumbed": {
          "entity": "pipe",
          "tick": 1924910,
          "segment_id": 3719,
          "segment": {}
        }
      },
      "after": {
        "success": true,
        "label": "destination frozen",
        "tick": 1868772,
        "isolated": {
          "entity": "pipe",
          "tick": 1868772,
          "direct": {
            "name": "fusion-plasma",
            "amount": 100,
            "temp": 1234567,
            "energy": 123456700
          },
          "segment_id": 3260,
          "segment": {
            "fusion-plasma": 100
          }
        },
        "plumbed": {
          "entity": "pipe",
          "tick": 1868772,
          "segment_id": 3264,
          "segment": {}
        }
      },
      "isolated": {
        "source": {
          "name": "fusion-plasma",
          "amount": 100,
          "temp": 1234567,
          "energy": 123456700
        },
        "destination": {
          "name": "fusion-plasma",
          "amount": 100,
          "temp": 1234567,
          "energy": 123456700
        },
        "volume_delta": 0,
        "energy_delta": 0
      },
      "plumbed_same_segment_source": false
    },
    "r2": {
      "success": true,
      "prediction": "quantization explains the prior residual or residual remains UNEXPLAINED",
      "raw_delta": 681796.25,
      "quantization_adjustment": 0,
      "residual": 681796.25,
      "classification": "UNEXPLAINED"
    }
  },
  "errors": [],
  "initial_reset": {
    "source": {
      "success": true,
      "surfaces": 0,
      "storage": false,
      "game_paused": false,
      "holds": 0,
      "locks": 0,
      "jobs": 0,
      "tombstones": 0
    },
    "destination": {
      "success": true,
      "surfaces": 0,
      "storage": false,
      "game_paused": false,
      "holds": 0,
      "locks": 0,
      "jobs": 0,
      "tombstones": 0
    },
    "ok": true
  },
  "final_reset": {
    "source": {
      "success": true,
      "surfaces": 0,
      "storage": false,
      "game_paused": false,
      "holds": 0,
      "locks": 0,
      "jobs": 0,
      "tombstones": 0
    },
    "destination": {
      "success": true,
      "surfaces": 0,
      "storage": false,
      "game_paused": false,
      "holds": 0,
      "locks": 0,
      "jobs": 0,
      "tombstones": 0
    },
    "ok": true
  },
  "finished": "2026-07-11T18:13:20.232Z"
}
```
## 2026-07-11 - Plasma engine-owned exclusion forensics and hard stop

Prediction: the failed T2 transfer's `fusion-plasma` shortfall comes from engine reassertion of
fusion-reactor output boxes, while isolated plasma remains exactly restorable.

### Banked T2 black-box reconstruction

- Raw source plasma: `100`.
- Import write-rejected subtraction: `4.0278787612915` (inferred from raw `100` to expected
  `95.9721212387085`).
- Frozen gate actual: `80`.
- Exact shortfall: `15.972121238708496`, entirely `fusion-plasma`.
- Physical source scan: eight fusion-generator input buffers at `10` each plus two fusion-reactor
  output boxes at approximately `10` each.
- Classification: the old write/readback path falsely treated roughly `16` units as accepted before
  the engine reasserted the reactor outputs. This explains the T2 plasma shortfall; T1c's VxT residual
  remains `UNEXPLAINED` because this run does not reconstruct its temperature distribution.

### First permanent-fixture run after symmetric plasma exclusion

The fixture was a stripped clone retaining the hub, two fusion reactors, eight fusion generators,
and one isolated pipe seeded with `5 fusion-plasma`. Both reactor output boxes were explicitly seeded
with `10 fusion-plasma` and read back before transfer.

- Engine-owned plasma surfaced informationally: `20`.
- Restorable expected plasma: `85` (the stable generator inputs plus the isolated `5` control).
- Plasma classification and skip logs fired for both reactor outputs.
- The run stopped on a new frozen-census loss class before the N=3/N=5 package could continue:
  `fluoroketone-cold expected 214.991133, actual 0, delta -214.991133`.
- Restoration had logged `insert_fluid recovered 215.0/215.0` into the fusion-reactor input segment,
  but the strict gate then observed zero. No tolerance or exact-gate code was changed.
- Result: **HARD STOP** under the one-shot brief. The plasma hypothesis is supported but the complete
  exclusion fix is not certified because the fixture revealed a separate reactor-input conservation
  problem.
- Cleanup proof: host-1 and host-2 each reported zero destination holds, zero locked platforms, zero
  async jobs, zero committed tombstones, and `game.tick_paused=false`.

### Adversarial design attack: segment-wide exclusion is unsafe

The required pre-implementation attack was reconstructed after the first implementation pass and found
a real-loss masking scenario. A pipe or storage tank connected to a fusion-reactor output shares that
output's fluid segment. Fluid in the passive holder remains player-recoverable: the player can disconnect
the holder and keep its contents. Classifying the entire shared segment as `engine_owned` excludes that
recoverable amount from both export expected counts and the destination gate census. Symmetry keeps the
comparison numerically commensurate, but it can make complete loss of the passive-holder fluid invisible.

The permanent fixture did not challenge this case: it removed all connected pipes, retained reactor and
generator machines, and placed the `5 fusion-plasma` control in an isolated pipe. It therefore proved only
that isolated plasma remains counted and reactor-output plasma is excluded; it did not execute Phase 2's
required output-connected pipe/tank case.

Result: **HARD STOP**. The segment-wide exclusion design is not safe to certify or publish as implemented.
No production change, gate change, or additional cluster run was made after this finding.

## 2026-07-11 - P2 segment-persistence fixture boundary

Prediction: ordinary pipes or tanks can share a fluid segment with a fusion-reactor plasma output, so
P2 can distinguish engine-owned-box reassertion from whole-segment reassertion.

The prediction was refuted before the N=5 matrix:

- A focused `single` harness run completed cleanly, but the reactor output and visually adjacent pipes
  had different segment IDs. The pipe-only segment conserved `100 -> 100 -> 100`; it was not evidence
  about reactor-connected plasma.
- Prototype inspection explains why. `fusion-reactor` output box 2 has connection category
  `fusion-plasma`; ordinary `pipe` and `storage-tank` connections use category `default`.
- An exhaustive census of every entity prototype on Factorio 2.0.77 found exactly three fluidboxes
  accepting `fusion-plasma`: `fusion-reactor` output box 2, `fusion-generator` input box 1, and the
  cheat-only `infinity-pipe`. No player-placeable passive holder supports the category.
- Therefore P2 fixtures (a) single reactor + connected pipes, (b) two reactors sharing a pipe network,
  and (c) reactor + connected pipes + tank are unconstructible on the pinned engine. The accepted
  premise that a player can disconnect such a holder and retain plasma is false for ordinary gameplay.
- The runner now asserts segment-ID equality for every purported connected fixture, preventing visual
  adjacency from being mistaken for a shared segment.

Result: **HARD STOP / OWNER ADJUDICATION REQUIRED**. No N=5 matrix was run, no exclusion redesign was
attempted, and the exact gate remains untouched. The remaining constructible network is reactor output
to fusion-generator input; whether that machine-only segment contains any player-recoverable state is
the next design question, not something this rung may silently substitute.

## 2026-07-11 - Design v2 category-based engine ownership

The owner re-adjudicated engine ownership from the P2 prototype census: any fluidbox whose connection
categories omit `default` is inaccessible to ordinary player pipes and tanks. Classification is now
derived generically from `fluidbox_prototype.pipe_connections[].connection_category`; no prototype
allowlist participates in the decision. Export emits a warning if a non-default category or owning
prototype falls outside today's measured fusion family.

Permanent production-shaped fixture evidence (`tests/integration/plasma-engine-owned`):

- Pre-fix RED: transfer validation passed physically, but `engineOwnedFluids` was absent (`owned=0`) and
  managed plasma remained in expected accounting (`expectedPlasma=85`).
- Post-fix GREEN: five independent disposable 1,359-entity clones, each with two fusion reactors, eight
  fusion generators, read-back-asserted reactor output plasma, and one isolated 5-unit plasma control.
- Result: exact gate green `5/5`; every run reported positive engine-owned plasma and retained at least
  the isolated 5 units in restorable expected plasma.
- The exact gate epsilon and verdict semantics remain unchanged.

Design v2's dedicated fixture is green. LAB-TAIL certification is not complete: its subsequent T2 pass
hard-stopped on an independent intermittent item mismatch, recorded in `tests/ops-lab/NOTEBOOK.md`.

## 2026-07-19 — LIVE PROBE challenges the fusion write-rejection law (Pitfall #21) — RUNG NEEDED

Owner hand-built a full fusion fluid loop on pad slot (36,36) (cryo plant + reactor + generator +
infinity-pipe seeding fusion-plasma) and observed the engine happily fills plasma boxes from an
infinity pipe. Follow-up scratch probe [live gallery, 2.0.77, scratch entities created+destroyed
same execution]: fusion-GENERATOR insert_fluid(plasma 10) -> readback 10 (both insert_fluid and
fluidbox[] write stick); fusion-REACTOR insert_fluid(plasma 10) -> readback 10 — CONTRADICTS the
blanket "fusion-reactor output fluidboxes reject writes" law. R11's write_rejected subtractions
were real measurements during transfers, so the rejection is likely CONDITIONAL (entity state /
segment connection / activation / fresh-vs-settled), not universal. The blanket generalization is
WRONG as scoped.

Consequence if a proper rung confirms: plasma is serializable+restorable; the engine-owned
exclusion narrows or retires (/di-change — it sits on the strict gate); census-fusion's ignition
ritual collapses to infinity-pipe seeding; the owner's hand-built loop becomes the fusion fixture.
DO NOT change api-notes or the exclusion from this single probe — rung first (conditions matrix:
fresh/connected/frozen/import-path), per [[lab-before-design]].


## 2026-07-20T00:02:40.207Z - fluid-lab R14 fusion write-rejection conditions matrix

Prediction stated before execution. Scratch-only on host-1; owner gallery loop untouched. Cite as "fluid-lab R14" (distinct from belt-lab BELT-R14).

```json
{
  "script": "tests/fluid-lab/run-r14-fusion-write-matrix.mjs",
  "rung": "fluid-lab R14",
  "started": "2026-07-20T00:02:33.330Z",
  "prediction": "Fusion plasma writes (both fluidbox[i]= and insert_fluid) ACCEPT on fresh/inactive/settled reactor-output and generator-input boxes at 2.0.77; the blanket Pitfall #21 'reactor output rejects writes' does not reproduce under any cheaply-constructible scratch condition, meaning R11's write_rejected was a topology/capacity artifact of the live transfer segment, not a categorical output-box rejection.",
  "errors": [],
  "initial_reset": {
    "success": true,
    "surfaces": 0,
    "storage": false,
    "game_paused": false,
    "holds": 0,
    "locks": 0,
    "jobs": 0,
    "ok": true
  },
  "setup": {
    "success": true,
    "name": "fluid-lab-r14-865169",
    "index": 5,
    "settled_reactor": 14316,
    "settled_generator": 14317,
    "tick": 865169
  },
  "matrix": {
    "tick_start": 865304,
    "cells": [
      {
        "path": "fluidbox",
        "box": 2,
        "active": true,
        "production_type": "output",
        "categories": [
          "fusion-plasma"
        ],
        "ok": true,
        "readback": {
          "name": "fusion-plasma",
          "amount": 10,
          "temp": 1000000
        },
        "seg_id": 69,
        "seg_contents": {},
        "accepted": true,
        "tick": 865304,
        "label": "reactor_output/fresh_active"
      },
      {
        "path": "insert_fluid",
        "box": 2,
        "active": true,
        "production_type": "output",
        "categories": [
          "fusion-plasma"
        ],
        "ok": true,
        "inserted": 10,
        "readback": {
          "name": "fusion-plasma",
          "amount": 10,
          "temp": 1000000
        },
        "seg_id": 71,
        "seg_contents": {},
        "accepted": true,
        "tick": 865304,
        "label": "reactor_output/fresh_active"
      },
      {
        "path": "fluidbox",
        "box": 2,
        "active": false,
        "production_type": "output",
        "categories": [
          "fusion-plasma"
        ],
        "ok": true,
        "readback": {
          "name": "fusion-plasma",
          "amount": 10,
          "temp": 1000000
        },
        "seg_id": 73,
        "seg_contents": {},
        "accepted": true,
        "tick": 865304,
        "label": "reactor_output/fresh_inactive"
      },
      {
        "path": "insert_fluid",
        "box": 2,
        "active": false,
        "production_type": "output",
        "categories": [
          "fusion-plasma"
        ],
        "ok": true,
        "inserted": 10,
        "readback": {
          "name": "fusion-plasma",
          "amount": 10,
          "temp": 1000000
        },
        "seg_id": 75,
        "seg_contents": {},
        "accepted": true,
        "tick": 865304,
        "label": "reactor_output/fresh_inactive"
      },
      {
        "path": "fluidbox",
        "box": 1,
        "active": true,
        "production_type": "input",
        "categories": [
          "fusion-plasma"
        ],
        "ok": true,
        "readback": {
          "name": "fusion-plasma",
          "amount": 10,
          "temp": 1000000
        },
        "accepted": true,
        "tick": 865304,
        "label": "generator_input/fresh_active"
      },
      {
        "path": "insert_fluid",
        "box": 1,
        "active": true,
        "production_type": "input",
        "categories": [
          "fusion-plasma"
        ],
        "ok": true,
        "inserted": 10,
        "readback": {
          "name": "fusion-plasma",
          "amount": 10,
          "temp": 1000000
        },
        "accepted": true,
        "tick": 865304,
        "label": "generator_input/fresh_active"
      },
      {
        "path": "fluidbox",
        "box": 1,
        "active": false,
        "production_type": "input",
        "categories": [
          "fusion-plasma"
        ],
        "ok": true,
        "readback": {
          "name": "fusion-plasma",
          "amount": 10,
          "temp": 1000000
        },
        "accepted": true,
        "tick": 865304,
        "label": "generator_input/fresh_inactive"
      },
      {
        "path": "insert_fluid",
        "box": 1,
        "active": false,
        "production_type": "input",
        "categories": [
          "fusion-plasma"
        ],
        "ok": true,
        "inserted": 10,
        "readback": {
          "name": "fusion-plasma",
          "amount": 10,
          "temp": 1000000
        },
        "accepted": true,
        "tick": 865304,
        "label": "generator_input/fresh_inactive"
      },
      {
        "path": "fluidbox",
        "box": 2,
        "active": true,
        "production_type": "output",
        "categories": [
          "fusion-plasma"
        ],
        "ok": true,
        "readback": {
          "name": "fusion-plasma",
          "amount": 10,
          "temp": 1000000
        },
        "seg_id": 65,
        "seg_contents": {},
        "accepted": true,
        "tick": 865304,
        "label": "reactor_output/settled",
        "unit": 14316
      },
      {
        "path": "insert_fluid",
        "box": 2,
        "active": true,
        "production_type": "output",
        "categories": [
          "fusion-plasma"
        ],
        "ok": true,
        "inserted": 10,
        "readback": {
          "name": "fusion-plasma",
          "amount": 10,
          "temp": 1000000
        },
        "seg_id": 65,
        "seg_contents": {},
        "accepted": true,
        "tick": 865304,
        "label": "reactor_output/settled",
        "unit": 14316
      },
      {
        "path": "fluidbox",
        "box": 1,
        "active": true,
        "production_type": "input",
        "categories": [
          "fusion-plasma"
        ],
        "ok": true,
        "readback": {
          "name": "fusion-plasma",
          "amount": 10,
          "temp": 1000000
        },
        "accepted": true,
        "tick": 865304,
        "label": "generator_input/settled",
        "unit": 14317
      },
      {
        "path": "insert_fluid",
        "box": 1,
        "active": true,
        "production_type": "input",
        "categories": [
          "fusion-plasma"
        ],
        "ok": true,
        "inserted": 10,
        "readback": {
          "name": "fusion-plasma",
          "amount": 10,
          "temp": 1000000
        },
        "accepted": true,
        "tick": 865304,
        "label": "generator_input/settled",
        "unit": 14317
      }
    ],
    "box_layout": {
      "reactor": [
        {
          "production_type": "input",
          "categories": [
            "default"
          ]
        },
        {
          "production_type": "output",
          "categories": [
            "fusion-plasma"
          ]
        }
      ],
      "generator": [
        {
          "production_type": "input",
          "categories": [
            "fusion-plasma"
          ]
        },
        {
          "production_type": "output",
          "categories": [
            "default"
          ]
        }
      ]
    },
    "connected": {
      "base_reactor_out_seg": 77,
      "attempts": [
        {
          "off": [
            0,
            4
          ],
          "infinity_pipe_seg": 78,
          "reactor_out_seg": 77,
          "shares": false
        },
        {
          "off": [
            4,
            0
          ],
          "infinity_pipe_seg": 79,
          "reactor_out_seg": 77,
          "shares": false
        }
      ],
      "constructible": false
    },
    "import_path": {
      "target": "fusion-reactor",
      "box": 2,
      "fluidbox_write_ok": true,
      "verify_actual_amount": 10,
      "retry_fired": false,
      "classified": "accepted_first_write",
      "final_readback": {
        "name": "fusion-plasma",
        "amount": 10
      }
    },
    "tick_end": 865304
  },
  "box_layout": {
    "reactor": [
      {
        "production_type": "input",
        "categories": [
          "default"
        ]
      },
      {
        "production_type": "output",
        "categories": [
          "fusion-plasma"
        ]
      }
    ],
    "generator": [
      {
        "production_type": "input",
        "categories": [
          "fusion-plasma"
        ]
      },
      {
        "production_type": "output",
        "categories": [
          "default"
        ]
      }
    ]
  },
  "connected": {
    "base_reactor_out_seg": 77,
    "attempts": [
      {
        "off": [
          0,
          4
        ],
        "infinity_pipe_seg": 78,
        "reactor_out_seg": 77,
        "shares": false
      },
      {
        "off": [
          4,
          0
        ],
        "infinity_pipe_seg": 79,
        "reactor_out_seg": 77,
        "shares": false
      }
    ],
    "constructible": false
  },
  "import_path": {
    "target": "fusion-reactor",
    "box": 2,
    "fluidbox_write_ok": true,
    "verify_actual_amount": 10,
    "retry_fired": false,
    "classified": "accepted_first_write",
    "final_readback": {
      "name": "fusion-plasma",
      "amount": 10
    }
  },
  "summary": {
    "rows": [
      {
        "cell": "reactor_output/fresh_active",
        "path": "fluidbox",
        "box_production_type": "output",
        "categories": "fusion-plasma",
        "active": true,
        "write_ok": true,
        "write_err": null,
        "inserted": null,
        "readback_amount": 10,
        "seg_id": 69,
        "accepted": true,
        "tick": 865304
      },
      {
        "cell": "reactor_output/fresh_active",
        "path": "insert_fluid",
        "box_production_type": "output",
        "categories": "fusion-plasma",
        "active": true,
        "write_ok": true,
        "write_err": null,
        "inserted": 10,
        "readback_amount": 10,
        "seg_id": 71,
        "accepted": true,
        "tick": 865304
      },
      {
        "cell": "reactor_output/fresh_inactive",
        "path": "fluidbox",
        "box_production_type": "output",
        "categories": "fusion-plasma",
        "active": false,
        "write_ok": true,
        "write_err": null,
        "inserted": null,
        "readback_amount": 10,
        "seg_id": 73,
        "accepted": true,
        "tick": 865304
      },
      {
        "cell": "reactor_output/fresh_inactive",
        "path": "insert_fluid",
        "box_production_type": "output",
        "categories": "fusion-plasma",
        "active": false,
        "write_ok": true,
        "write_err": null,
        "inserted": 10,
        "readback_amount": 10,
        "seg_id": 75,
        "accepted": true,
        "tick": 865304
      },
      {
        "cell": "generator_input/fresh_active",
        "path": "fluidbox",
        "box_production_type": "input",
        "categories": "fusion-plasma",
        "active": true,
        "write_ok": true,
        "write_err": null,
        "inserted": null,
        "readback_amount": 10,
        "seg_id": null,
        "accepted": true,
        "tick": 865304
      },
      {
        "cell": "generator_input/fresh_active",
        "path": "insert_fluid",
        "box_production_type": "input",
        "categories": "fusion-plasma",
        "active": true,
        "write_ok": true,
        "write_err": null,
        "inserted": 10,
        "readback_amount": 10,
        "seg_id": null,
        "accepted": true,
        "tick": 865304
      },
      {
        "cell": "generator_input/fresh_inactive",
        "path": "fluidbox",
        "box_production_type": "input",
        "categories": "fusion-plasma",
        "active": false,
        "write_ok": true,
        "write_err": null,
        "inserted": null,
        "readback_amount": 10,
        "seg_id": null,
        "accepted": true,
        "tick": 865304
      },
      {
        "cell": "generator_input/fresh_inactive",
        "path": "insert_fluid",
        "box_production_type": "input",
        "categories": "fusion-plasma",
        "active": false,
        "write_ok": true,
        "write_err": null,
        "inserted": 10,
        "readback_amount": 10,
        "seg_id": null,
        "accepted": true,
        "tick": 865304
      },
      {
        "cell": "reactor_output/settled",
        "path": "fluidbox",
        "box_production_type": "output",
        "categories": "fusion-plasma",
        "active": true,
        "write_ok": true,
        "write_err": null,
        "inserted": null,
        "readback_amount": 10,
        "seg_id": 65,
        "accepted": true,
        "tick": 865304
      },
      {
        "cell": "reactor_output/settled",
        "path": "insert_fluid",
        "box_production_type": "output",
        "categories": "fusion-plasma",
        "active": true,
        "write_ok": true,
        "write_err": null,
        "inserted": 10,
        "readback_amount": 10,
        "seg_id": 65,
        "accepted": true,
        "tick": 865304
      },
      {
        "cell": "generator_input/settled",
        "path": "fluidbox",
        "box_production_type": "input",
        "categories": "fusion-plasma",
        "active": true,
        "write_ok": true,
        "write_err": null,
        "inserted": null,
        "readback_amount": 10,
        "seg_id": null,
        "accepted": true,
        "tick": 865304
      },
      {
        "cell": "generator_input/settled",
        "path": "insert_fluid",
        "box_production_type": "input",
        "categories": "fusion-plasma",
        "active": true,
        "write_ok": true,
        "write_err": null,
        "inserted": 10,
        "readback_amount": 10,
        "seg_id": null,
        "accepted": true,
        "tick": 865304
      }
    ],
    "any_write_rejected": false
  },
  "final_reset": {
    "success": true,
    "surfaces": 0,
    "storage": false,
    "game_paused": false,
    "holds": 0,
    "locks": 0,
    "jobs": 0,
    "ok": true
  },
  "finished": "2026-07-20T00:02:40.207Z"
}
```

## 2026-07-20 — fluid-lab R15 (inline): buffer-class segment read — the 271-drop mechanism ISOLATED

Inline single-call rung on host-1 nauvis scratch (created+destroyed same execution, tick 869540):
fusion-reactor + 4 connected pipes, insert_fluid(fluoroketone-cold 500) into the reactor.
READINGS: reactor box local_amount=500, seg_id=82, get_fluid_segment_contents={} (EMPTY);
pipe box local=0, same seg 82, contents={}.

**Law confirmed [empirical, 2.0.77]: entity-buffered fluid is NOT part of segment contents even
when the box exposes the segment ID** — the buffer-class law is engine semantics; the API doc's
"counts of all fluids in the fluid segment" is incomplete, not wrong.

**The audit's 271-drop on the owner's live loop (belt-combined-omnibus-adjacent fluid loop) is
therefore OUR counter's bug — ORDER-DEPENDENT**: SurfaceCounter's segment pass marks a segment
counted-once; an EMPTY pipe processed first claims the segment (buffer-class fallback reads the
pipe's local 0), and the reactor's buffered amount is skipped as already-counted. census-fusion
never exposed this: its reactor has no pipes, so nothing claims the segment first.

**UNVERIFIED IMPLICATION (needs kill-measurement before asserting): silent transfer loss.** The
serializer shares the accessor — if export drops the buffered amount and the dest census drops it
identically, the strict gate passes while fluid is physically lost (blind both sides, the
script-state blindness class). Fix + kill-measurement = /di-change on the shared accessor
(read buffered boxes locally regardless of segment-counted state; dedupe only true shared volume).
Companion: fluid-lab R14 (same date, runner committed) found NO fusion write rejection in any
scratch condition at 2.0.77 — Pitfall #21's blanket law does not reproduce; R11's write_rejected
remains real-but-unexplained (topology/capacity artifact hypothesis). Law revision gated on the
same /di-change arc.
