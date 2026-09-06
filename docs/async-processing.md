# Tick-batched export and import jobs

Current behavior reviewed on 2026-09-06 for the Factorio 2.1.17 configuration.
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

## Scheduler and synchronous work

[`AsyncProcessor.process_tick()`](../docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua)
services pending mining-progress restoration, latch rearming, gateway staging, and
import-session cleanup, then sorts jobs by `started_tick`. It visits at most
`max_concurrent_jobs` entries sequentially. A finished entity batch can immediately
execute completion work in that same callback.

The limit counts job visits per tick, not admitted jobs, threads, or milliseconds.
An import waiting for its deferred phase still occupies a visit. Earlier jobs can
delay later jobs; this is not round-robin scheduling. With three visited entity jobs
and batch size 50, a tick can examine up to 150 entity entries plus other work.

| Path | Count-limited work | Work outside the entity batch limit |
|---|---|---|
| Export | Entity serialization | Queue preparation; final belt capture/census; verification construction; encoding, compression, and completion |
| Import | General entity creation | Payload preparation and platform creation; tiles; beacon pre-placement; hub, belt, state, inventory, held-item and fluid restoration; validation, activation, and reporting |

Export batches skip belt-item capture and retain belt references. Completion reads
their contents in one synchronous pass without simulation updates between those
reads. That consistency boundary can be expensive and is not limited by `batch_size`.

Import completion has two callbacks. Phase 1 restores hub contents, belts, and state,
then sets `pending_beacon_tick = game.tick + 1`. Phase 2 runs on an eligible later
visit, restoring inventories after the beacon update boundary, followed by held
items, fluids, validation, and completion handling. Beacon inventories precede other
inventories. Preserve the implementation's phase ordering and validation/failure
branches; changing scheduling does not authorize reordering restoration or activation.

For 1,000 queued entity entries at batch size 50, the entity loop needs 20 batch
visits, assuming no early failure. This excludes setup, deferred phases, completion,
and queue delay. It does not establish a measured 333 ms duration or zero game impact.

Sources: [export-pipeline.lua](../docker/seed-data/external_plugins/surface_export/module/core/export-pipeline.lua),
[import-pipeline.lua](../docker/seed-data/external_plugins/surface_export/module/core/import-pipeline.lua),
[import-completion.lua](../docker/seed-data/external_plugins/surface_export/module/core/import-completion.lua).

## Performance controls

These instance settings are declared in [index.ts](../docker/seed-data/external_plugins/surface_export/index.ts)
and sent to Lua on instance start by [instance.ts](../docker/seed-data/external_plugins/surface_export/instance.ts).

| Setting | Default | Current effect |
|---|---|---|
| `surface_export.batch_size` | 50 | Entity-list entries per visited export or general entity-creation batch; not milliseconds or a limit on all phases |
| `surface_export.max_concurrent_jobs` | 3 | Job entries serviced per scheduler invocation, sequentially |
| `surface_export.show_progress` | `true` | Conditional progress notifications and periodic job logging |
| `surface_export.profile_batches` | `false` | Additional bounded batch-level profiler records; phase totals remain enabled |
| `surface_export.debug_mode` | `true` | Debug behavior and diagnostic output, not a processing budget |
| `surface_export.max_export_cache_size` | 10 | Retained Lua export-cache limit, with a floor of `max_concurrent_jobs + 1`; affects retention/memory |

Temporary Lua-side configuration uses unprefixed keys:

```lua
/sc remote.call("surface_export", "configure", {batch_size = 25, max_concurrent_jobs = 1})
```

The scheduler values are module-local. Remote adjustments do not update Clusterio's
instance configuration; instance startup sends its configured values again. Setters
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
| Source Lua | entities | Each entity batch entry → return | Phase envelope and accumulated batches; includes paired per-entity census |
| Source Lua | belt capture; ground items | Final belt read; ground scan → collected state | Separate completion steps |
| Source Lua | verification census | Census verdict, blueprint comparison and report → completed check | Includes census diagnostics, distinct from entity capture |
| Source Lua | finalize payload; serialization; compression | Payload metadata → ready; JSON encode; compression call | Separate execution spans |
| Source Lua | cache output; diagnostic output; file output | Cache insertion; debug export; requested file write | Cache always; diagnostics/file output conditional |
| Source Lua | source unlock; failure diagnostics | Unlock call; census-abort black-box write | Standalone export / source rejection |
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
| Destination Lua | item census; fluid census | Physical recount start → counts | Individual audit checks |
| Destination Lua | item comparison; fluid comparison | Expected/actual comparison → verdict | Failed comparisons explicitly marked failed |
| Destination Lua | diagnostic capture; diagnostic output | Destination scan/schedule capture; diagnostic export write | Debug branch |
| Destination Lua | failure diagnostics; passenger evacuation; destination recovery | Black-box attempt; evacuation; failed destination deletion | Failure branch; failures never gate recovery |
| Destination Lua | activation; loss analysis | Restore activity; post-activation recount/analysis | Successful gate (standalone activation has its own branch) |
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
