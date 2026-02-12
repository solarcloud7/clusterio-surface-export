param (
    [Parameter(Mandatory=$false)]
    [int]$HostNumber = 1,
    
    [Parameter(Mandatory=$false)]
    [int]$InstanceNumber = 1,
    
    [Parameter(Mandatory=$true)]
    [int]$PlatformIndex,
    
    [Parameter(Mandatory=$false)]
    [string]$OutputFile = $null
)

$ErrorActionPreference = "Stop"

$instanceName = "clusterio-host-$HostNumber-instance-$InstanceNumber"

Write-Host "Retrieving Export from Instance: $instanceName" -ForegroundColor Cyan
Write-Host "Platform Index: $PlatformIndex" -ForegroundColor Cyan
Write-Host ""

# Step 1: Export the platform
Write-Host "Exporting platform..." -ForegroundColor Yellow
$exportResult = docker exec surface-export-controller npx clusterioctl --log-level error instance send-rcon $instanceName "/export-platform $PlatformIndex" 2>&1 | Out-String

if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to export platform: $exportResult"
}

# Parse job ID from the result
# Expected format: "QUEUED:export_1"
$jobIdMatch = $exportResult | Select-String -Pattern "QUEUED:(\S+)"
if (-not $jobIdMatch) {
    Write-Error "Could not find job ID in response:`n$exportResult"
}

$jobId = $jobIdMatch.Matches[0].Groups[1].Value
Write-Host "Job ID: $jobId" -ForegroundColor Green
Write-Host ""

# Step 2: Wait for export to complete and find the actual export ID
Write-Host "Waiting for export to complete..." -ForegroundColor Yellow
$maxAttempts = 20
$attemptCount = 0
$exportId = $null

while ($attemptCount -lt $maxAttempts -and -not $exportId) {
    Start-Sleep -Milliseconds 500
    $attemptCount++
    
    # List all exports and find the most recent one
    $listCommand = "/sc local exports = remote.call('surface_export', 'list_exports'); local latest = nil; for _, e in pairs(exports) do if not latest or e.tick > latest.tick then latest = e end end; if latest then rcon.print(latest.id) else rcon.print('NONE') end"
    $listResult = docker exec surface-export-controller npx clusterioctl --log-level error instance send-rcon $instanceName $listCommand 2>&1 | Out-String
    $latestExportId = ($listResult -split "`r?`n" | Where-Object { $_ -and $_.Trim().Length -gt 0 } | Select-Object -Last 1)
    
    if ($latestExportId -and $latestExportId -ne 'NONE') {
        $exportId = $latestExportId
        Write-Host "Export completed after $($attemptCount * 0.5)s" -ForegroundColor Green
        Write-Host "Export ID: $exportId" -ForegroundColor Green
        break
    }
    
    if ($attemptCount % 4 -eq 0) {
        Write-Host "  Still waiting... ($($attemptCount * 0.5)s)" -ForegroundColor DarkGray
    }
}

if (-not $exportId) {
    Write-Error "Export did not complete within $($maxAttempts * 0.5) seconds"
}
Write-Host ""

# Step 3: Retrieve the export data
Write-Host "Retrieving export data..." -ForegroundColor Yellow
$getExportCommand = "/sc local export = remote.call('surface_export', 'get_export', '$exportId'); if export then rcon.print(helpers.table_to_json(export)) else rcon.print('ERROR: Export not found') end"
$exportDataResult = docker exec surface-export-controller npx clusterioctl --log-level error instance send-rcon $instanceName $getExportCommand 2>&1 | Out-String

if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to retrieve export data: $exportDataResult"
}

# Get the last non-empty line (the JSON output)
$exportDataJson = ($exportDataResult -split "`r?`n" | Where-Object { $_ -and $_.Trim().Length -gt 0 } | Select-Object -Last 1)

if ($exportDataJson -like 'ERROR:*') {
    Write-Error "Export not found: $exportDataJson"
}

# Parse the export data
try {
    $exportData = $exportDataJson | ConvertFrom-Json
} catch {
    Write-Error "Failed to parse export JSON: $_`nRaw output: $exportDataJson"
}

Write-Host "Export retrieved successfully" -ForegroundColor Green

