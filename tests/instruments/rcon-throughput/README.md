# RCON input throughput

Manually triggered, supervised comparison of incoming command sizes on the local
Factorio 2.1.17 host-1. Run from the canonical checkout:

```powershell
node tests/instruments/rcon-throughput/run.mjs --supervised-client
node tests/instruments/rcon-throughput/run.mjs --supervised-client --compare-100k-10k
node tests/instruments/rcon-throughput/run.mjs --analyze ci-artifacts/<report>.json
```

Requires the consenting player `solarcloud7` connected on host-1, no connected
players on host-2, and no active transfer jobs, locks, holds, or tick pause. Do not
start transfers while this runs. It does not restart instances or modify settings.
The comparison option runs 100 kB then 10 kB, with a ten-second pause after each
case and a three-second countdown before the next observation window.

## Boundaries

- Three cases, one run each, with the same deterministic 100,000-byte ASCII payload.
  Chunk sizes are 1,000, 10,000 and 100,000 characters. ASCII makes bytes and
  characters equal. Command wrappers add overhead recorded separately.
- Five tiny commands first verify response shape and provide a baseline.
- Uses the installed `rcon-client` from inside host-1 over one persistent localhost
  connection, with one outstanding request. It deliberately bypasses the
  controller and host command queue to isolate the path below the plugin.
- Credentials are discovered inside the container and are never printed or saved.
- Measures request/acknowledgement elapsed time with Node's monotonic clock.
  A stopped Factorio profiler measures string assignment/length only. It excludes
  command parsing/compilation, scheduling, and reply formatting. Neither duration
  is a measurement of wire-only latency. No remote durations are subtracted.
- The Lua response verifies sequence and length, not end-to-end cargo or content
  integrity. No import, decoding, entity creation, or transfer is performed.
- Maximum 116 measured commands, 101 kB per command, 30 seconds per reply, and
  180 seconds before another send is refused. Outer runner stops at 210 seconds.
- Only local Lua variables/profilers and player notices are created. There is no
  persistent fixture or hook to clean up. The connection is closed in `finally`.
  A timeout may leave an already submitted stateless command in flight.
- In-game notices mark each client observation window. Client FPS/UPS requires a
  separate user report; the instrument cannot measure frame loss.

## Observed result: 2026-09-09

Raw artifact: `ci-artifacts/rcon-throughput-mtumb385.json` (local, ignored).
The report retains all acknowledgements, raw profiler strings, exact ticks,
payload/instrument hashes, engine/mod versions, and effective segment settings.

| Chunk payload | Commands | Total elapsed | Longest acknowledgement | Maximum measured Lua execution |
| --- | ---: | ---: | ---: | ---: |
| 1 kB | 100 | 13.333 s | 134.629 ms | 0.006695 ms |
| 10 kB | 10 | 9.317 s | 933.646 ms | 0.004725 ms |
| 100 kB | 1 | 9.285 s | 9284.909 ms | 0.003536 ms |

Tiny-command acknowledgements were 29.38–33.33 ms. Total command bytes including
wrappers were 117,190 / 101,710 / 100,171 respectively. Effective server settings:
minimum segment size 25, maximum 100, peer thresholds 20 and 10.

PASS: all expected responses arrived; player remained connected; before/after
jobs, locks and holds were zero and the simulation was not paused.

This reproduces seconds-long acknowledgements without importing a platform and
without the controller/host command queue. Import restoration therefore is not
required to produce the delay. The result is consistent with Factorio input
streaming limits, but does not isolate streaming from command compilation or
other engine scheduling. No segment-setting intervention was tested.

In this run, 1 kB chunks increased total time. The 10 kB and 100 kB results were
close; one fixed-order run cannot establish a statistically meaningful winner.
No production chunk size was changed. Client FPS/UPS evidence is pending.

The user-requested reverse-order comparison also passed:
`ci-artifacts/rcon-throughput-mtun27w4.json`. The 100 kB case took 9.285 s
(maximum measured Lua execution 0.005603 ms); the 10 kB case took 9.317 s
(maximum 0.007224 ms). No active jobs, locks or holds were present at postflight;
the player remained connected. The user reported "no drop for either of them"
while watching FPS/UPS. This is a qualitative observation, not a recorded
frame-time trace. The RCON delay reproduced without the observed slowdown from
the earlier full transfer; the exact cause of that earlier slowdown remains
unisolated.

Upstream references:

- [Clusterio communication guidance](https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md#communicating-with-factorio)
- [Factorio LuaProfiler](https://lua-api.factorio.com/latest/classes/LuaProfiler.html)
- [Factorio LuaRCON](https://lua-api.factorio.com/latest/classes/LuaRCON.html)
