<#
.SYNOPSIS
    Strict-gate loss-detection test — a transfer with a REAL, unaccounted item loss must FAIL validation,
    and the two-phase commit must preserve the source (no silent data loss).

.DESCRIPTION
    This is the mechanical anti-loop guard for the strict transfer gate (see the validation-timing-trilemma
    memory). The gate counts the destination AFTER held items are restored while machines stay deactivated,
    so it sees a COMPLETE physical reality and can tolerate only the tiny belt-restoration floor. We prove it
    actually DETECTS loss — not just that the happy path passes — by injecting a real shortfall.

    We arm the debug-gated, one-shot `test_force_item_loss = N` hook on the destination. During import,
    AFTER held-restore but BEFORE the gate, the hook removes N of the most-abundant item from the surface
    (an UNACCOUNTED loss — NOT routed through failedEntityLosses/overflow). Then we WITNESS (not infer):
      A) the `[TEST HOOK] Forced item loss` log line fired (the injection ran),
      B) validation_success == false               -> the strict gate detected the loss,
      C) the source clone still exists              -> two-phase commit preserved it (no silent delete),
      D) itemCountMatch == false                    -> the item gate (not a fluke) is what failed.

    LITMUS (why this is grounded, per data-integrity-test-grounding): under the OLD loose gate (95% loss AND
    >100 absolute), removing 500 of a multi-thousand-count item passes -> source deleted -> B and C would
    FAIL. So this test goes RED the moment anyone reverts the gate to loose. The complementary half — the
    strict gate PASSES clean transfers — is covered by platform-roundtrip / entity-roundtrip running under
    strict=true.

.PARAMETER SourcePlatform
    Platform to clone as the transfer subject (default: test).
.PARAMETER SourceHost
    Host holding the source platform (default: auto-detect).
.PARAMETER LossCount
    Number of items to remove on the destination before the gate (default: 500 — well above the strict
    per-item tolerance, well under the old loose 95% gate, so it discriminates strict vs loose).
.PARAMETER TimeoutSec
    Max seconds to wait for the destination import-result (default: 150).
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [int]$LossCount = 500,
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "🎯 Strict-Gate Loss Detection (real injected loss -> gate fails, source preserved)"

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
$clone = "gatelosstest-$(Get-Date -Format 'HHmmss')"
Write-Host "  host-$SourceHost -> host-$DestHost   clone: $clone   inject loss: $LossCount" -ForegroundColor Gray
Write-Host ""

$failed = 0
$TOTAL_ASSERTIONS = 4

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

# 2. Arm the one-shot loss-injection hook on the DESTINATION (where import + validation run).
Invoke-Lua -Instance $dstInstance -Code "remote.call('surface_export','configure',{debug_mode=true, test_force_item_loss=$LossCount}) rcon.print('armed')" | Out-Null
Write-Status "Armed test_force_item_loss=$LossCount on the destination" -Type info

# 3. Baseline the destination factorio log so we scan ONLY the import window.
$baseLines = [int]((docker exec $dstContainer sh -c "wc -l < $dstLog 2>/dev/null").Trim())

# 4. Transfer; the destination import injects a real loss and is expected to FAIL the strict gate.
$destId = Get-ClusterioInstanceId -InstanceName $dstInstance
docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
Write-Status "Transfer initiated (expecting strict-gate failure on injected loss)" -Type info

# 5. Wait for the import-result file (written regardless of pass/fail).
$start = Get-Date; $resultFile = $null
while (-not $resultFile -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Seconds 2
    $files = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${clone}_*.json")
    if ($files.Count -gt 0) { $resultFile = $files[0] }
}
if (-not $resultFile) { Write-Status "No import-result after ${TimeoutSec}s (transfer may have stalled)" -Type error; exit 1 }
Start-Sleep -Seconds 3   # let the rollback (source unlock, no delete) settle

$resultData = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $resultFile
if (-not $resultData) { Write-Status "Could not parse import-result $resultFile" -Type error; exit 1 }
$valResult     = Get-SafeProperty $resultData "validation_result"
$valSuccess    = Get-SafeProperty $resultData "validation_success"
$itemCountMatch = Get-SafeProperty $valResult "itemCountMatch"

# New destination log lines from the import window.
$newLogText = (docker exec $dstContainer sh -c "tail -n +$($baseLines + 1) $dstLog 2>/dev/null") -join "`n"

# --- Assertions ---

# A) DIRECT witness the injection hook ran (don't infer from the verdict).
if ($newLogText -match "TEST HOOK\] Forced item loss: removed \d+") {
    Write-TestResult -TestId "gateloss-hook-fired" -TestName "Loss-injection hook ran (witnessed in destination log)" -Status "passed"
} else {
    Write-TestResult -TestId "gateloss-hook-fired" -TestName "Loss-injection hook ran" -Status "failed" -Message "Did not find the '[TEST HOOK] Forced item loss' log line — the injection never ran, so this test proves nothing"
    $failed++
}

# B) The strict gate DETECTED the loss (validation failed).
if ($valSuccess -eq $false) {
    Write-TestResult -TestId "gateloss-gate-failed" -TestName "Strict gate fails on a real injected loss (validation_success=false)" -Status "passed"
} else {
    Write-TestResult -TestId "gateloss-gate-failed" -TestName "Strict gate fails on a real injected loss" -Status "failed" -Message "validation_success=$valSuccess — the gate did NOT detect a $LossCount-item loss (gate is too loose / reverted)"
    $failed++
}

# C) Two-phase commit preserved the source (the data-loss guard).
if (Get-PlatformIndex -Instance $srcInstance -PlatformName $clone) {
    Write-TestResult -TestId "gateloss-source-preserved" -TestName "Source preserved after gate failure (two-phase commit)" -Status "passed"
} else {
    Write-TestResult -TestId "gateloss-source-preserved" -TestName "Source preserved after gate failure" -Status "failed" -Message "Source platform '$clone' was DELETED despite a real loss — silent data loss (the exact failure this gate exists to prevent)"
    $failed++
}

# D) It was the ITEM gate that failed (not a fluke / unrelated mismatch).
if ($itemCountMatch -eq $false) {
    Write-TestResult -TestId "gateloss-itemcount-mismatch" -TestName "Item count gate is what failed (itemCountMatch=false)" -Status "passed"
} else {
    Write-TestResult -TestId "gateloss-itemcount-mismatch" -TestName "Item count gate is what failed" -Status "failed" -Message "itemCountMatch=$itemCountMatch — validation failed for some OTHER reason than the injected item loss"
    $failed++
}

# 6. Cleanup: disarm (defensive; one-shot) + remove the clone on both hosts.
Invoke-Lua -Instance $dstInstance -Code "remote.call('surface_export','configure',{test_force_item_loss=0}) rcon.print('disarmed')" | Out-Null
Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null
Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
Step-Tick -Instance $srcInstance -Ticks 5 | Out-Null

Write-TestSummary -Passed ($TOTAL_ASSERTIONS - $failed) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
