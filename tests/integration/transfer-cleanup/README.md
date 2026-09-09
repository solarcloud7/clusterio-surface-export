# Source deletion failure acceptance test

This is a fault-injection test of the production transfer route, not a proposed protocol implementation.
The invariant is at most one usable copy, with unchanged item/quality counts, belt-side counts, and fluids.
Platform indexes, ticks, item positions within a belt segment, and travel pause are not invariants.

Run explicitly on idle local instances (no connected players, jobs, locks, holds, or tombstones):

```powershell
node tests/integration/transfer-cleanup/delete-failure.mjs
# Offline analysis of an existing observation; no cluster access:
node tests/integration/transfer-cleanup/delete-failure.mjs --analyze ci-artifacts/transfer-cleanup-<run>.json
# Prove cleanup after a partially completed harness:
node tests/integration/transfer-cleanup/delete-failure.mjs --fail-after-build
# Empty-hub regression and controller restart recovery:
node tests/integration/transfer-cleanup/delete-failure.mjs --empty-hub-control --restart-controller
# Measure whole scheduler callbacks on the same bounded fixture:
node tests/integration/transfer-cleanup/delete-failure.mjs --profile-callbacks
# Empty-hub control without restarting the controller:
node tests/integration/transfer-cleanup/delete-failure.mjs --empty-hub-control
# Offline checks of the evidence analyzer (also included by root npm test):
node --test tests/integration/transfer-cleanup/oracle.test.mjs
```

The runner first transfers a small independent fixture without a fault. It then repeats with a
fixture-scoped exception in `GameUtils.delete_platform`, before actual deletion. The exception does
not alter locks, visibility, activation, validation, cargo, expiry, or the controller verdict. Calls
for any other platform delegate to the original function. The original function is restored in
`finally`. No production hook or debug setting is added. This in-memory injection is not a crash test.

Physical reads enumerate fixture inventories, each isolated belt's two lines, the tank fluid,
surface/platform visibility, an assembler's script activation, and lock/hold state. They do not use
export payload counts or the importer's validation report. A usable copy is visible, script-enabled,
and neither locked nor held. Travel pause does not stop machines and is recorded separately.
An idle assembler has no recipe and cannot consume or produce the measured cargo.

The normal transfer must preserve these physical readings and delete the source. The fault run
must reach its intended deletion boundary; failure to inject is a harness error. Two usable copies
with the original cargo is a reproducible invariant failure, even if the UI says `cleanup_failed`.

Bounds: Factorio 2.1.17; at most two transfers per invocation, 90 seconds/60 polls per transfer,
20 seconds per fixture RCON process, 32 KiB per fixture command and 64 KiB per fixture result.
Shared preflight and instance-ID helpers retain their existing 180-second command timeout;
registry reads retain the shared helper's timeout. A poll deadline does not interrupt an in-flight command.
Construction uses 425 tiles,
a hub, chest, tank, assembler, and two isolated belts. No global pause, save reset, expiry-clock
rewrite, or production configuration change. Pre-existing platform identities are checked afterward.
Cleanup restores the function first, waits for jobs to drain, removes only named owned fixtures,
and independently checks for remaining surfaces/locks/holds/tombstones. If cleanup cannot safely
finish, it reports HARNESS_ERROR and retains evidence; it never deletes a surface with active jobs.

Artifacts include source hashes, engine/module/mod versions, raw physical readings, fault-call
evidence, canonical operation IDs, controller outcomes, and cleanup results. Verdicts are PASS,
STOP (validly observed invariant violation), or HARNESS_ERROR. Both non-PASS outcomes exit 1.
The cleanup-injection mode is deliberately a HARNESS_ERROR when its injected exception occurs;
its `cleanup` field must independently pass.

