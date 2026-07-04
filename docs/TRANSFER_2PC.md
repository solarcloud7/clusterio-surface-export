# Cross-instance transfer: durability, identity, and two-phase commit

Single source of truth for how a cross-instance platform transfer stays safe under restarts, crashes, renames,
and concurrency. Supersedes and replaces the former `TRANSFER_2PC_DESIGN.md`, `TRANSFER_2PC_PHASE1_AUDIT.md`, and
`TRANSFER_2PC_PHASE1_REAUDIT.md` (design spec + two point-in-time audits — folded into "current state" below).

Related: CLAUDE.md Pitfalls #15/#16/#28/#29/#30/#31, [ENGINEERING_FAQ.md](ENGINEERING_FAQ.md) (per-scenario
behavior), [TRANSFER_WORKFLOW_GUIDE.md](TRANSFER_WORKFLOW_GUIDE.md).

## The core invariant
The **source** platform is the at-risk resource. One rule governs everything: **never delete the source unless a
validated copy exists on the destination AND the source is still the exact frozen platform we exported.** When
forced to choose, a **recoverable duplicate or stuck-lock always beats an unrecoverable deletion.**

Two gates express it:
- **Gate A (never both gone):** the source is deleted only after a durable signal that the destination holds a
  validated copy.
- **Gate B (never both live):** the destination goes live only after the source is confirmed gone or in an
  irreversible non-live state.

## Identity: `surface.index` / unique index, never `platform.name` (enforced)
Every transfer/lock/delete identity decision keys on the **stable** `surface.index` (recorded in the lock record
at lock time) or the unique per-force `platform.index`. `platform.name` is a mutable, non-unique display label — a
player can rename a platform mid-transfer from the hub GUI, and two platforms can share a name. Keying a
**destructive** decision on the name was a duplication exploit (rename mid-transfer → name-based delete check
false-refused → source survived + dest committed = two copies).

- The source-delete gate reads `lock.surface_index` (before the best-effort unlock clears it) and compares it to
  the current `platform.surface.index` via the pure `SurfaceLock.transfer_delete_identity_ok(lock, surface)`. A
  rename is ignored (same surface ⇒ same platform ⇒ proceed); a released or index-reused lock is refused.
- A user-supplied NAME is resolved to an index ONLY at the admin tooling boundary, failing loud on ambiguity
  (`SurfaceLock.find_lock_key_by_name`).
- **Mechanically enforced:** `npm run lint:lua` rule `no-name-as-transfer-identity` fails on `platform.name` /
  `platform_name` used in an `==`/`~=` comparison within the delete + lock spine. See CLAUDE.md Pitfall #31.
- Still name-keyed (lower-risk, follow-up): the dest-side `storage.validation_results[platform_name]` store and
  `platform_flight_data[platform.name]` — a name collision there cross-wires or loses a record.

## Phase 1 — source-side durable expiry (SHIPPED)
The failsafe lives where the at-risk resource lives: the source instance's own Factorio save, driven by game
ticks (which do not advance while the host is down). Non-destructive by construction — it **only ever unlocks,
never deletes**.

- The transfer lock carries `kind="transfer"` + `expires_tick` (+ the export `job_id`), stamped at the universal
  lock path (`ExportPipeline.queue` whenever a `destination_instance_id` is present) and at the in-game
  `transfer-trigger`. Manual `/lock-platform` locks are kind-less and are never auto-touched.
- `SurfaceLock.scan_transfer_expiries()` runs from `on_tick` (throttled `game.tick % 60 == 0`): for each
  `kind="transfer"` lock past `expires_tick` (fallback `locked_tick + DEFAULT_TRANSFER_LOCK_TTL_TICKS`), it calls
  `unlock_platform`. Old-save locks lacking timing data are skipped; every new field is nil-guarded.
- TTL: `DEFAULT_TRANSFER_LOCK_TTL_TICKS = 36000` (10 min at 60 UPS), sized to exceed the worst-case TOTAL
  transfer duration (export scan + chunked RCON + import + validation + margin), asserted `>=`
  `MIN_WORST_CASE_TRANSFER_TTL_TICKS`.
