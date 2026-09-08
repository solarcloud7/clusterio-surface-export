# Tick-batched export and import jobs

Current behavior reviewed on 2026-09-08 for the Factorio 2.1.17 configuration.
The filename, `AsyncProcessor` API, and `storage.async_jobs` identifiers remain unchanged.

## Execution model

The plugin's Lua callbacks run synchronously on the Factorio simulation thread. A
callback must finish before that thread can continue. Queuing a job defers work to
later callbacks; it does not start a background Lua worker.

**Tick-batched processing** retains job state and processes another batch during a
later `on_tick` callback. Simulation updates can occur between batches. Outstanding
jobs are concurrent in the scheduling sense, but their Lua work executes sequentially.
This does not mean that every Factorio subsystem is single-threaded. Clusterio's
separate Node processes also perform asynchronous requests and I/O.

At the nominal 60 updates per second, the interval is approximately 16.67 ms. This
is not an enforced callback deadline or a budget reserved for this plugin. A long
callback delays the next update. Batching does not guarantee stable UPS or no hitches.

## Controller admission queue

The web transfer action and `surface-export start-transfer` command enter a controller
queue before sending an export request. Acceptance means **queued**, not arrived.
Requests sharing either their source or destination instance run in arrival order;
independent instance pairs can run concurrently. Reservations last through terminal
cleanup or rollback. An unresolved pending-transfer intent also blocks admission on
its instances. Duplicate requests for the same source platform reuse the queue entry;
a different destination is refused while that entry exists.

Queued platforms remain untouched until dispatch. The gateway map shows a queued marker
at the source endpoint, followed by preparation and then transfer motion. The controller's
monotonic `Transfer queue wait` span records waiting separately from export work; the
observed operation duration includes it. The provisional request ID is carried as
`queuedRequestId` when the canonical source-job transfer ID becomes known.

The queue has a 100-request bound and journals admission before acknowledging it in
`surface_export_transfer_queue.json` beside the transaction log store. On a controller
restart, unfinished requests are reported as interrupted rather than replayed. A request
that had started export may have an uncertain outcome; the existing recovery safeguards
still apply. Queued requests do not survive restart as automatically executable work.

This admission queue covers controller-requested transfers. In-game/source-initiated
exports, stored-artifact transfers, and standalone imports keep their existing entry
paths. Already-active operations on those paths block overlapping queued requests;
the queue does not change the Lua scheduler or eliminate expensive synchronous scans.

Verification: a local three-platform concurrent submission completed in order through
source cleanup, retained measured queue waits under the canonical IDs, and left no
test platforms after cleanup. This verifies admission behavior, not a throughput gain.

## Scheduler and synchronous work

[`AsyncProcessor.process_tick()`](../docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua)
services pending mining-progress restoration, latch rearming, gateway staging, and
import-session cleanup, then sorts jobs by `started_tick`. It visits at most
`max_concurrent_jobs` entries sequentially. Export and import completion start on the
next eligible tick after the final entity batch.

The limit counts job visits per tick, not admitted jobs, threads, or milliseconds.
An import waiting for its deferred phase still occupies a visit. Earlier jobs can
delay later jobs; this is not round-robin scheduling. With three visited entity jobs
and batch size 50, a tick can examine up to 150 entity entries plus other work.

| Path | Count-limited work | Work outside the entity batch limit |
|---|---|---|
| Export | Entity serialization | Queue preparation; final belt capture/cargo integrity; verification construction; encoding, compression, and completion |
| Import | General entity creation; captured belt side groups | Payload preparation and platform creation; tiles; beacon pre-placement; hub, oversized side groups/unsupported belt networks, state, inventory, held-item and fluid restoration; validation, activation, and reporting |

Export batches skip belt-item capture and retain belt references. Completion reads
their contents in one synchronous pass without simulation updates between those
reads. That consistency boundary can be expensive and is not limited by `batch_size`.

Export capture and cargo checks remain in one callback. JSON serialization runs on
the next visit; compression, cache output and publication follow on another visit.
Source diagnostic files reuse the serialized JSON bytes instead of encoding the same
payload again. Encoding itself remains an indivisible synchronous operation. The Lua
regression `tests/lua/export-phase-yields.lua` checks these callback boundaries and
the identical diagnostic bytes; live callback measurements are recorded in the manual
Docker acceptance notes. This does not bound export setup or a large connected belt network.

