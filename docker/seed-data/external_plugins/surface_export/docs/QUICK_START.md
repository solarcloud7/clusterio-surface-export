# Surface Export Plugin - Quick Start Guide

## One-Command Platform Transfer

The simplest way to transfer a platform between instances:

### 🚀 In-Game Command (Recommended)

```lua
/transfer-platform <platform_index> <destination_instance_id>
```

**Example:**
```lua
/transfer-platform 1 2
```

This single command:
1. ✅ Locks the platform (hides from players)
2. ✅ Exports asynchronously (non-blocking)
3. ✅ Sends to controller automatically
4. ✅ Transfers to destination instance
5. ✅ Validates item/fluid counts
6. ✅ Deletes source on success OR unlocks on failure

---

### 📋 Step-by-Step Example

#### 1. Find Your Platform Index

```lua
/list-platforms
```

**Output:**
```
Found 2 platform(s):
  [1] Mining Outpost Alpha (Force: player, Entities: 523)
  [2] Defense Station Beta (Force: player, Entities: 234)
```

#### 2. Transfer Platform

```lua
/transfer-platform 1 2
```

**Output:**
```
═══════════════════════════════════════
🚀 Transfer Platform: Mining Outpost Alpha
═══════════════════════════════════════
Source: Instance 1 (this instance)
Destination: Instance 2
Platform: [1] Mining Outpost Alpha

[1/3] Locking platform...
✓ Platform locked (hidden from players)
[2/3] Queueing export...
✓ Export queued: export_42
⏳ Exporting asynchronously (this may take a while)...

The transfer will continue automatically:
  1. Export completes → Sent to controller
  2. Controller → Sends to destination instance
  3. Destination imports → Validates counts
  4. On success → Source deleted automatically
  5. On failure → Source unlocked automatically

💡 Use /list-platforms to track progress
═══════════════════════════════════════
```

#### 3. Monitor Progress

**Watch in-game messages:**
```
[Export Mining Outpost Alpha] Progress: 50% (261/523 entities)
[Export Complete] Mining Outpost Alpha (523 entities in 10.5s)
```

**On destination instance (Instance 2):**
```
[Import Mining Outpost Alpha] Progress: 50% (261/523 entities)
[Import Complete] Mining Outpost Alpha (523 entities in 10.5s)
[Transfer] Platform 'Mining Outpost Alpha' transferred successfully
```

**On source instance (Instance 1):**
```
[Transfer Complete] Platform 'Mining Outpost Alpha' transferred and deleted from source
```

#### 4. Verify Transfer

**On Instance 2:**
```lua
/list-platforms
```

**Output:**
```
Found 1 platform(s):
  [1] Mining Outpost Alpha (Force: player, Entities: 523)  ← Transferred!
```

**On Instance 1:**
```lua
/list-platforms
```

**Output:**
```
Found 1 platform(s):
  [2] Defense Station Beta (Force: player, Entities: 234)  ← Mining Outpost deleted
```

---

## Alternative: Via clusterioctl

If you prefer command-line control:

### 1. Export Platform

**In-game:**
```lua
/export-platform 1
```

**Wait for completion:**
```
[Export Complete] Mining Outpost Alpha (523 entities in 10.5s) - ID: Mining Outpost Alpha_12345678_export_42
```

### 2. List Exports

```bash
npx clusterioctl surface-export list
```

**Output:**
```
Found 1 export(s):

Export ID                              | Platform Name          | Instance | Size
-------------------------------------- | ---------------------- | -------- | --------
Mining Outpost Alpha_12345678_export_42 | Mining Outpost Alpha   | 1        | 2.45 MB
```

### 3. Transfer to Destination

```bash
npx clusterioctl surface-export transfer "Mining Outpost Alpha_12345678_export_42" 2
```

**Output:**
```
[info] Transferring platform Mining Outpost Alpha_12345678_export_42 to instance 2...
[info] ✓ Transfer initiated: transfer_1705680234567_abc123
[info] Monitor logs for validation and completion
```

---

## What Happens During Transfer?

### 🔒 Phase 1: Lock (Instant)
- Platform hidden from players (`force.set_surface_hidden(true)`)
- Cargo pod deliveries wait to complete
- Original state saved for rollback

### 📤 Phase 2: Export (~10-60 seconds)
- Async processing: 50 entities/tick (3000/second at 60 UPS)
- Minimal UPS impact (<1% drop)
- Progress shown every 10 batches
- Item/fluid counts calculated for verification

### 📨 Phase 3: Transfer (~1-10 seconds)
- Export sent to controller
- Controller stores and tracks transfer
- Data chunked into 100KB pieces
- Chunks sent via RCON to destination

### 📥 Phase 4: Import (~10-60 seconds)
- Async processing: 50 entities/tick
- Tiles placed first
- Entities created with full state
- Inventories, equipment grids restored

### ✅ Phase 5: Validation (Instant)
- Item counts compared (exact match required)
- Fluid volumes compared (0.1 tolerance)
- Success → Delete source automatically
- Failure → Unlock source automatically

---

## Troubleshooting

### "Platform not found"

**Check platform index:**
```lua
/list-platforms
```

Platform indices change when platforms are deleted. Always check before transferring.

### "Clusterio not available"

**Verify plugin loaded:**
```lua
/sc rcon.print(remote.interfaces["FactorioSurfaceExport"] ~= nil)
```

Should print `true`. If `false`, the plugin module didn't load.

**Check logs for:**
```
[Surface Export] Clusterio module initialized
```

### "Lock failed: Timeout waiting for cargo pods"

Wait for cargo pods to finish delivery before transferring:
```lua
/sc local pods = game.player.surface.find_entities_filtered({name = "cargo-pod"});
    game.print(#pods .. " cargo pods pending")
```

Wait until 0 pods, then retry transfer.

### "Validation failed"

**Common causes:**
1. **Different mods** - Source and destination must have identical mods
2. **Items consumed** - Fuel burned in furnaces during transfer
3. **Platform modified** - Someone edited platform during transfer (lock failed)

**Check logs for details:**
```
[Transfer Validation Failed] Item count mismatch: iron-plate: expected 500, got 450
```

---

## Performance Guidelines

### Small Platform (100 entities)
- **Export**: ~2 seconds
- **Transfer**: ~1 second
- **Import**: ~2 seconds
- **Total**: ~5 seconds

### Medium Platform (1000 entities)
- **Export**: ~20 seconds
- **Transfer**: ~5 seconds
- **Import**: ~20 seconds
- **Total**: ~45 seconds

### Large Platform (10000 entities)
- **Export**: ~3 minutes
- **Transfer**: ~30 seconds
- **Import**: ~3 minutes
- **Total**: ~7 minutes

**UPS Impact:** <1% drop during transfer (async processing)

---

## Best Practices

### ✅ DO:
- Use `/transfer-platform` for one-command simplicity
- Check platform index with `/list-platforms` first
- Wait for cargo pods to complete before transferring
- Ensure identical mods on source and destination
- Monitor logs during large transfers

### ❌ DON'T:
- Transfer platforms with pending cargo pods
- Modify platforms during active transfers
- Transfer between instances with different mod lists
- Transfer during high server activity (plan maintenance windows)

---

## Summary

**Simplest workflow:**
```lua
1. /list-platforms              -- Find platform index
2. /transfer-platform 1 2       -- Transfer platform 1 to instance 2
3. Wait for completion          -- Fully automatic from here
```

**That's it!** The entire workflow (lock → export → transfer → import → validate → cleanup) happens automatically.

No manual steps needed beyond the initial command.
