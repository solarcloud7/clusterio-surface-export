# Refactoring Plan: Remove safety.lua

**Date**: January 27, 2026  
**Reason**: safety.lua is a legacy synchronous wrapper that's redundant now that we have async processing with proper error handling.

---

## Current State

### Files Using Safety Module

1. **export-platform.lua** (remote interface)
   - Calls: `Safety.atomic_export(platform_index, force_name)`
   - Returns: Export data from `storage.platform_exports[export_id]`
   - Used by: Clusterio plugin for synchronous exports

2. **export-platform-to-file.lua** (remote interface)
   - Calls: `Safety.atomic_export(platform_index, force_name)`
   - Writes export to disk file
   - Used by: Script commands for file exports

3. **control.lua** (pending imports)
   - Calls: `Safety.atomic_import(pending.filename, platform.surface)`
   - Handles legacy file-based imports waiting for platform surface
   - Used by: Old import system (likely unused)

### What Safety.lua Provides

- `atomic_export()` - pcall wrapper around `Serializer.export_platform()`
- `atomic_import()` - pcall wrapper around `Deserializer.import_platform()`
- `atomic_import_from_data()` - pcall wrapper for JSON string imports
- `create_backup()` - Stub (not implemented)
- `restore_backup()` - Stub (not implemented)
- `delete_backup()` - Stub (not implemented)

---

## Refactoring Strategy

### Phase 1: Update Remote Interfaces

#### 1.1 export-platform.lua

**Current behavior:**
- Synchronously exports platform
- Returns complete export data immediately
- Blocks until export completes

**New behavior:**
- Queue async export job
- Return job_id instead of data
- Data retrieved from storage after job completes (checked by plugin)

**Implementation:**
```lua
-- Remote Interface: export_platform
-- Queue async export and return job ID

local AsyncProcessor = require("modules/surface_export/core/async-processor")

--- Export a platform asynchronously and return job ID
--- @param platform_index number: The index of the platform to export (1-based)
--- @param force_name string: Force name
--- @return string|nil: Job ID on success, nil on failure
local function export_platform(platform_index, force_name)
  local job_id, err = AsyncProcessor.queue_export(platform_index, force_name, nil, nil)
  if not job_id then
    log(string.format("[Export ERROR] Failed to queue export: %s", err or "unknown"))
    return nil
  end
  
  -- Return job ID - caller should poll storage.platform_exports[job_id]
  return job_id
end

return export_platform
```

**Plugin Impact:**
- Plugin will need to poll for completion
- Or use the existing `on_export_complete` event (already implemented)
- This is actually better - matches the async architecture

#### 1.2 export-platform-to-file.lua

**Current behavior:**
- Synchronously exports platform
- Writes to file immediately
- Returns success/failure

**New behavior:**
- Queue async export job
- Write to file in completion callback (or via separate remote call)
- Return job_id

**Implementation:**
```lua
-- Remote Interface: export_platform_to_file
-- Queue async export and optionally write to file when complete

local AsyncProcessor = require("modules/surface_export/core/async-processor")
local Util = require("modules/surface_export/utils/util")

--- Export platform to disk file (script-output directory)
--- @param platform_index number: The index of the platform to export (1-based)
--- @param force_name string: Force name
--- @param filename string (optional): Custom filename
--- @return string|nil, string: Job ID on success (nil + error on failure)
local function export_platform_to_file(platform_index, force_name, filename)
  local job_id, err = AsyncProcessor.queue_export(platform_index, force_name, nil, nil)
  if not job_id then
    return nil, err or "Failed to queue export"
  end
  
  -- Store file write request for when export completes
  storage.pending_file_writes = storage.pending_file_writes or {}
  storage.pending_file_writes[job_id] = {
    filename = filename,
    requested_tick = game.tick
  }
  
  return job_id, nil
end

return export_platform_to_file
```

**Note:** Need to add file writing logic to export completion handler in async-processor.lua

### Phase 2: Update control.lua

#### 2.1 Remove Legacy Import System

The `pending_platform_imports` system appears to be legacy code from before async imports.

**Current code:**
```lua
-- Check for pending imports (waiting for platform surface to be ready)
if storage.pending_platform_imports and #storage.pending_platform_imports > 0 then
    -- Poll for surface ready, then call Safety.atomic_import()
end
```

