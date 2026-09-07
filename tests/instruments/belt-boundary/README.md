# Belt boundary insertion probe

## Connected-network batching acceptance (2026-09-07)

Belt restoration now yields between independent connected networks. Both lanes,
splitter branches and underground partners stay together. A 500-work-unit target
is soft: large networks, unsupported types and external connections remain atomic.
Transport belts are not frozen across callbacks. Consumers stay inactive through
restoration; each network is inserted and physically checked before yielding.

`node tests/instruments/belt-boundary/run-helper.mjs --installed --batched` tested
19,700 items in seven callbacks with long tick gaps. At each callback, the newly
written network's captured position/name/quality/count tuples matched exactly, and
all previously completed networks retained their expected cargo totals. Zero
unplaced items or structural anomalies. Moving within a completed network is allowed;
the contract does not require its positions to remain frozen during later callbacks.
The 32-callback bound and cleanup pre/postflight checks passed.
Evidence: `ci-artifacts/belt-helper-batched-result.json`.

`node tests/integration/belt-item-state/roundtrip.mjs --profile-batches --reject-last`
then exercised production scheduling, controller transfer and recovery on one disposable
clone. It restores the previous debug settings and independently checks clone removal.

| Operation | Result | Belt batches / elapsed ticks | Execution ms | Longest belt callback ms |
| --- | --- | --- | --- | --- |
| `836570928:115_belt-roundtrip-1788762152298` | Completed to host 2 | 7 / 6 | 83.169 | 37.777 |
| `902099405:057_belt-roundtrip-1788762152298` | Completed back to host 1 | 7 / 6 | 91.436 | 54.004 |
| `836570928:117_belt-roundtrip-1788762152298` | Forced validation rejection; rollback acknowledged | 7 / 6 | 107.909 | 64.838 |

Each phase also recorded seven distinct work ticks. Debug batch records confirm
same-tick work has nonzero measured execution, and phase envelopes include waits.
Source deletion was checked for successful legs; rejection preserved the source and
removed the destination. All jobs, locks, holds, tombstones and test clones were clear.
The earlier 115–126 ms single-callback measurements included success tracing; these
are observations from different runs, not a controlled estimate of batching's speedup.
Other synchronous phases and large networks can still cause lag.

`836570928:120_beltstate-mtquukvy` additionally passed physical readback of eight
non-default item states through a full transfer. Stored counters matched, with zero
unmatched, failed, declined or merged state. Deployed self-tests passed 27 checks;
unit tests passed 643 with eight skipped. Backups before deployment:
`predeploy-20260907-021915-596.zip` on each host.
Evidence: `ci-artifacts/belt-batching-{roundtrip.json,item-state.log,selftest.json,unit-tests.log}`.

Harness mistakes remain separate evidence: `game.create_profiler` was corrected to
the pinned `helpers.create_profiler`; batched artifact serialization initially made
a circular reference; the first full rollback assertion used `type` instead of
`eventType`. Each owned fixture was cleaned up. Corrected runs passed. None of those
harness errors is counted as a production restoration failure.

The component profiler probe (`--installed --profile`) measured about 24 ms placement,
30 ms after-census, and 90 ms successful diagnostic work in its original traced run.
Success-only position tracing is now opt-in via `surface_export.belt_trace`; physical
census, item-state checks and failure diagnostics remain enabled.

## Earlier placement integration (2026-09-07)

The tested placement method is now used by the production helper through
`VersionCompat.belt_force_insert_at`. Captured coordinates are preserved, out-of-range positions
are rejected instead of clamped, and coordinate searching and merge fallback are removed. The
structural census, item-state handling, exception-to-verdict path and import scheduling remain.
The old `merge_discarded` metric remains readable for historical records; new restores never merge.

Local deployment preserved both saves, with backups named `predeploy-20260907-012314-992.zip`.
The deployed self-test passed 21 checks, including incorrect physical placement, a no-op insertion,
out-of-range rejection, separate compressed stacks, and blueprint/book state and refusal paths.

Three production transfers passed:

