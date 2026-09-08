# Capture and remove moving belts

Factorio 2.1.17. Disposable surfaces only. User-authorized experiment: capture a belt
and remove it before yielding; compare removal direction and recover a halfway abort.
No production exporter, transfer, or scheduler implementation changes.

Invariant after each removal, before recovery: captured cargo plus physical remaining
cargo equals the known seed, separately by item and quality. No ground spills, extra
items, or omitted items are allowed. Record candidate reads separately from independent
whole-fixture reads. Source item IDs may change when topology changes; they deduplicate
aliases within a single read only. Never deduplicate across destructive batches to
conceal a repeated capture. Each seed is one different normal-quality item.

Candidate: copy the selected entity's item rows to plain data, then call destroy in
the same callback. A failed destruction, invalid entity, or changed accounting stops
that arm immediately. Belts continue moving. There are no inserters, loaders, machines,
robots, players or external belt connections in the fixture; locking these writers and
consumers on a production platform is NOT TESTED. Clearing remaining belts, corrective
insertion, spill recovery and neighbor-based accounting corrections are forbidden.

Paired comparisons are independent candidates: upstream-first and downstream-first
on three same-tier straight belts, then a four-belt loop in both traversal orders.
Run both directions of the current pair for the user's direction comparison. If either
fails, stop before larger topology or recovery rungs. If both pairs pass, test halfway
abort/reconstruction of the loop in both directions, then paired splitter and paired
underground removal. STOP in an arm never permits further candidate deletions there.

Recovery is an explicit separate arm, not assistance for a failed removal. After two
loop removals, deliberately abort, recreate only removed geometry, allow one tick for
empty connections to settle, and insert only journaled cargo at its captured coordinates.
Validate native insertion effects, exact inserted positions in that callback, original
topology and total cargo; read again on the next tick to check continued conservation.
This tests small in-memory reconstruction, not disk durability, crash/reload recovery,
wiring/settings fidelity, non-default item state, or a simultaneous original snapshot.

Boundary follow-up after the back-seeded ladder: the saved first result proved moving
positions and topology changes but contained no inter-entity crossing. Preserve that
artifact. With --boundary, seed each item at position 1/64 using force_insert_at,
before any removal; no corrective insertion is permitted during capture. Repeat the
same pairs and require observed membership changes between callbacks before claiming
crossing coverage. Lack of a crossing is incomplete coverage, not a capture failure.
The prior ladder and its hash remain distinct. Bounds below apply to each ladder.

A temporary wrapper invokes the existing on_tick handler unchanged, then one bounded
probe step. It restores the original handler on completion/error and cleanup verifies
the original function identity. Never install over an unknown lab wrapper. Handlers,
surfaces and storage are ownership-tagged; functions live outside persistent storage.
Maximum 16 callbacks per arm, one removal per callback, at most five entities, eight
lines per entity, five seed items, 256 prepared tiles and one generated chunk on one
32x32 surface at a time. At most 13 surfaces including smoke/cleanup proof, 100 runner
calls plus 24 independent pre/postflight reads, 150 seconds excluding rescue cleanup,
24 KiB command, 256 KiB response and 8 MiB artifact. Live executions: one paired ladder
per fixed harness, except a corrected HARNESS_ERROR requires a new hash/cleanup proof.

Before mutation: pinned API shape/signatures, idle unpaused instances, no players,
jobs, locks, holds, tombstones or previous lab ownership. Then injected construction
failure plus injected callback failure prove cleanup/handler restoration, followed by
a tiny straight/corner/splitter/underground shape smoke. Raw evidence is saved before
offline analysis. Preserve actual mods, engine and harness/fixture/contract hashes.
PASS means only the declared fixture conserved cargo. STOP means a candidate invariant
failed. HARNESS_ERROR means API/setup/runner/oracle/cleanup failure. No performance claim.

## Paired underground candidate

The user's acceptance condition remains exact item parity; no tolerances or cargo
correction may hide a mismatch. --paired requires boundary seeding and retains a
separate artifact. First reproduce the known output-first loss with per-entity
capture as an expected-failure control. Then capture both ends of each original
underground pair, including every exposed transport line, before destroying either
end in the same callback. Deduplicate IDs only within that captured unit. Other
entities remain individual units. Pair membership is fixed from the initial runtime
topology; external or missing partners refuse the test.

Ladder: simple pair in both removal orders; partial reconstruction in both orders;
three connected underground pairs in both orders. An unexpected control result or
any candidate mismatch stops the ladder. Reconstruction still uses only captured
rows for cargo, with no remaining-belt clearing. Original fixture geometry supplies
the reconstruction layout; this is not certification of entity-settings serialization.
New paired bounds: at most eight entities and eight normal seed items, 16 callbacks
per arm, ten surfaces including the three cleanup/shape proofs and one control,
100 calls plus 24 independent reads, 150 seconds per ladder. Other limits above remain.

