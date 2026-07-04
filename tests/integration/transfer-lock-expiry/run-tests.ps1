<#
.SYNOPSIS
    Transfer-lock expiry self-test.

.DESCRIPTION
    Runs the in-module SurfaceLock.scan_transfer_expiries self-test through the surface_export remote
    interface. This grounds Phase-1 recovery in the live Lua module instead of source-grep tests.
#>
param(
    [int]$SourceHost = 1
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "Transfer Lock Expiry (source-side TTL unlock)"

$instance = "clusterio-host-$SourceHost-instance-1"
$failed = 0

$lua = "rcon.print(remote.call('surface_export', 'transfer_lock_selftest_json'))"
$raw = (Invoke-Lua -Instance $instance -Code $lua | Out-String).Trim()
$result = $null
try { $result = $raw | ConvertFrom-Json } catch { }

if (-not $result) {
    Write-TestResult -TestId "transfer-lock-selftest" -TestName "transfer lock expiry self-test runs" -Status "failed" -Message "No/invalid result from transfer_lock_selftest_json: $raw"
    $failed++
} elseif ([int]$result.failed -gt 0 -or [int]$result.passed -le 0) {
    $detailMsgs = @()
    foreach ($d in $result.details) { if (-not $d.ok) { $detailMsgs += "$($d.name): $($d.msg)" } }
    Write-TestResult -TestId "transfer-lock-selftest" -TestName "transfer lock expiry self-test passes" -Status "failed" -Message "passed=$($result.passed) failed=$($result.failed); $($detailMsgs -join '; ')"
    $failed++
} else {
    Write-TestResult -TestId "transfer-lock-selftest" -TestName "transfer lock expiry self-test passes ($($result.passed) checks)" -Status "passed"
}

Write-TestSummary -Passed $(if ($failed -eq 0) { 1 } else { 0 }) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
