# ONE-SHOT agent brief — plasma shortfall root-cause → engine-owned segment exclusion → resume the package

[Agent execution discipline](../../AGENT_EXECUTION_DISCIPLINE.md)

> ONE-SHOT: decisions pre-adjudicated; do not stop to ask. Valid stops: (a) audit-ready, (b) a listed
> hard stop. Standing discipline unchanged (LF refresh, tools/rcon.ps1, commit-before-teeth,
> per-section iteration, zero-leftover proof, no self-approved allows, package-lock untouched, no
> session URLs). This brief SUPERSEDES the remaining phases of the T1c/state-dimensions brief — their
> content reappears here as Phases 4–5.

## Orchestrator's framing (carry this in)
Your T2 hard stop was the gate working: real nondeterministic loss, caught, black-boxed, discarded,
source preserved. Working hypothesis from your own rungs (R0 refuted precision; R1 proved isolated
plasma conserves; actual == exactly 80 twice now): **fluid in segments connected to an engine-managed
output fluidbox is not durably writable — write-time read-back overcounts acceptance
(write_rejected undercounts), and the engine reasserts its own contents by gate time.** Your job:
prove or refute that, then make expected-count accounting deterministic.

## Phase 1 — forensics (no new cluster load)
1. Retrieve the banked black box from the failed transfer:
   `script-output/failure_black_box_*.json` on host-2 (it survives the discard by design). Extract the
   per-name fluid diff and the physical entity scan; confirm the entire 15.972121 shortfall is plasma
   attributable to output-connected segments.
2. From the run's logs (files, not docker logs): the fluid-restoration write_rejected total for that
   import vs R11's historical ~20. Expected finding: rejected ≈ 4.03 (95.972121 = raw − 4.03) — i.e.
   ~16 units of writes READ BACK as accepted at write time.
3. NOTEBOOK the reconstruction.

## Phase 2 — P1 rung: prove the mechanism (minimal fixture, N=5)
Fixture: fusion reactor + pipes CONNECTED to its output holding plasma + one ISOLATED plasma pipe loop
(control). Transfer it 5 times (fresh dest each time; cheap fixture, not the 1,359 clone). Per run
record: write-time read-back per segment, gate-time frozen census per segment, write_rejected total.
Predictions: isolated control conserves 5/5; output-connected segment shows variable write-time
acceptance vs a stable engine-asserted gate-time figure; write_rejected varies run to run.
Also attempt to close T1c-R2 with this data: if the +681,796.25 V×T residual is explained by the same
reassertion mechanism, retag it explained-with-evidence; otherwise it stays UNEXPLAINED — never force.

## Phase 3 — RE-ADJUDICATED (2026-07-11, second amendment): DESIGN v2 — CATEGORY-BASED EXCLUSION. IMPLEMENT.
P2's constructibility finding resolves the retraction: at 2.0.77 plasma outputs use the `fusion-plasma`
connection category, which no player-placeable pipe/tank shares — plasma physically cannot leave fusion
machinery, so the "player-recoverable connected-pipe plasma" attack scenario is unconstructible in
vanilla, and T1b's "passive" holders were separate segments (conserved exactly). Design v2, authorized:
1. CLASSIFY by CONNECTION CATEGORY, not segment reach: a fluid amount in any fluidbox whose prototype
   connection categories do not include `default` (i.e. unpipeable — fusion-plasma today; detect
   generically from the prototype, never a hardcoded prototype-name list) is `engine_owned`.
2. SYMMETRIC exclusion: excluded from expected at export, not written at import, excluded identically
   by the destination gate census. Serialized for the record as `engineOwnedFluids` (UI informational
   row, never loss). The exact gate's epsilon/verdict semantics untouched. If write_rejected ends up
   with zero remaining users, delete it and its subtraction (no dead accounting).
3. VERSION TRIPWIRE: at export, if any fluid sits in a non-`default`-category fluidbox on a prototype
   OUTSIDE the fusion family, log a loud warning naming it (a future engine version adding pipeable
   plasma or new categories must surface, not silently reclassify). Add the fact + tripwire to
   api-notes [empirical, 2.0.77, P2] and note it as a pin-bump re-check item.