Import visits yield after tiles, beacon pre-placement, the final entity batch, hub
contents, the final belt batch, inventories, and held items. Each next phase starts
on a later eligible tick. Hub mapping runs once before beacons. Belt writes and their
immediate physical checks remain together within each batch. State restoration still
sets `pending_beacon_tick = game.tick + 1` before inventories, with beacon inventories
preceding other inventories. Scratch inventories are released before yielding;
activatable entities remain disabled until activation; belts can still move. Progress is stored on the job,
including the next completion phase, so module reload does not repeat finished work.

Fluid injection, exact cargo verification, activation, and result handling remain
in one callback. Advancing the simulation between injection and verification could
change fluid amounts or temperatures. The failure branch still discards the failed
destination and reports its verdict for source rollback. No phase yield enables
early activation or removes the cargo gate. A phase can still be individually
expensive; these boundaries separate consecutive work, not arbitrary parts of a phase.

The 2026-09-07 force-insertion change replaces belt placement, not scheduling. Captured
positions are passed to `force_insert_at`; alternate-position scans and stack merging are
removed. The physical side-group and item-state checks remain. `batch_size` still controls
entity creation and does not bound the synchronous belt-item restoration phase.

Live round-trip records `836570928:106_belt-roundtrip-1788758774956` and
`902099405:052_belt-roundtrip-1788758774956` each recorded 28 destination entity batches
on 28 work ticks (27 elapsed ticks). Each belt phase recorded one batch on one work tick
(zero elapsed ticks), with roughly 115–126 ms of profiler execution time. These are separate
measurements; zero elapsed ticks does not mean zero work. No before/after performance gain
is established. Those records predate the connected-network batching described below.
Evidence: `ci-artifacts/force-insert-roundtrip.json` and the
[belt experiment notebook](../tests/instruments/belt-boundary/README.md).

For 1,000 queued entity entries at batch size 50, the entity loop needs 20 batch
visits, assuming no early failure. This excludes setup, deferred phases, completion,
and queue delay. It does not establish a measured 333 ms duration or zero game impact.

Sources: [export-pipeline.lua](../docker/seed-data/external_plugins/surface_export/module/core/export-pipeline.lua),
[import-pipeline.lua](../docker/seed-data/external_plugins/surface_export/module/core/import-pipeline.lua),
[import-completion.lua](../docker/seed-data/external_plugins/surface_export/module/core/import-completion.lua).

## Import phase-yield acceptance (2026-09-08)

Factorio 2.1.17, save-patched Lua 0.10.281: the disposable 1,359-entity fixture
completed host 1 -> 2 and host 2 -> 1, then deliberately rejected a third transfer.
Every tested phase boundary above advanced to a later tick. Entity creation used
28 work ticks and belts used 14 work ticks; import took 48 elapsed ticks. Fluid
injection, verification, and successful activation shared the final tick. These
are scheduling counts, not milliseconds.

The successful legs had exact per-item cargo parity (43,554 and 43,486 items) and
matching fluid totals (151,954.7280768752 and 151,884.7280768752). The deliberately
rejected leg also matched physical counts (43,541 items); its forced verdict
confirmed rollback acknowledgement, source preservation, and destination removal.
The separate belt item-state transfer also passed all eight state writes and physical
readbacks (`ci-artifacts/import-phase-item-state.log`). Disposable platforms were
removed and test settings restored. Evidence:
`ci-artifacts/import-phase-roundtrip.json` and `import-phase-deploy.log`.

`tests/lua/import-phase-yields.lua` drives the production scheduler and completion
code with fake engine operations, including module reload between every callback,
standalone import, belt failure, validation rejection, an existing deferred job,
and inventory exceptions. Live tick-boundary assertions are retained in
`tests/integration/belt-item-state/roundtrip.mjs` with `--profile-batches`.

This proves the new scheduling boundaries and these transfer outcomes. It does not
establish a latency improvement or bound the longest remaining callback.

## Work-budget investigation (2026-09-07)

Read-only audit of 85 retained operations saved between 2026-09-07 00:08 and
22:51 UTC, across multiple deployments and fixtures. This is historical evidence,
not a benchmark of the currently deployed revision. The offline analyzer reparsed
3,514 completed/failed execution readings and found no mismatches with their raw
profiler strings. Six selected slow-stage readings also matched original Factorio
output in the persisted cluster log, independently of the transaction store.

