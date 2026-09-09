# Batching acceptance contract

Factorio 2.1.17; use the canonical checkout and the existing owned transfer-cleanup
fixture. `--large --profile-callbacks` adds 400 steel chests (48 occupied slots,
slot N holds N rare iron plates), 400 isolated two-sided belts, and a 128x128
foundation. The original hub, canary, tank, chest and two belts remain. Independent
literal expectations check every entity, inventory item/quality total, belt side
and fluid amount/temperature. No helper may repair cargo to satisfy the oracle.
The expanded observer also compares every retained tile name and coordinate with
the literal 128x128 foundation. The first baseline predates that added tile observer;
its cargo evidence remains valid but does not establish tile parity.

Stop on any cargo mismatch, engine-pin change, unexpected job/lock, runtime error,
or unverified cleanup. Construction failure must exercise the existing finally
cleanup before a production replay. At most three full invocations per revision
(baseline, candidate, repeat), two transfers each; existing 90-second/60-poll
terminal limits remain. Commands stay below 32 KiB, responses below 4 MiB and
20 seconds. Whole-scheduler profiling retains at most 512 samples per instance;
truncation means no complete maximum claim. RCON setup is outside that profiler.

The scale fixture uses only engine members already exercised by the existing
fixture and deserializer. Source, observer and oracle hashes are retained. Run
analysis against saved artifacts without a cluster. Normal and source-deletion
failure/recovery paths must preserve the physical contract and clean up owned
platforms. Unrelated platforms and player state must remain intact.

This synthetic workload does not exercise every entity type, a single giant
inventory, complex belt topology, circuit memory or connected fluid flow. Those
need their existing specialized fixtures before changing those yield boundaries.
Timing is an observation, never an item-parity invariant. Native engine calls
remain indivisible; a yield before a call is not evidence that its cost is bounded.

## Encoding comparison

`node tests/instruments/callback-profile/payload-encoding.mjs` compares the native
whole-object encoder with the candidate's joined JSON. No surfaces or cargo are
modified. One command on an idle 2.1.17 instance, at most 100 encoder steps, 53
entities and 2,001 tiles plus nested/empty/escaped/scalar values; command limit
32 KiB, response limit 4 MiB, deadline 20 seconds. Independent Node JSON decoding
must produce identical values and the source payload must remain unchanged. This
checks format equivalence, not callback scheduling or performance. Artifact hashes
identify the exact encoder and observer. `--analyze <artifact>` repeats it offline.

`payload-encoding-mttnibwj.json` passed native equivalence before deployment.
Large transfer/recovery acceptance is still required for each deployed candidate.

## First batching result — 2026-09-09

Before: `transfer-cleanup-mttmxndu.json` and downloaded timing reports. After:
`transfer-cleanup-mttnaco9.json`. Both ran a baseline and a deletion-failure recovery.
Whole-scheduler maxima (two transfers combined) were source 445.44 -> 463.96 ms,
destination 498.38 -> 34.67 ms. These local samples include profiler overhead;
the source was not optimized in that candidate. Neither profile was truncated.

Destination tiles accumulated 484.26 ms over 34 batches instead of one 498.12 ms
call in the baseline leg. Inventories accumulated 64.86 ms over 39 batches instead
of 50.36 ms in one call. This reduces long callbacks, not total execution work.
All exact physical cargo, tile, replay, recovery and cleanup checks passed.

Remaining boundaries: source belt capture/checks stay atomic; inventory batches
still finish one entity at a time, so a single huge inventory remains unbounded.
State/connections, fluid injection/verification, native decoding/compression,
starter creation and native surface deletion need separate consistency or format
work; the current changes do not establish limits for those paths.

## Chunked encoding acceptance — 2026-09-09

`transfer-cleanup-mttnpjtk.json` passed both large transfers, source-deletion fault
recovery, replay, exact cargo and tile checks, and verified cleanup. The deployed
source hashes are retained in the artifact. Source whole-scheduler maximum was
164.37 ms over 264 samples; destination maximum was 33.99 ms over 226 samples.
Neither instrument truncated. The original baseline maxima were 445.44/498.38 ms.
These are observed local maxima over two transfers, not production guarantees.

Serialization accumulated 490.15/494.63 ms across 113 visits per transfer, instead
of 445.20/433.61 ms in one invocation. This trades extra scheduling and execution
overhead for shorter pauses; it does not improve total operation latency.
Its joined JSON retains the existing format and diagnostic byte reuse. The separate
native equivalence probe passed before rollout. Downloaded timing reports were
reconciled with raw profiler output and rendered browser values.

