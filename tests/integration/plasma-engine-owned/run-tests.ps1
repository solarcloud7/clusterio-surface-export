<#
.SYNOPSIS
    Engine-owned fusion output is excluded symmetrically while isolated plasma remains exact.
#>
param(
    [int]$Runs = 5,
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "Plasma engine-owned exclusion"
$prefix = "plasma-owned-"
$name = "$prefix$(Get-Date -Format 'HHmmss')"
$instances = @("clusterio-host-1-instance-1", "clusterio-host-2-instance-1")
$failed = 0
$passed = 0

function Remove-Fixture {
    foreach ($instance in $instances) {
        Remove-PlatformSurfacesWhere -Instance $instance -PredicateLua "string.find(p.name, '$prefix', 1, true) == 1" | Out-Null
    }
}

function New-PlasmaFixture {
    param([string]$Instance, [string]$PlatformName)

    $clone = New-TestPlatform -Instance $Instance -SourcePlatform "test" -DestPlatform $PlatformName
    if (-not $clone.success) { throw "clone failed: $($clone.error)" }
    if ($clone.job_id) {
        Wait-ForJob -Instances @($Instance) -MaxWaitSeconds 90 -CheckScript "local j=(storage.async_jobs or {})['$($clone.job_id)']; rcon.print(j == nil and 'true' or 'false')" | Out-Null
    }

    $fixture = Invoke-Lua -Instance $Instance -Code @"
local p=nil
for _,candidate in pairs(game.forces.player.platforms) do if candidate.name=='$PlatformName' then p=candidate end end
if not p then error('fixture platform missing') end
local isolated=nil
for _,tile in pairs(p.surface.find_tiles_filtered({name='space-platform-foundation'})) do
    if p.surface.can_place_entity({name='pipe',position=tile.position,force=p.force}) then
        local clear=true
        for _,near in pairs(p.surface.find_entities_filtered({position=tile.position,radius=4})) do
            if near.fluidbox and #near.fluidbox>0 then clear=false break end
        end
        if clear then isolated=p.surface.create_entity({name='pipe',position=tile.position,force=p.force}) break end
    end
end
if not isolated then error('no isolated plasma control site') end
isolated.fluidbox[1]={name='fusion-plasma',amount=5,temperature=1234567}
local control=isolated.fluidbox[1]
local reactors=p.surface.find_entities_filtered({name='fusion-reactor'})
local generators=p.surface.find_entities_filtered({name='fusion-generator'})
local managed=0
for _,reactor in pairs(reactors) do
    reactor.fluidbox[2]={name='fusion-plasma',amount=10,temperature=1234567}
    local f=reactor.fluidbox[2]
    managed=managed+(f and f.amount or 0)
end
-- Quiesce dynamic asteroid-chunk motion BEFORE the export snapshot (fixture-hardening only; the
-- exact gate stays exact). metallic-asteroid-chunk is stack-size 1 and circulates on unfreezable
-- belts (Pitfall #16), so the captured belt PHASE varies between transfer start and the atomic belt
-- scan, intermittently hitting belt_restoration's documented phase-sensitive geometry/compression
-- floor -> flaky expected>got at the gate. We remove the MOTION, not the strictness: freeze every
-- chunk-mover so nothing reintroduces chunks in the pre-lock window, then clear all chunks from
-- belts, inventories, and inserter hands. Reactors/generators/pipes (the plasma fluidboxes) are
-- untouched.
local chunk='metallic-asteroid-chunk'
local belt_types={'transport-belt','underground-belt','splitter','loader','loader-1x1','linked-belt'}
for _,e in pairs(p.surface.find_entities_filtered({type={'inserter','asteroid-collector','assembling-machine'}})) do
    if e.valid then e.active=false end
end
for _,e in pairs(p.surface.find_entities_filtered({type=belt_types})) do
    if e.valid then
        for i=1,e.get_max_transport_line_index() do e.get_transport_line(i).remove_item({name=chunk,count=1000000}) end
    end
end
for _,e in pairs(p.surface.find_entities_filtered({})) do
    if e.valid then
        for invn=1,12 do local iv=e.get_inventory(invn) if iv then iv.remove({name=chunk,count=1000000}) end end
        if e.type=='inserter' then local h=e.held_stack if h and h.valid_for_read and h.name==chunk then h.clear() end end
    end
end
local chunks_left=0
for _,e in pairs(p.surface.find_entities_filtered({type=belt_types})) do
    if e.valid then for i=1,e.get_max_transport_line_index() do chunks_left=chunks_left+e.get_transport_line(i).get_item_count(chunk) end end
end
for _,e in pairs(p.surface.find_entities_filtered({})) do
    if e.valid then
        for invn=1,12 do local iv=e.get_inventory(invn) if iv then chunks_left=chunks_left+iv.get_item_count(chunk) end end
        if e.type=='inserter' then local h=e.held_stack if h and h.valid_for_read and h.name==chunk then chunks_left=chunks_left+h.count end end
    end
end
rcon.print(helpers.table_to_json({entities=#p.surface.find_entities_filtered({}),control=control and control.amount or 0,managed=managed,reactors=#reactors,generators=#generators,chunks=chunks_left}))
"@
    $fixtureData = $fixture | ConvertFrom-Json
    if ($fixtureData.control -ne 5 -or $fixtureData.managed -le 0 -or $fixtureData.reactors -le 0 -or $fixtureData.generators -le 0 -or $fixtureData.chunks -ne 0) {
        throw "fixture grounding failed: $fixture"
    }
    return $fixtureData
}

try {
    Remove-Fixture
    $sourceHost = Resolve-PlatformHost -PlatformName "test"
    if (-not $sourceHost) { throw "test platform not found" }
    $sourceInstance = "clusterio-host-$sourceHost-instance-1"
    $destHost = if ($sourceHost -eq 1) { 2 } else { 1 }
    $destInstance = "clusterio-host-$destHost-instance-1"
    $destContainer = "surface-export-host-$destHost"
    $destId = Get-ClusterioInstanceId -InstanceName $destInstance

    for ($run = 1; $run -le $Runs; $run++) {
        $runName = "$name-$run"
        $fixtureData = New-PlasmaFixture -Instance $sourceInstance -PlatformName $runName
        $index = Get-PlatformIndex -Instance $sourceInstance -PlatformName $runName
        if (-not $index) { throw "run $run source platform missing" }
        $scriptOut = "/clusterio/data/instances/$destInstance/script-output"
        docker exec $destContainer sh -c "rm -f $scriptOut/debug_import_result_${runName}_*.json 2>/dev/null" 2>$null | Out-Null
        Send-Rcon -Instance $sourceInstance -Command "/transfer-platform $index $destId" | Out-Null

        $deadline = (Get-Date).AddSeconds($TimeoutSec)
        $resultFile = $null
        while (-not $resultFile -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 500
            $files = @(Get-DebugFiles -Instance $destInstance -Container $destContainer -Pattern "debug_import_result_${runName}_*.json")
            if ($files.Count -gt 0) { $resultFile = $files[0] }
        }
        if (-not $resultFile) { throw "run $run timed out" }
        $result = Read-DebugFile -Instance $destInstance -Container $destContainer -Filename $resultFile
        $validation = Get-SafeProperty $result "validation_result"
        $engineOwned = Get-SafeProperty $validation "engineOwnedFluids"
        $ownedPlasma = [double](Get-SafeProperty $engineOwned "fusion-plasma")
        $expected = Get-SafeProperty $validation "expectedFluidCounts"
        $expectedPlasma = 0.0
        foreach ($property in $expected.PSObject.Properties) {
            if ($property.Name -like "fusion-plasma@*") { $expectedPlasma += [double]$property.Value }
        }
        $ok = (Get-SafeProperty $result "validation_success") -eq $true -and
            (Get-SafeProperty $validation "fluidCountMatch") -eq $true -and
            $ownedPlasma -gt 0 -and $expectedPlasma -ge 5
        $id = "plasma-owned-run-$run"
        if ($ok) {
            Write-TestResult -TestId $id -TestName "Run ${run}: exact gate passes with engine-owned plasma excluded and isolated plasma retained" -Status passed
            $passed++
        } else {
            Write-TestResult -TestId $id -TestName "Run ${run}: symmetric engine-owned accounting" -Status failed -Message "success=$($result.validation_success) fluidMatch=$($validation.fluidCountMatch) owned=$ownedPlasma expectedPlasma=$expectedPlasma"
            $failed++
            break
        }
        Remove-Fixture
    }
} finally {
    Remove-Fixture
    foreach ($instance in $instances) {
        Invoke-Lua -Instance $instance -Code "game.tick_paused=false;rcon.print('clean')" | Out-Null
    }
}

Write-TestSummary -Passed $passed -Failed $failed
if ($failed -gt 0 -or $passed -ne $Runs) { exit 1 }
