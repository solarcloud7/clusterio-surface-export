# Cross-instance transfer: durability, identity, and two-phase commit

Single source of truth for how a cross-instance platform transfer stays safe under restarts, crashes, renames,
and concurrency.

Related: CLAUDE.md Pitfalls #15/#16/#28/#29/#30/#31, [ENGINEERING_FAQ.md](ENGINEERING_FAQ.md) (per-scenario
behavior), [EXPORT_IMPORT_FLOW.md](EXPORT_IMPORT_FLOW.md) (the message-level flow trace).

## The core invariant
The contract is **NO DUPLICATES** — never two live copies. Not transfer-at-any-cost, and not recovery from
someone else's hardware failure. Two side-scoped rules enforce it **by construction**:
- **Source (the original, the at-risk resource):** never deleted unless a validated copy exists on the
  destination AND the source is still the exact frozen platform we exported (a confirmed handshake). Its
  failsafe is **unlock-only** — a stuck lock always beats deleting the original.
- **Destination (a staged copy, pre-handshake):** never goes live without a completed handshake, and its
  failsafe is **discard-only** — a staged copy is an artifact, not "the platform"; at the handshake deadline it
  is DELETED regardless of why the handshake failed (host death, partition, timeout — the reason is irrelevant;
  the handshake either completed or it did not). A host that dies holding the only copy of a platform is a
  backup problem, not a transfer problem.

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
- Still name-keyed (lower-risk, follow-up): `platform_flight_data[platform.name]` — a name collision there
  cross-wires or loses a record. The dest-side validation-result debug store is keyed by transfer/job id.

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
  re-adoption only**. It never auto-deletes or auto-unlocks on boot.
- A controller restart during `awaiting_validation` no longer leaves the source locked-and-hidden forever — the
  source self-heals after the TTL.

**Known Phase-1 corners (documented, recoverable):**
- A transfer whose whole pipeline exceeds the TTL (~10 min) self-unlocks mid-flight. The delete gate then refuses
  to delete the now-live source (Gate A / identity refuse-if-not-locked), yielding a recoverable duplicate rather
  than deleting a live platform. Phase 2's heartbeat + canonical id eliminate the mid-flight unlock.
- A stranded-then-committed transfer's stored export can linger in the Exports tab and be re-imported into an
  extra copy (Phase 1 cannot know the dest committed, so it cannot safely delete the export). Resolved in Phase 2.
- A transient EXPORT/file lock self-expires as `kind="export"`; a crash mid-export recovers by TTL instead
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
- The dest VOTE means **fully finalized**: import → complete held items → restore fluids while paused/deactivated
  → one exact item+fluid gate (Pitfall #15, Entity Activation Before Validation) → activate → gateway park →
  only then vote, holding the finished platform not-live. COMMIT can never race a later restoration failure.
  **The single frozen-world verdict pre-implements this object** on the current live transfer path: one Lua
  payload carries `success`, item/fluid validation, `failedStage`, and metrics; PR-3's VOTE consumes the same
  verdict shape.
- `committed` is an **irreversible non-live tombstone**: every unlock/resume/expiry path REFUSES a `committed`
  lock; only delete clears it. GO-LIVE fires on source state `gone` OR `committed`.
- **Handshake-or-discard:** after transmitting COMMIT the controller enters a bounded compensation window — the
  reconcile loop queries the source phase and retries COMMIT/RELEASED. If the handshake still has not completed
  at the **deadline**, the staged destination copy is **DISCARDED anyway** — the no-duplicate contract outranks
  preserving the artifact. Accepted residual: a source that processed COMMIT, died inside the ack window, and
  never returns loses the platform with the host — the same category as that host dying with no transfer in
  flight, and recoverable the same way: Clusterio's own ops layer (dashboard save download/upload, backups,
  logs). The transfer protocol does not re-implement disaster recovery. There is **no operator attestation /
  force-resolve path** and no admin recovery console: every recovery row is a deterministic function of
  queryable state and is executed by the reconcile loop, not a human. Read-only observability (`/lock-status`,
  web status, metrics/escalation) is how the loop is trusted; the sole human lever is what RCON already provides.
- `GetSourceTransferLockStateRequest` distinguishes ALL of: `pre_commit` · `committed` ·
  `source_gone_matching_transfer` (via a durable committed tombstone keyed by the canonical transfer id) ·
  `unknown/offline` · `identity_mismatch` — never infer commit from absence.

**Phase-2 prerequisites:**
1. **Canonical transfer id.** One id shared across source-lock → dest-stage → COMMIT → GO-LIVE → tombstone. It
   MUST originate at the source (the in-game path has no controller at lock time); the controller adopts the
   export's source-generated id and persists it before awaiting export-complete. Still open.
