# Refactor Plan: Deduplication & Decoupling

## Goal
Remove duplicate code, decouple tightly-bound modules, and break apart oversized functions — without changing any runtime behavior.

---

## Phase 1: Extract Shared Constants & Helpers (Low Risk)

### 1a. Unify `ACTIVATABLE_ENTITY_TYPES`
**Problem:** Same 21-entry table defined twice, linked only by a comment saying "MUST match".
- `module/utils/surface-lock.lua:8-44` → `FREEZABLE_ENTITY_TYPES`
- `module/import_phases/active_state_restoration.lua:11-45` → `ACTIVATABLE_ENTITY_TYPES`

**Fix:** Define once in `game-utils.lua`, import in both files.

### 1b. Unify `make_stable_id`
**Problem:** Identical function in two files, linked only by a comment saying "MUST match".
- `module/export_scanners/entity-scanner.lua:211-220`
- `module/utils/surface-lock.lua:50-59`

**Fix:** Move to `game-utils.lua`, import in both files.

### 1c. Add `BELT_ENTITY_TYPES` constant
**Problem:** Belt type check repeated 4+ times with inconsistent approaches (`string.find` with pattern escaping vs direct `==` comparison).
- `verification.lua:179` (uses `find` with `%-`)
- `transfer-validation.lua:160` (uses `find` with `%-`)
- `async-processor.lua:714-718` (uses table lookup)
- `async-processor.lua:1251-1252` (uses `==`)

**Fix:** Add to `game-utils.lua`:
```lua
GameUtils.BELT_ENTITY_TYPES = {
  ["transport-belt"] = true,
  ["underground-belt"] = true,
  ["splitter"] = true,
}
```

### 1d. Add `safe_get` helper
**Problem:** `pcall(function() return entity.prop end)` pattern used 30+ times in `entity-handlers.lua` and `deserializer.lua`.

**Fix:** Add to `game-utils.lua`:
```lua
function GameUtils.safe_get(obj, property)
  local ok, val = pcall(function() return obj[property] end)
  if ok then return val end
  return nil
end
```

### 1e. Extract color helper
**Problem:** Same 6-line color extraction block copy-pasted 5 times in `entity-handlers.lua` (car, spider-vehicle, lamp, train-stop, train).

**Fix:** Add to `game-utils.lua`:
```lua
function GameUtils.extract_color(entity)
  local ok, color = pcall(function() return entity.color end)
  if ok and color then
    return { r = color.r or 0, g = color.g or 0, b = color.b or 0, a = color.a or 1 }
  end
  return nil
end
```

---

## Phase 2: Unify Surface Counting Logic (High Impact)

### 2a. Create `module/validators/surface-counter.lua`
**Problem:** Three independent implementations of "count all items on a live surface" and two of "count all fluids on a live surface":

**Item counting (triplicated):**
- `verification.lua:159-217` → `count_surface_items`
- `transfer-validation.lua:136-196` → inline in `validate_import`
- `async-processor.lua:1221-1325` → inline in `complete_import_job`

**Fluid counting (duplicated + stale):**
- `transfer-validation.lua:17-80` → `count_surface_fluids` (segment-aware, correct)
- `async-processor.lua:1219-1313` → inline (segment-aware, correct)
- `verification.lua:222-245` → `count_surface_fluids` (old, non-segment-aware, stale)

**Fix:** Create `SurfaceCounter` module with:
```lua
SurfaceCounter.count_items(surface) → item_counts, total
SurfaceCounter.count_fluids(surface) → fluid_counts, total
SurfaceCounter.count_all(surface) → { item_counts, fluid_counts, totals }
```

All three callers switch to `SurfaceCounter`. Delete the stale `Verification.count_surface_fluids`. Mark `Verification.count_surface_items` as a thin wrapper around `SurfaceCounter.count_items` or delete it.

### 2b. Use existing `TableUtils.sum_values` where available
**Problem:** Manual `for _, count in pairs(table) do total = total + count end` loops instead of using `Util.sum_values` which already exists.
- `async-processor.lua:620-628`
- `transfer-validation.lua:366-382`

**Fix:** Replace with `Util.sum_values(verification.item_counts)`.

---

## Phase 3: Extract Loss Analysis from `async-processor.lua` (High Impact)

### 3a. Create `module/validators/loss-analysis.lua`
**Problem:** `complete_import_job` is ~530 lines. Lines 1183-1481 (~300 lines) are a self-contained post-activation loss analysis pass that duplicates logic from `transfer-validation.lua`.

**Fix:** Extract into `LossAnalysis` module:
```lua
LossAnalysis.run(job, validation_result)
  → updated validation_result with:
     .totalActualItems, .actualItemCounts
     .totalActualFluids, .actualFluidCounts
     .fluidReconciliation, .postActivation
```

This module uses `SurfaceCounter` (from Phase 2) instead of inline counting, and contains the high-temp fluid reconciliation logic (currently duplicated in `transfer-validation.lua:263-330` and `async-processor.lua:1358-1443`).

### 3b. Extract high-temp fluid reconciliation helper
**Problem:** ~80 lines of high-temp aggregation + comparison logic duplicated between `transfer-validation.lua` and `async-processor.lua`.

