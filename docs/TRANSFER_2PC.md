# Cross-instance transfer: durability, identity, and two-phase commit

Single source of truth for how a cross-instance platform transfer stays safe under restarts, crashes, renames,
and concurrency. Supersedes and replaces the former `TRANSFER_2PC_DESIGN.md`, `TRANSFER_2PC_PHASE1_AUDIT.md`, and
`TRANSFER_2PC_PHASE1_REAUDIT.md` (design spec + two point-in-time audits — folded into "current state" below).

Related: CLAUDE.md Pitfalls #15/#16/#28/#29/#30/#31, [ENGINEERING_FAQ.md](ENGINEERING_FAQ.md) (per-scenario
behavior), [TRANSFER_WORKFLOW_GUIDE.md](TRANSFER_WORKFLOW_GUIDE.md).

## The core invariant
The contract is **NO DUPLICATES** — never two live copies. Not transfer-at-any-cost, and not recovery from
someone else's hardware failure. Two side-scoped rules enforce it **by construction** (DECIDED 2026-07-06):
- **Source (the original, the at-risk resource):** never deleted unless a validated copy exists on the
  destination AND the source is still the exact frozen platform we exported (a confirmed handshake). Its
  failsafe is **unlock-only** — a stuck lock always beats deleting the original.
- **Destination (a staged copy, pre-handshake):** never goes live without a completed handshake, and its
  failsafe is **discard-only** — a staged copy is an artifact, not "the platform"; at the handshake deadline it
  is DELETED regardless of why the handshake failed (host death, partition, timeout — the reason is irrelevant;
  the handshake either completed or it did not). Inventing a recovery flow per failure reason is
  over-engineering; a host that dies holding the only copy of a platform is a backup problem, not a transfer
  problem.

Duplication requires a live source AND a live destination copy — the symmetric failsafes (source unlocks, dest
discards) make that impossible without a completed handshake.

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

- Transfer locks carry `kind="transfer"` + `expires_tick` (+ the export `job_id`), stamped at the universal
  lock path (`ExportPipeline.queue` whenever a `destination_instance_id` is present) and at the in-game
  `transfer-trigger`. Export/file locks carry `kind="export"` + `expires_tick`. Manual `/lock-platform` locks
  are kind-less and are never auto-touched.
- `SurfaceLock.scan_transfer_expiries()` runs from `on_tick` (throttled `game.tick % 60 == 0`): for each
  `kind="transfer"` or `kind="export"` lock past `expires_tick` (fallback `locked_tick + DEFAULT_TRANSFER_LOCK_TTL_TICKS`), it calls
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
- A transient EXPORT/file lock now self-expires as `kind="export"`; a crash mid-export recovers by TTL instead
  of stranding the platform until manual `/unlock-platform`.

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
- **Handshake-or-discard (DECIDED 2026-07-06, supersedes the earlier unbounded never-discard rule):** after
  transmitting COMMIT the controller enters a bounded compensation window — the reconcile loop queries the
  source phase and retries COMMIT/RELEASED. If the handshake still has not completed at the **deadline**, the
  staged destination copy is **DISCARDED anyway** — the no-duplicate contract outranks preserving the artifact.
  Accepted residual (documented, not mitigated in-protocol): a source that processed COMMIT, died inside the ack
  window, and never returns loses the platform with the host — the same category as that host dying with no
  transfer in flight, and recoverable the same way: Clusterio's own ops layer (dashboard save download/upload,
  backups, logs) already rights that wrong. The transfer protocol does not re-implement disaster recovery. There is **no operator attestation / force-resolve path** and no admin recovery console: every other
  row of the recovery table is a deterministic function of queryable state and is executed by the reconcile
  loop, not a human. Read-only observability (`/lock-status`, web status, metrics/escalation) is how the loop is
  trusted; the sole human lever is what RCON already provides.
- New `GetSourceTransferLockStateRequest` distinguishes ALL of: `pre_commit` · `committed` ·
  `source_gone_matching_transfer` (via a durable committed tombstone keyed by the canonical transfer id) ·
  `unknown/offline` · `index_reused_or_name_mismatch` — never infer commit from absence.

**Phase-2 prerequisites (spike + prove BEFORE implementing):**
1. **Canonical transfer id.** One id shared across source-lock → dest-stage → COMMIT → GO-LIVE → tombstone. It
   MUST originate at the source (the in-game path has no controller at lock time); the controller adopts the
   export's source-generated id and persists it before awaiting export-complete.