- The controller keeps a bounded, age-pruned `pendingTransfers` record for **observability + future Phase-2
  re-adoption only**. It never auto-deletes or auto-unlocks on boot. The former #60 controller boot-reconcile /
  auto-delete-on-a-guess spine is removed.
- Fixes the original restart-stranding (#106): a controller restart during `awaiting_validation` no longer leaves
  the source locked-and-hidden forever — the source self-heals after the TTL.

**Known Phase-1 corners (documented, recoverable):**
- A transfer whose whole pipeline exceeds the TTL (~10 min) self-unlocks mid-flight. The delete gate then refuses
  to delete the now-live source (Gate A / identity refuse-if-not-locked), yielding a recoverable duplicate rather
  than deleting a live platform. Phase 2's heartbeat + canonical id eliminate the mid-flight unlock.
- A stranded-then-committed transfer's stored export can linger in the Exports tab and be re-imported into an
  extra copy (Phase 1 cannot know the dest committed, so it cannot safely delete the export). Resolved in Phase 2.
- A transient EXPORT/file lock is kind-less (no TTL); a crash mid-export strands it until manual `/unlock-platform`
  (no data loss — export deletes nothing). Follow-up: give transient export locks their own expiring kind.

## Phase 2 — full phase-aware 2PC (PENDING; do not start until prerequisites are proven)
Adds a durable COMMIT signal on the source (its lock gains a `phase`: `pre_commit → committed`) plus destination
**staging** (hold-not-live until go-live), re-sequencing today's *dest-live-then-source-delete* into
*source-commit → source-delete → dest-go-live*. This closes the duplication window and the Phase-1 corners.

Protocol (controller routes all; instances never talk directly):
`PREPARE (import, deactivated/hidden) → VOTE (staged + FULLY finalized, all fallible fidelity work done before the
vote) → COMMIT (flip phase=committed FIRST, then evacuate + delete) → RELEASED → GO-LIVE (reveal + unpause;
DISCARD the sibling on abort)`.

Load-bearing rules (each is a hard constraint, not a preference):
- The dest VOTE means **fully finalized**, not just item-validated: import → item-validate (pre-activation,
  Pitfall #15) → activate → restore fluids (post-activation, Pitfall #17) → fluid-validate → gateway park → only
  then vote, holding the finished platform not-live. COMMIT can never race a later restoration failure.
- `committed` is an **irreversible non-live tombstone**: every unlock/resume/expiry path REFUSES a `committed`
  lock; only delete clears it. GO-LIVE fires on source state `gone` OR `committed`.
- The controller must **never DISCARD after transmitting COMMIT** — a COMMIT timeout is ambiguous (may have
  landed); compensation is query-source-phase + retry-COMMIT or HOLD, never DISCARD. DISCARD is reachable only
  from a confirmed `pre_commit`.
- New `GetSourceTransferLockStateRequest` distinguishes ALL of: `pre_commit` · `committed` ·
  `source_gone_matching_transfer` (via a durable committed tombstone keyed by the canonical transfer id) ·
  `unknown/offline` · `index_reused_or_name_mismatch` — never infer commit from absence.

**Phase-2 prerequisites (spike + prove BEFORE implementing):**
1. **Canonical transfer id.** One id shared across source-lock → dest-stage → COMMIT → GO-LIVE → tombstone. It
   MUST originate at the source (the in-game path has no controller at lock time); the controller adopts the
   export's source-generated id and persists it before awaiting export-complete.
2. **Destination hold primitive.** A staged dest must be provably not-live (no sim/craft/consume/cargo-launch/
   movement/player-access) AND fidelity-preserving (items + fluids identical to the validated snapshot) AND
   losslessly reversible on go-live. `set_surface_hidden` alone doesn't stop the sim; `entity.frozen` detaches
   fluid segments (Pitfall #17). Prove the exact combination live before Phase 2 starts.

### Failure-mode table (restart/crash at each step)
Legend: **S**=source, **D**=dest, **C**=controller; `{}` = source lock phase (Phase 2). The decisive fact is S's phase.

| # | Failure point | S failsafe | D failsafe | C on restart | Invariant |
|---|---|---|---|---|---|
| 1 | S locked {pre_commit}, before/during export | expiry → UNLOCK | nothing staged | let S self-unlock | only S exists |
| 2 | D crashes mid-import | {pre_commit} → UNLOCK | no validated copy → discard | ABORT | D had no good copy |
| 3 | D staged_validated, VOTE lost / C down before COMMIT | {pre_commit} → UNLOCK | HOLD; re-announce | query S=pre_commit ⇒ DISCARD D | S live, D staged ⇒ not both-live |
| 4 | C sent COMMIT; S {committed}, delete errors persistently | {committed} → DELETE (retry); frozen tombstone | HOLD → GO-LIVE | query S=committed ⇒ GO-LIVE D | committed = non-live ⇒ not both-live |
| 5 | S deleted, RELEASED lost, C down before GO-LIVE | (done) | HOLD; re-announce | query S=gone ⇒ GO-LIVE D | S gone + D staged ⇒ not both-gone |
| 6 | GO-LIVE lands; D crashes mid-activate | (S gone) | idempotent re-run | GO-LIVE idempotent | only D exists |
| 7 | Race: COMMIT vs S {pre_commit} expiry | UNLOCK-first ⇒ COMMIT finds no matching id → REFUSE | HOLD | refused COMMIT ⇒ DISCARD D | id match prevents deleting a rolled-back live source |
| 8 | S-host down long mid-transfer | ticks don't advance ⇒ no spurious expiry | HOLD | per S phase on return | tick-based ⇒ downtime never over-counts |

## Current implementation status
- **Shipped:** Phase 1 source-side TTL (unlock-only) + identity gate (surface.index + a name-free `job_id`
  request↔lock correlation) + cargo-pod awaiting_launch zero-loss recovery. The #60 controller auto-delete spine
  is removed; `resolvePendingTransfer` is retained pure and dormant for Phase-2 reuse. Re-audit hardening R1–R8
  shipped (`feat/106-hardening`): in-game double-transfer refuse guard, expiry-scan failure counter, derived TTL
  floor, order-independent + timer-spy test teeth, stale-comment cleanup.
- **Follow-ups:** dest-side `validation_results` / `flight_data` re-key off name (collision); the descending/
  parking cargo-pod branch does not spill a hub-overflow remainder like `awaiting_launch` does — a potential
  loss IF `force_finish_descending` discards it, needs a live test before generalizing (avoid a double-deposit);
  a full controller/web-route behavior test for the double-transfer reject (the decision is unit-tested via
  `is_same_transfer_upgrade`; the in-game route is live-verified). The mid-flight TTL self-unlock on a >10-min
  transfer (delete gate makes it a recoverable dup, not loss) is eliminated by the Phase-2 heartbeat.
- **Pending:** all of Phase 2 (blocked on the two prerequisites above).

## Verification
- **Headless:** `npm run lint:lua` (incl. the identity guard) + `npm run lint:pcall-logging` + `npm test`.
- **In-module selftest (RCON):** `transfer-lock-selftest` — `scan_transfer_expiries` behavior (expired unlocks,
  manual/old-save skipped, TTL sizing) + `transfer_delete_identity_ok` (a renamed source still deletes;
  released/reused/invalid refuse). Wired into `tests/integration/transfer-lock-expiry`.
- **Live:** start a transfer, `docker restart` the controller during `awaiting_validation`, confirm the source
  auto-unlocks after the TTL with no admin action and a normal transfer is unaffected.
- Run `/di-change` before merging any change to the gate / rollback / source-delete / identity paths.

## Critical files
`module/utils/surface-lock.lua` (lock, scan_transfer_expiries, transfer_delete_identity_ok) ·
`module/interfaces/remote/delete-platform-for-transfer.lua` (the sole source-delete) · `module/core/control.lua`
(on_tick scan) · `module/core/transfer-trigger.lua` · `module/core/export-pipeline.lua` (universal lock stamp) ·
`lib/transfer-orchestrator.ts` · `lib/transfer-reconciliation.ts` (dormant Phase-2 core) · `controller.ts`
(observability store) · `messages.ts` · `instance.ts` · `scripts/lint-lua-invariants.mjs` (identity guard).
