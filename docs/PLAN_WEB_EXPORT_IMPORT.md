# Plan: Web UI Export Download & Upload Import

## Goal

Add two operator workflows to the Surface Export web UI:
1. **Download**: Download a stored export payload as a `.json` file from the browser.
2. **Upload + Import**: Upload a `.json` export file from disk and import it onto a chosen instance.

This plan is written for execution by an AI agent. Each step specifies exact file paths, anchors (line numbers / function names), code patterns to follow, and acceptance criteria.

---

## Prerequisites & Assumptions

- Cluster is running and reachable (`docker compose up -d`).
- Plugin web bundle builds with `npm run build:web` from `docker/seed-data/external_plugins/surface_export/`.
- Existing message class pattern is followed exactly (see any class in `messages.js`).
- Clusterio link protocol: messages between `control` (web UI / ctl) and `controller` travel over WebSocket. The `control.send(new MessageClass({...}))` pattern returns a promise of the Response. Max WebSocket frame is ~100MB by default in Clusterio, so payloads up to several MB are fine without chunking on the link layer — only RCON requires chunking.

---

## Step 1 — Message Definitions

**File**: `docker/seed-data/external_plugins/surface_export/messages.js`

### 1a. Add `GetStoredExportRequest`

Insert a new class **after** the existing `ListExportsRequest` class (currently ends around line 474). Follow the exact pattern of `ListExportsRequest` / `GetTransactionLogRequest`.

```js
class GetStoredExportRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "control";
    static dst = "controller";
    static permission = PERMISSIONS.LIST_EXPORTS;   // reuse existing permission
    static jsonSchema = {
        type: "object",
        properties: {
            exportId: { type: "string" },
        },
        required: ["exportId"],
        additionalProperties: false,
    };

    constructor(json) {
        this.exportId = json.exportId;
    }

    static fromJSON(json) {
        return new GetStoredExportRequest(json);
    }

    toJSON() {
        return { exportId: this.exportId };
    }

    static Response = {
        jsonSchema: {
            type: "object",
            properties: {
                success:      { type: "boolean" },
                error:        { type: "string" },
                exportId:     { type: "string" },
                platformName: { type: "string" },
                instanceId:   { type: "integer" },
                timestamp:    { type: "number" },
                size:         { type: "integer" },
                exportData:   { type: "object" },
            },
            required: ["success"],
        },
        fromJSON(json) { return json; },
    };
}
```

**Key details**:
- Permission: `PERMISSIONS.LIST_EXPORTS` — downloading is a read operation; no new permission needed.
- Response carries full `exportData` object so the browser can save it.

### 1b. Add `ImportUploadedExportRequest`

Insert immediately after `GetStoredExportRequest`.

```js
class ImportUploadedExportRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "control";
    static dst = "controller";
    static permission = PERMISSIONS.TRANSFER_EXPORTS;
    static jsonSchema = {
        type: "object",
        properties: {
            targetInstanceId: { type: "integer" },
            exportData:       { type: "object" },
            forceName:        { type: "string", default: "player" },
            platformName:     { type: "string" },
        },
        required: ["targetInstanceId", "exportData"],
        additionalProperties: false,
    };

    constructor(json) {
        this.targetInstanceId = json.targetInstanceId;
        this.exportData = json.exportData;
        this.forceName = json.forceName || "player";
        this.platformName = json.platformName || null;
    }

    static fromJSON(json) {
        return new ImportUploadedExportRequest(json);
    }

    toJSON() {
        return {
            targetInstanceId: this.targetInstanceId,
            exportData:       this.exportData,
            forceName:        this.forceName,
            platformName:     this.platformName,
        };
    }

    static Response = {
        jsonSchema: {
            type: "object",
            properties: {
                success:          { type: "boolean" },
                error:            { type: "string" },
                platformName:     { type: "string" },
                targetInstanceId: { type: "integer" },
            },
            required: ["success"],
        },
        fromJSON(json) { return json; },
    };
}
```

**Key details**:
- Permission: `PERMISSIONS.TRANSFER_EXPORTS` — import mutates game state.
- `platformName` is optional — if omitted, controller uses `exportData.platform_name`.
- Response is lightweight: success + platform name + target instance.
- This is a **non-destructive** operation: it does NOT delete source platforms, does NOT mutate `platformStorage`, and does NOT trigger the transfer-orchestrator cleanup pipeline.

