# Phase 1 audit — implementation vs `TRANSFER_2PC_DESIGN.md`

> **Audit-only.** These are findings from an xhigh workflow-backed `/code-review` of the (uncommitted, working-tree)
> Phase-1 implementation against `docs/TRANSFER_2PC_DESIGN.md`. **No fixes have been applied.** 7 findings survived
> independent verification; 2 candidates were refuted. Ranked most-actionable first. Fix *directions* are noted for
> the implementer but were deliberately NOT applied.

## Verdict
The Phase-1 direction conforms to the plan on the core mechanics — the source-side tick expiry always **unlocks
(never deletes)**, reshapes the dead `cleanup_stale_locks`, keys on `kind="transfer"`, stamps at the universal
`ExportPipeline.queue` path, and the #60 controller boot auto-delete spine is gone from the code. But it is **not
mergeable as-is**: a CI lint guard is RED, two real runtime defects were introduced, and — most important given this
repo's discipline — the two new Phase-1 tests are **pure source-grep** and execute none of the stateful failsafe
logic, so a future regression of a source-unlock / source-delete invariant would ship green.

---

## Findings

### F1 — `pendingTransfers` store now grows unbounded; `onStart` count inflates with stale data (CONFIRMED, correctness)
`controller.ts:144` · plan requirement: "keep `PendingTransferIntent` for observability" (Disposition of #60)
Deleting the boot-reconcile loop removed the **only consumer that ever pruned boot-leftover / `cleanup_failed`
intents**. The sole remaining removal (`transfer-orchestrator.ts:312-313`) requires a *live* transfer to reach
`completed/failed/error`, which a boot-leftover never can (its in-memory `activeTransfers` entry was lost on the
restart; the late `TransferValidationEvent` hits "Validation for unknown transfer" and returns early). `cleanup_failed`
is also deliberately excluded from that removal list. So every controller-restart-during-`awaiting_validation` and
every `cleanup_failed` **permanently** adds a stale entry: `pendingTransfers.json` grows without bound, and each future
`onStart` warns "N transfer(s) were awaiting validation at shutdown" with an ever-larger N of transfers that actually
resolved long ago via the new source-side TTL. **Fix direction:** give the kept observability store a real pruning
policy (age/bounded), and/or prune an intent once its source-side TTL window has elapsed — or drop the persisted store
entirely for Phase 1 since it now has no consumer.

### F2 — the kind-less-lock refusal breaks the documented `lock_platform_for_transfer` remote (CONFIRMED, correctness; dormant)
`module/utils/surface-lock.lua:247` · plan requirement: manual-lock safety / backfill (P1-5)
The new branch `if transfer_opts and existing_lock.kind ~= "transfer" then return false, "Platform already locked by a
non-transfer lock"` treats *any* pre-existing kind-less lock as a blocking manual lock. But the CLAUDE.md-documented
`lock_platform_for_transfer` remote (`interfaces/remote/lock-platform-for-transfer.lua:23`) still calls
`lock_platform(platform, force)` with **no** `transfer_opts` (kind=nil). So a platform pre-locked via that documented
API can no longer be transferred (export-pipeline aborts), and its lock is skipped by `scan_transfer_expiries`
(`kind~="transfer"`) → it becomes the exact stranded-locked-and-hidden platform Phase 1 exists to heal. Dormant today
(no live TS caller invokes that remote), but a real API-vs-behavior inconsistency the change introduced. **Fix
direction:** either have `lock_platform_for_transfer` pass `transfer_opts` (it *is* a transfer lock), or distinguish
"manual admin lock" from "kind-less legacy transfer lock" rather than treating all kind-less locks as blocking manual
locks.

### F3 — the stateful expiry logic has NO executed behavioral test (CONFIRMED, test-grounding / data-integrity)
`test/lua-transfer-lock-phase1.test.cjs:15` · plan Verification item + `lint:test-grounding` + `verified-the-easy-part`
`npm test`'s only Phase-1 coverage is **pure source-grep**: it `readFileSync`s the Lua/TS and asserts with
`assert.match`/`assert.doesNotMatch` — it never executes `scan_transfer_expiries`. The one test that *does* run the
logic (`module/interfaces/remote/transfer-lock-selftest.lua`) is wired into **no** integration runner (unlike the
version/gateway/schedule selftests). So a regression — inverting `game.tick >= expires_tick` to `<=`, or dropping the
`kind=="transfer"` guard — ships **green**, and the broken scanner then unlocks a fresh in-flight transfer lock
(reactivating a mid-transfer source → Pitfall #15 craft window → the completing transfer deletes it) and/or auto-unlocks
admin `/lock-platform` locks, with CI never going red. This is exactly the anti-pattern the repo's test-grounding
discipline forbids. **Fix direction:** register `transfer-lock-selftest.lua` in the integration runner (as the other
selftests are), so the expiry behavior — unlocks an expired `kind="transfer"` lock, SKIPS a manual lock, NIL-GUARDS an
old-save lock, NEVER deletes — is executed with teeth (RED on revert). (Refuted sub-point: the selftest's `pairs()`
iteration-order assumption was checked and does NOT break in practice — dense integer keys 1..5 iterate in order.)

### F4 — `no-controller-auto-delete.test.cjs` protects a source-DELETION invariant by grepping retired symbol names (CONFIRMED, test-grounding / data-integrity)
`test/no-controller-auto-delete.test.cjs:20` · plan Verification item + `verified-the-easy-part`
The old suite executed `resolveStrandedTransfer` and asserted real behavior; it was replaced by six
`assert.doesNotMatch` text-greps for the **retired** identifiers (`GetTransferOutcomeRequest`,
`reconcilePendingTransfers`, `resolveStrandedTransfer('complete')`, `surface_export_transfer_outcomes`). But the plan
deliberately **KEEPS** `resolvePendingTransfer` and `handleValidationSuccess`. A future edit that re-wires those *kept*
pieces into `onStart` to auto-delete a stranded source on boot (the exact #106 auto-delete-on-a-guess data-loss class)
contains **none** of the greped names → the test stays GREEN and the regression ships. A source-deletion invariant is
grounded in the wrong place. **Fix direction:** assert the invariant behaviorally — construct the controller, run
`onStart` with a persisted boot-leftover intent + a spy on the source-delete send, and assert the delete is never
issued — so it goes RED regardless of which symbols a reintroduction uses.

### F5 — the TTL selftest asserts the weaker bound plan P1-3 explicitly rejects (CONFIRMED, plan-deviation)
`module/interfaces/remote/transfer-lock-selftest.lua:90`
The assertion is `DEFAULT_TRANSFER_LOCK_TTL_TICKS > 7200` (= the 120s `VALIDATION_TIMEOUT_MS` at 60 UPS) — the exact
"NOT just VALIDATION_TIMEOUT_MS" bound the plan says is insufficient. It never checks the TTL exceeds worst-case TOTAL
transfer duration. A later lowering to e.g. 9000 ticks (2.5 min, > 7200 but below a 235KB platform's real worst case)
still passes while a slow-but-healthy large transfer self-unlocks mid-flight. **Fix direction:** assert against a
worst-case-total-duration constant (export + chunked transmission + import + validation + margin), not the validation
timeout.

### F6 — MERGE-BLOCKER: the new selftest fails the gated `lint:pcall-logging` guard (CONFIRMED, cleanup / CI-red)
`module/interfaces/remote/transfer-lock-selftest.lua:26`
Empirically verified: `npm run lint:pcall-logging` exits 1 — "transfer-lock-selftest.lua:26 captured pcall whose error
is neither logged nor propagated within 50 lines". The pcall opens at line 26; its only error surfacing (`msg =
tostring(err)`) is at line 100 (74 lines away, past the 50-line window). `npm run lint` is the gated CI aggregate, so
the PR **cannot merge** until fixed. `npm test` alone passes and masks it. **Fix direction:** surface the pcall error
within 50 lines, or add a `-- pcall:allow` annotation with a reason.

### F7 — stale comments still describe the removed #60 boot-reconcile/auto-delete as live (CONFIRMED, correctness/cleanup)
`controller.ts:702-709` (+ `transfer-orchestrator.ts:240, 309-311, 482`)
The #60 spine was removed from the code but its comments remain, still asserting "on boot we reconcile each against the
DESTINATION's authoritative outcome … complete = delete the stranded source … we poll while intents remain" and that the
persisted intent is kept "so a restart reconcile retries the delete." None of that exists anymore (`onStart` only logs;
the source self-heals via TTL). **Risk:** a Phase-2 maintainer trusting these comments re-introduces the retired
auto-delete-on-a-guess spine — the exact data-loss class the retirement bought safety against. **Fix direction:** update
the comments to describe the source-side TTL model.

---

## Refuted (not defects)
- `transfer-lock-selftest.lua:84` — the `pairs()` iteration-order dependency does NOT break (dense integer keys 1..5
  iterate in order in the LuaJIT/Factorio runtime here).
- `package.json:20` — `lib/transfer-reconciliation.ts` + its test being built/run despite no current production caller
  is **intended** (the plan KEEPS `resolvePendingTransfer` for Phase 2 re-use), not dead code.

## Net for the implementer (GPT-5.5)
Blockers to merge: **F6** (CI red). Substantive to fix before Phase-1 ships: **F1, F2** (runtime), **F3, F4** (make the
data-integrity failsafes actually tested — this is the repo's non-negotiable test-grounding discipline), **F5** (TTL
bound). **F7** is cleanup but real (prevents a maintainer re-adding the retired spine). The core Phase-1 mechanics are
sound; the gaps are around it.
