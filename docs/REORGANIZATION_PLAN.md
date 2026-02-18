# Plugin Reorganization Plan

Planned structural improvements to prevent bugs like the `hasSpaceHub` schema validation failure and scope-related variable bugs in the web UI.

**Status**: Complete (all 4 steps implemented)
**Base path**: `docker/seed-data/external_plugins/surface_export/`

---

## 1. Fix Response Schema Drift (messages.js)

Remove `additionalProperties: false` from **all Response schemas** (both top-level and nested). Keep it on Request schemas (callers should be validated strictly, but handlers should be free to add fields).

~12 occurrences across these message classes:
- `ExportPlatformRequest.Response`
- `GetPlatformTreeRequest.Response` (top-level + nested host/instance/platform objects)
- `ListTransactionLogsRequest.Response` (array items)
- `ImportPlatformRequest.Response`
- `TransferPlatformRequest.Response`
- `StartPlatformTransferRequest.Response`
- `InstanceListPlatformsRequest.Response` (top-level + nested platform items — caused the hasSpaceHub bug)
- `ImportPlatformFromFileRequest.Response`
- `DeleteSourcePlatformRequest.Response`
- `UnlockSourcePlatformRequest.Response`
- `TransferStatusUpdate.Response`
- `GetTransactionLogRequest.Response`

**Rationale**: `additionalProperties: false` on Response schemas means any new field added in handler code but not mirrored in the schema silently breaks the entire feature. Clusterio validates responses against these schemas and rejects non-conforming ones. Request schemas should remain strict.

**Do NOT split messages.js** — 19 boilerplate classes in one file is searchable. Splitting creates import sprawl since `index.js` references every message.

---

## 2. Split web/index.jsx into 4 Files

Current: 1711 lines in one file with two tab components, a page wrapper, a plugin class, and ~20 helper functions. Variables were found defined in wrong component scopes.

**New structure:**
```
web/
  index.jsx               ~350 lines — WebPlugin class, SurfaceExportPage, hooks
  ManualTransferTab.jsx   ~300 lines — Platform tree + transfer UI
  TransactionLogsTab.jsx  ~750 lines — Log viewer + validation display
  utils.js                ~200 lines — Pure formatting functions (no React)
  style.css               unchanged
```

### web/utils.js
Extract all pure helper functions (zero React dependencies):
`statusColor`, `humanizeMetricKey`, `formatDuration`, `formatNumeric`, `formatSigned`, `sumValues`, `buildMetricRows`, `buildExpectedActualRows`, `parseFluidTemperatureKey`, `buildFluidInventoryRows`, `findLatestEvent`, `buildDetailedLogSummary`, `summaryFromTransferInfo`, `mergeTransferSummary`

### web/ManualTransferTab.jsx
Move `ManualTransferTab` component. Imports `statusColor` from `./utils`.

### web/TransactionLogsTab.jsx
Move `TransactionLogsTab` component plus all its column definitions (`metricColumns`, `comparisonColumns`, `flowColumns`, `fluidColumns`, `validationCategoryColumns`), row builders (`validationCategoryRows`, `entityRows`, `itemRows`, `fluidInventoryRows`, `fluidReconciliationRows`, `flowRows`, etc.). Imports formatting helpers from `./utils`.

### web/index.jsx (slimmed)
Keep: `WebPlugin` class, `SurfaceExportPage`, `useSurfaceExportPlugin`, `useSurfaceExportState` hooks. Import both tab components.

**Webpack**: No config changes needed — webpack follows imports from the entry point.

---

## 3. Split controller.js into Focused Modules

Current: 1577 lines in one class doing transfer orchestration, tree building, transaction logging, subscription management, and storage.

**New structure:**
```
lib/
  transfer-orchestrator.js  ~400 lines — Transfer lifecycle state machine
  platform-tree.js          ~150 lines — Tree building + instance resolution
  transaction-logger.js     ~200 lines — Event logging, phase timing, persistence
  subscription-manager.js   ~120 lines — WebSocket subscriptions + broadcasting
controller.js               ~200 lines — Slim plugin class delegating to lib/
```

### lib/platform-tree.js
Extract: `buildPlatformTree()`, `requestInstancePlatforms()`, `applyActiveTransferState()`, `resolveTargetInstance()`, `resolveInstanceName()`. Pure query logic.

### lib/transaction-logger.js
Extract: `logTransactionEvent()`, `startPhase()`, `endPhase()`, `persistTransactionLog()`, `loadTransactionLogs()`, `buildTransferInfo()`, `buildTransferSummary()`, `buildDetailedTransferSummary()`, `buildPhaseSummary()`, `getTransferSummaries()`, `getLastEventTimestamp()`, `formatDuration()`, `resolveTransferResult()`, `normalizeTransferStatus()`. Owns `transactionLogs` Map and `persistedTransactionLogs` array.

### lib/subscription-manager.js
Extract: `broadcastToSubscribers()`, `emitTreeUpdate()`, `emitTransferUpdate()`, `emitLogUpdate()`, `handleSetSurfaceExportSubscriptionRequest()`, `queueTreeBroadcast()`. Owns `surfaceExportSubscriptions` Map, revision counters, rate limiter.

### lib/transfer-orchestrator.js
Extract: `transferPlatform()`, `handleTransferValidation()`, `handleStartPlatformTransferRequest()`, `handleTransferPlatformRequest()`, `waitForStoredExport()`, `broadcastTransferStatus()`. Core transfer state machine.

### controller.js (slimmed)
Keep: `ControllerPlugin` class with `init()`, `onStart()`, `onShutdown()`, handler registration (delegating to modules), `loadStorage()`, `persistStorage()`, `handlePlatformExport()`, `handleListExportsRequest()`, `cleanupOldExports()`.

**Wiring**: Each module is a class instantiated in `init()` receiving references to controller, logger, and shared state (Maps).

---

## 4. Clean Up dist/web/ Git Tracking

Add to `.gitignore`:
```
docker/seed-data/external_plugins/surface_export/dist/
```

Run `git rm -r --cached docker/seed-data/external_plugins/surface_export/dist/` to untrack.

The `dist/` is rebuilt by `npm run build:web` which already runs in both `deploy-cluster.ps1` and `patch-and-reset.ps1`.

---

## Implementation Order

1. **Schema fix** (messages.js) — zero risk, immediate fix for the `hasSpaceHub`-class of bugs
2. **Web split** — mechanical, testable by `npm run build:web` + browser check
3. **Controller split** — highest complexity, test with full transfer workflow
4. **dist gitignore** — independent cleanup

## Verification

1. `npm run build:web` — webpack compiles successfully
2. Hard refresh http://localhost:8080/surface-export — platforms display, no JS errors
3. `docker restart surface-export-controller` — controller loads with new module structure
4. Transfer test: select platform → start transfer → verify transaction log tab renders
5. Check controller logs: no `failed validation` errors for InstanceListPlatformsRequest
