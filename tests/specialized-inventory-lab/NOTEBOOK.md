# Specialized Inventory Lab Notebook

Append-only evidence for the specialized-handler inventory accounting prerequisite.

## 2026-07-12 - Pre-fix evidence and ownership classification

Prediction: every ordinary inventory returned by the canonical scanner must appear once in the serialized payload and exact-gate universe, regardless of specialized handler dispatch.

Historical live RED (banked on `feat/state-dimensions`, transfer `burnerrt-163355`, debug result `debug_import_result_burnerrt-163355_196255.json`):

- source burner-inserter fuel inventory: `coal=10`;
- source expected map: coal absent, `space-platform-foundation=10` only;
- destination burner-inserter fuel inventory: `coal=0`;
- destination actual map: coal absent, `space-platform-foundation=10` only;
- validation succeeded and the source was deleted.

Static RED on main, committed before implementation: `specialized-inventory-accounting.test.cjs` passed the complete 30-category ownership matrix and both canonical-scanner ownership checks, then failed because `attach_missing_inventories` did not exist.

Ownership result:

- 30 specialized categories are classified.
- 13 handlers own inventory extraction and all 13 call `InventoryScanner.extract_all_inventories(entity)`.
- 6 handlers own fluid extraction and all 6 call `InventoryScanner.extract_fluids(entity)`.
- No platform-reachable specialized category with fluidboxes was found outside those 6 handlers, so the conditional shared-fluid repair is not authorized.
- All remaining specialized categories receive ordinary inventory discovery from the shared dispatcher.

## 2026-07-12 - Specialized inventory focused evidence

Prediction: the shared dispatcher keeps legendary burner fuel in the serialized universe exactly once, and the exact gate preserves the source when one unit is removed.

### Success section

- Canonical transfer ID: `2119131471:001_specinv-success-192124`.
- Source artifact: `debug_source_platform_specinv-success-192124_449072.json`.
- Destination frozen artifact: `debug_destination_platform_specinv-success-192124_388314.json`.
- Import result: `debug_import_result_specinv-success-192124_388314.json`.
- Physical source, serialized entity payload, export verification, frozen destination, validation expected, validation actual, and live destination each reported `coal:legendary=20`.
- Validation succeeded; the source deleted only after success.
- Result: 10/10 checks passed, including both-host zero leftover state.

### Forced-loss section

- Canonical transfer ID: `2119131471:002_specinv-loss-192150`.
- Source artifact: `debug_source_platform_specinv-loss-192150_450559.json`.
- Destination frozen artifact: `debug_destination_platform_specinv-loss-192150_389803.json`.
- Import result: `debug_import_result_specinv-loss-192150_389803.json`.
- Black box: `failure_black_box_specinv-loss-192150_389803.json`.
- The one-shot hook directly logged removal of one legendary coal.
- The gate reported `coal:legendary 20 -> 19`, `validation_success=false`, and `failedStage=items`.
- The source remained and the failed destination was discarded.
- Result: 11/11 checks passed, including both-host zero leftover state.


## 2026-07-12 - Final full-suite evidence

Two consecutive complete suites ran without code, configuration, or cluster reset between them:

- Pass 1: `22/22 passed`; `specialized-inventory-roundtrip` passed in `18.4s`.
- Pass 2: `22/22 passed`; `specialized-inventory-roundtrip` passed in `17.4s`.
- Full outputs: `C:\tmp\specinv-full-pass1.txt` and `C:\tmp\specinv-full-pass2.txt`.
- The permanent runner executed both success and forced-loss sections in each suite.

The first post-suite census found two disposable surfaces left by existing suite runners: `entity-test-20260712_193648` on host 1 and `integration-test-20260712_194117` on host 2. They were deleted by exact name and cleanup was stepped before the final census.

Final state:

- Host 1 platforms: protected fixture `test` only; holds=0, locks=0, async_jobs=0, committed tombstones=0, game unpaused.
- Host 2 platforms: protected fixture `spikedoom08` only; holds=0, locks=0, async_jobs=0, committed tombstones=0, game unpaused.
## 2026-07-12 - Audit correction: independent fluid capability evidence

The original fluid matrix was vacuous: `fluidCapableOnPlatforms` copied `handlerFluidOwners`, so it encoded the ownership answer as the capability question. The corrected matrix is independent of handler ownership.

Tick-stamped live query on Factorio 2.0.77 (`game.tick=322800`, host 1 protected `test` platform, surface `platform-1`):

- platform properties: `pressure=0`, `gravity=0`;
- `flamethrower-turret`: one fluidbox, `surface_conditions pressure>=10`, therefore not platform-reachable;
- `electric-mining-drill`: one fluidbox, no surface conditions, and `surface.can_place_entity=true` on platform foundation;
- `fluid-wagon`: gravity condition requires `gravity>=1`, therefore not platform-reachable;
- `chemical-plant`, `storage-tank`, and `pump` were each independently observed with fluidboxes and `surface.can_place_entity=true`.

Result: the prior "verified-clean" fluid conclusion is retracted. `mining-drill` was a real platform-reachable specialized-handler omission, so the symmetric keep-if-non-nil shared fluid attachment is required. The static tooth first failed with exactly `uncovered = ["mining-drill"]` before the repair.
