# Automated simulation timing

Record local simulation cadence on host-1 and its connected Steam client without
watching the debug overlay. The wrapper runs at the plugin's existing per-tick
entry point. It never replaces Factorio event handlers or changes game speed.

For the subsequent JSON/compression experiments, see
[import setup results and replay instructions](import-setup.md). Their retained
evidence can be checked offline with
`node tests/instruments/tick-watch/codec-scaling.mjs --recorded`.

```powershell
node --test tests/instruments/tick-watch/analyze.test.mjs
node tests/instruments/tick-watch/run.mjs --cleanup-proof
node tests/instruments/tick-watch/run.mjs --idle
node tests/instruments/tick-watch/run.mjs --rcon
node tests/instruments/tick-watch/full-transfer.mjs --cleanup-proof
node tests/instruments/tick-watch/full-transfer.mjs --supervised-client
node tests/instruments/tick-watch/full-transfer.mjs --analyze ci-artifacts/<transfer-report>.json
node tests/instruments/tick-watch/analyze.mjs ci-artifacts/<id>-server.tsv
node tests/instruments/tick-watch/analyze.mjs ci-artifacts/<id>-client.tsv
```

All live modes require the consenting `solarcloud7` client on host-1, an idle
cluster and the canonical checkout. `--idle` waits five seconds. `--rcon` wraps
the existing 100 kB versus 10 kB stateless comparison. `--cleanup-proof` throws
an intentional runner exception after 1.5 seconds, then requires recorder
removal; it does not inject a game failure. The `capture(work)` helper can wrap
other bounded local tests using the same measurement and cleanup path.

## Full transfer baseline

`full-transfer.mjs` reuses the existing large transfer-cleanup fixture: 806 entities,
400 full chests, 402 belts and 16,384 tiles. It requires the consenting client on
host-1 and transfers one temporary platform from host-2 to host-1. The player stays
on their existing surface; the runner verifies that physical surface is unchanged.
It records a five-second idle observation, constructs the fixture, then records
the gateway transfer separately. Construction, independent cargo reads and fixture
deletion are outside the transfer capture. The capture includes command delivery,
terminal-result polling and recorder finish delivery; it is wider than the
controller's measured operation duration. Those durations must not be equated.

The runner verifies exact cargo by entity inventory, quality and belt side,
identical tiles, source absence, and retained transaction details. It removes only
its named fixture and verifies that pre-existing platforms are unchanged. Cleanup
refuses active jobs, locks or holds. It never clears protections to force a pass.
Disconnected clients, unavailable recordings and cleanup failures invalidate
baseline acceptance. Raw clock files, source hashes, engine/mod versions, before
and after physical observations, and transaction details remain in `ci-artifacts`.

Run the full-transfer `--cleanup-proof` first after changing its construction or
cleanup path. It builds the same fixture, arms the recorder and throws an intentional
runner error without starting a transfer. Success means recorder and fixture removal
were verified; the artifact remains `HARNESS_ERROR` with `cleanupProofPassed: true`,
and the workload remains untested. This is distinct from `run.mjs --cleanup-proof`,
which tests the recorder alone.

A successful transfer becomes an observation baseline, not a hard performance
threshold. Compare the same fixture, engine, deployment, client and environment;
retain maximum gaps and slowest rolling windows as well as average UPS. This runner
records destination server/client cadence. Source stage timings remain in the
transaction detail; source tick cadence and rendered client FPS are not recorded.

## What is measured

- Each tick entry snapshots a continuous local LuaProfiler using a stopped
  profiler and `add`. The profiler values are only rendered after recording;
  their values never control game logic or change tick scheduling.
- Actual tick transitions divided by independently measured local elapsed
  seconds give average UPS. Every rolling 60-transition interval gives a
  short-window UPS value. Sixty transitions are not assumed to take one second.
- Maximum and p99 gaps between tick entries retain hitches even when subsequent
  catch-up makes average UPS look healthy. Gap counts above 33 and 50 ms are
  diagnostics, not inferred counts of dropped frames.
- Scheduler execution is profiled separately. A tick-entry gap includes sleep,
  engine scheduling, other work and potentially rendering on a client. It is
  not exclusive CPU time or a measurement of one particular transfer stage.
- Estimated recorder bookkeeping cost is measured separately; the timer's own
  creation/start/stop overhead and later garbage collection are not fully
  included. This is an estimate, not a zero-overhead claim.

The server and client render their own profiler readings into separate files
using `helpers.write_file(..., for_player)`. The collector reads the server file
and `%APPDATA%/Factorio/script-output/surface-export-tests/<id>.tsv`, and copies
both into `ci-artifacts`. Clocks are never aligned or subtracted across processes.
Missing client output stays explicitly unavailable. Rendered FPS is **not**
measured; it requires a graphics/frame-presentation capture tool.

## Capture limits and cleanup

Maximum 7,200 tick samples; reaching the cap restores the original callback and
marks the capture truncated. Truncation, missing/reset ticks, invalid profiler
readings and non-default game speed are rejected by the analyzer. No throughput
claim is made from incomplete records. On reload/crash the transient recorder
disappears; absence of its report is not proof of a clean run.

The explicit finish path restores the original callback and clears the owned
package entry **before** formatting or writing any output. It verifies that no
other tool replaced the callback; it will not overwrite a foreign wrapper.
The recorder cannot coexist with the older callback-profile fixture. File output
occurs after capture so its cost does not contaminate the captured interval.
Raw evidence files are retained. No surface, inventory or save is deleted.

