# Commands Reference

Console commands for debugging and manual control of platform export/import functionality. These commands can be used in-game via the chat console or remotely via RCON.

## Quick Reference

```
/command-name [required_param] [optional_param]
```

All commands except `/plugin-import-file` require admin privileges.

---

## Platform Listing Commands

### `/list-platforms`
List all available space platforms for your force.

**Usage:**
```
/list-platforms
```

**Output:**
```
Found 2 platform(s):
  [1] Test Platform (Force: player, Entities: 47)
  [2] Mining Station (Force: player, Entities: 123)
```

**Notes:**
- Shows platform index (used by other commands)
- Displays entity count for each platform
- Works from chat or RCON

---

### `/list-surfaces`
List all surfaces with their indices.

**Usage:**
```
/list-surfaces
```

**Output:**
```
Found 5 surface(s):
  Surface 1: nauvis (Planet/Special)
  Surface 2: vulcanus (Planet/Special)
  Surface 3: platform-123456 (Space Platform)
  ...
```

**Notes:**
- Shows which surfaces are platforms vs planets
- Surface indices are internal Factorio IDs

---

### `/list-exports`
List available platform exports in memory.

**Usage:**
```
/list-exports
```

**Output:**
```
Found 2 export(s) in memory:
  [1] Test Platform_12345678 (47 entities, 2026-01-23T10:30:00Z)
  [2] Mining Station_12340000 (123 entities, 2026-01-23T09:15:00Z)
```

**Notes:**
- Lists exports from async export system
- Sorted by timestamp (newest first)

---

## Export Commands

### `/export-platform`
Export a platform to JSON asynchronously.

**Usage:**
```
/export-platform [platform_index] [destination_instance_id]
```

**Parameters:**
- `platform_index` (optional): 1-based platform index. If omitted, uses current platform
- `destination_instance_id` (optional): Clusterio instance ID to transfer to

**Examples:**
```
/export-platform              # Export current platform
/export-platform 1            # Export platform #1
/export-platform 1 2          # Export platform #1 and transfer to instance 2
```

**Output:**
```
Auto-detected platform: Test Platform (index 1)
Export queued: Test Platform_12345678 (processing async)
```

**Notes:**
- Player on platform can omit index parameter
- RCON requires platform index
- Use `/list-exports` to check export status

---

### `/export-platform-file`
Export a platform directly to a JSON file on disk.

**Usage:**
```
/export-platform-file [platform_index]
```

**Parameters:**
- `platform_index` (optional): 1-based platform index. If omitted, uses current platform

**Examples:**
```
/export-platform-file         # Export current platform to file
/export-platform-file 1       # Export platform #1 to file
```

**Output:**
```
Auto-detected platform: Test Platform (index 1)
Exporting platform 1 to file...
Export complete: platform_exports/Test Platform_12345678.json
File location: <factorio>/script-output/platform_exports/Test Platform_12345678.json
```

**Notes:**
- Synchronous operation (may cause brief lag for large platforms)
- File saved to `script-output/platform_exports/`

---

### `/export-sync-mode`
Toggle synchronous export mode for debugging.

**Usage:**
```
/export-sync-mode [on|off]
```

**Parameters:**
- `on|off` (optional): Enable or disable. If omitted, toggles current state

**Examples:**
```
/export-sync-mode             # Toggle mode
/export-sync-mode on          # Force sync mode on
/export-sync-mode off         # Force sync mode off
```

**Output:**
```
Sync mode: ON - All entities will be processed in single tick
```

**Notes:**
- Sync mode processes all entities in one tick (may cause lag)
- Useful for debugging timing issues
- Default: OFF (async processing)

---

## Transfer Commands

### `/transfer-platform`
Transfer a platform to another Clusterio instance.

**Usage:**
```
/transfer-platform <platform_index> <destination_instance_id>
```

**Parameters:**
- `platform_index` (required): 1-based platform index
- `destination_instance_id` (required): Target Clusterio instance ID

**Example:**
```
/transfer-platform 1 2
```

