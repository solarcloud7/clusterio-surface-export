# Parity Verification Model — How Transfer Fidelity Is Measured

How the plugin verifies that a transferred platform arrives with 100% of its restorable items and
fluids, which instruments that claim rests on, and — equally important — where the guarantee's
boundary sits. Read this before trusting, extending, or auditing any fidelity claim.

## The two meters

Every fidelity check in this project compares readings from two **independent instruments with
disjoint failure modes**:

| Meter | What it does | Where it lives | Natural failure mode |
|---|---|---|---|
| **Serializer walk** | Structured extraction: dispatches every entity to a per-category handler that decides which state to capture (inventories, fluids, belt lines, held items, settings) | [entity-handlers.lua](../docker/seed-data/external_plugins/surface_export/module/export_scanners/entity-handlers.lua), [inventory-scanner.lua](../docker/seed-data/external_plugins/surface_export/module/export_scanners/inventory-scanner.lua) | **Omission** — a handler forgets that a container of state exists |
| **Physical census** | Flat engine count: `surface.find_entities_filtered({})` enumerates every entity that exists; `entity.get_item_count(name)` returns the engine's total for that item anywhere inside the entity | [surface-counter.lua](../docker/seed-data/external_plugins/surface_export/module/validators/surface-counter.lua) (`count_items`, `count_fluids`) | Engine-level miscount only — the loop contains no per-category logic, so it cannot forget a container |

The census's independence is structural: the per-category handler taxonomy (the code that can
forget things) never appears in the census loop. A serializer omission therefore shows up as a
numeric disagreement between the two meters — it cannot hide.

Comparing the serializer against itself would prove nothing (extraction is deterministic; the same
walk returns the same answer twice). All checks below are serializer-vs-census or
census-vs-census comparisons across the transfer boundary, never ledger-vs-same-ledger.

## Verified engine facts the census relies on

Evidence tags and measurement details are in
[factorio-2.0-api-notes.md](factorio-2.0-api-notes.md) (see "Item counting").

- `LuaEntity.get_item_count(item)` is a per-entity total that **includes belt-line and held-stack
  items**; on a belt it equals that belt's own transport-line sum, so summing over every belt does
  not double-count a shared run.
- Ground items are entities (`item-entity`) and are counted by the same enumeration
  (`count_items` has a dedicated ground-item pass).
- Counting must happen in a **frozen world** (entities deactivated, no elapsed tick between
  restoration and count), or machines craft in the gap and produce false deltas. The import
  pipeline's phase ordering exists to guarantee this (see "Import Phase Ordering" in
  [CLAUDE.md](../CLAUDE.md)).
- Reconciled conventions, applied on **both** sides of every comparison: fusion-reactor **output**
  fluidboxes reject writes (rejected amounts are subtracted from expected — see
  [fluid_restoration.lua](../docker/seed-data/external_plugins/surface_export/module/import_phases/fluid_restoration.lua)),
  and engine-owned-category fluids are excluded
  (`count_fluids(..., exclude_engine_owned)`).

## Where each comparison runs today

| Check | Compares | Runs | Anchor |
|---|---|---|---|
| **Exact transfer gate** | serialized-expected vs **destination** physical census (items exact per key; fluids exact aggregate-by-name, epsilon 1e-6) | production, every transfer, before source deletion | [transfer-validation.lua](../docker/seed-data/external_plugins/surface_export/module/validators/transfer-validation.lua) |
| **Meter-drift sentinel** | serialized-expected (`expectedItemCounts`) vs **source** physical census | integration test only | [transfer-fidelity](../tests/integration/transfer-fidelity/run-tests.ps1) |
| **Loss-injection teeth** | gate behavior under a forced physical shortfall (must fail closed, preserve source) | integration tests | [gate-detects-loss](../tests/integration/gate-detects-loss/run-tests.ps1), [fluid-gate-detects-loss](../tests/integration/fluid-gate-detects-loss/run-tests.ps1) |
| **Fidelity fixtures** | source physical census vs destination physical census for a placed, known quantity | integration tests | [ground-item-fidelity](../tests/integration/ground-item-fidelity/run-tests.ps1), [belt-loss-replay](../tests/integration/belt-loss-replay/run-tests.ps1) |

