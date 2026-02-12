#!/usr/bin/env pwsh
<#
.SYNOPSIS
    List all available transaction logs
.DESCRIPTION
    Shows a summary of all persisted transaction logs (last 10)
.EXAMPLE
    .\tools\list-transaction-logs.ps1
#>

$ErrorActionPreference = "Stop"

Write-Host "`n=== Available Transaction Logs ===" -ForegroundColor Cyan
Write-Host "Showing up to last 10 transfers`n" -ForegroundColor Yellow

try {
    # Read the transaction log file directly from the controller container
    $result = docker exec surface-export-controller cat /clusterio/database/surface_export_transaction_logs.json 2>&1

    if ($LASTEXITCODE -ne 0) {
        Write-Host "No transaction logs found yet." -ForegroundColor Yellow
        exit 0
    }

    # Parse JSON
    $logs = $result | ConvertFrom-Json

    if ($logs.Count -eq 0) {
        Write-Host "No transaction logs found." -ForegroundColor Yellow
        exit 0
    }

    Write-Host "Found $($logs.Count) transaction logs:`n" -ForegroundColor Green

    # Display table
    $logs | ForEach-Object {
        $info = $_.transferInfo
        $timestamp = [DateTimeOffset]::FromUnixTimeMilliseconds($info.startedAt).LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss")
        
        $duration = if ($info.completedAt) {
            [Math]::Round(($info.completedAt - $info.startedAt) / 1000, 1)
        } elseif ($info.failedAt) {
            [Math]::Round(($info.failedAt - $info.startedAt) / 1000, 1)
        } else {
            "N/A"
        }
        
        $statusColor = switch ($info.status) {
            "completed" { "Green" }
            "failed" { "Red" }
            default { "Yellow" }
        }
        
        $statusIcon = switch ($info.status) {
            "completed" { "`u{2705}" }  # Green check
            "failed" { "`u{274C}" }     # X
            default { "`u{23F3}" }      # Hourglass
        }
        
        Write-Host "$statusIcon " -NoNewline -ForegroundColor $statusColor
        Write-Host "$timestamp " -NoNewline -ForegroundColor White
        Write-Host "| " -NoNewline -ForegroundColor DarkGray
        Write-Host "$($info.platformName) " -NoNewline -ForegroundColor Cyan
        Write-Host "($($info.sourceInstanceId) → $($info.targetInstanceId)) " -NoNewline -ForegroundColor White
        Write-Host "| " -NoNewline -ForegroundColor DarkGray
        Write-Host "$($info.status) " -NoNewline -ForegroundColor $statusColor
        Write-Host "| " -NoNewline -ForegroundColor DarkGray
        Write-Host "${duration}s " -NoNewline -ForegroundColor White
        Write-Host "| " -NoNewline -ForegroundColor DarkGray
        Write-Host "$($_.transferId)" -ForegroundColor DarkGray
        
        if ($info.PSObject.Properties['error'] -and $info.error) {
            Write-Host "    Error: $($info.error)" -ForegroundColor Red
        }
    }

    Write-Host "`nTo view details: " -NoNewline -ForegroundColor Yellow
    Write-Host ".\tools\get-transaction-log.ps1 -TransferId <transfer_id>" -ForegroundColor White
    Write-Host "Latest transfer:  " -NoNewline -ForegroundColor Yellow
    Write-Host ".\tools\get-transaction-log.ps1`n" -ForegroundColor White

} catch {
    Write-Host "Error: $_" -ForegroundColor Red
    exit 1
}
