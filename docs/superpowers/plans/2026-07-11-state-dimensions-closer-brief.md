# ONE-SHOT closer brief — cluster-validate feat/state-dimensions → one PR

> ONE-SHOT: decisions pre-adjudicated; do not stop to ask. Valid stops: (a) audit-ready, (b) a listed
> hard stop. Standing discipline unchanged (LF clone refresh, tools/rcon.ps1 not rc11, commit-before-
> teeth, zero-leftover proof, no self-approved allows, package-lock untouched, no session URLs).
> PRECONDITION: the cluster is free (the plasma-v2 agent has stopped for audit). Verify idle first:
> async_jobs == 0 and zero locks on BOTH hosts; if not idle, deadline-poll 10 min then stop and report.

## What you inherit
Branch `feat/state-dimensions` (origin, 6 commits on main at b07d11d): four serializer capture/restore
implementations (bonus_progress, entity burner, energy, temperature) + nine authored-but-never-executed
integration tests + the midcraft-lab MC1 rung + three cross-model-audit fixes (bc773fc). Statically
audited: no gate-neutrality blocker; every 2.0.77 API shape verified. Rebase onto current main first if
it has moved (the plasma-v2 fix may have merged — its fluid changes are disjoint from yours, but the
suite you must pass includes its new plasma test).

## Phase 1 — the MC1 measurement (decides an implementation)
Run tests/midcraft-lab/run-mc1.mjs. It classifies mid-craft transfer physics as RESUME-CLEAN /
RESET-LOSS / PHANTOM-GAIN (instrument guards: powered, mid-progress freeze, zero productivity).
- RESUME-CLEAN → set midcraft-roundtrip's EXPECTED_BEHAVIOR='resume'; no code change.
- RESET-LOSS or PHANTOM-GAIN → implement REFUND-NOT-RESUME (pre-adjudicated by the owner): at export,
  add the in-flight recipe's ingredients ×1 craft into the serialized input inventory and zero the
  exported crafting_progress (and bonus_progress interaction: refund does NOT touch bonus_progress).
  The refunded items ARE expected (they land in a counted inventory — verify the expected-count math
  needs no separate adjustment because the serialized inventory IS the source of expected). Flip
  EXPECTED_BEHAVIOR='refund'. Record the measured reality in the NOTEBOOK either way and promote the
  fact to api-notes [empirical, 2.0.77, MC1].
- PHANTOM-GAIN additionally means pre-fix code MANUFACTURES items: state this prominently in the PR.

## Phase 2 — validate the implementer's three UNVERIFIED flags (live, before the test sweep)
Small probes (bare platform, no docker restarts):
1. entity.energy write on a DEACTIVATED accumulator/machine — accepted? If rejected, move the restore
   to the activation pass (ActiveStateRestoration) and update the test's frozen-read expectations.
2. entity.temperature write on a deactivated heat entity — same contingency.
3. burner restore ordering: does setting currently_burning mutate the fuel inventory before
   restore_inventories' clear()+refill runs? (Static analysis says overwritten; confirm.)
Fix what the probes contradict; NOTEBOOK the readings.

## Phase 3 — the nine tests, per-section iteration
Run each new test individually (never full-suite debug loops). Expected outcomes to honor:
- circuit-latch-state: PASSES either way; if latch resets, add the ⚠️ ENGINEERING_FAQ row (docs
  commit) exactly as the test output instructs.
- equipment-burner-roundtrip: burner assertions may SKIP (vanilla likely has no burner equipment) —
  grid/battery assertions must still pass.
- A test red for a fixture/authoring reason: fix the test. Red because a SERIALIZER claim is false
  (a dimension doesn't actually survive): fix the implementation if additive-safe; if the fix would
  touch gate accounting, HARD STOP with evidence.
- Never weaken an assertion to go green; bounds may only be adjusted with a physical justification
  recorded in-file.

## Phase 4 — close out
Full chain: two consecutive full `node tools/run-integration-tests.mjs` runs green (including the
plasma test if merged), zero leftovers both hosts (surfaces, locks, holds, jobs, tombstones, unpaused),
all 11 lint guards + container npm test, package-lock byte-identical. Commits split by label
(fix/feat/test/docs). ONE PR: lead with the MC1 measured reality and the three UNVERIFIED-flag
verdicts, then the nine-test results table. STOP for audit.

## KNOWN PRE-EXISTING ANOMALY (do not hard-stop on it)
A rare, configuration-dependent belt loss exists on main (a few items of one belt-carried name short at
the frozen gate, entirely on transport belts — e.g. -4 piercing-rounds-magazine). It is under a
dedicated rung (2026-07-11-belt-loss-rung-brief.md). If a transfer in YOUR runs fails the gate with
that signature: the black box banks automatically — record the bank filename, RETRY the transfer once
(it is configuration-dependent and usually passes), note the occurrence in your report, and continue.
It does NOT count against your two-consecutive-green requirement if the retry is green and the failure
matches the signature (belt-only, single item name, small count). Any OTHER loss signature is still a
hard stop.

## Hard stops
MC1 UNCLASSIFIED after instrument-guard retries · refund implementation requires touching the exact
gate or its expected-count spine beyond the serialized-inventory route · any test reveals item/fluid
loss at the frozen gate on a shipped path with a signature OTHER than the known belt anomaly above ·
cluster unrecoverable.
