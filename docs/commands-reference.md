# Commands Reference

Console commands for debugging and manual control of platform export/import functionality. These commands run in-game via the chat console or remotely via RCON. They are registered in [`module/interfaces/commands/`](../docker/seed-data/external_plugins/surface_export/module/interfaces/commands/).

For the `clusterioctl surface-export` CLI subcommands (`list`, `get-export`, `upload-import`, `start-transfer`, `transfer`), see the Remote Interface and CLI sections of [README.md](README.md). For the Lua `remote.call("surface_export", ...)` API, see the Remote Interface section of [README.md](README.md).

## Table of Contents

- [Quick Reference](#quick-reference)
- [Platform Listing Commands](#platform-listing-commands)
- [Export Commands](#export-commands)
- [Transfer Commands](#transfer-commands)
- [Platform Lock Commands](#platform-lock-commands)
- [Debug Commands](#debug-commands)
- [Command Context](#command-context)
- [See Also](#see-also)

## Quick Reference

All commands except `/plugin-import-file` require admin privileges. `[param]` is optional, `<param>` is required.

| Command | Arguments | Description |
|---------|-----------|-------------|
| `/list-platforms` | — | List space platforms for your force |
| `/list-surfaces` | — | List all surfaces with their indices |
| `/list-exports` | — | List exports held in memory |
| `/export-platform` | `[platform_index] [destination_instance_id]` | Export a platform to JSON (async) |
| `/export-platform-file` | `[platform_index]` | Export a platform to a JSON file on disk (async) |
| `/export-sync-mode` | `[on\|off]` | Toggle synchronous export mode |
| `/transfer-platform` | `<platform_index> <destination_instance_id>` | Transfer a platform to another instance |
| `/gateway-transfer` | `<platform_index> <destination_instance_id>` | Transfer a platform parked at a gateway |
| `/gateway-gui` | `<platform_index>` | Open the destination chooser for a platform parked at a gateway |
| `/resume-platform` | `<platform_name_or_index>` | Unpause a platform and activate its entities |
| `/lock-platform` | `[platform_name_or_index]` | Lock a platform (complete cargo pods, freeze entities) |
| `/unlock-platform` | `[platform_name_or_index]` | Unlock a locked platform |
| `/lock-status` | `[platform_name]` | Show status of locked platforms |
| `/step-tick` | `[count]` | Unpause the game tick; `count` is currently accepted but ignored |
| `/plugin-import-file` | `<filename> [new_name]` | Request the plugin to import a platform from a file (no admin) |
| `/test-entity` | `<json>` | Import a single entity from JSON for debugging |
| `/test-entity-at` | `<x> <y> <json>` | Import a single entity at a specific position |
| `/transaction-dashboard` | `[limit]` | Open the in-game transaction history GUI |

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
  [1] Test Platform_12345678 (47 entities, <ISO-8601 timestamp>)
  [2] Mining Station_12340000 (123 entities, <ISO-8601 timestamp>)
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
Export queued: Test Platform_12345678
File will be written when export completes (check logs)
```

**Notes:**
- Async operation — the file is written when the export job completes
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

### `/gateway-transfer`
Transfer a platform that is parked (`waiting_at_station`) at a `surfexp_gateway_*` location.

**Usage:**
```
/gateway-transfer <platform_index> <destination_instance_id>
```

The destination copy is parked at the same gateway name. This explicit command does not require a saved web-UI link, but the source platform must already be waiting at a gateway.

---

### `/gateway-gui`
Open the in-game destination chooser for a platform parked at a gateway.

**Usage:**
```
/gateway-gui <platform_index>
```

This command must be run by a player. The chooser lists the destination links configured for that source instance and gateway in the web UI. If no links exist, it prints the configuration hint instead of opening an empty window.

---

### `/resume-platform`
Unpause a platform's space travel.

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
✓ Platform 'test' space travel RESUMED
```

**Notes:**
- Unpauses platform space travel (`platform.paused = false`)
- Does not affect entity active states — use `/unlock-platform` for that

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
Unpause the game tick (debug utility).

**Usage:**
```
/step-tick [count]
```

**Output:**
```
Game unpaused at tick 12345
```

**Notes:**
- Sets `game.tick_paused = false` if the game is paused; otherwise prints "Game is already running"
- Useful if the game gets stuck in a paused state during debugging
- The optional `count` is present in the registered command help but is currently ignored; the command only unpauses the game

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
- Plugin reads file and sends data via the Clusterio `send_json` event channel

---

### `/test-entity`
Import a single entity from JSON for debugging.

**Usage:**
```
/test-entity <json>
```

**Parameters:**
- `json` (required): A serialized entity (e.g. `{"name":"iron-chest","position":{"x":0,"y":0}}`)

**Examples:**
```
/test-entity {"name":"iron-chest","position":{"x":0,"y":0}}
```

**Output:**
```
═══════════════════════════════════════
🧪 Entity Test Result
═══════════════════════════════════════
✓ SUCCESS - Entity created!

Created Entity:
  Name: iron-chest
  Position: {x = 0, y = 0}
  Unit Number: 123
...
```

**Notes:**
- Creates the entity on your current surface via `remote.call("surface_export", "test_import_entity", ...)`
- Reports success/failure plus errors, warnings, and debug info (prototype type, placement check)
- A `file:<filename>` prefix is recognized but not supported in-game — it prints a note to pass the JSON via RCON or the remote interface instead

---

### `/test-entity-at`
Import a single entity at a specific position.

**Usage:**
```
/test-entity-at <x> <y> <json>
```

**Parameters:**
- `x` (required): Target X coordinate
- `y` (required): Target Y coordinate
- `json` (required): A serialized entity

**Examples:**
```
/test-entity-at 5 -3 {"name":"iron-chest"}
```

**Output:**
```
✓ Created iron-chest at {5, -3}
```

**Notes:**
- Same as `/test-entity` but overrides the position with the given coordinates
- Prints a condensed result (one line on success, errors/warnings on failure)

---

### `/transaction-dashboard`
Open the in-game transaction history dashboard (import/export/transfer history with phase timing).

**Usage:**
```
/transaction-dashboard [limit]
```

**Parameters:**
- `limit` (optional): Number of entries to show, 1–500. Default: 25

**Examples:**
```
/transaction-dashboard
/transaction-dashboard 100
```

**Notes:**
- Player-only — running it from the console/RCON prints an error ("can only be run by a player")
- Opens a GUI; `limit` outside the 1–500 range is rejected with a usage message

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

- [README.md](README.md) — Remote Interface (Lua `remote.call` API) and `clusterioctl surface-export` CLI commands
- [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) — Module structure and Factorio 2.0 compatibility
- [async-processing.md](async-processing.md) — How async export/import works
