# Owner ruling — BLACK-BOX DISCARD (destination disposition on single-gate failure)

> **Adjudicated 2026-07-10 (owner + orchestrator). Binding on the #30 single-gate rewrite.**
> Supersedes both current behaviors (item-failure preserve-paused; fluid-failure discard) with ONE policy.

## The policy

When the single frozen-world gate FAILS a transfer:

1. **Bank the black box FIRST — always-on, never debug-gated.** Written at gate tick, before anything is
   destroyed: the destination physical scan (same serializer as export), the per-name expected-vs-actual diff,
   a destination force-state snapshot (`FORCE_SYNC_PROPS` values — the one evidence class a live-surface
   interrogation ever uniquely provided, in the CI held-item incident), engine/mod versions, and tick stamps.
   Referenced from the transaction log. (Today's dumps are `debug_mode`-gated — a production failure with
   debug off would leave NOTHING; that gap closes here.)
2. **Then DISCARD the destination** via `GameUtils.delete_platform`. No failed copy ever persists —
   handshake-or-discard holds literally; no surface stacking, no save bloat, no retry name collisions.
3. **Source preserved and unlocked** (unchanged — two-phase commit).
4. **Opt-in escape hatch:** `preserve_failed_destination` (config, debug-gated, default off) keeps the failed
   surface paused for an active investigation — the CI-save workflow as a tool, not a default.

## Why (the evidence that settled it)

- **A preserved surface DRIFTS — measured.** BELT-2 [empirical, 2.0.77]: belts keep moving even fully locked
  (platform paused, machines deactivated, pumps disabled). Totals hold (LAB-A) but POSITIONS smear
  continuously — and belt-restoration bugs are positional. The gate-tick snapshot is more faithful than the
  live surface will ever be again. "Keep the artifact = keep the evidence" was a refuted process assumption.
- **Reproduction is deterministic from payload + destination state, not from logs alone.** The payload is
  already retained (preserved source + controller blob). The destination-state dependence is real (the CI
  bonus-0 incident: same bytes, different outcome) — hence the force-state snapshot in the bundle. With both,
  `/repro-transfer` rebuilds any failure locally, off the shared cluster.
- **Operational reality:** failed copies stack up on an always-up cluster; under the exact gate every failure
  is a real bug that goes to the lab anyway, not to in-place surgery.
