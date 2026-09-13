# Timing and performance measurements

Timing separates elapsed time, execution within callbacks and simulation progress.
These are different signals, so the interface does not turn ticks into milliseconds
or stretch Lua bars onto a controller clock.

| Signal | Source | Interpretation |
|---|---|---|
| Controller/instance elapsed time | Node monotonic clock within one process observation | Inclusive local handler or request interval, including awaits. |
| Lua phase elapsed time | Continuous job profiler with stopped boundary snapshots | Phase envelope, including time between callbacks. |
| Lua execution elapsed time | Accumulated profiler stopped between batches | Work measured while those callbacks execute. |
| Tick and batch counts | Saved phase transitions and work cursors | Scheduling boundaries and completed work, not wall time. |

Factorio's [LuaProfiler](https://lua-api.factorio.com/2.1.17/classes/LuaProfiler.html)
supports accumulation and rendered output, but Lua cannot read its time as a
number. The plugin emits marked profiler records through log output and parses
them in the instance plugin. Raw readings remain diagnostic evidence; missing or
malformed readings remain unavailable.

## Read a waterfall honestly

Every waterfall has its own clock identity. A process restart starts a new clock;
an unfinished old span does not acquire a fabricated end. UTC timestamps help
human correlation but do not align independent monotonic clocks.

Start, end and elapsed duration are displayed only when the boundaries are known.
Parent and child intervals overlap. A request round trip includes destination
handling and RCON work; subtracting remote processing does not establish pure
network latency. Uncovered intervals are uninstrumented, not assumed idle.

The headline begins at controller observation of the request and ends at the
terminal result, including required cleanup acknowledgement. Audit persistence is
measured separately. For source-initiated and stored-export operations, export can
precede that observation. Phase records stay enabled independently of the optional
batch-detail setting; debug batch records are capped at 2,000 per job while phase
totals continue.

Historical records are retained without inventing exact profiler values or ticks
from rounded legacy fields. The diagnostic details expose that older evidence.

## What a long callback means

A long Lua callback delays simulation progress on that instance. It does not by
itself reveal how many rendered frames a client missed. Client rendering, buffering
and subsequent catch-up are separate observations. The tick recorder computes UPS
from actual tick transitions divided by locally measured seconds; it also keeps
maximum gaps and rolling windows so an average does not conceal a hitch.

An 85 ms phase spread across callbacks and one 85 ms uninterrupted callback have
different effects. No fixed frame-loss calculation follows from an operation's
total duration. See the [recorded client experiment](../../tests/instruments/tick-watch/README.md)
and [codec comparison](../../tests/instruments/tick-watch/import-setup.md) for
fixture sizes, raw evidence, instrumentation limits and historical results.

## Metrics and implementation

[Metrics](../../docker/seed-data/external_plugins/surface_export/lib/metrics.ts)
include operation outcomes, observed durations, entities created on successful
imports and `surface_export_export_ticks`. The tick histogram is not a stall-time
metric. Legacy timestamp duration fallback is distinct from current monotonic
observation; metrics are not an independent physical cargo audit.

The detailed instrumentation and display are in
[timing modules](../../docker/seed-data/external_plugins/surface_export/lib/)
and the [Lua module](../../docker/seed-data/external_plugins/surface_export/module/).
Use [the testing guide](../developers/testing.md) to select an experiment rather
than treating a historical number as a performance target.