The remaining largest observed source phase was belt capture: 149.74/145.76 ms in
one invocation. Inner JSON decoding took 66.52/93.69 ms; starter-pack work took
43.01/49.91 ms. Those RCON setup calls are outside the scheduler probe. State
restoration took 3.21/3.60 ms and exact verification 5.92/5.38 ms here; this workload
does not justify adding risky yield boundaries to either. Native source deletion
measured 0.37 ms normally and 34.32 ms for the injected failure interval (which
includes the fixture's physical observation); the latter is not ordinary deletion
cost. Connected belts, large single inventories and engine calls remain open work.

## Rich-fixture stop: crusher input capacity

The existing `inventory-item-state` fixture rejected transfer
`836570928:229_invstate-mttnslnn`: metallic asteroid chunks expected 1027, actual
1025. Rollback succeeded and the fixture removed its owned clone. Its runner
waited for the removed destination until its 300-second arrival timeout; that
timeout is not the transfer duration. `ci-artifacts/batching-inventory-failure.json`
preserves the 4.45 MB engine black box. Offline comparison isolated one crusher at
(-10.5, 41), whose input slot was captured with nine chunks and restored with seven.

This also occurred during the earlier standalone clone (12 -> 7). Native logs
explicitly report `set_stack partial`. The isolated probe calls the unchanged
`Deserializer` directly, with no batch scheduler: all three disabled crushers
immediately read seven after a requested nine. Earlier/unconditional dormancy did
not help. `inventory.insert` and writing `LuaItemStack.count` also retained seven,
both immediately and after three subsequent reads. No workaround passed.

Run `node tests/instruments/callback-profile/crafter-dormancy.mjs` with idle hosts.
The literal failed entity is retained in `crafter-input.json`. One temporary
platform, three crushers, at most nine bounded RCON calls (32 KiB request, 256 KiB
response, 20-second command deadline), three 500ms observation waits. The first
lookup error cleaned up successfully; corrected lookup and capacity variants are
recorded in `transfer-cleanup-crafter-mtto8c2l.json` and
`transfer-cleanup-crafter-mttoakx4.json`. Cleanup was independently verified each time.
This is a negative engine experiment, not a passing fidelity test. The 2.1.17 API
declares `LuaItemStack.count` writable (`uint32`); writability did not bypass this
slot's capacity. Neither telemetry nor a repair container can make that a pass.

The simpler large acceptance remains valid for its defined cargo. That initial richer inventory run **did not pass**. The next section records the
subsequent root cause and repeat; it does not erase this failure evidence.
The strict cargo gate remains unchanged.


## Beacon capacity correction � 2026-09-09

The isolated unchanged-deserializer clamp above did **not** establish a pre-existing
production defect: that fixture omitted the original beacon effects. A read of the
protected source crusher found crafting speed 17.375 and 12 input chunks. The new
inventory batching had disabled beacons immediately after restoring their modules;
the original completion function disabled them after all inventories were restored.

`crafter-dormancy.mjs --beacons` varies beacon activation during insertion, with
all three production machines disabled throughout. On/off/on yielded exact input
counts 9/7/9 and crafting speeds 17.375/1.75/17.375. After switching the beacon off,
three later observations retained 9/7/9. This reproduces the loss mechanism and
falsifies a need to let the crushers run. An injected build failure verified owned
cleanup (`transfer-cleanup-crafter-mttovapu.json`). The first observation is
`transfer-cleanup-crafter-mttovnce.json`; the independent repeat with explicit
assertions passed in `transfer-cleanup-crafter-mttp1evr.json`. These use one shared
legendary beacon, two legendary speed modules, three legendary crushers, a power
source and one temporary platform; there is no cargo repair or altered recipe.
The source constructor's earlier Lua syntax error is retained as HARNESS_ERROR,
not engine evidence. Request/read/deadline bounds remain those stated above.

The corrected inventory scheduler keeps beacon effects through all dependent
inventory writes, then disables beacons in a final bounded scan. Other production
entities remain dormant between callbacks. The regression fails against commit
7a71cad with "beacon disabled before dependent inventory capacity was restored"
and passes against the corrected code; it also asserts beacon shutdown before
fluid restoration and validation. Interruption/reload regressions still pass.

Preserving deployment backed up both saves as `predeploy-20260909-020151-585.zip`.
The identical richer blueprint/book fixture then passed for
`836570928:232_invstate-mttozmpc`: successful cargo gate, independent physical
blueprint content and book-page checks, applied=4/declined=0/failed=0 in both engine
logs and stored details, and owned cleanup. Full output is retained in
`ci-artifacts/batching-beacon-inventory-state.log`. This fixture's whole-cargo
verdict comes from the runtime gate; its independent physical checks cover the
blueprints/books, not every item. Universal inventory fidelity is not claimed.
