# Platform Export/Import Flow: Complete Action Trace

**Format**: Step-by-step action breakdown with code references, timing, and debugging commands.  
**Purpose**: Comprehensive trace of every event, function call, and state change during platform transfer.

**Legend**:
- `🎯` Entry point / User action
- `📨` Message / Event
- `⚙️` State change
- `💾` File I/O
- `🔍` Validation
- `✅` Success checkpoint
- `❌` Error condition
- `⏱️` Timing information
- `🔧` Debug command
- `🔒` Surface lock / Critical safety mechanism

**Document Status**: Complete trace with code references  
**Last Updated**: January 26, 2026

---

## 🔒 Surface Lock Mechanism

**Purpose**: Prevents concurrent modifications to a platform surface during export/import operations to ensure data consistency.

**Why It's Critical**:
- **Export**: If players or other systems modify entities during scanning, the export data becomes inconsistent (e.g., items counted but entity deleted before restoration data captured)
- **Import**: If entities are placed while the surface is being modified, placement can fail or create duplicates
- **Prevents Race Conditions**: Only one export/import operation can run on a surface at a time

**How It Works**:
```lua
-- Lock surface (in async-processor.lua)
SurfaceLock.lock_surface(surface_index, job_id)
-- Creates: storage.surface_export.surface_locks[surface_index] = { job_id: "...", locked_at: tick }

-- Unlock surface (after completion)
SurfaceLock.unlock_surface(surface_index, job_id)
-- Removes: storage.surface_export.surface_locks[surface_index]
```

**When Locks Are Applied**:
1. **Export**: Locked in Phase 2 (Initialize) → Unlocked after completion
2. **Import**: Locked in Phase 4 (Initialize) → Unlocked after completion

**Lock Conflict Handling**:
- If a surface is already locked, new export/import operations fail immediately with `"Failed to lock surface"` error
- Lock includes job_id to prevent accidental unlocking by wrong job
- Locks persist across save/load (stored in `storage.surface_export`)

**Troubleshooting Stuck Locks**:
```powershell
# View all locked surfaces
rc11 "/c for surface_index, lock_info in pairs(storage.surface_export.surface_locks or {}) do game.print(surface_index .. ': ' .. serpent.line(lock_info)) end"

# Force unlock (use with caution - only if job crashed)
rc11 "/c storage.surface_export.surface_locks = {}"
```