- `836570928:103_beltstate-mtqsq2bj`: a disposable fixture clone with six armed item-state rows
  plus two same-item stacks with distinct health. Destination physical readbacks and persisted
  counters agreed: eight applications, zero unmatched, failed, declined or merge-discarded state.
- `836570928:106_belt-roundtrip-1788758774956`: host 1 to host 2; item/fluid and overall validation
  passed, the destination existed, and the source was deleted.
- `902099405:052_belt-roundtrip-1788758774956`: the same clone back to host 1; the same checks passed.

Both disposable clones were removed. The protected originals were not transferred. Final checks
reported no jobs, locks, holds, tombstones, players or active pauses. The round-trip platform ran
normally between requests, so totals between the two separate exports are not asserted equal;
each transfer independently matched its own source evidence.

Entity creation still used 28 batches across 28 work ticks in each round-trip import. Belt items
were restored in one callback (about 115â€“126 ms measured execution), as before. Spreading the belt
phase itself across ticks remains a separate scheduling change and is not claimed here.

Evidence: `ci-artifacts/force-insert-selftest.json`, `force-insert-transfer-state.log`,
`force-insert-roundtrip.json`, `force-insert-unit-tests.log` (641 passed, eight skipped).
Rerun the full production round trip with `node tests/integration/belt-item-state/roundtrip.mjs`.
For the isolated helper ladder after integration, add `--installed` to `run-helper.mjs`; this
compares the current helper against the saved `ci-artifacts/belt-helper-baseline.lua` and writes
separate installed-result artifacts. The pre-integration evidence below remains historical.

## Real-helper results (Factorio 2.1.17, 2026-09-07)

The isolated candidate passed the entire declared ladder. The baseline used the actual current
`restore_side_groups` helper and reproduced two structural anomalies with 68 placed items and
zero unplaced items. The candidate used the same helper and its 11 bundled modules, with only
the placement changes described below. No deployed restoration file was edited.

| Arm | Observed result |
| --- | --- |
| Baseline boundary replay | Two structural anomalies reproduced |
| Candidate boundary replay, three fresh repetitions | Exact 17-stack / 68-item restoration each time; zero anomalies |
| Stateful and quality fixture | Eight exact stacks; seven state applications; no unmatched, failed, discarded or declined state |
| Entire retained belt geometry | Exact 5,772 stacks / 19,700 items; zero unplaced items or structural anomalies |

The full geometry contains 453 transport belts, 140 underground-belt entities and three splitters
across 300 captured side groups. The oracle matched group, source entity identity, line, position,
item, quality and stack count. The state fixture additionally preserved two pistols on one line
with different health (0.25/0.75), weapon health, ammunition, repair-pack durability, blueprint
label and decoded two-entity contents, bioflux spoilage, and legendary item quality.

The three boundary candidate callbacks ran at ticks 17336557, 17336672 and 17336786; the state
fixture at 17336900 and the full geometry at 17337015. Each start tick equaled its end tick.
These are tick observations, not execution-time measurements. No settling ticks were allowed
with items present. All seven disposable surfaces and the temporary module/input storage were
removed. Both hosts ended with zero jobs, locks, holds, tombstones and players, and were unpaused.

Artifact: `ci-artifacts/belt-helper-result.json`; generated candidate:
`ci-artifacts/belt-helper-candidate.lua`.
Experiment hash: `add837267a1b34eac2a000537659328b7ecc77b88a2c901273e366e5c388fdf9`.
Candidate hash: `2d5477c0f9335ad58d75bf5b6a41d29514085a20da0af20138acc3e73b38acad`.
The runner also requires the retained `ci-artifacts/recurrent-failure-blackbox.json` and pinned
`ci-artifacts/belt-boundary-api.json`; it refuses a different operation ID or engine version.

This supports replacing the placement search and merge fallback. It does not establish full
transfer acceptance: controller routing, export/import scheduling, activation, rollback, loaders,
other engine versions, negative inputs and other item-state types remain untested here. No
performance improvement is claimed. The next rung is the candidate integrated into the normal
pipeline and exercised on disposable full-platform transfers, retaining the structural gate.

## Real-helper experiment contract (2026-09-07)

