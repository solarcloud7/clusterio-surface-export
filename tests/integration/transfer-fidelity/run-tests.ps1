<#
.SYNOPSIS
    Transfer-fidelity meter test — a clean transfer must report ~0 item loss (no phantom).

.DESCRIPTION
    Items physically transfer at ~100%, but the validation USED to report ~400 phantom "loss" because
    inserter held items are restored only in the post-validation activation phase and so were absent from
    the pre-activation count while still counted in `expected`. The fix subtracts those deferred held items
    from expected at the gate. This test guards that fix: on a clean transfer, the validation's reported
    `totalItemLoss` must be small (belt-drift residual only), NOT the ~400 it was before. A regression
    (held items not subtracted) would spike totalItemLoss back to the hundreds and fail here.

.PARAMETER MaxLoss
    Maximum tolerated reported item loss (belt-drift residual). Default 50 (observed ~8; pre-fix was ~400).
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [int]$MaxLoss = 50,
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "📊 Transfer Fidelity (clean transfer reports ~0 item loss — no phantom)"

if ($SourceHost -eq 0) {
    $SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
    if (-not $SourceHost) { Write-Status "Source platform '$SourcePlatform' not found on any host" -Type error; exit 1 }
}
$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance = "clusterio-host-$SourceHost-instance-1"
$dstInstance = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$clone = "fidtest-$(Get-Date -Format 'HHmmss')"
Write-Host "  host-$SourceHost -> host-$DestHost   clone: $clone" -ForegroundColor Gray
Write-Host ""

$failed = 0
$TOTAL_ASSERTIONS = 2

# 1. Clone.
$cl = New-TestPlatform -Instance $srcInstance -SourcePlatform $SourcePlatform -DestPlatform $clone
if (-not $cl.success) { Write-Status "Clone failed: $($cl.error)" -Type error; exit 1 }
if ($cl.job_id) {
    Wait-ForJob -Instances @($srcInstance) -MaxWaitSeconds 90 -CheckScript "local j=(storage.async_jobs or {})['$($cl.job_id)']; rcon.print(j == nil and 'true' or 'false')" | Out-Null
}
Start-Sleep -Seconds 1
$idx = Get-PlatformIndex -Instance $srcInstance -PlatformName $clone
if (-not $idx) { Write-Status "Clone did not materialize" -Type error; exit 1 }
Write-Status "Clone ready (index $idx)" -Type success

# 2. Transfer.
$destId = Get-ClusterioInstanceId -InstanceName $dstInstance
docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
Write-Status "Transfer initiated..." -Type info

# 3. Wait for the import-result.
$start = Get-Date; $rf = $null
while (-not $rf -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Seconds 2
    $f = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${clone}_*.json")
    if ($f.Count -gt 0) { $rf = $f[0] }
}
if (-not $rf) { Write-Status "No import-result after ${TimeoutSec}s (transfer may have stalled)" -Type error; exit 1 }
Start-Sleep -Seconds 2

$rd = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $rf
$vr = Get-SafeProperty $rd "validation_result"
$totalLoss = [int](Get-SafeProperty $vr "totalItemLoss")
$valSuccess = Get-SafeProperty $rd "validation_success"
Write-Status "Reported totalItemLoss=$totalLoss; validation_success=$valSuccess" -Type info

# A) The phantom is gone: reported item loss is small (belt-drift residual), not the ~400 it was pre-fix.
if ($totalLoss -ge 0 -and $totalLoss -le $MaxLoss) {
    Write-TestResult -TestId "fid-no-phantom-loss" -TestName "Clean transfer reports <= $MaxLoss item loss (no held-item phantom)" -Status "passed"
} else {
    Write-TestResult -TestId "fid-no-phantom-loss" -TestName "Clean transfer reports <= $MaxLoss item loss" -Status "failed" -Message "totalItemLoss=$totalLoss (> $MaxLoss) -- the held-item meter fix likely regressed (pre-fix was ~400)"
    $failed++
}

# B) The gate still passes a clean transfer.
if ($valSuccess -eq $true) {
    Write-TestResult -TestId "fid-validation-passes" -TestName "Clean transfer passes validation" -Status "passed"
} else {
    Write-TestResult -TestId "fid-validation-passes" -TestName "Clean transfer passes validation" -Status "failed" -Message "validation_success=$valSuccess on a clean transfer"
    $failed++
}

# 4. Cleanup (source deleted on success; remove dest clone + any source remnant).
Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null

Write-TestSummary -Passed ($TOTAL_ASSERTIONS - $failed) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