`run-tests.mjs` includes this acceptance test in normal integration discovery. The controller's expected
`cleanup_failed` outcome does not satisfy the test: independent physical observations must pass the oracle.
After two fault observations, the runner removes the injected fault and waits for the controller's
ordinary recovery worker to complete the same canonical transfer. It checks source absence, destination
usability and exact physical cargo again. The normal leg also replays source deletion and destination
release and verifies unchanged cargo. Integration discovery runs the populated-hub case followed by an
empty-hub case that restarts only the controller while the handoff is unresolved.
The source replay supplies the UID captured from the locked source in the same Lua
callback that starts the transfer. It does not infer identity from a deleted platform
or manufacture a UID from the destination. The artifact retains `sourcePlatformUid`.
Abrupt crashes, lost acknowledgements, TTL expiry and restoration of older saves remain separate live
acceptance cases. The controller unit suite covers lost replies and concurrent duplicate verdicts.
Callback profiling raises only the fixture response cap to 256 KiB; see the
[probe contract](../../instruments/callback-profile/README.md) for its measurement limits.

## Original failure observed on 2026-09-08

Factorio 2.1.17, save-patched module 0.10.281:

- Control `836570928:181_transfer-cleanup-mtsm5wgv-baseline`: completed, source absent,
  destination usable, exact physical cargo parity.
- Fault `836570928:182_transfer-cleanup-mtsm5wgv-fault`: `cleanup_failed`. The fault fired
  before deletion. Source and destination were each visible, script-enabled, unlocked, and unheld
  in two sequential observation rounds. Both local tick counters advanced independently.
  Each copy retained 54 items (including 4 belt items with their quality and side preserved),
  123 water at temperature 15, and the six expected entities. Verdict: **STOP**.
- Artifact: `ci-artifacts/transfer-cleanup-mtsm5wgv.json`. Both owned fixtures removed, function
  restored, both hosts unpaused with zero jobs/locks/holds/tombstones, pre-existing platform
  identities unchanged. This observation predates the production fix below.

The source-delete handler called `unlock_platform` before `GameUtils.delete_platform` on this
path. The injection-time reading already shows the source unlocked and script-enabled.
The destination has already been activated when this deletion request arrives. This reproduces
the two-copy failure without shortening a TTL or forcing any activation state.
Observations are sequential RCON reads, not synchronized cross-machine snapshots.

An earlier empty-hub control (`836570928:180_transfer-cleanup-mtsjs4tj-baseline`) failed validation
with `space-platform-foundation: unexpected item (got 10)`; rollback succeeded. Its raw artifact
is `ci-artifacts/transfer-cleanup-mtsjs4tj.json`. The deletion fault was **not tested** in that run.
The normal fixture retains its ten starter foundation items to exercise the deletion boundary.
`--empty-hub-control` instead uses a literal empty-hub cargo contract. Both variants now run in
integration discovery. A failed control remains a failed prerequisite (HARNESS_ERROR), with the
actual controller failure retained rather than claiming the deletion fault was tested.

This is one live deletion-fault reproduction. Offline analyzer tests are not additional live trials.
No universal zero-loss, crash-safety, or production-readiness claim follows from this bounded test.

CI run `34302612345` on `582a211` exposed an outdated caller in this harness: the
baseline transfer completed, source absence and destination cargo checks passed, but
the replay omitted the newly required retirement UID. This was `HARNESS_ERROR` with
successful cleanup; the injected deletion-failure leg was not reached. The harness
now reuses the original source UID and surfaces Lua refusal text in assertion errors.

The final fixture's injected construction-failure cleanup passed in
`ci-artifacts/transfer-cleanup-mtsmbjbf.json`. Its intentional error exits 1; `cleanup.success` is true.
Forty API members were checked against the pinned official 2.1.17 schema; signatures and the probe
hash are retained in `ci-artifacts/transfer-cleanup-api-check.json`. Inventory access tolerates
missing indexes, transport lines are read only for transport belts, fluid methods only for the tank,
and the activation canary only for the assembler. These schema checks certify API shape, not transfer safety.
Controller transaction history is retained as evidence; physical cleanup does not erase the failed operation.

## Fix verification

Earlier hold-only implementation: `ci-artifacts/transfer-cleanup-mtsown16.json` — **PASS**. Control
`836570928:187_transfer-cleanup-mtsown16-baseline` completed; fault
`836570928:188_transfer-cleanup-mtsown16-fault` retained the hold, preserved exact cargo, and allowed
only the source to become usable after explicit source unlock. Cleanup passed. All eleven recorded
implementation hashes identify that tested revision. This run includes the partial-stage, hold-identity,
and engine-refusal corrections. Deployment saved backups and verified the existing worlds afterward.