2. **Destination hold primitive — PROVEN.** The hold mechanism is `platform.paused = true` +
   `force.set_surface_hidden(surface, true)` + per-entity deactivation for activatable entities, keyed by the
   destination platform's stable `surface.index`; `DestinationHold.stage()` also completes in-flight cargo pods
   through `SurfaceLock.complete_cargo_pods` after pause/hidden/deactivation takes ownership. Proven with
   physically counted items and fluids across stage → 600 held ticks → docker restart of the destination host →
   go-live (paused, hidden, inactive, restart-durable, fidelity-preserving), and the discard path is safe when
   the held platform was already externally deleted. One historical CI-only fluid delta (1120→1100) remains
   **UNEXPLAINED, not solved** — eliminated by fixture determinism and meter hardening, never root-caused.
3. **D1 — hold owns the platform's FULL not-live state** (visibility, entity activation, platform pause):
   `unlock_platform` (manual, TTL expiry, or any other path) touches none of them while a hold exists for that
   surface. Ships as **PR-1, first and alone**, with selftest teeth (unlock over a held surface leaves it hidden
   AND inactive AND paused — RED if the guard is removed), `/di-change` gated. The measured hazard: an expired
   transfer lock restores surface visibility over an active hold, and its `frozen_states` unfreeze can
   reactivate entities the hold deactivated.

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
| 8 | Race: COMMIT vs S {pre_commit} expiry | UNLOCK-first ⇒ COMMIT finds no matching id → REFUSE | HOLD | refused COMMIT ⇒ DISCARD D | id match prevents deleting a rolled-back live source |
| 9 | S-host down long mid-transfer | ticks don't advance ⇒ no spurious expiry | HOLD | per S phase on return | tick-based ⇒ downtime never over-counts |

## Current implementation status
- **Shipped:** Phase 1 source-side TTL (unlock-only) + identity gate (surface.index + a name-free `job_id`
  request↔lock correlation) + cargo-pod awaiting_launch zero-loss recovery + in-game double-transfer refuse
  guard + expiry-scan failure counter + derived TTL floor. The controller has no auto-delete or boot-reconcile
  spine; the Phase-2 reconcile loop will be built fresh against the handshake-or-discard contract.
- **Follow-ups:** dest-side `flight_data` re-key off name (collision); a true live `descending`/`parking`
  cargo-pod overflow specimen (the shared helper routes those states through recover-and-spill; the live-proven
  specimen is `awaiting_launch`); a full controller/web-route behavior test for the double-transfer reject (the
  decision is unit-tested via `is_same_transfer_upgrade`; the in-game route is live-verified). The mid-flight
  TTL self-unlock on a >10-min transfer (a recoverable dup, not loss) is eliminated by the Phase-2 heartbeat.
- **Pending:** Phase 2 COMMIT / GO-LIVE / committed-tombstone protocol wiring, gated on the canonical-id
  prerequisite and PR-1 hold-aware unlock. The destination-hold primitive proof and hold-completeness gate are
  closed.

## Verification
- **Headless:** `npm run lint:lua` (incl. the identity guard) + `npm run lint:pcall-logging` + `npm test`.
- **In-module selftest (RCON):** `transfer-lock-selftest` — `scan_transfer_expiries` behavior (expired unlocks,
  manual/old-save skipped, TTL sizing) + `transfer_delete_identity_ok` (a renamed source still deletes;
  released/reused/invalid refuse). Wired into `tests/integration/transfer-lock-expiry`.
- **Live:** start a transfer, `docker restart` the controller during `awaiting_validation`, confirm the source
  auto-unlocks after the TTL with no admin action and a normal transfer is unaffected.
- **Destination-hold primitive proof:** `tests/integration/destination-hold` (`-Sections
  main,restart,lifecycle,double,discard,ttl,cleanup` by default) records the
  not-live/fidelity/restart/go-live/discard/TTL-hazard evidence and asserts zero leftover
  `storage.destination_holds`, zero `storage.locked_platforms`, zero `desthold-*` surfaces, and
  `game.tick_paused == false` after cleanup.
- Run `/di-change` before merging any change to the gate / rollback / source-delete / identity paths.

## Critical files
`module/utils/surface-lock.lua` (lock, scan_transfer_expiries, transfer_delete_identity_ok) ·
`module/interfaces/remote/delete-platform-for-transfer.lua` (the sole source-delete) · `module/core/control.lua`
(on_tick scan) · `module/core/transfer-trigger.lua` · `module/core/export-pipeline.lua` (universal lock stamp) ·
`lib/transfer-orchestrator.ts` · `controller.ts`
(observability store) · `messages.ts` · `instance.ts` · `scripts/lint-lua-invariants.mjs` (identity guard).
