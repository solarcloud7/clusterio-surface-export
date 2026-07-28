<#
.SYNOPSIS
    Missing-source-positions payload refusal — the successor contract of the 550-belt aggregate-deficit replay.

.DESCRIPTION
    HISTORY: this test replayed a banked 550-belt payload through the legacy consolidation
    restore and asserted the exact gate preserved 19 processing units across 5 runs — the
    kill-measurement for the aggregate-deficit loss class. The legacy restore (consolidation +
    hub-deficit recovery + first-fit fallback) was DELETED 2026-07-27 (owner purge
    order): item_source_positions is REQUIRED and a payload without it is REFUSED at import, so the loss class
    this replay measured is structurally impossible — there is no path left that can lose items.

    THE FIXTURE IS NOW THE ADVERSARY: fixture.json is a REAL historical payload without item_source_positions, which
    makes it the perfect end-to-end probe for the refusal contract (review finding F1: this
    import runs on the bare on_tick path where an uncaught throw kills the headless server).
    The upload must:
      1. complete WITHOUT killing the server (the F1 crash class),
      2. report the operation FAILED (failedStage "belts", missing-source-positions refusal — review F2: belt
         anomalies must fail non-transfer imports too, never a silent success),
      3. physically restore ZERO belt items (nothing routed to any fallback), and
      4. log the loud refusal line.
