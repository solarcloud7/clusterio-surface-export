# Plan — PR-3: Phase-2 Two-Phase-Commit Protocol Wiring & Reconcile Loop

> Provenance: authored + approved 2026-07-08 in-session; rescued into the repo 2026-07-08 (the session plan file
> was later overwritten by the empirical-test-suite plan — this doc is now the source of truth for PR-3).
> Execution gates: **#76 (composite verdict V1) must merge first** (VOTE emits its verdict object, amendment A6),
> and the `lint-allow-manifest` guard should land first. Companion: the boundary/UX decisions live in
> `2026-07-06-phase-2-ux-decision.md`; the parent roadmap in `2026-07-06-phase-2-implementation-plan.md`.

## Context

Phase 2 re-sequences a cross-instance transfer from today's *dest-live-then-source-delete* (a duplication
window) into a durable handshake — **`PREPARE → VOTE → COMMIT → RELEASED → GO-LIVE`** — so the destination copy
is never live before the source has committed and released, and an unfinished handshake discards the destination
artifact by a deadline. The contract is **NO DUPLICATES** (`docs/TRANSFER_2PC.md`). This is the riskiest PR of
the phase (the destructive spine) and the pattern that produced 16 review defects on #106 — every one in the
stateful integration, none in the pure core.

**The key finding from mapping the code: PR-2 (#75) already shipped the entire parts list; nothing wires it in.**
PR-3 supplies three missing verbs and the driver:
- **No controller caller** of `GetSourceTransferLockStateRequest` — the instance answers, the controller never asks.
- **`SurfaceLock.commit_source_transfer_lock` is uncalled** in production Lua (the phase never flips to `committed`,
  so every committed-guard — unlock/resume/TTL refuse — is presently dead).
- **`recordCommitTransmitted` is uncalled** on the controller (write-ahead COMMIT marker store exists, dormant).
- **`DestinationHold.stage/go_live/discard`** (Lua) has **zero TS wiring** and is "intentionally not wired into
  the normal transfer path yet."
- **No reconcile driver:** `onStart` only prunes + warns; there is no boot re-adoption and no periodic loop.

So PR-3 is **mostly wiring pre-built primitives** behind a controller state machine + a source-phase-driven
reconcile loop — not new mechanism.

Base dir (Lua): `docker/seed-data/external_plugins/surface_export/module/` · (TS): `docker/seed-data/external_plugins/surface_export/`

## Invariants this rests on (from `docs/TRANSFER_2PC.md`, all DECIDED)
Gate A (source deleted only after a durable signal the dest holds a validated copy) + Gate B (dest goes live only
after source `gone`/`committed`); source failsafe **unlock-only**, dest failsafe **discard-only**. VOTE = **fully
finalized** (both gates passed, held not-live). `committed` = irreversible non-live tombstone (only delete clears
it). **Handshake-or-discard**: bounded compensation window, then unconditional dest discard — **no force-resolve,
no admin console**. Identity keys on `surface.index` / unique index + canonical transfer id, **never
`platform.name`**. Controller routes all; instances never talk directly.

---

## 1. Lua — VOTE (stage-not-live), COMMIT flip, GO-LIVE / unified DISCARD

**1a. PREPARE + VOTE — hold instead of go-live** (`core/import-completion.lua` `run_phase2`, and the transfer
import entry so it sets a `job.hold_for_transfer` flag). When the flag is set, after the fluid gate PASSES,
replace the go-live + gateway-park block with `DestinationHold.stage(job.transfer_id, platform, force)`
(`core/destination-hold.lua`) and emit the existing `surface_export_import_complete` event — which is now the
**VOTE** — carrying the already-computed composite verdict (`event_payload.success`,
item+fluid+`failedStage`+metrics). The platform stays paused, hidden, deactivated.
- **Unify Q9 (both gate failures self-discard the dest).** In the transfer/hold path, on EITHER an item-gate
  failure (today leaves a deactivated corpse) OR a fluid-gate failure (already discards), delete the
  just-imported destination via `GameUtils.delete_platform` and VOTE `success=false`. So a failed VOTE always
  means the dest is already gone — the controller's abort path only unlocks the source. Non-transfer/upload
  imports keep today's go-live behavior (flag off).

**1b. COMMIT — flip the source lock to `committed`** (new source-side remote wrapper, e.g.
`interfaces/remote/commit-source-transfer.lua`, registered in `interfaces/remote-interface.lua`). Calls the
existing **`SurfaceLock.commit_source_transfer_lock(platform_index, transfer_id)`** (`utils/surface-lock.lua`) —
which already guards `kind=="transfer"` + job-id match, flips `phase="committed"`, and records the tombstone.
This is a **distinct durable step before delete** so a crash between flip and delete is recoverable as
`committed`. No delete here.

**1c. RELEASED — reuse the existing source-delete.** `DeleteSourcePlatformRequest` → the sole
`delete-platform-for-transfer.lua` already branches on `source_lock_is_committed` and calls
`clear_committed_source_lock_after_delete` (stamps `source_deleted_tick` → query later returns
`source_gone_matching_transfer`). Once 1b flips the lock, that branch — dead today — goes live. Identity gate
(`transfer_delete_identity_ok`, surface.index + job-id) unchanged.

**1d. GO-LIVE / DISCARD — reuse the primitives** (new dest-side remote wrappers over
`DestinationHold.go_live(transfer_id)` and `DestinationHold.discard(transfer_id)`, both keyed by transfer id,
tolerant of a missing platform). GO-LIVE restores active states + original hidden/paused and clears the hold;
DISCARD deletes the held platform + clears the hold.

**Lua lint:** new code in the delete/lock/commit spine keys on `surface.index`/index, never name
(`no-name-as-transfer-identity`); every new `pcall` surfaces via `GameUtils.pcall_warn` (`lint:pcall-logging`);
route all platform teardown through `GameUtils.delete_platform` (`no-platform-destroy`, Pitfall #19).

**Reconcile with #76.** The V1 remediation added `quarantine_destination_after_discard_failure` in
`core/import-completion.lua` — a manual `paused=true` + `set_surface_hidden(true)` + `active=false` mini-hold on
the discard-failure path. That is an ad-hoc duplicate of `DestinationHold.stage`. PR-3 should route that path
through `DestinationHold` + the reconcile loop's discard gates so there is ONE quarantine owner, not two parallel
mechanisms.

## 2. Messages — 3 new + 1 flag (`messages.ts`, register in `index.ts`, round-trip auto-covered)
- **`CommitSourceTransferRequest`** (controller → instance-source): `{ transferId, platformIndex, platformName, forceName }`.
- **`GoLiveDestinationRequest`** (controller → instance-dest): `{ transferId }`.
- **`DiscardDestinationRequest`** (controller → instance-dest): `{ transferId }`.
- **`holdForTransfer: boolean` flag on `ImportPlatformRequest`** — carries PREPARE without a new blob-carrier.
- **Reused as-is:** `TransferValidationEvent` (VOTE), `DeleteSourcePlatformRequest` (RELEASED),
  `GetSourceTransferLockStateRequest` (query — PR-3 adds the caller), `UnlockSourcePlatformRequest` (abort).
- Add `lua-interface.ts` bindings for the 3 new remote calls; add instance handlers wiring them to the Lua remotes.

## 3. TS controller — the 5-phase state machine (`lib/transfer-orchestrator.ts`, `instance.ts`)
Rewrite the validation-success tail (`handleValidationSuccess`) from *delete-source immediately* into the ordered
handshake. Extend `ActiveTransfer` with a `phase` (`preparing|voted|committing|released|going_live|done`).
- **PREPARE:** `transferPlatform` sends `ImportPlatformRequest{ holdForTransfer:true }`; dest imports + stages held.
- **VOTE:** dest emits `TransferValidationEvent` (held). `handleTransferValidation` branches on `event.success`:
  - **success →** `recordCommitTransmitted(transferId)` write-ahead → `CommitSourceTransferRequest` (COMMIT) →
    `DeleteSourcePlatformRequest` (RELEASED; await confirm) → `GoLiveDestinationRequest` (GO-LIVE) →
    `status:"completed"`, `removePendingTransfer`, delete blob.
  - **failure →** `DiscardDestinationRequest` (idempotent; dest already self-discarded per 1a) + `tryUnlockSource`
    (source still `pre_commit` ⇒ unlock-only) → `status:"failed"`.
- Gate B holds by construction: the dest goes live only in the last step.
- Metrics unchanged: everything funnels through `updateTransfer` → `emitTransferUpdate` →
  `recordOperationOutcome`. Widen `TERMINAL_RESULT`/`failure_stage` only if a new terminal outcome (e.g.
  `deadline_discard`) is added — never count at a new site.

## 4. Reconcile loop — source-phase-driven, deadline-bounded (`controller.ts`, pure core restored)
**Restore the pure decision core.** `resolvePendingTransfer(inputs) → { kind:"complete"|"unlock"|"retry"|"escalate" }`
survives only as the `dist/node/lib/transfer-reconciliation.js` orphan (source `.ts` deleted in #64). Recreate
`lib/transfer-reconciliation.ts` from it, re-scoped to **handshake-or-discard**, as a **pure function** of
`(sourcePhase, commitTransmitted, deadlinePassed)` — this is where the risky logic is exhaustively unit-tested.

**The driver** (reuse `pendingTransfers`; `PendingTransferIntent` already carries the query inputs):
- **Boot re-adoption** in `onStart` (today prune+warn only): for each surviving intent, send
  `GetSourceTransferLockStateRequest`, apply `resolvePendingTransfer`.
- **Periodic timer** armed in `onStart`, cancelled in `onShutdown`.
- **Recovery table** (mirrors `docs/TRANSFER_2PC.md`), by source phase: `pre_commit` + never-committed → **abort**
  (discard dest, unlock source); `committed` → **roll forward** (retry RELEASED, then GO-LIVE);
  `source_gone_matching_transfer` → **roll forward** (GO-LIVE); `unknown/offline` → **retry later** (transport
  state, never act); `identity_mismatch` → **discard dest**. Bounded backoff.
- **Two discard gates:** immediate-abort discard **only** when this controller never transmitted COMMIT (marker
  absent) **and** source queried `pre_commit`; **deadline discard** once the compensation window expires
  (unconditional — handshake-or-discard).

**Naming / retirement-test constraint:** the loop must NOT be the retired #60 destination-outcome spine.
`no-controller-auto-delete.test.cjs` forbids `reconcilePendingTransfers`, `GetTransferOutcomeRequest`, and a
restart-`complete` auto-delete branch. Name the driver differently (e.g. `adoptPendingTransfers`/`driveHandshake`),
keep it **source-phase-query-authoritative** (the commit marker is hygiene, never the gate), and **update that
test in the same reviewed di-change** to permit the new safe loop while still forbidding the old auto-delete.

## 5. Deadline constants
Define `HANDSHAKE_COMPENSATION_DEADLINE_MS`; must be **< committed-tombstone retention** (39000 ticks ≈ 10.8 min,
so the tombstone still resolves `source_gone_matching_transfer` at discard time) and generous enough to survive a
destination `docker restart` (~30-60 s). Proposed ≈ 5 min — **boundary question for the agent**.

## 6. Tests & teeth (di-change gates; physical grounding)
- **Pure core:** recreate `test/transfer-reconciliation.test.cjs` (`package.json` still lists it — `npm test`
  currently errors on the missing file) and exhaustively unit-test `resolvePendingTransfer` across all 5 states ×
  commit-marker × deadline.
- **Selftest teeth:** extend `transfer-lock-selftest.lua` for the `commit` transition and
  `source_gone_matching_transfer`.
- **Integration sections** (mirror `tests/integration/destination-hold` section-selection; reuse
  `tests/lib/TestBase.psm1` `Get-PlatformIndex` for physical no-both-live; `get_item_count` for fidelity):
  1. **happy path** — full handshake; physical no-both-live: source index `null` AND dest present after GO-LIVE.
  2. **controller-restart re-adoption** — restart mid-handshake; the source-phase query drives resume; no dup.
  3. **abort discard** — VOTE failure (arm `test_force_validation_failure` as `tests/integration/rollback` does) →
     dest discarded + source preserved.
  4. **deadline discard** — handshake never completes → dest discarded at the deadline; source unlock-only.
  - Physical no-both-live assertion (`Get-PlatformIndex` on BOTH instances) after EVERY scenario.
  - Section-selectable; cheap fixtures for debugging; restart sections in final passes only; zero-leftover
    assertion (`destination_holds`, `locked_platforms`, `committed_source_transfer_tombstones`, `desthold-*`
    surfaces, `game.tick_paused==false`).
- **Update `no-controller-auto-delete.test.cjs`** as above (reviewed).
- **Gates:** `/di-change`; all four Lua/test lints; `npm test`; `node --test test/destination-hold.test.cjs`;
  `/code-review` at authoring (not just merge).

## 7. Docs (same PR)
`docs/TRANSFER_2PC.md` planned→implemented for the wired parts; `docs/ENGINEERING_FAQ.md` row ("What happens if
the controller restarts mid-transfer?"); CLAUDE.md/AGENTS.md one-line addendum. Deploy boundary:
`patch-and-reset` wipes saves → no in-flight-across-deploy support; deploy cluster-wide at a boundary.

## Boundary questions for the agent (raise BEFORE coding)
1. **Message decomposition** — 3 new messages + `holdForTransfer` flag vs folding COMMIT+GO-LIVE (plan recommends
   the 3+flag split — one verb per message).
2. **Deadline value** — `HANDSHAKE_COMPENSATION_DEADLINE_MS` (proposed ≈ 5 min; < 39000-tick tombstone retention).
3. **Restore vs. rewrite** `resolvePendingTransfer` — plan recommends restoring from the dist orphan, re-scoped.
4. Any DI-lint firing on your change = **escalate to the orchestrator, never self-approve an `*:allow`**.

## Files touched
Lua: `core/import-completion.lua` (hold-not-live + Q9 unify) · `core/destination-hold.lua` (reuse) ·
`utils/surface-lock.lua` (reuse commit/tombstone/query) · `interfaces/remote/delete-platform-for-transfer.lua`
(committed branch now live) · new `interfaces/remote/commit-source-transfer.lua` / `go-live-destination.lua` /
`discard-destination.lua` · `interfaces/remote-interface.lua` · `interfaces/remote/transfer-lock-selftest.lua`.
TS: `lib/transfer-orchestrator.ts` · `controller.ts` (driver + timer + caller) · `instance.ts` (3 handlers +
hold flag) · `messages.ts` + `index.ts` · `lib/lua-interface.ts` · new `lib/transfer-reconciliation.ts` ·
`lib/metrics.ts` (only if new terminal outcome) · `package.json` (fix stale test slot).
Tests: `test/transfer-reconciliation.test.cjs` (restore) · `test/no-controller-auto-delete.test.cjs` (update) ·
new `tests/integration/transfer-2pc/` (4 sections) · selftest.
Docs: `docs/TRANSFER_2PC.md` · `docs/ENGINEERING_FAQ.md` · CLAUDE.md/AGENTS.md.

## Verification (end-to-end)
```powershell
# container: npm run lint (lua/pcall/test-grounding/test-hooks) ; npm test ; node --test test/transfer-reconciliation.test.cjs test/destination-hold.test.cjs
# patch-and-reset (Lua changed), then focused sections (cheap fixtures; restart section last):
node tools/run-integration-tests.mjs --only 'transfer-2pc|rollback|destination-hold'
# happy path: one real transfer end-to-end -> source index null + dest present (no both-live) + get_item_count fidelity
# restart: docker restart controller mid-handshake -> source-phase query resumes -> no dup
# abort: arm test_force_validation_failure -> VOTE fail -> dest discarded + source preserved
# deadline: block the handshake -> dest discarded at deadline -> source unlock-only
```
Then: `/di-change` in the PR body · boundary-questions answered before coding · audit + a fresh `/code-review`
reconciled against HEAD · CI green · squash merge · post-merge main run watched · PR-4 (observability) follows.