**Fix:** Add to `loss-analysis.lua` or `surface-counter.lua`:
```lua
FluidReconciliation.reconcile(expected_counts, actual_counts, high_temp_threshold)
  → { reconciledLoss, lowTempLoss, highTempReconciledLoss, highTempAggregates }
```

Both `transfer-validation.lua` and the new `loss-analysis.lua` call this shared function.

---

## Phase 4: Slim Down `async-processor.lua` (Medium Impact)

After Phases 2-3, `complete_import_job` shrinks from ~530 to ~200 lines (orchestration + IPC only).

### 4a. Extract `complete_export_job` helpers
**Problem:** `complete_export_job` is ~215 lines with 8 distinct concerns inline.

**Fix:** Extract the pending file write handler (~30 lines) into a local helper. The rest is reasonable orchestration that doesn't need further extraction.

### 4b. Fix `skip_belt_items` coupling
**Problem:** `async-processor.lua` toggles `EntityHandlers.skip_belt_items` global flag (lines 711, 737). If an error occurs mid-batch, the flag stays `true` and all future exports silently produce empty belt data.

**Fix:** Wrap in pcall or use a pattern like:
```lua
local function with_skip_belt_items(fn)
  EntityHandlers.skip_belt_items = true
  local ok, err = pcall(fn)
  EntityHandlers.skip_belt_items = false
  if not ok then error(err) end
end
```

---

## Phase 5: Clean Up Deserializer (Medium Impact)

### 5a. Extract item property restoration helper
**Problem:** The 35-line block that restores item properties (health, durability, ammo, spoil_percent, label, custom_description, grid, nested_inventory) after `set_stack` is duplicated between:
- `deserializer.lua:655-770` → `restore_inventories`
- `deserializer.lua:884-974` → `restore_nested_inventory`

**Fix:** Extract into local function `restore_item_properties(stack, item_data)`.

### 5b. Mark synchronous `import_platform` as legacy
**Problem:** `Deserializer.import_platform` (lines 26-182) is a synchronous import path that skips tile placement, belt restoration, and active state deferral. The async pipeline in `async-processor.lua` + `import_phases/` is the correct path. Both exist without documentation.

**Fix:** Add a clear comment marking `import_platform` as legacy/debug-only. Consider whether it can be removed entirely (check if any code path still calls it).

### 5c. Mark old `Deserializer.restore_fluids` as superseded
**Problem:** `deserializer.lua:977-1066` contains the old per-entity fluid restoration. The async path uses `FluidRestoration.restore()` instead. Both exist.

**Fix:** Add deprecation comment, or delete if only called from the legacy sync path.

---

## Phase 6: Minor Cleanup (Low Impact)

### 6a. Consolidate `entity_state_restoration.lua` loops
**Problem:** `restore_all` has 5 consecutive loops over the same `entities_to_create` list with identical `entity_map` + `entity.valid` guards (lines 14-57).

**Fix:** Consider a single-pass approach or at minimum extract the guard pattern. Low priority — the current structure is correct and the separation has documentation value.

### 6b. Use `Util.sum_values` consistently
Replace manual summation loops identified in Phase 2b.

---

## Dependency Graph (After Refactor)

```
game-utils.lua (constants: ACTIVATABLE_ENTITY_TYPES, BELT_ENTITY_TYPES, make_stable_id, safe_get, extract_color)
  ↑
  ├── surface-lock.lua
  ├── active_state_restoration.lua
  ├── entity-scanner.lua
  ├── entity-handlers.lua
  └── surface-counter.lua (count_items, count_fluids)
        ↑
        ├── verification.lua (thin wrappers)
        ├── transfer-validation.lua (uses count_items, count_fluids, FluidReconciliation)
        └── loss-analysis.lua (uses count_all, FluidReconciliation)
              ↑
              └── async-processor.lua (orchestration only)
```

---

## Execution Order

| Order | Phase | Risk | LOC Saved | Files Changed |
|-------|-------|------|-----------|---------------|
| 1 | 1a-1e: Shared constants & helpers | Low | ~80 | 6 |
| 2 | 2a-2b: Surface counting | Medium | ~200 | 4 + 1 new |
| 3 | 3a-3b: Loss analysis extraction | Medium | ~300 | 3 + 1 new |
| 4 | 4a-4b: async-processor cleanup | Low | ~40 | 1 |
| 5 | 5a-5c: Deserializer cleanup | Low | ~35 | 1 |
| 6 | 6a-6b: Minor cleanup | Low | ~20 | 2 |

**Total estimated LOC reduction:** ~675 lines of duplicate/inline code

---

## Testing Strategy

Each phase should be validated by running:
1. Full cluster deploy (`./tools/deploy-cluster.ps1 -SkipIncrement`)
2. Export a platform: `rc11 "/export-platform 1"`
3. Transfer a platform: `rc11 "/transfer-platform 1 2"` (exercises export, import, validation, loss analysis, IPC)
4. Check logs for any errors: `docker exec surface-export-host-1 tail -200 /clusterio/instances/clusterio-host-1-instance-1/factorio-current.log`
5. Verify validation result: `rc21 "/sc rcon.print(remote.call('surface_export', 'get_validation_result_json', '<platform_name>'))"`
