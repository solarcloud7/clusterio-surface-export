# Surface Export Plugin - Transfer Flow Documentation

This document provides a comprehensive view of the surface-export plugin's data flow when transferring Factorio space platforms between instances in a Clusterio cluster.

## Table of Contents
1. [Overview](#overview)
2. [Transfer Command Initiated](#1-transfer-command-initiated)
3. [Source Instance: Lock Surface](#2-source-instance-lock-surface)
4. [Source Instance: Export Surface](#3-source-instance-export-surface)
5. [Transfer to Controller](#4-transfer-to-controller)
6. [Transfer to Destination Instance](#5-transfer-to-destination-instance)
7. [Destination Instance: Import Surface](#6-destination-instance-import-surface)
8. [Validation & Rollback](#7-validation--rollback)
9. [Success: Cleanup Source](#8-success-cleanup-source)
10. [Error Handling](#9-error-handling)
11. [Data Structures](#10-data-structures-at-each-level)
12. [Message Sequence Diagrams](#11-message-sequence-diagrams)
13. [Component Responsibilities](#12-key-responsibilities-by-component)
14. [Configuration](#13-configuration)

## Overview

The surface_export plugin enables cross-instance transfer of Factorio space platforms. Unlike inventory_sync which handles player state, surface_export transfers complete platform snapshots including entities, tiles, inventories, and connections.

**Key Components:**
- **Lua Module** (save-patched): Serializes platforms, locks surfaces, handles async operations
- **Instance Plugin**: Bridges Lua ↔ Controller communication, handles chunking
- **Controller Plugin**: Manages platform storage, coordinates transfers between instances

**Communication Flow:**
```
Source Instance (Lua) ←IPC→ Source Instance Plugin ←WebSocket→ Controller ←WebSocket→ Destination Instance Plugin ←IPC→ Destination Instance (Lua)
```

**Transfer Phases:**
1. Transfer command initiated
2. Lock surface from modifications
3. Export surface asynchronously
4. Send to controller for storage
5. Transfer to destination instance
6. Import surface asynchronously
7. Validate item counts
8. On success: delete from source / On failure: unlock source

---

## 1. Transfer Command Initiated

### Phase 1: User Issues Transfer Command

**Command Format:**
```bash
# Via clusterioctl
npx clusterioctl surface-export transfer <export_id> <source_instance_id> <destination_instance_id>

# Or via Web UI
# Navigate to Surface Export page → Select platform → Click "Transfer"
```

**Controller Handler:**
```javascript
// controller.js:186-192
async handleTransferPlatformRequest(request) {
    const instance = this.controller.instances.get(request.targetInstanceId);
    if (!instance) {
        return { success: false, error: `Unknown instance ${request.targetInstanceId}` };
    }
    return this.transferPlatform(request.exportId, request.targetInstanceId);
}
```

**Message:**
```javascript
// messages.js:192-238
class TransferPlatformRequest {
    constructor({
        exportId: string,           // ID of platform export to transfer
        targetInstanceId: number    // Destination instance ID
    })
}
```

**Initial State:**
- Source instance has platform at index N
- Destination instance is running and connected
- Controller has no stored export yet

---

## 2. Source Instance: Lock Surface

### Phase 1: Identify Surface to Lock

**Command received by source instance:**
```javascript
// instance.js:302-304
async handleExportPlatformRequest(request) {
    return await this.exportPlatform(request.platformIndex, request.forceName);
}
```

### Phase 2: Lock Surface from Changes

**Lua locks the surface:**
```lua
-- commands.lua:36-40 (conceptual addition needed)
local platform = force.platforms[platform_index]
local surface = platform.surface

-- Lock surface from player modifications
force.set_surface_hidden(surface, true)

-- Ensure no deliveries to/from platform
-- Wait for all pending cargo pod deliveries to complete
local pending_pods = surface.find_entities_filtered({name = "cargo-pod"})
while #pending_pods > 0 do
    -- Wait one tick
    coroutine.yield()
    pending_pods = surface.find_entities_filtered({name = "cargo-pod"})
end

-- Remove platform from planetary orbit if docked
if platform.schedule then
    storage.locked_platforms = storage.locked_platforms or {}
    storage.locked_platforms[platform.name] = {
        original_schedule = platform.schedule,
        original_hidden = force.get_surface_hidden(surface),
        locked_tick = game.tick
    }
end
```

**Surface Lock State:**
```lua
storage.locked_platforms[platform_name] = {
    original_schedule = {...},     -- Saved for rollback
    original_hidden = false,       -- Original visibility state
    locked_tick = 12345678,        -- Tick when locked
    platform_index = 1,            -- Platform index
    surface_index = 42             -- Surface index
}
```

**Lock Duration:** Remains locked until transfer completes or fails

---

## 3. Source Instance: Export Surface

### Phase 1: Queue Async Export

**Export initiated:**
```javascript
// instance.js:120-135
async exportPlatform(platformIndex, forceName = "player") {
    this.logger.info(`Exporting platform index ${platformIndex} for force "${forceName}"`);

    const result = await this.sendRcon(
        `/sc remote.call("FactorioSurfaceExport", "export_platform", ${platformIndex}, "${forceName}")`
    );

    return { success: true, message: result };
}
```

**Lua queues export job:**
```lua
-- commands.lua:91-96
local job_id, queue_err = AsyncProcessor.queue_export(
    platform_index,
    force_name,
    "TRANSFER"  -- Indicates transfer operation
)
```

### Phase 2: Async Export Processing

**AsyncProcessor creates export job:**
```lua
-- async-processor.lua:88-139
function AsyncProcessor.queue_export(platform_index, force_name, requester_name)
    storage.async_job_id_counter = storage.async_job_id_counter + 1
    local job_id = "export_" .. storage.async_job_id_counter

    local platform = force.platforms[platform_index]
    local surface = platform.surface
    local entities = surface.find_entities_filtered({})

    storage.async_jobs[job_id] = {
        type = "export",
        job_id = job_id,
        platform_index = platform_index,
        platform_name = platform.name,
        force_name = force_name,
        requester = requester_name,
        started_tick = game.tick,
        entities = entities,
        total_entities = #entities,
        current_index = 0,
        export_data = {
            platform_name = platform.name,
            force_name = force_name,
            entities = {},
            stats = {
                entity_count = #entities,
                started_tick = game.tick
            }
        }
    }

    return job_id
end
```

### Phase 3: Process Export Batches (on_tick)

**Batch processing:**
```lua
-- async-processor.lua:386-414
local function process_export_batch(job)
    local batch_size = get_batch_size()  -- Default: 50 entities per tick
    local start_index = job.current_index + 1
    local end_index = math.min(start_index + batch_size - 1, job.total_entities)

    for i = start_index, end_index do
        local entity = job.entities[i]
        if entity and entity.valid then
            local entity_data = EntityScanner.serialize_entity(entity)
            if entity_data then
                table.insert(job.export_data.entities, entity_data)
            end
        end
    end

    job.current_index = end_index

    -- Show progress every 10 batches
    if should_show_progress() and end_index % (batch_size * 10) == 0 then
        local progress = math.floor((end_index / job.total_entities) * 100)
        game.print(string.format("[Export %s] Progress: %d%% (%d/%d entities)",
            job.platform_name, progress, end_index, job.total_entities))
    end

    return job.current_index >= job.total_entities
end
```

**Runs every tick:**
```lua
-- control.lua:14-16
script.on_event(defines.events.on_tick, function()
    AsyncProcessor.process_tick()
end)
```

### Phase 4: Export Complete

**Export finalization:**
```lua
-- async-processor.lua:477-519
local function complete_export_job(job)
    local export_id = job.platform_name .. "_" .. job.started_tick .. "_" .. job.job_id

    -- Store completed export
    storage.platform_exports = storage.platform_exports or {}
    storage.platform_exports[export_id] = job.export_data

    -- Calculate stats
    local duration_ticks = game.tick - job.started_tick
    local duration_seconds = duration_ticks / 60

    game.print(string.format(
        "[Export Complete] %s (%d entities in %.1fs) - ID: %s",
        job.platform_name, job.total_entities, duration_seconds, export_id
    ), {0, 1, 0})

    -- Notify Clusterio via IPC
    clusterio_api.send_json("surface_export_complete", {
        export_id = export_id,
        platform_name = job.platform_name,
        entity_count = job.total_entities,
        duration_ticks = duration_ticks
    })

    storage.async_jobs[job.job_id] = nil
end
```

### Phase 5: Validation

**Verification before sending:**
```lua
-- serializer.lua:52-62
-- Count items for verification
local item_counts = Verification.count_all_items(entity_data)
local total_items = Util.sum_items(item_counts)

-- Count fluids
local fluid_counts = Verification.count_all_fluids(entity_data)
local total_fluids = Util.sum_fluids(fluid_counts)

-- Generate checksum
local verification_hash = Util.simple_checksum(json_preview)
```

**Export Data Structure:**
```lua
export_data = {
    schema_version = "1.0.0",
    factorio_version = "2.0",
    export_timestamp = game.tick,
    platform = {
        name = platform.name,
        force = platform.force.name,
        index = platform_index,
        surface_index = surface.index,
        schedule = platform.schedule,
        paused = platform.paused
    },
    metadata = {
        total_entity_count = #entity_data,
        total_tile_count = #tile_data,
        total_item_count = total_items,
        total_fluid_volume = total_fluids,
        verification_hash = "abc123def"
    },
    entities = {...},
    tiles = {...},
    verification = {
        item_counts = {["iron-plate"] = 500, ...},
        fluid_counts = {["crude-oil"] = 1000.5, ...}
    }
}
```

---

## 4. Transfer to Controller

### Phase 1: Instance Sends Export to Controller

**IPC Event Handler:**
```javascript
// instance.js:63-88
async handleExportComplete(data) {
    this.logger.info(`Platform export completed: ${data.export_id} (${data.platform_name})`);

    // Retrieve full export data from mod
    const exportData = await this.getExportData(data.export_id);

    if (!exportData) {
        this.logger.error(`Failed to retrieve export data for ${data.export_id}`);
        return;
    }

    // Send export to controller for storage
    await this.instance.sendTo("controller", new messages.PlatformExportEvent({
        exportId: data.export_id,
        platformName: data.platform_name,
        instanceId: this.instance.id,
        exportData: exportData,
        timestamp: Date.now(),
    }));

    this.logger.info(`Sent platform export ${data.export_id} to controller`);
}
```

**Get Export Data via RCON:**
```javascript
// instance.js:142-157
async getExportData(exportId) {
    const result = await this.sendRcon(
        `/sc local export = remote.call("FactorioSurfaceExport", "get_export", "${exportId}"); ` +
        `if export then rcon.print(game.table_to_json(export.data)) else rcon.print("null") end`
    );

    if (result === "null") {
        return null;
    }
    return JSON.parse(result);
}
```

### Phase 2: Controller Receives and Stores Export

**Controller Event Handler:**
```javascript
// controller.js:63-92
async handlePlatformExport(event) {
    this.logger.info(
        `Received platform export: ${event.exportId} from instance ${event.instanceId} ` +
        `(${event.platformName})`
    );

    const serializedSize = Buffer.byteLength(JSON.stringify(event.exportData), "utf8");

    // Store platform export
    this.platformStorage.set(event.exportId, {
        exportId: event.exportId,
        platformName: event.platformName,
        instanceId: event.instanceId,
        exportData: event.exportData,
        timestamp: event.timestamp,
        size: serializedSize,
    });

    this.logger.info(`Stored platform export: ${event.exportId}`);

    // Clean up old exports if storage exceeds configured limit
    const maxStorage = this.controller.config.get("surface_export.max_storage_size");
    if (this.platformStorage.size > maxStorage) {
        this.cleanupOldExports(maxStorage);
    }

    await this.persistStorage();
}
```

**Controller State:**
```javascript
// controller.js:29
this.platformStorage = new Map();

// Entry structure:
platformStorage.set(exportId, {
    exportId: "Platform Name_12345678_export_42",
    platformName: "Platform Name",
    instanceId: 1,
    exportData: {...},  // Full platform data
    timestamp: 1705680234567,
    size: 2456789  // Bytes
});
```

### Phase 3: Persistence to Disk

**Save to database directory:**
```javascript
// controller.js:218-226
async persistStorage() {
    const payload = JSON.stringify(Array.from(this.platformStorage.values()), null, 2);
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    await fs.writeFile(this.storagePath, payload, "utf8");
}
```

**File Location:** `{controller.database_directory}/surface_export_storage.json`

**File Format:**
```json
[
    {
        "exportId": "Platform Name_12345678_export_42",
        "platformName": "Platform Name",
        "instanceId": 1,
        "exportData": {
            "schema_version": "1.0.0",
            "entities": [...],
            "tiles": [...],
            "verification": {...}
        },
        "timestamp": 1705680234567,
        "size": 2456789
    }
]
```

---

## 5. Transfer to Destination Instance

### Phase 1: Controller Initiates Transfer

**Transfer request handler:**
```javascript
// controller.js:149-180
async transferPlatform(exportId, targetInstanceId) {
    this.logger.info(`Transferring platform ${exportId} to instance ${targetInstanceId}`);

    // Get export data
    const exportData = this.platformStorage.get(exportId);
    if (!exportData) {
        return { success: false, error: `Export not found: ${exportId}` };
    }

    // Send import request to target instance
    const response = await this.controller.sendTo(
        { instanceId: targetInstanceId },
        new messages.ImportPlatformRequest({
            exportId: exportId,
            exportData: exportData.exportData,
            forceName: "player",
        })
    );

    if (response.success) {
        this.logger.info(`Successfully transferred platform ${exportId} to instance ${targetInstanceId}`);
    } else {
        this.logger.error(`Failed to transfer platform: ${response.error}`);
    }

    return response;
}
```

**Message Sent:**
```javascript
// messages.js:98-146
class ImportPlatformRequest {
    constructor({
        exportId: string,       // Original export ID
        exportData: object,     // Full platform data
        forceName: string       // Target force (default: "player")
    })
}
```

### Phase 2: Destination Instance Receives Request

**Instance handler:**
```javascript
// instance.js:311-313
async handleImportPlatformRequest(request) {
    return await this.importPlatform(request.exportData, request.forceName);
}
```

---

## 6. Destination Instance: Import Surface

### Phase 1: Prepare for Chunked Transfer

**Node.js prepares platform data:**
```javascript
// instance.js:182-209
async importPlatform(exportData, forceName = "player") {
    this.logger.info(`Importing platform for force "${forceName}"`);

    // Serialize export data as JSON
    const jsonData = JSON.stringify(exportData);
    const platformName = exportData.platform.name;

    // Send via chunked RCON (100KB chunks)
    await sendChunkedJson(
        this.instance,
        `remote.call("FactorioSurfaceExport", "import_platform_chunk", "${platformName}", %CHUNK%, %INDEX%, %TOTAL%, "${forceName}")`,
        exportData,
        this.logger,
        100000  // 100KB chunks
    );

    this.logger.info(`Platform import chunks sent successfully`);
    return { success: true, message: `Platform "${platformName}" import queued` };
}
```

### Phase 2: Send Chunks via RCON

**Chunking helper with hybrid escaping:**
```javascript
// helpers.js:40-85
async function sendChunkedJson(instance, luaTemplate, data, logger, chunkSize = 100000) {
    const json = JSON.stringify(data);
    const needsEscaping = json.includes(']]');

    logger.info(
        `Sending ${json.length} bytes in ${chunkSize} byte chunks ` +
        `(escaping: ${needsEscaping ? 'yes' : 'no'})`
    );

    const chunks = chunkify(chunkSize, json);
    const startTime = Date.now();

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const index = i + 1;
        const total = chunks.length;

        let chunkString;
        if (needsEscaping) {
            chunkString = `'${lib.escapeString(chunk)}'`;
        } else {
            chunkString = `[[${chunk}]]`;
        }

        // Replace template placeholders
        const command = luaTemplate
            .replace(/%CHUNK%/g, chunkString)
            .replace(/%INDEX%/g, index.toString())
            .replace(/%TOTAL%/g, total.toString());

        await instance.sendRcon(`/sc ${command}`, true);

        if (i % 10 === 0 || index === total) {
            const percent = ((index / total) * 100).toFixed(1);
            logger.verbose(`Sent chunk ${index}/${total} (${percent}%)`);
        }
    }

    const duration = Date.now() - startTime;
    const throughput = (json.length / 1024 / (duration / 1000)).toFixed(2);
    logger.info(
        `All ${chunks.length} chunks sent successfully ` +
        `(${duration}ms, ${throughput} KB/s)`
    );
}
```

**RCON Commands Sent:**
```bash
/sc remote.call("FactorioSurfaceExport", "import_platform_chunk", "Platform Name", [[chunk1_data]], 1, 150, "player")
/sc remote.call("FactorioSurfaceExport", "import_platform_chunk", "Platform Name", [[chunk2_data]], 2, 150, "player")
...
/sc remote.call("FactorioSurfaceExport", "import_platform_chunk", "Platform Name", [[chunk150_data]], 150, 150, "player")
```

### Phase 3: Lua Reassembles Chunks

**Remote interface receives chunks:**
```lua
-- remote-interface.lua (conceptual - not yet in codebase)
function RemoteInterface.import_platform_chunk(platform_name, chunk_data, chunk_num, total_chunks, force_name)
    force_name = force_name or "player"

    if not storage.chunked_imports then
        storage.chunked_imports = {}
    end

    local session_key = platform_name .. "_" .. force_name

    if not storage.chunked_imports[session_key] then
        storage.chunked_imports[session_key] = {
            platform_name = platform_name,
            force_name = force_name,
            total_chunks = total_chunks,
            chunks = {},
            started_tick = game.tick
        }
    end

    local session = storage.chunked_imports[session_key]
    session.chunks[chunk_num] = chunk_data
    session.last_activity = game.tick

    -- Count received chunks
    local received = 0
    for i = 1, total_chunks do
        if session.chunks[i] then
            received = received + 1
        end
    end

    if received < total_chunks then
        return string.format("CHUNK_OK:%d/%d", received, total_chunks)
    end

    -- All chunks received - reassemble
    local json_parts = {}
    for i = 1, total_chunks do
        table.insert(json_parts, session.chunks[i])
    end
    local complete_json = table.concat(json_parts, "")

    storage.chunked_imports[session_key] = nil

    -- Queue async import
    local job_id, err = AsyncProcessor.queue_import(
        complete_json,
        platform_name,
        force_name,
        "TRANSFER"
    )

    if not job_id then
        return "ERROR:" .. (err or "Failed to queue import")
    end

    return "JOB_QUEUED:" .. job_id
end
```

### Phase 4: Queue Async Import

**AsyncProcessor creates import job:**
```lua
-- async-processor.lua:285-384
function AsyncProcessor.queue_import(json_data, new_platform_name, force_name, requester_name)
    storage.async_job_id_counter = storage.async_job_id_counter + 1
    local job_id = "import_" .. storage.async_job_id_counter

    -- Parse JSON
    local platform_data = Util.json_to_table_compat(json_data)
    if not platform_data then
        return nil, "Failed to parse JSON data"
    end

    local force = game.forces[force_name] or game.forces.player

    -- Handle duplicate names
    local final_name = new_platform_name
    local function platform_name_exists(name)
        for _, platform in pairs(force.platforms) do
            if platform.name == name then
                return true
            end
        end
        return false
    end

    if platform_name_exists(new_platform_name) then
        local counter = 1
        while platform_name_exists(string.format("%s #%d", new_platform_name, counter)) do
            counter = counter + 1
        end
        final_name = string.format("%s #%d", new_platform_name, counter)
        game.print(string.format("[Import Warning] Platform '%s' already exists, renamed to '%s'",
            new_platform_name, final_name), {1, 0.5, 0})
    end

    -- Create new platform
    local new_platform = force.create_space_platform({
        name = final_name,
        planet = "nauvis",
        starter_pack = "space-platform-starter-pack"
    })

    if not new_platform or not new_platform.valid then
        return nil, "Failed to create platform"
    end

    -- Apply starter pack to activate surface
    new_platform.apply_starter_pack()

    if not new_platform.surface or not new_platform.surface.valid then
        new_platform.destroy()
        return nil, "Platform surface not valid after activation"
    end

    storage.async_jobs[job_id] = {
        type = "import",
        job_id = job_id,
        platform_name = new_platform.name,
        force_name = force_name,
        requester = requester_name,
        started_tick = game.tick,
        platform_data = platform_data,
        target_surface = new_platform.surface,
        tiles_to_place = platform_data.tiles or {},
        tiles_placed = false,
        entities_to_create = platform_data.entities or {},
        total_entities = #(platform_data.entities or {}),
        current_index = 0
    }

    return job_id
end
```

### Phase 5: Process Import Batches (on_tick)

**Batch processing:**
```lua
-- async-processor.lua:416-475
local function process_import_batch(job)
    -- Validate surface is still valid
    if not job.target_surface or not job.target_surface.valid then
        game.print("[Import Error] Target surface became invalid", {1, 0, 0})
        return true  -- Abort job
    end

    -- Place all tiles first (before any entities)
    if not job.tiles_placed and job.tiles_to_place and #job.tiles_to_place > 0 then
        local placed, failed = Deserializer.place_tiles(job.target_surface, job.tiles_to_place)
        if placed > 0 then
            game.print(string.format("[Import %s] Placed %d tiles", job.platform_name, placed))
        end
        job.tiles_placed = true
    end

    local batch_size = get_batch_size()  -- Default: 50 entities per tick
    local start_index = job.current_index + 1
    local end_index = math.min(start_index + batch_size - 1, job.total_entities)

    for i = start_index, end_index do
        local entity_data = job.entities_to_create[i]
        if entity_data then
            if entity_data.type == "item-on-ground" then
                Deserializer.create_ground_item(job.target_surface, entity_data)
            else
                local entity = Deserializer.create_entity(job.target_surface, entity_data)
                if entity and entity.valid then
                    Deserializer.restore_entity_state(entity, entity_data)
                    Deserializer.restore_inventories(entity, entity_data)
                    Deserializer.restore_fluids(entity, entity_data)
                end
            end
        end
    end

    job.current_index = end_index

    -- Show progress every 10 batches
    if should_show_progress() and end_index % (batch_size * 10) == 0 then
        local progress = math.floor((end_index / job.total_entities) * 100)
        game.print(string.format("[Import %s] Progress: %d%% (%d/%d entities)",
            job.platform_name, progress, end_index, job.total_entities))
    end

    return job.current_index >= job.total_entities
end
```

### Phase 6: Import Complete

**Import finalization:**
```lua
-- async-processor.lua:521-562
local function complete_import_job(job)
    local duration_ticks = game.tick - job.started_tick
    local duration_seconds = duration_ticks / 60

    game.print(string.format(
        "[Import Complete] %s (%d entities in %.1fs)",
        job.platform_name, job.total_entities, duration_seconds
    ), {0, 1, 0})

    -- Notify Clusterio via IPC
    if clusterio_api and clusterio_api.send_json then
        clusterio_api.send_json("surface_export_import_complete", {
            job_id = job.job_id,
            platform_name = job.platform_name,
            entity_count = job.total_entities,
            duration_ticks = duration_ticks
        })
    end

    storage.async_job_results[job.job_id] = {
        status = "complete",
        complete = true,
        type = "import",
        job_id = job.job_id,
        platform_name = job.platform_name,
        total_entities = job.total_entities,
        duration_ticks = duration_ticks,
        duration_seconds = duration_seconds,
        progress = 100,
        requester = job.requester
    }

    storage.async_jobs[job.job_id] = nil
end
```

---

## 7. Validation & Rollback

### Phase 1: Count Items on Destination

**Destination instance validates:**
```lua
-- validators/verification.lua (conceptual)
function Verification.validate_import(surface, expected_verification)
    local entities = surface.find_entities_filtered({})
    local actual_item_counts = Verification.count_all_items(entities)
    local actual_fluid_counts = Verification.count_all_fluids(entities)

    -- Compare item counts
    for item_name, expected_count in pairs(expected_verification.item_counts) do
        local actual_count = actual_item_counts[item_name] or 0
        if actual_count ~= expected_count then
            return false, string.format(
                "Item count mismatch: %s (expected %d, got %d)",
                item_name, expected_count, actual_count
            )
        end
    end

    -- Compare fluid counts
    for fluid_name, expected_volume in pairs(expected_verification.fluid_counts) do
        local actual_volume = actual_fluid_counts[fluid_name] or 0
        if math.abs(actual_volume - expected_volume) > 0.1 then
            return false, string.format(
                "Fluid volume mismatch: %s (expected %.1f, got %.1f)",
                fluid_name, expected_volume, actual_volume
            )
        end
    end

    return true, nil
end
```

### Phase 2: Send Validation Result to Source

**Destination IPC message:**
```lua
-- Destination sends validation result
clusterio_api.send_json("surface_transfer_validation", {
    transfer_id = transfer_id,
    success = true,
    platform_name = platform_name,
    validation = {
        item_count_match = true,
        fluid_count_match = true,
        entity_count = entity_count
    }
})
```

**Instance forwards to controller:**
```javascript
// instance.js (conceptual addition)
async handleTransferValidation(data) {
    await this.instance.sendTo("controller", new messages.TransferValidationEvent({
        transferId: data.transfer_id,
        success: data.success,
        platformName: data.platform_name,
        validation: data.validation,
    }));
}
```

### Phase 3: Rollback on Failure

**If validation fails, unlock source:**
```lua
-- Source instance receives rollback command
function unlock_platform_surface(platform_name)
    local lock_data = storage.locked_platforms[platform_name]
    if not lock_data then
        return
    end

    local platform = game.forces[lock_data.force_name].platforms[lock_data.platform_index]
    if not platform then
        return
    end

    -- Restore original state
    local force = game.forces[lock_data.force_name]
    force.set_surface_hidden(platform.surface, lock_data.original_hidden)

    if lock_data.original_schedule then
        platform.schedule = lock_data.original_schedule
    end

    storage.locked_platforms[platform_name] = nil

    game.print(string.format(
        "[Transfer Failed] Platform '%s' unlocked and restored",
        platform_name
    ), {1, 0, 0})
end
```

---

## 8. Success: Cleanup Source

### Phase 1: Delete Platform from Source

**Source receives success confirmation:**
```javascript
// instance.js (conceptual addition)
async handleTransferSuccess(data) {
    this.logger.info(`Transfer successful: ${data.platform_name}`);

    // Delete platform from source instance
    const result = await this.sendRcon(
        `/sc local force = game.forces["${data.force_name}"]; ` +
        `local platform = force.platforms[${data.platform_index}]; ` +
        `if platform then platform.destroy(); game.print("[Transfer] Platform deleted from source") end`
    );

    this.logger.info(`Deleted platform from source instance: ${result}`);
}
```

**Lua deletes platform:**
```lua
-- Destroy platform and surface
local platform = force.platforms[platform_index]
if platform and platform.valid then
    platform.destroy()
end

-- Clean up lock data
storage.locked_platforms[platform_name] = nil

game.print(string.format(
    "[Transfer Complete] Platform '%s' successfully transferred",
    platform_name
), {0, 1, 0})
```

### Phase 2: Clean Up Controller Storage (Optional)

**Controller can optionally remove stored export:**
```javascript
// controller.js (conceptual addition)
async cleanupCompletedTransfer(exportId) {
    if (this.platformStorage.has(exportId)) {
        this.platformStorage.delete(exportId);
        await this.persistStorage();
        this.logger.info(`Cleaned up completed transfer: ${exportId}`);
    }
}
```

---

## 9. Error Handling

### Chunk Timeout

**Destination detects missing chunks:**
```lua
-- Check for stale import sessions
function AsyncProcessor.check_import_sessions()
    local now = game.tick
    for session_key, session in pairs(storage.chunked_imports) do
        local age = now - (session.last_activity or session.started_tick)
        if age > 600 then  -- 10 seconds at 60 UPS
            storage.chunked_imports[session_key] = nil
            game.print(string.format(
                "[Import Error] Session timeout: %s",
                session.platform_name
            ), {1, 0, 0})

            -- Notify controller of failure
            clusterio_api.send_json("surface_transfer_failed", {
                platform_name = session.platform_name,
                error = "Chunk timeout"
            })
        end
    end
end
```

### Export Failure

**Async export job fails:**
```lua
-- If export fails during processing
if not entity or not entity.valid then
    storage.async_jobs[job_id] = nil
    storage.async_job_results[job_id] = {
        status = "error",
        error_message = "Invalid entity during export"
    }

    game.print(string.format(
        "[Export Error] Failed to export %s",
        job.platform_name
    ), {1, 0, 0})

    -- Unlock platform
    unlock_platform_surface(job.platform_name)
end
```

### Import Failure

**Async import job fails:**
```lua
-- If import fails during processing
local function complete_import_job(job)
    if not job.target_surface or not job.target_surface.valid then
        game.print(string.format(
            "[Import Error] Surface invalid for %s",
            job.platform_name
        ), {1, 0, 0})

        storage.async_job_results[job.job_id] = {
            status = "error",
            error_message = "Surface became invalid"
        }

        -- Notify source to unlock
        clusterio_api.send_json("surface_transfer_failed", {
            platform_name = job.platform_name,
            error = "Surface became invalid"
        })

        return
    end

    -- Normal completion path...
end
```

### Network Disconnection

**Instance loses connection during transfer:**
```javascript
// instance.js
async onControllerConnectionEvent(event) {
    if (event === "drop" || event === "close") {
        this.logger.warn("Lost connection to controller during potential transfer");

        // Queue pending operations for retry
        // Transfers will be retried when connection resumes
    }

    if (event === "resume") {
        this.logger.info("Connection resumed, checking for incomplete transfers");
        // Check for locked platforms and resume or rollback
    }
}
```

---

## 10. Data Structures at Each Level

### Lua Module (Factorio)

```lua
-- Storage tables
storage = {
    -- Locked platforms during transfer
    locked_platforms = {
        [platform_name] = {
            original_schedule = {...},
            original_hidden = false,
            locked_tick = 12345678,
            platform_index = 1,
            surface_index = 42,
            force_name = "player"
        }
    },

    -- Async export/import jobs
    async_jobs = {
        [job_id] = {
            type = "export" | "import",
            job_id = "export_42",
            platform_name = "Platform Name",
            force_name = "player",
            requester = "TRANSFER",
            started_tick = 12345678,

            -- Export fields
            entities = {LuaEntity1, LuaEntity2, ...},
            total_entities = 500,
            current_index = 250,
            export_data = {...},

            -- Import fields
            platform_data = {...},
            target_surface = LuaSurface,
            tiles_to_place = {...},
            tiles_placed = true,
            entities_to_create = {...},
        }
    },

    -- Completed exports
    platform_exports = {
        [export_id] = {
            data = {...},           -- Full export data
            json_string = "...",    -- Serialized JSON
            platform_name = "Platform Name",
            platform_index = 1,
            force_name = "player",
            tick = 12345678,
            stats = {
                entities = 500,
                items = 10000,
                fluids = 5000,
                size_kb = 2456
            }
        }
    },

    -- Chunked import sessions
    chunked_imports = {
        [session_key] = {
            platform_name = "Platform Name",
            force_name = "player",
            total_chunks = 150,
            chunks = {
                [1] = "chunk1_data",
                [2] = "chunk2_data",
                ...
            },
            received_count = 100,
            started_tick = 12345678,
            last_activity = 12345700
        }
    },

    -- Job results
    async_job_results = {
        [job_id] = {
            status = "complete" | "error",
            complete = true,
            type = "export" | "import",
            job_id = "import_42",
            platform_name = "Platform Name",
            total_entities = 500,
            duration_ticks = 600,
            duration_seconds = 10.0,
            progress = 100,
            requester = "TRANSFER",
            error_message = nil
        }
    }
}
```

### Instance Plugin (Node.js)

```javascript
// In-memory state (minimal, as operations are stateless)
class InstancePlugin {
    // No persistent transfer state - all operations are request/response
    // or event-driven via IPC with Lua module
}
```

### Controller Plugin (Node.js)

```javascript
// controller.js:29
this.platformStorage = new Map();

// Entry structure:
platformStorage.set(exportId, {
    exportId: "Platform Name_12345678_export_42",
    platformName: "Platform Name",
    instanceId: 1,                // Source instance
    exportData: {
        schema_version: "1.0.0",
        factorio_version: "2.0",
        export_timestamp: 12345678,
        platform: {
            name: "Platform Name",
            force: "player",
            index: 1,
            surface_index: 42,
            schedule: {...},
            paused: false
        },
        metadata: {
            total_entity_count: 500,
            total_tile_count: 100,
            total_item_count: 10000,
            total_fluid_volume: 5000,
            verification_hash: "abc123def"
        },
        entities: [...],
        tiles: [...],
        verification: {
            item_counts: {...},
            fluid_counts: {...}
        }
    },
    timestamp: 1705680234567,
    size: 2456789  // Bytes
});
```

### Persistent Storage (File)

**Location:** `{controller.database_directory}/surface_export_storage.json`

**Format:**
```json
[
    {
        "exportId": "Platform Name_12345678_export_42",
        "platformName": "Platform Name",
        "instanceId": 1,
        "exportData": {
            "schema_version": "1.0.0",
            "factorio_version": "2.0",
            "export_timestamp": 12345678,
            "platform": {
                "name": "Platform Name",
                "force": "player",
                "index": 1,
                "surface_index": 42
            },
            "metadata": {
                "total_entity_count": 500,
                "total_tile_count": 100,
                "total_item_count": 10000,
                "total_fluid_volume": 5000,
                "verification_hash": "abc123def"
            },
            "entities": [...],
            "tiles": [...],
            "verification": {
                "item_counts": {
                    "iron-plate": 500,
                    "copper-plate": 300
                },
                "fluid_counts": {
                    "crude-oil": 1000.5
                }
            }
        },
        "timestamp": 1705680234567,
        "size": 2456789
    }
]
```

---

## 11. Message Sequence Diagrams

### Complete Transfer Flow

```
┌──────────────┐   ┌──────────────┐   ┌────────────┐   ┌──────────────┐   ┌──────────────┐
│ User/Control │   │ Source Inst  │   │ Controller │   │  Dest Inst   │   │  Dest Lua    │
└──────┬───────┘   └──────┬───────┘   └─────┬──────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │                  │                  │
       ├─Transfer Cmd────>│                  │                  │                  │
       │  (exportId,      │                  │                  │                  │
       │   destInstId)    │                  │                  │                  │
       │                  │                  │                  │                  │
       │                  ├─Lock Surface─────┤                  │                  │
       │                  │  (hide, stop)    │                  │                  │
       │                  │                  │                  │                  │
       │                  ├─Export (async)───┤                  │                  │
       │                  │  (batch 50/tick) │                  │                  │
       │                  │                  │                  │                  │
       │                  ├─PlatformExport──>│                  │                  │
       │                  │  Event           │                  │                  │
       │                  │                  ├─Store Export     │                  │
       │                  │                  │  (Map + disk)    │                  │
       │                  │                  │                  │                  │
       │                  │                  ├─TransferRequest─>│                  │
       │                  │                  │  (exportData)    │                  │
       │                  │                  │                  │                  │
       │                  │                  │                  ├─Chunk 1─────────>│
       │                  │                  │                  ├─Chunk 2─────────>│
       │                  │                  │                  ├─...              │
       │                  │                  │                  ├─Chunk 150───────>│
       │                  │                  │                  │                  │
       │                  │                  │                  │<─Reassemble─────┤
       │                  │                  │                  │  (concat)        │
       │                  │                  │                  │<─Queue Import───┤
       │                  │                  │                  │  (job_id)        │
       │                  │                  │                  │                  │
       │                  │                  │                  │<─Import (async)─┤
       │                  │                  │                  │  (batch 50/tick)│
       │                  │                  │                  │                  │
       │                  │                  │                  │<─Validate───────┤
       │                  │                  │                  │  (item counts)   │
       │                  │                  │                  │                  │
       │                  │                  │<─ValidationEvent─┤                  │
       │                  │                  │  (success=true)  │                  │
       │                  │                  │                  │                  │
       │                  │<─DeletePlatform──┤                  │                  │
       │                  │  (cleanup source)│                  │                  │
       │                  │                  │                  │                  │
       │<─TransferSuccess─┤                  │                  │                  │
       │  (completed)     │                  │                  │                  │
       │                  │                  │                  │                  │
```

### Failure with Rollback

```
┌──────────────┐   ┌──────────────┐   ┌────────────┐   ┌──────────────┐   ┌──────────────┐
│ User/Control │   │ Source Inst  │   │ Controller │   │  Dest Inst   │   │  Dest Lua    │
└──────┬───────┘   └──────┬───────┘   └─────┬──────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │                  │                  │
       ├─Transfer Cmd────>│                  │                  │                  │
       │                  ├─Lock Surface─────┤                  │                  │
       │                  ├─Export (async)───┤                  │                  │
       │                  ├─PlatformExport──>│                  │                  │
       │                  │                  ├─TransferRequest─>│                  │
       │                  │                  │                  ├─Chunks─────────>│
       │                  │                  │                  │<─Import (async)─┤
       │                  │                  │                  │                  │
       │                  │                  │                  │<─Validate───────┤
       │                  │                  │                  │  (MISMATCH!)     │
       │                  │                  │                  │                  │
       │                  │                  │<─ValidationEvent─┤                  │
       │                  │                  │  (success=false) │                  │
       │                  │                  │                  │                  │
       │                  │<─RollbackCmd─────┤                  │                  │
       │                  │                  │                  │                  │
       │                  ├─Unlock Surface───┤                  │                  │
       │                  │  (restore state) │                  │                  │
       │                  │                  │                  │                  │
       │                  │                  │                  ├─DeletePlatform──>│
       │                  │                  │                  │  (destroy dest)  │
       │                  │                  │                  │                  │
       │<─TransferFailed──┤                  │                  │                  │
       │  (rolled back)   │                  │                  │                  │
       │                  │                  │                  │                  │
```

---

## 12. Key Responsibilities by Component

### Lua Module (Factorio)

**Export Operations:**
- Lock surfaces during transfer (hide + stop deliveries)
- Serialize entities, tiles, inventories, fluids asynchronously
- Generate verification checksums
- Store completed exports in memory
- Notify Clusterio via IPC when export completes

**Import Operations:**
- Receive and reassemble RCON chunks
- Create new platforms with starter packs
- Place tiles and entities asynchronously
- Restore entity state, inventories, equipment grids
- Validate item/fluid counts
- Notify Clusterio when import completes

**State Management:**
- Track locked platforms
- Manage async jobs (export/import)
- Handle chunked import sessions
- Store job results for polling

### Instance Plugin (Node.js)

**Export Bridge:**
- Initiate exports via RCON
- Retrieve completed export data from Lua
- Send export data to controller

**Import Bridge:**
- Receive import requests from controller
- Chunk large JSON payloads (100KB default)
- Send chunks via RCON with hybrid escaping
- Monitor import progress

**Connection Handling:**
- Handle controller disconnections
- Queue operations for retry on reconnect

### Controller Plugin (Node.js)

**Storage Management:**
- Store platform exports in memory (Map)
- Persist exports to disk (JSON file)
- Clean up old exports (LRU, max_storage_size)

**Transfer Coordination:**
- Route transfer requests between instances
- Validate instance availability
- Track transfer status

**Persistence:**
- Save exports to `{database_directory}/surface_export_storage.json`
- Load exports on controller startup
- Auto-save on export reception

---

## 13. Configuration

### Instance-Level Settings

**`surface_export.max_export_cache_size`**
- Type: `number`
- Default: `10`
- Description: Maximum number of platform exports to cache per instance (in Lua memory)
- Impact: Higher = more memory usage, but can handle more concurrent operations

### Controller-Level Settings

**`surface_export.max_storage_size`**
- Type: `number`
- Default: `100`
- Description: Maximum number of platform exports to store on controller (all instances)
- Impact: Higher = more disk usage and memory, but keeps more transfer history

### Factorio Settings (Global)

**`factorio-surface-export-batch-size`**
- Type: `number`
- Default: `50`
- Description: Entities to process per tick during async export/import
- Impact:
  - Lower = smoother UPS, longer transfers
  - Higher = faster transfers, potential UPS drops

**`factorio-surface-export-show-progress`**
- Type: `boolean`
- Default: `true`
- Description: Show progress messages during export/import
- Impact: Visual feedback vs. chat spam

---

## Summary

The surface_export plugin orchestrates complex multi-phase platform transfers between Factorio instances:

1. **Safety First:** Locks source surface to prevent modifications during export
2. **Async Processing:** Exports and imports run over multiple ticks (50 entities/tick) to avoid UPS drops
3. **Chunking:** Large platform data (>100KB) is split into chunks for RCON transmission
4. **Verification:** Item and fluid counts are validated after import to detect corruption
5. **Rollback:** Failed transfers unlock source platform and destroy incomplete destination platform
6. **Cleanup:** Successful transfers delete source platform and optionally clean up controller storage

**Key Differences from inventory_sync:**
- **No Distributed Locking:** Platforms are transferred completely (not shared between instances)
- **Async Operations:** Exports/imports can take many ticks (unlike inventory_sync which is near-instant)
- **Larger Payloads:** Platform data can be 10+ MB (vs. <100KB for player inventories)
- **Chunking Required:** Most platforms require chunking due to RCON limits
- **Validation Critical:** Item count validation detects serialization bugs or mod conflicts

**Performance Characteristics:**
- **Export Speed:** ~50 entities/tick = 3000 entities/second at 60 UPS
- **Transfer Speed:** ~100KB chunks = depends on network latency between controller and instance
- **Import Speed:** ~50 entities/tick = 3000 entities/second at 60 UPS
- **Total Time:** 1000-entity platform = ~20 seconds (10s export + 10s import, assuming fast network)

This architecture enables safe, reliable platform transfers across distributed Factorio servers while maintaining game performance and data integrity.