### 1c. Export from `module.exports`

In the `module.exports` block at the bottom of `messages.js` (currently around line 997), add both new classes:

```js
GetStoredExportRequest,
ImportUploadedExportRequest,
```

---

## Step 2 — Register Messages in Plugin Index

**File**: `docker/seed-data/external_plugins/surface_export/index.js`

### 2a. Add to `messages` array

In the `messages:` array inside `module.exports.plugin` (currently lines ~106-130), add:

```js
messages.GetStoredExportRequest,
messages.ImportUploadedExportRequest,
```

Insert them after `messages.ListExportsRequest` (currently on or near line 112) to keep related messages grouped.

---

## Step 3 — Controller Handlers

**File**: `docker/seed-data/external_plugins/surface_export/controller.js`

### 3a. Register handlers in `init()`

Add two new handler registrations inside `init()`, after the existing `ListExportsRequest` handler registration (currently around line 72):

```js
this.controller.handle(messages.GetStoredExportRequest, this.handleGetStoredExportRequest.bind(this));
this.controller.handle(messages.ImportUploadedExportRequest, this.handleImportUploadedExportRequest.bind(this));
```

### 3b. Implement `handleGetStoredExportRequest(request)`

Add this method to the `ControllerPlugin` class, after `handleListExportsRequest()` (around line 180):

```js
async handleGetStoredExportRequest(request) {
    const { exportId } = request;
    const stored = this.platformStorage.get(exportId);
    if (!stored) {
        return { success: false, error: `Export not found: ${exportId}` };
    }
    return {
        success: true,
        exportId: stored.exportId,
        platformName: stored.platformName,
        instanceId: stored.instanceId,
        timestamp: stored.timestamp,
        size: stored.size,
        exportData: stored.exportData,
    };
}
```

**Design notes**:
- Simple Map lookup — O(1).
- Returns the full `exportData` object. For a typical platform (~235KB compressed), this is well within WebSocket frame limits.
- No authorization beyond the message-level `permission` check (handled by Clusterio framework).

### 3c. Implement `handleImportUploadedExportRequest(request)`

Add this method immediately after `handleGetStoredExportRequest`:

```js
async handleImportUploadedExportRequest(request) {
    const { targetInstanceId, exportData, forceName, platformName } = request;

    // Validate payload shape
    if (!exportData || typeof exportData !== "object") {
        return { success: false, error: "exportData must be a non-null object" };
    }

    // Resolve target instance
    const resolved = this.platformTree.resolveTargetInstance(targetInstanceId);
    if (!resolved) {
        return { success: false, error: `Target instance not found: ${targetInstanceId}` };
    }

    // Build import payload — override platform name if provided
    const importData = { ...exportData };
    if (platformName) {
        importData.platform_name = platformName;
    }

    // Generate a traceability label
    const uploadExportId = `uploaded_${Date.now()}`;

    try {
        const response = await this.controller.sendTo(
            { instanceId: resolved.id },
            new messages.ImportPlatformRequest({
                exportId: uploadExportId,
                exportData: importData,
                forceName: forceName || "player",
            })
        );

        if (!response.success) {
            return {
                success: false,
                error: response.error || "Import failed on target instance",
                targetInstanceId: resolved.id,
            };
        }

        return {
            success: true,
            platformName: importData.platform_name || "Unknown",
            targetInstanceId: resolved.id,
        };
    } catch (err) {
        this.logger.error(`Upload import failed:\n${err.stack}`);
        return { success: false, error: err.message };
    }
}
```

**Design notes**:
- Reuses existing `ImportPlatformRequest` which instance.js already handles — the instance side receives export data and calls `importPlatform()` which does chunked RCON.
- Does NOT create an active transfer, does NOT log to transaction logs, does NOT trigger source deletion. This is intentionally non-destructive — it's a standalone import, not a full transfer.
- Uses `platformTree.resolveTargetInstance()` for consistent instance resolution (handles both numeric IDs and name strings).
- The `uploadExportId` provides traceability in instance logs without polluting controller `platformStorage`.

---

## Step 4 — Web UI: Exports Tab

### 4a. Create `ExportsTab.jsx`

