# Preparation timing breakdown

## Measurement contract

Measure calls inside source `preparation` and destination `platform_preparation` on
Factorio 2.1.17 using the existing operation-timing LuaProfiler instrumentation.
These are nested local elapsed measurements, not exclusive CPU time. Do not add
parent and child durations or convert ticks to milliseconds.

Preserve call order, arguments, results, exception handling, transfer gates and
physical item/quality, belt-side and fluid parity. Do not add yields, change batch
sizes, suppress validation, or move work for this measurement. Timing and tick
values are observations, not fidelity invariants. No new Factorio API calls are
introduced; profiler access uses the already exercised operation-timing module.

Use the existing `transfer-cleanup/delete-failure.mjs --profile-callbacks` fixture
on idle local instances. Its independent physical oracle, version check, RCON
bounds, preflight refusal and owned cleanup remain authoritative. Completed
deletion receipts accepted by `assertLeaseClean` remain untouched.

At most two invocations (four transfers, each bounded by the fixture's existing
90-second/60-poll limit). Stop on cargo mismatch, missing expected measurements,
runtime exceptions, truncation, or incomplete cleanup. Preserve failed evidence;
do not loosen the contract to obtain a pass.

Record implementation hashes with fixture artifacts. Compare downloaded raw
profiler records and rendered browser values. Analyze saved records offline after
cleanup. The fixture measures six entities and 425 tiles; it cannot establish a
large-platform limit or causal speedup. Additional instrumentation has overhead.

## Boundaries

Source children: schedule capture, entity collection, placement sorting, tile scan,
and export-job construction. Destination children: unique-name selection, target
resolution, platform creation, starter pack application/cargo clearing, starter
entity cleanup, parking, schedule restoration and cargo-total calculation.
Parent envelopes retain their existing boundaries and meaning. Diagnostics between
child spans remain in the parent; they are not classified as idle time.

## Observed results — 2026-09-09

Two invocations completed on Factorio 2.1.17, module 0.10.281, with the instrumented
source hashes retained in `ci-artifacts/transfer-cleanup-mttlrgxz.json` and
`ci-artifacts/transfer-cleanup-mttltx4m.json`. Each invocation ran a baseline transfer
and a source-deletion fault followed by real recovery. All four preserved physical
cargo, belt sides and fluids; both invocations verified owned fixture cleanup.

| Operation suffix | Source preparation | Tile scan (child) | Destination preparation | Starter pack (child) |
|---|---:|---:|---:|---:|
| `215_transfer-cleanup-mttlrgxz-baseline` | 96.63 ms | 95.47 ms | 41.92 ms | 41.40 ms |
| `216_transfer-cleanup-mttlrgxz-fault` | 91.29 ms | 90.86 ms | 38.44 ms | 38.03 ms |
| `217_transfer-cleanup-mttltx4m-baseline` | 89.95 ms | 89.14 ms | 37.68 ms | 37.19 ms |
| `218_transfer-cleanup-mttltx4m-fault` | 118.33 ms | 117.84 ms | 35.26 ms | 34.86 ms |

These are rounded execution readings, with one batch and identical start/end ticks
for every listed stage. Parent and child columns overlap. Tile scan consistently
accounts for most source preparation here; starter application and hub-cargo clearing
account for most destination preparation. The latter remain one measured child, so
this does not attribute all its time to either individual engine call.

Browser assertions checked 353 displayed timing rows and reparsed 233 Lua timing
records, including skipped stages, across the four downloaded reports. The existing
offline work-budget analyzer verified 201 measured execution readings with zero
unavailable readings. All 13 required child spans were present
once per operation, completed, and linked to the correct parent. The two
`*-baseline-preparation-browser.json` artifacts retain the assertion results;
per-operation `*-browser-report.json` files retain raw readings and exact numbers.
No browser runtime errors were observed.

The queue regression verifies engine call order, parent links and handled failure
cleanup. All 51 lifecycle smoke tests and the export/import phase-yield regressions
passed. The deployed change adds measurements only. No latency reduction, large-world
limit, or continuous observation of all intervening engine updates is claimed.

Next experiment: compare the exact exported tile set from the current full query and
Lua exclusion pass against a narrower engine query. Preserve positions and tile names,
not just the tile count, before selecting an optimization. Starter-pack work needs a
separate call-level comparison; adding a tick before it cannot shorten that call.
