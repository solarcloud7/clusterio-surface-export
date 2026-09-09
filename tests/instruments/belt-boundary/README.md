# Belt boundary insertion probe

## Connected side-group import results (2.1.17, 2026-09-08)

The simpler same-lane candidate passed and is now applied to the import helper and
planner. Each captured side group is written and physically checked atomically;
connected groups can yield. Distances are clamped on the captured entity and lane
when rebuilt corner geometry exposes a shorter line. Exact item/quality/property
checks remain; source removal is not deployed.

| Rung | Items across arms | Result artifact | Result |
| --- | ---: | --- | --- |
| Full rebuild, same-lane sparse placement | 208 | belt-remove-same-lane-result.json | PASS |
| Dense stateful full rebuild | 816 | belt-remove-dense-result.json | PASS |
| Intact capture, connected import groups | 816 | belt-import-groups-result.json | PASS |
| Side-loading and splitter branches | 516 | belt-import-junctions-result.json | PASS |
| Retained 596-belt / 300-group payload | 19,700 | belt-helper-connected-result.json | PASS, 14 callbacks |

Artifacts are in `ci-artifacts/`; each retains its exact harness and module hashes.
The first four rungs passed the independent offline `verify-remove-parity.mjs`
checks, including negative controls for wrong-lane writes, loss, duplication and
changed properties. The full replay compared physical group deltas and cumulative
item/quality totals after every callback; it does not add property coverage beyond
the small stateful fixtures. Every rung confirmed cleanup on both hosts.

One launch hit Windows ENAMETOOLONG before constructing a fixture. Its error and
independent owned-buffer cleanup are retained in
`belt-import-groups-command-length-{error,cleanup}.json`. The observer now uses
bounded chunk uploads; the corrected harness passed cleanup and shape checks.
This failed launch supplies no candidate result.

These are bounded fixtures, not a proof for every modded topology or item type.
A single large side group and unsupported/external-connection fallback remain atomic.
Destructive export batching still needs durable recovery/journaling; its small-fixture
success is not permission to delete live source belts during production capture.
Historical results below retain the contracts that applied when they were recorded.



### Deployed acceptance (2026-09-08)

Save-preserving plugin/Lua reloads verified both worlds and player positions. The
final deployed selftest passed 28 checks. The full plugin suite passed 623 tests
with eight platform-dependent skips; the local planner and clamp/trace Lua regressions
also passed. A source-size grounding test was updated to include the three retained
experiment runners instead of keeping its stale count of 29 files.

| Production leg | Captured / destination items | Belt callbacks | Work / elapsed ticks | Belt execution | Longest belt callback |
| --- | ---: | ---: | ---: | ---: | ---: |
| Host 1 -> 2 | 43,554 / 43,554 | 14 | 14 / 13 | 74.175 ms | 12.405 ms |
| Host 2 -> 1 | 43,487 / 43,487 | 14 | 14 / 13 | 53.083 ms | 8.418 ms |
| Forced rejection, host 1 -> 2 | 43,495 / 43,495 | 13 | 13 / 12 | 73.484 ms | 16.301 ms |

The first two legs completed with exact per-item/quality validation. The third
intentionally rejected the verdict and acknowledged rollback: source preserved,
destination removed. Platforms ran normally between legs, so departure totals can
change; each destination was compared with its own departure manifest.

A separate real transfer physically verified spoilage, health, ammo, durability,
blueprint contents, entity data, and two same-item stacks with different health.
Eight state writes applied with zero unmatched, failed, declined or merge-discarded.

Review reproduced a false BORN/VANISHED diagnostic after coordinate clamping. The
trace now records the actual insertion coordinate while retaining the source
coordinate separately. A deterministic regression proves correct trace output and
rejection of NaN, infinities and nonnumeric coordinates. The correction was
save-patched and the final deployed selftest passed again.

These callback measurements include debug-batch instrumentation and runtime noise;
they are not a controlled before/after benchmark or a hard frame budget. Final
postflight confirmed no jobs, locks, holds, tombstones or pauses on either host;
profiling and belt tracing were off, with belt budget 500 restored.

Evidence: `ci-artifacts/belt-group-{acceptance.json,roundtrip.json,item-state.log,
selftest.json,final-postflight.json,full-unit-tests.log,deploy.log,trace-deploy.log}`.
`belt-clamp-trace-before.log` retains the reproduced diagnostic bug. Complete
experiments and their contracts remain under `tests/instruments/belt-boundary`.

## Lane preservation clarification and API findings (2.1.17, 2026-09-07)