**File**: `docker/seed-data/external_plugins/surface_export/web/ExportsTab.jsx` (new file)

This component renders:
1. **Stored Exports table** — lists exports from `ListExportsRequest` (already fetched during refresh).
2. **Download action** — per-row button that calls `GetStoredExportRequest` and triggers browser download.
3. **Upload + Import panel** — file picker + destination instance selector + import button.

**Structural pattern**: Follow `ManualTransferTab.jsx` — functional component receiving `{ plugin, state }` props.

```jsx
import React, { useMemo, useState } from "react";
import {
    Alert,
    Button,
    Card,
    Empty,
    Select,
    Space,
    Spin,
    Table,
    Tag,
    Typography,
    Upload,
    message as antMessage,
} from "antd";
import { DownloadOutlined, UploadOutlined } from "@ant-design/icons";
import * as messageDefs from "../messages";

const { Text } = Typography;
const {
    ListExportsRequest,
    GetStoredExportRequest,
    ImportUploadedExportRequest,
} = messageDefs;
```

**Exports Table section**:
- Call `plugin.listExports()` (new method, see 4c) during mount / refresh.
- Columns: Platform Name, Export ID (truncated), Source Instance, Timestamp (human-readable), Size (formatted KB/MB), Actions.
- Sort by timestamp descending (newest first).
- Actions column: Download button.

**Download handler**:
```js
async function handleDownload(exportId, platformName, timestamp) {
    try {
        const response = await plugin.getStoredExport(exportId);
        if (!response.success) {
            throw new Error(response.error);
        }
        const blob = new Blob(
            [JSON.stringify(response.exportData, null, 2)],
            { type: "application/json" }
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const ts = new Date(timestamp).toISOString().replace(/[:.]/g, "-");
        a.download = `${platformName}_${ts}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        antMessage.error(`Download failed: ${err.message}`);
    }
}
```

**Upload + Import section** (in a `<Card>` below or beside the table):
- `<Upload>` component with `beforeUpload` returning `false` (manual upload, no auto-POST).
- Accept `.json` files only (`accept=".json"`).
- On file select: read via `FileReader`, parse JSON, store in local state. Show validation errors immediately if JSON is malformed or missing `platform_name`.
- Destination instance `<Select>` — reuse the instance list from `state.tree` (same pattern as `ManualTransferTab`'s `destinationOptions`).
- Optional force name input (default "player").
- Import button calls `plugin.importUploadedExport(...)`.

**Import handler**:
```js
async function handleImport() {
    if (!parsedData || targetInstanceId === null) return;
    setImporting(true);
    try {
        const response = await plugin.importUploadedExport({
            targetInstanceId,
            exportData: parsedData,
            forceName: forceName || "player",
        });
        if (!response.success) {
            throw new Error(response.error);
        }
        antMessage.success(
            `Import started: "${response.platformName}" on instance ${response.targetInstanceId}`,
            8
        );
        setFileList([]);
        setParsedData(null);
    } catch (err) {
        antMessage.error(`Import failed: ${err.message}`, 10);
    } finally {
        setImporting(false);
    }
}
```

**File validation rules** (client-side, before sending to controller):
- Must parse as valid JSON.
- Must be an object (not array/null).
- Must have `platform_name` (string) — or show a warning and let user provide one.
- If file is >50MB, show a warning (not hard block) about potential timeout.

### 4b. Wire into `index.jsx`

**File**: `docker/seed-data/external_plugins/surface_export/web/index.jsx`

1. Add import at top:
   ```js
   import ExportsTab from "./ExportsTab";
   ```

2. In `SurfaceExportPage()`, add a new tab item (`ExportsTab.jsx`). Insert it between "Manual Transfer" and "Transaction Logs":
   ```js
   {
       key: "exports",
       label: "Exports",
       children: <ExportsTab plugin={plugin} state={state} />,
   },
   ```

3. In the `WebPlugin` class state initialization (constructor, around line 102), add:
   ```js
   exports: [],
   loadingExports: false,
   exportsError: null,
   ```

4. In `refreshSnapshots()` (around line 192), after fetching the tree and logs, also fetch exports:
   ```js
   let exports = [];
   try {
       exports = await this.control.send(new ListExportsRequest());
       if (Array.isArray(exports)) {
           exports.sort((a, b) => b.timestamp - a.timestamp);
       }
   } catch (err) {
       // non-fatal — exports tab just won't populate
       this.logger.warn?.("Failed to fetch exports list", err);
   }
   ```
   And include `exports` in the `setState` call.

### 4c. Add plugin helper methods

In the `WebPlugin` class in `index.jsx`, add three new methods:

```js
async listExports() {
    const exports = await this.control.send(new ListExportsRequest());
    const sorted = Array.isArray(exports)
        ? [...exports].sort((a, b) => b.timestamp - a.timestamp)
        : [];
    this.setState({ exports: sorted });
    return sorted;
}

