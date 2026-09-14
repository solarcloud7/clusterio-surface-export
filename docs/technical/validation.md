# What validation checks

Validation decides whether an attempted restoration has acceptable cargo and
structure before transfer ownership changes. The item, entity and fluid panels
describe that destination attempt; recovery is a separate result.

## Cargo and structure

Source export compares captured entity cargo with corresponding live reads. Belt
capture retains its same-callback verification because items can move between
belts. Ground-item capture has its own path; it should not be described as another
independent per-entity cargo comparison.

At the destination, the required check compares physical item totals by item name
and quality, and fluid amounts aggregated by fluid name with a tolerance of
`1e-6`. Restoration failures also matter: failed placements, belt structural
anomalies and unavailable measurements can reject the attempt even when aggregate
item and fluid totals match. Reported losses are not subtracted from expectations
to manufacture a pass.

Fluid amount parity is not proof of preserved thermal energy, temperature
distribution or every fluid-network property. Aggregate item parity does not
independently prove every item's original inventory location, entity setting,
circuit state or belt position. Those need targeted restoration checks and
independent fixture observations.

## Runtime checks and test evidence

The runtime validator is a protection in the transfer path. Tests also inspect
source and destination worlds independently so an error shared by serialization
and validation does not become its own proof of correctness. The fixtures compare
their declared item qualities, belt sides, fluids, tiles and entity state.
Coverage depends on the fixture; having one example of an entity does not prove
every setting or mod combination.

The [gallery fixtures](../developers/fixtures.md) exercise varied platform content.
The [transfer cleanup fixture](../../tests/integration/transfer-cleanup/README.md)
combines physical cargo with ownership checks under an injected failure.
The [belt notebook](../../tests/instruments/belt-boundary/README.md) preserves
the original restoration failures and candidate comparisons.

## Diagnostics are optional extra work

Normal transaction history, required validation and phase measurements do not
depend on debug mode. `belt_trace` adds successful belt-position evidence.
`debug_destination_snapshot`, together with debug mode, adds a full destination
snapshot after successful validation. That extra scan can be expensive and is
disabled in the Docker acceptance fixture. Neither setting replaces the required check.

Relevant implementation: the
[cargo integrity modules](../../docker/seed-data/external_plugins/surface_export/module/core/)
and [import completion](../../docker/seed-data/external_plugins/surface_export/module/core/import-completion.lua).
The current checks reduce specific failure risks; they are not a universal
zero-loss guarantee or proof of exact preservation of all modded state.
