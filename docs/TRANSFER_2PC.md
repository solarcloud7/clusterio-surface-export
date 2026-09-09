# Transfer handoff and recovery

The current handoff is **validate destination → hold destination → delete source →
release destination**. A guarded recovery worker retries retained handoffs after lost
replies and controller restarts. An instance journal outside Factorio saves records
source retirement before deletion. The bounded source-crash and older-save tests pass;
this is not proof of arbitrary crash or backup-restore safety.

## Current behavior

- Import finishes restoration and validation before reporting success. A successful
  transfer destination is hidden and its active entities are disabled in the same
  Lua callback that prepares the completed platform. Deferred circuit restoration
  waits until this hold is released.
- The controller verifies the destination hold before requesting source deletion.
- Source deletion checks the transfer lock and recorded surface identity. Platform
  names are display labels. A refused or thrown deletion retains the lock; the
  engine's false result is propagated through both Lua adapters.
- Before source deletion, the instance durably writes the platform's saved identity,
  export ID, indices and force to `surface_export_source_retirements.json` in its data
  directory. Linux writes sync the file and containing directory. The matching Lua
  transfer lock becomes committed before deletion; ordinary expiry/unlock cannot release it.
- The controller releases the destination only after an acknowledged source deletion.
  A refused or lost reply records cleanup_failed and retains the recovery intent.
  Concurrent duplicate validation messages share the same completion operation.
- Source deletion and destination activation retain save-local, identity-bound receipts.
  A replay checks the receipt and current platform identity before acknowledging the action.
  Each receipt kind retains its latest 2,048 entries; eviction means evidence is unavailable,
  never permission to infer success. Source receipts require the exact platform to be absent;
  released-destination receipts require that destination to remain present.
- Every 30 seconds, the controller retries retained uncertain handoffs when both instances
  are online. It never imports a second copy. The ordinary completion path performs the
  hold/receipt check, source deletion request, activation, audit and payload cleanup.
  A failed recovery-intent disk write prevents the source deletion request.
- A validation timeout retains uncertainty and does not invent failed item/fluid checks or
  unlock the source. A later genuine verdict can settle the same transfer. Unknown recovery
  outcomes leave the destination held; they do not authorize discarding it.
- A failed destination preparation cannot activate. Cleanup may discard a registered
  hold only when its platform and surface indices match the failed import job.
- Ordinary transfer locks expire after 36,000 simulation ticks. Expiry unlocks the
  source; it never deletes it. Manual locks and old locks without timing are skipped.
  An expired source lock prevents a later deletion request from deleting that platform.
- Unresolved controller intents no longer expire with wall-clock age. Explicit resolution
  removes them. Missing intents, legacy transfers without canonical IDs, missing receipts and changed identities
  cannot be automatically resolved. Destination holds have no automatic expiry. An
  unresolved destination may remain hidden indefinitely and needs investigation.

## Required recovery contract

Exact cargo preservation and at most one usable copy are both required. In particular,
**a timeout or offline source does not authorize deleting a held destination**: the
source may already have been deleted and its reply lost.

Recovery must preserve these boundaries; the durability distinction remains a release gate:

1. Retain an identity-bound receipt for accepted source deletion and destination
   release. Absence of a platform is not evidence of a matching transfer deletion.
2. Make repeated requests idempotent, including a reply lost after a successful action.
   A canonical transfer ID must not overwrite an active transfer or cause another import.
3. Persist controller recovery intent before irreversible actions. On restart, use the
   same completion path so audit updates, stored payload cleanup and queue release agree.
4. Prove what survives a Factorio save reload. Lua storage survives only through the
   save that contains it; recording a receipt in memory is not a disk durability barrier.
   Controller restart, graceful Factorio restart, abrupt process loss and deliberate
   restoration of an older save are different test cases.
5. Preserve a recoverable copy on ambiguous outcomes. Retrying an action must not
   re-import, delete a different platform, or release a destination after source recovery.

The retirement journal is intent evidence, not a deletion receipt. A missing source
still requires its save-local receipt to acknowledge a replay. If an earlier checkpoint
restores that source, reconciliation binds its saved identity to the original committed
lock; the matching pending handoff can retry the real deletion. A completed handoff's
resurrected source remains quarantined, with no automatic deletion or re-import.

## Startup and operator recovery

Clusterio's save-patch startup event protects existing platforms before the Node
background reconciliation, launched by `onStart` without holding Clusterio's hook open.
The ordinary Lua scheduler and unlock/expiry path wait for
reconciliation. Normal startup locks are released; retired sources keep committed
locks. This uses the server-startup event, not `on_load`, which also runs on client join.
Startup protection does not force-finish cargo pods or reject pending circuit restoration;
those transfer-preparation actions do not belong to ordinary server startup. The Lua
regression reproduced the unwanted pod call before that separation was added.

Platform identities combine a persisted creation epoch with hub identity. A different
journal ID, corrupt journal, unidentified older platform when retirements exist, or
roster over 500 platforms refuses automatic reconciliation. Startup protection and
Lua reconciliation calls are synchronous/bounded by that roster limit, not a proven
frame budget. RCON requests run sequentially outside the startup hook. Stop/restart
invalidates the worker before its next request, including `finish`. A failed reply or
journal refusal logs an explicit protected-startup error; repair the cause and restart.

When recovery refuses:

