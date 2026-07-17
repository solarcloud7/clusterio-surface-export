# ONE-SHOT agent brief — T1c plasma decomposition → finish LAB-TAIL → state-dimension package

> ONE-SHOT: decisions pre-adjudicated; do not stop to ask. Valid stops: (a) audit-ready, (b) a listed
> hard stop. Same standing discipline as your previous brief (LF clone refresh, tools/rcon.ps1 not
> rc11, commit-before-teeth, per-section iteration, zero-leftover proof, no allows without
> adjudication, package-lock untouched, no session URLs). You own the cluster until you stop.

## Phase 1 — T1c: decompose the T1b anomaly (three independent mechanisms; one rung each)

Orientation fact from the orchestrator's analysis of your T1b table: **total frozen plasma volume was
EXACT (600→600)** — the aggregate-by-name gate contract held; this is NOT fluid loss. Your V×T metric
conflates three candidate mechanisms. Isolate them:

**R0 — temperature quantization (no transfer, no cluster state beyond one lab surface):**
Write plasma at known temperatures into a single pipe and read back SAME-TICK: sweep
1,000,000 / 1,234,567 / 1,252,651 / 2,000,000 / 5,000,000 °C (include your exact T1b fixture temps).
Record written vs read-back per point. Prediction if float32 quantization: read-back error grows with
magnitude (~0.06°C at 1M, ~0.5°C at 8M). This measures the ENGINE's temp storage precision with zero
serializer involvement. Whatever you find: this is the empirical foundation the HIGH_TEMP_THRESHOLD
constant has been waiting for — record it, recommend a grounded threshold (or its removal), change NO
constant.

**R1 — topology (answers whether the 20-unit redistribution is benign):**
First, from your T1b NOTEBOOK: state whether the passive holder was PLUMBED to the reactor output or
ISOLATED. Then run both variants:
(a) isolated pipe loop with script-injected plasma, no reactor connection — transfer — frozen census.
Prediction: V exact AND ownership stable (nothing to redistribute into).
(b) pipes connected to the reactor output — before export, record `get_fluid_segment_id` for the pipes
and (expected nil per Pitfall #22) the output box; repeat on the destination frozen world. If pipes and
output share one segment, the redistribution is engine segment mechanics — benign, document it. If (a)
shows redistribution too, THAT is a restoration bug: hard stop with the table.

**R2 — V×T accounting under R0's answer:**
Recompute your T1b V×T deltas after quantizing the expected temperatures per R0's measured precision.
If the residual goes ~0, the +0.09% drift is quantization — document that by-temperature accounting is
unsound above the measured precision boundary and that the volume-only aggregate-by-name gate is the
CORRECT design (this closes GATE-7/FLUID-13). If a residual remains, record it UNEXPLAINED honestly.

**Phase 1 exit:** NOTEBOOK + runners committed (`test(lab-tail): ...`); api-notes additions drafted but
NOT yet promoted (they go in the final PR with certification).

## Phase 2 — finish LAB-TAIL: T2 (validation-timeout wall-clock) and T4 (stored-export latency) per the
original brief [2026-07-10-lab-tail-agent-brief.md](2026-07-10-lab-tail-agent-brief.md). T3's 25.6 MB
single-command RCON instrument: re-run once to confirm, then it certifies with the package.

## Phase 3 — state-dimension package (serializer coverage; pre-investigated by the orchestrator)

Coverage facts verified at main (b07d11d): circuits + spoilage + equipment-burner are implemented but
untested; `crafting_progress` is exported AND restored (simple field write) but never proven to take
effect on a recreated machine; `bonus_progress` is exported but NEVER restored (dead export);
entity-level burner state (`currently_burning`, `remaining_burning_fuel`) is NOT handled;
`entity.energy` (accumulator charge, machine buffers) is NOT handled; heat (`entity.temperature` on
heat-carrying entities) is NOT handled.

**3a — mid-craft rung FIRST (it decides an implementation):** source machine frozen mid-craft
(ingredients consumed, progress ~0.5, inputs for exactly one more craft in the input slots). Transfer.
Measure on the destination: does the restored `crafting_progress` value persist and, after activation,
does the craft COMPLETE producing outputs exactly once (physical count: inputs consumed once, outputs
appear once — no phantom gain, no double consumption)?
- Resume works cleanly → write the grounded test; no code change.
- Resume fails or double-produces → implement REFUND-NOT-RESUME (owner-adjudicated): at export, add
  the in-flight recipe's ingredients ×1 craft back into the serialized input inventory and zero the
  exported progress. Items conserve exactly; only progress-time resets. Update the expected-count math
  accordingly (the refunded items ARE expected). If refund is blocked by an engine behavior, HARD STOP
  with evidence.

**3b — implementation gaps (each additive capture+restore, NO exact-gate changes — the gate stays
items+fluids):**
1. `bonus_progress` restore (one line in SIMPLE_RESTORE_RULES; verify writability, safecall if needed).
2. Entity burner state: export/restore `currently_burning` (name+quality) and
   `remaining_burning_fuel` for entities with a burner (mirror the existing equipment-burner code in
   inventory-scanner/deserializer).
3. `entity.energy` capture/restore for accumulators and machine buffers (set after creation; pcall +
   log per the pcall guard; verify accumulators accept the write while deactivated — if they reject,
   apply it in the activation pass and note it).
4. Heat: export/restore `temperature` on entities with a heat buffer (same deactivated-write check).

**3c — grounded round-trip tests, one assertion per coverage-table row** (extend the cheap-fixtures
known-content kit if it has merged; otherwise a bare platform + script-built fixture). Each test reads
the property PHYSICALLY on the destination (lint:test-grounding rules apply):
1. Circuit/combinator CONFIG + wires: an arithmetic/decider's parameters (`control_behavior`
   settings) survive verbatim AND a red/green wire between two entities reconnects (assert via the 2.0
   wire-connector API, and assert a downstream lamp/inserter condition actually evaluates
   post-activation).
2. Combinator RUNTIME state: a decider latch's held signal value post-activation. Known limitation to
   record, not fix: runtime latch state may be non-restorable by design — if the latch resets,
   document it in ENGINEERING_FAQ as a ⚠️ known behavior, don't chase it.
3. Spoilage: `spoil_percent` mid-decay survives within one tick's drift.
4. Crafting progress: 3a's outcome (resume-exact or refund-exact).
5. `bonus_progress`: survives after 3b.1.
6. Equipment burner (existing code, never tested): a roboport/equipment burner mid-burn —
   `currently_burning` + `remaining_burning_fuel` survive.
7. Entity burner: same assertions after 3b.2.
8. Accumulator charge + a machine energy buffer: survive after 3b.3.
9. Heat: `temperature` on a heat-carrying entity survives after 3b.4.

## Phase 4 — close out
Certification: labs-certified.json gains T1/T1b/T1c/T2/T3/T4 with evidence commits. api-notes gains the
R0 precision fact, the plasma segment/ownership fact, and the state-dimension facts — every entry
tagged [empirical, 2.0.77]. HIGH_TEMP_THRESHOLD: include your grounded recommendation in the PR body;
do NOT change the constant (separate reviewed change). Full verification chain (all 11 guards,
container npm test, two consecutive full integration runs green, zero leftovers both hosts), then ONE
PR (commits split: test(lab)/feat(serializer)/test(integration)/docs), STOP for audit.

## Hard stops
R1(a) shows redistribution on an ISOLATED holder · 3a refund path blocked · any physical census shows
item/fluid loss at the frozen gate point · cluster unrecoverable.