The owner requires exact quantities and item properties on the corresponding side
of the belt route. Exact distance along the segment is not required. The earlier
coordinate rejection remains evidence about that stricter candidate, not proof that
reverse reconstruction is required under the clarified requirement. A simpler
same-lane placement candidate remains to be tested; no production code changed.

The saved inverse-reconstruction observations were rechecked offline with side
included in every item/quality/property comparison. All eight arms passed at all
224 recorded boundaries, including journal plus physical cargo during dismantling
and restoration. The counts below apply to each removal order independently:

| Fixture | Left-side items | Right-side items |
| --- | ---: | ---: |
| Straight | 3 -> 3 | 12 -> 12 |
| Loop | 4 -> 4 | 16 -> 16 |
| Splitter | 4 -> 4 | 16 -> 16 |
| Three-pair underground chain | 17 -> 17 | 32 -> 32 |

These are fixture-wide side checks. They do not certify placement on the correct
branch of an arbitrary network. The next topology observer must establish route and
lane membership, especially around side-loading junctions and splitter branches.

```powershell
node tests/instruments/belt-boundary/verify-remove-parity.mjs --lanes --self-test
```

The verifier rejects a wrong-side item even when the saved native counts are updated
consistently and total item quantities/properties remain unchanged. It accepts same-lane
position changes. The earlier loss/duplication/property-change controls also pass.
Raw live observations were not rewritten. Derived output is in
`ci-artifacts/belt-remove-inverse-lane-verification.jsonl`.