#>
param(
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "Missing-source-positions payload refusal (legacy replay retired)"
$prefix = "belt-loss-replay-"
$instances = @("clusterio-host-1-instance-1", "clusterio-host-2-instance-1")
$failed = 0
$passed = 0

function Remove-Fixture {
    foreach ($instance in $instances) {
        Remove-PlatformSurfacesWhere -Instance $instance -PredicateLua "string.find(p.name, '$prefix', 1, true) == 1" | Out-Null
    }
}

function Count-BeltProcessingUnits([string]$Instance, [string]$PlatformName) {
    $json = Invoke-Lua -Instance $Instance -Code @"
local p=nil
for _,candidate in pairs(game.forces.player.platforms or {}) do if candidate.name=='$PlatformName' then p=candidate break end end
if not p then rcon.print(helpers.table_to_json({missing=true})) return end
local belt=0
for _,e in ipairs(p.surface.find_entities_filtered({type={'transport-belt','underground-belt','splitter','linked-belt','loader','loader-1x1'}})) do
    for line=1,e.get_max_transport_line_index() do belt=belt+e.get_transport_line(line).get_item_count('processing-unit') end
end
rcon.print(helpers.table_to_json({belt=belt,entities=#p.surface.find_entities_filtered({})}))
"@
    return $json | ConvertFrom-Json
}

try {
    Remove-Fixture
    $sourceHost = Resolve-PlatformHost -PlatformName (Get-TransferFixturePlatform)
    if (-not $sourceHost) { throw "transfer fixture platform not found" }
    $sourceInstance = "clusterio-host-$sourceHost-instance-1"
    $sourceContainer = "surface-export-host-$sourceHost"
    $sourceId = Get-ClusterioInstanceId -InstanceName $sourceInstance
    $fixture = Join-Path $PSScriptRoot "fixture.json"
    docker cp $fixture surface-export-controller:/tmp/belt-loss-replay.json | Out-Null

    $runName = "$prefix$(Get-Date -Format 'HHmmss')"
    $upload = docker exec surface-export-controller sh -c "npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error surface-export upload-import /tmp/belt-loss-replay.json $sourceId player $runName"
    if ($LASTEXITCODE -ne 0) { throw "fixture upload failed: $upload" }

    # The import creates the platform's entities; only the belts phase refuses. Wait for the job
    # to COMPLETE (result record present), not just the platform to exist.
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $verdict = $null
    while (-not $verdict -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $json = Invoke-Lua -Instance $sourceInstance -Code @"
local out={}
for id,r in pairs(storage.async_job_results or {}) do
    if r.type=='import' and r.platform_name=='$runName' and r.complete then
        out={found=true, status=r.status,
            success=(r.validation and r.validation.success),
            failedStage=(r.validation and r.validation.failedStage),
            details=(r.validation and r.validation.mismatchDetails)}
    end
end
rcon.print(helpers.table_to_json(out))
"@
        $parsed = $json | ConvertFrom-Json
        if (Get-SafeProperty $parsed "found") { $verdict = $parsed }
    }
    if (-not $verdict) { throw "upload-import job never completed — if the instance died, this is the F1 crash class" }

    # 1. Server alive after importing a hostile-shaped payload (any successful RCON proves it,
    #    and the verdict read above already did one — assert explicitly anyway).
    $alive = Invoke-Lua -Instance $sourceInstance -Code "rcon.print('alive')"
    if ($alive -match "alive") {
        Write-TestResult -TestId "missing-source-positions-server-alive" -TestName "Server survives importing a real payload without item_source_positions (F1 crash class closed)" -Status passed
        $passed++
    } else {
        Write-TestResult -TestId "missing-source-positions-server-alive" -TestName "Server survives importing a real payload without item_source_positions" -Status failed -Message "post-import RCON failed: $alive"
        $failed++
    }

    # 2. The operation reports FAILURE with the missing-source-positions belt refusal — never a silent success.
    $stage = Get-SafeProperty $verdict "failedStage"
    $details = [string](Get-SafeProperty $verdict "details")
    if ((Get-SafeProperty $verdict "success") -eq $false -and $stage -eq "belts" -and $details -match "predates captured source positions") {
        Write-TestResult -TestId "missing-source-positions-operation-failed" -TestName "Upload-import reports FAILED (failedStage belts, missing source positions) — F2 contract" -Status passed
        $passed++
    } else {
        Write-TestResult -TestId "missing-source-positions-operation-failed" -TestName "Upload-import reports FAILED (failedStage belts, missing source positions)" -Status failed -Message "success=$($verdict.success) failedStage=$stage details=$details"
        $failed++
    }

    # 3. PHYSICAL: zero belt items restored — nothing was routed to any fallback path.
    $physical = Count-BeltProcessingUnits -Instance $sourceInstance -PlatformName $runName
    if (-not (Get-SafeProperty $physical "missing") -and $physical.belt -eq 0 -and $physical.entities -gt 500) {
        Write-TestResult -TestId "missing-source-positions-zero-belt-restore" -TestName "Zero belt items physically restored from the refused payload (entities=$($physical.entities))" -Status passed
        $passed++
    } else {
        Write-TestResult -TestId "missing-source-positions-zero-belt-restore" -TestName "Zero belt items physically restored from the refused payload" -Status failed -Message "belt=$($physical.belt) entities=$($physical.entities) missing=$($physical.missing)"
        $failed++
    }

    # 4. The loud refusal line reached the log (the operator-visible witness).
    $logHit = docker exec $sourceContainer sh -c "grep -a 'predates captured source positions' /clusterio/data/instances/$sourceInstance/factorio-current.log | tail -1"
    if ($logHit -match "predates captured source positions") {
        Write-TestResult -TestId "missing-source-positions-loud-log" -TestName "Refusal logged loudly (re-export guidance present)" -Status passed
        $passed++
    } else {
        Write-TestResult -TestId "missing-source-positions-loud-log" -TestName "Refusal logged loudly" -Status failed -Message "no 'predates captured source positions' line in $sourceInstance factorio-current.log"
        $failed++
    }
} finally {
    Remove-Fixture
    foreach ($instance in $instances) { Invoke-Lua -Instance $instance -Code "game.tick_paused=false;rcon.print('clean')" | Out-Null }
}

Write-TestSummary -Passed $passed -Failed $failed
if ($failed -gt 0 -or $passed -ne 4) { exit 1 }
