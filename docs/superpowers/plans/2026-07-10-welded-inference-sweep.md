# Welded-inference sweep — every pitfall decomposed into measured fact vs. welded conclusion

> **Provenance:** read-only audit, 2026-07-10, commissioned after Pitfall #17's "the fluid gate must count a
> live world" was exposed as an untested inference welded to a real measurement (see
> `2026-07-10-fluid-r11-frozen-injection-rung-spec.md`). The auditor examined all 31 numbered pitfalls, the
> "Known Factorio API Limitations" claims, the Import Phase Ordering rationale, and every claim section of
> `docs/factorio-2.0-api-notes.md`, verified against all six lab NOTEBOOKs, the empirical-test backlog, and the
> cited code. **No edits were made by the auditor; this document records the findings for adjudication.**
> Severity labels follow the repo taxonomy: MEASURED-ACTIVE-LOSS / LATENT-DETECTION-GAP / UNPROVEN-ASSUMPTION.

## Summary

**21 pitfalls CLEAN** (pure measured fact or correctly-scoped conclusions). **10 findings carry welded
inferences; 7 load-bearing (4 on the source-delete spine); 4 already contradicted or refuted by lab evidence.**
The disease concentrates exactly where suspected: gate-tolerance rationales weld "we picked a number" to "the
number is 3× a measured floor," and ordering rules weld "reordering fixed a loss in the old architecture" to
"this ordering is required forever."

