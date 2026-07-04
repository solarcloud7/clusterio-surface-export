# Durable, phase-aware two-phase-commit for cross-instance transfers

> **Status:** design/plan (not yet implemented). This doc is the implementation spec: it is built against and
> audited against. Supersedes the controller-side reconcile approach on branch
> `feat/106-rollback-restart-durability` / PR #60 (see "Disposition of the #60 branch").
>
> Incorporates **three rounds of adversarial design review** (all folded in below): R1 — universal lock path, TTL
> sizing, vote-means-finalized, idempotent COMMIT, source-phase read; R2 — canonical transfer id, destination hold
> primitive, source-gone tombstone, idempotent GO-LIVE/discard, manual-lock-safe backfill; R3 — `committed` as an
> irreversible non-live tombstone (GO-LIVE on committed-OR-gone), synchronous source-id capture, never-DISCARD-
> after-COMMIT, hold-primitive as a hard blocker.
>
> **Do NOT implement Phase 2 until the two "Phase 2 prerequisites" (canonical transfer id + destination hold
> primitive) are spiked and proven. Phase 1 is independent of both and can proceed.**

## Context
A transfer MOVES a platform from a source instance to a destination. Today the orchestration **and the failsafe
timeout** live only in the CONTROLLER's memory (`activeTransfers` Map + a `setTimeout(VALIDATION_TIMEOUT_MS=120000)`
in `lib/transfer-orchestrator.ts`). Two consequences:
1. **Restart-stranding** (the original #106 problem): if the controller process restarts during
   `awaiting_validation`, that in-memory state — including the timer — is gone, so the source platform stays
   **locked-and-hidden forever** (owner loses it; only a manual `/unlock-platform` recovers it).
2. **A duplication window**: the dest's imported platform goes LIVE at import/activation while the source still
   exists until the controller commands the delete — briefly both are live.

The existing WIP branch (`feat/106-rollback-restart-durability`, PR #60) tried to fix #1 by making the
**controller** the restart failsafe: persist an intent, on boot re-query the dest, and **auto-DELETE the source**.
That auto-delete-on-a-guess produced repeated data-loss defects across 3 review passes — a structural problem,
not a bug to patch. Owner decision: move the failsafe to **where the at-risk resource lives** (the source
instance's own Factorio save, which survives every restart, driven by GAME TICKS), and make transfers a real
**two-phase commit with mutual agreement**. This plan supersedes #60's controller-auto-delete approach.

## The whole design: two gates, one durable fact
- **Gate A (never both gone):** the SOURCE deletes only after a durable COMMIT signal proving the DEST has staged a
  *validated* copy.
- **Gate B (never both live):** the DEST goes live only after the SOURCE is confirmed **gone OR in the irreversible
  `committed` non-live state**. `committed` is a permanent, non-live tombstone (R3): the source stays hidden+frozen
  and **every unlock/resume path REFUSES a `committed` lock** (only delete can clear it). So a source stuck
  `committed` because its delete keeps erroring is a harmless frozen tombstone that can never revive — releasing
  the dest on `committed` (not only on `gone`) prevents the dest being held hostage to source cleanup, while still
  honoring "never both live" (a frozen, unrevivable tombstone is not live).
- The **commit point** is a single durable fact — the source lock's `phase` flips `pre_commit → committed` — stored
  in the at-risk resource's own save (`storage.locked_platforms` on the source). Every failsafe/reconcile resolves
  ambiguity by consulting that phase: `pre_commit` ⇒ ABORT (source unlocks, dest discards); `committed` or
  source-gone ⇒ COMMIT (source deletes, dest goes live). Because COMMIT is sent only *after* the dest's
  staged-validated vote, `phase=committed ⇒ dest provably holds a good copy`, which is what makes the post-commit
  auto-DELETE loss-safe.

## Phase 1 — source-side durable expiry (small, safe, ship first)
Give the transfer lock a durable, tick-based expiry that lives in the source save and **always auto-UNLOCKS**
(never deletes). Non-destructive by construction → cannot lose data → dissolves the entire "reconcile deleted the
wrong thing" class. Fixes the restart-stranding: the source heals itself instead of waiting on the controller.

Files (all additive + nil-guarded):
- `module/utils/surface-lock.lua`:
  - `lock_platform` (212-275): accept optional `transfer_opts`; when present stamp `kind="transfer"` +
    `expires_tick` (+ the Lua export `job_id` as a correlation handle) into the lock record (259-269).
    Manual/legacy callers pass nothing → no `kind`. **NOTE (audit P0-1):** the controller's canonical `transferId`
    does NOT exist at lock time — it is minted later in `transferPlatform` (`transfer-orchestrator.ts:126`), after
    export completes. Phase 1 does not need it (expiry keys on `kind` + `expires_tick`, unlocks by index+name).
    The single canonical transfer id is a **Phase 2 prerequisite** (see "Phase 2 prerequisites" below).
  - Reshape the **dead** `cleanup_stale_locks` (390-420) into `scan_transfer_expiries()`: iterate
    `storage.locked_platforms`; **skip unless `kind=="transfer"`** (protects `/lock-platform`); **nil-guard**
    `locked_tick`/`expires_tick` (current line 400 would crash on an old-save lock); expired transfer lock →
    `unlock_platform(index, platform_name)`.
- `module/core/control.lua` (79-81): extend the existing `[e.on_tick]` closure to also call
  `scan_transfer_expiries()` throttled (`game.tick % 60 == 0`), independent of `process_tick`'s no-async
  early-return.
- **Stamp the transfer marker at the UNIVERSAL lock path, not just `transfer-trigger`** (audit P0-2). The
  `export_platform` remote (`interfaces/remote/export-platform.lua:12`) passes `destination_instance_id` straight
  into `AsyncProcessor.queue_export` → `ExportPipeline.queue` locks at `export-pipeline.lua:189`, **bypassing**
  `transfer-trigger.lua`. So a controller/web-initiated transfer never touches `transfer-trigger`. Fix: stamp
  `kind="transfer"` + `expires_tick` at `ExportPipeline.queue` **whenever the job carries a
  `destination_instance_id`** (the universal path for every transfer), and also at `transfer-trigger.lua:63` (the
  in-game path locks first). Because the transfer's FIRST lock already carries the marker, there is no "transfer
  already locked without `kind`" case in normal flow.
- **Backfill must NOT convert a manual lock (audit P1-5).** The only way the universal lock path meets an
  already-locked platform *lacking* `kind` is a pre-existing **manual `/lock-platform`**. Do NOT silently stamp
  that into an expiring transfer lock. Instead: if a transfer targets a platform already locked by a non-transfer
  (manual) lock → **refuse the transfer** (surface the conflict), leaving the admin's lock intact. Only ever
  "upgrade" a lock that is verifiably this same transfer (index/name/surface match + created by the transfer path).
- **Retire #60's controller boot-reconcile auto-delete in the same PR** (see disposition below) so there is a single
  failsafe authority.

Honest caveat to document in the PR + `/di-change` notes: Phase 1 adds one **narrow, recoverable** dup corner —
validation passed → dest already live → controller died *after* the validation event but *before* the delete
landed → the source's expiry later unlocks → two live copies. Today that same scenario leaves an **invisible frozen
orphan forever**; a visible, admin-deletable dup is strictly more recoverable (owner invariant: recoverable
dup/stuck beats unrecoverable loss). Phase 2 eliminates this corner.

**TTL sizing (audit P1-3):** the lock is taken at export *start* (`ExportPipeline.queue`, before scanning), so it
lives for the WHOLE transfer — export scan + controller store wait + chunked RCON transmission + dest import +
validation + cleanup. TTL must exceed the **worst-case total transfer duration** (a 235KB platform is ~40s of
RCON alone; import + the 120s `VALIDATION_TIMEOUT_MS` on top), NOT just the validation timeout — else a slow-but-
healthy large transfer self-unlocks mid-flight. Start generous (≥ the dead code's 36000-tick / 10-min default,
sized against the largest realistic transfer + margin); make it a named constant, not a magic number. Default
fallback when `expires_tick` absent: `locked_tick + DEFAULT_TTL_TICKS`. A controller **heartbeat** that extends the
lock while a live controller is actively working the transfer (so a huge/congested transfer can't self-unlock
mid-flight, while small failed ones still recover fast) is a **deferred Phase 2 refinement (R3), NOT Phase 1** — and
if added it must extend ONLY a matching `kind="transfer"` lock scoped by the canonical transfer id + identity
tripwires, so a stray/mismatched heartbeat can never extend the wrong lock. Phase 1 uses the static generous TTL.

## Phase 2 prerequisites — spike + nail down BEFORE implementing Phase 2
These two are protocol foundations, not implementation details. **Phase 2 is blocked on both; Phase 1 is not.**

1. **Canonical transfer ID (audit P0-1).** Today the controller mints its own `transferId`
   (`transfer-orchestrator.ts:126`) AFTER export completes — separate from the Lua export `job_id`
   (`export-pipeline.lua:160`) created at lock time. The 2PC requires ONE id shared across source-lock →
   dest-stage → COMMIT → GO-LIVE → tombstone. Resolve the id model: make the **source-generated** id canonical
   (promote the export `job_id`, or generate a dedicated `transfer_id` at lock time) and have the controller
   **adopt** it from the export-complete event instead of minting its own. The in-game path has no controller
   involvement at lock time, so the id MUST originate at the source. Every downstream record keys on it.
   **Concrete recipe (R3):** `export_platform` already returns its source-generated `job_id` **synchronously** to
   the RCON caller (`export-platform.lua:12`). For a controller-initiated transfer the controller MUST capture that
   returned id and **persist it as the canonical `transferId` immediately after the RCON response — before it
   begins waiting for export-complete** — so a controller restart in the export window doesn't lose the transfer
   intent. (Today the controller instead mints its own id after export-complete, so that window is unprotected.)
2. **Destination hold primitive (audit P0-2).** A staged dest must be provably **not-live** between
   final-validation and GO-LIVE: no simulation, crafting, fluid/item consumption, cargo launch, movement, or
   player access — AND without diverging from or losing the just-validated snapshot. `set_surface_hidden` alone is
   NOT enough (it hides but may not stop the sim); `platform.paused` may not freeze entity processing; and
   `entity.frozen` detaches from fluid segments (Pitfall #17), risking the just-restored fluids. **Spike it live:**
   find the exact combination (paused + hidden? a fluid-preserving re-freeze with a GO-LIVE unfreeze?) that halts
   all processing while preserving fluids, proven with physical `get_item_count`/fluid + entity-active +
   surface-hidden assertions across the hold window. **HARD BLOCKER (R3):** Phase 2 does not start until a hold
   primitive with ALL of these properties is proven — (a) *non-live*: no sim/craft/consume/move/cargo-launch/
   player-access; (b) *fidelity-preserving*: items AND fluids identical to the validated snapshot for the whole
   hold; (c) *losslessly reversible*: GO-LIVE reveals with zero fallible restoration. **Rejected fallbacks:**
   deferring fluid restoration to GO-LIVE (reintroduces the exact "source deleted before fallible dest
   finalization" flaw R1/P0-1 removed) and dummy-surface clone/teleport (space platforms are bound to their
   surface — speculative + high-risk). If no primitive satisfies (a)-(c), the staging model is reconsidered before
   Phase 2 — a convenient-but-unsafe fallback is not acceptable.

## Phase 2 — full phase-aware 2PC (closes the dup window + the Phase-1 corner)
Adds the durable COMMIT signal to the source (failsafe becomes phase-aware: `pre_commit`→unlock,
`committed`→delete) + destination **staging** (hold-not-live until go-live) + the handshake. Re-sequences today's
*dest-live-then-source-delete* into *source-delete-then-dest-go-live*.

Protocol (controller routes all; instances never talk directly):
`PREPARE (ImportPlatformRequest)` → `VOTE (TransferValidationEvent: success=staged+validated / fail=abort)` →
`COMMIT (extend DeleteSourcePlatformRequest: flip phase=committed FIRST, then evacuate+delete)` → `RELEASED (ack)`
→ `GO-LIVE (new ReleaseStagedPlatformRequest; discard sibling for abort)`.

- **The dest VOTE means FULLY finalized, not just item-validated (audit P0-1 — the load-bearing correction).** ALL
  fallible fidelity work must complete BEFORE the dest votes `staged_validated`, so COMMIT (source delete) can
  never race a later restoration failure. Dest sequence: import (deactivated/paused/hidden) → item-validate
  (pre-activation, Pitfall #15) → activate (`ActiveStateRestoration.restore`) → restore fluids (post-activation,
  Pitfall #17) → fluid-validate + loss adjust → gateway park (if any) → **only now** vote `staged_validated`,
  holding the finished platform **not-live**. This moves the *whole* fallible block (`import-completion.lua`
  ~460-555) to run BEFORE the vote — NOT into GO-LIVE. Hold mechanism: keep the surface hidden; and pause to
  preserve the validated snapshot — **verify re-pause preserves the just-restored fluids** (`platform.paused` ≠
  `entity.frozen`, so it should, but this is a real risk to confirm; if not, hold via a mechanism that neither
  diverges the snapshot nor drops fluids).
- **GO-LIVE = non-fallible reveal ONLY:** `set_surface_hidden(false)` + unpause (the platform is already fully
  restored + validated). DISCARD deletes the staged copy. Dest failsafe = **HOLD + re-announce only** (never
  autonomously go-live or discard — the 2PC blocking case); the controller resolves by reading the source's phase.
- Source lock gains `phase` + a `set_committed` durable flip; `scan_transfer_expiries` becomes phase-aware
  (`pre_commit`→unlock, `committed`→delete).
- **COMMIT handler (`delete-platform-for-transfer.lua`) — idempotent, phase-first, NO unlock-first (audit P1-5):**
  flip `phase=committed` as the first durable act, then evacuate+delete; do NOT unlock-first (today's 38-40 bug).
  Explicit idempotency for controller retries + restart reconciliation: repeat COMMIT on an already-gone matching
  source → return success/released; on `phase=committed` (a prior delete failed) → retry the delete; the
  name/surface/index tripwires remain on every call. On delete failure leave `committed` set so the source's own
  failsafe also retries. **`committed` is IRREVERSIBLE (R3):** once a lock is `committed`,
  `SurfaceLock.unlock_platform`, `/unlock-platform`, `/resume-platform`, AND the tick-expiry unlock branch MUST all
  REFUSE it — only delete can clear a `committed` lock. That refusal is what makes `committed` a safe non-live
  tombstone (Gate B) and lets GO-LIVE fire on `committed` without risking a revived source.
- **Controller must NEVER DISCARD after transmitting COMMIT (R3).** A COMMIT that times out or errors is
  **ambiguous** — it may have landed (source `committed`/gone) or not. Treating a COMMIT timeout as failure and
  issuing DISCARD to the dest would violate the 2PC (dest discards while the source deleted = total loss). Rule:
  once the controller has sent COMMIT for a transfer, its only compensatory moves are **query the source phase /
  tombstone (`GetSourceTransferLockStateRequest`) and retry COMMIT, or HOLD** — never DISCARD on a timeout/error.
  DISCARD is reachable ONLY from a confirmed `pre_commit` (the dest never got a COMMIT). This forbids the naive
  `catch → discard` that produced #106's data-loss class.
- **Source-phase read API + committed tombstone (audit: source-phase existence + P1-3 distinct states).** Add a
  `GetSourceTransferLockStateRequest` controller→source remote whose result **distinguishes ALL of**: `pre_commit`
  lock · `committed` lock · `source_gone_matching_transfer` · `unknown`/offline · `index_reused_or_name_mismatch`
  — NOT just `{found}`. Because COMMIT deletes the lock entirely, a bare "not found" is ambiguous
  (deleted-for-this-transfer vs a reused index / unrelated platform). So COMMIT also writes a small durable
  **committed tombstone** keyed by the canonical transfer id (`storage.surface_export_committed[transfer_id] =
  {tick}`); the read API returns `source_gone_matching_transfer` only when the tombstone matches (authoritative
  GO-LIVE), else `unknown` (**never infer commit from absence**). Name/surface/index tripwires apply. The
  controller feeds this into the repurposed pure `resolvePendingTransfer` → GO-LIVE (committed/gone) / DISCARD
  (`pre_commit`/unlocked) / HOLD (unknown/offline). Without it a restarted controller can't safely unblock a held
  dest.
- New message `ReleaseStagedPlatformRequest` (go-live/discard) + `instance.ts` handler — **idempotent (audit
  P1-4):** a repeat GO-LIVE on an already-live transfer returns success; a repeat DISCARD on an already-discarded
  returns success; a contradictory action (go-live after discard, or vice-versa) FAILS loudly unless the source
  phase proves the opposite. `handleValidationSuccess` re-sequences to COMMIT → await source-gone → GO-LIVE.

Failure-mode guarantee: D never goes live except via GO-LIVE, issued only on a confirmed source state of **`gone`
or irreversible `committed`** (Gate B) ⇒ no both-live; S enters `committed`/deletes only after D's staged-validated
vote (Gate A) ⇒ no both-gone. Tick-based expiry means source-host downtime never over-counts.

### Failure-mode table (Phase 2, restart/crash at each step)
Legend: **S**=source, **D**=dest, **C**=controller; source lock phase in braces. The decisive fact is S's phase.

| # | Point of failure | S failsafe | D failsafe | C on restart | Invariant preserved |
|---|---|---|---|---|---|
| 1 | S locked {pre_commit}, before/during export or PREPARE | expiry → **UNLOCK** | nothing staged | re-drive or let S self-unlock | Only S exists (locked); D holds nothing. |
| 2 | D crashes mid-import (`staging`) | {pre_commit} → **UNLOCK** | no validated copy → discard | ABORT: unlock S, discard D | D never had a good copy. |
| 3 | D `staged_validated`, VOTE lost / C down before COMMIT | {pre_commit} → **UNLOCK** | HOLD (not live); re-announce | query S phase = pre_commit ⇒ **DISCARD** D | S live (rolled back), D only staged ⇒ not both-live. |
| 4 | C sent COMMIT; S {committed}, delete **fails/errors persistently** | {committed} → **DELETE** (retry); stays a frozen, unrevivable non-live tombstone | HOLD → **GO-LIVE** | query S = committed ⇒ **GO-LIVE D immediately** (R3 — do NOT wait for gone) | committed = irreversible non-live ⇒ D live + S tombstone = not both-live; dest never held hostage to source cleanup. |
| 5 | S {committed}→deleted, RELEASED ack lost, C down before GO-LIVE | (done) | HOLD; re-announce | query S = gone ⇒ **GO-LIVE** D | S gone + D staged(not live) ⇒ D holds copy, not both-gone. |
| 6 | GO-LIVE lands; D crashes mid-activate | (S gone) | idempotent re-run of GO-LIVE | GO-LIVE idempotent → re-send | Only D exists. |
| 7 | Race: COMMIT vs S {pre_commit} expiry | if UNLOCK first: COMMIT finds no matching-`transfer_id` lock → **REFUSE** delete; if COMMIT first: expiry no-op | HOLD | refused COMMIT ⇒ **DISCARD** D | `transfer_id` match key prevents deleting a rolled-back live source. |
| 8 | S-host down long mid-transfer | ticks don't advance while down ⇒ no spurious expiry | HOLD | waits, then per S phase on return | Tick-based ⇒ downtime never over-counts. |

## Disposition of the #60 branch
- **Discard (the destructive spine):** the controller boot reconcile loop/timer + auto-action
  (`controller.ts` ~787-913), `resolveStrandedTransfer` "complete" branch (auto-delete on restart,
  `transfer-orchestrator.ts` ~85-116), and the dest-outcome-query-**as-failsafe** (`GetTransferOutcomeRequest`,
  `get-transfer-outcome.lua`, `handleGetTransferOutcome`, the `transfer_outcomes` store) insofar as they exist to
  drive an auto-delete.
- **Keep (cheap, non-destructive, reused by Phase 2):** `PendingTransferIntent` persistence + load/persist/remove
  (controller-side observability + re-adoption record, not a failsafe — cannot lose data); and the pure
  `lib/transfer-reconciliation.ts` `resolvePendingTransfer` — **repurposed** so its (exhaustively tested,
  never-destructive-on-ambiguity) decision drives the **dest** go-live/discard keyed off the **source's phase**
  instead of a dest self-report.

## Manual-lock safety & migration
- Discriminator: only the transfer path stamps `kind="transfer"`; the expiry scan acts only on `kind=="transfer"`,
  so `/lock-platform` admin locks are never auto-touched. Absent `kind` (old save / manual) ⇒ skip (safe default).
- Nil-guard every new field. Absent `phase` ⇒ treat as `pre_commit` (conservative: unlock, never delete). Absent
  `expires_tick` ⇒ fall back to `locked_tick + DEFAULT_TTL`; absent `locked_tick` too ⇒ skip (never error).
- Init `storage.surface_export_staged = {}` and `storage.surface_export_committed = {}` (the committed tombstone
  store) in `initialize_storage` (`control.lua` 28-36). Prune the tombstone store by age (bounded, generously
  longer than the reconciliation window) so it can't grow unbounded — but never evict a tombstone while its
  transfer could still be queried (retention ≫ TTL + any dest-hold window).
- A transfer airborne *exactly across the deploy* has a pre-upgrade lock with no `kind` → degrades to today's
  behavior (manual `/unlock-platform`). Acceptable.

## Critical files
`module/utils/surface-lock.lua` · `module/core/control.lua` · `module/core/transfer-trigger.lua` ·
`module/core/export-pipeline.lua` · `module/core/import-completion.lua` ·
`module/interfaces/remote/delete-platform-for-transfer.lua` · `module/interfaces/remote/export-platform.lua` ·
`lib/transfer-orchestrator.ts` · `controller.ts` · `messages.ts` · `instance.ts`.

## Verification
- **Phase 1 (headless):** Lua invariant lint + `npm test`. New RCON-callable pure Lua selftest for
  `scan_transfer_expiries`: (a) a `kind="transfer"` lock past `expires_tick` → unlocked; (b) a manual lock (no
  `kind`) → untouched; (c) an old-save lock lacking `expires_tick`/`locked_tick` → no error, skipped;
  (d) TTL > worst-case transfer duration. **Live:** start a transfer, `docker restart` the controller during
  `awaiting_validation`, confirm the source auto-unlocks itself after the TTL (no admin action) and a normal
  transfer is unaffected. Run `/di-change` (source-delete/rollback path).
- **Phase 2 (headless + live):** message round-trip auto-covers the new `ReleaseStagedPlatformRequest`; a staged
  round-trip integration test (import → staged/not-live → go-live) grounded in physical `get_item_count` +
  entity/surface-hidden checks; adversarial tests per failure-mode row (crash after COMMIT-before-GO-LIVE →
  dest holds then goes live; crash pre-commit → source unlocks + dest discards). `/code-review` (Opus) + `/di-change`
  before merge; a live controller-restart-at-each-step matrix.
- Apply the session's `verified-the-easy-part` lesson throughout: the risky states are the *stateful* failsafes —
  test those directly (not just the pure decision core), and equivalence-diff any reused path.