**Analysis:**
- This is for file-based imports
- Current async system handles this better with `queue_import_from_file()`
- Platform surface waiting is handled in async job itself

**Action:** Remove entire pending_platform_imports block

#### 2.2 Alternative: Convert to Async

If we want to keep file import support:

```lua
-- Check for pending file imports
if storage.pending_file_imports and #storage.pending_file_imports > 0 then
    for i = #storage.pending_file_imports, 1, -1 do
        local pending = storage.pending_file_imports[i]
        
        -- Check for timeout
        if game.tick > pending.timeout_tick then
            log(string.format("[Import ERROR] File import timeout: %s", pending.filename))
            table.remove(storage.pending_file_imports, i)
        else
            -- Queue async import
            local AsyncProcessor = require("modules/surface_export/core/async-processor")
            local job_id, err = AsyncProcessor.queue_import_from_file(
                pending.filename, 
                pending.platform_name, 
                "player", 
                pending.requester
            )
            if job_id then
                log(string.format("[Import] Queued async import from file: %s", pending.filename))
                table.remove(storage.pending_file_imports, i)
            end
        end
    end
end
```

### Phase 3: Delete safety.lua

After confirming no other references:

```bash
git rm docker/seed-data/external_plugins/surface_export/module/core/safety.lua
```

### Phase 4: Update Documentation

Files to update:
- `docs/architecture.md` - Remove Safety Wrapper section
- `docs/async-processing.md` - Remove safety.lua reference
- `CLAUDE.md` - Remove safety.lua from file tree
- `docker/seed-data/external_plugins/surface_export/docs/IMPLEMENTATION_SUMMARY.md` - Remove reference

---

## Testing Plan

### Test 1: Remote Export
```lua
/c local job_id = remote.call("surface_export", "export_platform", 1, "player")
/c game.print(job_id)
-- Wait a few seconds
/c if storage.platform_exports[job_id] then game.print("Export complete") else game.print("Still processing") end
```

### Test 2: Export via Clusterio
```powershell
rc11 "/export-platform 1"
# Check logs for export completion
docker logs clusterio-host-1 | Select-String "Export"
```

### Test 3: Import via Clusterio
```powershell
rc21 "/import-platform export_Alpha_12345"
# Check logs for import job
docker logs clusterio-host-2 | Select-String "Import"
```

### Test 4: Verify No Regressions
- Run full export/import cycle
- Check transaction logs
- Verify item counts match

---

## Migration Notes

### Breaking Changes

**Remote Interface Changes:**
- `export_platform()` now returns `job_id` (string) instead of export data (table)
- `export_platform_to_file()` now returns `job_id` instead of boolean + filename
- Callers must poll `storage.platform_exports[job_id]` or listen for completion event

**Plugin Compatibility:**
- No changes needed - plugin already uses async events
- `handleExportComplete` already handles job completion
- Remote interface calls can be updated to use job_id pattern

### Rollback Plan

If issues arise:
1. Revert all changes: `git revert <commit>`
2. Restore safety.lua from backup
3. Test with original synchronous flow

---

## Completion Checklist

- [ ] Update export-platform.lua to use AsyncProcessor
- [ ] Update export-platform-to-file.lua to use AsyncProcessor
- [ ] Add file writing logic to async export completion
- [ ] Remove pending_platform_imports from control.lua
- [ ] Delete safety.lua
- [ ] Update architecture.md
- [ ] Update async-processing.md
- [ ] Update CLAUDE.md
- [ ] Update IMPLEMENTATION_SUMMARY.md
- [ ] Run Test 1: Remote Export
- [ ] Run Test 2: Export via Clusterio
- [ ] Run Test 3: Import via Clusterio
- [ ] Run Test 4: Full roundtrip verification
- [ ] Update version to 0.9.1 in changelog

---

## Implementation Order

1. ✅ Create this plan document
2. Update export-platform.lua
3. Update export-platform-to-file.lua
4. Update async-processor.lua (add file write completion handler)
5. Update control.lua (remove pending imports)
6. Delete safety.lua
7. Update documentation files
8. Test all scenarios
9. Commit changes

---

**Status**: Ready for implementation
