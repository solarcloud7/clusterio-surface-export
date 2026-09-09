# Transfer handoff and recovery

The current handoff is **validate destination → hold destination → delete source →
release destination**. A guarded recovery worker retries retained handoffs after lost
replies and controller restarts. Abrupt-process-loss durability is not yet established;
this is not a completed crash-safe two-phase commit protocol.

## Current behavior

- Import finishes restoration and validation before reporting success. A successful
  transfer destination is hidden and its active entities are disabled in the same
  Lua callback that prepares the completed platform. Deferred circuit restoration
  waits until this hold is released.
- The controller verifies the destination hold before requesting source deletion.
- Source deletion checks the transfer lock and recorded surface identity. Platform
  names are display labels. A refused or thrown deletion retains the lock; the
  engine's false result is propagated through both Lua adapters.
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
- Pending controller intents retain their existing 15-minute age limit. Missing/expired
  intents, legacy transfers without canonical IDs, missing receipts and changed identities
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

Existing committed-lock and tombstone helpers are prerequisites, not proof that this
protocol runs. They are not wired into the ordinary source deletion path. Do not infer
successful deletion from their presence in the repository.

Restart recovery retains available audit evidence and starts timing on a new process clock.
It does not manufacture one continuous measured duration across the restart.

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
Killing the source host before its receipt was saved preserved sampled safety after reload,
but left the destination held and the operation `cleanup_failed`; automatic recovery did not finish.
Restoring only an earlier source save **after completion reproduced two usable copies**.
Backup reconciliation therefore remains a demonstrated production blocker, not merely an
untested precaution. The manual lab retains the negative evidence and removes its disposable worlds.

The same suite tests empty and populated hubs. Import setup removes generated starter
cargo before restoring the payload, including payloads that omit empty inventories.

Lua regression tests cover engine refusal, partial hold preparation, discard failure,
foreign hold identity, phase yields and deferred circuit work. Controller tests cover
concurrent duplicate verdicts and uncertain deletion/activation replies. See
[batching and timing](async-processing.md) for the separate performance boundaries.