4. PROOF: N=5 consecutive transfers of a production-shaped reactor+generator fixture, exact gate green
   5/5 with deterministic expected counts (this was nondeterministic pre-fix — T2's 15.97 shortfall);
   the fixture ships as tests/integration/plasma-engine-owned/ (verify it goes RED once on pre-fix
   code, then green ×5). /di-change applies; adversarial review at audit.
Then resume Phase 4 (LAB-TAIL certification) as originally written.

## Phase 3 — SUPERSEDED HISTORY (first amendment): design RETRACTED after a successful adversarial attack
The symmetric segment-wide exclusion design was attacked and REFUTED before implementation: plasma in
reactor-connected pipes/tanks is PLAYER-RECOVERABLE (disconnect the holder, keep the fluid), so
excluding whole segments on both sides would hide a real loss class. Additionally the evidence is
mechanism-ambiguous: T1b's connected segment conserved total volume (600→600 frozen) while T2's
production run lost ~16 — box-only clamping vs whole-segment reassertion is UNRESOLVED.
Do NOT implement any exclusion. Instead run P2 and escalate:

**P2 — segment-persistence characterization (replaces the implementation):**
Fixtures, N=5 transfers each, recording per-holder (managed box vs each pipe/tank) volume at
write-time, dest-frozen, and post-activation+120:
(a) single reactor + connected pipes holding plasma (the T1b shape);
(b) TWO reactors sharing one connected pipe network (multi-managed-box segment — closest to the
    production platform, prime suspect for T2's loss);
(c) reactor + connected pipes + a connected TANK (large passive capacity);
(d) isolated pipe loop (control — must conserve 5/5).
Questions the table must answer: does the engine reassert ONLY its own box contents, or the whole
segment? Is the reassertion deterministic per fixture? Does pipe/tank plasma injected at import
persist to the frozen gate point? Does write-time read-back ever disagree with dest-frozen?
Then STOP and report the table — the redesign is an ORCHESTRATOR/OWNER adjudication, not yours.
(The original Phase 3 text below is retained for reference only — do not execute it.)

## Phase 3 (RETRACTED — reference only) — implement SYMMETRIC ENGINE-OWNED EXCLUSION (adjudicated design; this is a DI change)
Rule (both sides identical, keeping the comparison commensurate):
- EXPORT: a fluid amount residing in a segment that contains at least one engine-managed output
  fluidbox (fusion output today; detect generically, not by prototype name, if the API allows —
  otherwise a documented prototype list with a comment) is classified `engine_owned`: serialized for
  the record (display/forensics as `engineOwnedFluids`) but EXCLUDED from verification expected counts.
- IMPORT: do not write into engine-owned segments at all (removes the write-time read-back dependence;
  write_rejected remains only for any remaining non-segment managed boxes — if it ends up with zero remaining
  users, delete it and its subtraction rather than leaving dead accounting).
- GATE CENSUS: `count_fluids` applies the same classification and excludes engine-owned segments on the
  destination. Expected and actual are then both deterministic and engine-independent.
- The exact gate itself (epsilon, aggregate-by-name, verdict timing) is UNTOUCHED.
- UI/docs: transfer details show engine-owned amounts as an informational row, never as loss.
Blast radius: export_scanners/inventory-scanner.lua (classification), core/export-pipeline.lua
(verification build), import_phases/fluid_restoration.lua (skip + possibly retire write_rejected),
validators/surface-counter.lua + transfer-validation.lua (census exclusion), loss-analysis display,
docs (Pitfall #21 gains the segment-reassertion fact; api-notes entry [empirical, 2.0.77, P1]).
ADVERSARIAL FIXTURE ships WITH the fix (ship-the-adversarial-fixture rule): the P1 fixture becomes
tests/integration/plasma-engine-owned/ — N=3 consecutive transfers of the output-connected fixture
must pass the exact gate 3/3 (this fails on pre-fix code with the nondeterministic shortfall — verify
red on old code once, then green ×3).
/di-change applies in full; expect an adversarial /code-review at audit.

## Phase 4 — resume and certify LAB-TAIL
T2 reruns (its wall-clock measurement is still wanted — and post-fix it should no longer trip), T4
completes (your 2.06–2.55s preliminaries look done — one confirming pass), T3 confirmed (25.6 MB).
Certify T1/T1b/T1c/P1/T2/T3/T4 into tests/labs-certified.json with evidence commits (41adbf1, 696d09c,
and the new ones). api-notes promotions all tagged. HIGH_TEMP_THRESHOLD recommendation in the PR body
(R0 gives you the grounding: zero quantization through 5M°C — say what that implies), constant
unchanged.

## Phase 5 — REMOVED (2026-07-11 amendment)
The state-dimension package (3a/3b/3c of the previous brief) is being executed IN PARALLEL by
orchestrator-managed subagents. Do NOT touch the serializer state dimensions or author those tests.
Stop after Phase 4's close-out.

## Close-out
Full chain: all 11 guards, container npm test, TWO consecutive full integration runs green (now
including the new plasma-engine-owned test), zero leftovers both hosts. ONE PR covering Phases 1–4,
commits split by label (test(lab)/fix(fluids)/test(integration)/docs). PR body leads with the P1
mechanism table and the black-box forensics. STOP for audit.

## Hard stops
P1's isolated control EVER loses (that breaks R1/R11 and the hypothesis — full stop, report) · the
exclusion fix cannot make the adversarial fixture green 3/3 without touching the exact gate's epsilon
or verdict semantics · any NEW loss class appears in the frozen census · cluster unrecoverable.
