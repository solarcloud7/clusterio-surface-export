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
    $result = docker exec surface-export-controller cat /clusterio/data/database/surface_export_transaction_logs.json

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
        
        $sourceName = if ($info.PSObject.Properties['sourceInstanceName'] -and $info.sourceInstanceName) { " ($($info.sourceInstanceName))" } else { "" }
        $destName = if ($info.PSObject.Properties['targetInstanceName'] -and $info.targetInstanceName) { " ($($info.targetInstanceName))" } else { "" }
        Write-Host "  Source:      Instance $($info.sourceInstanceId)$sourceName" -ForegroundColor White
        Write-Host "  Destination: Instance $($info.targetInstanceId)$destName" -ForegroundColor White
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
                if ($pm.PSObject.Properties['tileCount']) { $parts += "tiles=$($pm.tileCount)" }
                if ($pm.PSObject.Properties['totalItemCount']) { $parts += "items=$($pm.totalItemCount) ($($pm.uniqueItemTypes) types)" }
                if ($pm.PSObject.Properties['totalFluidVolume']) { $parts += "fluids=$($pm.totalFluidVolume) ($($pm.uniqueFluidTypes) types)" }
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
                $v = $event.validation
                Write-Host "    Validation: " -NoNewline -ForegroundColor Yellow
                Write-Host "items=$($v.itemCountMatch) fluids=$($v.fluidCountMatch) entities=$($v.entityCount)" -ForegroundColor Yellow
                if ($v.PSObject.Properties['mismatchDetails'] -and $v.mismatchDetails) {
                    Write-Host "    Mismatch: $($v.mismatchDetails)" -ForegroundColor Red
                }
            }
        }
        
        Write-Host "$("`u{2500}" * 80)" -ForegroundColor DarkGray
    } else {
        Write-Host "No events found for this transfer." -ForegroundColor Yellow
    }

    # Display summary section if present
    if ($log.PSObject.Properties['summary'] -and $log.summary) {
        $s = $log.summary
        Write-Host "`n=== Transfer Summary ===" -ForegroundColor Cyan
        
        $resultColor = if ($s.result -eq "SUCCESS") { "Green" } else { "Red" }
        $resultIcon = if ($s.result -eq "SUCCESS") { "`u{2705}" } else { "`u{274C}" }
        Write-Host "$resultIcon Result: $($s.result)" -ForegroundColor $resultColor
        Write-Host "  Duration: $($s.totalDurationStr) ($($s.totalDurationMs)ms)" -ForegroundColor White
        
        # Phase timing
        if ($s.PSObject.Properties['phases'] -and $s.phases) {
            Write-Host "`n  Phase Timing:" -ForegroundColor Green
            $phases = $s.phases
            foreach ($prop in $phases.PSObject.Properties) {
                $phaseName = $prop.Name -replace 'Ms$', ''
                $ms = $prop.Value
                $bar = ""
                if ($s.totalDurationMs -gt 0) {
                    $pct = [Math]::Round($ms / $s.totalDurationMs * 100, 1)
                    $barLen = [Math]::Max(1, [Math]::Min(40, [Math]::Round($pct / 100 * 40)))
                    $bar = "`u{2588}" * $barLen
                    Write-Host "    $($phaseName.PadRight(14)) " -NoNewline -ForegroundColor White
                    Write-Host "$bar " -NoNewline -ForegroundColor Cyan
                    Write-Host "${ms}ms ($pct%)" -ForegroundColor DarkGray
                } else {
                    Write-Host "    $($phaseName.PadRight(14)) ${ms}ms" -ForegroundColor White
                }
            }
        }
        
        # Platform info
        if ($s.PSObject.Properties['platform'] -and $s.platform) {
            $p = $s.platform
            Write-Host "`n  Platform:" -ForegroundColor Green
            Write-Host "    Name: $($p.name)" -ForegroundColor White
            if ($p.source) {
                $srcLabel = if ($p.source.instanceName) { "$($p.source.instanceName) (#$($p.source.instanceId))" } else { "Instance $($p.source.instanceId)" }
                Write-Host "    Source: $srcLabel" -ForegroundColor White
            }
            if ($p.destination) {
                $dstLabel = if ($p.destination.instanceName) { "$($p.destination.instanceName) (#$($p.destination.instanceId))" } else { "Instance $($p.destination.instanceId)" }
                Write-Host "    Destination: $dstLabel" -ForegroundColor White
            }
        }
        
        # Payload info
        if ($s.PSObject.Properties['payload'] -and $s.payload) {
            $pl = $s.payload
            Write-Host "`n  Payload:" -ForegroundColor Green
            if ($pl.payloadSizeKB) { Write-Host "    Size: $($pl.payloadSizeKB) KB (compressed=$($pl.isCompressed), type=$($pl.compressionType))" -ForegroundColor White }
            if ($pl.entityCount) { Write-Host "    Entities: $($pl.entityCount)" -ForegroundColor White }
            if ($pl.tileCount) { Write-Host "    Tiles: $($pl.tileCount)" -ForegroundColor White }
            if ($pl.uniqueItemTypes) { Write-Host "    Items: $($pl.totalItemCount) total ($($pl.uniqueItemTypes) types)" -ForegroundColor White }
            if ($pl.uniqueFluidTypes) { Write-Host "    Fluids: $($pl.totalFluidVolume) total ($($pl.uniqueFluidTypes) types)" -ForegroundColor White }
        }
        
        # Import metrics
        if ($s.PSObject.Properties['import'] -and $s.import) {
            $im = $s.import
            Write-Host "`n  Import Processing:" -ForegroundColor Green
            Write-Host "    Duration: $($im.total_ticks) ticks ($($im.total_ms)ms)" -ForegroundColor White
            Write-Host "    Entities: $($im.entities_created) created, $($im.entities_failed) failed" -ForegroundColor White
            Write-Host "    Tiles: $($im.tiles_placed) placed" -ForegroundColor White
            Write-Host "    Belt Items: $($im.belt_items_restored) restored" -ForegroundColor White
            Write-Host "    Fluids: $($im.fluids_restored) restored" -ForegroundColor White
            Write-Host "    Circuits: $($im.circuits_connected) connected" -ForegroundColor White
        }
        
        # Validation details
        if ($s.PSObject.Properties['validation'] -and $s.validation) {
            $v = $s.validation
            Write-Host "`n  Validation:" -ForegroundColor Green
            $itemIcon = if ($v.itemCountMatch) { "`u{2705}" } else { "`u{274C}" }
            $fluidIcon = if ($v.fluidCountMatch) { "`u{2705}" } else { "`u{274C}" }
            Write-Host "    $itemIcon Items: match=$($v.itemCountMatch)" -ForegroundColor $(if ($v.itemCountMatch) { "Green" } else { "Red" })
            Write-Host "    $fluidIcon Fluids: match=$($v.fluidCountMatch)" -ForegroundColor $(if ($v.fluidCountMatch) { "Green" } else { "Red" })
            Write-Host "    Entities: $($v.entityCount)" -ForegroundColor White
            
            # Show summary totals if available
            if ($v.PSObject.Properties['totalExpectedItems'] -and $v.PSObject.Properties['totalActualItems']) {
                Write-Host "    Item Totals: expected=$($v.totalExpectedItems), actual=$($v.totalActualItems)" -ForegroundColor White
            }
            if ($v.PSObject.Properties['totalExpectedFluids'] -and $v.PSObject.Properties['totalActualFluids']) {
                Write-Host "    Fluid Totals: expected=$([Math]::Round($v.totalExpectedFluids, 1)), actual=$([Math]::Round($v.totalActualFluids, 1))" -ForegroundColor White
            }
            
            # Entity type breakdown
            if ($v.PSObject.Properties['entityTypeBreakdown'] -and $v.entityTypeBreakdown) {
                Write-Host "`n  Entity Type Breakdown:" -ForegroundColor Green
                $entityTypes = @{}
                foreach ($prop in $v.entityTypeBreakdown.PSObject.Properties) {
                    $entityTypes[$prop.Name] = $prop.Value
                }
                $sorted = $entityTypes.GetEnumerator() | Sort-Object -Property Value -Descending
                foreach ($entry in $sorted) {
                    Write-Host "    $($entry.Value.ToString().PadLeft(5)) $($entry.Key)" -ForegroundColor White
                }
            }
            
            # Item counts breakdown (top items by count)
            if ($v.PSObject.Properties['expectedItemCounts'] -and $v.expectedItemCounts) {
                Write-Host "`n  Item Inventory (expected vs actual):" -ForegroundColor Green
                Write-Host "    $("Item".PadRight(40)) $("Expected".PadLeft(10)) $("Actual".PadLeft(10)) $("Diff".PadLeft(8))" -ForegroundColor DarkGray
                Write-Host "    $("-" * 70)" -ForegroundColor DarkGray
                
                $itemEntries = @{}
                foreach ($prop in $v.expectedItemCounts.PSObject.Properties) {
                    $itemEntries[$prop.Name] = @{ Expected = $prop.Value; Actual = 0 }
                }
                if ($v.PSObject.Properties['actualItemCounts'] -and $v.actualItemCounts) {
                    foreach ($prop in $v.actualItemCounts.PSObject.Properties) {
                        if ($itemEntries.ContainsKey($prop.Name)) {
                            $itemEntries[$prop.Name].Actual = $prop.Value
                        } else {
                            $itemEntries[$prop.Name] = @{ Expected = 0; Actual = $prop.Value }
                        }
                    }
                }
                
                $sortedItems = $itemEntries.GetEnumerator() | Sort-Object { $_.Value.Expected } -Descending
                foreach ($entry in $sortedItems) {
                    $diff = $entry.Value.Actual - $entry.Value.Expected
                    $diffStr = if ($diff -eq 0) { "  OK" } elseif ($diff -gt 0) { "+$diff" } else { "$diff" }
                    $diffColor = if ($diff -eq 0) { "Green" } elseif ($diff -gt 0) { "Red" } else { "Yellow" }
                    Write-Host "    $($entry.Key.PadRight(40)) $($entry.Value.Expected.ToString().PadLeft(10)) $($entry.Value.Actual.ToString().PadLeft(10)) " -NoNewline -ForegroundColor White
                    Write-Host "$($diffStr.PadLeft(8))" -ForegroundColor $diffColor
                }
            }
            
            # Fluid counts breakdown
            if ($v.PSObject.Properties['expectedFluidCounts'] -and $v.expectedFluidCounts) {
                Write-Host "`n  Fluid Inventory (expected vs actual):" -ForegroundColor Green
                Write-Host "    $("Fluid".PadRight(40)) $("Expected".PadLeft(12)) $("Actual".PadLeft(12))" -ForegroundColor DarkGray
                Write-Host "    $("-" * 66)" -ForegroundColor DarkGray
                
                $fluidEntries = @{}
                foreach ($prop in $v.expectedFluidCounts.PSObject.Properties) {
                    $fluidEntries[$prop.Name] = @{ Expected = $prop.Value; Actual = 0 }
                }
                if ($v.PSObject.Properties['actualFluidCounts'] -and $v.actualFluidCounts) {
                    foreach ($prop in $v.actualFluidCounts.PSObject.Properties) {
                        if ($fluidEntries.ContainsKey($prop.Name)) {
                            $fluidEntries[$prop.Name].Actual = $prop.Value
                        } else {
                            $fluidEntries[$prop.Name] = @{ Expected = 0; Actual = $prop.Value }
                        }
                    }
                }
                
                $sortedFluids = $fluidEntries.GetEnumerator() | Sort-Object { $_.Value.Expected } -Descending
                foreach ($entry in $sortedFluids) {
                    Write-Host "    $($entry.Key.PadRight(40)) $([Math]::Round($entry.Value.Expected, 1).ToString().PadLeft(12)) $([Math]::Round($entry.Value.Actual, 1).ToString().PadLeft(12))" -ForegroundColor White
                }
            }
        }
        
        if ($s.PSObject.Properties['error'] -and $s.error) {
            Write-Host "`n  Error: $($s.error)" -ForegroundColor Red
        }
    }

    Write-Host ""

} catch {
    Write-Host "Error: $_" -ForegroundColor Red
    exit 1
}