2. **Destination hold primitive — PROVEN for the primitive, not yet wired.** The live-proven hold mechanism is
   `platform.paused = true` + `force.set_surface_hidden(surface, true)` + per-entity deactivation for activatable
   entities, keyed by the destination platform's stable `surface.index`; `DestinationHold.stage()` also completes
   in-flight cargo pods through `SurfaceLock.complete_cargo_pods` after pause/hidden/deactivation takes ownership. The proof runs
   physically counted items and fluids across stage → 600 held ticks → docker restart of the destination host →
   go-live, and verified the copy stayed paused, hidden, inactive, restart-durable, and fidelity-preserving. The
   destructive discard path was also proved safe when the held platform was already externally deleted: discard
   cleared the hold record without treating the missing platform as a failure. PR-0A then proved the remaining
   hold-completeness axes under the corrected not-live definition: no observable side effects, held drift no worse
   than a live control, zero platform damage, and nothing leaving the platform — not frozen time. This closes the
   prerequisite that a destination can be held not-live, fidelity-preserved, and reversibly released before Phase 2
   starts.

   *Amendment (CI closeout, 2026-07-06):* the earlier CI-only `fluids 1120→1100 delta=20` gap is **UNEXPLAINED,
   not solved**. The bad run was eliminated by fixture determinism and direct-machine meter hardening: the probe now
   enables `heavy-oil-cracking`, asserts the write was accepted, measures direct machine buffers separately from
   segment totals, and reports tick/game-paused/platform-paused state on recurrence. Local R9 and CI run
   28814951121 preserved asserted machine fluid through stage → +600 held ticks → go-live with the primitive
   unchanged. Rejected design: no destination-hold fluid snapshot/reinject; the hold keeps full deactivation.
   **D1 — DECIDED (2026-07-06): an active destination hold owns the platform's FULL not-live state** — visibility,
   entity activation, and platform pause; `unlock_platform` (manual, TTL expiry, or any other path) touches none
   of them while a hold exists for that surface. Lock-release-before-stage ordering is retained as protocol
   hygiene, not the load-bearing guarantee. Ships as **PR-1, first and alone**, with selftest teeth (unlock over a
   held surface leaves it hidden AND inactive AND paused — RED if the guard is removed), `/di-change` gated.
   Background — the measured hazard that forced the decision (both axes): an expired transfer lock restores
   surface visibility over an active hold, and its `frozen_states` unfreeze can reactivate entities the hold
   deactivated. Superseded resolution options (recorded for history):
   (a) make `unlock_platform` consult `storage.destination_holds` before restoring visibility, which centralizes the
   guard but couples the lock spine to the destination-hold primitive; (b) require Phase-2 sequencing to release the
   source lock before staging the destination hold, which keeps the primitive boundary clean but makes ordering
   correctness load-bearing; or (c) have destination holds re-assert hidden after any unlock, which is self-healing
   but introduces competing ownership and tick/order races. The decided path is (a), shipped before any Phase 2
   wiring, with the not-live definition above as the acceptance bar.

### Failure-mode table (restart/crash at each step)
Legend: **S**=source, **D**=dest, **C**=controller; `{}` = source lock phase (Phase 2). The decisive fact is S's phase.

| # | Failure point | S failsafe | D failsafe | C on restart | Invariant |
|---|---|---|---|---|---|
| 1 | S locked {pre_commit}, before/during export | expiry → UNLOCK | nothing staged | let S self-unlock | only S exists |
| 2 | D crashes mid-import | {pre_commit} → UNLOCK | no validated copy → discard | ABORT | D had no good copy |
| 3 | D staged_validated, VOTE lost / C down before COMMIT | {pre_commit} → UNLOCK | HOLD; re-announce | query S=pre_commit ⇒ DISCARD D | S live, D staged ⇒ not both-live |
| 4 | C sent COMMIT; S {committed}, delete errors persistently | {committed} → DELETE (retry); frozen tombstone | reconcile loop: retry → GO-LIVE (within the deadline window) | query S=committed ⇒ GO-LIVE D | committed = non-live ⇒ not both-live |
| 5 | S deleted, RELEASED lost, C down before GO-LIVE | (done) | HOLD; re-announce | query S=gone ⇒ GO-LIVE D | S gone + D staged ⇒ not both-gone |
| 6 | GO-LIVE lands; D crashes mid-activate | (S gone) | idempotent re-run | GO-LIVE idempotent | only D exists |
| 7 | S permanently unreachable / handshake never completes | (unknowable) | reconcile loop retries through the compensation window; at the DEADLINE → **DISCARD D** (handshake-or-discard) | same — deadline discard is unconditional | no-dup by construction; residual loss accepted, rightable via the ops layer (backups/save upload) |
| 7 | Race: COMMIT vs S {pre_commit} expiry | UNLOCK-first ⇒ COMMIT finds no matching id → REFUSE | HOLD | refused COMMIT ⇒ DISCARD D | id match prevents deleting a rolled-back live source |
| 8 | S-host down long mid-transfer | ticks don't advance ⇒ no spurious expiry | HOLD | per S phase on return | tick-based ⇒ downtime never over-counts |