`ci-artifacts/transfer-cleanup-mtso68sl.json` passed the unchanged cargo/usability oracle:

- Normal control `836570928:183_transfer-cleanup-mtso68sl-baseline` completed with source absent and destination usable.
- Injected failure `836570928:184_transfer-cleanup-mtso68sl-fault` retained the source lock and destination hold.
  Both physical readings retained exact cargo parity. Explicit source unlock restored one usable source;
  the destination remained held and unusable. All owned fixtures and holds were removed afterward.
- The construction-failure cleanup probe passed in `ci-artifacts/transfer-cleanup-mtso4r5y.json`.
- Source deletion, partial staging failure, refused discard, and held latch scheduling have executable Lua
  regressions in `tests/lua/source-delete-gate.lua` and `tests/lua/destination-transfer-gate.lua`.
  Six independent in-memory removals of their protections made those tests fail; evidence is in
  `ci-artifacts/transfer-gate-mutations.json`. No production file was changed for those mutation checks.

Those earlier runs tested explicit source unlock; they did not test automatic recovery.

The empty-hub correction passed on Factorio 2.1.17 in
`ci-artifacts/transfer-cleanup-mtsqitu4.json`: control 189 completed with the hub empty;
fault 190 retained exact physical cargo, source lock and destination hold. The populated-hub
control and failure test also passed (`ci-artifacts/transfer-cleanup-mtsqk1yy.json`, jobs 191/192).
Both runs removed their temporary platforms, restored the fault hook and preserved existing worlds.
Import setup now clears generated starter cargo before any payload restoration. This changes neither
the validation expectations nor the serializer's omission of empty inventories.

Review also added regressions for a colliding hold ID (cleanup must not discard another platform),
and an engine `delete_surface` refusal (both Lua adapters must preserve `false`, rather than acknowledge
successful deletion). The latter test failed against the old adapters before the fix.
The full integration runner's golden-save preflight does not match the current local placement of
`oneofeach-fixture-v1` on host-2; local acceptance uses this suite's own idle/world-preservation preflight.
Full integration runs use the freshly seeded CI cluster rather than rearranging existing local worlds.

## Recovery verification (2026-09-08)

Final deployed acceptance passed in `ci-artifacts/transfer-cleanup-mtsshyoa.json` (jobs 201/202,
populated hub) and `ci-artifacts/transfer-cleanup-mtssiqe4.json` (jobs 203/204, empty hub and
controller restart). Both verified receipt replay, exact physical cargo, recovery and cleanup.
Four separate in-memory removals of receipt protections made the Lua tests fail; production files
were unchanged (`ci-artifacts/receipt-mutations.json`). A controller regression also refuses required
persistence when the exact intent is missing, rather than accepting an empty persisted store.

The controller restart case passed in `ci-artifacts/transfer-cleanup-mtss2gvh.json`:
control 197 completed; fault 198 first retained both protections, then completed the same canonical
transfer after controller restart. Independent reads found the source absent, the destination usable,
and unchanged item/quality, belt-side and fluid cargo. Receipt replay and final fixture cleanup passed.

The preceding attempt, `ci-artifacts/transfer-cleanup-mtsruw3z.json`, was a harness failure with clean
fixture removal: recovery never ran because Clusterio does not invoke a controller `onStart` hook.
Recovery now starts from the actual `init` hook; a regression checks that lifecycle connection.

`ci-artifacts/transfer-cleanup-mtsqusla.json` separately verified held-state survival across a graceful,
save-preserving Factorio reload. Neither test proves durability through an abrupt process loss or an
older save. Receipts are bounded and save-local; see [handoff and recovery](../../../docs/TRANSFER_2PC.md).

The callback-profile run `ci-artifacts/transfer-cleanup-mtss5rbi.json` also passed ordinary recovery.
It recorded two source callbacks (maximum 11.305 ms) and eighteen destination callbacks (maximum
9.502 ms), without truncation. These are whole scheduler invocations for a six-entity fixture, including
nested profiling. RCON setup is outside that boundary. This verifies the measurement path, not a
large-platform performance limit or instrumentation overhead improvement.
