# equipment-burner-roundtrip — fixture notes (PLATFORM-FIXTURE-UNCERTAIN)

Tests the never-tested equipment-grid serializer path: `inventory-scanner.lua`
`extract_equipment_grid()` (equipment name/position/energy/shield + `burner.currently_burning`,
`burner.remaining_burning_fuel`, burner fuel/result inventories) and `deserializer.lua`
`restore_equipment_grid()`.

## Fixture uncertainty at Factorio 2.0.77 (Space Age)

Two facts could not be validated offline (no cluster access at authoring time), so the test probes
them **at runtime** and degrades explicitly instead of guessing:

1. **No known platform-placeable entity with an equipment grid.** Vanilla gridded entities are
   vehicles (car, tank, spidertron, locomotive…), and space platforms normally refuse vehicle
   placement via surface conditions. Script `create_entity` may bypass the build-time surface
   check — unverified. The test tries `spidertron` → `tank` → `car` in order; if none place, it
   falls back to a **steel chest containing a power-armor item** whose *item-stack* grid
   (`stack.grid`) exercises the same `extract_equipment_grid`/`restore_equipment_grid` pair via the
   item path (`inventory-scanner.lua` line ~97, `deserializer.lua` line ~51). The result records
   `fixture_kind` (`spidertron`/`tank`/`car`/`power-armor-stack`) so the closer can see which path
   actually ran.

2. **No known vanilla BURNER equipment.** Base + Space Age 2.0.77 equipment (solar panel, batteries,
   shields, exoskeleton, roboport, belt immunity, nightvision, fusion/fission reactors) is not
   burner-powered to our knowledge — `equipment.burner` support in the scanner appears to target
   modded content. The test **probes every `prototypes.equipment` entry at runtime** (grid.put →
   check `.burner` → take back if not) and:
   - if a burner equipment exists: sets it mid-burn (`currently_burning` + partial
     `remaining_burning_fuel` + fuel inventory) and asserts the full burner state round-trips;
   - if none exists: records `burner_equipment_available=false`, marks the burner assertions
     **skipped** (visible in the summary), and still asserts the grid + battery-energy round-trip.

Flag for the report: **PLATFORM-FIXTURE-UNCERTAIN** — both probes above may change the effective
coverage of this test depending on what the live prototype set actually allows. If the burner
branch is skipped on vanilla, real burner coverage requires seeding a mod that ships burner
equipment (closer/owner decision).

## What is always asserted (physical destination reads)

- the grid-holding fixture arrives (entity at position, or chest + power-armor item)
- the equipment name list matches the source exactly (sorted multiset compare)
- battery-equipment energy survives within 1% of max (nothing on the fixture charges or drains it)
- transfer gate passed; zero leftovers on both hosts after cleanup

UNVALIDATED: authored offline; never executed against the live cluster.