## Item-property round trip

--fidelity requires a saved PASS from the paired ladder and uses separately bundled,
unmodified production BeltRestoration.capture_side_groups/restore_side_groups with
their actual source dependencies. It saves a separate artifact and module hashes.
Modules are evaluated in an isolated require cache; no deployed module is replaced.
The bundle is owned, bounded to 1 MiB and removed in finally.

Each unit's production capture is JSON-serialized, compressed, decompressed and decoded
before it may be restored. The independent oracle reads name, quality, count, health,
ammunition, durability, and blueprint contents/label directly from physical stacks.
These properties, with exact counts, must match the known armed before-state after
every removal and after the complete reconstruction. Item positions can move; no
cross-tick simultaneous-position guarantee is claimed. Spoilage, equipment grids,
nested inventories and arbitrary modded item fields remain NOT TESTED, not passed.

Seed both lanes: one primary stack per entity cycling through two pistols with
different health, a partial magazine, a used repair pack, a labeled two-entity
blueprint, and four-item stacks at legendary/normal/uncommon quality; lane two holds
four rare iron plates. Fixture capacities and resulting stack properties must be
confirmed before capture. This ladder tests straight, loop, splitter and three-pair
chain in both orders, stopping on the first candidate failure. No correction, merging
fallback, spill handling or relaxed item-property comparison may make it pass.

Each arm fully removes then reconstructs the fixture using only its encoded captures
for cargo. Restoring known fixture geometry is allowed and is explicitly not a test
of whole-platform entity serialization, controller transport or crash-safe rollback.
Maximum 64 seeded items and eight entities per surface, 16 callbacks, 11 surfaces,
120 calls plus 24 independent reads, 180 seconds, 40 KiB command, 1 MiB response,
8 MiB artifact. Re-run construction/callback fault cleanup for the new harness hash.

## Reverse reconstruction candidate

The first fidelity ladder rejected a loop because removing neighbors changed its
inner-lane geometry: a captured coordinate valid on a straight segment did not fit
the rebuilt corner. Retain that failure. --reverse-rebuild changes only reconstruction
order: recreate the last removed unit, wait one tick for its connections, restore
its production payload, then continue toward the first removed unit. Never clamp or
remap positions, force a missing item into a different place, or ignore restoration
rejection. Exact combined journal-plus-physical item-property parity still gates every
callback, including partial reconstruction. The original invalid-coordinate witness
must exist before this candidate is allowed. Repeat the same fidelity ladder in a
separate artifact, stopping at the first failure. Existing 16-callback bound covers
the largest fixture (five capture units, ten reconstruction callbacks, one final check).

## Owner clarification: preserve lanes, not exact coordinates (2026-09-07)

The owner clarified that exact distance along a belt segment is not required;
quantities on each side are required. Acceptance for subsequent candidates is exact
item quantity, quality and state on the corresponding route/lane. Placement may move
along that lane. Moving cargo to the other side or an unrelated route, dropping cargo,
duplicating cargo, or losing its properties remains forbidden. An intentional valid
placement on the corresponding lane is allowed; post-hoc cargo corrections to make
a failed count pass are not. Earlier positional experiments and hashes remain intact.

The inverse experiment's original offline verifier omitted lane from its comparison
key. Its quantity/property PASS alone did not certify lane preservation. The new
`verify-remove-parity.mjs --lanes --self-test` mode independently rechecks retained
physical observations with lane side included. It checks exact left/right quantities
per item/quality/state for each isolated fixture and journal at every recorded boundary.
It must reject wrong-side placement even when quantities and properties are unchanged,
and must accept a position change within the same lane. This is offline analysis, not
a new live experiment or a change to production restoration.

The enum values were read from the running 2.1.17 engine and retained in
`ci-artifacts/belt-lane-api-values.json`; do not infer them from documentation ordering.
Fixture-wide side counts do not certify branch/route membership in arbitrary networks.
At junctions, subsequent fixtures must distinguish actual route membership and legal
flow from a restoration that puts an item onto the wrong branch or side.

Research confirmed the 2.1.17 LuaTransportLine members `line_equals`, `input_lines`,
`output_lines`, `line_length`, and `total_segment_length`. They expose internal-line
equality, connections and lengths, not a stable persisted segment identity or an atomic
snapshot across callbacks. Any new physical observer using these fields still needs
the pinned manifest, shape smoke and cleanup ladder before behavior claims.

A separate future candidate can rebuild the full geometry, choose valid positions
on the corresponding source lane, and verify exact physical lane deltas and item state.
That candidate has not run. Do not describe the previous out-of-range coordinate
failure as disproving lane-preserving reconstruction under this clarified requirement.

