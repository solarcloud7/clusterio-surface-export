# Clusterio Surface Export Plugin

This plugin enables exporting and importing Factorio space platforms across Clusterio servers.

## Installation

### 1. Install Clusterio

```bash
npm install -g @clusterio/ctl @clusterio/controller @clusterio/host
```

### 2. Initialize Clusterio

```bash
# Create directories
mkdir -p clusterio-data/{controller,instances,plugins}

# Initialize controller
cd clusterio-data/controller
clusteriocontroller init
clusteriocontroller bootstrap create-admin your-username

# Initialize host
cd ../instances
clusteriohost init
```

### 3. Install Plugin

```bash
# Link the plugin
cd clusterio-data/plugins
ln -s ../../clusterio-plugin surface_export

# Install plugin dependencies
cd surface_export
npm install
```

### 4. Configure Clusterio

Edit `clusterio-data/controller/config.json`:
```json
{
  "plugins": {
    "surface_export": {
      "enabled": true
    }
  }
}
```

## Usage

### Via RCON (on Factorio server):

```lua
-- Export platform 1
/export-platform 1

-- List exports
/list-exports

-- Import platform
/import-platform platform_Alpha_12345
```

### Via Clusterio Plugin (from controller):

```javascript
// Export platform
await instance.sendTo("surface_export:export_platform", {
  platformIndex: 1,
  forceName: "player"
});

// List exports on instance
const exports = await instance.sendTo("surface_export:list_exports");

// Get specific export
const exportData = await instance.sendTo("surface_export:get_export", {
  exportId: "Alpha_12345"
});
```

## Docker Setup

Use the provided `docker-compose.clusterio.yml`:

```bash
# Start Clusterio cluster
docker-compose -f docker/docker-compose.clusterio.yml up -d

# View logs
docker logs clusterio-controller
docker logs clusterio-instance-1

# Access web UI
# Open http://localhost:8080
```

## Development

The plugin has two components:

- **instance.js**: Runs on each Factorio server instance
  - Handles export/import commands
  - Communicates with Factorio via RCON
  
- **controller.js**: Runs on Clusterio master
  - Stores exported platform data
  - Routes platforms between instances

## API

### Instance Commands

- `exportPlatformCommand(platformIndex, forceName)` - Export a platform
- `listExportsCommand()` - List available exports on this instance
- `getExportCommand(exportId)` - Get specific export data

### Controller Storage

- `storePlatformExport(instanceId, exportData)` - Store platform from instance
- `listStoredExports()` - List all stored platforms
- `getStoredExport(key)` - Retrieve platform for import
