# TS-layer assumption sweep — the welded-inference method applied to the TypeScript transfer layer

> **Provenance:** read-only audit, 2026-07-10, companion to `2026-07-10-welded-inference-sweep.md` (which
> covered the Lua/pitfall corpus). Verified at `codex/composite-transfer-verdict` HEAD. Severity per the repo
> taxonomy. **No MEASURED-ACTIVE-LOSS found in the TS layer.** Orchestrator note: finding A1 is the known
> PR-3 scope (`2026-07-08-pr-3-protocol-wiring-plan.md`) — this sweep independently rediscovered it and
> SHARPENED it with three concrete duplication scenarios; treat A1 as PR-3's urgency case, not a new lane.

**Summary:** 4 spine findings (1 duplication-window design gap = PR-3, 1 correctness-critical unmeasured
timeout, 2 unguarded-input/idempotency gaps) · 5 silent-failure findings · 6 magic-number/welded-comment
findings · 3 dead-scaffolding findings · 1 stale memory resolved · 9 verified-clean areas.

## A. Source-delete spine (ranked)

### A1. The 2PC COMMIT protocol is scaffolding only — TTL auto-unlock can resurrect a source AFTER a successful destination import. LATENT-DETECTION-GAP (duplication window) → **this is PR-3**
Call-graph verified: `SurfaceLock.commit_source_transfer_lock` (`module/utils/surface-lock.lua:335`) has zero
callers; `ControllerPlugin.recordCommitTransmitted` (`controller.ts:842`) never called;
`GetSourceTransferLockStateRequest` handled (`instance.ts:105`) but never sent; `sourceCommitMarkers`
(`controller.ts:74-114,808-867`) persists an always-empty map. So `source_lock_is_committed` in the delete
gate (`delete-platform-for-transfer.lua:58`) is dead, and the ~10-min Lua TTL unlock resurrects a live source
after a delivered-and-successful import in three reachable scenarios:
(a) validation event later than the 120s timeout → timeout rolls back + unlocks
(`transfer-orchestrator.ts:265-282` → `:383`), dest finishes → two live copies;
(b) controller restart while `awaiting_validation` → late success hits unknown-transfer warn-and-return
(`:297-299`), source TTL-unlocks;
(c) the delete send throws (SessionLost controller→source host): `handleValidationSuccess`'s `sendTo` (`:338`)
has no SessionLost-aware handling (unlike the import send at `:182`) → catch (`:324`), no retry, TTL-unlocks.
**Welded inference:** the #106 comment (`transfer-orchestrator.ts:190-197`) — "a recoverable stranded lock is
strictly better than unrecoverable duplication" — is true only for genuine non-delivery; for a
delivered-and-successful import the TTL unlock IS the duplication. Test shape: delay the validation send past
`VALIDATION_TIMEOUT_MS`; assert physically (surface census both instances) at most one live copy after TTL.

### A2. `VALIDATION_TIMEOUT_MS = 120_000` (`helpers.ts:14`) is a guess beside a measured 60–90s operation. UNPROVEN-ASSUMPTION, correctness-critical
Arms after transmission (`:168`), covers async import + validation; margin ~2× at best, unquantified under
load; overrun feeds A1(a) — converts an eventually-successful import into duplication. Human strings hardcode
"2 minutes" twice (`:270,:279`) independent of the constant. Rung: measure import+validation wall-clock for
the 1359-entity platform + a 2–3× synthetic on CI hardware; set from measured p99 with cited margin.

### A3. `handleTransferValidation` has no terminal-state guard. LATENT-DETECTION-GAP
`transfer-orchestrator.ts:287-332`: only guard is record existence. A real event arriving after the timeout
resolved the transfer (or a duplicate event) re-enters `handleValidationSuccess` and re-sends the source
delete; safety rests on the Lua identity gate refusing (verified fail-closed) but yields a misleading
`cleanup_failed` relabel + re-broadcasts. Neither failure path ever messages the DESTINATION — a
completed-but-timed-out import is never cleaned up or flagged. One `status === "awaiting_validation"` entry
check closes it.

### A4. Upload-import does not strip embedded transfer metadata. LATENT-DETECTION-GAP (spine input sanitization) — **cheap fix**
`controller.ts:304-316`: `handleImportUploadedExportRequest` injects `_operationId` but never deletes
`_transferId`/`_sourceInstanceId` from user-supplied JSON. A reuploaded/crafted export carrying a live
transfer's `_transferId` makes the dest emit a `TransferValidationEvent` for that ID — the uploaded copy's
verdict can drive the real transfer's source delete. Two `delete` lines close it. Test: upload an export
carrying a live transfer's `_transferId`; assert the real spine unaffected.

### A5. The dual-success coupling memory is RESOLVED at HEAD — verified CLEAN (small residual)
No RCON re-fetch anywhere in TS; success derived once instance-side (`instance.ts:717-739`), fail-closed on
missing payload; Lua delete gate correlates name-free on `exportId == lock.transfer_job_id` + `surface.index`.
Residual: if `data.success` is missing/non-boolean, TS falls back to the two match booleans alone (`:738`) —
a mirror that could drift from the composite verdict. One line: treat non-boolean `data.success` as failure.