# Step 4: Check if compressed and decompress if needed
if ($exportData.compressed -and $exportData.payload) {
    Write-Host ""
    Write-Host "Export is compressed ($($exportData.compression))" -ForegroundColor Yellow
    Write-Host "Compressed size: $($exportData.payload.Length) characters (base64)" -ForegroundColor Gray
    
    try {
        # Base64 decode
        $compressedBytes = [System.Convert]::FromBase64String($exportData.payload)
        Write-Host "Compressed bytes: $($compressedBytes.Length)" -ForegroundColor Gray
        
        # Decompress using deflate (skip 2-byte zlib header)
        $memoryStream = New-Object System.IO.MemoryStream
        $memoryStream.Write($compressedBytes, 2, $compressedBytes.Length - 2)
        $memoryStream.Position = 0
        
        $deflateStream = New-Object System.IO.Compression.DeflateStream($memoryStream, [System.IO.Compression.CompressionMode]::Decompress)
        $decompressedStream = New-Object System.IO.MemoryStream
        $deflateStream.CopyTo($decompressedStream)
        
        $decompressedBytes = $decompressedStream.ToArray()
        $decompressedJson = [System.Text.Encoding]::UTF8.GetString($decompressedBytes)
        
        Write-Host "Decompressed size: $($decompressedBytes.Length) bytes" -ForegroundColor Gray
        Write-Host "Compression ratio: $([Math]::Round((1 - $compressedBytes.Length / $decompressedBytes.Length) * 100, 1))%" -ForegroundColor Green
        
        # Parse the decompressed JSON
        $platformData = $decompressedJson | ConvertFrom-Json
        
        # Clean up streams
        $deflateStream.Dispose()
        $decompressedStream.Dispose()
        $memoryStream.Dispose()
        
    } catch {
        Write-Error "Failed to decompress payload: $_"
    }
} else {
    Write-Host ""
    Write-Host "Export is not compressed" -ForegroundColor Yellow
    $platformData = $exportData
}

# Step 5: Display summary
Write-Host ""
Write-Host "--- Export Summary ---" -ForegroundColor Cyan
Write-Host "Platform: $($exportData.platform_name)" -ForegroundColor White
Write-Host "Tick: $($exportData.tick)" -ForegroundColor White
Write-Host "Timestamp: $($exportData.timestamp)" -ForegroundColor White

if ($exportData.stats) {
    Write-Host ""
    Write-Host "Statistics:" -ForegroundColor Cyan
    if ($exportData.stats.PSObject.Properties['total_entities']) {
        Write-Host "  Total entities: $($exportData.stats.total_entities)" -ForegroundColor White
    }
    if ($exportData.stats.PSObject.Properties['processing_time_ticks']) {
        Write-Host "  Processing time: $($exportData.stats.processing_time_ticks) ticks" -ForegroundColor White
    }
    
    if ($exportData.stats.PSObject.Properties['entity_counts'] -and $exportData.stats.entity_counts) {
        Write-Host ""
        Write-Host "Entity types:" -ForegroundColor Cyan
        $exportData.stats.entity_counts.PSObject.Properties | Sort-Object Value -Descending | Select-Object -First 10 | ForEach-Object {
            Write-Host "  $($_.Name): $($_.Value)" -ForegroundColor White
        }
    }
}

if ($platformData.entities) {
    Write-Host ""
    Write-Host "Decompressed data:" -ForegroundColor Cyan
    Write-Host "  Entities: $($platformData.entities.Count)" -ForegroundColor White
    Write-Host "  Tiles: $($platformData.tiles.Count)" -ForegroundColor White
}

# Step 6: Save to file
if (-not $OutputFile) {
    $OutputFile = ".\tools\export_${exportId}.json"
}

Write-Host ""
Write-Host "Saving export to: $OutputFile" -ForegroundColor Yellow

# Pretty print the JSON
$prettyJson = $platformData | ConvertTo-Json -Depth 100 -Compress:$false

$prettyJson | Out-File -FilePath $OutputFile -Encoding UTF8

Write-Host "Export saved successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "To compare with blueprint schema:" -ForegroundColor Cyan
Write-Host "  Blueprint entities: .\tools\decoded_blueprint.json" -ForegroundColor Gray
Write-Host "  Export entities:    $OutputFile" -ForegroundColor Gray