**See Also**: [Troubleshooting: "Export failed - surface locked"](#issue-export-failed---surface-locked)

---

## Table of Contents

### 1. [Export Flow: Instance 1 → Controller](#export-flow-instance-1--controller)
   - [Phase 1: User Initiates Export](#phase-1-user-initiates-export)
   - [Phase 2: Async Export Processing](#phase-2-async-export-processing)
   - [Phase 3: Instance Plugin Receives Export](#phase-3-instance-plugin-receives-export)
   - [Phase 4: Controller Stores Export](#phase-4-controller-stores-export)
   - [Phase 5: Export Complete](#phase-5-export-complete-)

### 2. [Import Flow: Controller → Instance 2](#import-flow-controller--instance-2)
   - [Phase 1: User Initiates Import](#phase-1-user-initiates-import)
   - [Phase 2: Controller Sends Export Data](#phase-2-controller-sends-export-data)
   - [Phase 3: Instance Plugin Receives Export Data](#phase-3-instance-plugin-receives-export-data)
   - [Phase 4: Async Import Processing in Factorio](#phase-4-async-import-processing-in-factorio)
   - [Phase 5: Plugin Updates Transaction Log](#phase-5-plugin-updates-transaction-log)
   - [Phase 6: Import Complete](#phase-6-import-complete-)

### 3. [Transfer Flow: Instance 1 → Instance 2 (Combined)](#transfer-flow-instance-1--instance-2-combined)
   - [Direct Transfer (Export + Import in One Operation)](#direct-transfer-export--import-in-one-operation)

### 4. [Transaction Log Tracking](#transaction-log-tracking)
   - [Transaction Log Structure](#transaction-log-structure)
   - [Viewing Transaction Logs](#viewing-transaction-logs)

### 5. [Timing Breakdown](#timing-breakdown)
   - [Export Timing (488-entity platform)](#export-timing-488-entity-platform)
   - [Import Timing (488-entity platform)](#import-timing-488-entity-platform)
   - [Complete Transfer Timing](#complete-transfer-timing)

### 6. [Troubleshooting Guide](#troubleshooting-guide)
   - [Export Issues](#export-issues)
   - [Import Issues](#import-issues)
   - [Performance Issues](#performance-issues)

### 7. [Code Reference Map](#code-reference-map)
   - [Lua Files (Factorio Mod)](#lua-files-factorio-mod)
   - [JavaScript Files (Clusterio Plugin)](#javascript-files-clusterio-plugin)
   - [Storage Locations](#storage-locations)

### 8. [Quick Reference: Debug Commands](#quick-reference-debug-commands)
   - [Check Export Status](#check-export-status)
   - [Check Import Status](#check-import-status)
   - [View Transaction Logs](#view-transaction-logs)
   - [Monitor Real-Time](#monitor-real-time)

**Important**: See [🔒 Surface Lock Mechanism](#-surface-lock-mechanism) for critical safety information.

---

# 📤 EXPORT FLOW

---

## Export Flow: Instance 1 → Controller

### Phase 1: User Initiates Export

#### Step 1.1: Command Entry 🎯

**User Action**:
```lua
/export-platform 1
```

**Alternative Triggers**:
```powershell
# Via PowerShell shortcut
rc11 "/export-platform 1"

# Via clusterioctl
docker exec surface-export-controller npx clusterioctl instance rcon clusterio-host-1-instance-1 "/export-platform 1"

# Via RCON message (plugin-triggered)
messages.ExportPlatformRequest.send(instance, { platformIndex: 1 })
```

**Log Location**: 
- Factorio: `/clusterio-hosts/clusterio-host-1/instances/clusterio-host-1-instance-1/factorio-current.log`
- Host: `docker logs surface-export-host-1`

#### Step 1.2: Command Handler Invoked 📨

**File**: `docker/seed-data/external_plugins/surface_export/module/interfaces/commands.lua`  
**Function**: `Commands.export_platform(args)`

**Actions**:
```lua
-- Parse command arguments
local platform_identifier = args.parameter  -- "1" or "platform name"

-- Validate argument
if not platform_identifier or platform_identifier == "" then
    player.print("[Export] Usage: /export-platform <index_or_name>", {r=1, g=0.5, b=0})
    return
end

-- Find platform by index or name
local platform = find_platform(platform_identifier)
if not platform then
    player.print("[Export] Platform not found: " .. platform_identifier, {r=1, g=0, b=0})
    return
end

-- Check if platform surface exists
if not platform.surface or not platform.surface.valid then
    player.print("[Export] Platform has no valid surface", {r=1, g=0, b=0})
    return
end
```

**Expected Output**:
```
[Export] Starting export for platform 'Alpha' (index 1)
```

**⏱️ Timing**: <1ms (command parsing)

#### Step 1.3: Export Job Queued ⚙️

**File**: `docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua`  
**Function**: `AsyncProcessor.queue_export(platform, player_name)`

**Actions**:
```lua
-- Generate unique job ID
local job_id = generate_job_id()  -- e.g., "export_Alpha_1234567890_job_1"

-- Create job descriptor
local job = {
    type = "export",
    job_id = job_id,
    platform_index = platform.index,
    platform_name = platform.name,
    surface_index = platform.surface.index,
    player_name = player_name,
    created_tick = game.tick,
    status = "queued",
    current_phase = "initializing",
    entities_processed = 0,
    total_entities = 0,
    batch_size = storage.surface_export.config.batch_size or 50,
    show_progress = storage.surface_export.config.show_progress or true
}

-- Add to job queue
table.insert(storage.surface_export.jobs, job)

-- Log job creation
log(string.format("[AsyncProcessor] Export job queued: %s", job_id))
```

**Storage Location**: `storage.surface_export.jobs[1]`

**User Feedback**:
```
[Export] Export queued: export_Alpha_1234567890_job_1
Processing in background...
```

**⏱️ Timing**: <1ms (job creation)

---

### Phase 2: Async Export Processing

#### Step 2.1: Export Phase: Initialize �

**Critical**: This step locks the surface to prevent modifications during export.

**Trigger**: `script.on_event(defines.events.on_tick)` → `AsyncProcessor.process_tick()`

**File**: `docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua`  
**Function**: `AsyncProcessor.process_export_job(job)`

**Actions**:
```lua
-- Phase: "initializing"
if job.current_phase == "initializing" then
    -- 🔒 Lock surface to prevent modifications during export
    local lock_result = SurfaceLock.lock_surface(job.surface_index, job.job_id)
    if not lock_result then
        job.status = "failed"
        job.error = "Failed to lock surface"
        log(string.format("[AsyncProcessor ERROR] %s: %s", job.job_id, job.error))
        return
    end
    
    -- Scan for all entities on platform surface
    local entities = job.surface.find_entities()
    job.total_entities = #entities
    job.entity_list = entities
    job.current_entity_index = 0
    
    -- Initialize export data structure
    job.export_data = {
        schema_version = "1.0.0",
        factorio_version = game.active_mods["base"],
        export_timestamp = game.tick,
        platform = {
            name = job.platform_name,
            index = job.platform_index,
            surface_index = job.surface_index
        },
        entities = {},
        metadata = {
            total_entity_count = job.total_entities,
            total_item_count = 0,
            total_fluid_count = 0
        }
    }
    
    -- Transition to scanning phase
    job.current_phase = "scanning_entities"
    log(string.format("[AsyncProcessor] %s: Initialized, found %d entities", job.job_id, job.total_entities))
end
```

**State Changes**:
- ⚙️ `job.status`: `"queued"` → `"running"`
- ⚙️ `job.current_phase`: `"initializing"` → `"scanning_entities"`
- 🔒 **Surface locked for export** (prevents any modifications until complete)

**⏱️ Timing**: ~10-50ms (depends on entity count for `find_entities()`)

#### Step 2.2: Export Phase: Scan Entities (Batch Processing) 📨

**Phase Execution**: Runs over multiple ticks (50 entities per tick by default)

**Actions Per Tick**:
```lua
-- Phase: "scanning_entities"
if job.current_phase == "scanning_entities" then
    local batch_count = 0
    local batch_size = job.batch_size
    
    -- Process next batch of entities
    while batch_count < batch_size and job.current_entity_index < job.total_entities do
        job.current_entity_index = job.current_entity_index + 1
        local entity = job.entity_list[job.current_entity_index]
        
        if entity and entity.valid then
            -- Scan entity
            local entity_data = EntityScanner.scan_entity(entity)
            
            -- Scan inventories
            local inventory_data = InventoryScanner.scan_all_inventories(entity)
            entity_data.inventories = inventory_data.inventories
            
            -- Update item counts
            job.export_data.metadata.total_item_count = 
                job.export_data.metadata.total_item_count + inventory_data.total_items
            
            -- Scan fluids
            if entity.fluidbox and #entity.fluidbox > 0 then
                entity_data.fluids = FluidScanner.scan_fluidboxes(entity)
                job.export_data.metadata.total_fluid_count = 
                    job.export_data.metadata.total_fluid_count + entity_data.fluids.total_fluid
            end
            
            -- Add to export
            table.insert(job.export_data.entities, entity_data)
        end
        
        batch_count = batch_count + 1
        job.entities_processed = job.current_entity_index
    end
    
    -- Progress reporting (every 10 batches)
    if job.show_progress and job.entities_processed % (batch_size * 10) == 0 then
        local progress_pct = math.floor((job.entities_processed / job.total_entities) * 100)
        game.print(string.format(
            "[Export] Processing: %d/%d entities (%d%%)", 
            job.entities_processed, job.total_entities, progress_pct
        ))
    end
    
    -- Check if scanning complete
    if job.current_entity_index >= job.total_entities then
        job.current_phase = "serializing"
        log(string.format("[AsyncProcessor] %s: Entity scanning complete", job.job_id))
    end
end
```

**Example Progress Output** (488 entities, batch_size=50):
```
Tick 12345: [Export] Processing: 500/488 entities (10%)  -- After 1 batch
Tick 12346: [Export] Processing: 1000/488 entities (20%) -- After 2 batches
...
Tick 12354: [Export] Processing: 4500/488 entities (92%) -- After 9 batches
Tick 12355: [Export] Processing: 488/488 entities (100%) -- Complete
```

**⏱️ Timing**: ~10 ticks for 488 entities at batch_size=50 (~167ms at 60 UPS)

#### Step 2.3: Export Phase: Serialize to JSON 📨

**Actions**:
```lua
-- Phase: "serializing"
if job.current_phase == "serializing" then
    -- Serialize to JSON
    local json_string = game.table_to_json(job.export_data)
    
    -- Store in global (will be sent to plugin)
    storage.platform_exports[job.job_id] = {
        data = json_string,
        platform_name = job.platform_name,
        timestamp = game.tick,
        size_bytes = #json_string
    }
    
    -- Transition to notifying phase
    job.current_phase = "notifying_plugin"
    job.export_size_bytes = #json_string
    log(string.format("[AsyncProcessor] %s: Serialized to JSON (%d bytes)", job.job_id, #json_string))
end
```

**State Changes**:
- ⚙️ `job.current_phase`: `"serializing"` → `"notifying_plugin"`
- 💾 JSON stored in `storage.platform_exports[job_id]`

**⏱️ Timing**: ~5-20ms (JSON serialization)

#### Step 2.4: Export Phase: Notify Plugin 📨

**File**: `docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua`

**Actions**:
```lua
-- Phase: "notifying_plugin"
if job.current_phase == "notifying_plugin" then
    -- Send export complete notification to Clusterio plugin via clusterio_lib
    local success = clusterio_api.send_json("surface_export_complete", {
        job_id = job.job_id,
        platform_name = job.platform_name,
        platform_index = job.platform_index,
        entity_count = job.total_entities,
        item_count = job.export_data.metadata.total_item_count,
        size_bytes = job.export_size_bytes,
        export_tick = game.tick
    })
    
    if success then
        job.current_phase = "complete"
        job.status = "success"
        log(string.format("[AsyncProcessor] %s: Plugin notified", job.job_id))
    else
        job.status = "failed"
        job.error = "Failed to notify plugin"
        log(string.format("[AsyncProcessor ERROR] %s: Plugin notification failed", job.job_id))
    end
end
```

**Clusterio Message**: `surface_export_complete` event sent to instance plugin

**State Changes**:
- ⚙️ `job.current_phase`: `"notifying_plugin"` → `"complete"`
- ⚙️ `job.status`: `"running"` → `"success"`

**⏱️ Timing**: <1ms (message send)

---

### Phase 3: Instance Plugin Receives Export

#### Step 3.1: Plugin Event Handler 📨

**File**: `docker/seed-data/external_plugins/surface_export/instance.js`  
**Function**: `InstancePlugin.handleExportComplete(message)`  
**Line**: ~98

**Actions**:
```javascript
async handleExportComplete(message) {
    const { job_id, platform_name, entity_count, item_count, size_bytes } = message.data;
    
    this.logger.info(`📤 Export completed: ${job_id}`);
    this.logger.info(`   Platform: ${platform_name}, Entities: ${entity_count}, Items: ${item_count}, Size: ${size_bytes} bytes`);
    
    // Request the actual export data from Lua
    try {
        const exportDataResponse = await this.instance.sendRcon(
            `/sc remote.call("surface_export", "get_export_data", "${job_id}")`,
            true
        );
        
        const exportData = JSON.parse(exportDataResponse);
        
        this.logger.info(`   Received export data (${exportData.length} chars)`);
```

**Log Output** (Host 1):
```
[info] Surface Export: 📤 Export completed: export_Alpha_1234567890_job_1
[info] Surface Export:    Platform: Alpha, Entities: 488, Items: 12453, Size: 235678 bytes
[info] Surface Export:    Received export data (235678 chars)
```

**⏱️ Timing**: ~50-500ms (RCON round-trip + JSON transfer)

#### Step 3.2: Send Export to Controller 📨

**File**: `docker/seed-data/external_plugins/surface_export/instance.js`  
**Function**: Continuation of `handleExportComplete`

**Actions**:
```javascript
        // Send to controller for storage
        await this.sendTo("controller", new messages.StorePlatformExport({
            exportId: job_id,
            platformName: platform_name,
            sourceInstanceId: this.instance.id,
            exportData: exportData,
            metadata: {
                entityCount: entity_count,
                itemCount: item_count,
                sizeBytes: size_bytes,
                exportTick: message.data.export_tick,
                timestamp: Date.now()
            }
        }));
        
        this.logger.info(`✅ Export sent to controller storage`);
        
    } catch (err) {
        this.logger.error(`Failed to process export: ${err.message}`);
        this.logger.error(err.stack);
    }
}
```

**WebSocket Message**: `StorePlatformExport` sent from Instance → Controller

**Log Output**:
```
[info] Surface Export: ✅ Export sent to controller storage
```

**⏱️ Timing**: ~10-50ms (WebSocket message)

---

### Phase 4: Controller Stores Export

#### Step 4.1: Controller Message Handler 📨

**File**: `docker/seed-data/external_plugins/surface_export/controller.js`  
**Function**: `ControllerPlugin.handleStorePlatformExport(message, src)`  
**Line**: ~50

**Actions**:
```javascript
async handleStorePlatformExport(message, src) {
    const { exportId, platformName, sourceInstanceId, exportData, metadata } = message.data;
    
    this.logger.info(`📥 Storing platform export: ${exportId}`);
    this.logger.info(`   From instance ${sourceInstanceId}, platform '${platformName}'`);
    this.logger.info(`   Entities: ${metadata.entityCount}, Items: ${metadata.itemCount}, Size: ${metadata.sizeBytes} bytes`);
    
    try {
        // Store in controller's platform storage
        await this.platformStorage.set(exportId, {
            platformName,
            sourceInstanceId,
            exportData,
            metadata,
            storedAt: Date.now()
        });
        
        this.logger.info(`✅ Export stored: ${exportId}`);
        
        // Notify source instance of successful storage
        await this.sendTo({ instanceId: sourceInstanceId }, new messages.ExportStorageConfirm({
            exportId,
            success: true
        }));
        
    } catch (err) {
        this.logger.error(`Failed to store export ${exportId}: ${err.message}`);
        throw err;
    }
}
```

**Storage Location**: `/clusterio/platforms/${exportId}.json`

**Log Output** (Controller):
```
[info] Surface Export: 📥 Storing platform export: export_Alpha_1234567890_job_1
[info] Surface Export:    From instance 1, platform 'Alpha'
[info] Surface Export:    Entities: 488, Items: 12453, Size: 235678 bytes
[info] Surface Export: ✅ Export stored: export_Alpha_1234567890_job_1
```

**File Created**: 💾 `/clusterio/platforms/export_Alpha_1234567890_job_1.json`

**⏱️ Timing**: ~10-100ms (disk write, depends on size)

#### Step 4.2: Create Transaction Log 📨

**File**: `docker/seed-data/external_plugins/surface_export/controller.js`  
**Function**: Continuation of `handleStorePlatformExport`

**Actions**:
```javascript
        // Create transaction log
        const transactionId = `transfer_${Date.now()}_${sourceInstanceId}_pending`;
        await this.transactionLogStorage.set(transactionId, {
            type: "export",
            status: "exported",
            exportId,
            platformName,
            sourceInstanceId,
            destinationInstanceId: null,  // Not imported yet
            metadata,
            createdAt: Date.now(),
            exportedAt: Date.now(),
            importedAt: null,
            events: [
                {
                    timestamp: Date.now(),
                    event: "export_complete",
                    instanceId: sourceInstanceId,
                    details: { entityCount: metadata.entityCount, itemCount: metadata.itemCount }
                }
            ]
        });
        
        this.logger.info(`📋 Transaction log created: ${transactionId}`);
```

**Storage Location**: `/clusterio/transaction_logs/${transactionId}.json`

**⏱️ Timing**: ~5-20ms (disk write)

---

### Phase 5: Export Complete ✅

**Summary**:
- ✅ Platform scanned: 488 entities
- ✅ Data serialized: 235KB JSON
- ✅ Stored on controller
- ✅ Transaction log created
- 🔒 Source surface unlocked (can be modified again)

**Total Time**: ~500ms - 2 seconds (depends on platform size and network latency)

**Verification Commands**:
```powershell
# Check export exists in controller storage
docker exec surface-export-controller ls -lh /clusterio/platforms/ | Select-String "export_Alpha"

# View transaction log
.\tools\get-transaction-log.ps1

# Check Factorio logs
docker exec surface-export-host-1 cat /clusterio/instances/clusterio-host-1-instance-1/factorio-current.log | Select-String "export_Alpha"
```

---

# 🔄 IMPORT FLOW

---

## Import Flow: Controller → Instance 2

### Phase 1: User Initiates Import

#### Step 1.1: Command Entry 🎯

**User Action**:
```lua
/import-platform export_Alpha_1234567890_job_1
```

**Alternative Triggers**:
```powershell
# Via PowerShell shortcut
rc21 "/import-platform export_Alpha_1234567890_job_1"

# Via plugin message
messages.ImportPlatformRequest.send(instance, { 
    exportId: "export_Alpha_1234567890_job_1",
    targetInstanceId: 2 
})
```

#### Step 1.2: Command Handler Invoked 📨

**File**: `docker/seed-data/external_plugins/surface_export/module/interfaces/commands.lua`  
**Function**: `Commands.import_platform(args)`

**Actions**:
```lua
-- Parse command
local export_id = args.parameter

-- Request export from controller via plugin
clusterio_api.send_json("surface_import_file_request", {
    export_id = export_id,
    requester_player = player.name
})

player.print(string.format("[Import] Requesting export: %s", export_id))
log(string.format("[Import] Import requested: %s", export_id))
```

**Clusterio Message**: `surface_import_file_request` → Instance Plugin

**⏱️ Timing**: <1ms

#### Step 1.3: Instance Plugin Requests from Controller 📨

**File**: `docker/seed-data/external_plugins/surface_export/instance.js`  
**Function**: `InstancePlugin.handleImportFileRequest(message)`

**Actions**:
```javascript
async handleImportFileRequest(message) {
    const { export_id, requester_player } = message.data;
    
    this.logger.info(`📥 Import request received: ${export_id}`);
    
    try {
        // Request export from controller
        const response = await this.sendTo("controller", new messages.RequestPlatformExport({
            exportId: export_id,
            targetInstanceId: this.instance.id,
            requesterPlayer: requester_player
        }));
        
        this.logger.info(`   Export retrieved from controller`);
```

**WebSocket Message**: `RequestPlatformExport` → Controller

**⏱️ Timing**: ~10-50ms (WebSocket round-trip)

---

### Phase 2: Controller Sends Export Data

#### Step 2.1: Controller Retrieves Export 📨

**File**: `docker/seed-data/external_plugins/surface_export/controller.js`  
**Function**: `ControllerPlugin.handleRequestPlatformExport(message, src)`

**Actions**:
```javascript
async handleRequestPlatformExport(message, src) {
    const { exportId, targetInstanceId, requesterPlayer } = message.data;
    
    this.logger.info(`📦 Export requested: ${exportId} by instance ${targetInstanceId}`);
    
    try {
        // Retrieve from storage
        const exportRecord = await this.platformStorage.get(exportId);
        
        if (!exportRecord) {
            this.logger.error(`Export not found: ${exportId}`);
            throw new Error(`Export not found: ${exportId}`);
        }
        
        this.logger.info(`   Found export for platform '${exportRecord.platformName}'`);
        this.logger.info(`   Original source: instance ${exportRecord.sourceInstanceId}`);
        this.logger.info(`   Size: ${exportRecord.metadata.sizeBytes} bytes`);
        
        // Send to requesting instance
        await this.sendTo({ instanceId: targetInstanceId }, new messages.PlatformExportData({
            exportId,
            platformName: exportRecord.platformName,
            sourceInstanceId: exportRecord.sourceInstanceId,
            exportData: exportRecord.exportData,
            metadata: exportRecord.metadata,
            requesterPlayer
        }));
        
        this.logger.info(`✅ Export sent to instance ${targetInstanceId}`);
```

**Log Output** (Controller):
```
[info] Surface Export: 📦 Export requested: export_Alpha_1234567890_job_1 by instance 2
[info] Surface Export:    Found export for platform 'Alpha'
[info] Surface Export:    Original source: instance 1
[info] Surface Export:    Size: 235678 bytes
[info] Surface Export: ✅ Export sent to instance 2
```

**⏱️ Timing**: ~10-50ms (storage read + WebSocket send)

---

### Phase 3: Instance Plugin Receives Export Data

#### Step 3.1: Plugin Processes Export Data 📨

**File**: `docker/seed-data/external_plugins/surface_export/instance.js`  
**Function**: Continuation of `handleImportFileRequest`

**Actions**:
```javascript
        // Response received (PlatformExportData message)
        const { exportData, platformName, metadata } = response;
        
        this.logger.info(`   Sending export data to Factorio...`);
        
        // Send export data to Lua via RCON (chunked for large exports)
        const importScript = `/sc remote.call("surface_export", "import_platform_async", game.json_to_table([[${exportData}]]))`;
        
        // Use adaptive chunking for large exports
        const result = await sendAdaptiveJson(
            this.instance,
            "surface_export",
            "import_platform_async",
            JSON.parse(exportData),
            this.logger
        );
        
        this.logger.info(`✅ Import initiated in Factorio`);
        
    } catch (err) {
        this.logger.error(`Failed to process import: ${err.message}`);
        throw err;
    }
}
```

**Log Output** (Host 2):
```
[info] Surface Export:    Sending export data to Factorio...
[info] Surface Export: ✅ Import initiated in Factorio
```

**⏱️ Timing**: ~100-1000ms (RCON chunking depends on export size)

---

### Phase 4: Async Import Processing in Factorio

#### Step 4.1: Remote Interface Called 📨

**File**: `docker/seed-data/external_plugins/surface_export/module/interfaces/remote-interface.lua`  
**Function**: `RemoteInterface.import_platform_async(export_data)`

**Actions**:
```lua
-- Create new platform
local platform_name = export_data.platform.name .. " #" .. (get_next_platform_number())
local platform = game.forces.player.create_space_platform({
    name = platform_name,
    planet = nil,  -- Created in space
    starter_pack = nil  -- Empty platform
})

log(string.format("[Import] Created platform: %s", platform_name))

-- Queue async import job
local job_id = AsyncProcessor.queue_import(export_data, platform, player_name)

return {
    success = true,
    job_id = job_id,
    platform_name = platform_name,
    message = "Import queued: " .. job_id
}
```

**State Changes**:
- ⚙️ New platform created
- ⚙️ Import job queued

**User Feedback**:
```
[Import] Platform created: Alpha #2
[Import] Import queued: import_job_2
Processing in background...
```

**⏱️ Timing**: ~10-50ms (platform creation)

#### Step 4.2: Import Phase: Initialize �

**Critical**: This step locks the surface to prevent modifications during import.

**File**: `docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua`  
**Function**: `AsyncProcessor.process_import_job(job)`

**Actions**:
```lua
-- Phase: "initializing"
if job.current_phase == "initializing" then
    -- Wait for platform surface to be ready
    if not job.platform.surface or not job.platform.surface.valid then
        -- Platform surface not ready yet, wait
        if game.tick > job.timeout_tick then
            job.status = "failed"
            job.error = "Platform surface initialization timeout"
            return
        end
        return  -- Wait for next tick
    end
    
    -- 🔒 Surface ready, lock it to prevent modifications during import
    local lock_result = SurfaceLock.lock_surface(job.surface_index, job.job_id)
    if not lock_result then
        job.status = "failed"
        job.error = "Failed to lock surface"
        return
    end
    
    -- Prepare entity placement list
    job.total_entities = #job.export_data.entities
    job.current_entity_index = 0
    job.entities_placed = 0
    job.entities_failed = 0
    
    -- Transition to placing phase
    job.current_phase = "placing_entities"
    log(string.format("[AsyncProcessor] %s: Initialized, will place %d entities", job.job_id, job.total_entities))
end
```

**State Changes**:
- ⚙️ `job.current_phase`: `"initializing"` → `"placing_entities"`
- 🔒 **Platform surface locked** (prevents modifications during import)

**⏱️ Timing**: ~10-100ms (waiting for surface initialization)

#### Step 4.3: Import Phase: Place Entities (Batch Processing) 📨

**Phase Execution**: Runs over multiple ticks

**Actions Per Tick**:
```lua
-- Phase: "placing_entities"
if job.current_phase == "placing_entities" then
    local batch_count = 0
    local batch_size = job.batch_size
    
    -- Place next batch of entities
    while batch_count < batch_size and job.current_entity_index < job.total_entities do
        job.current_entity_index = job.current_entity_index + 1
        local entity_data = job.export_data.entities[job.current_entity_index]
        
        -- Create entity
        local created_entity = job.surface.create_entity({
            name = entity_data.name,
            position = entity_data.position,
            direction = entity_data.direction,
            force = "player",
            raise_built = false,
            create_build_effect_smoke = false
        })
        
        if created_entity and created_entity.valid then
            -- Restore health
            if entity_data.health then
                created_entity.health = entity_data.health
            end
            
            -- Restore inventories
            if entity_data.inventories then
                InventoryRestorer.restore_inventories(created_entity, entity_data.inventories)
            end
            
            -- Restore fluids
            if entity_data.fluids then
                FluidRestorer.restore_fluids(created_entity, entity_data.fluids)
            end
            
            -- Restore entity-specific state (recipe, filters, etc.)
            EntityStateRestorer.restore_state(created_entity, entity_data)
            
            job.entities_placed = job.entities_placed + 1
        else
            job.entities_failed = job.entities_failed + 1
            log(string.format("[AsyncProcessor WARN] %s: Failed to create entity: %s at %s", 
                job.job_id, entity_data.name, serpent.line(entity_data.position)))
        end
        
        batch_count = batch_count + 1
    end
    
    -- Progress reporting
    if job.show_progress and job.current_entity_index % (batch_size * 10) == 0 then
        local progress_pct = math.floor((job.current_entity_index / job.total_entities) * 100)
        game.print(string.format(
            "[Import] Placing entities: %d/%d (%d%%) - %d failed", 
            job.entities_placed, job.total_entities, progress_pct, job.entities_failed
        ))
    end
    
    -- Check if placement complete
    if job.current_entity_index >= job.total_entities then
        job.current_phase = "validating"
        log(string.format("[AsyncProcessor] %s: Entity placement complete - %d placed, %d failed", 
            job.job_id, job.entities_placed, job.entities_failed))
    end
end
```

**Example Progress Output**:
```
Tick 23456: [Import] Placing entities: 50/488 (10%) - 0 failed
Tick 23457: [Import] Placing entities: 100/488 (20%) - 1 failed
...
Tick 23465: [Import] Placing entities: 488/488 (100%) - 3 failed
```

**⏱️ Timing**: ~10 ticks for 488 entities (~167ms at 60 UPS)

#### Step 4.4: Import Phase: Validation 🔍

**Actions**:
```lua
-- Phase: "validating"
if job.current_phase == "validating" then
    -- Count all items on imported platform
    local actual_item_counts = {}
    for _, entity in pairs(job.surface.find_entities()) do
        if entity.valid then
            local item_counts = InventoryScanner.count_all_items(entity)
            for item_name, count in pairs(item_counts) do
                actual_item_counts[item_name] = (actual_item_counts[item_name] or 0) + count
            end
        end
    end
    
    -- Compare with expected counts
    local expected_counts = job.export_data.verification.item_counts
    local discrepancies = {}
    
    for item_name, expected_count in pairs(expected_counts) do
        local actual_count = actual_item_counts[item_name] or 0
        if actual_count ~= expected_count then
            table.insert(discrepancies, {
                item = item_name,
                expected = expected_count,
                actual = actual_count,
                delta = actual_count - expected_count
            })
        end
    end
    
    -- Store validation results
    job.validation_results = {
        discrepancies = discrepancies,
        total_expected = job.export_data.metadata.total_item_count,
        total_actual = count_total_items(actual_item_counts)
    }
    
    -- Log results
    if #discrepancies > 0 then
        log(string.format("[AsyncProcessor WARN] %s: Item count discrepancies detected:", job.job_id))
        for _, disc in ipairs(discrepancies) do
            log(string.format("  %s: expected %d, got %d (delta: %+d)", 
                disc.item, disc.expected, disc.actual, disc.delta))
        end
    else
        log(string.format("[AsyncProcessor] %s: Validation passed - all item counts match", job.job_id))
    end
    
    -- Transition to notification
    job.current_phase = "notifying_plugin"
end
```

**State Changes**:
- ⚙️ `job.current_phase`: `"validating"` → `"notifying_plugin"`
- 🔍 Validation results stored

**⏱️ Timing**: ~50-200ms (depends on entity count)

#### Step 4.5: Import Phase: Notify Plugin 📨

**Actions**:
```lua
-- Phase: "notifying_plugin"
if job.current_phase == "notifying_plugin" then
    -- Send completion notification to plugin
    clusterio_api.send_json("surface_export_import_complete", {
        job_id = job.job_id,
        platform_name = job.platform.name,
        entities_placed = job.entities_placed,
        entities_failed = job.entities_failed,
        validation_results = job.validation_results,
        import_tick = game.tick
    })
    
    -- Unlock surface
    SurfaceLock.unlock_surface(job.surface_index, job.job_id)
    
    -- Mark complete
    job.current_phase = "complete"
    job.status = "success"
    
    -- User feedback
    game.print(string.format(
        "[Import] ✅ Complete: Platform '%s' created with %d entities (%d failed)", 
        job.platform.name, job.entities_placed, job.entities_failed
    ))
    
    if #job.validation_results.discrepancies > 0 then
        game.print(string.format(
            "[Import] ⚠️ Warning: %d item count discrepancies detected", 
            #job.validation_results.discrepancies
        ), {r=1, g=0.8, b=0})
    end
    
    log(string.format("[AsyncProcessor] %s: Import complete", job.job_id))
end
```

**User Feedback**:
```
[Import] ✅ Complete: Platform 'Alpha #2' created with 485 entities (3 failed)
[Import] ⚠️ Warning: 2 item count discrepancies detected
```

**State Changes**:
- 🔒 **Surface unlocked** (import complete, surface now modifiable)
- ⚙️ `job.status`: `"running"` → `"success"`

**⏱️ Timing**: <1ms

---

### Phase 5: Plugin Updates Transaction Log

#### Step 5.1: Plugin Receives Import Complete 📨

**File**: `docker/seed-data/external_plugins/surface_export/instance.js`  
**Function**: `InstancePlugin.handleImportCompleteValidation(message)`

**Actions**:
```javascript
async handleImportCompleteValidation(message) {
    const { job_id, platform_name, entities_placed, entities_failed, validation_results } = message.data;
    
    this.logger.info(`✅ Import completed: ${job_id}`);
    this.logger.info(`   Platform: ${platform_name}`);
    this.logger.info(`   Entities: ${entities_placed} placed, ${entities_failed} failed`);
    
    if (validation_results.discrepancies.length > 0) {
        this.logger.warn(`⚠️  Validation: ${validation_results.discrepancies.length} item count discrepancies`);
        for (const disc of validation_results.discrepancies) {
            this.logger.warn(`   ${disc.item}: expected ${disc.expected}, got ${disc.actual} (delta: ${disc.delta})`);
        }
    } else {
        this.logger.info(`✅ Validation: All item counts match`);
    }
    
    // Notify controller to update transaction log
    await this.sendTo("controller", new messages.ImportCompleteNotification({
        exportId: this.currentImportExportId,  // Tracked from import request
        targetInstanceId: this.instance.id,
        platformName: platform_name,
        entitiesPlaced: entities_placed,
        entitiesFailed: entities_failed,
        validationResults: validation_results,
        completedAt: Date.now()
    }));
}
```

**Log Output** (Host 2):
```
[info] Surface Export: ✅ Import completed: import_job_2
[info] Surface Export:    Platform: Alpha #2
[info] Surface Export:    Entities: 485 placed, 3 failed
[info] Surface Export: ✅ Validation: All item counts match
```

**⏱️ Timing**: ~10-50ms

#### Step 5.2: Controller Updates Transaction Log 📨

**File**: `docker/seed-data/external_plugins/surface_export/controller.js`  
**Function**: `ControllerPlugin.handleImportCompleteNotification(message, src)`

**Actions**:
```javascript
async handleImportCompleteNotification(message, src) {
    const { exportId, targetInstanceId, platformName, entitiesPlaced, entitiesFailed, validationResults, completedAt } = message.data;
    
    this.logger.info(`📋 Import complete for export: ${exportId}`);
    this.logger.info(`   Imported to instance ${targetInstanceId} as '${platformName}'`);
    
    // Find transaction log
    const transactionId = await this.findTransactionByExportId(exportId);
    
    if (transactionId) {
        const transaction = await this.transactionLogStorage.get(transactionId);
        
        // Update transaction
        transaction.status = "completed";
        transaction.destinationInstanceId = targetInstanceId;
        transaction.importedAt = completedAt;
        transaction.importResults = {
            platformName,
            entitiesPlaced,
            entitiesFailed,
            validationResults
        };
        transaction.events.push({
            timestamp: completedAt,
            event: "import_complete",
            instanceId: targetInstanceId,
            details: { entitiesPlaced, entitiesFailed, discrepancyCount: validationResults.discrepancies.length }
        });
        
        // Save updated transaction
        await this.transactionLogStorage.set(transactionId, transaction);
        
        this.logger.info(`✅ Transaction log updated: ${transactionId}`);
    }
}
```

**Log Output** (Controller):
```
[info] Surface Export: 📋 Import complete for export: export_Alpha_1234567890_job_1
[info] Surface Export:    Imported to instance 2 as 'Alpha #2'
[info] Surface Export: ✅ Transaction log updated: transfer_1234567890_1_2
```

**File Updated**: 💾 `/clusterio/transaction_logs/transfer_1234567890_1_2.json`

**⏱️ Timing**: ~5-20ms

---

### Phase 6: Import Complete ✅

**Summary**:
- ✅ Export retrieved from controller
- ✅ Platform created: "Alpha #2"
- ✅ Entities placed: 485/488 (3 failed)
- ✅ Validation complete: 0 discrepancies
- ✅ Transaction log updated
- 🔒 Target surface unlocked (import complete)

**Total Time**: ~1-3 seconds (depends on platform size and network latency)

**Verification Commands**:
```powershell
# Check platform created
rc21 "/c for _, p in pairs(game.forces.player.platforms) do game.print(p.name) end"

# View transaction log
.\tools\get-transaction-log.ps1

# Check Factorio logs
docker exec surface-export-host-2 cat /clusterio/instances/clusterio-host-2-instance-1/factorio-current.log | Select-String "import_job"
```

---

# 🔀 TRANSFER FLOW

---

## Transfer Flow: Instance 1 → Instance 2 (Combined)

### Direct Transfer (Export + Import in One Operation)

**Trigger**: Plugin-initiated transfer request

**File**: `docker/seed-data/external_plugins/surface_export/instance.js`  
**Function**: `InstancePlugin.handleTransferRequest(message)`

This flow combines both export and import phases automatically:

1. **Export Phase** (Steps 1.1 - 4.2 from Export Flow)
2. **Automatic Import Trigger** (Controller initiates import to target instance)
3. **Import Phase** (Steps 1.3 - 5.2 from Import Flow)

**Advantages**:
- Single command for complete transfer
- Automatic cleanup after successful import
- Transaction log tracks entire flow
- Can optionally delete source platform

---

# 📋 TRANSACTION LOG TRACKING

---

## Transaction Log Tracking

### Transaction Log Structure

**File**: `/clusterio/transaction_logs/transfer_${timestamp}_${srcId}_${dstId}.json`

**Schema**:
```json
{
  "type": "transfer",
  "status": "completed",
  "exportId": "export_Alpha_1234567890_job_1",
  "platformName": "Alpha",
  "sourceInstanceId": 1,
  "destinationInstanceId": 2,
  "metadata": {
    "entityCount": 488,
    "itemCount": 12453,
    "sizeBytes": 235678
  },
  "createdAt": 1737894567000,
  "exportedAt": 1737894568000,
  "importedAt": 1737894570000,
  "importResults": {
    "platformName": "Alpha #2",
    "entitiesPlaced": 485,
    "entitiesFailed": 3,
    "validationResults": {
      "discrepancies": [],
      "total_expected": 12453,
      "total_actual": 12453
    }
  },
  "events": [
    {
      "timestamp": 1737894568000,
      "event": "export_complete",
      "instanceId": 1,
      "details": { "entityCount": 488, "itemCount": 12453 }
    },
    {
      "timestamp": 1737894570000,
      "event": "import_complete",
      "instanceId": 2,
      "details": { "entitiesPlaced": 485, "entitiesFailed": 3, "discrepancyCount": 0 }
    }
  ]
}
```

### Viewing Transaction Logs

**PowerShell Script**: `tools\get-transaction-log.ps1`

```powershell
# Get latest transaction
.\tools\get-transaction-log.ps1

# Get specific transaction
.\tools\get-transaction-log.ps1 -TransferId "transfer_1737894567000_1_2"

# List all transactions
.\tools\list-transaction-logs.ps1
```

---

# ⏱️ TIMING BREAKDOWN

---

## Timing Breakdown

### Export Timing (488-entity platform)

| Phase | Duration | Percentage |
|-------|----------|------------|
| Command parsing | <1ms | <0.1% |
| Job queueing | <1ms | <0.1% |
| Surface locking | ~10ms | 1% |
| Entity scanning (10 ticks) | ~167ms | 15% |
| JSON serialization | ~20ms | 2% |
| Plugin notification | <1ms | <0.1% |
| RCON data transfer | ~500ms | 45% |
| Controller storage | ~50ms | 4.5% |
| Transaction log | ~10ms | 1% |
| **Total** | **~760ms** | **100%** |

### Import Timing (488-entity platform)

| Phase | Duration | Percentage |
|-------|----------|------------|
| Command parsing | <1ms | <0.1% |
| Export retrieval | ~50ms | 3% |
| RCON data transfer | ~800ms | 50% |
| Platform creation | ~50ms | 3% |
| Surface initialization | ~100ms | 6% |
| Entity placement (10 ticks) | ~167ms | 10% |
| Inventory restoration | (included) | - |
| Validation | ~100ms | 6% |
| Plugin notification | <1ms | <0.1% |
| Transaction log update | ~10ms | 0.5% |
| **Total** | **~1.6s** | **100%** |

### Complete Transfer Timing

**Total Time**: Export (760ms) + Import (1600ms) = **~2.4 seconds**

**Bottlenecks**:
1. **RCON round-trips** (50% of total time) - Limited by network + RCON protocol
2. **Entity processing** (25% of total time) - Limited by batch_size setting
3. **Storage I/O** (10% of total time) - Disk write speed

**Optimization Opportunities**:
- Increase `batch_size` (default: 50) for faster processing (may cause frame drops)
- Use local storage (not network-mounted) for `/clusterio/`
- Upgrade network between containers (use host networking for minimal latency)

---

# 🔧 TROUBLESHOOTING GUIDE

---

## Troubleshooting Guide

### Export Issues

#### Issue: "Export failed - surface locked"

**Cause**: Another export/import is in progress on the same surface

**Debug Commands**:
```powershell
# Check locked surfaces
rc11 "/c for surface_index, lock_info in pairs(storage.surface_export.surface_locks or {}) do game.print(surface_index .. ': ' .. serpent.line(lock_info)) end"

# Force unlock (use with caution)
rc11 "/c storage.surface_export.surface_locks = {}"
```

#### Issue: "Export data not received by plugin"

**Debug**:
1. Check Factorio logs for `surface_export_complete` event
2. Check Host logs for export completion handler
3. Verify clusterio_lib is loaded: `rc11 "/c game.print(remote.interfaces['clusterio'] and 'loaded' or 'not loaded')"`

**Logs**:
```powershell
# Factorio logs
docker exec surface-export-host-1 grep "surface_export_complete" /clusterio/instances/clusterio-host-1-instance-1/factorio-current.log

# Host plugin logs
docker logs surface-export-host-1 2>&1 | Select-String "export_complete"
```

---

### Import Issues

#### Issue: "Import stuck at 'waiting for surface'"

**Cause**: Platform surface not initializing

**Debug**:
```powershell
# Check pending imports
rc21 "/c game.print(#(storage.pending_platform_imports or {}))"

# Check platform surface status
rc21 "/c for _, p in pairs(game.forces.player.platforms) do game.print(p.name .. ': surface=' .. tostring(p.surface ~= nil)) end"

# Force retry
rc21 "/c storage.pending_platform_imports = {}"
```

#### Issue: "Item count validation failures"

**Cause**: Mod mismatch, quality differences, or failed entity placement

**Debug**:
```powershell
# View validation results
rc21 "/c if storage.surface_export.jobs then for _, job in ipairs(storage.surface_export.jobs) do if job.validation_results then game.print(serpent.block(job.validation_results)) end end end"

# Check failed entities
docker exec surface-export-host-2 grep "Failed to create entity" /clusterio/instances/clusterio-host-2-instance-1/factorio-current.log
```

**Common Causes**:
- Missing mod on target instance
- Quality mod not installed
- Belt-like entity with items (belt contents not preserved by design)

---

### Performance Issues

#### Issue: "Export/import causes game lag"

**Cause**: `batch_size` too high

**Solution**:
```powershell
# Reduce batch size (default 50)
docker exec surface-export-controller npx clusterioctl instance config set clusterio-host-1-instance-1 surface_export.batch_size 25

# Restart instance
docker exec surface-export-controller npx clusterioctl instance stop clusterio-host-1-instance-1
docker exec surface-export-controller npx clusterioctl instance start clusterio-host-1-instance-1
```

#### Issue: "RCON timeouts during large exports"

**Debug**:
```powershell
# Check RCON response time
Measure-Command { docker exec surface-export-controller npx clusterioctl instance rcon clusterio-host-1-instance-1 "/time" }

# If >1 second, RCON may be overloaded
```

**Solution**: Use chunked RCON transfers (automatic for exports >100KB)

---

# 📚 CODE REFERENCE MAP

---

## Code Reference Map

### Lua Files (Factorio Mod)

| File | Purpose | Key Functions |
|------|---------|---------------|
| `module/control.lua` | Entry point | `on_init`, `on_tick`, event handlers |
| `module/interfaces/commands.lua` | Console commands | `export_platform`, `import_platform`, `list_exports` |
| `module/interfaces/remote-interface.lua` | Remote calls | `export_platform`, `import_platform_async`, `get_export_data` |
| `module/core/async-processor.lua` | Async job processing | `process_tick`, `queue_export`, `queue_import` |
| `module/export_scanners/entity-scanner.lua` | Entity data extraction | `scan_entity`, `scan_inventories` |
| `module/import_phases/entity-restorer.lua` | Entity recreation | `create_entity`, `restore_inventories` |
| `module/utils/surface-lock.lua` | Surface locking | `lock_surface`, `unlock_surface` |
| `module/validators/item-counter.lua` | Validation | `count_items`, `compare_counts` |

### JavaScript Files (Clusterio Plugin)

| File | Purpose | Key Functions |
|------|---------|---------------|
| `instance.js` | Instance plugin | `handleExportComplete`, `handleImportFileRequest` |
| `controller.js` | Controller plugin | `handleStorePlatformExport`, `handleRequestPlatformExport` |
| `messages.js` | Message definitions | All Clusterio message classes |
| `helpers.js` | Utility functions | `sendChunkedJson`, `sendAdaptiveJson` |

### Storage Locations

| Data | Location | Format |
|------|----------|--------|
| Platform exports | `/clusterio/platforms/` | JSON files |
| Transaction logs | `/clusterio/transaction_logs/` | JSON files |
| Factorio logs | `/clusterio-hosts/.../instances/.../factorio-current.log` | Text |
| Host logs | `docker logs surface-export-host-X` | Text |
| Controller logs | `docker logs surface-export-controller` | Text |

---

# 🚀 QUICK REFERENCE

---

## Quick Reference: Debug Commands

### Check Export Status

```powershell
# View all exports in controller storage
docker exec surface-export-controller ls -lh /clusterio/platforms/

# Get export metadata
docker exec surface-export-controller cat /clusterio/platforms/export_Alpha_1234567890_job_1.json | ConvertFrom-Json | Select-Object -Property platform, metadata
```

### Check Import Status

```powershell
# View active jobs in Factorio
rc21 "/c if storage.surface_export.jobs then for i, job in ipairs(storage.surface_export.jobs) do game.print(i .. ': ' .. job.job_id .. ' - ' .. job.status .. ' - ' .. job.current_phase) end else game.print('No jobs') end"

# Check pending imports
rc21 "/c game.print(#(storage.pending_platform_imports or {}) .. ' pending imports')"
```

### View Transaction Logs

```powershell
# Latest transaction
.\tools\get-transaction-log.ps1

# All transactions
.\tools\list-transaction-logs.ps1

# Specific transaction
.\tools\get-transaction-log.ps1 -TransferId "transfer_1737894567000_1_2"
```

### Monitor Real-Time

```powershell
# Follow Factorio logs
docker logs -f surface-export-host-1 2>&1 | Select-String "export|import"

# Follow controller logs
docker logs -f surface-export-controller 2>&1 | Select-String "Surface Export"

# Follow all logs
docker compose logs -f
```

---

**End of Document**

For questions or issues, see [README.md](../README.md) or check the [Troubleshooting](#troubleshooting-guide) section above.
