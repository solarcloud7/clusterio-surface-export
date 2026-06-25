<#
.SYNOPSIS
    Rollback safety test — a transfer whose validation FAILS must NOT delete the source platform.

.DESCRIPTION
    This pins the two-phase-commit guarantee: the source platform is removed only AFTER the
    destination validates the import. We arm the debug-gated, one-shot `test_force_validation_failure`
    hook on the destination so its import deliberately fails validation, run a real transfer, then
    assert the source clone is still present (rolled back / unlocked, not deleted).

.PARAMETER SourcePlatform
    Platform to clone as the transfer subject (default: test).

.PARAMETER SourceHost
    Host holding the source platform (default: auto-detect).

.PARAMETER TimeoutSec
    Max seconds to wait for the destination import-result (default: 150).
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "🛟 Rollback Safety (failed validation -> source preserved)"

if ($SourceHost -eq 0) {
    $SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
    if (-not $SourceHost) { Write-Status "Source platform '$SourcePlatform' not found on any host" -Type error; exit 1 }
}
$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance  = "clusterio-host-$SourceHost-instance-1"
$dstInstance  = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$clone = "rollbacktest-$(Get-Date -Format 'HHmmss')"
Write-Host "  host-$SourceHost -> host-$DestHost   clone: $clone" -ForegroundColor Gray
Write-Host ""

$failed = 0

# 1. Clone a disposable platform on the source.
Write-Status "Cloning '$SourcePlatform' -> '$clone'..." -Type info
$cl = New-TestPlatform -Instance $srcInstance -SourcePlatform $SourcePlatform -DestPlatform $clone
if (-not $cl.success) { Write-Status "Clone failed: $($cl.error)" -Type error; exit 1 }
if ($cl.job_id) {
    Wait-ForJob -Instances @($srcInstance) -MaxWaitSeconds 90 -CheckScript "local j=(storage.async_jobs or {})['$($cl.job_id)']; rcon.print(j == nil and 'true' or 'false')" | Out-Null
}
Start-Sleep -Seconds 1
$idx = Get-PlatformIndex -Instance $srcInstance -PlatformName $clone
if (-not $idx) { Write-Status "Clone did not materialize" -Type error; exit 1 }
Write-Status "Clone ready (index $idx)" -Type success

# 2. Arm the one-shot fail hook on the DESTINATION (where import + validation run).
Invoke-Lua -Instance $dstInstance -Code "remote.call('surface_export','configure',{debug_mode=true, test_force_validation_failure=true}) rcon.print('armed')" | Out-Null
Write-Status "Armed test_force_validation_failure on the destination" -Type info

# 3. Transfer; the destination import is expected to fail validation.
$destId = Get-ClusterioInstanceId -InstanceName $dstInstance
docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
Write-Status "Transfer initiated (expecting validation failure)" -Type info

# 4. Wait for the import to finish (the result file is written regardless of pass/fail).
$start = Get-Date; $found = $false
while (-not $found -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Seconds 2
    $n = (docker exec $dstContainer sh -c "ls $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null | wc -l" 2>$null).Trim()
    if ($n -match '^\d+$' -and [int]$n -gt 0) { $found = $true }
}
if (-not $found) { Write-Status "No import-result after ${TimeoutSec}s (transfer may have stalled)" -Type warning }
Start-Sleep -Seconds 3   # let the rollback (source unlock, no delete) settle

# 5. ASSERT: the source platform is still present — the two-phase commit held (no delete on failure).
if (Get-PlatformIndex -Instance $srcInstance -PlatformName $clone) {
    Write-TestResult -TestId "rollback-source-preserved" -TestName "Failed validation leaves the source platform intact (two-phase commit)" -Status "passed"
} else {
    Write-TestResult -TestId "rollback-source-preserved" -TestName "Failed validation leaves the source platform intact (two-phase commit)" -Status "failed" -Message "Source platform '$clone' was DELETED despite validation failure -- the two-phase commit did not hold (data-loss risk)"
    $failed++
}

# 6. Cleanup: disarm the hook (defensive; it's one-shot) + remove the clone on both hosts.
Invoke-Lua -Instance $dstInstance -Code "remote.call('surface_export','configure',{test_force_validation_failure=false}) rcon.print('disarmed')" | Out-Null
Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null
Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
Step-Tick -Instance $srcInstance -Ticks 5 | Out-Null

Write-TestSummary -Passed $(if ($failed -eq 0) { 1 } else { 0 }) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