## Current implementation status
- **Shipped:** Phase 1 source-side TTL (unlock-only) + identity gate (surface.index + a name-free `job_id`
  request↔lock correlation) + cargo-pod awaiting_launch zero-loss recovery. The #60 controller auto-delete spine
  is removed; the dormant `resolvePendingTransfer` reconciliation core was DELETED in #64 (it embodied the
  superseded destination-outcome/escalate-to-admin model — the Phase-2 reconcile loop is built fresh against the
  handshake-or-discard contract). Re-audit hardening R1–R8
  shipped (`feat/106-hardening`): in-game double-transfer refuse guard, expiry-scan failure counter, derived TTL
  floor, order-independent + timer-spy test teeth, stale-comment cleanup.
- **Follow-ups:** dest-side `validation_results` / `flight_data` re-key off name (collision); a true live
  `descending`/`parking` cargo-pod overflow specimen is still not constructed by PR-0A (the shared helper now routes
  those states through recover-and-spill, while the live specimen is `awaiting_launch`); a full controller/web-route
  behavior test for the double-transfer reject (the decision is unit-tested via
  `is_same_transfer_upgrade`; the in-game route is live-verified). The mid-flight TTL self-unlock on a >10-min
  transfer (delete gate makes it a recoverable dup, not loss) is eliminated by the Phase-2 heartbeat.
- **Pending:** Phase 2 COMMIT / GO-LIVE / committed-tombstone protocol wiring, gated on the remaining Phase-0
  labs and PR-1 hold-aware unlock. **D1 is DECIDED** (hold owns the full not-live state; PR-1 ships first,
  alone). The canonical-id prerequisite, export-lock strand, destination-hold primitive proof, and PR-0A
  hold-completeness gate are closed.

## Verification
- **Headless:** `npm run lint:lua` (incl. the identity guard) + `npm run lint:pcall-logging` + `npm test`.
- **In-module selftest (RCON):** `transfer-lock-selftest` — `scan_transfer_expiries` behavior (expired unlocks,
  manual/old-save skipped, TTL sizing) + `transfer_delete_identity_ok` (a renamed source still deletes;
  released/reused/invalid refuse). Wired into `tests/integration/transfer-lock-expiry`.
- **Live:** start a transfer, `docker restart` the controller during `awaiting_validation`, confirm the source
  auto-unlocks after the TTL with no admin action and a normal transfer is unaffected.
- **Destination-hold primitive proof:** `tests/integration/destination-hold` (`-Sections main,restart,lifecycle,double,discard,ttl,cleanup` by default) records the not-live/fidelity/restart/go-live/discard/TTL-hazard evidence and asserts zero leftover `storage.destination_holds`, zero `storage.locked_platforms`, zero `desthold-*` surfaces, and `game.tick_paused == false` after cleanup. The harness scopes parsed RCON output to stdout from `surface-export-controller`; the unrelated `clusterio-atlas` warning was `clusterioctl` stderr from the same controller's incomplete `/clusterio/external_plugins/clusterio-atlas` directory, not an atlas-container dependency.
- Run `/di-change` before merging any change to the gate / rollback / source-delete / identity paths.

## Critical files
`module/utils/surface-lock.lua` (lock, scan_transfer_expiries, transfer_delete_identity_ok) ·
`module/interfaces/remote/delete-platform-for-transfer.lua` (the sole source-delete) · `module/core/control.lua`
(on_tick scan) · `module/core/transfer-trigger.lua` · `module/core/export-pipeline.lua` (universal lock stamp) ·
`lib/transfer-orchestrator.ts` · `controller.ts`
(observability store) · `messages.ts` · `instance.ts` · `scripts/lint-lua-invariants.mjs` (identity guard).
