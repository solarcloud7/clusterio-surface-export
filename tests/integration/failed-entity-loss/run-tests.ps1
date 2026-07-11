<#
.SYNOPSIS
    Failed-entity-loss attribution test (Pitfall #20) — a transfer in which an inventory-bearing
    entity fails to place must retain quality-keyed attribution while the test hook deliberately
    FAILS the overall verdict so a leaked hook cannot delete the source.

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
$TOTAL_ASSERTIONS = 9

try {

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

# Add a deterministic entity carrying both an inventory item and fluid, so this probe grounds both
# failed-entity adjustment axes in one transfer.
$fixture = Invoke-Lua -Instance $srcInstance -ReturnJson -Code @"
local p=game.forces.player.platforms[$idx]; local s=p and p.surface
local out={created=false,item=0,fluid=0,x=0,y=0}
if s then
    p.force.recipes['heavy-oil-cracking'].enabled=true
  for _,tile in ipairs(s.find_tiles_filtered({name='space-platform-foundation'})) do
    local pos=tile.position
    if s.can_place_entity({name='chemical-plant',position=pos,force=p.force}) then
      local e=s.create_entity({name='chemical-plant',position=pos,force=p.force})
      if e then
        e.set_recipe('heavy-oil-cracking')
        local inv=e.get_module_inventory()
        out.item=inv and inv.insert({name='speed-module',count=3,quality='legendary'}) or 0
        for i=1,#e.fluidbox do
          local ok=pcall(function() e.fluidbox[i]={name='heavy-oil',amount=20,temperature=25} end)
          local f=e.fluidbox[i]
          if ok and f and f.amount>0 then out.fluid=f.amount; break end
        end
        out.created=true
        out.x=e.position.x
        out.y=e.position.y
        break
      end
    end
  end
end
rcon.print(helpers.table_to_json(out))
"@
if (-not $fixture.created -or [int]$fixture.item -ne 3 -or [double]$fixture.fluid -le 0) {
    throw "Could not build deterministic inventory+fluid failed-entity fixture"
}
Write-Status "Fixture ready (items=$($fixture.item), fluid=$($fixture.fluid))" -Type success

# 2. Arm the one-shot entity-failure hook on the DESTINATION (where import + validation run).
$hookMode = "inventory_and_fluid_at:$($fixture.x):$($fixture.y)"
Invoke-Lua -Instance $dstInstance -Code "remote.call('surface_export','configure',{debug_mode=true, test_force_entity_failure='$hookMode'}) rcon.print('armed')" | Out-Null
Write-Status "Armed inventory+fluid test_force_entity_failure on the destination" -Type info

# 3. Baseline the destination factorio log so we can scan ONLY the import window.
$baseLines = [int]((docker exec $dstContainer sh -c "wc -l < $dstLog 2>/dev/null").Trim())

# 4. Transfer; the item/fluid parity checks should pass after attribution, while the test hook's
# fail-safe marker forces the overall verdict to fail and preserve the source.
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
$totalFluids = [double](Get-SafeProperty $fel "total_fluids")
$valSuccess  = Get-SafeProperty $resultData "validation_success"

# A) DIRECT witness the forced-failure hook ran. The 'test' platform also has an incidental 0-item
#    natural failure (an item-on-ground / item-entity), so entity_count >= 1 alone CANNOT prove OUR
#    hook fired — witness the [TEST HOOK] log line itself.
if ($newLogText -match "TEST HOOK.*Forcing placement failure for inventory_and_fluid_at:.* entity") {
    Write-TestResult -TestId "fel-hook-fired" -TestName "Forced-failure hook ran (witnessed in destination log)" -Status "passed"
} else {
    Write-TestResult -TestId "fel-hook-fired" -TestName "Forced-failure hook ran" -Status "failed" -Message "Did not find the '[TEST HOOK] Forcing placement failure' log line — the hook never matched an inventory-bearing entity"
    $failed++
}

if ($totalFluids -gt 0) {
    Write-TestResult -TestId "fel-fluid-attributed" -TestName "Failed-entity fluids attributed ($totalFluids fluid)" -Status "passed"
} else {
    Write-TestResult -TestId "fel-fluid-attributed" -TestName "Failed-entity fluids attributed" -Status "failed" -Message "failedEntityLosses total_fluids=$totalFluids"
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
if ($newLogText -match "Adjusted expected totals for \d+ failed entities: -\d+ items, -[1-9][\d.]* fluids") {
    Write-TestResult -TestId "fel-expected-adjusted" -TestName "Expected totals adjusted for failed-entity items and fluids" -Status "passed"
} else {
    Write-TestResult -TestId "fel-expected-adjusted" -TestName "Expected totals adjusted to exclude failed-entity items" -Status "failed" -Message "Missing the '[Import] Adjusted expected totals: subtracted ... failed entities' log line in the import window"
    $failed++
}

$validation = Get-SafeProperty $resultData "validation_result"
if ((Get-SafeProperty $validation "itemCountMatch") -eq $true -and (Get-SafeProperty $validation "fluidCountMatch") -eq $true) {
    Write-TestResult -TestId "fel-both-gates-pass" -TestName "Exact item and fluid gates both pass after attribution" -Status "passed"
} else {
    Write-TestResult -TestId "fel-both-gates-pass" -TestName "Exact item and fluid gates both pass after attribution" -Status "failed" -Message "itemCountMatch=$(Get-SafeProperty $validation 'itemCountMatch') fluidCountMatch=$(Get-SafeProperty $validation 'fluidCountMatch')"
    $failed++
}

# D) The mutating hook forces the overall verdict to FAIL even though the accounting gates pass.
if ($valSuccess -eq $false -and (Get-SafeProperty $validation "testForcedEntityFailure") -eq $true) {
    Write-TestResult -TestId "fel-hook-fails-safe" -TestName "Forced entity hook fails overall verdict after exact attribution" -Status "passed"
} else {
    Write-TestResult -TestId "fel-hook-fails-safe" -TestName "Forced entity hook fails overall verdict" -Status "failed" -Message "validation_success=$valSuccess testForcedEntityFailure=$(Get-SafeProperty $validation 'testForcedEntityFailure')"
    $failed++
}

$failedItems = Get-SafeProperty $fel "items"
$legendaryModules = [int](Get-SafeProperty $failedItems "speed-module:legendary")
if ($legendaryModules -eq 3) {
    Write-TestResult -TestId "fel-quality-key" -TestName "Failed legendary modules retain their quality key" -Status "passed"
} else {
    Write-TestResult -TestId "fel-quality-key" -TestName "Failed legendary modules retain their quality key" -Status "failed" -Message "speed-module:legendary=$legendaryModules (expected 3)"
    $failed++
}

# E) The source clone remains present because the fail-safe verdict blocks source deletion.
$sourceStillPresent = Get-PlatformIndex -Instance $srcInstance -PlatformName $clone
if ($sourceStillPresent) {
    Write-TestResult -TestId "fel-source-preserved" -TestName "Source preserved after forced entity failure" -Status "passed"
} else {
    Write-TestResult -TestId "fel-source-preserved" -TestName "Source preserved after forced entity failure" -Status "failed" -Message "Source platform was deleted despite the fail-safe test-hook verdict"
    $failed++
}

# F) Robustness: failing an entity must not trip a downstream restoration phase (belt/circuit/inserter).
if ($newLogText -match "Error while running event") {
    Write-TestResult -TestId "fel-no-lua-error" -TestName "Import completes with no Lua error" -Status "failed" -Message "A Lua error appeared in the destination import window — failing an entity tripped a downstream restoration phase"
    $failed++
} else {
    Write-TestResult -TestId "fel-no-lua-error" -TestName "Import completes with no Lua error" -Status "passed"
}

} finally {
    # Guaranteed cleanup: a failed assertion or early exit must never leak the mutating hook.
    Invoke-Lua -Instance $dstInstance -Code "remote.call('surface_export','configure',{test_force_entity_failure=false}) rcon.print('disarmed')" | Out-Null
    Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
    Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null
    Step-Tick -Instance $srcInstance -Ticks 5 | Out-Null
}

Write-TestSummary -Passed ($TOTAL_ASSERTIONS - $failed) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
