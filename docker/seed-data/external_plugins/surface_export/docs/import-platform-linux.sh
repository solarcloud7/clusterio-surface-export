#!/bin/bash
# Platform Import Script (Linux)
# Run inside Docker container to bypass Windows cmd.exe limits

set -e

EXPORT_FILE="${1:-/tmp/test-data/Strana Mechty_25494879.json}"
PLATFORM_NAME="${2:-Linux Direct Import}"
INSTANCE_NAME="${3:-clusterio-host-1-instance-1}"
FORCE_NAME="${4:-player}"

echo "============================================"
echo "Platform Import (Linux Direct)"
echo "============================================"
echo "Export file: $EXPORT_FILE"
echo "Platform: $PLATFORM_NAME"
echo "Instance: $INSTANCE_NAME"
echo ""

# Check if file exists
if [ ! -f "$EXPORT_FILE" ]; then
    echo "Error: Export file not found: $EXPORT_FILE"
    exit 1
fi

# Read JSON and prepare for import
echo "Reading JSON..."
RAW_JSON=$(cat "$EXPORT_FILE")

# Escape for Lua [[...]] syntax: replace newlines with spaces (matching PowerShell)
# Use printf to avoid adding extra newline
JSON=$(printf '%s' "$RAW_JSON" | tr '\n' ' ' | tr '\r' ' ')
JSON_SIZE=${#JSON}
echo "JSON size: $JSON_SIZE bytes (newlines converted to spaces)"
echo ""

# Generate session ID
SESSION_ID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "$(date +%s)-$(( RANDOM % 10000 ))")

