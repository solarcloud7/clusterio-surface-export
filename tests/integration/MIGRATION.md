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
| entity-roundtrip | `test/quality-dimension-ownership.test.cjs` pins its `test-cases.json` (splitter-quality-filter law); delete after that law lands on a pad |
| ~~spoilage-roundtrip~~ | DELETED 2026-07-20: absorbed by `omnibus-spoilage-midspoil` through `pad-transfer-suite` (2× consecutive green, real transfer, physical dest reads) |
| ~~platform-roundtrip~~ | DELETED 2026-07-20: absorbed by the `transfer-workhorse` transfer-act lifecycle (whole 1359-entity platform through the real transfer, exact dest `surface_entity_count`; 2× consecutive suite green) |
| transfer-fidelity | KEEP until the paired-reads census (SC-6) ships — it is the meter-drift SENTINEL (serialized-expected vs SOURCE physical census), a law no pad fixture carries; the workhorse leg checks dest count + gate verdict only |
| ~~gate-detects-loss, fluid-gate-detects-loss, failed-entity-loss, force-bonus-sync, rollback~~ | DELETED 2026-07-20: absorbed as sabotage pad fixtures (`gate-item-loss`, `gate-fluid-loss`, `failed-entity-attribution`, `force-bonus-held`, `rollback-validation-failure`) run through the REAL transfer by `pad-transfer-suite` — 2× consecutive green, opus di-change review MERGE-READY. Note the measured contract shift: a fired `test_force_entity_failure` hook forces a fail-safe refusal (`failedStage: "test_hook"`) with clean attribution — the legacy test's "validation passes" expectation predates that hardening. |

## Permanent — infrastructure / protocol, not absorbable by pads

engine-invariants, gateway-guard, gateway-transfer, transfer-lock-expiry, version-dispatch,
name-collision-delete, passenger-evacuate, destination-hold, schedule-filter,
plasma-engine-owned, belt-loss-replay, belt-side-restore (Phase 5B instruments), `lib/`.
