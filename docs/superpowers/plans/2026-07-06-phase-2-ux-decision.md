# Phase 2 UX Decision Brief

Status: final decision brief for audit. Do not implement from this file alone; use the Phase 2 implementation plan after audit approval.

## Seven-Line Product Summary

1. Platform transfer is async by design; the happy path is "safe and clear," not instant.
2. The transfer contract is handshake-or-discard: no duplicate live platforms by construction.
3. Passengers aboard at lock time choose "go to Nauvis now" or "wait and follow."
4. During the transfer gap, every passenger physically lands on Nauvis; no player rides inside a hidden destination copy.
5. Followers get a destination teleport prompt only after GO-LIVE; pre-COMMIT rollback can return them to the ship, while post-COMMIT residual failure leaves them on Nauvis with a platform-lost message.
6. Admins get read-only status and stale-hold escalation, not force-resolve buttons or a recovery console.
7. Disaster recovery belongs to the ops layer through backups and save upload, not transfer-protocol improvisation.

## Final Decisions

### Failure Contract

Phase 2 uses a bounded handshake-or-discard contract.

- Source failsafe: unlock only. The source side never deletes itself as a timeout recovery action.
- Destination failsafe: discard only at the handshake deadline.
- Failure reason does not change the terminal compensation rule.
- No duplicate live platforms are allowed, including after controller restart or source/destination crash.
- No force-resolve, no operator attestation, and no admin recovery console belong in this primitive.
- Ops-level disaster recovery remains outside the transfer protocol: dashboard backups, saved-game recovery, and save upload.

The previous unbounded "never discard after COMMIT" idea is superseded by the bounded compensation window. The controller must preserve the two destructive safety gates:

- Immediate abort discard is allowed only if COMMIT was never transmitted by this controller and the source was queried as `pre_commit`.
- Deadline discard happens when the compensation window expires and discards the destination artifact regardless of source reachability.

The COMMIT-transmitted flag is write-ahead hygiene, not the restart-safety proof. Restart safety lives in the source-phase query plus the persisted committed tombstone.

### D1 Resolution

An active destination hold owns the full not-live state:

- destination surface visibility
- destination entity activation
- destination platform pause

`unlock_platform` must not alter any of those axes while a destination hold owns the surface. Protocol ordering still releases the source lock before destination staging as hygiene, but that ordering is not the load-bearing guarantee.

The hold keeps full deactivation. The fluid-lab work cleared the blocker without changing the primitive: the original CI fluid delta is recorded as UNEXPLAINED, eliminated by fixture and meter hardening, and instrumented to self-diagnose if it recurs.

### Recovery Model

Recovery is the controller reconcile loop, as code:

- on boot and periodically, re-adopt persisted pending transfers
- query source phase
- apply the recovery table in `docs/TRANSFER_2PC.md`
- retry with backoff
- discard the held destination at the handshake deadline

All destructive operations remain behind correlation-gated identity checks. The controller never broadens a timeout into "best effort delete the source."

### Passenger UX

At lock time, players aboard the transferring platform see two choices:

- Teleport to Nauvis now.
- Wait and follow this transfer.

Both choices use the existing Layer-1 evacuation path during the gap, so every passenger physically lands on Nauvis before the source is deleted and before the destination goes live. "Wait and follow" persists follow intent keyed by canonical `transferId`.

At GO-LIVE, followers receive a "teleport now" dialog that uses `connect_to_server` to move them to the destination instance. On pre-COMMIT rollback, followers can be returned to the ship with the transfer error. In a post-COMMIT residual failure, there is no source ship to return to; followers stay on Nauvis and see a "platform lost with its host" message. There is no admin step in the passenger path.

The passenger stage is gated on a reachability spike proving whether a client on this cluster can actually be handed to the other instance's game port, what survives of equipped gear, and how `inventory_sync` interacts with the handoff.

### Admin Experience

Admins see read-only observability:

- `/lock-status` extension for active locks and destination holds
- web status on existing rails
- Prometheus escalation for stale holds
- transfer id, phase, age, deadline, source query result, and destination hold state

Admins do not get force-resolve, force-go-live, or manual discard buttons as part of Phase 2. Stale holds escalate; they do not expire independently of the protocol deadline.

## UX Cases

### Happy Path

1. User starts a transfer.
2. Source locks and passengers choose Nauvis now or wait-and-follow.
3. Destination imports, validates, activates, fluid-validates, parks, then enters a hidden paused hold.
4. Source commits and releases.
5. Destination goes live.
6. Followers get the destination teleport prompt.

The visible user story is one platform in motion, a waiting gap, then the destination copy becoming available. It is never presented as instant.

### Destination Fails Before COMMIT

The controller queries the source as `pre_commit`, confirms this controller did not transmit COMMIT, discards the destination artifact, and unlocks the source. Users are returned to the ship with the failure reason.

### Controller Restarts

The controller re-adopts pending transfers, queries source phase, and resumes from the recovery table. It does not trust only an in-memory flag and does not invent an admin decision point.

### Source Permanently Unreachable

The reconcile loop retries during the compensation window. At the handshake deadline, the held destination artifact is discarded. The source is not deleted by the controller.

### Destination Held Too Long

The hold remains hidden, inactive, and paused. Metrics escalate the stale hold. The protocol deadline decides discard; no separate hold expiry exists.

## Scope Boundaries

In scope for the Phase 2 plan:

- hold-aware `unlock_platform`
- source lock phase model and committed tombstone
- reconcile loop and handshake-or-discard wiring
- read-only observability
- crash-point probes
- passenger follow UX after protocol safety is proven
- Phase-0 assumption labs from issue #69 Tier A

Out of scope:

- Phase-2 code implementation before plan audit
- admin recovery console
- force-resolve actions
- changing the destination-hold primitive unless new lab data requires it
- Tier B 2.0.76 to 2.0.77 re-pin sweep, which remains parallel maintenance

## Audit Questions

- Does the brief preserve the no-duplicates contract without creating a hidden admin escape hatch?
- Does it make D1 a code invariant, not a sequencing hope?
- Does the passenger story avoid implying instant transfer?
- Does the failure story clearly separate protocol recovery from ops disaster recovery?