1. Retain both worlds, controller recovery intents, instance retirement journals and
   transaction diagnostics. Back up the current state before changing it.
2. Check the canonical operation, journal platform identity and physical source/destination
   state. A name match or an empty source lookup is insufficient evidence.
3. Repair availability or restore a verified matching journal, then restart the affected
   instance through the established save-preserving deploy/start process. Retained
   handoffs retry every 30 seconds through the normal validation/deletion gate.
4. A completed transfer's quarantined duplicate or a missing/conflicting identity needs
   operator adjudication. There is no force-release fallback. Do not delete the journal
   or unlock the duplicate to make the warning disappear.

Unresolved intents reserve both participating instances, including after loss of the
active timing record. Unrelated instance pairs may still transfer. This can require
operator intervention indefinitely; age or lack of active retry is not proof that
another transfer is safe. A startup refusal to unlock remains a failed recovery
acknowledgement, never a benign/successful unlock.

Restoring older copies of the external journal/controller state as well as the worlds,
destination rollback after release, journal loss, and storage-device failure are not
covered by the successful source-only restore test. Journal entries are not age-pruned;
backup retention and journal compaction need a separate, explicit policy.

Restart recovery retains available audit evidence and starts timing on a new process clock.
It does not manufacture one continuous measured duration across the restart.

### PR #305 review verification

| Finding | Disposition and evidence |
|---|---|
| Startup hook budget | Reproduced a held RCON reply blocking `onStart`. Background recovery now returns the hook, visits a 500-entry simulated roster before finish, reports refusal, and stops after an old-runtime reply. No live 500-platform performance claim. |
| Export callback replay | Faults in entity work, belt capture, verification, serialization, compression, cache output and post-publication pruning now interrupt the saved job. Scheduler reload cannot repeat the work; recorded completion is invalidated after a publication exception. Source lock expiry and controller recovery remain separate mechanisms. |
| Permanent queue reservation | Retained deliberately. Regression proves orphan intents block both participants without an active record and unrelated pairs still run. Releasing on missing `timingPendingRecovery` would bypass unknown outcomes. |
| Startup unlock refusal | Retained as a recovery failure. Classifying it as benign would assert source resolution without acknowledgement. Use the recovery procedure above. |
| Invalid hub reference | Reproduced invalid-member access; recovery now checks validity and refuses cleanly. |
| Optional retirement identity | Missing, empty, non-string or mismatched UID cannot authorize deletion. Evacuation fixtures now obtain the runtime identity explicitly. These direct Lua fixtures test evacuation, not journal durability. |
| Uncompressed JSON between ticks | Retained deliberately to separate synchronous encoding and compression, reuse diagnostic bytes and resume across save/load. Combining both calls would undo a requested phase yield. Save size/peak-memory impact remains unmeasured; no memory optimization claim. |
| Bare identity JSON parse | Shared reply parser now retains bounded raw evidence and refuses malformed/unsuccessful replies. Regression reproduced the missing diagnostic. |
| Repeated identity lookup | Existing identity is read once during assignment. |
| Separate CI worlds | Retained. Deleting retirement authority between suites would change the test's recovery guarantees; matrix legs run concurrently, so duplicate setup increases runner use but does not imply double wall-clock duration. |

Executable checks: `test/gateway-config-chunking.test.cjs`,
`test/transfer-request-queue.test.cjs` in the plugin, and
`tests/lua/export-phase-yields.lua`, `tests/lua/source-recovery.lua`,
`tests/lua/source-delete-gate.lua`. Engine/RCON fault injection is simulated; these
regressions do not establish arbitrary crash safety or a live callback-time bound.

## Executable evidence

[Transfer cleanup acceptance](../tests/integration/transfer-cleanup/README.md) runs a
normal transfer and an injected source-deletion failure using temporary platforms.
Its oracle independently reads inventories, belt sides, fluids, visibility and activation.
It verifies fixture cleanup and preservation of pre-existing platform identities.

The original failure left two usable copies. The corrected path retains the destination
hold when deletion fails. The current acceptance runner removes the injected fault and
verifies automatic completion of the same transfer, including after controller restart.
Receipt replay leaves cargo unchanged. A separate graceful Factorio reload preserved the
hold and source lock. These are bounded observations, not abrupt-crash durability evidence.

The opt-in [manual Docker lab](../tests/manual/transfer-reliability/README.md) now exercises
accepted actions whose replies are withheld, followed by a real controller kill/restart.
Both deletion and release cases recovered with exact physical cargo and one import request.
The original source crash left `cleanup_failed`; the original earlier-source restore
**reproduced two usable copies**. With the external retirement journal, run
`se-manual-mtt3qqj0-030e24a4` completed source-crash recovery with exact cargo and one import.
Run `se-manual-mtt3mop4-023b3790` kept the resurrected source protected after an acknowledged
transfer, with the destination usable and exact cargo. Both removed their disposable
resources. The original negative evidence remains in the manual lab notes. Observations
are at the reported boundaries; they are not continuous observation of every engine update.

The same suite tests empty and populated hubs. Import setup removes generated starter
cargo before restoring the payload, including payloads that omit empty inventories.

Lua regression tests cover engine refusal, partial hold preparation, discard failure,
foreign hold identity, phase yields and deferred circuit work. Controller tests cover
concurrent duplicate verdicts and uncertain deletion/activation replies. See
[batching and timing](async-processing.md) for the separate performance boundaries.
