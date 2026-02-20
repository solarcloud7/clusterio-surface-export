# Transfer Workflow Guide
Diagrams

## Entry Points
- In-game command: `/transfer-platform <platform_index> <destination_instance_id>`
- CLI (stored export): `npx clusterioctl surface-export transfer <exportId> <instanceId>`
- List exports: `npx clusterioctl surface-export list`

## Critical Invariants
1. Transfer Start (lock source platform)
   - completes in-flight cargo pod transitions
   - freezes entities (`entity.active = false`) and records `frozen_states`
   - hides/locks the surface so it can’t be modified during export
2. Export Job (scanning)
   - runs async export batches
   - performs atomic single-tick belt scan before final verification
   - stores compressed export data by `export_id`
3. Factorio -> Instance Plugin (Clusterio `send_json` event channel)
   - source Factorio emits `surface_export_complete`
   - instance plugin fetches full export payload via `get_export_json(export_id)`
4. Host -> Controller (Clusterio link messages)
   - E3a: `PlatformExportEvent` (store export)
   - E3b: `TransferPlatformRequest` (start transfer)
5. Validation + controller decision
   - I5a: `TransferValidationEvent` (destination plugin -> controller)
   - I5b: Controller decision (success / failed / timeout)
   - I5c-success: `DeleteSourcePlatformRequest` (cleanup path)
   - I5c-failure: `UnlockSourcePlatformRequest` (rollback path)

## 1) Canonical End-to-End Transfer Sequence
```mermaid
sequenceDiagram
autonumber
participant U as Initialize Transfer
participant SF as Factorio 1 (Lua)
participant SI as Host 1
participant C as Controller
participant DI as Host 2
participant DF as Factorio 2 (Lua)

U->>SF: /command
SF->>SF: Export Job
SF->>SI: clusterio_api.send_json("surface_export_complete", data)
SI->>C:  PlatformExportEvent + TransferPlatformRequest
C->>DI: ImportPlatformRequest
DI->>DF: Send import payload in chunks
DF->>DF: Run async import + validation preparation
DF->>DI: send_json event surface_export_import_complete
DI->>C: TransferValidationEvent

alt Validation success
  C->>SI: DeleteSourcePlatformRequest
  SI->>SF: Delete source platform surface
  C->>C: Mark completed + persist log
else Validation failed or timeout
  C->>SI: UnlockSourcePlatformRequest
  SI->>SF: Unlock source platform (rollback)
  C->>C: Mark failed + persist log
end
```

## 2) Export Internals (Zoom-In: E1 -> E3)
Scope: Source-side export work only. Starts when export is queued and ends when export data is stored on controller.

```mermaid
sequenceDiagram
autonumber
participant SF as Source Factorio (Lua)
participant SI as Source Instance Plugin
participant C as Controller

SF->>SF: Lock platform (cargo pods complete, entities freeze, surface hidden)
SF->>SF: Capture platform schedule (records + interrupts + group)

loop on_tick export batches
  SF->>SF: Serialize entities (belt contents deferred)
end

SF->>SF: Atomic single-tick belt scan
SF->>SF: Build verification counts + compress + store export by export_id
SF->>SI: send_json event surface_export_complete {export_id, metrics}
SI->>SF: RCON get_export_json(export_id)
SF-->>SI: Export payload
SI->>C: PlatformExportEvent(export_id, platformName, instanceId, exportData)
C->>C: Store export in platformStorage
```

## 3) Import Internals (Zoom-In: I2 -> I5)
Scope: Destination-side import work only. Starts when payload chunking begins and ends when validation event is sent to controller.

```mermaid
sequenceDiagram
autonumber
participant DI as Destination Instance Plugin
participant DF as Destination Factorio (Lua)

loop Chunk transfer
  DI->>DF: import_platform_chunk(platform, chunk, index, total, force)
  DF->>DF: Store chunk session
end

DF->>DF: Finalize chunks -> queue_import()
DF->>DF: Parse/decompress payload + validate transfer schedule payload
DF->>DF: Create platform + apply starter pack + pause platform

loop on_tick creation phases
  DF->>DF: Tile restoration
  DF->>DF: Hub mapping
  DF->>DF: Entity creation (entities kept inactive)
end

DF->>DF: Deferred hub inventory restore
DF->>DF: Belt restore (single tick)
DF->>DF: Entity state/connections restore
DF->>DF: TransferValidation.validate_import(skip_fluid_validation=true)

alt validation success
  DF->>DF: Unpause platform
  DF->>DF: Restore active states from frozen_states
  DF->>DF: Post-activation fluid restore
else validation failure
  DF->>DF: Keep destination paused/inactive for investigation
end

DF->>DF: Store validation result
DF->>DI: send_json event surface_export_import_complete
DI->>DF: RCON get_validation_result_json(platform_name)
DF-->>DI: Validation JSON
```

## Validation Summary
- Item gains greater than 5 are failure.
- Very large item loss (greater than 95% and greater than 100 absolute) is failure.
- Unexpected item types above threshold are flagged.
- Fluid gains greater than 500 are failure.
- If expected fluid is greater than 1000 and actual is near zero, failure.
- Transfer path defers full fluid reconciliation until post-activation analysis.

## Transaction Log Flow
Common progression:
- `transfer_created` -> `import_started` -> `validation_received` -> `transfer_completed`
- Failure path includes rollback events (for example `rollback_attempt`, `rollback_success`, `transfer_failed`)
- Timeout path records `validation_timeout` then rollback

Scripts:
- `.\tools\list-transaction-logs.ps1`
- `.\tools\get-transaction-log.ps1`
- `.\tools\get-transaction-log.ps1 -TransferId <transfer_id>`