# Calculate checksum (must match PowerShell: checksum on space-converted JSON)
CHECKSUM=$(echo -n "$JSON" | python3 -c "
import sys
data = sys.stdin.read()
hash_val = 0
for ch in data.encode('utf-8'):
    hash_val = ((hash_val * 31) + ch) % 0x100000000
print(f'{hash_val:08x}')
")

echo "Session: $SESSION_ID"
echo "Checksum: $CHECKSUM"
echo ""

# Determine chunking strategy
CHUNK_SIZE=100000      # 100KB chunks (practical limit with npx/clusterioctl overhead)

CHUNK_COUNT=$(( ($JSON_SIZE + $CHUNK_SIZE - 1) / $CHUNK_SIZE ))
echo "File will be split into $CHUNK_COUNT chunks of ~100KB"
echo ""

# Begin import session
echo "[1/4] Beginning import session..."
START_TIME=$(date +%s%3N)

BEGIN_CMD="/sc local ok, err = remote.call('FactorioSurfaceExport', 'begin_import_session', '$SESSION_ID', $CHUNK_COUNT, '$PLATFORM_NAME', '$FORCE_NAME') if ok then rcon.print('BEGIN_OK') else rcon.print('ERROR:' .. (err or 'failed')) end"

# Run command from controller (assuming we're in host and need to route through controller)
if [ -f "/.dockerenv" ] && [ "$(hostname)" != "clusterio-controller" ]; then
    # Running in host container - need to use docker exec to controller
    RESULT=$(docker exec clusterio-controller npx clusterioctl --log-level error instance send-rcon "$INSTANCE_NAME" "$BEGIN_CMD" 2>&1 | tail -n 1)
else
    # Running in controller or directly
    RESULT=$(npx clusterioctl --log-level error instance send-rcon "$INSTANCE_NAME" "$BEGIN_CMD" 2>&1 | tail -n 1)
fi
if [[ ! "$RESULT" =~ "BEGIN_OK" ]]; then
    echo "Error: Failed to begin session: $RESULT"
    exit 1
fi

BEGIN_TIME=$(date +%s%3N)
echo "  Session begun in $((BEGIN_TIME - START_TIME))ms"
echo ""

# Upload chunks
echo "[2/4] Uploading $CHUNK_COUNT chunk(s)..."
UPLOAD_START=$(date +%s%3N)

for ((i=0; i<CHUNK_COUNT; i++)); do
    CHUNK_IDX=$((i + 1))
    OFFSET=$((i * CHUNK_SIZE))
    CHUNK_DATA="${JSON:$OFFSET:$CHUNK_SIZE}"
    
    CHUNK_CMD="/sc local ok, err = remote.call('FactorioSurfaceExport', 'enqueue_import_chunk', '$SESSION_ID', $CHUNK_IDX, [[$CHUNK_DATA]]) if ok then rcon.print('CHUNK_OK:' .. $CHUNK_IDX) else rcon.print('ERROR:' .. (err or 'failed')) end"
    
    CHUNK_RESULT=$(npx clusterioctl --log-level error instance send-rcon "$INSTANCE_NAME" "$CHUNK_CMD" 2>&1 | tail -n 1)
    
    if [[ ! "$CHUNK_RESULT" =~ "CHUNK_OK" ]]; then
        echo "Error: Chunk $CHUNK_IDX failed: $CHUNK_RESULT"
        exit 1
    fi
    
    echo "  Uploaded chunk $CHUNK_IDX/$CHUNK_COUNT"
done

UPLOAD_END=$(date +%s%3N)
echo "  All chunks uploaded in $((UPLOAD_END - UPLOAD_START))ms"
echo ""

# Finalize import
echo "[3/4] Finalizing import..."
FINALIZE_CMD="/sc local job_id, err = remote.call('FactorioSurfaceExport', 'finalize_import_session', '$SESSION_ID', '$CHECKSUM') if job_id then rcon.print('QUEUED:' .. job_id) else rcon.print('ERROR:' .. (err or 'failed')) end"

FINALIZE_RESULT=$(npx clusterioctl --log-level error instance send-rcon "$INSTANCE_NAME" "$FINALIZE_CMD" 2>&1 | tail -n 1)

if [[ ! "$FINALIZE_RESULT" =~ "QUEUED:" ]]; then
    echo "Error: Failed to finalize: $FINALIZE_RESULT"
    exit 1
fi

JOB_ID=$(echo "$FINALIZE_RESULT" | sed 's/QUEUED://')
FINALIZE_END=$(date +%s%3N)
echo "  Job queued: $JOB_ID (in $((FINALIZE_END - UPLOAD_END))ms)"
echo ""

# Poll for completion
echo "[4/4] Polling import status..."
POLL_START=$(date +%s%3N)

while true; do
    STATUS_CMD="/sc local status = remote.call('FactorioSurfaceExport', 'get_import_status', '$JOB_ID'); if status then rcon.print(game.table_to_json(status)) else rcon.print('{\"status\":\"unknown\"}') end"
    
    STATUS_JSON=$(npx clusterioctl --log-level error instance send-rcon "$INSTANCE_NAME" "$STATUS_CMD" 2>&1 | grep -E '^\{' | tail -n 1)
    
    STATUS=$(echo "$STATUS_JSON" | grep -oP '"status"\s*:\s*"\K[^"]+')
    
    if [ "$STATUS" == "completed" ]; then
        echo "✓ Import complete!"
        break
    elif [ "$STATUS" == "error" ]; then
        ERROR_MSG=$(echo "$STATUS_JSON" | grep -oP '"error_message"\s*:\s*"\K[^"]+')
        echo "Error: Import failed: $ERROR_MSG"
        exit 1
    elif [ "$STATUS" == "in_progress" ]; then
        PROGRESS=$(echo "$STATUS_JSON" | grep -oP '"current_index"\s*:\s*\K[0-9]+')
        TOTAL=$(echo "$STATUS_JSON" | grep -oP '"total_entities"\s*:\s*\K[0-9]+')
        echo "  Progress: $PROGRESS/$TOTAL entities..."
        sleep 0.5
    else
        echo "  Waiting for job to start..."
        sleep 0.5
    fi
done

END_TIME=$(date +%s%3N)
TOTAL_TIME=$((END_TIME - START_TIME))

echo ""
echo "============================================"
echo "Import Complete!"
echo "============================================"
echo "Total time: ${TOTAL_TIME}ms ($(echo "scale=2; $TOTAL_TIME/1000" | bc)s)"
echo "Breakdown:"
echo "  - Session begin: $((BEGIN_TIME - START_TIME))ms"
echo "  - Chunk upload: $((UPLOAD_END - UPLOAD_START))ms"
echo "  - Finalize: $((FINALIZE_END - UPLOAD_END))ms"
echo "  - Processing: $((END_TIME - FINALIZE_END))ms"
echo ""
