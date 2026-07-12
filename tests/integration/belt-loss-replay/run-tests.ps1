<#
.SYNOPSIS
    Deterministic replay of the 550-belt aggregate restoration deficit.
#>
param(
    [int]$Runs = 5,
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

Write-TestHeader "Belt aggregate deficit recovery"
$prefix = "belt-loss-replay-"
$instances = @("clusterio-host-1-instance-1", "clusterio-host-2-instance-1")
$failed = 0
$passed = 0

function Remove-Fixture {
    foreach ($instance in $instances) {
        Remove-PlatformSurfacesWhere -Instance $instance -PredicateLua "string.find(p.name, '$prefix', 1, true) == 1" | Out-Null
    }
}

function Count-ProcessingUnits([string]$Instance, [string]$PlatformName) {
    $json = Invoke-Lua -Instance $Instance -Code @"
local p=nil
for _,candidate in pairs(game.forces.player.platforms or {}) do if candidate.name=='$PlatformName' then p=candidate break end end
if not p then rcon.print(helpers.table_to_json({missing=true})) return end
local belt=0
for _,e in ipairs(p.surface.find_entities_filtered({type={'transport-belt','underground-belt','splitter','linked-belt','loader','loader-1x1'}})) do
    for line=1,e.get_max_transport_line_index() do belt=belt+e.get_transport_line(line).get_item_count('processing-unit') end
end
local hub=p.hub.get_inventory(defines.inventory.hub_main).get_item_count('processing-unit')
local ground=0
for _,e in ipairs(p.surface.find_entities_filtered({type='item-entity'})) do
    if e.stack and e.stack.valid_for_read and e.stack.name=='processing-unit' then ground=ground+e.stack.count end
end
rcon.print(helpers.table_to_json({belt=belt,hub=hub,ground=ground,total=belt+hub+ground,entities=#p.surface.find_entities_filtered({})}))
"@
    return $json | ConvertFrom-Json
}

try {
    Remove-Fixture
    $sourceHost = Resolve-PlatformHost -PlatformName "test"
    if (-not $sourceHost) { throw "test platform not found" }
    $sourceInstance = "clusterio-host-$sourceHost-instance-1"
    $sourceId = Get-ClusterioInstanceId -InstanceName $sourceInstance
    $destHost = if ($sourceHost -eq 1) { 2 } else { 1 }
    $destInstance = "clusterio-host-$destHost-instance-1"
    $destContainer = "surface-export-host-$destHost"
    $destId = Get-ClusterioInstanceId -InstanceName $destInstance
    $fixture = Join-Path $PSScriptRoot "fixture.json"
    docker cp $fixture surface-export-controller:/tmp/belt-loss-replay.json | Out-Null

    for ($run = 1; $run -le $Runs; $run++) {
        $runName = "$prefix$(Get-Date -Format 'HHmmss')-$run"
        $upload = docker exec surface-export-controller sh -c "npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error surface-export upload-import /tmp/belt-loss-replay.json $sourceId player $runName"
        if ($LASTEXITCODE -ne 0) { throw "run $run fixture upload failed: $upload" }
        $deadline = (Get-Date).AddSeconds($TimeoutSec)
        $index = $null
        while (-not $index -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 500
            $index = Get-PlatformIndex -Instance $sourceInstance -PlatformName $runName
        }
        if (-not $index) { throw "run $run source fixture timed out" }
        $source = Count-ProcessingUnits -Instance $sourceInstance -PlatformName $runName
        if ($source.total -ne 19 -or $source.entities -ne 552) {
            throw "run $run fixture grounding failed: entities=$($source.entities) belt=$($source.belt) hub=$($source.hub) ground=$($source.ground) total=$($source.total)"
        }

        $scriptOut = "/clusterio/data/instances/$destInstance/script-output"
        docker exec $destContainer sh -c "rm -f $scriptOut/debug_import_result_${runName}_*.json 2>/dev/null" 2>$null | Out-Null
        Send-Rcon -Instance $sourceInstance -Command "/transfer-platform $index $destId" | Out-Null
        $resultFile = $null
        while (-not $resultFile -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 500
            $files = @(Get-DebugFiles -Instance $destInstance -Container $destContainer -Pattern "debug_import_result_${runName}_*.json")
            if ($files.Count -gt 0) { $resultFile = $files[0] }
        }
        if (-not $resultFile) { throw "run $run transfer timed out" }
        $result = Read-DebugFile -Instance $destInstance -Container $destContainer -Filename $resultFile
        Assert-TransferSucceeded -Result $result -Context "Belt replay run $run ($runName)"
        $validation = Get-SafeProperty $result "validation_result"
        $dest = Count-ProcessingUnits -Instance $destInstance -PlatformName $runName
        $ok = (Get-SafeProperty $result "validation_success") -eq $true -and
            (Get-SafeProperty $validation "itemCountMatch") -eq $true -and
            $dest.total -eq 19 -and $dest.ground -ge 1
        $id = "belt-loss-replay-run-$run"
        if ($ok) {
            Write-TestResult -TestId $id -TestName "Run ${run}: exact gate preserves 19 processing units across the 550-belt replay" -Status passed
            $passed++
        } else {
            Write-TestResult -TestId $id -TestName "Run ${run}: deterministic belt deficit recovery" -Status failed -Message "success=$($result.validation_success) itemMatch=$($validation.itemCountMatch) belt=$($dest.belt) hub=$($dest.hub) ground=$($dest.ground) total=$($dest.total)"
            $failed++
            break
        }
        Remove-Fixture
    }
} finally {
    Remove-Fixture
    foreach ($instance in $instances) { Invoke-Lua -Instance $instance -Code "game.tick_paused=false;rcon.print('clean')" | Out-Null }
}

Write-TestSummary -Passed $passed -Failed $failed
if ($failed -gt 0 -or $passed -ne $Runs) { exit 1 }