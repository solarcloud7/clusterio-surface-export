# Failed Entity Loss Tracking

## Problem

When `create_entity` returns nil (placement failure), all downstream restoration phases silently skip that entity. The items, fluids, and belt contents that *would* have been restored are lost without attribution. Validation sees the mismatch but reports it as unexplained — "expected 500 iron-plate, got 450" with no indication that a foundry failed to place and was holding those 50 plates.

**Root cause**: `entity_map[entity_data.entity_id]` is nil for failed entities. Every restoration phase checks this and moves on. No code tallies what was inside the failed entity.

**When this happens**: Mod mismatches (unknown prototype), tile collisions, or prototype changes between export/import instances.

## Goal

Three improvements, all achieved with minimal code changes:

1. **Honest expected totals** — Subtract failed-entity items/fluids from "expected" before validation compares, so known-impossible items don't trigger false failures
2. **Clearer validation output** — Validation result includes a `failedEntityLosses` section attributing exact item/fluid counts to specific failed entities
3. **Better debugging** — Log each failed entity with its name, position, type, and the items/fluids it contained

## Design

### Where to collect data: `entity_creation.lua`

The failure site already has all the information needed. When `create_entity` returns nil, `entity_data` is right there with `specific_data.inventories`, `specific_data.fluids`, `specific_data.items` (belt), and `specific_data.held_item`.

Add a tally at the existing failure branch (currently lines 65-71). No new files, no new state-tracking abstractions.

### What to collect

A new field `job.failed_entity_losses` (table) accumulating:

```lua
job.failed_entity_losses = {
    -- Summary totals
    entity_count = 0,         -- Number of entities that failed to place
    total_items = 0,          -- Total item count across all failed entities
    total_fluids = 0,         -- Total fluid amount across all failed entities

    -- Per-item-type breakdown (for adjusting expected counts)
    items = {},               -- { ["iron-plate"] = 50, ["copper-cable"] = 12, ... }
    fluids = {},              -- { ["molten-iron@15"] = 200.0, ... }

    -- Per-entity detail log (for debugging, capped at 50 entries)
    entities = {},            -- { {name="foundry", type="furnace", position={x=1,y=2}, items=50, fluids=200}, ... }
}
```

### Changes by file

#### 1. `entity_creation.lua` — Collect losses at failure site

In the `batch_failed` branch (after `create_entity` returns nil), sum up items/fluids from `entity_data.specific_data`:

```lua
-- After: batch_failed = batch_failed + 1
-- Add:
local losses = job.failed_entity_losses
if not losses then
    losses = { entity_count = 0, total_items = 0, total_fluids = 0, items = {}, fluids = {}, entities = {} }
    job.failed_entity_losses = losses
end

local entity_items = 0
local entity_fluids = 0

if entity_data.specific_data then
    -- Sum inventory items
    if entity_data.specific_data.inventories then
        for _, inv_data in ipairs(entity_data.specific_data.inventories) do
            for _, item in ipairs(inv_data.items or {}) do
                local key = item.name  -- or use Util.make_quality_key if quality matters
                losses.items[key] = (losses.items[key] or 0) + item.count
                entity_items = entity_items + item.count
            end
        end
    end

    -- Sum belt items
    if entity_data.specific_data.items then
        for _, line_data in ipairs(entity_data.specific_data.items) do
            for _, item in ipairs(line_data.items or {}) do
                local key = item.name
                losses.items[key] = (losses.items[key] or 0) + item.count
                entity_items = entity_items + item.count
            end
        end
    end

    -- Sum held item (inserters)
    if entity_data.specific_data.held_item then
        local held = entity_data.specific_data.held_item
        losses.items[held.name] = (losses.items[held.name] or 0) + held.count
        entity_items = entity_items + held.count
    end

    -- Sum fluids
    if entity_data.specific_data.fluids then
        for _, fluid_data in ipairs(entity_data.specific_data.fluids) do
            local key = fluid_data.name  -- or fluid_key with temperature
            losses.fluids[key] = (losses.fluids[key] or 0) + (fluid_data.amount or 0)
            entity_fluids = entity_fluids + (fluid_data.amount or 0)
        end
    end
end

losses.entity_count = losses.entity_count + 1
losses.total_items = losses.total_items + entity_items
losses.total_fluids = losses.total_fluids + entity_fluids

-- Cap detail entries to prevent memory bloat
if #losses.entities < 50 then
    table.insert(losses.entities, {
        name = entity_data.name or "?",
        type = entity_data.type or "?",
        position = entity_data.position,
        items = entity_items,
        fluids = entity_fluids,
    })
end

-- Enhanced existing log line: include what was lost
log(string.format(
    "[Entity Creation] FAILED to create '%s' (type=%s) at (%.1f,%.1f) — lost %d items, %.1f fluids — index %d/%d",
    entity_data.name or "?", entity_data.type or "?",
    entity_data.position and (entity_data.position.x or entity_data.position[1]) or 0,
    entity_data.position and (entity_data.position.y or entity_data.position[2]) or 0,
    entity_items, entity_fluids, i, job.total_entities))
```

