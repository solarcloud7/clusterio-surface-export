# Phase 1 RE-AUDIT — GPT-5.5's fixes for F1–F7

> **Audit-only.** Verifies GPT-5.5's fixes to the 7 findings in `TRANSFER_2PC_PHASE1_AUDIT.md`, and probes
> whether the fixes introduced new correctness/data-loss/plan-deviation defects. **No fixes applied.**
> Method: manual read of the working-tree diff + independent re-run of the pure-node guards (`lint:lua`,
> `lint:pcall-logging`, `lint:test-hooks`, `lint:test-grounding`, `npm test` 122/122 — all green) + an
> xhigh workflow-backed `/code-review` (22 agents: 6 finders, 13 verifiers, sweep, synthesize; 14 candidates
> → 11 kept, 3 refuted). Each item below states whether I **independently confirmed** it.

## Verdict
The **core Phase-1 mechanics are sound**: source-side TTL, unlock-**only** (never deletes), `kind=="transfer"`
guard protects admin `/lock-platform`, nil-guards intact, `scan_transfer_expiries` wired into `on_tick`
(throttled `%60`), universal `ExportPipeline.queue` stamping intact, the #60 controller-auto-delete spine is
gone and its pure `resolvePendingTransfer` is dormant (defined, imported nowhere in production). No happy-path
data loss, no destructive auto-delete on boot.

