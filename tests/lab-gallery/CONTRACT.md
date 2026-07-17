# First Baked Lab Contract Card

This card freezes the first paired-gallery vertical slice before implementation.

## Invariants

- The committed source and destination saves load on Factorio 2.0.77 with the exact manifest mod set.
- Both saves are unpaused and contain zero jobs, locks, holds, committed source tombstones, or foreign lab state.
- The source save contains exactly one `specialized-fluid-reachability` fixture revision and the destination save
  contains no conflicting platform identity.
- The fixture is an actual space platform. Its pressure and gravity are zero, and its baked electric mining drill
  has `mining_target == nil`, live fluidbox length zero, and rejected reads/writes at fluidbox index 1.
- The existing belt pilot remains in the same source gallery save until its separate inventory disposition changes.
- Reloading the paired saves is the only normal reset. A fixture is consumed once per loaded batch.

## Intentionally not invariant

- `game.tick`, runtime unit numbers, profiler values, save timestamps, and zip byte order.
- Item order, entity iteration order, or other telemetry excluded from a fixture fingerprint.
- A transfer result: the first migrated reachability lab is an engine observation and intentionally invokes no
  production transfer operation.

## Forbidden assists

- Runtime platform cloning, fixture construction, prefix cleanup, platform deletion, direct plugin-storage
  clearing, or silent game unpause in the migrated runner.
- Treating the baked fixture, manifest, or production analytics as the independent physical oracle.
- Retaining unrelated planet surfaces, generated chunks, entities, or artificial large fixtures without a named
  causal variable.

## Oracle and stop conditions

The oracle is a direct, read-only Factorio census after loading the committed save. Stop as `HARNESS_ERROR` for an
API/shape failure, incomplete save, mod mismatch, or cleanup failure. Stop the design as `STOP` if unrelated world
state cannot be removed, the paired baseline is not reproducible, or the baked drill disagrees with the banked
2.0.77 live conclusion. Do not relax the fingerprint or retain extra world state after observing a stop.

## Budgets and pins

- Engine: Factorio 2.0.77; mods: exact manifest set, recorded in both reload readings.
- Maximum detailed entity reads: 50,000 per save; maximum RCON command: 100,000 bytes.
- Maximum isolated runtime: 90 seconds per load; maximum build attempts before redesign: two.
- Live ladder: one seed census, one source/destination build, one injected-failure reset, and two final paired
  reload batches.
- Artifact SHA-256 values and structural fingerprints are filled into the manifest and evidence only after the
  generated files pass independent reload.