**Output:**
```
═══════════════════════════════════════
🚀 Transfer Platform: Test Platform
═══════════════════════════════════════
Destination: Instance 2
Platform: [1] Test Platform

[1/3] Locking platform...
✓ Platform locked (hidden from players)
[2/3] Queueing export...
✓ Export queued: Test Platform_12345678
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

**Notes:**
- Requires Clusterio to be running
- Platform is locked during transfer
- Automatically deleted on successful transfer
- Use `/list-platforms` to see available indices

---

### `/resume-platform`
Resume a paused platform after inspection.

**Usage:**
```
/resume-platform <platform_name_or_index>
```

**Parameters:**
- `platform_name_or_index` (required): Platform name or 1-based index

**Examples:**
```
/resume-platform test         # By name
/resume-platform 1            # By index
```

**Output:**
```
✓ Game tick UNPAUSED
✓ Platform 'test' space travel RESUMED
✓ Activated 47 entities on platform
```

**Notes:**
- Unpauses game tick if paused
- Unpauses platform space travel
- Reactivates all entities on platform

---

## Platform Lock Commands

### `/lock-platform`
Lock a platform for testing (completes cargo pods, freezes entities).

**Usage:**
```
/lock-platform [platform_name_or_index]
```

**Parameters:**
- `platform_name_or_index` (optional): Platform name or index. If omitted, uses current platform

**Examples:**
```
/lock-platform                # Lock current platform
/lock-platform test           # Lock by name
/lock-platform 1              # Lock by index
```

**Output:**
```
Using current platform: Test Platform
Platform 'Test Platform' locked successfully
  - Cargo pods completed and items recovered
  - Entity freezing started (check /lock-status for progress)
Use /unlock-platform Test Platform to unlock
```

**Notes:**
- Completes any in-progress cargo pods
- Freezes (deactivates) all entities
- Platform becomes hidden from players
- Use before export for consistent snapshots

---

### `/unlock-platform`
Unlock a locked platform (restores entities and visibility).

**Usage:**
```
/unlock-platform [platform_name_or_index]
```

**Parameters:**
- `platform_name_or_index` (optional): Platform name or index. If omitted, uses current platform

**Examples:**
```
/unlock-platform              # Unlock current platform
/unlock-platform test         # Unlock by name
/unlock-platform 1            # Unlock by index
```

**Output:**
```
Using current platform: Test Platform
Platform 'Test Platform' unlocked successfully
  - Entities restored to original active state
  - Surface visibility restored
```

**Notes:**
- Restores entities to their pre-lock active state
- Can unlock even if platform was deleted

---

### `/lock-status`
Show status of locked platforms.

**Usage:**
```
/lock-status [platform_name]
```

**Parameters:**
- `platform_name` (optional): Specific platform to check. If omitted, lists all

**Examples:**
```
/lock-status                  # List all locked platforms
/lock-status test             # Show details for 'test'
```

**Output (list all):**
```
Locked platforms:
  1. Test Platform (locked 45s ago, 47 entities frozen)
  2. Mining Station (locked 120s ago, 123 entities frozen)

Use /lock-status <platform_name> for details
Use /unlock-platform <name> to unlock
```

**Output (specific):**
```
Lock status for platform 'Test Platform':
  Platform index: 1
  Surface index: 3
  Force: player
  Locked for: 45 seconds (2700 ticks)
  Entities frozen: 47
  Originally hidden: false
```

---

## Debug Commands

### `/step-tick`
Advance the game by N ticks (for debugging paused imports).

**Usage:**
```
/step-tick [count]
```

**Parameters:**
- `count` (optional): Number of ticks to step (1-60). Default: 1

**Examples:**
```
/step-tick                    # Step 1 tick
/step-tick 10                 # Step 10 ticks
/step-tick 60                 # Step 60 ticks (1 second)
```

**Output:**
```
Stepping 10 tick(s) from tick 12345...
```

**Notes:**
- Maximum 60 ticks per command (1 second)
- Only works when game is paused (`game.tick_paused = true`)
- Useful for debugging async import processing

---

### `/plugin-import-file`
Request plugin to import a platform from a file.

**Usage:**
```
/plugin-import-file <filename> [new_name]
```

**Parameters:**
- `filename` (optional): File path relative to script-output. Default: `platform_exports/Strana Mechty_25494879.json`
- `new_name` (optional): New name for the imported platform

**Examples:**
```
/plugin-import-file platform_exports/test.json
/plugin-import-file platform_exports/test.json "New Platform"
```

**Output:**
```
Requesting plugin to import from file: platform_exports/test.json
New platform name: New Platform
✓ Request sent to plugin
Check logs for import status
```

**Notes:**
- Requires Clusterio plugin to be running
- Does NOT require admin (anyone can request import)
- Plugin reads file and sends data via IPC

---

## Command Context

All commands automatically handle:

1. **Admin Privileges** - Most commands require admin status
2. **Print Function** - Output works for both chat and RCON
3. **Error Handling** - Crashes are caught and logged
4. **Force Detection** - Uses player's force or defaults to "player"

### RCON Usage

Commands work via RCON but some require explicit parameters:

```bash
# RCON (must specify platform index)
/silent-command rcon.print(game.tick)
/export-platform 1

# In-game (can auto-detect current platform)
/export-platform
```

---

## See Also

- [Remote Interface Reference](remote-interface-reference.md) - Lua API for plugin integration
- [Architecture](architecture.md) - System design overview
- [Async Processing](async-processing.md) - How async export/import works