## Initial validation, 2026-09-09, Factorio 2.1.17

- Analyzer tests reproduce a known 200 ms gap and distinguish that gap from
  average UPS. They reject missing boundaries and reset/truncated recordings.
- `tickwatch-mtundlef`: intentional runner error; hook removal verified and both
  server/client files recovered. The overall artifact is deliberately marked
  `HARNESS_ERROR`, not a successful workload measurement.
- `tickwatch-mtunec6v`: idle baseline, 323 samples. Server average 60.003 UPS,
  maximum update gap 16.906 ms. Client local average 54.121 UPS, maximum gap
  34.596 ms. These client timings were captured automatically; they are not
  a reading of the on-screen FPS/UPS overlay.
- Baseline estimated recorder bookkeeping: 5.395 ms total on the server and
  4.445 ms on the client across 323 samples (about 0.017/0.014 ms per callback).
  Single maximum bookkeeping readings were 0.743/0.082 ms respectively.

The slower client baseline predates a transfer; do not attribute it to transfer
work. Use same-environment baseline comparisons and retain maximum gaps.

- `tickwatch-mtunewvd`: automated RCON comparison, 2,896 consecutive samples.
  Server average 60.001 UPS, slowest rolling window 59.857 UPS, maximum gap
  18.953 ms. Client average 54.468 UPS, slowest window 53.641 UPS, maximum gap
  35.174 ms. Neither process had a measured gap over 50 ms. RCON still took
  9.285/9.317 seconds. Client cadence resembled the idle baseline.
- Independent client clock check `tickwatch-mtunizin`: client profiler full
  capture 5,950.093 ms versus 5,953.590 ms between local file timestamps.
  File times include output overhead and are only a sanity check. The earlier
  `mtunhupp` check could not write a bare profiler userdata; wrapping it in a
  LocalisedString fixed the marker output. That failed check remains in its raw
  artifact, explicitly unavailable.

Start/end marker files are now retained alongside the TSV to corroborate the
client clock. They do not replace the monotonic profiler or calibrate its scale.

API references: [LuaProfiler](https://lua-api.factorio.com/latest/classes/LuaProfiler.html),
[player-specific file output](https://lua-api.factorio.com/latest/classes/LuaHelpers.html#write_file).

## Full-transfer observation baseline, 2026-09-09

The tracked [baseline](baseline-2.1.17.json) retains measurements and SHA-256 hashes
of the local raw evidence. Factorio 2.1.17, module 0.10.281; player physically on an
existing platform on host-1. The earlier attempt `transfer-cleanup-tickwatch-mtuoma0w`
stopped before mutation because its preflight unnecessarily required Nauvis.
The runner now preserves the existing observer surface. No cargo, topology or
performance acceptance condition was weakened. The revised full-fixture cleanup
proof passed in `transfer-cleanup-tickwatch-mtuoob04`: intentional runner error,
recorder removed, owned fixture absent on both hosts, existing worlds preserved.

Transfer `902099405:178_transfer-cleanup-tickwatch-mtuop1r6` **passed**: exact physical
cargo and tile parity, source absent, retained transaction detail available, both
fixtures removed, and player physical surface unchanged. Both hosts ended unpaused
with zero jobs, locks and holds. A valid source retirement receipt was retained;
its platform and surface were absent. Controller observed duration was 6,542.842 ms.
The wider recording includes control and terminal polling overhead, so its length
is not the transfer duration.

| Measurement | Idle server | Transfer server | Idle client | Transfer client |
| --- | ---: | ---: | ---: | ---: |
| Recorded samples | 330 | 655 | 330 | 655 |
| Average local UPS | 60.006 | 57.965 | 55.308 | 52.257 |
| Slowest rolling 60-transition UPS | 59.985 | 41.087 | 54.449 | 31.019 |
| Maximum update gap, ms | 16.833 | 190.845 | 35.129 | 339.401 |
| p99 update gap, ms | 16.828 | 37.562 | 34.017 | 51.490 |
| Gaps over 50 ms | 0 | 1 | 0 | 9 |
| Maximum scheduler callback, ms | 0.028 | 34.365 | 0.043 | 51.634 |

The longest gap ends at game tick **52922076** on both peers. Retained destination
telemetry puts import setup on that tick: its inclusive interval was 170.731 ms,
including payload decoding (104.527 ms execution), decompression (16.681 ms), and
platform preparation (47.136 ms). Starter-pack work (45.928 ms) is nested inside
platform preparation and must not be added again. This associates the hitch with
setup; it does not assign an exclusive cause or a server-derived duration to the
client. The preceding scheduler callback was only 0.012 ms on the server, showing
why scheduler-only measurements would miss this larger interval.

Source telemetry separately recorded a one-batch belt capture of 243.528 ms.
No source-client impact was measured in this incoming-transfer test. The destination
recorder's estimated bookkeeping totaled 10.756 ms on the server and 8.408 ms on the
client over 655 callbacks; neither is a complete instrumentation-overhead estimate.

Idle evidence: `tickwatch-mtuop4xw`; transfer evidence: `tickwatch-mtuopevy`.
Full report: `ci-artifacts/transfer-cleanup-tickwatch-mtuop1r6.json`.
These are a reproducible workload and a single observation baseline, not a frame
budget guarantee, universal cargo proof, or evidence that optimization is exhausted.