### A6. Divergent sibling timeouts on the same wait. UNPROVEN-ASSUMPTION
`waitForStoredExport` 10s on the transfer path (`transfer-orchestrator.ts:31`, used `:456`) vs 60s on the
download path (`controller.ts:423`) — same physical wait, 6× apart, neither justified. Overrun is fail-closed
(source unlocks; late export auto-transfer-suppressed via `controllerManagedTransferExports`,
`instance.ts:232-236`) but aborts transfers that would have succeeded. Rung: measure stored-export latency vs
payload size; unify.

## B. Silent / degraded failure paths
- **B1** `transaction-logger.ts:271-276,303-312`: any transient read error → `allLogs = []` → next write makes
  the wipe permanent (audit trail, LATENT).
- **B2** `controller.ts:601-626`: non-ENOENT loadStorage error → empty map → next persist overwrites the file
  incl. in-flight export blobs (LATENT).
- **B3** `instance.ts:206-303`: export-complete delivery failure (null data / send throw) → log-and-return;
  source stays locked-and-hidden until TTL, invisible to UI (LATENT-DETECTION-GAP).
- **B4** `transfer-orchestrator.ts:499`: benign-unlock detection regex-matches Lua error PROSE
  (`/platform not locked|no locked platforms/i`) — rewording flips benign unlocks into reported rollback
  failures (fail-safe direction).
- **B5** `instance.ts:575-591`: "verify the import was queued" sends a constant-print `/sc` after `wait(500)`
  — decorative; both branches return success. Delete or query the real job queue.

## C. Magic numbers & welded comments
- **C1** Three inconsistent RCON-limit claims: `RCON_CHUNK_SIZE = 100_000` (`helpers.ts:11` + independent
  duplicate default `:176`) vs `lua-interface.ts:66-69` guarding at 7000 bytes citing "~8KB RCON limit" vs
  CLAUDE.md's "4KB chunks / ~8KB max". The working 100KB path (CI moves 235KB exports) refutes the comments;
  needs ONE measurement at the pin, then one constant.
- **C2** `TICKS_TO_MS = 16.67` (`helpers.ts:10`) assumes 60 UPS; display-grade + exportStallSeconds histogram
  label skew under UPS drops. Low.
- **C3** `pruneOldTransfers` cap 100 (`transfer-orchestrator.ts:405-412`) shared across transfers+exports+
  imports; can evict an in-flight `awaiting_validation` transfer (→ A1 path). No in-flight exclusion.
- **C4** Retention constants (`controller.ts:39-40`) chosen relative to the Lua TTL, no cited derivation.
- **C5** `operation-record.ts:40` defaults `platformIndex` to **1** on invalid input — the exact `|| 1` the
  orchestrator comment says was eliminated survives in the shared factory (transfer path pre-validates, so
  today safe). Make it null-and-throw for transfer-typed records.
- **C6** `ensureLuaConsoleUnlocked` (`instance.ts:602-621`) — console-confirmation lore never demonstrated for
  RCON; harmless double-send. UNPROVEN-ASSUMPTION.

## D. Dead scaffolding (label or wire)
`waitForExportData` (`instance.ts:410-429`) zero callers + its two constants (`helpers.ts:12-13`) · the entire
COMMIT half of Phase 2 (see A1) — none marked "not yet wired"; comments read as if live ("the source-phase
query is authoritative…" — a query never made). PR-3 either wires them or the labels must say scaffolding.

## E. Verified CLEAN
Lua-injection surface (escapeString/Math.trunc/JSON-not-literals throughout `lua-interface.ts`) · Pitfall #26
bound-Link discipline · SessionLost handling on the IMPORT send (fail-closed into awaiting_validation) ·
fail-loud index guards on delete/unlock (`instance.ts:797-801,834-838`; `transfer-orchestrator.ts:103-109`) ·
`recordOperationOutcome` idempotency (metricsRecorded stamp, verified) · canonical transfer-ID make/parse
(`shared/utils.ts:45-71`); no mirror of the Lua numeric-key pitfall · `_operationId` injection mechanics +
fail-safe ImportOperationComplete forwarding (`instance.ts:690-715`) · gateway config load/migration +
self-target rejection · subscription broadcasting (stale-connection culling; annotated best-effort catch).

## Triage (orchestrator)
1. **A4** — two-line sanitization fix + test: queue as a small standalone PR (or fold into PR-3's wiring PR).
2. **A1/A3/A6/C3/D** — all PR-3 scope: fold this sweep's scenarios and line-cites into the PR-3 plan before
   executing it; A2's timeout measurement is a cheap cluster rung to run alongside LAB-B+.
3. **A5 residual + C5** — one-line hardenings; candidates for the #30 PR (same files, same review).
4. **B1/B2/B3** — reliability backlog (audit-trail + observability, not game data).
5. **C1** — one RCON measurement rung (max single `/sc` size at the pin), then collapse three claims to one
   constant. C2/C4/C6 — note-and-leave.
6. Memory `transfer-validation-dual-success` is stale at HEAD — updated to point at A1 as the successor risk.
