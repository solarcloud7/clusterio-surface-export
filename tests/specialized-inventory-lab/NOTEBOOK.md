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