| Stage | Largest retained execution reading | Boundary / evidence |
|---|---:|---|
| Source preparation | 22,353.801 ms | One invocation, zero elapsed ticks; operation `836570928:1788806972746_lab-omnibus-state-v1`, 542 entities, 12,339 exported tiles |
| Destination tiles | 1,119.731 ms | One invocation; operation `836570928:083_oneofeach-fixture-v1`, 37,632 exported tiles |
| Source belt capture | 404.562 ms | One invocation; operation `836570928:126_lab-transfer-fixture-v1` |
| Destination inventories | 113.038 ms | One invocation; same `126` operation, 1,359 exported entities |

Two other preparation readings were 20,095.605 and 20,084.829 ms (operations
`836570928:079_lab-transfer-fixture-v1` and `836570928:082_lab-omnibus-state-v1`).
Original log messages put the long gap after schedule capture and before the
scanned-entities/tiles message. That narrows the unmeasured substeps to entity
collection, placement sorting, and tile scanning; it does not identify which one
caused the delay. `tile_scanner.lua` currently requests every tile and only then
excludes empty space in Lua. Split those measurements before choosing a fix.

These are stage execution intervals, not exclusive CPU times or complete callback
measurements. Do not add maxima from different operations, nested validation stages,
or parent stages and their debug batches. In the debug subset, the largest recorded
source entity batch was 51.791 ms and destination entity batch 14.448 ms. These are
limited samples, not global maxima. The scheduler has no enclosing callback timer;
stage totals alone cannot establish the maximum pause across several jobs.

### Candidate limits and required consistency checks

| Work | Candidate boundary | What must remain true |
|---|---|---|
| Export preparation | Separate entity collection, sorting, and tile-scan measurements; bounded spatial tile queries | Preserve the exact exported tile set; avoid gathering an unbounded list before the first yield |
| Tile placement / beacon creation | Tile batches, then beacon batches, before general entities | Foundation precedes overlays; no entity creation before its supporting tiles and required beacons are ready |
| Import inventories | Cursor over inventories and item slots, with beacons/modules first | Preserve slot identity and item-state session cleanup on success, failure and reload; entity count alone cannot bound a large inventory |
| Entity state / connections | Ordered passes with retained cursors | All referenced entities exist; verify circuit memory, copper links, proxies and logistic groups across inserted ticks |
| Belt and fluid contents / cargo verification | Only independently isolated networks or proven consistent snapshots | Moving contents must not be double-counted or missed between reads; keep the mandatory cargo gate and defer activation until it passes |
| Serialization, compression, native deletion | Bound input size or redesign payload/storage boundaries | A tick before an indivisible native call does not limit that call; preserve payload compatibility and cleanup acknowledgements |

The first measurement change should wrap the whole scheduler invocation and its
per-job visit, including consecutive completion phases. Setup invoked from RCON
needs its own callback measurement. Use the existing optional batch telemetry cap;
do not sum overlapping parent/child intervals or introduce a second time conversion.
Do not allow a stage transition to run the next heavy stage in the same job visit.
A shared work allowance must also account for multiple jobs visited in one tick.