**Bottom line:** the source-delete spine currently rests on two numbers whose written justifications are
refuted (item gate: a "3× the irreducible belt floor" that is neither irreducible nor extant; fluid gate: a
500/5% band with a proven-zero export residual and a silent-complete-loss hole), and on two ordering rules
(#15, #17) whose measured facts are solid but whose "must" conclusions came from an architecture that no
longer exists.

## Findings, ranked (most severe first)

### 1. Fluid gate band `max(25, min(500, 5%))` — inherits #17's welded inference (SOURCE-DELETE SPINE)
- **Fact:** old-pipeline pre-activation injection lost ~15%, reorder fixed it [empirical, no pin]. R10a/b:
  steam merges pre-export, round-trips exactly [empirical, 2.0.77]. LAB-A: export fluid residual **0**.
- **Welded:** (a) "gate must count a live post-activation world"; (b) "fluid deltas need a 500/5% band" — no
  measurement ever produced a clean-transfer fluid residual > 0.
- **Load-bearing:** yes — gates source deletion (`transfer-validation.lua:13-14,45-51,366-389`; discard/
  quarantine at `import-completion.lua:629-644`).
- **Contradicted:** partially — fluid-lab R1/R2/R7; the /code-review silent-complete-loss finding
  (LATENT-DETECTION-GAP). **Resolution already in flight:** owner contract 2026-07-10 (exact, no band) + R11.

### 2. Pitfall #28's "~3× the irreducible belt floor" + the "±4–8 cosmetic" claim — REFUTED (SOURCE-DELETE SPINE)
- **Fact:** the phantom 382/417 held-item failure was real and the clock fix eliminated it. A −8 per-item
  residual was observed on the settled test platform (−135–143 busy).
- **Welded:** (a) "±4–8 is export-window redistribution between belts, cosmetic, not loss" (CLAUDE.md Known
  Limitations); (b) "STRICT_ABS=20 ≈ 3× the irreducible belt floor, verified empirically"
  (`transfer-validation.lua:207-209`) — it never was.
- **Contradicted on every count:** belt-lab located the −8 as **restore-time REAL loss** (`insert_at` void-drop
  on over-compressed stacks) — MEASURED-ACTIVE-LOSS at the time, not cosmetic; LAB-A proved the export side
  exact; the floor was then **fixed to zero** by oversized-stack consolidation (dfdd59d). So the "irreducible
  floor" is (i) not export drift, (ii) not irreducible, (iii) no longer exists — 20/item is unmoored headroom
  that can mask real loss (LATENT-DETECTION-GAP).
- **Action:** GATE-1/2 measurement (clean-transfer per-item restore residual post-fix; predict 0) → exact item
  gate (already the direction of the held #30 task). Fix the stale ±4–8 text + the :207-209 comment.

### 3. Pitfall #15 — "the count must happen pre-activation" (same shape as #17)
- **Fact:** post-activation validation in the then-current multi-tick architecture produced false GAINs;
  pre-activation validation eliminated them [empirical, regression-tested].
- **Welded:** the craft-in-the-gap mechanism [hypothesis, correctly tagged]; and the scope generalization
  "counting must ALWAYS be pre-activation." What was measured: a count separated from activation by ELAPSED
  TICKS is invalid. Today's completion is one synchronous execution — no-tick-sync lab proved `game.tick` and
  `crafting_progress` don't advance through a sync pass — so the ordering rule's REASON should be the measured
  zero-tick guarantee, not the unmeasured craft-gap story.
- **Load-bearing:** yes — the two-stage verdict architecture + trilemma dead-end #1. UNPROVEN-ASSUMPTION, low
  urgency (current ordering is conservative-safe). Rung: backlog API-2.

### 4. Pitfall #17 proper — mechanism + scope (already adjudicated → R11)
Ghost-buffer mechanism's prediction set contradicted (R1, R2, R3/R9, R7 — the mechanism's constructible domain
is empty on 2.0.77); behavioral rule survives only as historical evidence at an unpinned version; the original
CI delta=20 stays honestly UNEXPLAINED (FLUID-12). CLAUDE.md's #17 body still narrates the dead mechanism as
"Root Cause" — rewrite to lead with the behavioral rule once R11 lands.

### 5. Pitfall #29 — raise-only rationale contradicts its own durability paragraph
"Never LOWER a dest bonus, which would EJECT other platforms' held items" vs. the same pitfall's verified
durability fact ("once seated the hand keeps its items even if the bonus later drops"). One is wrong, or
"ejection" applies to an untested third state. Design is conservative-safe either way; the rationale is
internally incoherent and will mislead the next redesign. Rung: INS-6 (lower the bonus over seated
over-capacity hands and observe). UNPROVEN-ASSUMPTION.

### 6. Pitfall #23 — weighted-merge mechanism + the 10000 vs 1,000,000°C threshold weld
The code comment welds an IEEE-754 story at ">1,000,000°C" to a threshold of **10000** (`game-utils.lua:
102-105`) — two orders of magnitude apart. R10b also shows temperature-key merging is NOT high-temp-only (165C
steam merged pre-export) — the low-temp case just equilibrates deterministically. Report-side today, not on the
delete spine. Rungs: FLUID-3 (unequal-volume merge; predict volume-weighted 416.25), GATE-6 (where does key
precision actually degrade). UNPROVEN-ASSUMPTION.

### 7. Pitfall #16 — "rolling snapshot" mechanism
Half-confirmed (BELT-2: belts DO move under the export lock), half-open (the double-count pattern itself,
BELT-1). The FIX is load-bearing and rests on LAB-A's measured exactness, not on the mechanism. Keep the
mechanism labelled historical. Not load-bearing → low priority.

### 8. Pitfall #22 — nil segment IDs: measured domain BROADER than the stated scope
The pitfall scopes nil to "isolated machines … not connected to pipes"; R7/R0 measured that a pump connected to
live pipes and a chemical plant ALSO report nil — machines apparently never expose segment ids on 2.0.77.
Behavior is correct either way (generic nil-fallback); **doc-only fix**: align #22's wording with R7.

### 9. Pitfall #19 — `platform.destroy()` no-op: pin drift (verified 2.0.76, cluster runs 2.0.77)
Never re-verified on the current pin, and latest docs describe `destroy(ticks)` as scheduled deletion — the
no-op claim is plausibly already false on 2.0.77. Nothing rests on destroy() being broken (all deletion routes
through `GameUtils.delete_platform` → `game.delete_surface`, which works regardless; the lint guard is
conservative-safe). **Action:** one RCON check on 2.0.77 + update the "pinned 2.0.76" strings (backlog API-7).

### 10. Pitfall #7 — "gracefully skips unknown items": stated, never tested (backlog API-8). Low priority —
cross-mod robustness, not the delete spine; the identical-mod dev cluster never exercises it.

**Honorable mention (same weld shape, nothing contradicts it):** beacon-before-crafter's "crafting_speed
updates instantly — no tick delay, no power" is unpinned [empirical] generalized across machine classes and is
load-bearing on the two-pass inventory order. Backlog API-1.

## CLEAN (no manufactured findings)
#1, #2, #3, #4, #5, #6, #9, #10, #11, #12, #13, #14, #18, #20, #21, #24, #25, #26, #27, #30, #31, #32 — plus
api-notes' item counting, LuaProfiler, hold semantics (honest about unconstructed pod states → HOLD-1),
player/passenger facts (correctly tagged), and the read-only-`frozen` self-correction.

## Adjudication queue (owner/orchestrator decisions, in order)
1. Findings 1–2 are already resolved-by-direction (owner exact-parity contract + R11 + the #30 rewrite);
   the stale texts (±4–8 claim, `transfer-validation.lua:207-209` comment, #17 Root-Cause narration) get
   corrected in the #30 PR — with their rungs landed, not before.
2. Finding 8 (#22 scope) and 9 (#19 pin re-check) are cheap: doc fix + one RCON probe — batch into the next
   docs pass / lab session on the current pin.
3. Findings 3, 5, 6 get rungs queued in the backlog (API-2, INS-6, FLUID-3/GATE-6) behind LAB-B.
4. Finding 10 (API-8) stays parked until cross-mod transfers matter.