**But it is not clean-merge-ready.** F6 is fully resolved; F1/F2/F3/F5 are *mechanically* resolved (each did the
specific thing asked) but carry residuals; **F4 has a real test-teeth gap**; and **F7 is incomplete** (stale
"reconcile" comments remain). The fixes also **introduced one real correctness regression** (F2's backfill) and
surfaced one robustness gap (the expiry scan swallows its unlock result). All remaining issues are
**recoverable** (dup / stuck-lock / mis-report), none is silent happy-path loss.

Per-finding: **F6 ✅** · **F1 ✅ (1 residual)** · **F2 ⚠️ mechanically-yes + NEW regression** · **F3 ✅ (1 minor)**
· **F4 ⚠️ teeth gap** · **F5 ✅ (teeth weakened)** · **F7 ❌ incomplete**

---

## Ranked remaining/introduced defects

### R1 — F2 backfill accepts a SECOND concurrent in-game transfer of an in-flight platform (CONFIRMED — regression)
`module/utils/surface-lock.lua:239` · `module/core/transfer-trigger.lua:64`
The same-transfer backfill (`surface-lock.lua:239-245`) returns `true, nil` for **any** existing
`kind=="transfer"` lock whose name/surface match (Phase 1 has no canonical `transfer_id`, so it can't tell "my
own export-pipeline re-lock" from "a second, independent transfer command"). `transfer-trigger.start` has **no
pre-lock guard** — the lock *was* the concurrency guard. **Independently confirmed by reading the diff:** OLD
`SurfaceLock.lock_platform(platform, force)` returned `false, "Platform already locked"` → `transfer-trigger`
returned `"Lock failed"` → **refused**. NEW `lock_platform(platform, force, {expires_tick})` → backfill →
`true` → **proceeds** to `queue_export` a second time on the same frozen source → imports to two destinations
while the single source is deleted once = **duplication (violates 2PC "never both live")**.
Scope: the **in-game** `/transfer-platform` + `/gateway-transfer` path only. The web/controller path never
touches `transfer-trigger`, and OLD `export-pipeline` already treated `"Platform already locked"` as
benign-continue — so that path's behavior is **unchanged** by this PR. Severity: **recoverable dup**, requires an
admin to re-issue a transfer on an in-flight platform.
*Fix direction:* restore the in-game guard — `transfer-trigger.start` should refuse if
`SurfaceLock.is_locked(platform.index)` **before** locking (export-pipeline's legitimate self-re-lock still uses
the backfill; transfer-trigger is always the FIRST lock in that path, so a refuse there is safe).

### R2 — F7 is incomplete: stale "reconcile" comments remain, one actively misleading (CONFIRMED)
`lib/transfer-orchestrator.ts:382` · `lib/lua-interface.ts:163` · `instance.ts:843` · `messages.ts:1086`
The F7-named locations *were* cleaned, but four comments still present the **removed** #106 restart-reconcile as a
live caller. **Independently confirmed by grep.** The name-tripwire's actual current caller is `tryUnlockSource`
(same-tick rollback), not a reconcile. Most dangerous: `transfer-orchestrator.ts:380-382` — *"mark it
cleanup_failed … letting a restart reconcile retry the unlock"* — describes a controller-boot recovery mechanism
that **no longer exists** (recovery is source-side TTL only). A maintainer trusting it mishandles the
cross-deploy stranded-lock case (a pre-deploy lock has no `kind`, so `scan_transfer_expiries` never expires it and
no reconcile recovers it) and could re-introduce the retired auto-delete spine — the exact risk F7 exists to kill.
*Fix direction:* reword to describe the source-side-TTL model (and, for the tripwire, "the rollback path / a
future Phase-2 reconcile passes it").

### R3 — F4 restart test has no teeth against a TIMER-scheduled reintroduction (CONFIRMED)
`test/no-controller-auto-delete.test.cjs:54`
The behavioral test (good improvement over the old grep) asserts `calls.sends.length === 0` **synchronously**
right after `await plugin.onStart()`. **The retired #60 spine was a `setInterval` poll loop.** A future
re-introduction using the KEPT `resolvePendingTransfer`/`handleValidationSuccess` on a timer fires its
delete/unlock sends as a macrotask **after** the sync assert resolves → the test stays **green**, and the
companion grep test only matches the retired *symbol names* (none of which a kept-helper reintroduction contains).
So the controller-auto-delete-on-restart data-loss regression the whole Phase-1 change exists to prevent could
ship with CI green. *Fix direction:* use fake timers / assert no timer was scheduled (spy `setInterval`/
`setTimeout`), or drain the loop before asserting.

### R4 — `scan_transfer_expiries` swallows the unlock result → half-restored source mis-reported as clean expiry (CONFIRMED)
`module/utils/surface-lock.lua:431,434`
The scan pre-increments `expired` (431) then **discards** `unlock_platform`'s `(ok, err)` return (434); the
summary has no failure counter. `unlock_platform` **unfreezes entities + un-hides the surface (349-350) BEFORE
restoring the schedule (351-356)**, so if `PlatformSchedule.apply` fails it drops the lock and returns `false`,
leaving the source **live + visible + wrong-schedule + unlocked** — now reachable with **no admin/controller
action** because the new `on_tick` scan is the caller. The tick loop and the selftest get no signal. Severity:
requires a schedule-restore failure (rare), but the silent mis-report is real. *Fix direction:* count/log a
failed unlock in the summary; consider restoring schedule before the visible/active reveal.

### R5 — a stranded transfer's stored export lingers, re-importable into a 3rd copy (PLAUSIBLE — equivalence-diff miss)
`controller.ts:766`
On a controller restart during `awaiting_validation` of an already-committed transfer, the source self-unlocks
(the documented dup), `handleValidationSuccess` (which deletes `platformStorage[exportId]`) never runs, and
`prunePendingTransfersInMemory` drops the intent **and its `exportId`** after 15 min **without deleting the stored
export**. The export stays in the Exports tab, re-importable → an operator Import-JSON yields a **third** copy.
The removed reconcile `complete` path deleted this export precisely to prevent that; Phase 1 dropped the side
effect with no replacement (the exact "new path drops the proven path's side effects" class from
`verified-the-easy-part`). Caveat: Phase 1 *can't* know the dest committed, so a fully-correct fix is Phase-2
territory — but the dropped cleanup should be documented as a known corner.

### R6 — F5's worst-case TTL floor is tautological (CONFIRMED — teeth weakened)
`module/utils/surface-lock.lua:11` · `module/interfaces/remote/transfer-lock-selftest.lua:91`
`MIN_WORST_CASE_TRANSFER_TTL_TICKS` is a **duplicate literal** equal to `DEFAULT_TRANSFER_LOCK_TTL_TICKS` (both
`36000`), so the selftest `DEFAULT >= MIN` is `36000 >= 36000` — always true. It **does** catch lowering *only*
`DEFAULT` (the F5 win over the old `>7200`), but a **co-lowering of both** (e.g. to 9000 to "speed up recovery")
ships green while a legit slow 235 KB transfer TTL-expires mid-flight. *Fix direction:* derive `MIN` independently
(e.g. `ceil(VALIDATION_TIMEOUT_MS/1000*60) + RCON_transmit_estimate + import + margin`), not a copy of `DEFAULT`.

### R7 — mid-flight TTL window can delete a re-activated source (PLAUSIBLE — design-accepted corner)
`module/core/export-pipeline.lua:191`
TTL clock starts at export-**queue** time (`game.tick + 36000`). A transfer whose whole pipeline exceeds 36000
ticks (~10 min) gets its still-in-flight source auto-unlocked (re-activated, revealed); the later success-path
delete then removes a now-live source, losing anything it produced/consumed in the live window. This is the
`TRANSFER_2PC_DESIGN.md` §"TTL sizing" corner — 36000 has ~3× margin over the estimated worst case (~200 s), so it
won't fire under normal load, but it's newly reachable (locks never auto-expired before this PR). **Document** as
a known corner; R6's independent `MIN` derivation is the real guard.

### R8 — selftest `unlock_uses_name_tripwire` relies on `pairs()` order (PLAUSIBLE — spurious-RED only)
`module/interfaces/remote/transfer-lock-selftest.lua:85`
Asserts `unlocks[1].name=='expired' and unlocks[2].name=='fallback'`, depending on `pairs()` visiting integer key
1 before 4. Worst case is a **flaky RED**, not a false-green (production behavior stays correct). Factorio's Lua
5.2 traverses the array part ascending, so unlikely to fire — the prior audit already refuted this as
"not-breaking-in-practice." Minor: assert order-independently (check the set `{expired,fallback}` unlocked).

---

## Confirmed RESOLVED (fix is real + has teeth)
- **F6 ✅** `lint:pcall-logging` green — independently re-ran in the host container: *"138 pcall(s) … all surface
  their errors or are annotated."* The `-- pcall:allow` at `transfer-lock-selftest.lua:26` is justified (the
  selftest restores `storage`/`SurfaceLock` unconditionally after the pcall and surfaces the error into
  `details` at :99-102, 74 lines away — outside the 50-line window, hence the annotation).
- **F1 ✅** bounded pruning real: `PENDING_TRANSFER_INTENT_RETENTION_MS` age-prune on boot + before every insert;
  behavioral test (`prunePendingTransfers` prunes stale+invalid, persists compacted store). *(Residual: R5.)*
- **F2 ✅ (mechanically)** `lock_platform_for_transfer` now stamps `{expires_tick}` → expiring `kind="transfer"`
  lock; manual `/lock-platform` (command handler passes **no** `transfer_opts` → kind-less → never scanned/
  expired) is still refused by a transfer and never auto-touched — independently confirmed. *(But see R1.)*
- **F3 ✅** the `transfer-lock-expiry` integration test **executes** `scan_transfer_expiries` via
  `transfer_lock_selftest_json` over RCON, is registered in `remote-interface.lua`, auto-discovered by
  `run-integration-tests.mjs`, and has real teeth (RED if `>= expires_tick` is inverted or the `kind` guard
  dropped — the manual-lock case would then be unlocked → `manual_lock_untouched` fails). *(Minor: R8.)*
- **F4 ✅ (behavioral core)** the restart test constructs the controller, runs `onStart` with a persisted intent,
  spies `sendTo`, asserts 0 sends + the source-side-TTL warning; `resolvePendingTransfer` confirmed unwired.
  *(But see R3 for the timer gap.)*
- **F5 ✅ (mechanically)** selftest now asserts `DEFAULT >= MIN_WORST_CASE`, catching a `DEFAULT`-only lowering
  the old `>7200` missed. *(But see R6.)*

## Refuted (not defects) — the review's own refutations, which I concur with
- `lock_platform_for_transfer` becoming an *expiring* lock is the **intended** F2 fix, not a defect (transfer
  locks are supposed to auto-unlock).
- `scan_transfer_expiries` unconditionally unlocking a `cleanup_failed` lock is the **design-accepted** Phase-1
  unlock-only behavior (recoverable dup ≫ unrecoverable loss), not a "guaranteed duplication" bug.
- The 15-min wall-clock retention vs the game-tick TTL is **not** a harmful decoupling — the pending store is
  observability-only in Phase 1, so premature eviction causes no correctness harm (R5 is the *export-lingering*
  angle, which is real; the *eviction-of-a-needed-intent* angle is not).

## Net for the implementer (GPT-5.5)
Before Phase 1 ships: **R2** (trivial comment completion), **R1** (restore the in-game double-transfer guard),
and the test-teeth items **R3** + **R6** (so the safety tests actually protect the invariants) + the **R4**
mis-report. **R5** and **R7** are known/Phase-2 corners — document them in the PR + `/di-change` notes rather than
fix now. **R8** is cosmetic. The core failsafe (source-side, unlock-only, tick-based) is correct and the #60
destructive spine is gone; the gaps are all at the edges.
