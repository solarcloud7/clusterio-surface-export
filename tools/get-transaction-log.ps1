#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Get transaction log for a specific transfer
.DESCRIPTION
    Retrieves all critical events for a transfer transaction from the controller
.PARAMETER TransferId
    The transfer ID to retrieve logs for. If not specified, shows the latest transfer.
.EXAMPLE
    .\tools\get-transaction-log.ps1
    Shows the latest transfer log
.EXAMPLE
    .\tools\get-transaction-log.ps1 -TransferId "transfer_1769126198841_ghkd99"
    Shows a specific transfer log
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$TransferId = "latest"
)

$ErrorActionPreference = "Stop"

Write-Host "`n=== Transaction Log Viewer ===" -ForegroundColor Cyan
if ($TransferId -eq "latest") {
    Write-Host "Showing: Latest Transfer`n" -ForegroundColor Yellow
} else {
    Write-Host "Transfer ID: $TransferId`n" -ForegroundColor Yellow
}

try {
    # Read transaction log file directly from controller container
    # Note: We do NOT use 2>&1 here because unrelated Docker warnings on stderr would corrupt the JSON
    $result = docker exec surface-export-controller cat /clusterio/database/surface_export_transaction_logs.json

    if ($LASTEXITCODE -ne 0) {
        Write-Host "No transaction logs found yet. Transfer a platform first." -ForegroundColor Yellow
        exit 0
    }

    # Ensure result is a single string and parse JSON
    $jsonContent = $result -join "`n"
    
    if ([string]::IsNullOrWhiteSpace($jsonContent)) {
        Write-Host "Transaction log file is empty." -ForegroundColor Yellow
        exit 0
    }

    try {
        $allLogs = $jsonContent | ConvertFrom-Json
    } catch {
        Write-Host "Failed to parse transaction log JSON. Content preview:" -ForegroundColor Red
        Write-Host ($jsonContent | Select-Object -First 5) -ForegroundColor Gray
        throw $_
    }

    if (-not $allLogs -or $allLogs.Count -eq 0) {
        Write-Host "No transaction logs available yet." -ForegroundColor Yellow
        exit 0
    }

    # Get the requested log
    if ($TransferId -eq "latest") {
        # Handle case where ConvertFrom-Json returns a single object instead of array
        if ($allLogs -isnot [System.Array]) {
            $log = $allLogs
        } else {
            $log = $allLogs[-1]
        }
    } else {
        $log = $allLogs | Where-Object { $_.transferId -eq $TransferId } | Select-Object -First 1
        if (-not $log) {
            Write-Host "Error: Transfer ID not found: $TransferId" -ForegroundColor Red
            Write-Host "`nAvailable transfer IDs:" -ForegroundColor Yellow
            $allLogs | ForEach-Object { Write-Host "  $($_.transferId)" -ForegroundColor White }
            exit 1
        }
    }

    $response = @{
        success = $true
        transferId = $log.transferId
        events = $log.events
        transferInfo = $log.transferInfo
    }

    # Display transfer info
    if ($response.transferInfo) {
        $info = $response.transferInfo
        Write-Host "Transfer Information:" -ForegroundColor Green
        Write-Host "  Platform:    $($info.platformName)" -ForegroundColor White
        Write-Host "  Export ID:   $($info.exportId)" -ForegroundColor White
        Write-Host "  Source:      Instance $($info.sourceInstanceId)" -ForegroundColor White
        Write-Host "  Destination: Instance $($info.targetInstanceId)" -ForegroundColor White
        Write-Host "  Status:      $($info.status)" -ForegroundColor $(if ($info.status -eq "completed") { "Green" } elseif ($info.status -eq "failed") { "Red" } else { "Yellow" })
        
        if ($info.PSObject.Properties['startedAt'] -and $info.startedAt) {
            $started = [DateTimeOffset]::FromUnixTimeMilliseconds($info.startedAt).LocalDateTime
            Write-Host "  Started:     $started" -ForegroundColor White
        }
        
        if ($info.PSObject.Properties['completedAt'] -and $info.completedAt) {
            $completed = [DateTimeOffset]::FromUnixTimeMilliseconds($info.completedAt).LocalDateTime
            $duration = [Math]::Round(($info.completedAt - $info.startedAt) / 1000, 2)
            Write-Host "  Completed:   $completed ($duration seconds)" -ForegroundColor White
        }
        
        if ($info.PSObject.Properties['failedAt'] -and $info.failedAt) {
            $failed = [DateTimeOffset]::FromUnixTimeMilliseconds($info.failedAt).LocalDateTime
            $duration = [Math]::Round(($info.failedAt - $info.startedAt) / 1000, 2)
            Write-Host "  Failed:      $failed ($duration seconds)" -ForegroundColor White
        }
        
        if ($info.PSObject.Properties['error'] -and $info.error) {
            Write-Host "  Error:       $($info.error)" -ForegroundColor Red
        }
        
        Write-Host ""
    }

    # Display events
    if ($response.events -and $response.events.Count -gt 0) {
        Write-Host "Event Timeline ($($response.events.Count) events):" -ForegroundColor Green
        Write-Host "$("`u{2500}" * 80)" -ForegroundColor DarkGray
        
        foreach ($event in $response.events) {
            $timestamp = [DateTime]::Parse($event.timestamp).ToLocalTime().ToString("HH:mm:ss.fff")
            
            # Get elapsed time if available
            $elapsedStr = ""
            if ($event.PSObject.Properties['elapsedMs'] -and $event.elapsedMs -gt 0) {
                $elapsedStr = "+$($event.elapsedMs)ms"
            }
            
            # Color code by event type
            $color = switch -Wildcard ($event.eventType) {
                "*_created"    { "Cyan" }
                "*_started"    { "Blue" }
                "*_success*"   { "Green" }
                "*_completed"  { "Green" }
                "*_failed"     { "Red" }
                "*_timeout"    { "Red" }
                "*_error"      { "Red" }
                "*_rollback*"  { "Yellow" }
                default        { "White" }
            }
            
            # Icon by event type
            $icon = switch -Wildcard ($event.eventType) {
                "*_created"    { "`u{1F195}" } # NEW
                "*_started"    { "`u{25B6}" }  # Play
                "*_success*"   { "`u{2713}" }  # Checkmark
                "*_completed"  { "`u{2705}" }  # Green check
                "*_failed"     { "`u{274C}" }  # X
                "*_timeout"    { "`u{23F0}" }  # Clock
                "*_error"      { "`u{26A0}" }  # Warning
                "*_rollback*"  { "`u{21A9}" }  # Return arrow
                "*_deleted"    { "`u{1F5D1}" } # Wastebasket
                "*_received"   { "`u{1F4DD}" } # Memo
                "*_cleared"    { "`u{1F4DD}" } # Memo
                default        { "`u{1F4DD}" } # Memo
            }
            
            Write-Host "[$timestamp] " -NoNewline -ForegroundColor DarkGray
            if ($elapsedStr) {
                Write-Host "$elapsedStr " -NoNewline -ForegroundColor DarkYellow
            }
            Write-Host "$icon " -NoNewline -ForegroundColor $color
            Write-Host "$($event.eventType)" -NoNewline -ForegroundColor $color
            Write-Host " - $($event.message)" -ForegroundColor White
            
            # Show metrics if present
            if ($event.PSObject.Properties['metrics'] -and $event.metrics) {
                Write-Host "    Metrics: " -NoNewline -ForegroundColor Cyan
                $metricsStr = @()
                foreach ($prop in $event.metrics.PSObject.Properties) {
                    $metricsStr += "$($prop.Name)=$($prop.Value)"
                }
                Write-Host ($metricsStr -join ", ") -ForegroundColor Cyan
            }
            
            # Show payload metrics if present
            if ($event.PSObject.Properties['payloadMetrics'] -and $event.payloadMetrics) {
                Write-Host "    Payload: " -NoNewline -ForegroundColor Magenta
                $pm = $event.payloadMetrics
                $parts = @()
                if ($pm.PSObject.Properties['isCompressed']) { $parts += "compressed=$($pm.isCompressed)" }
                if ($pm.PSObject.Properties['compressionType']) { $parts += "type=$($pm.compressionType)" }
                if ($pm.PSObject.Properties['payloadSizeKB']) { $parts += "size=$($pm.payloadSizeKB)KB" }
                if ($pm.PSObject.Properties['entityCount']) { $parts += "entities=$($pm.entityCount)" }
                if ($pm.PSObject.Properties['itemCount']) { $parts += "items=$($pm.itemCount)" }
                Write-Host ($parts -join ", ") -ForegroundColor Magenta
            }
            
            # Show phases if present (completion event)
            if ($event.PSObject.Properties['phases'] -and $event.phases) {
                Write-Host "    Phase Timing: " -NoNewline -ForegroundColor Green
                $phaseStr = @()
                foreach ($prop in $event.phases.PSObject.Properties) {
                    $phaseStr += "$($prop.Name)=$($prop.Value)"
                }
                Write-Host ($phaseStr -join ", ") -ForegroundColor Green
            }
            
            # Show transmission time if present
            if ($event.PSObject.Properties['transmissionMs'] -and $event.transmissionMs) {
                Write-Host "    Transmission: $($event.transmissionMs)ms" -ForegroundColor Blue
            }
            
            # Show validation time if present
            if ($event.PSObject.Properties['validationMs'] -and $event.validationMs) {
                Write-Host "    Validation Duration: $($event.validationMs)ms" -ForegroundColor Blue
            }
            
            # Show import metrics if present (from Lua async processing)
            if ($event.PSObject.Properties['importMetrics'] -and $event.importMetrics) {
                $im = $event.importMetrics
                Write-Host "    Import Phase Timing:" -ForegroundColor Yellow
                $phaseTimings = @()
                if ($im.tiles_ms) { $phaseTimings += "tiles=$($im.tiles_ms)ms" }
                if ($im.entities_ms) { $phaseTimings += "entities=$($im.entities_ms)ms" }
                if ($im.fluids_ms) { $phaseTimings += "fluids=$($im.fluids_ms)ms" }
                if ($im.belts_ms) { $phaseTimings += "belts=$($im.belts_ms)ms" }
                if ($im.state_ms) { $phaseTimings += "state=$($im.state_ms)ms" }
                if ($im.validation_ms) { $phaseTimings += "validation=$($im.validation_ms)ms" }
                Write-Host "      $($phaseTimings -join ', ')" -ForegroundColor Yellow
                Write-Host "      Total: $($im.total_ticks) ticks ($($im.total_ms)ms)" -ForegroundColor Yellow
                
                Write-Host "    Import Counts:" -ForegroundColor Cyan
                $counts = @()
                if ($im.tiles_placed) { $counts += "tiles=$($im.tiles_placed)" }
                if ($im.entities_created) { $counts += "entities=$($im.entities_created)" }
                if ($im.entities_failed) { $counts += "failed=$($im.entities_failed)" }
                if ($im.fluids_restored) { $counts += "fluids=$($im.fluids_restored)" }
                if ($im.belt_items_restored) { $counts += "beltItems=$($im.belt_items_restored)" }
                if ($im.circuits_connected) { $counts += "circuits=$($im.circuits_connected)" }
                Write-Host "      $($counts -join ', ')" -ForegroundColor Cyan
                if ($im.total_items -or $im.total_fluids) {
                    Write-Host "      Source totals: items=$($im.total_items), fluids=$($im.total_fluids)" -ForegroundColor Cyan
                }
            }
            
            # Show additional data if present
            if ($event.PSObject.Properties['error'] -and $event.error) {
                Write-Host "    Error: $($event.error)" -ForegroundColor Red
            }
            if ($event.PSObject.Properties['validation'] -and $event.validation) {
                Write-Host "    Validation:" -ForegroundColor Yellow
                $event.validation | ConvertTo-Json -Compress | Write-Host -ForegroundColor Yellow
            }
        }
        
        Write-Host "$("`u{2500}" * 80)" -ForegroundColor DarkGray
    } else {
        Write-Host "No events found for this transfer." -ForegroundColor Yellow
    }

    Write-Host ""

} catch {
    Write-Host "Error: $_" -ForegroundColor Red
    exit 1
}
