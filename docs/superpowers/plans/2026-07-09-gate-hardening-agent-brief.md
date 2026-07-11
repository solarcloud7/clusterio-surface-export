# Gate-hardening agent brief — tighten the fidelity gates on LAB-A's evidence (task #30)

> **STATUS (2026-07-10): ON HOLD — fluid semantics below are SUPERSEDED. Do not execute this brief.**
> The owner rejected the fluid BAND and complete-loss FLOOR: regular fluids are exact, black-or-white, no
> exceptions — same contract as items. Fluid-lab R2 already refutes the universal "inject only after activation"
> premise this brief's fluid section rests on. Run the R11 rung FIRST
> (`2026-07-10-fluid-r11-frozen-injection-rung-spec.md`); if it passes, this brief is rewritten to a SINGLE
> frozen-world exact gate (items+fluids, one verdict before activation) and the post-activation fluid gate is
> retired. The item-gate exactness section (0/0) remains directionally valid but will be re-issued as part of
> the rewrite.

> You are the **implementer** on the `codex/composite-transfer-verdict` branch (PR #76). The orchestrator audits
> and the owner merges — **stop for audit before any merge.** This is a DATA-INTEGRITY change on the
> source-delete spine: `/di-change` applies in full; any DI-lint firing = escalate, never self-approve an allow.

## Why now (the evidence that licenses this)
LAB-A (`d666b23`, audited) measured the export-scan residual at **0** for items and fluids and proved the
mechanism: the production export lock disables fluid movers while the atomic scan covers still-moving belts. The
export-side justification for the gate tolerance bands (`STRICT_ABS=20`, `STRICT_PCT=1.5%`, fluid
`max(25, min(500, 5%))`, `FLUID_GAIN_TOLERANCE=500`) is dead. The owner parity contract
(`2026-07-08-lab-a-execution-spec.md`, Pass/decision) now governs: **a tolerance is only ever acceptable for a
proven measurement artifact; real loss is a bug; a complete-loss floor lands on every branch.**

## Target gate semantics — items and fluids are NOT symmetric

### Item gate (`validate_fluid_counts`' sibling strict item path, `module/validators/transfer-validation.lua`)
The item gate counts a **frozen** world (pre-activation so machines can't craft during the count — Pitfall #15,
entity activation before validation; held items pre-restored by the synchronous pass — Pitfall #28, the gate must
count a complete state; belts placed single-tick; failed-entity losses already subtracted from expected —
Pitfall #20, failed-entity loss attribution). No artifact source remains → the contract licenses **exact**:
- **Complete-loss floor:** any item type with `expected > 0` and `actual == 0` → FAIL, unconditionally.
- **Band:** `STRICT_ABS 20 → 0`, `STRICT_PCT 0.015 → 0` (exact, symmetric — a gain is as anomalous as a loss).
- **Validation duty:** the full fidelity suite + ≥5 real transfers of the 1359-entity platform must run green
  under the exact gate. **If ANY clean run trips it: STOP and report the per-name delta evidence** — the
  artifact-vs-bug fork is the orchestrator's call, and the gate does NOT get quietly re-loosened.

### Fluid gate (`validate_fluids_post_activation` path)
The fluid gate **must** count a live world (fluids inject only after activation — Pitfall #17), so machines can
legitimately consume/produce fluid between injection and the count. That window is a REAL artifact class — but
its size has never been measured. This PR measures it:
- **Complete-loss floor first (unconditional):** any fluid name with `expected_by_name > 1.0` and
  `actual_by_name < epsilon` → FAIL. (Fusion rejected writes are already subtracted from expected, so a
  fully-rejected output cannot false-trip this.)
- **Measure the band in-PR:** run ≥5 clean transfers of the big platform; record the max per-name
  `|expected − actual|` at the gate, split by direction (loss vs gain). Size the band to
  `max(3 × measured_max, 1.0)` and **document the measurement** in the PR body + promote it to
  `docs/factorio-2.0-api-notes.md` tagged `[empirical, 2.0.77]`. Replace `25/500/5%` and the gain-500 with it.
- **Boundary stop:** if any single name dominates the measurement (fusion plasma is the expected suspect —
  engine-generated post-activation), STOP and report before sizing — per-name handling vs a global band is an
  adjudicated design decision, not yours.

## Also in this PR (from the audited /code-review findings on 3a47a58)
1. **Surface the quarantine escalation.** `destinationDiscardEscalated` / `destinationQuarantined` /
   `destinationQuarantineError` are set and read by NOTHING — a surviving live duplicate is invisible. Minimum
   viable surfacing (full observability is PR-4's scope): carry them in the validation payload/DTO, log at error
   level in the orchestrator, and show one line in the TransactionLogs failure details.
2. **Drop the redundant `reconcile_fluids`** computed per gate and used only for a debug-log branch.
3. **Adversarial fixtures, red-on-revert (lint:test-grounding + Pitfall #30 rules apply):**
   - a small-FLUID complete-loss case (a name with total ≤25 vanishes) → gate must FAIL, source preserved;
   - a small-ITEM complete-loss case (a type with expected ≤20 vanishes) → strict gate must FAIL;
   - both grounded in physical counts, hooks pre-gate/fail-safe (`FAIL_SAFE_HOOKS`) or disarmed in `finally`;
   - verify TEETH: each fixture goes RED when its floor/band change is reverted.
4. Existing teeth stay green and meaningful: `gate-detects-loss`, `fluid-gate-detects-loss`, `force-bonus-sync`,
   `transfer-fidelity`, `rollback`, the fusion roundtrip (no-false-alarm on rejected writes — di-change gate 4).

## Out of scope — do not touch
PR-3/2PC wiring, `DestinationHold` routing of the quarantine path (PR-3 owns unifying that), the lint guards
(separate PRs), `package-lock.json` (byte-identical, never staged), anything under `docs/superpowers/plans/`
except your own evidence notes.

## Docs in lockstep (same PR)
- `docs/ENGINEERING_FAQ.md` §D rows: gates are now exact-with-measured-band + complete-loss floors.
- `CLAUDE.md` Pitfall #28's "~3× the irreducible belt floor" rationale is superseded by LAB-A — update the text
  to cite the measured basis (and mirror `AGENTS.md` locally; it is gitignored).
- api-notes: the fluid-window measurement, tagged.

## Verification (all of it, in order)
```
# container: npm run lint:lua && lint:pcall-logging && lint:test-grounding && lint:test-hooks ; npm test
./tools/patch-and-reset.ps1          # Lua changed — saves must re-patch
node tools/run-integration-tests.mjs --only 'gate-detects-loss|fluid-gate-detects-loss|transfer-fidelity|rollback|force-bonus-sync'
node tools/run-integration-tests.mjs # full suite once focused sections are green
# + the >=5 clean big-platform transfers for the fluid-band measurement (record per-name deltas as evidence)
```
Two consecutive green full-suite runs before claiming done. `/di-change` checklist completed and stated in the
PR body. Then **stop for audit** — the orchestrator runs a fresh `/code-review` against your HEAD and the owner
merges (squash-only). No push beyond the branch, no self-merge, no session URLs or `Claude-Session:` trailers.

## Stop conditions (report, don't improvise)
A clean run trips the exact item gate · one fluid name dominates the band measurement · any DI-lint fires ·
`patch-and-reset`/cluster failures · anything appearing to require touching the two-phase-commit flow.

## Report format (final message)
The measured fluid-window numbers (per-name max deltas, both directions, across the ≥5 transfers) · the final
gate constants with their evidence basis · fixture teeth proof (RED on revert) · two full-suite green runs ·
di-change checklist state · diff summary confirming scope held.
