# PR-3 executor brief — wire the two-phase-commit protocol (PREPARE→VOTE→COMMIT→RELEASED→GO-LIVE)

> You are the **implementer** on a new branch cut from `main` **AFTER #76 (`codex/composite-transfer-verdict`,
> the single frozen-world exact gate) squash-merges**. Dependency chain: **#77/#78 → #76 → PR-3**. Follow the
> [Agent execution discipline](../../AGENT_EXECUTION_DISCIPLINE.md). This is THE destructive spine of the
> transfer campaign — **`/di-change` applies in full** and **stop for audit before any merge**.
>
> **Line-cite caveat:** every `file:line` below is at codex HEAD `31424eb` pre-squash-merge (a review-findings
> fix pass may land after it). Re-confirm each cite after your branch-off. The TS-sweep's own line numbers are
> pre-single-gate — trust THIS brief's cites, not the sweep's.
>
> Read first, in order:
> 1. `docs/superpowers/plans/2026-07-08-pr-3-protocol-wiring-plan.md` — the parent plan (steps 1–7); this
>    brief RECONCILES it to HEAD, does not replace it.
> 2. `docs/superpowers/plans/2026-07-10-ts-layer-assumption-sweep.md` — findings A1/A2/A3/A6/C3/D, folded
>    below as acceptance tests.
> 3. `docs/superpowers/plans/2026-07-10-black-box-discard-ruling.md` — binding failure-disposition policy
>    (already implemented at HEAD; PR-3 preserves it).
> 4. `docs/TRANSFER_2PC.md` — the NO-DUPLICATES contract and gate invariants (all DECIDED).

