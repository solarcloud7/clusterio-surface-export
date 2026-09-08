# Whole scheduler callback profile

Run from the canonical checkout:

```powershell
node tests/integration/transfer-cleanup/delete-failure.mjs --profile-callbacks
```

The existing temporary transfer fixture installs this wrapper on both instances and
removes it in its cleanup block. It measures the complete scheduler callback only
while that fixture has a queued job. Normal results and exceptions are preserved.
Import/export setup performed by RCON handlers is outside this measurement.

Stopped LuaProfiler readings are rendered through RCON when the wrapper is removed.
The runner retains their raw text and parses milliseconds with the production profiler
parser. It reports a maximum per instance without joining their clocks or adding
overlapping phase measurements. Exact game ticks remain separate fields.

Sampling stops after 64 callbacks per instance. Truncation is explicit. The fixture
contains six entities; its measurements do not establish production performance or
instrumentation overhead. The profiler includes existing nested stage instrumentation.
Use separate runs for restart recovery and profiling because restart removes the wrapper.

`tests/lua/callback-profiler.lua` tests return values, exceptions, the sample cap,
unrelated-work bypass and restoration of the original callback.
