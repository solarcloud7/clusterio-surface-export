# Timing instrumentation

This map identifies instrumented boundaries in the current entry points. Labels
can have parent/child overlap and applicability differs by operation. It does not
certify that every error path emits every record. Missing output or boundaries
remain unavailable, not zero or implicitly skipped.

The source entry points are `export-pipeline.lua`, the export scanner modules,
`import-pipeline.lua`, `import-completion.lua`, `operation-timing.lua`, the Node
instance plugin and transfer orchestrator under the
[plugin root](../../docker/seed-data/external_plugins/surface_export/).
Use the [measurement explanation](../technical/timing.md) for clock semantics and
the [batching guide](../technical/batching.md) for scheduling boundaries.

| Owner | Label(s) | Start → end | Applicability / source |
|---|---|---|---|
| Source Lua | preflight; locking | Validity/hub checks; lock call | Export queue in `export-pipeline.lua` |
| Source Lua | preparation | Schedule capture, entity collection/sorting, tile scan and job setup → enqueued | Synchronous work before scheduler admission; child spans do not imply yields |
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
| Destination Lua | tiles; beacons; entities; hub mapping | Actual restoration callbacks | Tiles/beacons/entities accumulate execution across batches; hub mapping runs once |
| Destination Lua | hub; belts; state | Phase-1 restoration calls | Separate phase totals |
| Destination Lua | deferred beacon wait | Phase 1 sets pending tick → phase-2 callback entry | Wait excluded from execution |
| Destination Lua | inventories; held items; fluids | Phase-2 restoration calls | Separate phase totals |
| Destination Lua | verdict handling | Validation preparation → completion notification | Inclusive envelope, includes reporting and branch handling |
| Destination Lua | verification preparation | Prepare expected cargo totals → exact check | Transfer-shaped payload with verification |
| Destination Lua | exact verification | Exact audit and gate decision → result | Envelope for individual checks |
| Destination Lua | item cargo count; fluid cargo count | Physical recount start → counts | Individual audit checks |
| Destination Lua | item comparison; fluid comparison | Expected/actual comparison → verdict | Failed comparisons explicitly marked failed |
| Destination Lua | diagnostic capture; diagnostic output | Destination scan/schedule capture; diagnostic export write | Successful transfer with debug_mode and debug_destination_snapshot enabled |
| Destination Lua | failure diagnostics; passenger evacuation; destination recovery | Black-box attempt; evacuation; failed destination deletion | Failure branch; diagnostic-write failure does not authorize cleanup; evacuation failure prevents deletion |
| Destination Lua | activation | Restore activity after cargo validation; no second cargo recount | Successful gate (standalone activation has its own branch) |
| Recovery Lua | source deletion; source unlock | Actual remote recovery call → result | Separate recovery job clock, matched by source export ID |
| Controller | Observed operation | Observed request → terminal result/cleanup acknowledgement | Monotonic headline; earlier source work can precede controller observation |
| Controller | Artifact receipt and storage; Artifact serialization; Artifact storage write | Export event handler; serialized size calculation; storage persistence | Handler inclusive, serialization execution, storage inclusive |
| Controller | Payload preparation | Payload counts and metrics calculation | Synchronous local work |
| Controller | Import request round trip; Await destination completion; Source cleanup round trip | Phase start → request return, verdict receipt or cleanup result | Broad orchestration envelopes, not pure transport |
| Controller | Clusterio request round trip; Rollback unlock round trip | Request send → response/error | Individual nested request intervals where a request context exists |
| Controller | Destination verdict handling | Verdict handler entry → return | Inclusive, including cleanup/rollback awaits |
| Controller | Audit persistence | Detail/audit write entry → return | Separate from terminal headline |
| Instance | Export/Import request handling; completion handling; deletion/unlock handling | Handler entry → return | Local process clocks; asynchronous inclusive intervals |
| Instance | RCON request round trip; RCON payload upload | RCON call; entire chunk upload loop | Inclusive of Factorio work and scheduling |
| Instance | Payload serialization; Artifact JSON decoding | JSON conversion call → return | Local synchronous execution |

Sources: [operation-timing.lua](../../docker/seed-data/external_plugins/surface_export/module/utils/operation-timing.lua),
[timing.ts](../../docker/seed-data/external_plugins/surface_export/lib/timing.ts),
[transaction-logger.ts](../../docker/seed-data/external_plugins/surface_export/lib/transaction-logger.ts).
This inventory is not a claim that every auxiliary engine operation has a span.
Deferred circuit/mining restoration after import completion and actual wire
latency are outside these boundaries. The upload protocol owns its own spans;
missing upload measurements are not reconstructed from import ticks.
