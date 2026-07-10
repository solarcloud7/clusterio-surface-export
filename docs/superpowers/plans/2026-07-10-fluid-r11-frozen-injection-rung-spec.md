# Fluid-lab R11 — frozen-world fluid injection (the rung that may retire the post-activation fluid gate)

> **Provenance:** owner adjudication, 2026-07-10. This spec is the durable record of that conversation — if you
> are reading this instead of the chat, you have everything that mattered from it.
> **Sequencing:** this rung runs BEFORE the #30 gate hardening. The 2026-07-09 gate-hardening agent brief is ON
> HOLD (see its status header) — its fluid BAND + complete-loss FLOOR semantics were REJECTED by the owner and
> are superseded by the contract below.

## Owner law (contract update — supersedes any band/floor language elsewhere)

Regular fluids have the SAME parity contract as items and entities: **0 loss, 0 gain, before vs after. Black or
white. No band. No complete-loss floor. No fidelity-suite tolerance. No exceptions.** If any fluid loss is
measured, we ENGINEER a solution (as was done for beacons, belts, held items, force bonuses) — we never size a
tolerance around it. High-temperature fluids are already solved separately (aggregate-by-name gating; fusion
output write-rejection subtracted from expected) and are NOT an exception to this contract.

The only comparison nuance permitted is double-precision representation at the serializer's own quantum — that is
how two floats are compared, not a loss allowance, and it is itself minimizable at the source (serialize full
precision). Expected magnitude ~1e-6, never 25.

## The diagnosis this rung tests (why an exception was ever on the table)

Pitfall #17 welded a **measured fact** to an **untested design conclusion**:

- **Fact [empirical, old pipeline]:** pre-activation fluid injection lost ~15% on real transfers; reordering
  injection to after activation eliminated it. Which entity/topology class actually caused the loss was **never
  isolated**.
- **Welded inference (never tested):** "fluids can only be injected into a live world → the fluid gate must
  count a live world → some tolerance is physics." This was reasoned under the obsolete per-entity-fluid model
  (pre-2.0), whose mechanism story (ghost buffer) the fluid-lab already refuted.

Three-layer doc drift confirmed by code+lab audit (2026-07-10):
1. Dead mechanism (ghost buffer — refuted, see api-notes).
2. Over-generalized rule — **fluid-lab R2 [empirical, 2.0.77] already contradicts it**: writing fluid to an
   INACTIVE chemical plant reads back immediately and survives reactivation. R1: an inactive buffer survives
   deactivate → +60 ticks → reactivate → +60 ticks, no loss.
3. Fix text matches neither engine nor code: `LuaEntity.frozen` is READ-ONLY (R1 measured the hard error);
   shipped code (`active_state_restoration.lua`) writes only `entity.active`; `frozen_states` is a misnomer (it
   maps original ACTIVE states).

Also established by code-read (2026-07-10, `import-completion.lua`): the completion sequence — unpause →
activate → inject fluids → physical recount (`LossAnalysis.run`) → fluid gate — is ONE synchronous Lua
execution. `game.tick` does not advance between injection and the count, so even the CURRENT order has a
zero-tick window: the "live world" the gate supposedly counts cannot have moved. The band never had a physical
basis in the current pipeline.

## What the rung decides

**If fluids can be injected into the FROZEN world (pre-gate), the architecture collapses to a single gate:**
one census of a complete frozen world — items AND fluids — with the verdict rendered BEFORE activation and
before anything irreversible. The entire second act is then retired: no post-activation fluid gate, no
`failedStage=fluids` composite verdict, no "fluid gate failed after activation → discard destination →
quarantine on discard-failure" path (that block exists ONLY because the current order activates before the
fluid verdict). Commit semantics become strictly cleaner: full parity proven → activate → only then may the
source be deleted.

## Evidence state going in

| Claim | Status |
|---|---|
| Write fluid to an inactive machine buffer → reads back, survives reactivation | **[empirical, 2.0.77]** (fluid-lab R2) |
| Inactive machine buffer survives deactivate → wait → reactivate | **[empirical, 2.0.77]** (R1) |
| Segments hold static, readable contents while movers are disabled | **[empirical, 2.0.77]** (gate-drift LAB-A freeze0) |
| Write into a pipe SEGMENT while everything is off → survives real activation | **UNTESTED — R11a** |
| Full mixed line (pump/pipes/plant/boiler) injected while off → totals conserved through activation | **UNTESTED — R11b** |
| Newly-created entities on a mid-import paused platform: engine-reported `frozen`/`active`, and do their fluidboxes accept-and-retain writes before first activation? | **UNTESTED — R11c** (this isolates what the original ~15% actually was) |
| The real import path at 1359-entity scale with injection moved pre-gate | **UNTESTED — R11d** |

## The ladder (controls first; prediction stated up front: ZERO loss at every step)

- **R11a — segment write-while-off.** Pipe run + storage tank, no machines (then with machines present but
  `active=false`): inject into the segment via a member fluidbox, read back same tick (segment contents + proxy
  reads, both meters per fluid-lab R0), activate the world, read after +N ticks. Conserved?
- **R11b — full mini-line.** Pump + pipes + chemical plant + boiler, all `active=false`: inject every fluidbox,
  single-tick census, activate for real, census again after +N ticks. Totals conserved by name?
- **R11c — newly-created entity state.** Create entities exactly the way the import does (paused platform,
  entities created deactivated), tick-stamp what the engine reports for `frozen` and `active`, then test
  write-and-retain on their fluidboxes BEFORE first activation. If a class rejects/loses writes here, that class
  is the isolated cause of the historical ~15% — and the candidate for the inserter-style fix below.
- **R11d — the real path at scale.** Debug-gated ordering hook: inject fluids pre-gate on a clone of the big
  platform, run an EXACT fluid comparison in the frozen census, then activate, recount. Two clean passes, span
  and ticks recorded, both-instance zero-leftover.

**Fallback pattern if some entity class fails write-while-off:** the inserter-style synchronous toggle
(`active=true` → write fluid → `active=false`, all in one execution — no tick elapses, nothing crafts or flows),
exactly the Pitfall #28 `restore_held_items_only` pattern, applied per-class. R11 should measure this variant
wherever the plain write fails.

## Decision contract

- **All rungs conserve →** rewrite the #30 brief to the SINGLE frozen-world exact gate (items+fluids, one
  verdict, pre-activation; post-activation fluid gate + discard/quarantine path retired). Re-scope Pitfall #17
  in CLAUDE.md/AGENTS.md + api-notes to the historical fact with its now-isolated cause; promote R11 results
  with `[empirical, 2.0.77]` tags.
- **Any rung trips →** STOP; the trip has, for the first time, ISOLATED the real mechanism. Report per-name,
  per-class evidence for adjudication. The fix will be engineered around that specific mechanism (toggle
  variant, ordering, serializer precision); the gate does NOT loosen. Ever.
- Either way: **no doc claim is deleted before this rung lands** (flag, don't delete); no gate constants change
  inside the rung itself (measurement only); DI-lint fires = escalate.

## Discipline (same as every lab)

Fluid-lab NOTEBOOK append-only · controls before experiments · every reading tick-stamped with both meters +
paused flags · `--reset` + both-instance zero-leftover (7 fields, incl. lab `platform_exports`) · two clean full
passes reported once at the end · honest UNEXPLAINED · commit runners with conclusions
(`test(fluid-lab): ...`), no session URLs/trailers · stop for audit.
