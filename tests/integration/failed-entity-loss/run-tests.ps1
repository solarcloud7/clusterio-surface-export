<#
.SYNOPSIS
    Failed-entity-loss attribution test (Pitfall #20) — a transfer in which an inventory-bearing
    entity fails to place must still VALIDATE, with the lost items attributed to failedEntityLosses
    and SUBTRACTED from expected so they are not reported as a false "lost items" mismatch.

.DESCRIPTION
    When create_entity returns nil (mod mismatch / prototype collision), the items inside that entity
    are never placed but remain in the source "expected" totals. The import tallies them into
    job.failed_entity_losses and subtracts them from expected before validation, so a failed entity
    does not cause a false validation failure.

    We arm the debug-gated, one-shot `test_force_entity_failure` hook on the destination so the first
    inventory-bearing entity deliberately fails to place, run a real transfer, then WITNESS (not infer)
    the attribution path:
      A) failedEntityLosses is populated (entity_count >= 1, total_items > 0)  -> the hook fired
      B) "Adjusted expected totals: subtracted N items ... failed entities" log -> subtraction ran
      C) validation_success == true                                            -> loss accounted, not a mismatch
      D) no "Error while running event" in the import window                    -> failing an entity didn't
                                                                                  trip belt/circuit restoration

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

Write-TestHeader "🧩 Failed-Entity-Loss Attribution (failed placement -> loss attributed, validation still passes)"

if ($SourceHost -eq 0) {
    $SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
    if (-not $SourceHost) { Write-Status "Source platform '$SourcePlatform' not found on any host" -Type error; exit 1 }
}
$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance  = "clusterio-host-$SourceHost-instance-1"
$dstInstance  = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$dstLog       = "/clusterio/data/instances/$dstInstance/factorio-current.log"
$clone = "failentitytest-$(Get-Date -Format 'HHmmss')"
Write-Host "  host-$SourceHost -> host-$DestHost   clone: $clone" -ForegroundColor Gray
Write-Host ""

$failed = 0
$TOTAL_ASSERTIONS = 5

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

# 2. Arm the one-shot entity-failure hook on the DESTINATION (where import + validation run).
Invoke-Lua -Instance $dstInstance -Code "remote.call('surface_export','configure',{debug_mode=true, test_force_entity_failure=true}) rcon.print('armed')" | Out-Null
Write-Status "Armed test_force_entity_failure on the destination" -Type info

# 3. Baseline the destination factorio log so we can scan ONLY the import window.
$baseLines = [int]((docker exec $dstContainer sh -c "wc -l < $dstLog 2>/dev/null").Trim())

# 4. Transfer; the destination import is expected to fail one entity but still validate.
$destId = Get-ClusterioInstanceId -InstanceName $dstInstance
docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
Write-Status "Transfer initiated (expecting one failed entity)" -Type info

# 5. Wait for the import-result file (written regardless of pass/fail).
$start = Get-Date; $resultFile = $null
while (-not $resultFile -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Seconds 2
    $files = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${clone}_*.json")
    if ($files.Count -gt 0) { $resultFile = $files[0] }
}
if (-not $resultFile) { Write-Status "No import-result after ${TimeoutSec}s (transfer may have stalled)" -Type error; exit 1 }
Start-Sleep -Seconds 2

$resultData = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $resultFile
if (-not $resultData) { Write-Status "Could not parse import-result $resultFile" -Type error; exit 1 }

# New destination log lines from the import window.
$newLogText = (docker exec $dstContainer sh -c "tail -n +$($baseLines + 1) $dstLog 2>/dev/null") -join "`n"

# --- Assertions ---
$fel         = Get-SafeProperty (Get-SafeProperty $resultData "validation_result") "failedEntityLosses"
$entityCount = [int](Get-SafeProperty $fel "entity_count")
$totalItems  = [int](Get-SafeProperty $fel "total_items")
$valSuccess  = Get-SafeProperty $resultData "validation_success"

# A) DIRECT witness the forced-failure hook ran. The 'test' platform also has an incidental 0-item
#    natural failure (an item-on-ground / item-entity), so entity_count >= 1 alone CANNOT prove OUR
#    hook fired — witness the [TEST HOOK] log line itself.
if ($newLogText -match "TEST HOOK.*Forcing placement failure for inventory-bearing entity") {
    Write-TestResult -TestId "fel-hook-fired" -TestName "Forced-failure hook ran (witnessed in destination log)" -Status "passed"
} else {
    Write-TestResult -TestId "fel-hook-fired" -TestName "Forced-failure hook ran" -Status "failed" -Message "Did not find the '[TEST HOOK] Forcing placement failure' log line — the hook never matched an inventory-bearing entity"
    $failed++
}

# B) The failed entity's items were attributed to failedEntityLosses (total_items > 0).
if ($entityCount -ge 1 -and $totalItems -gt 0) {
    Write-TestResult -TestId "fel-loss-attributed" -TestName "Failed-entity items attributed ($entityCount failed / $totalItems items)" -Status "passed"
} else {
    Write-TestResult -TestId "fel-loss-attributed" -TestName "Failed-entity items attributed" -Status "failed" -Message "failedEntityLosses entity_count=$entityCount total_items=$totalItems (no items attributed)"
    $failed++
}

# C) Direct witness: the expected-count subtraction route executed (don't infer it).
if ($newLogText -match "Adjusted expected totals: subtracted \d+ items.*failed entities") {
    Write-TestResult -TestId "fel-expected-adjusted" -TestName "Expected totals adjusted to exclude failed-entity items (subtraction ran)" -Status "passed"
} else {
    Write-TestResult -TestId "fel-expected-adjusted" -TestName "Expected totals adjusted to exclude failed-entity items" -Status "failed" -Message "Missing the '[Import] Adjusted expected totals: subtracted ... failed entities' log line in the import window"
    $failed++
}

# D) Validation still PASSES despite the failed entity (the loss was accounted for, not a false mismatch).
if ($valSuccess -eq $true) {
    Write-TestResult -TestId "fel-validation-passes" -TestName "Validation passes despite the failed entity (loss subtracted, not a false mismatch)" -Status "passed"
} else {
    Write-TestResult -TestId "fel-validation-passes" -TestName "Validation passes despite the failed entity" -Status "failed" -Message "validation_success=$valSuccess (failed-entity items were NOT correctly subtracted from expected)"
    $failed++
}

# E) Robustness: failing an entity must not trip a downstream restoration phase (belt/circuit/inserter).
if ($newLogText -match "Error while running event") {
    Write-TestResult -TestId "fel-no-lua-error" -TestName "Import completes with no Lua error" -Status "failed" -Message "A Lua error appeared in the destination import window — failing an entity tripped a downstream restoration phase"
    $failed++
} else {
    Write-TestResult -TestId "fel-no-lua-error" -TestName "Import completes with no Lua error" -Status "passed"
}

# 6. Cleanup: disarm (defensive; one-shot) + remove the clone on both hosts.
Invoke-Lua -Instance $dstInstance -Code "remote.call('surface_export','configure',{test_force_entity_failure=false}) rcon.print('disarmed')" | Out-Null
Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null
Step-Tick -Instance $srcInstance -Ticks 5 | Out-Null

Write-TestSummary -Passed ($TOTAL_ASSERTIONS - $failed) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