`node tests/instruments/belt-boundary/run-helper.mjs --prepare` checks the pinned schema and
builds an isolated candidate from the actual restoration source. No deployed file changes.
Without `--prepare`, the runner uploads a temporary, ownership-tagged bundle of that helper and
its real dependencies. `--analyze` reads saved results without cluster calls.

The candidate changes only placement: force-insert at the captured position, reject out-of-range
positions, and remove alternate-coordinate searches and stack merging. Capture, item-state
application and structural validation stay intact. The invariant is exact physical
group/entity/line/position/name/quality/count equality; stateful rows additionally compare physical
health, ammunition, durability, spoilage and decoded blueprint contents. Runtime unique IDs may
change. No belt advancement, spill, recovery or merging may satisfy the oracle.

Bounded ladder: injected cleanup failure; actual helper baseline on the known boundary fixture;
three fresh candidate repetitions; eight stateful/quality stacks on seven isolated belts; then
the retained failure's entire belt-only geometry (596 entities, 300 groups). Stop on any failure.
The last rung is a belt-phase replay, not a complete controller transfer. Full export/import,
activation, rollback and loaders remain outside its proof. Every insertion/readback arm executes
within one callback after empty geometry has settled. Exact tuple comparison is independent of
the helper's own counters. Both hosts must be idle, with no players or outstanding lab state.

Budgets: seven disposable surfaces, at most 596 entities per surface and 6,000 slots per arm,
1 MiB uncompressed upload, 12 KiB per upload command, 8 MiB result and 180-second RCON timeout.
No user platform is modified. Cleanup runs after exceptions and is checked in a separate callback;
temporary storage is removed and both hosts checked again in `finally`. Module, candidate,
observer and fixture sources are hashed into `ci-artifacts/belt-helper-result.json`.

Harness correction: two initial runs refused the `disabled_by_script` readback, including
immediately after writing it. The pinned API states that non-updatable entities ignore that write;
the harness therefore does not use it as a movement barrier. Construction settles while empty.
All operations with items present run in one non-yielding callback, with equal start/end ticks
required. This does not certify freezing belts across ticks. Both initial runs cleaned their
surfaces and temporary storage; their artifacts are retained as harness errors, not candidate
failures.

Candidate experiment: `node tests/instruments/belt-boundary/run-tests.mjs --candidate` uses six
fresh disposable surfaces: cleanup proof, shape smoke, three failing baseline replays and one
`force_insert_at` candidate. All three baseline runs must reproduce the same 13th-insertion
failure before the candidate runs. This experiment permits force insertion only in the candidate
arm, using captured positions without the speed subtraction or alternate-position search. It
requires exact final entity/line/position/item/quality/stack-count equality for all 17 captured
stacks as well as correct per-write group deltas. No source stack has non-default item state, so
passing this fixture cannot certify blueprint, spoilage, durability or other item-state fidelity.
Outputs are saved separately in `ci-artifacts/belt-boundary-force-result.json`; use `--candidate
--analyze` to inspect them without RCON. Production restoration is unchanged.

## Candidate result, 2026-09-07

On Factorio 2.1.17, all three fresh baseline fixtures reproduced the same failure at insertion 13:
entity 50106, line 2, source position 246/256, requested insertion 214/256, accepted write, group
counts `[48,0] -> [48,4]`. Their insertion callbacks ran at ticks 17239929, 17240040 and 17240153;
each callback's start and end ticks matched. This is a repeatable engine-level reproduction of
the current insertion loop, not a test that moves the user's platform.

Only after those baselines passed their expected-failure assertions did the force-insertion arm
run. It completed all 17 insertions with final group counts `[52,16]` and 68 rockets total. The
independent final comparison matched all captured entity IDs, lines, positions, names, qualities
and stack sizes exactly, including five stacks on entity 50106. Candidate start/end tick: 17240265.
The cleanup exception, shape smoke and independent absence checks passed for all six surfaces;
both hosts finished with no jobs, locks, holds, tombstones, connected players or active pause.

Result artifact: `ci-artifacts/belt-boundary-force-result.json`.
Runner/fixture/observer hash: `4515434c0e7b639df23aa42166286231e41e7c7dad7b5426587afcf2e813188e`.
The first attempt was refused offline because the API checker did not traverse inherited
`LuaQualityPrototype.name`; no live mutation occurred on that attempt. The checker now follows
prototype inheritance.

