# Development Setup - Running Surface Export Plugin

This guide explains how to run and test the Surface Export plugin in the Clusterio development environment.

## Prerequisites

- Node.js >= 18
- pnpm package manager
- Factorio 2.0.x installed

## Plugin Structure

The Surface Export plugin is configured as an **external plugin** using **save-patched modules**:

```
external_plugins/surface-export/
├── index.js              # Plugin definition
├── controller.js         # Controller logic
├── instance.js           # Instance logic
├── control.js            # Control interface
├── ctl.js                # CLI commands
├── messages.js           # Message definitions
├── module/               # Lua module (save-patched)
│   ├── module.json       # Module metadata
│   ├── control.lua       # Main Lua entry point
│   ├── core/             # Core processing logic
│   ├── interfaces/       # Commands & remote interface
│   ├── utils/            # Utilities (locking, etc.)
│   ├── validators/       # Transfer validation
│   └── scanners/         # Entity scanning
└── docs/                 # Documentation
```

## Setup Instructions

### 1. Build Clusterio

From the root directory:

```bash
pnpm install
pnpm build
```

### 2. Configure Controller

Initialize controller config if not already done:

```bash
npx clusteriocontroller config set controller.name "Development Cluster"
npx clusteriocontroller config set controller.http_port 8080
```

The plugin is automatically discovered via the `external_plugins/` workspace.

### 3. Configure Host

Initialize host config:

```bash
npx clusteriohost config set host.name "Development Host"
npx clusteriohost config set host.controller_url "http://localhost:8080"
npx clusteriohost config set host.factorio_directory "C:/path/to/factorio"
```

### 4. Start Clusterio

Start the controller:

```bash
npx clusteriocontroller run
```

In a separate terminal, start the host:

```bash
npx clusteriohost run
```

### 5. Create Test Instances

```bash
npx clusterioctl instance create "Instance 1"
npx clusterioctl instance create "Instance 2"
```

Assign instances to the host:

```bash
npx clusterioctl instance assign "Instance 1" "Development Host"
npx clusterioctl instance assign "Instance 2" "Development Host"
```

Start the instances:

```bash
npx clusterioctl instance start "Instance 1"
npx clusterioctl instance start "Instance 2"
```

## Testing the Plugin

### Verify Plugin Loaded

Check controller logs for:
```
Loaded plugin surface_export
```

Check instance logs for:
```
[Surface Export] Clusterio module initialized
```

### Test Commands

Connect to Instance 1 in Factorio and run:

```lua
-- List available platforms
/list-platforms

-- Export a platform (creates a platform first if needed)
/export-platform 1

-- Transfer platform to Instance 2
/transfer-platform 1 2
```

### Expected Workflow

1. **Lock Phase**: Platform hidden from players
2. **Export Phase**: Async export with progress messages
3. **Transfer Phase**: Sent to controller → forwarded to Instance 2
4. **Import Phase**: Async import on Instance 2
5. **Validation Phase**: Item/fluid counts compared
6. **Cleanup Phase**: Source deleted on success, unlocked on failure

### Status Messages

Both instances will see synchronized status updates:

**On Instance 1 (source):**
```
[Transfer: Platform Name] Validation passed ✓
[Transfer: Platform Name] Deleting source platform...
[Transfer: Platform Name] Transfer complete! Source deleted, destination validated ✓
```

**On Instance 2 (destination):**
```
[Import Platform Name] Progress: 50% (261/523 entities)
[Import Complete] Platform Name (523 entities in 10.5s)
[Transfer: Platform Name] Validation passed ✓
[Transfer: Platform Name] Transfer complete! Source deleted, destination validated ✓
```

## Development Workflow

### Hot Reload (Save-Patched Modules)

The Lua module is automatically patched into saves when instances start. To test changes:

1. Edit files in `module/`
2. Restart the Factorio instance (or reload the save)
3. The new code will be patched in automatically

**No build step required for Lua modules!**

### Node.js Code Changes

For changes to `controller.js`, `instance.js`, `ctl.js`:

1. Stop the controller/host
2. Run `pnpm build` (if TypeScript is involved)
3. Restart controller/host

## Troubleshooting

### Plugin Not Discovered

**Symptom:** Controller logs show "Plugin not found"

**Solution:** Verify `package.json` has the `"clusterio-plugin"` keyword:

```json
"keywords": [
    "clusterio",
    "clusterio-plugin",
    "factorio"
]
```

### Lua Module Not Loading

**Symptom:** No "[Surface Export] Clusterio module initialized" message

**Solutions:**
- Check `module/module.json` has correct `name` and `load` fields
- Verify `control.lua` exists and has no syntax errors
- Check instance logs for Lua errors

### Transfer Validation Failing

**Common Causes:**
1. **Different mods**: Source and destination must have identical mods
2. **Items consumed**: Fuel burned during transfer
3. **Platform modified**: Someone edited platform during transfer

**Check Logs:**
```
[Transfer Validation Failed] Item count mismatch: iron-plate: expected 500, got 450
```

### RCON Connection Issues

**Symptom:** "Failed to send RCON command"

**Solutions:**
- Verify Factorio instance is running
- Check RCON is enabled in instance config
- Verify RCON password is set correctly

## CLI Testing

Test the clusterioctl commands:

```bash
# List stored exports
npx clusterioctl surface-export list

# Transfer an export
npx clusterioctl surface-export transfer <exportId> <targetInstanceId>
```

## Performance Testing

### Small Platform (100 entities)
- Export: ~2 seconds
- Transfer: ~1 second
- Import: ~2 seconds
- Total: ~5 seconds

### Large Platform (10000 entities)
- Export: ~3 minutes
- Transfer: ~30 seconds
- Import: ~3 minutes
- Total: ~7 minutes

**UPS Impact:** <1% drop during transfer (async processing at 50 entities/tick)

## Next Steps

1. Create test platforms with various entity types
2. Test with different mod configurations
3. Test failure scenarios (validation failures, network interruptions)
4. Verify rollback mechanism works correctly
5. Test with multiple simultaneous transfers

## Additional Resources

- [Quick Start Guide](QUICK_START.md) - User-facing guide
- [Surface Transfer Flow](SURFACE_TRANSFER_FLOW.md) - Technical documentation
- [Clusterio Plugin Development](../../docs/writing-plugins.md) - Official guide