The public [LuaTransportLine API](https://lua-api.factorio.com/latest/classes/LuaTransportLine.html)
was verified against the cached official 2.1.17 runtime schema:

| Member | Documented use |
| --- | --- |
| `line_equals(other)` | Compare the associated internal transport lines, including across different owning entities. |
| `input_lines` / `output_lines` | Read incoming and outgoing transport-line connections. |
| `line_length` | Read the valid insertion range for this line. |
| `total_segment_length` | Read the length of the segment including directly connected lines in front and behind. |
| `get_detailed_contents()` | Read physical stacks and positions for independent verification. |

The GUI option is `show-transport-lines`; a
[Factorio developer explanation](https://forums.factorio.com/viewtopic.php?p=701574)
identifies its boundary arrows and explains runtime line splitting. Internal line
boundaries should therefore not become persisted source/destination IDs. No single
stable segment-ID or all-belt-segments enumeration API was found in the 2.1.17 schema.
These APIs do not pause cargo or provide a multi-tick atomic snapshot.

The running engine's `defines.transport_line` values were read without mutating the
game and retained in `ci-artifacts/belt-lane-api-values.json`: left indices 1/3/5/7,
right indices 2/4/6/8. Underground and secondary splitter names share 3/4. The API
schema lists names and ordering, so its order alone must not be used as numeric values.
Current production capture already uses `line_equals`; it does not use the connection
or total-segment-length members above. Production restoration still rejects out-of-range
captured positions. The API documents that native `force_insert_at` clamps out-of-range
positions; allowing same-lane placement is a testable candidate, not yet an acceptance result.


## Capture/remove with inverse reconstruction (2.1.17, 2026-09-07)

**PASS for eight bounded belt round trips, not production transfer acceptance.**
Capture/remove underground partners together, then reconstruct the units in the
reverse order of removal. Each reconstruction creates one unit, waits one tick,
restores its encoded cargo, and yields before the next unit. No production exporter,
importer or scheduler code was changed or deployed for these experiments.

| Fixture | Forward removal / reverse reconstruction | Reverse removal / forward reconstruction |
| --- | --- | --- |
| Three connected straight belts | PASS: 15 -> 15 items | PASS: 15 -> 15 items |
| Four-belt loop | PASS: 20 -> 20 items | PASS: 20 -> 20 items |
| Splitter and adjacent belts | PASS: 20 -> 20 items | PASS: 20 -> 20 items |
| Three connected underground pairs and adjacent belts | PASS: 49 -> 49 items | PASS: 49 -> 49 items |

Across the eight arms, all **208 seeded items** were physically restored. Exact
comparison included name, quality, count, two pistols with different health, partial
magazine ammunition, used repair-pack durability, and a labeled blueprint containing
two entities. Both lanes were populated, including four-item stacks and normal,
uncommon, rare and legendary qualities. There were zero unplaced items, restoration
anomalies, unmatched/failed/discarded/declined item-state applications, or ground spills.
All original fixture geometry and connections were restored. Item coordinates were
allowed to move with the simulation; there is no simultaneous original-position claim.

The experiment called the unmodified production belt capture/restore helpers through
an isolated module bundle. Each captured unit passed through Factorio JSON encoding,
compression, decompression and decoding. Production Lua cannot be imported directly
from an RCON callback; the bundle used a private require cache and retained hashes of
all eleven source modules. It did not replace the deployed modules. Geometry came
from known fixture definitions, so entity-settings serialization is outside this result.

An independent offline verifier replays the saved observations without trusting
their PASS/conserved flags. It checks physical stack reads against native line counts,
encoded payload quantities, and the known fixture seed. It then checks exact
item-property parity for journal plus physical cargo at **224 observed boundaries**.
It verifies removal/restoration order, consecutive ticks and final topology. Offline
negative controls deliberately lose an item, duplicate one, and change pistol health;
all three are rejected. This recount requires no new live run.

The inverse ladder ran once: 55 probe calls, 73.436 seconds for the complete lab
workflow, 10-16 consecutive callbacks per arm. Construction and callback exception
tests verified cleanup before the candidate arms. All disposable surfaces, storage,
module bundle and tick wrapper were removed; both instances were independently idle,
unpaused and free of players, jobs, locks, holds and tombstones afterward. The wrapper
checked restoration of the original handler by function identity. The 143 saved
profiler records include setup and observer work, not a production speed measurement.

### Counterexamples retained before this pass

The preceding paired-underground ladder reproduced the old per-entity output-first
loss as an expected-failure control (2 captured + 1 remaining, expected 4). Capturing
both underground ends before destroying either passed six candidate arms: both
orders for the simple pair, partial reconstruction, and three connected pairs. That
ladder checked simple cargo quantities, used 43 calls in 42.128 seconds, and retained
66 profiler records. Partial reconstruction was in-memory, not crash recovery.

The first item-property ladder rebuilt the entire layout before restoring cargo.
Both straight-belt arms passed with 15 items. Forward loop restoration then rejected
a captured coordinate. Removing a neighboring belt had straightened an inner lane:

| Source payload | Captured position | Line length at capture | Length after rebuilding full loop |
| --- | ---: | ---: | ---: |
| C, lane 2: four rare iron plates | 0.9375 | 1 | 0.4140625 |
| D, lane 2: four rare iron plates | 0.7109375 | 1 | 0.4140625 |

The production helper correctly raised `captured position outside destination line`.
No position was clamped or remapped. The ladder stopped immediately; later arms were
not run. The raw artifact records HARNESS_ERROR because its wrapper classified the
exception that way. Offline analysis derives **candidate STOP** from the immutable
encoded payload and independent source/destination line-length readings; it preserves
the raw classification. This was not a successful full round trip. It used 30 calls
in 30.113 seconds and retained 37 profiler records. Cleanup passed.

Inverse reconstruction was a separate candidate after that counterexample. It
recreates each unit's capture-time neighboring geometry before restoring its cargo.
The same formerly failing loop then passed without coordinate corrections or a
weaker parity requirement. Both removal directions now passed the declared fixtures;
that does not establish that reconstruction order is interchangeable.

### Reproduce and inspect

Run from the canonical checkout, with both local instances idle. The official
2.1.17 runtime API schema must be cached at `ci-artifacts/belt-boundary-api.json`.
Use `--prepare` first; see [remove-contract.md](remove-contract.md) for bounds.

```powershell
node tests/instruments/belt-boundary/run-remove.mjs --paired --boundary --prepare
node tests/instruments/belt-boundary/run-remove.mjs --paired --boundary
node tests/instruments/belt-boundary/run-remove.mjs --paired --boundary --fidelity
node tests/instruments/belt-boundary/run-remove.mjs --paired --boundary --fidelity --reverse-rebuild
```

The fidelity ladder intentionally retains the whole-layout coordinate failure.
The inverse ladder requires that witness plus a paired-ladder PASS. These are live,
bounded experiments, not default CI tests. Inspect retained artifacts offline with:

```powershell
node tests/instruments/belt-boundary/run-remove.mjs --paired --analyze
node tests/instruments/belt-boundary/run-remove.mjs --fidelity --analyze
node tests/instruments/belt-boundary/run-remove.mjs --reverse-rebuild --analyze
node tests/instruments/belt-boundary/verify-remove-parity.mjs --self-test
```

Evidence is retained locally in `ci-artifacts/belt-remove-{paired,fidelity,inverse}-result.json`
and matching `-profiler.log` files. Each raw result includes actual mods, cleanup reads,
the API manifest, and its harness/fixture/contract/source hash. Later offline analysis
does not rewrite that evidence. Exact hashes for these runs:

- Paired: `ea4687d924c62d73902a593f9c05a3c548b521354aecd67405aed80c86f68ef2`
- Whole-layout fidelity: `1ebb9dd05c2f2588eddac31bf87d8a1964fd2d34ee5f41e2048fc9035421aff0`
- Inverse reconstruction: `ff36062cf800fbfdd967ac8487729f498456cf8c83a709cb279d8616ee4a2820`

Still **NOT TESTED**: the full Clusterio transfer path, production producer/consumer
locking, durable journal and crash/reload recovery, all cardinal rotations and
arbitrary topology combinations, dense/large networks, spoilage, equipment grids,
nested inventories, arbitrary modded item fields, and whole-platform entity settings.
No universal zero-loss or production performance claim follows from these fixtures.
The next acceptance steps are topology/density coverage, interruption and recovery,
then the actual transfer pipeline with the same exact physical cargo oracle.


## Capture-and-remove direction experiment (2.1.17, 2026-09-07)

**STOP for unrestricted per-belt removal.** The boundary-seeded comparison found
actual cargo loss when an underground output was removed before its input. No
production export/import or scheduler files were changed. Only disposable fixtures
were mutated; the temporary tick wrapper restored the original handler by function
identity, and independent cleanup reads confirmed no wrapper/surface/storage residue.

Run `node tests/instruments/belt-boundary/run-remove.mjs --prepare` to check the
pinned API. Run with `--boundary` for the crossing-sensitive ladder, or without it
for the original back-seeded control. `--analyze` reads the last saved artifact
without cluster access. See [remove-contract.md](remove-contract.md) for invariants,
permitted reconstruction and bounds. Both local instances must be idle.

Each removal captures the selected entity's cargo to plain data and destroys that
entity in the same callback. Every following removal is exactly one tick later.
The independent observer checks known seeded cargo by item and quality against the
journal plus every surviving fixture entity, and rejects any ground spill. All
items are distinct, normal-quality, single items; no production producer/consumer
locking, non-default item state, stacked cargo or durable recovery is certified.

| Boundary-seeded fixture | Following flow / forward traversal | Against flow / reverse traversal |
| --- | --- | --- |
| Three connected same-tier straight belts | PASS: 3 captured | PASS: 3 captured |
| Four-belt loop | PASS: 4 captured | PASS: 4 captured |
| Loop aborted after two removals, then reconstructed | PASS: 4 physical items restored | PASS: 4 physical items restored |
| Splitter and adjacent belts | PASS: 4 captured | PASS: 4 captured |
| Paired underground belts and adjacent belts | PASS: 4 captured | STOP after second removal: 2 captured + 1 remaining, expected 4 |

The concrete failing route is `A -> B(input) === tunnel === C(output) -> D`.
Reverse order removed D at tick 21484934, then C at tick 21484935. Immediately before
C's removal, the copper plate (ID 8762152) was on **B's line 3**, position 2.984375,
whose native item count was 1 and length was 3. C's capture included only its steel
plate. Destroying C returned true; afterward B's line 3 had length 1 and native count
0, and the copper plate was absent from all remaining lines, journal and ground.
This same-callback before/after observation isolates removal's effect from tick motion.
The candidate stopped immediately. This is a fixture counterexample, not a claim
that every underground-output removal loses cargo.

Boundary seeding at position 1/64 exercised actual inter-entity crossings. For example,
a copper plate moved B -> C between ticks 21482917 and 21482918 in the forward straight
arm and was captured once when C was removed. Crossings were also recorded in both
loop orders, the reverse splitter arm, and both underground orders. The forward
splitter arm had no observed inter-entity crossing; its pass has that coverage limit.

The earlier control seeded near belt backs: all ten arms passed, but no item crossed
between entities during capture. Those results were retained before changing seed
placement. Both control and boundary ladders ran once, used 59 probe calls each, and
took about 52 seconds each. Construction and callback fault injection passed cleanup
before the candidate arms. The control retained 95 rendered profiler records and the boundary run retained 92
(the failed arm stopped three callbacks earlier). These include construction/observation
work and do not establish a production speedup.

Both loop reconstruction directions restored the removed geometry, exact insertion
coordinates at the restoration callback, original topology, and cargo totals on the
next tick. Surviving cargo kept moving. This does not recreate all positions from one
original instant, and is not crash-safe rollback. Recovery was not used to rescue the
failed underground arm. Cardinal rotations were not varied independently of topology.

Evidence: `ci-artifacts/belt-remove-result.json`, `belt-remove-crossings.json`,
`belt-remove-profiler.log`; control evidence: `belt-remove-back-result.json` and
`belt-remove-back-profiler.log`. Both result files include actual mods and independent
final checks: zero players, jobs, locks, holds, tombstones or lab surfaces; unpaused.
Boundary harness/fixture/contract hash:
`9ef82b7a4a6b61239e1eb237119bfcfc6ace340873025c3d0e477be9639a7a26`.
Control hash: `9c19816da1033d1e18d8a7b85f9694935d7d236a19c2ce666b930dbe115a5e37`.

A candidate for a later experiment is capturing/removing both underground ends and
all tunnel cargo together before yielding. That change is **NOT TESTED** here.


## Moving capture experiment (Factorio 2.1.17, 2026-09-07)

The simple cross-batch capture candidate is **STOP**: merging item IDs from each
selected belt and its immediate input/output neighbors can still miss a moving item.
Production export, import and scheduling were not changed by this experiment.

Run `node tests/instruments/belt-boundary/run-capture.mjs --prepare` for the pinned
API check; omit `--prepare` to run on the idle local cluster. Requires the official
2.1.17 schema cached at `ci-artifacts/belt-boundary-api.json`. Use `--analyze` to
read the saved result with zero cluster calls. Fixture and permitted assists are
specified in [capture-contract.md](capture-contract.md).

Every fixture held one normal iron plate. Each candidate column below is its captured
quantity; the independent whole-network observer confirmed one physical item throughout.
Neighbor reads include the selected belt and deduplicate IDs across batches.

| Fixture / read order | Plain reads | Deduplicated IDs | With immediate neighbors | Expected |
| --- | ---: | ---: | ---: | ---: |
| Straight / upstream first | 2 | 1 | 1 | 1 |
| Straight / downstream first | 0 | 0 | 1 | 1 |
| Splitter / upstream first | 2 | 1 | 1 | 1 |
| Four-belt loop / adversarial delayed reads | 0 | 0 | 0 | 1 |

The loop's single item kept ID 8762060. The observer selected legal sampling moments
when it was outside the next candidate window; the candidate received none of those
observer readings. This is the actual captured trace:

| Tick | Selected belt | Candidate window | Physical item on | Candidate items |
| ---: | --- | --- | --- | ---: |
| 21389936 | A | A, B, D | C | 0 |
| 21389973 | B | A, B, C | D | 0 |
| 21390012 | C | B, C, D | A | 0 |
| 21390581 | D | A, C, D | B | 0 |

These are delayed RCON batches, not strictly consecutive-tick callbacks. The result
falsifies this simple union-of-observations algorithm under the declared schedule.
It does not falsify every possible boundary-tracking algorithm or prove a failure
under a fixed one-tick schedule. The straight/splitter quantity passes do not establish
a simultaneous snapshot of item positions. No actual item was lost: the candidate
omitted an item that remained on the fixture.

The ladder ran once, used 44 probe calls, and finished in 36.4 seconds. The deliberate
construction exception and API shape smoke passed their cleanup/access checks before
the candidate arms. All six disposable surfaces and owned storage were independently
confirmed absent. Both instances remained unpaused with zero players, jobs, locks,
holds and tombstones. All 38 non-cleanup probe profiler records were retained; these
include construction and oracle work and are not production performance measurements.

Harness/fixture/contract hash:
`6361b87a30ad94143e3c8fb82854b19c50d9f76ee2f32469e45eecce7c8fbb9d`.
Evidence: `ci-artifacts/belt-capture-result.json` (raw observations, API manifest and
actual mod versions), `belt-capture-profiler.log`, `belt-capture-cleanup.json`.
Larger networks, stack merging/splitting, stateful items, spoilage, loaders/linked
belts, production transfers and performance improvements remain **NOT TESTED**.


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

## Product acceptance repeat (2026-09-08)

The unchanged deployed code completed another real round trip on a disposable copy.
Host 1 -> 2 preserved 43,555 / 43,555 items; host 2 -> 1 preserved 43,488 / 43,488.
Both item/quality maps matched exactly. Each import used 14 batches on 14 work ticks
(13 elapsed ticks). Longest belt callbacks were 41.031 and 17.607 ms; these local
samples reinforce that the work target is not a hard frame-time guarantee. The
intentional rejection acknowledged rollback, preserved the source and removed the
destination; its maximum belt callback was 10.100 ms.

The refreshed product UI displayed the successful audits, separate Lua timing and
tick/batch counts, and an Intentional test label with Rollback succeeded for the
rejected leg. Final checks confirmed no remaining fixtures, jobs, locks, holds,
tombstones or pauses. Profiling and trace settings returned to their prior values.
Evidence: ci-artifacts/belt-product-{preflight,roundtrip,acceptance}.json and
belt-product-roundtrip.log. No additional production code or deployment was needed.