Scope of proof: three failing baseline runs and one exact candidate pass for this small straight-
belt junction fixture. Production restoration, non-default item state, splitters, underground
belts, loaders and the full transfer/rollback path are NOT TESTED by the candidate. The next rung
is integration through the real restoration helper and a disposable full-payload replay while
retaining the existing structural gate.

Contract: on Factorio 2.1.17, observe whether each successful insertion adds its four rockets to
the captured side group. Preserve item identity/count and group membership; exact spacing is
observed, not an acceptance condition. No merging, spills, recovery, cloning, force insertion or
simulation ticks may make the baseline pass. No production transfer or scheduler changes.

The fixture is the two discrepant groups from operation `836570928:099_lab-transfer-fixture-v1`
plus neighboring straight belts needed for the side-feeding geometry. The source is the retained
`failure_black_box_lab-transfer-fixture-v1_16979845.json`. It contains no inventories or credentials.

Run `node tests/instruments/belt-boundary/run-tests.mjs` with both local instances idle.
Requires `ci-artifacts/belt-boundary-api.json` from the official 2.1.17 runtime API schema.
The API manifest is checked offline. The actual constructor, observer, runner and fixture are
hashed together. A deliberate exception proves cleanup, then a shape smoke precedes one baseline
replay. Empty belts are constructed in an earlier callback so the engine can join their internal
segments, matching the batched import. Every measured insertion occurs in one later RCON callback
with before/after contents and tick readings.
Stop at the first successful insertion whose physical group delta is not four.

Budget: three disposable surfaces, at most 17 successful insertions per replay, 16 KiB per RCON
command and 128 KiB per result. The runner uses the existing RCON helper's 180-second transport
timeout; the 17-slot insertion loop is bounded separately. No existing surface may be overwritten.
Preflight refuses players, pauses, jobs, locks, holds, tombstones and leftover probe surfaces.
Cleanup is checked both inside Lua and independently afterward. Lua errors are HARNESS_ERROR;
an observed boundary discrepancy is STOP; PASS means that this small fixture preserved groups,
not that the full transfer is certified. Deletion can be deferred until callback return, so the
independent follow-up read owns the cleanup verdict. Analyze saved output without RCON using
`--analyze`. Empty Lua arrays are normalized before analysis.

## Result: reproduced on 2.1.17

The settled fixture stopped at group 1, slot 13, entity 50106 line 2. Source position was 246/256;
the production insertion algorithm requested 214/256 after subtracting belt speed. Both
`can_insert_at` and `insert_at` accepted it. The intended group stayed at 48 rockets while group 2
rose from 0 to 4. The new unique item ID appeared on entity 50135, not in group 1. Whole-fixture
count rose from 48 to 52, so the problem is placement, not loss. Start/end tick was 17114991.

The setup condition matters: constructing and inserting in the same callback left the three
group-1 belts with separate internal lines (`line_equals=false`), and slot 13 was rejected instead.
After empty construction was allowed to settle, those three lines compared equal and the cross-group
insertion reproduced. The same geometry and requested positions were used in both experiments.

The proven defect is treating an accepted insertion as placement in the intended captured side
group. The existing final side-group census correctly refuses the operation. No production gate
or restoration behavior has been changed by this instrument. Choosing a replacement placement
algorithm (including investigating the documented `force_insert_at` for squashed stacks) requires
separate fidelity tests; this experiment does not certify a fix.

Evidence: `ci-artifacts/belt-boundary-result.json`, plus the unsettled control in
`ci-artifacts/belt-boundary-unsettled-lines.json`. Successful run hash:
`c1b7ebb318d3cf3777fd4926989111884379ce7944712c5b693807738e758527`.
The deliberate cleanup exception and shape smoke passed; all three disposable surfaces were
independently confirmed absent and both hosts had zero jobs, locks, holds, tombstones and players.
Earlier harness errors (read-only `active` and checking deferred deletion inside the callback) are
preserved separately under `ci-artifacts/belt-boundary-*`; neither is treated as engine evidence.