**Complexity**: ~40 lines added to one existing branch. No new functions, no new files.

#### 2. `async-processor.lua` (`complete_import_job`) — Pass losses to validation

Before calling `TransferValidation.validate_import`, adjust expected counts:

```lua
-- Before the validate_import call, adjust expected counts for failed entities
local adjusted_verification = job.platform_data.verification
if job.failed_entity_losses and job.failed_entity_losses.total_items > 0 then
    -- Deep-copy item_counts to avoid mutating source data
    local adjusted_items = {}
    for k, v in pairs(adjusted_verification.item_counts or {}) do
        adjusted_items[k] = v
    end
    -- Subtract items that were in failed entities (can't possibly be on the surface)
    for item_key, lost_count in pairs(job.failed_entity_losses.items) do
        if adjusted_items[item_key] then
            adjusted_items[item_key] = math.max(0, adjusted_items[item_key] - lost_count)
        end
    end
    adjusted_verification = {
        item_counts = adjusted_items,
        fluid_counts = adjusted_verification.fluid_counts,  -- fluids adjusted separately if needed
    }
    log(string.format("[Import] Adjusted expected totals: %d items subtracted due to %d failed entities",
        job.failed_entity_losses.total_items, job.failed_entity_losses.entity_count))
end
```

Then pass `adjusted_verification` to `validate_import` instead of `job.platform_data.verification`.

Also include `failed_entity_losses` in the validation result and the send_json payload:

```lua
-- After validation_result is populated:
if job.failed_entity_losses and job.failed_entity_losses.entity_count > 0 then
    validation_result.failedEntityLosses = job.failed_entity_losses
end
```

**Complexity**: ~15 lines, straightforward copy-adjust pattern.

#### 3. `loss-analysis.lua` — Report failed entity losses in breakdown

Add a section to `LossAnalysis.run()` that logs the failed entity summary if present in the validation result:

```lua
-- After existing item/fluid analysis:
if result.failedEntityLosses and result.failedEntityLosses.entity_count > 0 then
    local fel = result.failedEntityLosses
    log(string.format("[Loss Analysis] %d entities failed to place — %d items and %.1f fluids unrestorable",
        fel.entity_count, fel.total_items, fel.total_fluids))
    for _, ent in ipairs(fel.entities or {}) do
        if ent.items > 0 or ent.fluids > 0 then
            log(string.format("[Loss Analysis]   FAILED: %s (%s) at (%.1f,%.1f) — %d items, %.1f fluids",
                ent.name, ent.type,
                ent.position and (ent.position.x or ent.position[1]) or 0,
                ent.position and (ent.position.y or ent.position[2]) or 0,
                ent.items, ent.fluids))
        end
    end
end
```

**Complexity**: ~12 lines in existing function.

### Files NOT changed

- `transfer-validation.lua` — No changes. It already compares expected vs actual; we adjust expected *before* calling it.
- `fluid_restoration.lua` — No changes. Skipping nil entities is correct behavior.
- `belt_restoration.lua` — No changes. Same skip pattern.
- `entity_state_restoration.lua` — No changes. Same skip pattern.
- No new files created.

## What the output looks like after this change

### Factorio log (enhanced)
```
[Entity Creation] FAILED to create 'foundry' (type=furnace) at (12.5, 4.5) — lost 50 items, 200.0 fluids — index 42/1359
[Import] Adjusted expected totals: 50 items subtracted due to 1 failed entities
[Loss Analysis] 1 entities failed to place — 50 items and 200.0 fluids unrestorable
[Loss Analysis]   FAILED: foundry (furnace) at (12.5, 4.5) — 50 items, 200.0 fluids
```

### Validation result (JSON sent to controller)
```json
{
    "itemCountMatch": true,
    "totalExpectedItems": 12450,
    "totalActualItems": 12448,
    "failedEntityLosses": {
        "entity_count": 1,
        "total_items": 50,
        "total_fluids": 200.0,
        "items": { "iron-plate": 50 },
        "fluids": { "molten-iron": 200.0 },
        "entities": [
            { "name": "foundry", "type": "furnace", "position": {"x": 12.5, "y": 4.5}, "items": 50, "fluids": 200.0 }
        ]
    }
}
```

### Transaction log (web UI)
The `failedEntityLosses` data flows through the existing `send_json` → controller → web UI pipeline. The `TransactionLogsTab.jsx` can display it if/when we add a section for it, but even without web UI changes, the data is available in the raw log JSON.

## Summary

| Aspect | Change |
|--------|--------|
| Files modified | 3 (`entity_creation.lua`, `async-processor.lua`, `loss-analysis.lua`) |
| Lines added | ~70 |
| New files | 0 |
| New abstractions | 0 |
| New state fields | 1 (`job.failed_entity_losses`) |
| Risk | Low — all changes are additive; no existing behavior modified |
| Testing | Deploy, export a platform, delete a mod, import — verify failed entity items are attributed |