The production export path performs **no source-side physical census**: the gate's expected counts
derive from the serializer's own output (verification is generated from serialized data — see
Pitfall #16, atomic belt scan, in [CLAUDE.md](../CLAUDE.md)). The meter-drift sentinel covers that
axis in CI only.

## Freeze policy by entity family

Measurement and serialization are only meaningful against a non-moving target. Different entity
families require different freeze mechanisms, and several intuitive ones are measured
non-starters. Current policy, per family:

| Family | Mechanism during export/import | Anchor |
|---|---|---|
| Machines, inserters, turrets, most activatables | `entity.active = false` at lock time; original states recorded and restored on unlock/activation ([surface-lock.lua](../docker/seed-data/external_plugins/surface_export/module/utils/surface-lock.lua) `freeze`, [active_state_restoration.lua](../docker/seed-data/external_plugins/surface_export/module/import_phases/active_state_restoration.lua)) | code |
| Belts (transport-belt, underground, splitter) | **cannot be deactivated — items keep moving on locked platforms** (measured); read in one atomic Lua execution instead ([async-processor.lua](../docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua) atomic belt scan; Pitfall #16, atomic belt scan, in [CLAUDE.md](../CLAUDE.md)) | measured |
| Cargo pods in flight | not frozen — **completed** by the lock before export scanning ("completes cargo pods", [export-pipeline.lua](../docker/seed-data/external_plugins/surface_export/module/core/export-pipeline.lua)); a mover is retired, not paused | code |
| Ground items (`item-entity`) | static entities; no freeze needed | code |
| Beacons (import side) | deliberately kept **active** through restoration so `crafting_speed` propagates to crafters before inventory refill (see "Import Phase Ordering" in [CLAUDE.md](../CLAUDE.md)) | code |
| Inserter held items (import side) | per-inserter brief active-toggle inside one synchronous pass — no tick elapses, so no swing occurs (Pitfall #28, the gate must count a complete state, in [CLAUDE.md](../CLAUDE.md)) | measured |
| Whole platform (`platform.paused`) | parks held destinations; does **not** stop belt drift on the held surface (the observation behind Black-Box Discard's snapshot-then-delete design) | measured |
| Whole game (`game.tick_paused`) | labs and tests only; also halts the plugin's own async processing (`/step-tick` exists to step past it) | code |

The strongest freeze is not a pause mechanism at all: **within a single Lua execution, zero ticks
elapse and nothing in the simulation moves** (measured — see the no-tick-sync results referenced
from Pitfall #15, entity activation before validation, in [CLAUDE.md](../CLAUDE.md)). Reads that
must be mutually consistent are placed in the same execution; freezing across ticks is required
only when work cannot fit in one execution, and then only the families above that support it.

## The guarantee boundary — read this before claiming "100%"

The gate's guarantee is precisely: **what was serialized equals what was restored.** It is *not*,
by itself, "what was on the source platform equals what is on the destination." The difference is
exactly the serializer-omission case: state the serializer never captured is absent from *both*
sides of the gate's comparison, so the gate passes while the state is lost with the deleted
source. The gate is an honest accountant working from a possibly-incomplete ledger.

Fidelity claims therefore live in two tiers with different protection mechanisms:

| Tier | State | Protection | Unknown-unknown exposure |
|---|---|---|---|
| **1 — countable** | items and fluids (conserved quantities the engine can total) | measurement: physical census on the destination (production gate) and on the source (test sentinel) | a serializer omission is *detectable by measurement* wherever a census runs |
| **2 — non-countable** | circuit configuration, crafting progress, schedules, spoilage timers, health, energy, heat, … | enumeration: per-category handlers, per-dimension roundtrip fixtures, and static ownership/classification tests | no aggregate meter exists; an unenumerated dimension is silently absent and **no census can detect it** |

Consequences of the boundary:

- For tier 1, a census comparison converts any omission bug from *silent loss* into a *loud
  numeric mismatch* — but only on the side where a census actually runs. On the destination it
  runs in production; on the source it runs only in the CI sentinel.
- For tier 2, coverage is exactly the list of dimensions someone has enumerated and tested.
  "100% parity" statements should be scoped to tier 1 plus the enumerated tier-2 dimensions, never
  stated unqualified.
- Both tiers ultimately trust the engine's own meters. That trust is not axiomatic: the
  load-bearing engine facts above were measured in lab rungs before the gate was allowed to rely
  on them, and the labs re-run on every engine pin bump (`lint:version-certification`).
