# Post-gate campaign roadmap (2026-07-11)

> Status snapshot at authoring: the single frozen-world exact gate (PR #76) squash-merged as `c5d7437`;
> its post-merge main run was in flight. Owner-approved execution order below. Every lane follows the
> [Agent execution discipline](../../AGENT_EXECUTION_DISCIPLINE.md); task-specific `/di-change`, ownership,
> verification, and audit requirements below are additive.

## Gate 0 — main green after the gate-rewrite merge
No lane branches off main until the post-merge run passes. Red ⇒ freeze lanes, diagnose on the cluster.

## Lane 1 — Guards publication (orchestrator; no cluster)
Rebase `guard/evidence-and-version-cert` onto post-merge main. The parked blocker self-resolved: the merge
deleted the false "verified empirically" tolerance comment. Steps: drop the PENDING-ADJUDICATION
`evidence-claims` allow + ledger entry → verify the guard passes the rewritten comment honestly (it now
cites LAB-A) → refresh the stale "2.0.76 build 84451" text in `version-compat.lua` → re-run all guard
chains + teeth in a worktree → open the PR. Delivers guard #10 (uncited-empirical-claim lint,
`lint-evidence-claims.mjs`) and guard #11 (Factorio-pin vs `tests/labs-certified.json` tripwire,
`lint-version-certification.mjs` — the pin-bump re-certification instrument).

## Lane 2 — Cheap fixtures (implementer agent; owns the cluster)
Brief: [2026-07-10-cheap-fixtures-agent-brief.md](2026-07-10-cheap-fixtures-agent-brief.md) (precondition
met). Deliverables: `New-BarePlatform` + `New-KnownContentPlatform` + committed manifest (keeps one
non-normal-quality item), 9 migrations off the 1,359-entity clone, `SCALE_FIDELITY_TESTS` allowlist with
verified teeth, `tests/lib/lab-helpers.mjs` consolidation, before/after wall-clock table (~12–18 min/run).
Post-brief landings that apply: `lint:catch-swallow` on any TS touched; `lint-commit-labels` PR-gated;
CI's `ci-plugin-ready` sentinel makes run timestamps honest evidence.

## Lane 3 — Two-phase-commit wiring, PR-3 (implementer agent; after Lane 2; owns the cluster)
The last big feature: closes the duplication window (late VOTE past timeout / controller restart /
delete-send failure / VOTE wire-shape drift can no longer yield two live platforms). Brief:
[2026-07-10-pr-3-executor-brief.md](2026-07-10-pr-3-executor-brief.md) PLUS the 2026-07-11 addendum
(relayed; key points): re-confirm every cite against post-merge main · ALL new discard paths route through
the evacuation-protected deletion seam · NEW acceptance test from review finding 10 — non-boolean-truthy
VOTE `success` must fail toward DISCARD, physical census ≤1 live copy · degraded-storage
(`storageLoadError`) row in `resolvePendingTransfer` — re-adoption on a degraded controller fails toward
discard-at-deadline, never duplication · adjudications: `HANDSHAKE_COMPENSATION_DEADLINE_MS = 300000`
(named constant; ceiling ~10.8 min tombstone, floor ≥ dest restart; refine from LAB-TAIL T2 later),
one-verb-per-message (3 requests + `holdForTransfer`), restore `resolvePendingTransfer` from the dist
orphan re-scoped to handshake-or-discard. Acceptance: A1(a/b/c) + A3 + wire-drift, each with a physical
≤1-live-copy census. Full `/di-change`; fresh adversarial review at audit.

## Lane 4 — Follow-up-fixes PR (small; anytime after Gate 0; no cluster)
Running ledger for the next small PR:
1. `messages.ts` `failedStage` union: add `'test_hook'` (or map it Lua-side to a documented value) — the
   type currently lies about the forced-entity-failure verdict.
2. `entity_creation.lua`: warn when `test_force_entity_failure` is armed with an unrecognized string
   (today it silently never matches and never fires — an armed flag no log explains).
3. Survivors of the high-effort workflow review of the merged gate (triage pending; DI-severe findings
   escalate to the owner instead of queueing here).

## Lane 5 — Lab tail + docs truth-sync (fills cluster gaps; non-blocking)
- LAB-TAIL (brief: [2026-07-10-lab-tail-agent-brief.md](2026-07-10-lab-tail-agent-brief.md)): thermal V×T
  conservation, validation-timeout wall-clock (T2 → refines the Lane-3 constant), max RCON payload,
  stored-export latency. Runs whenever the cluster is free between Lanes 2 and 3.
- Docs truth-sync (orchestrator): empirical-backlog triage (mark LAB-A/B+/R11-grounded entries; the
  guessed-threshold entries now describe DELETED code), api-notes save-completion cross-check, memory sync.

## Campaign completion criteria
All lanes merged and green on main · eleven mechanical guards live · zero known paths to silent loss OR
duplication · every remaining engine belief either lab-grounded (`[empirical, <pin>]`) or tagged
`[hypothesis]` with a queued rung.
