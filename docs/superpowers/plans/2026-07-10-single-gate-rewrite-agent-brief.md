# Single-gate rewrite agent brief (task #30) — ONE frozen-world exact gate, Black-Box Discard, retire the second act

> You are the **implementer** on `codex/composite-transfer-verdict` (PR #76). This is THE data-integrity change
> of the campaign — `/di-change` applies in full; any DI-lint firing = escalate, never self-approve an allow;
> **stop for audit before any merge** (orchestrator runs a fresh `/code-review` against your HEAD; the owner
> squash-merges). Read first, in order:
> 1. `docs/superpowers/plans/2026-07-10-single-gate-impact-map.md` — every consumer you touch, with file:line.
> 2. `docs/superpowers/plans/2026-07-10-black-box-discard-ruling.md` — the binding failure-disposition policy.
> 3. `docs/superpowers/plans/2026-07-10-fluid-r11-frozen-injection-rung-spec.md` — the license + owner parity law.
>
> **Step 0 — merge `main` into the branch first** (post-#77/#78 main): resolve the known CLAUDE.md/FAQ overlap
> conflicts, and get green under the NEW lints (`lint:doc-refs` will flag the FAQ's bare `(Pitfall #16)` — fix
> it; `lint-commit-labels` applies to every commit you make: docs commits touch ONLY doc paths).

## The target design (owner law: exact parity, black or white, no band, no floor, no exceptions)

**One gate. One census of the complete frozen world — items AND fluids — verdict BEFORE activation, and
nothing irreversible before the verdict.**

### Frozen-phase fluid injection (the R11 seam's body IS the blueprint — impact map §1)
- Move `FluidRestoration.restore()` to the R11 seam's exact position (after `restore_held_items_only`, before
  the gate; entities settled, platform paused). Retire the seam itself + its `configure.lua` allowlist entry +
  `r11FrozenFluidMeasurement`. Delete the post-activation injection block and the non-transfer post-activation
  variant (**decision #11: uploads/clones unify to frozen injection too** — one order in the file; note the
  `test_defer_clone_activation` contract change in its comment).
- **Pre-gate expected-count adjustments, in order:** failed-entity items (existing) · **failed-entity FLUIDS —
  the confirmed GAP (impact map landmine #1):** subtract `fel.fluids` (name-keyed) from expected, mirroring the
  write-rejected temp-key distribution loop · inventory-overflow items (existing) · `write_rejected` fusion
  subtraction (MOVES pre-gate, between injection and census) · re-sited `test_force_fluid_loss` hook (inflate
  `adjusted_verification.fluid_counts` pre-gate; update the `lint-test-hooks.mjs` FAIL_SAFE comment).
- **`FluidRestoration` must return `dropped_fluids`** (landmine #2): capacity-overflow/partial-insert drops are
  currently logged-only. Under the exact gate a drop correctly FAILS — the result must carry the attribution so
  the failure is diagnosable. Do NOT subtract drops from expected (owner law: a drop is a bug, not an artifact).

### The single gate (`transfer-validation.lua`)
- `validate_import` for transfers: `skip_fluid_validation` REMOVED; fluid comparison runs unconditionally.
- **Items: exact.** `STRICT_ABS 20 → 0`, `STRICT_PCT 0.015 → 0`, symmetric (a gain is as anomalous as a loss).
  Fix the false ":207-209 'verified empirically'" comment — cite LAB-A (residual 0/0, `d666b23`) as the basis.
- **Fluids: exact BY-NAME (decision #9)**, all temperatures — R10/R11's measured granularity; volume is the
  parity contract, temperature stays a display concern (thermal-energy reporting unchanged). Delete
  `FLUID_GAIN_TOLERANCE`/`FLUID_LOSS_TOLERANCE` and the band. Comparison epsilon `1e-6` (double representation
  at the serializer quantum — a comparison nuance, NOT a tolerance). Consolidate the duplicate
  `aggregate_fluid_counts_by_name` helper.
- **The census must be fed `segment_temps`** (landmine #8): thread the injection result's `segment_temps` into
  the gate's `SurfaceCounter.count_fluids` call, exactly as the R11 seam did — an exact gate without it
  false-fails on proxy-lag temp keys.
- Delete `validate_fluids_post_activation` entirely. `failedStage` is set ONCE by the single gate
  (**decision #4:** keep the field + the Prometheus `failure_stage` label, re-derived from which category
  mismatched: `items`/`fluids`/`none`; update `messages.ts`/`dto.ts`/orchestrator/web accordingly).
- The loose non-strict path stays for non-transfer (upload) verdicts — unchanged scope, GATE-8 remains a
  backlog item; do not touch its constants.

### Failure path = BLACK-BOX DISCARD (the ruling, verbatim semantics)
On gate FAILURE, in this order:
1. **Bank the black box — ALWAYS-ON, never `debug_mode`-gated:** destination physical scan (same serializer),
   per-name expected/actual diff, destination force-state snapshot (`GameUtils.FORCE_SYNC_PROPS` values),
   engine + mod versions, tick stamps. Written to script-output + referenced from the transaction log.
2. **Discard the destination** via `GameUtils.delete_platform` (never `platform.destroy()` — Pitfall #19,
   platform.destroy is a no-op/route through GameUtils).
3. Source preserved + rolled back (existing two-phase behavior; the controller path is UNCHANGED — anything
   touching the 2PC flow itself is a boundary stop, PR-3 owns it).
4. `preserve_failed_destination` config flag (debug-gated, default off, registered in the `configure.lua`
   allowlist): skips step 2, leaves the dest paused for an active hunt.
- DELETE: `quarantine_destination_after_discard_failure` + `destinationDiscarded/Escalated/Quarantined/
  QuarantineError` (zero readers — impact map's consumer census). If `delete_platform` itself returns false,
  that is now a loud error log + `cleanup_failed` status — not a silent field.

### Post-verdict (success path — order preserved, one synchronous execution)
Unpause → `ActiveStateRestoration.restore` → gateway park (unchanged) — all strictly after the verdict.
`LossAnalysis.run` keeps running post-activation for REPORTING but writes to a **separate
`postActivationReport` sub-object (decision #3)** — gate fields are immutable after the verdict. Keep a
NON-GATING post-activation fluid recount log (R11d's drift assertion, free regression telemetry). Restamp
`fluids_started/completed_tick` at the new injection site and fix the `phase_spans` order (landmine #7);
delete the consumer-less `job.metrics.fluids_deferred`. Collapse the triple `emit_debug_import_result` to
gate-time + final.

### Small TS hardenings (TS-sweep triage #3 — same files, same review)
- `instance.ts:738`: missing/non-boolean `data.success` ⇒ FAIL (never fall back to the match booleans alone).
- `operation-record.ts:40`: `platformIndex` `|| 1` default ⇒ null-and-throw for `operationType === "transfer"`.

## Tests (impact map §5 — the fixtures are the contract)
- **Rewrite** `test/composite-transfer-verdict.test.cjs` → the single-gate guard: injection-before-census,
  census-before-activation, NO post-activation verdict writer, hooks-before-gate, black-box-before-discard.
- **Rewrite** `tests/integration/fluid-gate-detects-loss`: arm the re-sited hook → assert the single gate
  FAILS, source preserved, destination DISCARDED, black box written (assert the bundle file exists + carries
  the injected shortfall). Physical cross-grounding per lint:test-grounding.
- **Extend** `tests/integration/failed-entity-loss` with a fluid-bearing failed entity (landmine #1's teeth).
- **New teeth:** revert-the-floor equivalent — set STRICT_ABS back to 20 locally and confirm gate-detects-loss
  still red-on-revert semantics hold (tolerances 0 are load-bearing).
- Update `no-tick-sync-selftest.lua:80` + `run-pr0b.test.mjs:13` (the `skip_fluid_validation` literal).
- Keep green AND meaningful: `gate-detects-loss`, `transfer-fidelity`, `force-bonus-sync`, `rollback`,
  `platform-roundtrip` (now the primary clean-transfer evidence), fusion `entity-roundtrip` cases,
  `destination-hold`, passenger/gateway/lock suites. `run-r10/r11.mjs` stay committed as historical
  instruments; update their `failedStage` reads only if they break.

## Docs in lockstep (pure-docs commits; impact map §6 is the checklist)
Import Phase Ordering steps 6–10 rewritten (single gate; injection pre-gate) · Pitfall #15/#17/#28 sentences
referencing the composite verdict · the FAQ composite Q&A rewritten to single-gate + black-box semantics ·
the FAQ fluid claim pinned to "measured exact (R10/R11); enforced exact by the single gate" · TRANSFER_2PC.md
:89-93 · TRANSFER_WORKFLOW_GUIDE.md :115-137 · FAILED_ENTITY_LOSS_TRACKING.md (+fluid subtraction) ·
api-notes: the retired inject-after-activation rule re-scoped, gate constants' evidence basis cited · every
citation "number + short name" · mirror CLAUDE.md → AGENTS.md locally.

## Verification (all of it, in order)
```
# container: all lint guards + npm test
./tools/patch-and-reset.ps1
node tools/run-integration-tests.mjs --only 'gate-detects-loss|fluid-gate-detects-loss|failed-entity-loss|transfer-fidelity|rollback|force-bonus-sync|platform-roundtrip'
node tools/run-integration-tests.mjs        # full suite
# >=5 clean transfers of the 1359-entity platform under the EXACT gate — the acceptance evidence.
```
Two consecutive green full-suite runs. **If ANY clean run trips the exact gate: STOP with the per-name delta
evidence** — the artifact-vs-bug fork is the orchestrator's call; the gate does NOT get loosened. `/di-change`
checklist completed and stated in the PR body. package-lock byte-identical, never staged. No session URLs.
Then **stop for audit**.

## Boundary stops
A clean run trips the exact gate · anything appearing to require 2PC-flow changes (PR-3's territory) · any
DI-lint fires · `delete_platform` false on the discard path in testing · cluster failures.
