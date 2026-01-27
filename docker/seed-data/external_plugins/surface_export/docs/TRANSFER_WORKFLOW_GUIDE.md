# Surface Export Plugin - Transfer Workflow Guide

This guide explains how to use the complete surface transfer workflow to move space platforms between Clusterio instances.

## Table of Contents
1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Transfer Flow](#transfer-flow)
4. [API Reference](#api-reference)
5. [Testing](#testing)
6. [Troubleshooting](#troubleshooting)

---

## Overview

The surface-export plugin enables safe, validated transfers of Factorio space platforms between instances with these features:

✅ **Surface Locking** - Source platform is locked during transfer (hidden from players)
✅ **Async Processing** - Non-blocking export/import (50 entities/tick)
✅ **Validation** - Item and fluid counts verified after import
✅ **Automatic Rollback** - Source unlocked if validation fails
✅ **Automatic Cleanup** - Source deleted if validation succeeds

---

## Prerequisites

### 1. Plugin Installation

```bash
# Install plugin on controller
node packages/ctl plugin add ./external_plugins/surface-export

# Start controller with plugin
node packages/controller run

# Start hosts
node packages/host run
```

### 2. Configuration

**Instance Configuration:**
```bash
# Enable script commands (required for RCON)
npx clusterioctl instance config set <instance_name> factorio.enable_script_commands true

# Set export cache size (optional, default: 10)
npx clusterioctl instance config set <instance_name> surface_export.max_export_cache_size 20
```

**Controller Configuration:**
```bash
# Set max storage (optional, default: 100)
npx clusterioctl controller config set surface_export.max_storage_size 200
```

### 3. Verify Plugin Loaded

**Check controller logs:**
```
[info] Surface Export controller plugin initialized
```

**Check instance logs:**
```
[info] Surface Export plugin initialized
```

**Check Factorio logs (in-game or script-output):**
```
[Surface Export] Clusterio module initialized
```

---

## Transfer Flow

### Method 1: Via clusterioctl (Recommended)

#### Step 1: Export Platform on Source Instance

```bash
# From source Factorio console or RCON
/export-platform 1

# This creates an export like: "Platform Name_12345678_export_42"
```

**What happens:**
- Platform is scanned asynchronously
- Entities, tiles, inventories are serialized
- Item/fluid counts calculated for verification
- Export sent to controller for storage

**Expected output:**
```
[Export Complete] Platform Name (500 entities in 10.0s) - ID: Platform Name_12345678_export_42
```

#### Step 2: List Available Exports

```bash
# Via clusterioctl
npx clusterioctl surface-export list

# Output:
# Export ID                              | Platform Name  | Instance | Size
# -------------------------------------- | -------------- | -------- | ------
# Platform Name_12345678_export_42       | Platform Name  | 1        | 2.4 MB
```

#### Step 3: Transfer to Destination Instance

```bash
# Transfer from source (instance 1) to destination (instance 2)
npx clusterioctl surface-export transfer "Platform Name_12345678_export_42" 2

# Output:
# [info] Transfer initiated: transfer_1705680234567_abc123
# [info] Platform import initiated on instance 2, awaiting validation
```

**What happens:**
1. **Source Locked** - Platform hidden, cargo pods wait to complete
2. **Import Started** - 100KB chunks sent via RCON to destination
3. **Async Import** - Platform created and populated (50 entities/tick)
4. **Validation** - Item/fluid counts compared to source
5. **Rollback or Cleanup**:
   - ✅ Success → Source platform deleted
   - ❌ Failure → Source platform unlocked

#### Step 4: Monitor Transfer Status

**Watch controller logs:**
```
[info] Transferring platform Platform Name_12345678_export_42 to instance 2
[info] Created transfer transfer_1705680234567_abc123
[info] Platform import initiated on instance 2, awaiting validation
[info] Validation result for transfer transfer_1705680234567_abc123: SUCCESS
[info] Source platform deleted successfully
```

**Watch destination Factorio in-game:**
```
[Import Platform Name] Progress: 50% (250/500 entities)
[Import Complete] Platform Name (500 entities in 10.0s)
[Transfer] Platform 'Platform Name' transferred successfully
```

---

### Method 2: Via Remote Interface (Advanced)

For programmatic control or custom workflows:

#### Step 1: Lock Platform on Source

```lua
-- Lock platform before export (prevents player modifications)
local success, err = remote.call(
    "FactorioSurfaceExport",
    "lock_platform_for_transfer",
    1,        -- Platform index
    "player"  -- Force name
)

if not success then
    game.print("Lock failed: " .. (err or "Unknown error"))
end
```

#### Step 2: Export Platform

```lua
-- Queue async export
local job_id, err = remote.call(
    "FactorioSurfaceExport",
    "export_platform",
    1,        -- Platform index
    "player"  -- Force name
)

if not job_id then
    game.print("Export failed: " .. (err or "Unknown error"))
end

-- Wait for completion (poll job status)
local status = remote.call(
    "FactorioSurfaceExport",
    "get_import_status",
    job_id
)
```

#### Step 3: Transfer via Controller API

```javascript
// Node.js code in controller or instance plugin
const response = await controller.sendTo(
    "controller",
    new messages.TransferPlatformRequest({
        exportId: "Platform Name_12345678_export_42",
        targetInstanceId: 2
    })
);

console.log("Transfer initiated:", response.transferId);
```

#### Step 4: Handle Validation Result

```lua
-- Destination instance - after import completes
local validation = remote.call(
    "FactorioSurfaceExport",
    "get_validation_result",
    "Platform Name"
)

if validation then
    game.print(string.format(
        "Validation: Items=%s, Fluids=%s, Entities=%d",
        validation.itemCountMatch and "✓" or "✗",
        validation.fluidCountMatch and "✓" or "✗",
        validation.entityCount
    ))
end
```

---

## API Reference

### Lua Remote Interface

#### `lock_platform_for_transfer(platform_index, force_name)`
Locks a platform to prevent modifications during transfer.

**Parameters:**
- `platform_index` (number): Platform index (1-based)
- `force_name` (string): Force name (default: "player")

**Returns:**
- `success` (boolean): true if locked successfully
- `error` (string|nil): Error message if failed

**Example:**
```lua
local ok, err = remote.call("FactorioSurfaceExport", "lock_platform_for_transfer", 1, "player")
```

#### `unlock_platform(platform_name)`
Unlocks a platform (restores original visibility and schedule).

**Parameters:**
- `platform_name` (string): Name of the platform

**Returns:**
- `success` (boolean): true if unlocked successfully
- `error` (string|nil): Error message if failed

**Example:**
```lua
local ok, err = remote.call("FactorioSurfaceExport", "unlock_platform", "Platform Name")
```

#### `get_validation_result(platform_name)`
Retrieves validation result after import.

**Parameters:**
- `platform_name` (string): Name of the platform

**Returns:**
- `validation` (table|nil): Validation result or nil if not found

**Validation Table:**
```lua
{
    itemCountMatch = true,
    fluidCountMatch = true,
    entityCount = 500,
    mismatchDetails = nil  -- or string if validation failed
}
```

**Example:**
```lua
local validation = remote.call("FactorioSurfaceExport", "get_validation_result", "Platform Name")
if validation and not validation.itemCountMatch then
    game.print("Item count mismatch!")
end
```

### Node.js Messages

#### `TransferPlatformRequest`
Initiates a transfer from controller to destination instance.

**Properties:**
- `exportId` (string): Export ID from source
- `targetInstanceId` (number): Destination instance ID

**Example:**
```javascript
const response = await controller.sendTo("controller",
    new messages.TransferPlatformRequest({
        exportId: "Platform Name_12345678_export_42",
        targetInstanceId: 2
    })
);
```

#### `TransferValidationEvent`
Sent from destination instance to controller after import validation.

**Properties:**
- `transferId` (string): Transfer ID
- `platformName` (string): Platform name
- `sourceInstanceId` (number): Source instance ID
- `success` (boolean): Validation result
- `validation` (object): Validation details

**Example:**
```javascript
// Event is sent automatically by instance plugin
// Controller handles it in handleTransferValidation()
```

#### `DeleteSourcePlatformRequest`
Controller sends to source instance to delete platform after successful transfer.

**Properties:**
- `platformIndex` (number): Platform index
- `platformName` (string): Platform name
- `forceName` (string): Force name

#### `UnlockSourcePlatformRequest`
Controller sends to source instance to unlock platform after failed transfer.

**Properties:**
- `platformName` (string): Platform name
- `forceName` (string): Force name

---

## Testing

### Test 1: Simple Transfer

```bash
# 1. Create a test platform on instance 1
# In-game: Build a small platform with 10-20 entities

# 2. Export it
/export-platform 1

# 3. List exports
npx clusterioctl surface-export list

# 4. Transfer to instance 2
npx clusterioctl surface-export transfer "<export_id>" 2

# 5. Verify on instance 2
# In-game: /list-platforms
# Should show the transferred platform
```

### Test 2: Validation Failure (Intentional)

To test rollback, you can modify the destination after import but before validation completes:

```lua
-- Destination instance - quickly delete items after import starts
-- This will cause validation to fail and trigger rollback
```

### Test 3: Large Platform Transfer

```bash
# Transfer a large platform (1000+ entities)
# Monitor UPS during transfer - should remain stable
# Async processing keeps UPS at 60

# Check logs for throughput:
# [info] All 150 chunks sent successfully (5000ms, 489.6 KB/s)
```

---

## Troubleshooting

### Issue: "Plugin not loaded"

**Symptoms:**
```
[error] Plugin path /opt/seed-plugins/surface-export missing index or main file
```

**Solution:**
Ensure `package.json` has `"clusterio-plugin"` keyword:
```json
"keywords": ["clusterio", "clusterio-plugin", "factorio", "platform", "export"]
```

### Issue: "Platform not found"

**Symptoms:**
```
Export failed: Platform index 1 not found
```

**Solution:**
Check platform index:
```lua
/list-platforms
-- Shows all platforms with their indices
```

### Issue: "Validation failed"

**Symptoms:**
```
[Transfer Validation Failed] Item count mismatch: iron-plate: expected 500, got 450
```

**Possible Causes:**
1. Items consumed during transfer (e.g., fuel burned in furnaces)
2. Mod conflict (different mods on source/destination)
3. Platform modified during transfer (lock failed)

**Solution:**
- Check that both instances have identical mods
- Ensure platform was properly locked
- Review validation details in logs

### Issue: "Chunk timeout"

**Symptoms:**
```
[Import Error] Session timeout: Platform Name
```

**Solution:**
- Check network latency between controller and instance
- Increase chunk timeout (currently 10 seconds)
- Reduce chunk size if network is slow

### Issue: "Lock failed"

**Symptoms:**
```
Lock failed: Timeout waiting for cargo pod deliveries
```

**Solution:**
Wait for cargo pods to complete delivery before transferring:
```lua
-- Check for pending pods
local pending = surface.find_entities_filtered({name = "cargo-pod"})
if #pending > 0 then
    game.print("Waiting for " .. #pending .. " cargo pods to complete")
end
```

---

## Performance Characteristics

### Export Performance
- **Speed**: ~3000 entities/second (50 entities/tick at 60 UPS)
- **UPS Impact**: Minimal (<1% drop for platforms <5000 entities)
- **Duration**: 1000-entity platform ≈ 20 seconds

### Transfer Performance
- **Chunk Size**: 100KB (default)
- **Network**: Depends on latency between controller and instance
- **Throughput**: ~500 KB/s typical (varies by network)

### Import Performance
- **Speed**: ~3000 entities/second (50 entities/tick at 60 UPS)
- **UPS Impact**: Minimal (<1% drop for platforms <5000 entities)
- **Duration**: 1000-entity platform ≈ 20 seconds

### Total Transfer Time
**Small Platform (100 entities):**
- Export: ~2 seconds
- Transfer: ~1 second
- Import: ~2 seconds
- **Total: ~5 seconds**

**Medium Platform (1000 entities):**
- Export: ~20 seconds
- Transfer: ~5 seconds
- Import: ~20 seconds
- **Total: ~45 seconds**

**Large Platform (10000 entities):**
- Export: ~3 minutes
- Transfer: ~30 seconds
- Import: ~3 minutes
- **Total: ~7 minutes**

---

## Best Practices

### 1. Plan Transfers During Low Activity
Transfer large platforms during maintenance windows to avoid player disruption.

### 2. Monitor Logs
Watch both controller and instance logs during transfers to catch issues early.

### 3. Verify Before Transfer
Use `/list-platforms` to confirm platform index before exporting.

### 4. Keep Mods Synchronized
Ensure source and destination instances have identical mods to avoid validation failures.

### 5. Test with Small Platforms First
Before transferring critical platforms, test the workflow with small test platforms.

### 6. Use Named Platforms
Give platforms descriptive names for easier tracking:
```lua
platform.name = "Mining Outpost Alpha"
```

### 7. Clean Up Old Exports
Periodically clean up old exports to save disk space:
```lua
remote.call("FactorioSurfaceExport", "clear_old_exports", 10)  -- Keep only last 10
```

---

## Summary

The surface-export transfer workflow provides a safe, validated way to move platforms between instances:

1. ✅ **Export** - Async serialization with verification checksums
2. ✅ **Lock** - Source platform hidden during transfer
3. ✅ **Transfer** - Chunked data transfer via controller
4. ✅ **Import** - Async deserialization on destination
5. ✅ **Validate** - Item/fluid count comparison
6. ✅ **Cleanup** - Automatic deletion or rollback

This ensures data integrity and prevents corruption during cross-instance platform transfers.