## The owner's law this rests on (do not violate)
**ONE binary contract: handshake-or-discard.** The destination is never live before the source has committed
and released; an unfinished handshake discards the destination artifact at a deadline. **No per-failure-reason
recovery flows, no force-resolve, no admin console.** Identity keys on `surface.index` / unique index +
canonical transfer id, never `platform.name` (Pitfall #31, identity = surface.index). Controller routes all;
instances never talk directly. A gate must measure a COMPLETE frozen state (Pitfall #28, count a complete state).

## 1. Reconciliation — old plan (2026-07-08) vs current codex HEAD

### 1A. Already DONE by the single-gate rewrite (#76) — inherit, do not redo
- **VOTE payload IS the single-gate verdict:** `event_payload.success = validation_result.success == true`
  (`module/core/import-completion.lua:708`), full result attached for transfers (`:717`), emitted via
  `send_json("surface_export_import_complete", …)` (`:729`). `failedStage` set ONCE by the single gate.
- **Failed verdict = Black-Box Discard, implemented:** `bank_failure_black_box` (always-on) at
  `import-completion.lua:108-145`; bank-then-discard with `preserve_failed_destination` escape hatch and
  `cleanup_failed`-on-false at `:548-571`. PR-3 must NOT add another quarantine/recovery owner.
- **Finding-10 / A5-residual landed** (`instance.ts:736-740`): `success` requires a typed boolean `=== true`
  AND the validation payload's own verdict; the weaker fallback was removed (fail-closed). **C5** likewise:
  `lib/operation-record.ts:33-39` null-and-throws `platformIndex` for transfer records. Verify both survived
  the squash before building on them.
- **The query verb is fully built instance-side; only the controller caller is missing:**
  `GetSourceTransferLockStateRequest` (`messages.ts:1133`; `index.ts:103`; `instance.ts:105,861`;
  `lib/lua-interface.ts:158`; Lua remote via `remote-interface.lua:57/113`; backed by
  `SurfaceLock.get_source_transfer_lock_state`, `utils/surface-lock.lua:372`).
- **All COMMIT primitives present and uncalled:** `commit_source_transfer_lock` (`surface-lock.lua:335`),
  `clear_committed_source_lock_after_delete` (`:352`), tombstones + retention (`:296-378`), the delete gate's
  committed branch (`delete-platform-for-transfer.lua:58-62`), `recordCommitTransmitted` (`controller.ts:842`),
  `sourceCommitMarkers` (`controller.ts:808-867`), retention constants (`controller.ts:39-40`).

### 1B. Changed shape under #76 — update the plan's wording
- "Composite verdict" → ONE frozen-world exact gate; `failedStage` is a category label, not a second act.
- **The go-live path PR-3 intercepts is explicit:** on a passing verdict, one synchronous tick runs
  `paused=false` → `ActiveStateRestoration.restore` → optional gateway-park (`import-completion.lua:573-632`).
  There is NO `hold_for_transfer` flag anywhere yet (grep-confirmed). PR-3 §1a replaces this block, behind the
  new PREPARE flag, with `DestinationHold.stage(...)` (`core/destination-hold.lua:113`) + the VOTE emit.
- Failed VOTE ⇒ dest has already self-discarded at gate time; the controller's `DiscardDestinationRequest` is
  an idempotent, tolerant-of-missing-platform confirm.

### 1C. Stale in the old plan — correct on sight
- "#76 must merge first" phrasing superseded by this brief's branch-off rule.
- Deadline math confirmed at HEAD: `COMMITTED_SOURCE_TOMBSTONE_RETENTION_TICKS = 36000 + 3000 = 39000`
  (`surface-lock.lua:10,17,24`); source-lock TTL = 36000 ticks (10 min). `HANDSHAKE_COMPENSATION_DEADLINE_MS`
  must be < ~10.8 min and ≥ a dest `docker restart` (~30–60 s).

## 2. The wiring to build (old plan §1–5, reconciled)
- **§1a PREPARE + VOTE:** `job.hold_for_transfer` from new `holdForTransfer` on `ImportPlatformRequest`; when
  set AND the exact gate passes, replace the go-live block (`:573-632`) with
  `DestinationHold.stage(job.transfer_id, platform, force)`; still emit the VOTE. Failure path unchanged.
- **§1b COMMIT:** new `interfaces/remote/commit-source-transfer.lua` wrapping
  `SurfaceLock.commit_source_transfer_lock(platform_index, transfer_id)`. Durable step BEFORE delete. No delete here.
- **§1c RELEASED:** reuse `DeleteSourcePlatformRequest` → the committed branch (`:58-62`) goes live once 1b flips.
- **§1d GO-LIVE / DISCARD:** new dest-side remotes over `DestinationHold.go_live`/`.discard`
  (`destination-hold.lua:193/217`), keyed by transfer id, tolerant of missing platform.
- **§2 Messages:** `CommitSourceTransferRequest`, `GoLiveDestinationRequest`, `DiscardDestinationRequest`,
  + `holdForTransfer` flag; register in `index.ts` (round-trip harness auto-covers); 3 `lua-interface.ts`
  bindings + `instance.ts` handlers. **Apply the fail-closed contract to all three new response shapes:**
  typed boolean, `=== true`, never fall back to a weaker signal.
- **§3 TS state machine:** rewrite `handleValidationSuccess` (`transfer-orchestrator.ts:334`) into the ordered
  handshake: `recordCommitTransmitted` write-ahead → COMMIT → RELEASED (await) → GO-LIVE → `completed`.
  `ActiveTransfer.phase` (`preparing|voted|committing|released|going_live|done`). Metrics funnel unchanged;
  widen `TERMINAL_RESULT`/`failure_stage` only for genuinely new terminal outcomes (e.g. `deadline_discard`).
- **§4 Reconcile loop:** boot re-adoption in `onStart` (today prune+warn only, `controller.ts:151-159`) +
  periodic timer, both driven through a PURE `resolvePendingTransfer(sourcePhase, commitTransmitted,
  deadlinePassed)` in new `lib/transfer-reconciliation.ts`. **Must NOT reintroduce the retired #60 spine:**
  keep `no-controller-auto-delete.test.cjs` teeth (update in the same reviewed di-change), name the driver
  `adoptPendingTransfers`/`driveHandshake`, source-phase-query-authoritative (the commit marker is hygiene,
  never the gate).

## 3. Sweep findings as EXPLICIT acceptance tests
Physical grounding per lint:test-grounding (surface census BOTH instances; `get_item_count` for fidelity);
section-selectable; restart sections in final passes only; zero-leftover incl. `destination_holds`,
`locked_platforms`, `committed_source_transfer_tombstones`.
- **A1(a) late VOTE past the 120s timeout** → after source TTL window, assert ≤1 live copy (COMMIT-before-
  delete + re-adoption from `pendingTransfers`, never a resurrected live source).
- **A1(b) controller restart while `awaiting_validation`** → boot re-adoption resumes from the source-phase
  query; no dup.
- **A1(c) delete-send failure** (inject SessionLost on the delete `sendTo`, `:338`) → source phase is already
  `committed`; reconcile ROLLS FORWARD (retry RELEASED → GO-LIVE); never unlocks a live source.
- **A3 phase guard:** top of `handleTransferValidation` (`:287`) rejects a VOTE not expected in the current
  `phase`. Test: duplicate/late VOTE after terminal resolution does not re-send the delete.
- **A3 tail — destination notification:** GO-LIVE/DISCARD become the terminal dest messages; a VOTE arriving
  after a timeout-driven DISCARD routes to an idempotent DISCARD (explicit reconcile-table row).
- **A2/A6 are INPUTS from LAB-TAIL T2/T4** (validation-timeout distribution; stored-export latency) —
  reference, do not re-measure. LAB-TAIL does NOT measure the handshake deadline (that's §5.2, bounded by the
  39000-tick tombstone).
- Plus old plan §6 unchanged: `test/transfer-reconciliation.test.cjs` (exhaustive resolvePendingTransfer),
  `transfer-lock-selftest.lua` commit-transition coverage, and the 4 integration sections (happy / restart
  re-adoption / abort discard / deadline discard), each with a physical no-both-live assertion.

## 4. ORCHESTRATOR ADJUDICATIONS (decided — implement as stated)
1. **C3 (prune can evict in-flight): FOLD IN as defense-in-depth.** Add the one-line in-flight exclusion to
   `pruneOldTransfers`; frame as UI/metrics correctness + belt-and-suspenders (durable recovery keys on
   `pendingTransfers` + tombstones, untouched by prune). NOT labeled a duplication blocker (severity taxonomy).
2. **Finding-D hygiene: DELETE `waitForExportData` (`instance.ts:410-429`) + `helpers.ts:12-13` constants in
   PR-3's TS commit** — zero-caller dead code; removing it is part of un-scaffolding the protocol. Label the
   commit honestly (`refactor`/`chore` content in a code-labeled commit).
3. **Gateway-park × go-live (was boundary question 1): PRIMARY = `go_live` replays the park** — store
   `gateway_target` in the hold record at stage time; on GO-LIVE, run the existing pause-first park block for
   held gateway transfers. **Sanctioned FALLBACK if the replay proves hairy in practice: exclude gateway
   transfers from `holdForTransfer` in PR-3** (they keep the current non-held path) and file the follow-up —
   report which path you took and why. Either way: a boarded-passenger check is NOT needed at go-live
   (evacuation is a delete-time concern; go-live deletes nothing).

## 5. Boundary questions still open (raise BEFORE coding)
1. `HANDSHAKE_COMPENSATION_DEADLINE_MS` value (proposed ≈5 min; ceiling ~10.8 min; floor ≥ ~60 s; refine with
   LAB-TAIL T2 if it has landed).
2. Message decomposition confirmation (recommended: one verb per message — 3 messages + the flag).
3. Restore vs rewrite `resolvePendingTransfer` (recommended: restore from the `dist/node/lib/
   transfer-reconciliation.js` orphan, re-scoped to handshake-or-discard).

## 6. Files touched
Lua: `core/import-completion.lua` · `core/destination-hold.lua` · `utils/surface-lock.lua` (reuse) ·
`interfaces/remote/delete-platform-for-transfer.lua` (branch goes live) · new `commit-source-transfer.lua` /
`go-live-destination.lua` / `discard-destination.lua` · `remote-interface.lua` · `transfer-lock-selftest.lua`.
TS: `lib/transfer-orchestrator.ts` · `controller.ts` · `instance.ts` · `messages.ts` + `index.ts` ·
`lib/lua-interface.ts` · new `lib/transfer-reconciliation.ts` · `lib/metrics.ts` (only if new terminal
outcome) · `package.json` test slot · delete `waitForExportData` + its constants (adjudication 2).
Tests: `test/transfer-reconciliation.test.cjs` (restore) · `test/no-controller-auto-delete.test.cjs`
(update, reviewed) · new `tests/integration/transfer-2pc/` (4 sections + A1×3 + A3 teeth; use the cheap
fixtures if #35 has landed) · selftest. Docs: `TRANSFER_2PC.md` planned→implemented · `ENGINEERING_FAQ.md`
controller-restart row · CLAUDE.md/AGENTS.md one-liner (mirror locally).

## 7. Verification (in order)
```
# container: npm run lint ; npm test ; node --test test/transfer-reconciliation.test.cjs test/destination-hold.test.cjs
./tools/patch-and-reset.ps1
node tools/run-integration-tests.mjs --only 'transfer-2pc|rollback|destination-hold'
node tools/run-integration-tests.mjs
# happy / restart(A1b) / abort(A3) / deadline / A1a / A1c — each with a physical <=1-live-copy census
```
Two consecutive green full-suite runs + zero-leftover, reported ONCE. `/di-change` checklist in the PR body;
`/code-review` at authoring, not just merge. package-lock untouched. Then **stop for audit**; watch the
post-merge main run.

## Boundary stops
Anything requiring changes to the single exact gate (#76's territory) · a physical census EVER showing two
live copies · any DI-lint fires · `delete_platform` false on the discard path · unresolved §5 questions ·
cluster failures.
