<#
.SYNOPSIS
    Single exact-gate loss-detection test: a frozen-world fluid mismatch fails the transfer,
    banks a black box, discards the held destination artifact, and preserves the source.

.DESCRIPTION
    This is the adversarial tooth for the single frozen-world transfer verdict. The destination arms the
    one-shot `test_force_fluid_loss = N` hook. During import, after frozen fluid restoration but before
    the exact gate, the hook adds a non-destructive
    expected-fluid shortfall. The final debug import-result must report validation_success=false,
    failedStage=fluids, and fluidCountMatch=false. The black box must be banked before the held
    destination is discarded, while the source clone remains.
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [int]$LossAmount = 1500,
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "Single Exact Fluid Gate Loss Detection"

$clone = "fluidgateloss-$(Get-Date -Format 'HHmmss')"
$srcInstance = $null
$dstInstance = $null
$dstContainer = $null
$failed = 0
$TOTAL_ASSERTIONS = 8

try {
    if ($SourceHost -eq 0) {
        $SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
        if (-not $SourceHost) { throw "Source platform '$SourcePlatform' not found on any host" }
    }
    $DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
    $srcInstance  = "clusterio-host-$SourceHost-instance-1"
    $dstInstance  = "clusterio-host-$DestHost-instance-1"
    $dstContainer = "surface-export-host-$DestHost"
    $dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
    $dstLog       = "/clusterio/data/instances/$dstInstance/factorio-current.log"

    Write-Host "  host-$SourceHost -> host-$DestHost   clone: $clone   expected-fluid shortfall: $LossAmount" -ForegroundColor Gray
    Write-Host ""

    Write-Status "Cloning '$SourcePlatform' -> '$clone'..." -Type info
    $cl = New-TestPlatform -Instance $srcInstance -SourcePlatform $SourcePlatform -DestPlatform $clone
    if (-not $cl.success) { throw "Clone failed: $($cl.error)" }
    if ($cl.job_id) {
        Wait-ForJob -Instances @($srcInstance) -MaxWaitSeconds 90 -CheckScript "local j=(storage.async_jobs or {})['$($cl.job_id)']; rcon.print(j == nil and 'true' or 'false')" | Out-Null
    }
    Start-Sleep -Seconds 1
    $idx = Get-PlatformIndex -Instance $srcInstance -PlatformName $clone
    if (-not $idx) { throw "Clone did not materialize" }
    Write-Status "Clone ready (index $idx)" -Type success

    Invoke-Lua -Instance $dstInstance -Code "remote.call('surface_export','configure',{debug_mode=true, test_force_fluid_loss=$LossAmount}) rcon.print('armed')" | Out-Null
    Write-Status "Armed test_force_fluid_loss=$LossAmount on the destination" -Type info

    $baseLines = [int]((docker exec $dstContainer sh -c "wc -l < $dstLog 2>/dev/null").Trim())

    $destId = Get-ClusterioInstanceId -InstanceName $dstInstance
    docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json $dstScriptOut/failure_black_box_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
    Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
    Write-Status "Transfer initiated (expecting fluid-stage failure and destination discard)" -Type info

    $start = Get-Date; $resultFile = $null
    while (-not $resultFile -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
        Start-Sleep -Seconds 2
        $files = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${clone}_*.json" | Sort-Object -Descending)
        if ($files.Count -gt 0) { $resultFile = $files[0] }
    }
    if (-not $resultFile) { throw "No import-result after ${TimeoutSec}s (transfer may have stalled)" }
    Start-Sleep -Seconds 3

    $resultData = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $resultFile
    if (-not $resultData) { throw "Could not parse import-result $resultFile" }
    $valResult       = Get-SafeProperty $resultData "validation_result"
    $valSuccess      = Get-SafeProperty $resultData "validation_success"
    $failedStage     = Get-SafeProperty $valResult "failedStage"
    $fluidCountMatch = Get-SafeProperty $valResult "fluidCountMatch"
    $blackBoxRef     = Get-SafeProperty $valResult "failureBlackBox"

    $newLogText = (docker exec $dstContainer sh -c "tail -n +$($baseLines + 1) $dstLog 2>/dev/null") -join "`n"

    if ($newLogText -match "TEST HOOK\] Forced fluid loss: inflated missing expected") {
        Write-TestResult -TestId "fluidgate-hook-fired" -TestName "Fluid-loss hook ran (witnessed in destination log)" -Status "passed"
    } else {
        Write-TestResult -TestId "fluidgate-hook-fired" -TestName "Fluid-loss hook ran" -Status "failed" -Message "Did not find the '[TEST HOOK] Forced fluid loss' log line; the injection never ran"
        $failed++
    }

    if ($valSuccess -eq $false) {
        Write-TestResult -TestId "fluidgate-gate-failed" -TestName "Composite verdict fails on injected fluid shortfall" -Status "passed"
    } else {
        Write-TestResult -TestId "fluidgate-gate-failed" -TestName "Composite verdict fails on injected fluid shortfall" -Status "failed" -Message "validation_success=$valSuccess"
        $failed++
    }

    if ($failedStage -eq "fluids") {
        Write-TestResult -TestId "fluidgate-failed-stage" -TestName "Failure is labeled failedStage=fluids" -Status "passed"
    } else {
        Write-TestResult -TestId "fluidgate-failed-stage" -TestName "Failure is labeled failedStage=fluids" -Status "failed" -Message "failedStage=$failedStage"
        $failed++
    }

    if ($fluidCountMatch -eq $false) {
        Write-TestResult -TestId "fluidgate-fluidcount-mismatch" -TestName "Fluid count gate is what failed" -Status "passed"
    } else {
        Write-TestResult -TestId "fluidgate-fluidcount-mismatch" -TestName "Fluid count gate is what failed" -Status "failed" -Message "fluidCountMatch=$fluidCountMatch"
        $failed++
    }

    $blackBoxFile = Get-SafeProperty $blackBoxRef "file"
    $blackBox = if ($blackBoxFile) { Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $blackBoxFile } else { $null }
    if ($blackBox) {
        Write-TestResult -TestId "fluidgate-blackbox-written" -TestName "Always-on failure black box written before discard" -Status "passed"
    } else {
        Write-TestResult -TestId "fluidgate-blackbox-written" -TestName "Always-on failure black box written before discard" -Status "failed" -Message "failureBlackBox.file=$blackBoxFile"
        $failed++
    }

    $fluidDiff = if ($blackBox) { Get-SafeProperty (Get-SafeProperty $blackBox "diff") "fluids" } else { $null }
    $shortfallGrounded = $false
    if ($fluidDiff) {
        foreach ($prop in $fluidDiff.PSObject.Properties) {
            $delta = [double](Get-SafeProperty $prop.Value "delta")
            if ($delta -le -$LossAmount) { $shortfallGrounded = $true; break }
        }
    }
    if ($shortfallGrounded) {
        Write-TestResult -TestId "fluidgate-blackbox-shortfall" -TestName "Black box carries the injected per-name shortfall" -Status "passed"
    } else {
        Write-TestResult -TestId "fluidgate-blackbox-shortfall" -TestName "Black box carries the injected per-name shortfall" -Status "failed" -Message "No fluid diff delta <= -$LossAmount"
        $failed++
    }

    if (Get-PlatformIndex -Instance $srcInstance -PlatformName $clone) {
        Write-TestResult -TestId "fluidgate-source-preserved" -TestName "Source preserved after fluid gate failure" -Status "passed"
    } else {
        Write-TestResult -TestId "fluidgate-source-preserved" -TestName "Source preserved after fluid gate failure" -Status "failed" -Message "Source platform '$clone' was deleted despite fluid-stage failure"
        $failed++
    }

    if (-not (Get-PlatformIndex -Instance $dstInstance -PlatformName $clone)) {
        Write-TestResult -TestId "fluidgate-dest-discarded" -TestName "Held destination artifact discarded after exact-gate failure" -Status "passed"
    } else {
        Write-TestResult -TestId "fluidgate-dest-discarded" -TestName "Activated destination artifact discarded after fluid gate failure" -Status "failed" -Message "Destination platform '$clone' still exists after fluid-stage failure"
        $failed++
    }
}
finally {
    if ($dstInstance) {
        try { Invoke-Lua -Instance $dstInstance -Code "remote.call('surface_export','configure',{test_force_fluid_loss=0}) rcon.print('disarmed')" | Out-Null } catch {}
    }
    if ($srcInstance) { try { Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null } catch {} }
    if ($dstInstance) { try { Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null } catch {} }
    if ($srcInstance) { try { Step-Tick -Instance $srcInstance -Ticks 5 | Out-Null } catch {} }
}

Write-TestSummary -Passed ($TOTAL_ASSERTIONS - $failed) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