## Same-lane reconstruction candidate (2026-09-08)

Authorized continuation: test the simplest lane-preserving reconstruction before
applying a production change. `--same-lane` uses the fidelity ladder, rebuilds all
geometry, waits one tick, then restores one captured unit per callback. The isolated
production-helper bundle changes only its insertion coordinate guard: finite captured
positions are clamped to this same destination line's valid range. Entity identity,
line index, item count, quality and properties remain unchanged. No fallback to another
entity/line, spill handling or count correction is allowed.

Exact fixture-wide item/property/left/right parity gates each callback. Each helper
call must also pass its independent physical side-group delta check. Record before
and after reads per restore callback, clamped coordinates and restoration results.
These small fixtures do not certify arbitrary branch routing or dense networks; those
are later rungs. Stop on the first candidate mismatch, preserving raw evidence. A
helper rejection is STOP; construction/API/oracle failures are HARNESS_ERROR.

Prerequisite: retained paired-capture and inverse-fidelity passes, plus the known
whole-layout coordinate counterexample. Fresh construction-failure, callback-failure
and geometry smoke proofs are required for the new hash. At most eight entities,
64 items, 16 callbacks per arm, eleven surfaces, 120 calls plus independent pre/post
reads, 180 seconds, 40 KiB command, 1 MiB response and 8 MiB artifact. Only disposable
surfaces and the owned isolated bundle are mutated. Production remains unchanged
until its corresponding acceptance rungs pass.

### Dense same-lane follow-up

Only after the sparse same-lane ladder passes, `--dense` adds two four-item stacks
at positions 1/8 and 1/4 on each entity's two primary lanes. Extra left cargo is
legendary copper; extra right cargo is uncommon steel. Force insertion during seed
construction explicitly permits compression/squashing. Expected extra quantity is
known: sixteen items per entity, with independently verified lane totals and properties.
The original item-state seeds remain. Maximum 192 items and 8 MiB artifact; all other
same-lane bounds apply. Preserve a separate artifact and stop on the first mismatch.

### Intact capture and connected import groups

After dense reconstruction passes, `--import-groups` captures the intact fixture in
one callback using the production serializer, round-trips the payload through JSON
and compression, then clears all disposable fixture cargo in that same callback.
That clearing simulates an empty destination; it is not proposed source behavior.
It restores production side groups with a candidate planner that keeps group writes
atomic but permits yielding between connected groups. Use budget 1 to exercise every
available group boundary. Network counting and all restoration verdicts remain.

Journal entries follow captured side groups. Global item/property/lane parity must
hold across callbacks; each new physical item must also appear on a member line of
the group being restored, with matching quantity and properties. Positions may move.
Up to 48 callbacks per arm; other dense bounds apply. Save an independent artifact.
This tests importing an intact source payload without deleting source belts in production.

The first intact-capture launch hit Windows ENAMETOOLONG before probe construction.
Its command-length error and independent owned-buffer cleanup are retained. The
corrected runner uploads the observer as compressed 10,000-character chunks and
invokes it with short substitution arguments (16 KiB command maximum). Source and
helper bytes stay in the same owned buffer and are removed together. No fixture
result is attributed to the failed launch. Re-run the cleanup/shape ladder for the
corrected harness hash.

### Junction routing follow-up

After intact dense group imports pass, `--junctions` runs the dense side-loading
junction and two-input/two-output splitter fixtures in both capture orders. The lane
mapping test remains strict at each restoration write: new physical items must be on
a member line of the captured group and match its captured item/property/side counts.
Global cargo quantity/properties remain invariant between callbacks. Global left/right
numbers are not a conserved quantity for these fixtures, because ordinary side loading
can move cargo from either incoming lane onto one downstream lane. Do not misclassify
that permitted simulation movement as corruption or use it to excuse wrong-side writes.
The earlier isolated fixture lane-parity checks remain unchanged. Existing dense bounds
apply, with four candidate arms. Source geometry stays intact throughout this rung.

### Retained full-fixture import replay

`run-helper.mjs --installed --batched --connected` reuses retained black-box geometry
and cargo: 596 belt entities, 300 side groups, 5,772 stacks / 19,700 items. Only the
isolated planner changes network packing to side-group packing; the production
restorer is unchanged. Budget 500, at most 32 callbacks, and a 64 MiB result bound.
Each callback records independent physical before/after rows. Its group quantity
delta must equal the written payload; whole-fixture cumulative item/quality totals
must stay exact while ordinary belt movement occurs. Position equality is not required.
Run once after pinned API preparation and an injected-cleanup fixture. Only owned
buffers and surfaces may be changed; independently verify both hosts after cleanup.