Lua cannot use a profiler reading as a numeric deadline: the
[2.1.17 LuaProfiler API](https://lua-api.factorio.com/latest/classes/LuaProfiler.html)
intentionally withholds raw times from Lua because they are nondeterministic. Use
deterministic work counts and tune them from external profiler analysis. The
[tile search API](https://lua-api.factorio.com/latest/classes/LuaSurface.html#find_tiles_filtered)
supports bounded areas; an unbounded query followed by a smaller Lua loop is not
bounded preparation. API support alone does not prove the speed or fidelity of a
replacement; use a bounded fixture and compare the resulting tile set before rollout.

Reproduce the offline analysis after building the plugin:

```sh
node tools/surface-export/analyze-work-budgets.mjs <transaction-log-store.json> <report.json>
```

Local evidence: `ci-artifacts/callback-audit/retained-records.json`, `report.json`,
`raw-log-evidence.json` and `corroboration.json`. These artifacts are ignored by git.
Analyzer checks rejected tick-only, mismatched and interrupted records and deduplicated
revisions. This investigation did not change runtime scheduling or run new transfers.

### Whole-callback probe (2026-09-08)

The [bounded callback probe](../tests/instruments/callback-profile/README.md) now wraps
the actual scheduler for temporary acceptance fixtures. Stopped profiler readings retain
their raw output and exact simulation tick, with no tick-to-time conversion. It restores
the original scheduler in cleanup and does not add production log traffic.

`ci-artifacts/transfer-cleanup-mtss5rbi.json` passed transfer, deletion-failure recovery
and cleanup. Its six-entity fixture recorded two source callbacks (maximum **11.305 ms**)
and eighteen destination callbacks (maximum **9.502 ms**), with no truncation. This
measures complete scheduler invocations including nested instrumentation. RCON setup
is outside this boundary; no large-platform or controlled overhead claim follows.
The historical slow preparation and tile stages above still need representative,
separately bounded measurement before a new batching change is justified.

## Performance controls

These instance settings are declared in [index.ts](../docker/seed-data/external_plugins/surface_export/index.ts)
and sent to Lua on instance start by [instance.ts](../docker/seed-data/external_plugins/surface_export/instance.ts).

| Setting | Default | Current effect |
|---|---|---|
| `surface_export.batch_size` | 50 | Entity-list entries per visited export or general entity-creation batch; not milliseconds or a limit on all phases |
| `surface_export.belt_batch_size` | 500 | Soft stack/member-line work target per belt callback; each captured side group remains atomic |
| `surface_export.belt_trace` | `false` | Expensive successful belt position diagnostics; failure traces and mandatory cargo integrity stay enabled |
| `surface_export.max_concurrent_jobs` | 3 | Job entries serviced per scheduler invocation, sequentially |
| `surface_export.show_progress` | `true` | Conditional progress notifications and periodic job logging |
| `surface_export.profile_batches` | `false` | Additional bounded batch-level profiler records; phase totals remain enabled |
| `surface_export.debug_mode` | `true` | Debug behavior and diagnostic output, not a processing budget |
| `surface_export.debug_destination_snapshot` | `false` | Full destination snapshot on successful transfers; also requires debug_mode |
| `surface_export.max_export_cache_size` | 10 | Retained Lua export-cache limit, with a floor of `max_concurrent_jobs + 1`; affects retention/memory |

Temporary Lua-side configuration uses unprefixed keys:

```lua
/sc remote.call("surface_export", "configure", {batch_size = 25, max_concurrent_jobs = 1})
```

The entity scheduler values are module-local; belt controls are retained in storage. Remote adjustments do not update Clusterio's
instance configuration; instance startup sends its configured values again. The belt budget enforces integers from 1 through 1,000,000. Entity/job setters
do not enforce positive-integer ranges. Use positive integers for the batch/job
counts; zero is not a supported pause mechanism.

`/export-sync-mode on` changes the effective batch size to **1,000,000**, for both
export and import. It does not introduce another execution model, process unlimited
entities, or remove import's deferred phase-2 boundary. `/export-sync-mode off`
restores the configured batch size. No argument toggles the mode; it is not a read.

Smaller batches can reduce work per entity callback while increasing job latency.
Fewer visits can reduce aggregate work per tick while increasing queue waits.
Neither setting limits synchronous completion work. Compare the same payload,
engine/mod versions, settings, and job load when evaluating performance.

## Measurement contract

Timing has three independent signals. They are never converted or averaged together.

| Signal | Clock and boundary | Display |
|---|---|---|
| Clusterio elapsed time | Node `performance.now()` within one process and observation | Controller waterfall; expandable instance-handler/RCON waterfalls, each with its own origin |
| Lua elapsed time | A continuously running job `LuaProfiler`; stopped snapshots at phase boundaries | Source, destination, and recovery waterfalls on their own local clocks |
| Lua execution elapsed time | Accumulating profiler restarted/stopped around each batch | Execution column; excludes time between callbacks |
| Scheduling | Exact `game.tick` boundaries, their difference, batch count, distinct work ticks | Separate step details; never waterfall geometry |

Every measured row carries start, end, status, clock identity and measurement source.
Missing boundaries produce no duration bar. A completed zero-tick phase may take
hundreds of milliseconds. An inclusive handler includes awaits and remote work;
it is not exclusive CPU time. A request round trip is not pure network latency.
Uncovered intervals remain uninstrumented. Overlapping durations cannot be added.

The headline starts when the controller observes the operation request and ends
at its terminal outcome, including required cleanup acknowledgement. Audit
persistence has a separate span afterward. Source-initiated and stored-export
transfers begin controller observation after the source export exists; earlier
Lua work is shown separately. UTC dates remain human correlation information.
Clock identities change on process/instance restart. An unfinished old observation
is interrupted with no fabricated finish; it cannot be continued on the new clock.

## Boundary inventory

This inventory names the actual instrumented boundaries. Rows with several labels
represent separate spans; there are no per-entity records. Applicability depends on
the execution path. Phase completion emits explicit skipped records for branches
that did not run; missing log output remains unavailable instead of becoming zero.
The source job begins after resolving its platform name; request-level failures
before a job exists are observed by Clusterio, without a fabricated Lua job.

| Owner | Label(s) | Start → end | Applicability / source |
|---|---|---|---|
| Source Lua | preflight; locking | Validity/hub checks; lock call | Export queue in `export-pipeline.lua` |
| Source Lua | preparation | Schedule capture, entity scan and job setup → enqueued | All queued exports |
| Source Lua | scheduler wait | Enqueued → first scheduler visit | Wait, no execution accumulator |
| Source Lua | entities | Each entity batch entry → return | Phase envelope and accumulated batches; includes paired per-entity cargo integrity |
| Source Lua | belt capture; ground items | Final belt read; ground scan → collected state | Separate completion steps |
| Source Lua | source cargo integrity | Cargo verdict, blueprint comparison and report → completed check | Includes cargo-integrity diagnostics, distinct from entity capture |
| Source Lua | finalize payload; serialization; compression | Payload metadata → ready; JSON encode; compression call | Separate execution spans |
| Source Lua | cache output; diagnostic output; file output | Cache insertion; debug export; requested file write | Cache always; diagnostics/file output conditional |
| Source Lua | source unlock; failure diagnostics | Unlock call; cargo-integrity rejection black-box write | Standalone export / source rejection |
| Destination Lua | chunk delivery; chunk assembly | First chunk → assembled payload; concatenation call | RCON chunk path, separate job clock from import |
| Destination Lua | queue setup | Intake → scheduled job | Inclusive envelope, not another validation check |
| Destination Lua | decode; decompression; decode payload | Outer JSON parse; decompression; inner JSON parse | Decode/decompression branches explicit |
| Destination Lua | compatibility checks | Schema, required metadata, schedule and verification checks | Before platform creation |
| Destination Lua | platform preparation | Target creation/starter pack and schedule setup → queued | Synchronous setup |
| Destination Lua | scheduler wait | Enqueued → first import visit | Wait, no execution accumulator |
| Destination Lua | tiles; beacons; entities; hub mapping | Actual restoration callbacks | Tiles/beacons synchronous; entity batches accumulate across ticks |
| Destination Lua | hub; belts; state | Phase-1 restoration calls | Separate phase totals |
| Destination Lua | deferred beacon wait | Phase 1 sets pending tick → phase-2 callback entry | Wait excluded from execution |
| Destination Lua | inventories; held items; fluids | Phase-2 restoration calls | Separate phase totals |
| Destination Lua | verdict handling | Validation preparation → completion notification | Inclusive envelope, includes reporting and branch handling |
| Destination Lua | verification preparation | Adjust expected counts → exact check | Transfer-shaped payload with verification |
| Destination Lua | exact verification | Exact audit and gate decision → result | Envelope for individual checks |
| Destination Lua | item cargo count; fluid cargo count | Physical recount start → counts | Individual audit checks |
| Destination Lua | item comparison; fluid comparison | Expected/actual comparison → verdict | Failed comparisons explicitly marked failed |
| Destination Lua | diagnostic capture; diagnostic output | Destination scan/schedule capture; diagnostic export write | Successful transfer with debug_mode and debug_destination_snapshot enabled |
| Destination Lua | failure diagnostics; passenger evacuation; destination recovery | Black-box attempt; evacuation; failed destination deletion | Failure branch; failures never gate recovery |
| Destination Lua | activation | Restore activity after cargo validation; no second cargo recount | Successful gate (standalone activation has its own branch) |
| Recovery Lua | source deletion; source unlock | Actual remote recovery call → result | Separate recovery job clock, matched by source export ID |
| Controller | Observed operation | Observed request → terminal result/cleanup acknowledgement | Monotonic headline; source-initiated boundary described above |
| Controller | Artifact receipt and storage; Artifact serialization; Artifact storage write | Export event handler; serialized size calculation; storage persistence | Handler inclusive, serialization execution, storage inclusive |
| Controller | Payload preparation | Payload counts and metrics calculation | Synchronous local work |
| Controller | Import request round trip; Await destination completion; Source cleanup round trip | Phase start → request return, verdict receipt or cleanup result | Broad orchestration envelopes, not pure transport |
| Controller | Clusterio request round trip; Rollback unlock round trip | Request send → response/error | Individual nested request intervals where a request context exists |
| Controller | Destination verdict handling | Verdict handler entry → return | Inclusive, including cleanup/rollback awaits |
| Controller | Audit persistence | Detail/audit write entry → return | Separate from terminal headline |
| Instance | Export/Import request handling; completion handling; deletion/unlock handling | Handler entry → return | Local process clocks; asynchronous inclusive intervals |
| Instance | RCON request round trip; RCON payload upload | RCON call; entire chunk upload loop | Inclusive of Factorio work and scheduling |
| Instance | Payload serialization; Artifact JSON decoding | JSON conversion call → return | Local synchronous execution |

Sources: [operation-timing.lua](../docker/seed-data/external_plugins/surface_export/module/utils/operation-timing.lua),
[timing.ts](../docker/seed-data/external_plugins/surface_export/lib/timing.ts),
[transaction-logger.ts](../docker/seed-data/external_plugins/surface_export/lib/transaction-logger.ts).
This inventory is not a claim that every auxiliary engine operation has a span.
Latch/mining rearm work after import completion and actual wire latency are outside
these boundaries. Alternate legacy import-session APIs do not gain an invented
chunk-delivery duration from the primary chunk path.

## Transport and retention

Factorio 2.1.17 renders a profiler as `Duration: 0.397571ms`. Lua cannot read its
numeric value. The module logs a versioned `[SE_TIMING_V1]` marker, JSON metadata,
and three tab-separated `LocalisedString` profiler readings. The instance `onOutput`
hook parses explicit units and preserves raw readings. Invalid readings become
unavailable; malformed metadata is diagnosed rather than interpreted as timing.
The [LuaProfiler API](https://lua-api.factorio.com/2.1.17/classes/LuaProfiler.html)
defines accumulation, restart/stop and rendered output.

Transaction details and diagnostic downloads carry an optional `timing: {v: 1,
records: [...]}` collection. Stable clock/record IDs and increasing revisions make
repeated, late and out-of-order delivery idempotent. Early source measurements are
associated using the existing canonical export identity; stored exports retain
that evidence until transferred. Late evidence updates retained terminal details
without reopening transfers, changing validation or deleting a source.

Stored artifacts retain source Lua and artifact-storage measurements. A later
transfer has its own operation records; its import, recovery and verdict spans
must not be attached to the earlier standalone export. Direct operation identity
takes precedence over a shared artifact clock when associating late records.

Unmatched telemetry is limited to 10,000 records and five minutes, pruned on arrival
with an explicit discard diagnostic. Controller clock retention targets
1,000 observations, evicting settled clocks; active observations can exceed this target. Phase
measurements are always emitted. `surface_export.profile_batches` defaults to
`false`; enabling it adds up to **2,000 individual batch records per Lua job**.
Truncation is explicit and phase totals continue beyond the limit. Profilers are
module-local, never serialized into simulation storage. Reloads lose unfinished
profiler objects; stored start evidence stays incomplete/interrupted.

Historical JSON remains readable in Technical details. Legacy tick-derived
milliseconds, synthetic residuals and tick-based offsets are excluded from
waterfalls. `surface_export_export_stall_seconds` was removed; the replacement
`surface_export_export_ticks` explicitly measures ticks. No dashboard should treat
that as a rename preserving units.

## Verification (2026-09-06, Factorio 2.1.17)

Reproducible drivers:

- `node tools/surface-export/probe-timing.mjs`: bounded fixed workloads, no world
  entities changed; requires debug mode. Restores the batch-debug setting.
- `node tests/integration/upload-import-verdict/run-tests.mjs`: successful standalone
  import, belt rejection and exact item-gate rejection; physical cleanup checked.
- `node tests/integration/hub-request-sections/run-tests.mjs`: real successful transfer
  and forced validation rejection/rollback; owned fixtures removed afterward.
- `node tools/surface-export/reconcile-timing.mjs`: matches retained readings against
  actual Factorio logs and reparses boundaries, execution time and exact ticks.
- `node tools/surface-export/check-timing-ui.mjs`: deployed browser assertions for
  separate clocks, numeric readings, historical labels and no tick-only geometry.

Observed evidence, not general performance guarantees:

| Check | Result |
|---|---|
| Same-tick work | 100 batches, 0 elapsed ticks, **68.687949 ms** accumulated execution |
| Two callbacks with an intervening wait | 42 elapsed ticks; **700.582591 ms** envelope, **1.339580 ms** execution |
| Debug cap | Exactly 2,000 batch records; totals still reported 2,005 batches |
| Real transfer | 81 timing records; 55 Lua readings matched raw logs; observed operation **115.635294 ms** |
| Real failed transfer/rollback | 81 records; 55 raw readings matched; observed operation **149.562185 ms**; source preserved, destination removed |
| Standalone import arms | 46 records each, including Lua measurements for both rejection paths |
| Browser | Profiler values match fixture readings; tick-only records draw zero bars; legacy evidence labelled |

The overhead probe interleaves five baseline/normal/debug samples, each performing
100 fixed batches of 200,000 additions in one callback. Median outer-profiler totals
were **67.679211 ms** baseline, **70.029194 ms** normal and **77.155355 ms** debug.
Differences were about **2.35 ms (3.5%)** and **9.48 ms (14.0%)** for this workload.
These include profiler/logging overhead and local runtime noise. They do not predict
transfer throughput, cross-machine latency or engine frame impact for other payloads.
Raw evidence and reports are written under ignored `ci-artifacts/timing/`.

Unit tests cover parser units/malformed or missing readings, deduplication, late
updates, stored-export association, clock identity, controlled communication delay,
retained-record interruption and rejection/cleanup contracts. Crash/reload handling
is tested as missing evidence, not a synthesized finish. Browser previews include a
sanitized actual profiling capture and a constructed missing-output case.

## Historical mistakes

Previously, `floor(ticks * 16.67)` was labelled milliseconds and used to place Lua
steps on the controller timeline. Zero-tick work became `<1 tick`; a display-only
`Not tick-attributed` calculation filled the remaining window. Neither measured
processing time. Those conversions were not averages and are no longer used for
waterfalls or new elapsed-time metrics.

The old `mptransfer-mtonvmga` record's **124 ms** covered controller observation of
an already-exported payload through source cleanup. It did not include the earlier
source export. Historical profiler reports in [PR #173](https://github.com/solarcloud7/clusterio-surface-export/pull/173)
already showed nonzero execution during zero ticks. The missing piece was the
structured telemetry path and honest clock boundaries, not a faster tick clock.

## Inspecting jobs

The internal `AsyncProcessor.get_active_jobs()` returns job IDs, entity progress,
and `elapsed_ticks`. `AsyncProcessor.get_job_status(job_id)` distinguishes active and
retained result records. These are internal helpers, not registered remote-interface
methods. Entity progress is not a percentage of measured execution time.

Do not remove `storage.async_jobs[job_id]` as a cancellation procedure. That bypasses
cleanup and lock-handling paths. Inspect the job, source lock, destination, and
controller state together before recovery. Platform travel pause and stopping
simulation ticks are different controls; stopping ticks prevents normal scheduler
progress.


## Belt side-group batches (2026-09-08)

The import planner now packs individual captured side groups into callbacks using
`surface_export.belt_batch_size` (default 500). Each group costs the larger of its
stack-slot count, member-line count, or one. A group's insertion and physical delta
check stay in one callback; connected groups may run on different ticks. Existing
cargo may move before the next callback takes its before-snapshot. Validation and
activation still follow completion of every batch. Unsupported types or external
connections retain the conservative atomic fallback.

Rebuilt corners can expose shorter local transport lines. Restoration clamps the
captured distance to that same entity's same lane. Exact quantity, quality and item
state remain required; distance along the lane is not part of the acceptance contract.
Nonfinite positions are rejected before insertion. No deficit recovery or cargo
redirection is added.

The budget remains a soft work target: one large captured side group can exceed it.
This change does not batch source belt capture, serialization, or other Lua phases.
Destructive source capture/removal is still an experiment; it needs durable recovery
before production use.

Isolated 2.1.17 acceptance: eight dense topology/order arms (816 items), four junction
arms (516 items), and the retained 596-belt fixture (19,700 items in 14 callbacks)
passed physical checks. New writes matched their captured member lines; whole cargo
quantities stayed exact across tick gaps. Junctions also verified item properties at
write boundaries while allowing ordinary side-loading between callbacks. Evidence:
`ci-artifacts/belt-import-groups-result.json`, `belt-import-junctions-result.json`,
and `belt-helper-connected-result.json`; runnable probes and independent verifier
are under `tests/instruments/belt-boundary`.


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

### Previous network-batching implementation and measurements (2026-09-07)

The following describes the earlier implementation and its recorded local results.
Its atomic-network limit is superseded by the side-group implementation above.

`surface_export.belt_batch_size` defaults to **500** work units independently of
entity `batch_size`. Each side group costs the larger of its stack-slot count,
member-line count, or one. The planner joins both lanes of each belt, connected
inputs/outputs, splitter branches, and underground partners. It packs whole
connected networks into callbacks; it never splits a connected network to meet
the target. A large network can exceed the target. This is a soft work budget,
not a milliseconds limit or a guarantee against lag.

Transport lines continue moving between callbacks: `disabled_by_script` does not
pause belts. Each network is fully inserted and physically checked before yielding.
Restored consumer entities remain inactive through belt batching, including standalone
imports. Transfers activate only after validation; standalone imports retain their
existing activation point after inventory and fluid restoration. Unsupported belt types (including loaders) or connections outside the
captured entity map conservatively use one atomic belt batch. These cases retain
the previous synchronous behavior and may still cause long callbacks.

Each callback accumulates placement and item-state results. The belt restorer keeps its
physical placement witnesses; the importer no longer aggregates a diagnostic phase census.
A failed callback stops further belt batches and follows the existing validation
and recovery path. Hub restoration executes once. State restoration and the deferred
beacon/inventory phase follow the final belt batch. Belt profiler execution stops
between callbacks; start/end ticks retain the first and last callback boundaries.

`surface_export.belt_trace` defaults to **false**. It enables expensive successful
position-trace diagnostics independently of `debug_mode`. Physical cargo counts and
item-state checks remain mandatory, and failures still produce diagnostic traces.

The isolated Factorio 2.1.17 fixture restored 19,700 items in seven separate callbacks
with long intervening tick gaps. Each newly restored network matched captured
positions, names, qualities and counts. Independent network cargo totals matched
after every gap, with zero unplaced items or structural anomalies. Previously
restored belts are allowed to move within their network; final positions are not
claimed to remain frozen. Evidence: `ci-artifacts/belt-helper-batched-result.json`.
Deployed acceptance completed two transfers and a forced rejection with acknowledged
rollback, source preservation and destination removal. Every belt phase recorded
seven batches on seven work ticks (six elapsed ticks). Successful legs accumulated
83.169 and 91.436 ms of belt execution; their longest belt callbacks were 37.777 and
54.004 ms. The rejected leg's longest belt callback was 64.838 ms. These local samples
include debug-batch profiling and runtime noise; they are not a controlled benchmark
or a guarantee that every callback meets a frame budget. Earlier single-callback
115–126 ms measurements also had successful diagnostic tracing enabled.

A separate deployed transfer preserved eight non-default item states with physical
destination readback (blueprint contents, entity data, health, ammo, durability and
spoilage), zero state failures, and matching persisted counters. The deployed
self-test passed 27 checks. The unit suite passed 643 tests with eight skipped.
Evidence: `ci-artifacts/belt-batching-roundtrip.json`, `belt-batching-item-state.log`,
`belt-batching-selftest.json` and `belt-batching-unit-tests.log`. Disposable clones
were removed, settings restored, and jobs/locks/holds/tombstones were clear.
