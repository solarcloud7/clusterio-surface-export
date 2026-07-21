# Integration-suite migration table (one-test-save consolidation, 2026-07-19)

Every deleted test's law now lives as a **pad fixture on the live gallery save**, reconciled and
run by `/test-run` against the pushed roster (`tests/lab-gallery/push-roster.mjs`). Deletion
evidence: the full pad run was 16 passed / 0 failed / 0 missing on roster `c0ab723d28f2` with CI
green on `73dcf43`. A pad fixture cannot rot silently — a missing pad is a RED `MISSING` verdict,
never a vacuous pass.

## Wave 1 — deleted (law absorbed by a pad fingerprint)

| Deleted test | Absorbing pad fixture | Notes |
|---|---|---|
| active-state-roundtrip | omnibus-midcraft-progress + no-tick-sync-frozen-pair | frozen/active state rides the paste fingerprint |
| belt-corner-recovery | belt-combined-omnibus | owner ruling: corner over-pack is covered by the omnibus circuit; standalone platform retired |
| bonus-progress-roundtrip | omnibus-module-bonus-progress | |
| circuit-config-roundtrip | omnibus-circuit-config | |
| circuit-latch-state | omnibus-decider-latch | output register is an engine limit — `pasteExclude:["signalS"]` (measured 2026-07-19) |
| energy-roundtrip | (retired) | owner ruling: too simple; energy behavior exercised by every powered pad |
| entity-burner-roundtrip | omnibus-burner-fuel | |
| equipment-burner-roundtrip | omnibus-equipment-grid | |
| ground-item-fidelity | omnibus-ground-items | |
| heat-roundtrip | omnibus-heat-temperature | |
| item-grid-roundtrip | omnibus-equipment-grid | |
| midcraft-roundtrip | omnibus-midcraft-progress | |
| specialized-inventory-roundtrip | omnibus-adversarial-inventory | |

## Wave 2 — gated deletions (do NOT delete yet)

| Test | Gate |
|---|---|
| ~~entity-roundtrip~~ | DELETED 2026-07-20: the splitter-quality-filter law is baked on `omnibus-adversarial-inventory` (legendary iron-plate splitter filter, fingerprint-pinned, paste-verified live); `quality-dimension-ownership.test.cjs` now guards the manifest pin |
| ~~spoilage-roundtrip~~ | DELETED 2026-07-20: absorbed by `omnibus-spoilage-midspoil` through `pad-transfer-suite` (2× consecutive green, real transfer, physical dest reads) |
| ~~platform-roundtrip~~ | DELETED 2026-07-20: absorbed by the `transfer-workhorse` transfer-act lifecycle (whole 1359-entity platform through the real transfer, exact dest `surface_entity_count`; 2× consecutive suite green) |
| ~~transfer-fidelity~~ | DELETED 2026-07-20 (SC-6 Phase 4): absorbed by the PRODUCTION paired-reads source census, which does the same serialized-expected vs SOURCE-physical comparison per-entity, fail-closed, on EVERY real transfer. Witnessed live by two pad fixtures through `pad-transfer-suite`: `census-omission-abort` (census fires + refuses an omission) and the `transfer-workhorse` `census_pass` check (census RAN + PASSED clean on the 1359-entity transfer, banked `census_pass_*.json`, ok=true / 0 mismatches). Stronger where it counts — handler/serializer omission, EVERY transfer, fail-closed, entity-attributed — but note it trades the deleted sentinel's engine-native `get_item_count` oracle for a scanner-shared one (`InventoryScanner.extract_all_inventories`, the same primitive the serializer uses), so a regression INSIDE that shared enumerator nets to zero and is not caught by the census; the `engine-invariants` get_item_count-completeness fact stands as the independent backstop for that enumerator. |
| ~~gate-detects-loss, fluid-gate-detects-loss, failed-entity-loss, force-bonus-sync, rollback~~ | DELETED 2026-07-20: absorbed as sabotage pad fixtures (`gate-item-loss`, `gate-fluid-loss`, `failed-entity-attribution`, `force-bonus-held`, `rollback-validation-failure`) run through the REAL transfer by `pad-transfer-suite` — 2× consecutive green, opus di-change review MERGE-READY. Note the measured contract shift: a fired `test_force_entity_failure` hook forces a fail-safe refusal (`failedStage: "test_hook"`) with clean attribution — the legacy test's "validation passes" expectation predates that hardening. |

## Permanent — infrastructure / protocol, not absorbable by pads

engine-invariants, gateway-guard, gateway-transfer, transfer-lock-expiry, version-dispatch,
name-collision-delete, passenger-evacuate, destination-hold, schedule-filter,
belt-loss-replay, belt-side-restore (Phase 5B instruments), `lib/`.

## Wave 3 — retired with its subject (2.1 fluid-segment registry, 2026-07-21)

| Deleted test | Why | Coverage now |
|---|---|---|
| plasma-engine-owned | Its entire premise — the `engine_owned` connection-category exclusion — was DELETED from production by owner ruling 2026-07-20/21 (plasma rides transfers like any fluid; the only lawful fluid subtraction is physically-measured `write_rejected`). The test asserted behavior that no longer exists and cannot be made to pass against the registry build. | The INVERSE law is what production now guarantees, and it is covered live on 2.1.11: the `fluid-segment-law` selftest (plasma capacity-clamp + segmentless generator boxes + whole-segment writes), the `fusion-loop` pad (ACTIVE fusion rig: plasma + buffered coolant ride copy/paste with nothing engine-excluded), and the strict fluid gate exercised by `pad-transfer-suite`. |
