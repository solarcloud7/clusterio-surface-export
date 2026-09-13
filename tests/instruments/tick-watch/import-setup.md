# Import setup hitch investigation

Factorio 2.1.17, module 0.10.281, 2026-09-09. This investigation does not change
the production serializer, wire format, import scheduler or cargo gate.

## Reproduced boundary

The [full-transfer baseline](baseline-2.1.17.json) recorded its longest destination
server/client update gap at tick 52922076. The import setup envelope occupied that
same tick. The source payload had 3,092,846 JSON bytes, compressed to 93,440 base64
characters. Entities account for 1,924,784 JSON bytes and tiles for 1,060,097;
together they are about 96.5% of the document. These are measured bytes of this
fixture, not a bound on other platforms.

`ImportPipeline.queue` does the following before inserting the import job into
`storage.async_jobs`:

1. Parse the small outer envelope.
2. Inflate the compressed payload.
3. Parse the entire resulting JSON document through `Util.json_to_table_compat`.
4. Check compatibility, schedule and required cargo-verification fields.
5. Create the platform, apply its starter pack, clear starter cargo, and set its
   destination/schedule.

The compatibility helper calls `helpers.json_to_table` exactly once. The official
[JSON API](https://lua-api.factorio.com/latest/classes/LuaHelpers.html#json_to_table)
accepts one string and returns its decoded value; it has no incremental cursor.
[Starter-pack application](https://lua-api.factorio.com/latest/classes/LuaSpacePlatform.html#apply_starter_pack)
also has no resumable interface. The measured starter-pack span includes the
subsequent hub-inventory lookup and clearing; it is not a pure engine-call timer.

RCON transport chunks are assembled into one document before this sequence.
Smaller transport chunks alone therefore cannot divide the large JSON parse.
Likewise, a yield between setup phases would separate their costs but would leave
the full-document decoder as one synchronous call.

## Decode-only falsification experiment

Use the exact cached export, without creating or importing any platform. Run only
on unoccupied host-2 with zero active jobs/locks/holds and unpaused ticks. The tool
checks the supplied local JSON against the current source cache before preparing
anything. It retains only temporary package state and never edits that cache.

```powershell
node tests/instruments/tick-watch/decode-budget.mjs --cleanup-proof
node tests/instruments/tick-watch/decode-budget.mjs --run
node tests/instruments/tick-watch/decode-budget.mjs --analyze ci-artifacts/decodebudget-mtupmyua.json
```

The default replay requires `178_transfer-cleanup-tickwatch-mtuop1r6` still in the
source cache and `ci-artifacts/import-setup-exact-payload.json`. For another owned
large-fixture export, pass `<export-id> <local-json-path>` after `--run` or
`--cleanup-proof`. The saved JSON must be that export's exact decompressed document.
The source cache is bounded; a missing export is a refused replay, not permission
to construct an unrelated payload and call it the same test.

Preparation makes independently valid JSON sections from whole entity, tile and
belt-group records, plus metadata. Native-encoded sections must fit within 64 KiB;
the runner targets 60,000 bytes and refuses a single oversized record. At most
100 sections are retained. Preparation and its encoding cost are outside the
measured comparison; this is a decoder experiment, not a producer implementation.

Trials run in full/sections/sections/full order. Each RCON callback parses one
document or one section. Successive callbacks must have different exact game
ticks. The profiler includes decoding and sectional reassembly; full recursive
payload equality is checked afterward, outside that span. Total decode work does
not include RCON delivery, intervening waits, preparation, the equality oracle or
all eventual garbage collection. No player FPS or full-callback latency is measured.

## Results

The injected runner failure passed removal and source-cache preservation in
`decodebudget-mtupmljb`. Actual comparison `decodebudget-mtupmyua` passed all four
full structural equality checks and final removal. The Lua observer hash and
payload SHA-256 are retained in the raw report.

| Trial | Native decode calls | Maximum measured span | Sum of measured spans |
| --- | ---: | ---: | ---: |
| Full document, first | 1 | 77.983 ms | 77.983 ms |
| Sections, first | 55 | 5.991 ms | 81.449 ms |
| Sections, second | 55 | 2.620 ms | 69.167 ms |
| Full document, second | 1 | 79.104 ms | 79.104 ms |

This proves a smaller measured decode/reassembly span for this payload when the
input is already sectional. It does not establish a production speedup or a new
maximum client gap. The work moved across callbacks; it did not disappear.

Offline compression estimate, using Node zlib level 6 for both layouts:
85,496 base64 characters for the original document versus 105,324 for separately
compressed sections, an increase of 23.2%. This excludes protocol framing and is
not Factorio's encoder output or a network-throughput result. Retained calculation:
`ci-artifacts/decode-budget-compression-estimate.json`. Incoming bandwidth and
additional acknowledgements could increase end-to-end transfer duration.

## Measurement scope

The decode experiment measures its supplied payload and codec callbacks. It does
not establish a whole-transfer speedup, a worst client update gap, or crash
recovery for a changed wire format. Smaller RCON chunks do not divide the cost of
an indivisible JSON decode. Current sectional encoding and shared scheduling are
described in [batching and timing](../../../docs/async-processing.md).

## External compression and 1x/2x/4x codec scaling

### Retained evidence and replay

The [evidence manifest](evidence/codec-2.1.17.manifest.json) identifies a compressed
bundle containing both original reports, the exact 3.09 MB captured JSON input,
the pinned API schema, and the exact three harness source files used in those runs.
Their hashes match the original reports. The bundle preserves raw profiler strings
and every frame measurement; it is not just a table of rounded results. It contains
test data and source code, not credentials or a Factorio save.

```powershell
# No Docker, player, export cache or network required:
node tests/instruments/tick-watch/codec-scaling.mjs --recorded
```

This verifies the archive hashes and original source/input provenance, then checks
the recorded cleanup proof and six trial results. It re-analyzes recorded evidence;
it does not execute the archived sources or claim a new live pass.

For a new live run, use the current harness from the repository root. Defaults below
refer to the original local cache/artifact names. If that cache entry was evicted,
create a fresh owned fixture export using the full-transfer runner, retain its exact
decompressed JSON, and pass its ID, JSON file and Factorio 2.1.17 API schema:

```powershell
node tests/instruments/tick-watch/codec-scaling.mjs --cleanup-proof <export-id> <payload.json> <runtime-api.json>
node tests/instruments/tick-watch/codec-scaling.mjs --run <export-id> <payload.json> <runtime-api.json>
```

Host-2 must be unoccupied and pass the existing idle-host guards. The local input
must match its cached export byte-for-byte. A missing cache refuses execution;
the archived JSON is not a replacement for a live cache entry. Argument overrides
and offline archive verification were added after the recorded run; the archived
runner preserves the exact originally executed version. No live behavior change
or fresh performance result is claimed for those tooling additions.

### Live commands and boundaries

Run the next rung manually:

```powershell
node tests/instruments/tick-watch/codec-scaling.mjs --cleanup-proof
node tests/instruments/tick-watch/codec-scaling.mjs --run
node tests/instruments/tick-watch/codec-scaling.mjs --analyze ci-artifacts/codecscale-mtuqz887.json
# Only after a failed runner has stopped, remove its exact owned package state:
node tests/instruments/tick-watch/codec-scaling.mjs --cleanup <codecscale-id>
```

This uses the same retained export and local JSON file as the decode-only replay.
It wraps one, two or four copies of the captured document in a codec container.
These are larger data workloads, **not physically larger platforms**. Both Factorio
codec endpoints run on unoccupied host-2. The Node process runs in that container,
uses persistent localhost RCON, and compresses frames through asynchronous zlib
with one outstanding compression operation. No deployment or game-world mutation
occurs. Compression is outside Factorio; this is not yet the production Clusterio
import handler.

Each source callback serializes one whole-record JSON frame, at most 64 KiB.
Node receives it, compresses and base64-encodes it, then submits it to the separate
decode action. That action inflates, parses and appends it to the decoded copy.
Source and destination action sequences separately require advancing game ticks.
The final recursive oracle compares every field and value in every reconstructed
copy with the original captured data. It runs outside measured decoding spans.

The control compresses one already assembled JSON document using Factorio's
`encode_string`, then inflates/parses it in one action. It does not benchmark
monolithic source JSON serialization. Two trials per scale alternate whether that
control runs before or after the sectional candidate. Setup, source capture,
inter-instance network transport, real cargo restoration/recovery and player
FPS/UPS are outside this experiment. Repeated copies are not a representative
entropy/topology distribution for all large platforms.

Bounds: four copies, fewer than 100 frames per copy, two trials per size, at most
2,200 RCON calls, a 360-second loop deadline, 30-second command timeout, 100,000-byte
requests and 300,000-character responses. The outer runner has a 450-second watchdog.
The version-pinned API manifest, payload/runner/probe hashes and raw readings remain
in the result. Profiler values never control Factorio scheduling.

Cleanup proof `codecscale-mtuqysr6` passed after an intentional runner exception.
Matrix `codecscale-mtuqz887` **passed all six full and sectional equality checks**,
retained exact JSONL archive round trips, removed owned package state, preserved
the original export cache, and passed the repository's idle-host postflight.
The matrix made 1,600 bounded requests and did not create any platform or job.

Measured milliseconds, ranges across the two trials:

| Data workload | Frames | Factorio full compression | Full inflate + parse | Max source encode per frame | Max destination inflate + parse/reassembly per frame |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1x, 3.09 MB | 56 | 31.35–31.66 | 80.39–86.64 | 11.40–11.80 | 4.81–4.93 |
| 2x, 6.19 MB | 112 | 60.31–64.06 | 104.40–160.75 | 11.44–12.09 | 8.75–17.08 |
| 4x, 12.37 MB | 224 | 120.96–123.35 | 187.73–217.23 | 11.92–12.39 | 9.31–10.90 |

The outer RCON action/reply-construction measurement includes argument decoding,
instrument dispatch and result formatting. Across all trials its maximum was
12.662 ms for source emission and 17.170 ms for destination consumption. Engine
command compilation and socket waits are outside that Lua timer. The 2x spike
remains recorded; fixed byte budgets do not guarantee a fixed time budget. Garbage
collection and host scheduling effects were not isolated.

At 4x, total source frame encoding was 1,737–1,771 ms and destination decoding was
295–299 ms, spread across 224 callbacks each. Node compression await time summed
to 96–97 ms. These are different scopes: moving/spreading work does not make it
disappear, and Node await time includes worker scheduling. The local codec loops
took 17.86–17.91 seconds at 4x, including serial RCON exchanges and enforced tick
separation. That is **not a production transfer duration or network estimate**.

Encoded transport sizes include base64 and the candidate's per-frame metadata:

| Workload | Full Factorio encoding | Independent external encoding | Increase |
| --- | ---: | ---: | ---: |
| 1x | 93,452 bytes | 109,388 bytes | 17.1% |
| 2x | 187,960 bytes | 218,848 bytes | 16.4% |
| 4x | 378,816 bytes | 437,864 bytes | 15.6% |

The previous 23.2% figure was a different offline estimate using Node's compressor
for both layouts. It must not replace these actual prototype wire-byte totals.
More bytes and acknowledgements may increase incoming transfer time.

JSONL frames round-tripped exactly through a single gzip archive and through two
concatenated gzip members in Node, at every size. At 4x the single archive was
276,850 binary bytes. This archive size is not directly comparable to a base64
transport size. These buffers were verified in memory; production archive writes
and append/recovery behavior were not tested.

The Factorio gzip smoke check returned `nil` for a small externally generated gzip
payload. All independently zlib-deflated/base64 frames decoded successfully. The
tested direction is therefore **JSONL or framed JSON for captured data, external
compression, independent deflate/base64 batches for Factorio, and gzip for archives**.
The codec result alone does not establish platform/gateway/client acceptance.
