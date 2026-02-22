# Quick Start — Platform Transfer

## Prerequisites

1. Docker Desktop running
2. Clone the repo, copy `.env.example` to `.env`, set `INIT_CLUSTERIO_ADMIN`
3. Create external volume (one-time): `docker volume create factorio-client`
4. Start the cluster: `docker compose up -d`

> **Factorio Game Client**: If you need export-data (icon spritesheets), set `FACTORIO_USERNAME` and `FACTORIO_TOKEN` in `.env`. Host-1 downloads the client into the `factorio-client` volume on first startup. This volume persists across `docker compose down -v`.

## One-Command Transfer

```lua
/transfer-platform <platform_index> <destination_instance_id>
```

This single command handles the full workflow: lock → export → send to controller → import on destination → validate → delete source (or rollback on failure).

## Step-by-Step Example

### 1. Find Your Platform Index

```lua
/list-platforms
```

Output:
```
Found 2 platform(s):
  [1] Mining Outpost Alpha (Force: player, Entities: 523)
  [2] Defense Station Beta (Force: player, Entities: 234)
```

### 2. Transfer Platform

```lua
/transfer-platform 1 2
```

The transfer runs asynchronously. You'll see progress messages in chat:

```
[Export Mining Outpost Alpha] Progress: 50% (261/523 entities)
[Export Complete] Mining Outpost Alpha (523 entities in 10.5s)
```

On the destination instance:
```
[Import Mining Outpost Alpha] Progress: 50% (261/523 entities)
[Import Complete] Mining Outpost Alpha (523 entities in 10.5s)
```

### 3. Verify

On destination:
```lua
/list-platforms
```
```
Found 1 platform(s):
  [1] Mining Outpost Alpha (Force: player, Entities: 523)
```

On source (platform deleted automatically):
```lua
/list-platforms
```
```
Found 1 platform(s):
  [1] Defense Station Beta (Force: player, Entities: 234)
```

## Alternative: Manual Export + CLI Transfer

### Step 1: Export In-Game

```lua
/export-platform 1
```

Wait for completion message:
```
[Export Complete] Mining Outpost Alpha (523 entities in 10.5s) - ID: Mining Outpost Alpha_12345678_export_42
```

### Step 2: List Exports via CLI

```bash
npx clusterioctl surface-export list
```

### Step 3: Transfer via CLI

```bash
npx clusterioctl surface-export transfer "Mining Outpost Alpha_12345678_export_42" 2
```

## What Happens During Transfer

| Phase | Duration | Description |
|-------|----------|-------------|
| Lock | Instant | Platform hidden from players |
| Export | ~10-60s | Async scan at 50 entities/tick |
| Transfer | ~1-10s | Chunked to controller → destination via WebSocket |
| Import | ~10-60s | Async rebuild at 50 entities/tick |
| Validation | Instant | Item/fluid counts compared to source |
| Cleanup | Instant | Success → delete source / Failure → unlock source |

## Performance Estimates

| Platform Size | Export | Transfer | Import | Total |
|---------------|--------|----------|--------|-------|
| 100 entities | ~2s | ~1s | ~2s | ~5s |
| 1000 entities | ~20s | ~5s | ~20s | ~45s |
| 10000 entities | ~3min | ~30s | ~3min | ~7min |

UPS impact: <1% during transfer.