async getStoredExport(exportId) {
    return this.control.send(new GetStoredExportRequest({ exportId }));
}

async importUploadedExport(payload) {
    return this.control.send(new ImportUploadedExportRequest(payload));
}
```

Also add imports at the top of `index.jsx`:
```js
const {
    // ...existing destructured imports...
    ListExportsRequest,        // already imported for refreshSnapshots
    GetStoredExportRequest,    // NEW
    ImportUploadedExportRequest, // NEW
} = messageDefs;
```

### 4d. Add CSS for ExportsTab

**File**: `docker/seed-data/external_plugins/surface_export/web/style.css`

Add minimal styles at the end:
```css
.surface-export-exports-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.surface-export-upload-panel {
    max-width: 600px;
}
```

---

## Step 5 — CLI Commands (control.js)

**File**: `docker/seed-data/external_plugins/surface_export/control.js`

Add two new commands to the existing `surfaceExportCommands` tree.

### 5a. `get-export <exportId> [outputFile]`

```js
surfaceExportCommands.add(new Command({
    definition: [
        "get-export <exportId> [outputFile]",
        "Download a stored export payload as JSON",
        (yargs) => {
            yargs.positional("exportId", { describe: "Export ID to download", type: "string" });
            yargs.positional("outputFile", { describe: "Output file path (default: stdout)", type: "string" });
        },
    ],
    handler: async function(args, control) {
        const response = await control.sendTo("controller",
            new messages.GetStoredExportRequest({ exportId: args.exportId }));
        if (!response.success) {
            throw new Error(response.error || "Export not found");
        }
        const json = JSON.stringify(response.exportData, null, 2);
        if (args.outputFile) {
            const fs = require("fs");
            fs.writeFileSync(args.outputFile, json, "utf8");
            console.log(`Written ${json.length} bytes to ${args.outputFile}`);
        } else {
            console.log(json);
        }
    },
}));
```

### 5b. `upload-import <file> <targetInstanceId> [forceName]`

```js
surfaceExportCommands.add(new Command({
    definition: [
        "upload-import <file> <targetInstanceId> [forceName]",
        "Upload a JSON export file and import it onto a target instance",
        (yargs) => {
            yargs.positional("file", { describe: "Path to JSON export file", type: "string" });
            yargs.positional("targetInstanceId", { describe: "Target instance ID", type: "number" });
            yargs.positional("forceName", { describe: "Force name", type: "string", default: "player" });
        },
    ],
    handler: async function(args, control) {
        const fs = require("fs");
        const content = fs.readFileSync(args.file, "utf8");
        let exportData;
        try {
            exportData = JSON.parse(content);
        } catch (err) {
            throw new Error(`Invalid JSON in ${args.file}: ${err.message}`);
        }
        if (!exportData || typeof exportData !== "object") {
            throw new Error("Export file must contain a JSON object");
        }
        const targetInstanceId = Number(args.targetInstanceId);
        if (Number.isNaN(targetInstanceId)) {
            throw new Error("targetInstanceId must be a number");
        }
        console.log(`Uploading ${(content.length / 1024).toFixed(1)} KB to instance ${targetInstanceId}...`);
        const response = await control.sendTo("controller",
            new messages.ImportUploadedExportRequest({
                targetInstanceId,
                exportData,
                forceName: args.forceName || "player",
            }));
        if (response.success) {
            console.log(`Import started: "${response.platformName}" on instance ${response.targetInstanceId}`);
        } else {
            throw new Error(response.error || "Import failed");
        }
    },
}));
```

---

## Step 6 — Build & Deploy

1. Build the web bundle:
   ```powershell
   cd docker/seed-data/external_plugins/surface_export
   npm run build:web
   ```
2. Deploy to cluster (restart containers to pick up JS changes):
   ```powershell
   ./tools/deploy-cluster.ps1 -SkipIncrement -KeepData
   ```
   Or, for minimal disruption:
   ```powershell
   docker compose restart
   ```

---

## Step 7 — Validation

### Functional (positive path)

| # | Test | How | Expected |
|---|------|-----|----------|
| 1 | Exports tab loads | Open `/surface-export`, click "Exports" tab | Table shows stored exports sorted newest-first |
| 2 | Download works | Click Download on any row | Browser saves `.json` file; file parses as valid export JSON with `platform_name`, `entities`, etc. |
| 3 | Upload + Import | Upload the just-downloaded `.json`, select target instance, click Import | Success toast; `/list-platforms` on target shows new platform |
| 4 | Non-destructive | After upload-import, check `platformStorage` | No new entries added; no exports deleted |
| 5 | CLI get-export | `clusterioctl surface-export get-export <id> out.json` | File written with correct export data |
| 6 | CLI upload-import | `clusterioctl surface-export upload-import out.json <instanceId>` | Success message; platform appears on target |

### Negative (error cases)

| # | Test | Expected |
|---|------|----------|
| 1 | Download nonexistent export ID | Error toast: "Export not found: ..." |
| 2 | Upload invalid JSON file | Client-side error before send: "Invalid JSON" |
| 3 | Upload valid JSON missing `platform_name` | Warning shown; user can still proceed (controller uses fallback name) |
| 4 | Import to disconnected instance | Error: "Target instance not found" or connection error |
| 5 | Import without TRANSFER_EXPORTS permission | Permission denied error from Clusterio framework |
| 6 | Upload very large file (>50MB) | Client-side warning about potential timeout |

### Regression

| # | Test | Expected |
|---|------|----------|
| 1 | Manual Transfer tab | Works unchanged — start a transfer, verify it completes |
| 2 | Transaction Logs tab | Works unchanged — logs load and display correctly |
| 3 | Live updates (subscriptions) | Tree/transfer/log push updates still arrive |
| 4 | Integration tests | `run-tests.ps1 -TransferMode rcon` and `-TransferMode controller` pass |

---

## File Change Summary

| File | Action | Lines Changed (est.) |
|------|--------|---------------------|
| `messages.js` | Add 2 classes + export them | +110 |
| `index.js` | Register 2 new messages | +2 |
| `controller.js` | Register 2 handlers + implement them | +55 |
| `web/index.jsx` | Add imports, state fields, tab, helper methods | +30 |
| `web/ExportsTab.jsx` | **New file** — exports table + download + upload/import | +250 |
| `web/style.css` | Add 2 CSS rules | +10 |
| `control.js` | Add 2 CLI commands | +55 |
| **Total** | | **~512 new lines** |

---

## Architecture Decisions

### Why not reuse TransferOrchestrator for uploads?

The transfer orchestrator manages a full lifecycle: export → lock → transmit → validate → activate → delete source → log. Upload-import is a simpler one-shot operation — the user already has the export data, there's no source platform to lock/delete, and validation is handled by the instance's normal async import pipeline. Routing through the orchestrator would require special-casing "no source" at every step.

### Why send full exportData through WebSocket instead of chunking?

Clusterio's WebSocket link has no practical size limit for a single message (default max is ~100MB). Chunking is only needed for RCON (Factorio's ~8KB command limit). A large platform export (~235KB compressed, ~1MB uncompressed) is well within WebSocket limits. The RCON chunking is handled by `instance.js`'s `importPlatform()` which the `ImportPlatformRequest` handler already calls.

### Why `LIST_EXPORTS` permission for download?

Downloading is a read operation — it returns the same data that's already stored on the controller. Using the existing `LIST_EXPORTS` permission avoids adding a new permission that would need to be granted to existing roles. If more granular access control is needed later, a `DOWNLOAD_EXPORTS` permission can be split out.

### Why no controller storage mutation on upload?

The upload-import flow is a direct pipe: browser → controller → instance. The controller acts as a router only. This avoids polluting the `platformStorage` map with uploaded data (which could be arbitrarily large or duplicated), avoids cleanup concerns, and keeps the storage map as a clean record of server-generated exports only.
