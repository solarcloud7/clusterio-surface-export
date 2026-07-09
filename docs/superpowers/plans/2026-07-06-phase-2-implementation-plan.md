# Phase 2 Implementation Plan

Status (updated 2026-07-08): APPROVED with amendments A1-A5 (audited 2026-07-06). Merged: PR-0A (#70,
hold-completeness lab), PR-0B (#71, no-tick-sync rung), PR-1 (#73, hold-aware unlock), PR-2 (#75, source phase
model). Phase-0 hold-completeness gate PASSED on the corrected not-live bar. Inserted debt-paydown: composite
transfer verdict V1 (PR #76, in review) — its fluid-gate threshold fix is gated on LAB-A of
`2026-07-08-empirical-test-backlog.md`. Next: PR-3 (detailed executor plan:
`2026-07-08-pr-3-protocol-wiring-plan.md`; starts after #76 merges). PR-0C remains a scheduled non-blocker.

Source of truth: `docs/TRANSFER_2PC.md` on converged main after PR #68, plus issue #69 Tier A assumption sweep.

## Product Contract

Phase 2 changes platform transfer into a bounded, async handshake:

`PREPARE -> VOTE -> COMMIT -> RELEASED -> GO-LIVE`

The destination copy is never live before the source has committed and released. If the handshake cannot finish by the deadline, the destination artifact is discarded. The source timeout path is unlock-only. This is the no-duplicates guarantee.

## Global Non-Goals

- Do not add a force-resolve path.
- Do not add an admin recovery console.
- Do not wire passenger follow before protocol safety is proven.
- Do not weaken destructive identity checks.
- Do not broaden this plan to the Tier B 2.0.76 to 2.0.77 re-pin sweep; track it as parallel maintenance.

## Phase 0: Assumption Labs Before Wiring Approval

Purpose: prove the remaining engine assumptions that Phase 2 makes load-bearing before any protocol wiring can rely on long-held destination platforms.

### PR-0A: Hold-Completeness Lab

Blocking for protocol wiring.

Question: Does a destination hold keep the whole platform non-live over a long hold window, not merely item/fluid counts?

Correct not-live bar: no observable side effects, held drift no worse than live-control drift, zero platform damage, nothing leaves the platform, and staged platforms are pod-free. It does not require frozen time.

Tasks:

1. Add a lab runner following the PR #68 lab discipline: isolated fixture, reset action, tick-stamped readings, both direct and aggregate meters where applicable, zero-leftover assertion.
2. Measure spoilage progression during a long hold against a live control.
3. Measure asteroid collision or damage exposure during a long hold against a live control.
4. Measure cargo-pod descent and landing behavior while the platform is held.
5. Include the cargo-pod overflow branch from issue #69's checklist; label the live specimen state exactly (`awaiting_launch`, `descending`, or `parking`) and do not promote an unconstructed state as empirical evidence.
6. If cargo pods advance under pause, close it mechanically by reusing the source-lock cargo-pod completion helper in `DestinationHold.stage()`; do not reimplement the helper.
7. Record every result in the lab notebook, including failed specimens and unconstructible cases.
8. Promote durable facts to api-notes with evidence tags only after the lab result is stable.

Acceptance:

- The held platform remains hidden, inactive, paused, and non-live under the corrected bar, or the plan stops for redesign.
- A staged held platform is pod-free, and any pod overflow cargo remains on the platform.
- Lab cleanup proves no lab platforms or `storage.fluid_lab`-style state remains.
- The notebook distinguishes empirical facts from hypotheses and uses UNEXPLAINED honestly if needed.

Verification:

- New focused lab command documented in the notebook.
- `npm run lint:lua`
- `npm run lint:test-grounding`
- Zero-leftover assertion from the lab output.

### PR-0B: No-Tick-In-Synchronous-Pass Rung

Blocking for strict-gate wiring.

Question: Does the synchronous pass relied on by the strict gate avoid advancing game ticks?

Tasks:

1. Build the cheapest single-session rung that captures `game.tick` before and after the synchronous pass.
2. Assert no tick advance across the pass.
3. Assert the proxy state does not move across the pass: `crafting_progress` and held-item counts stay unchanged.
4. Record the result in the lab notebook and promote it only if the rung is deterministic.

Acceptance:

- Same-session proof that the synchronous pass does not tick.
- Same-session proof that `crafting_progress` and held-item counts do not swing across the pass.
- If the tick advances or the proxy state moves, stop and redesign the strict gate before Phase 2 wiring.

Verification:

- Focused rung command.
- `npm run lint:lua`
- `npm run lint:test-grounding`

### PR-0C: Hidden-Semantics Semi-Manual Rung

Scheduled, not a wiring blocker.

Question: What does a connected player actually perceive when a platform is hidden and held?

Tasks:

1. Define a semi-manual connected-player script with exact setup and expected observations.
2. Test remote view, platform list visibility, dialogs, and any player-facing platform references.
3. Record results in the notebook with manual evidence notes.
4. File follow-up issues for UX polish if the observations are confusing but not duplicate-producing.

Acceptance:

- A future agent can repeat the semi-manual check.
- Any unsafe exposure becomes a blocker; confusing-but-safe exposure becomes UX backlog.

Verification:

- Notebook entry with tick, instance, player, and observation context.
- No automated-gate requirement unless the semi-manual result finds a safety issue.

## PR-1: Hold-Aware `unlock_platform`

Ships first and alone after Phase 0 blockers pass. No protocol wiring.

Goal: make the D1 decision a code invariant.

Tasks:

1. Teach `SurfaceLock.unlock_platform` to detect an active destination hold for the same surface.
2. While a hold owns the surface, unlock must not restore:
   - surface visibility
   - entity active states
   - platform pause
3. Preserve source-lock cleanup behavior and existing identity tripwires.
4. Keep ordering hygiene out of this PR; this PR is ownership only.
5. Add selftest teeth that fail red if the guard is removed.

Acceptance:

- Unlock over a held surface leaves it hidden.
- Unlock over a held surface leaves activatable entities inactive.
- Unlock over a held surface leaves the platform paused.
- Unlock for non-held platforms keeps existing behavior.

Verification:

- `node --test test/destination-hold.test.cjs`
- `npm run lint:lua`
- `npm run lint:pcall-logging`
- `npm run lint:test-grounding`
- `npm run lint:test-hooks`
- `docker exec surface-export-host-1 sh -c 'cd /clusterio/external_plugins/surface_export && npm test'`
- `/di-change` checklist, because this touches lock/unlock safety.

## PR-2: Source Phase Model And Query Message

Goal: give the controller a restart-durable source-phase oracle.

Tasks:

1. Extend the source lock model from `pre_commit` to `committed`.
2. Add a committed tombstone keyed by canonical transfer id.
3. Bound committed-tombstone retention to at least the deadline window plus a generous margin, then age-prune it using the same pattern as `pendingTransfers`.
4. Treat locks and `pendingTransfers` records written before the phase model existed as `pre_commit`: nil-guarded, unit-tested, and fail-closed so no commit-dependent action can fire from legacy data.
5. Add `GetSourceTransferLockStateRequest`.
6. Return all five states:
   - `pre_commit`
   - `committed`
   - `source_gone_matching_transfer`
   - `unknown/offline`
   - `identity_mismatch`
7. Persist the COMMIT-transmitted marker write-ahead as hygiene, without using it as the only destructive gate.
8. Add message round-trip coverage and source-state unit tests.

Acceptance:

- Controller can distinguish abort-safe `pre_commit` from committed or identity-mismatched states.
- Reused platform index or name mismatch is fail-closed.
- The committed tombstone survives restart and is age-pruned after the retention window.
- Legacy phase-less locks and pending-transfer records are interpreted as `pre_commit` and cannot trigger commit-dependent actions.

Verification:

- `npm test`
- `node --test test/messages.roundtrip.test.cjs`
- Focused source-lock selftest.
- `npm run lint:lua`
- `npm run lint:pcall-logging`
- `/di-change` checklist, because source phase controls destructive compensation.

## PR-3: Protocol Wiring And Reconcile Loop

Goal: wire Phase 2's transfer spine without passenger follow UX.

Tasks:

1. Implement controller phases:
   - PREPARE
   - VOTE
   - COMMIT
   - RELEASED
   - GO-LIVE
2. Stage the destination through `DestinationHold` only after full finalization:
   - import
   - item validate
   - activate
   - fluids
   - fluid validate
   - park
   - vote
3. Flip source phase to committed before evacuation and delete.
4. Release source lock before destination GO-LIVE as protocol hygiene.
5. Re-adopt pending transfers on boot and periodically.
6. Query source phase and apply the recovery table from `docs/TRANSFER_2PC.md`.
7. Retry with bounded backoff.
8. Define deadline constants and document their relation to the source TTL. No ordering constraint is required because a staged copy is never live.
9. Implement both discard gates:
   - immediate abort discard only when COMMIT was never transmitted by this controller and source queried `pre_commit`
   - deadline discard after the compensation window expires
10. Keep every destructive act behind existing correlation-gated identity checks.
11. Document deploy-boundary behavior for transfers in flight across this change: on this cluster, `patch-and-reset` wipes saves, so in-flight Phase-1 transfers across the deploy are not supported; perform a cluster-wide deploy boundary.

Acceptance:

- Normal transfer completes through GO-LIVE with no duplicate live surface.
- Focused scenarios physically assert the contract meter: no both-live platform count across both instances.
- Controller restart re-adopts and resumes or compensates according to source phase.
- Destination artifacts self-resolve by deadline.
- Source timeout path remains unlock-only.

Verification:

- `npm test`
- `node --test test/destination-hold.test.cjs`
- `npm run lint:lua`
- `npm run lint:pcall-logging`
- `npm run lint:test-grounding`
- `npm run lint:test-hooks`
- Focused integration section for happy path.
- Focused integration section for controller-restart re-adoption.
- Focused integration sections for abort and deadline discard.
- Physical no-both-live assertion after every focused scenario, counting live platforms on both instances.
- Full integration pass only after focused sections are green.
- `/di-change` checklist.

## PR-4: Read-Only Observability

Goal: expose state without adding operator mutation paths.

Tasks:

1. Extend `/lock-status` with destination hold state, phase, age, deadline, transfer id, source query result, and what the reconcile loop last did and will try next.
2. Add web status on existing rails.
3. Add Prometheus escalation for stale holds.
4. Register new terminal outcomes, including `deadline_discard`, through the existing `recordOperationOutcome` metrics chokepoint.
5. Make stale holds escalate, never expire outside the protocol deadline.
6. Document that ops disaster recovery is backups/save upload, not transfer-protocol force-resolve.

Acceptance:

- Admins can see what is stuck and why.
- No force-resolve, force-go-live, or manual discard action exists in the admin surface.
- Metrics identify stale holds without changing state.
- Terminal outcomes, including `deadline_discard`, flow through `recordOperationOutcome` rather than a side-channel.

Verification:

- `npm test`
- Web/status focused tests where existing harness permits.
- `npm run lint:lua`
- `npm run lint:test-grounding`
- Read-only status integration check.

## PR-5: Crash-Point Probe Matrix

Goal: prove every documented recovery row against the real cluster.

Tasks:

1. Implement probe sections for every row in `docs/TRANSFER_2PC.md`'s failure table.
2. Add the two required rows:
   - destination VOTEs, then hard-kills pre-save
   - destination GO-LIVE-acks, then hard-kills pre-save
3. Mark where deadline discard now self-resolves a case.
4. Follow AGENTS.md integration-probe discipline:
   - section selection
   - cheap fixtures unless fidelity is measured
   - no per-iteration restarts
   - derived counts
   - zero-leftover assertions
   - predicates scoped only to `surface-export-*`
5. Include post-run zero-state evidence for holds, locks, desthold surfaces, and game paused state.

Acceptance:

- Every recovery-table row has a probe result.
- Restart sections are reserved for final evidence passes.
- A full "green" claim requires two consecutive full green runs and zero-leftover evidence.

Verification:

- Focused section runs while iterating.
- Two consecutive full integration probe runs only as final evidence.
- `npm run lint:test-grounding`
- `npm run lint:test-hooks`

## PR-6: Passenger Follow UX

Ships after protocol safety and crash probes. Passenger path has no admin involvement.

Phase-0 spike inside this PR:

1. Prove whether a connected client can be handed to the other instance's game port with `connect_to_server`.
2. Record what survives of equipped gear.
3. Record how `inventory_sync` interacts with the handoff.
4. Stop or redesign if the cluster cannot actually hand off a client.

Implementation tasks after spike passes:

1. At source lock time, present aboard players with:
   - teleport to Nauvis now
   - wait and follow
2. Persist follow intent keyed by canonical `transferId`.
3. Use existing Layer-1 evacuation so both choices physically land on Nauvis during the gap.
4. At GO-LIVE, show followers a teleport-now dialog.
5. On pre-COMMIT failure or rollback, return followers to the ship with the transfer error; in a post-COMMIT residual failure, leave followers on Nauvis with a "platform lost with its host" message because no source ship remains.
6. Add copy that does not promise instant transfer.

Acceptance:

- Passengers never block transfer.
- Passengers are never stranded in a hidden destination copy.
- Followers can reach the destination only after GO-LIVE.
- Rollback path is understandable to the player and requires no admin action.

Verification:

- Passenger evacuate regression.
- New passenger follow integration or semi-manual client proof, depending on `connect_to_server` testability.
- `npm run lint:lua`
- `npm run lint:test-grounding`
- `npm run lint:test-hooks`

## PR-7: Final Documentation And Release Gate

Goal: align docs with the implemented protocol and close the plan.

Tasks:

1. Update `docs/TRANSFER_2PC.md` from planned to implemented where evidence supports it.
2. Add final UX copy and admin observability docs.
3. Record remaining limitations and parallel maintenance items.
4. Run the full verification set.

Acceptance:

- Docs no longer describe superseded Phase-1 behavior as current.
- Every evidence claim points to a passing test, probe, or lab notebook entry.
- Tier B re-pin sweep remains explicitly parallel, not smuggled into Phase 2.

Verification:

- `npm test`
- `node --test test/destination-hold.test.cjs`
- `npm run lint:lua`
- `npm run lint:pcall-logging`
- `npm run lint:test-grounding`
- `npm run lint:test-hooks`
- `docker exec surface-export-host-1 sh -c 'cd /clusterio/external_plugins/surface_export && npm test'`
- Required full integration probes from PR-5.

## Audit Checklist Before Coding

- Phase 0 blockers are real gates, not documentation chores.
- D1 is handled before any Phase 2 wiring.
- The immediate-abort gate depends on source-phase query, not transmit flag alone.
- Destination staging happens only after full finalization.
- Admin surfaces are read-only.
- Passenger follow is last and depends on a real `connect_to_server` spike.
- The plan keeps Tier B outside this scope.
