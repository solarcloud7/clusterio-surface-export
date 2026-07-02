<#
.SYNOPSIS
    Entity cross-ground test — after import, the transfer details must be GROUNDED against a live physical
    count of the destination surface, so they can never claim more entities than actually landed.

.DESCRIPTION
    Adversarial fixture for the "catch" (see import-completion.lua CROSS-GROUND block + the
    connected-player-transfer / name-collision investigation). The reported entity count is the payload's
    EXPECTED count — nothing verified it against reality. We prove the cross-ground DETECTS a shortfall — not
    just that the happy path matches — by injecting a real post-gate entity loss.

    We arm the debug-gated, one-shot `test_force_entity_loss = N` hook on the destination. During import,
    AFTER the strict item gate passes but BEFORE the cross-ground count, the hook DESTROYS N non-hub entities
    on the destination surface (destroy() removes them + their contents, creating NO item-on-ground, so the
    surface entity count drops by exactly N). Then we WITNESS (not infer):
      A) the `[TEST HOOK] Forced entity loss` log line fired (the injection ran),
      B) entityCountMatch == false                 -> the cross-ground detected the shortfall,
      C) actualEntityCount < reportedEntityCount    -> the details report the LIVE count, not the payload's.

    GROUNDING (per data-integrity-test-grounding): this measures the invariant with an INDEPENDENT physical
    count (find_entities_filtered on the destination), not a validator self-report. If the cross-ground were
    reverted to trust `job.total_entities`, entityCountMatch would stay true here -> B and C go RED. The
    complementary half — a clean transfer grounds to a MATCH (entityCountMatch=true) — is exercised by every
    other roundtrip test's import-result now carrying actualEntityCount >= reportedEntityCount.

.PARAMETER SourcePlatform
    Platform to clone as the transfer subject (default: test).
.PARAMETER SourceHost
    Host holding the source platform (default: auto-detect).
.PARAMETER LossCount
    Number of entities to destroy on the destination before the cross-ground count (default: 10).
.PARAMETER TimeoutSec
    Max seconds to wait for the destination import-result (default: 150).
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [int]$LossCount = 10,
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "🔎 Entity Cross-Ground (details grounded to a live physical count of the destination)"

if ($SourceHost -eq 0) {
    $SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
    if (-not $SourceHost) { Write-Status "Source platform '$SourcePlatform' not found on any host" -Type error; exit 1 }
}
$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance  = "clusterio-host-$SourceHost-instance-1"
$dstInstance  = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstLog       = "/clusterio/data/instances/$dstInstance/factorio-current.log"
$clone = "xgroundtest-$(Get-Date -Format 'HHmmss')"
Write-Host "  host-$SourceHost -> host-$DestHost   clone: $clone   inject entity loss: $LossCount" -ForegroundColor Gray
Write-Host ""

$failed = 0
$TOTAL_ASSERTIONS = 3

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

# 2. Arm the one-shot entity-loss hook on the DESTINATION (where import + cross-ground run).
Invoke-Lua -Instance $dstInstance -Code "remote.call('surface_export','configure',{debug_mode=true, test_force_entity_loss=$LossCount}) rcon.print('armed')" | Out-Null
Write-Status "Armed test_force_entity_loss=$LossCount on the destination" -Type info

# 3. Baseline the destination factorio log so we scan ONLY the import window.
$baseLines = [int]((docker exec $dstContainer sh -c "wc -l < $dstLog 2>/dev/null").Trim())

# 4. Transfer; the destination import injects a real entity loss AFTER the gate.
$destId = Get-ClusterioInstanceId -InstanceName $dstInstance
Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
Write-Status "Transfer initiated (expecting cross-ground to flag the injected entity loss)" -Type info

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
$valResult   = Get-SafeProperty $resultData "validation_result"
$matchField  = Get-SafeProperty $valResult "entityCountMatch"
$reported    = Get-SafeProperty $valResult "reportedEntityCount"
$actual      = Get-SafeProperty $valResult "actualEntityCount"
Write-Host "  reportedEntityCount=$reported actualEntityCount=$actual entityCountMatch=$matchField" -ForegroundColor Gray

# New destination log lines from the import window.
$newLogText = (docker exec $dstContainer sh -c "tail -n +$($baseLines + 1) $dstLog 2>/dev/null") -join "`n"

# --- Assertions ---

# A) DIRECT witness the injection hook ran (don't infer from the verdict).
if ($newLogText -match "TEST HOOK\] Forced entity loss: destroyed \d+") {
    Write-TestResult -TestId "xground-hook-fired" -TestName "Entity-loss injection hook ran (witnessed in destination log)" -Status "passed"
} else {
    Write-TestResult -TestId "xground-hook-fired" -TestName "Entity-loss injection hook ran" -Status "failed" -Message "Did not find the '[TEST HOOK] Forced entity loss' log line — the injection never ran, so this test proves nothing"
    $failed++
}

# B) The cross-ground DETECTED the shortfall.
if ($matchField -eq $false) {
    Write-TestResult -TestId "xground-mismatch-detected" -TestName "Cross-ground flags the shortfall (entityCountMatch=false)" -Status "passed"
} else {
    Write-TestResult -TestId "xground-mismatch-detected" -TestName "Cross-ground flags the shortfall" -Status "failed" -Message "entityCountMatch=$matchField — the cross-ground did NOT detect a $LossCount-entity shortfall (reverted to trusting the payload count?)"
    $failed++
}

# C) The reported count is grounded to the LIVE surface (actual < reported).
if ($null -ne $actual -and $null -ne $reported -and [int]$actual -lt [int]$reported) {
    Write-TestResult -TestId "xground-actual-below-reported" -TestName "Details report the live count, not the payload ($actual < $reported)" -Status "passed"
} else {
    Write-TestResult -TestId "xground-actual-below-reported" -TestName "Details report the live count, not the payload" -Status "failed" -Message "actualEntityCount=$actual reportedEntityCount=$reported — expected actual < reported after a real entity loss"
    $failed++
}

# 6. Cleanup: disarm (defensive; one-shot) + remove the clone on both hosts.
Invoke-Lua -Instance $dstInstance -Code "remote.call('surface_export','configure',{test_force_entity_loss=0}) rcon.print('disarmed')" | Out-Null
Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null
Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
Step-Tick -Instance $srcInstance -Ticks 5 | Out-Null

Write-TestSummary -Passed ($TOTAL_ASSERTIONS - $failed) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
