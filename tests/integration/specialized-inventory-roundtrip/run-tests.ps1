<#
.SYNOPSIS
    Proves specialized-handler inventories remain in the serialized and exact-gate universe.
#>
param(
    [ValidateSet("success", "loss")]
    [string[]]$Sections = @("success"),
    [int]$SourceHost = 1,
    [int]$TimeoutSec = 150
)
$ErrorActionPreference = "Stop"
Import-Module (Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1") -Force
$prefix = "specinv-"
$script:total = 0
$script:failed = 0

function Add-Result([string]$Id, [string]$Name, [bool]$Ok, [string]$Message = "") {
    $script:total++
    if ($Ok) { Write-TestResult -TestId $Id -TestName $Name -Status passed }
    else { Write-TestResult -TestId $Id -TestName $Name -Status failed -Message $Message; $script:failed++ }
}
function Count-Key($Counts, [string]$Key) {
    $value = if ($Counts) { Get-SafeProperty $Counts $Key } else { $null }
    if ($null -eq $value) { return 0 }
    return [int]$value
}
function Count-Payload($Data) {
    $total = 0
    foreach ($entity in @((Get-SafeProperty $Data "entities"))) {
        if ((Get-SafeProperty $entity "name") -ne "burner-inserter") { continue }
        $specific = Get-SafeProperty $entity "specific_data"
        foreach ($inventory in @((Get-SafeProperty $specific "inventories"))) {
            foreach ($item in @((Get-SafeProperty $inventory "items"))) {
                if ((Get-SafeProperty $item "name") -eq "coal" -and (Get-SafeProperty $item "quality") -eq "legendary") {
                    $total += [int](Get-SafeProperty $item "count")
                }
            }
        }
    }
    return $total
}
function Wait-File([string]$Instance, [string]$Container, [string]$Pattern) {
    $start = Get-Date
    while (((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
        $files = @(Get-DebugFiles -Instance $Instance -Container $Container -Pattern $Pattern | Sort-Object -Descending)
        if ($files.Count -gt 0) { return $files[0] }
        Start-Sleep -Seconds 1
    }
    throw "Timed out waiting for $Pattern"
}
function Find-Fuel([string]$Instance, [string]$PlatformName) {
    return Invoke-Lua -Instance $Instance -ReturnJson -Code @"
local out={present=false,count=-1}
for _,p in pairs(game.forces['player'].platforms or {}) do
  if p.name=='$PlatformName' then
    for _,e in ipairs(p.surface.find_entities_filtered({name='burner-inserter'})) do
      local inv=e.get_inventory(defines.inventory.fuel)
      if inv then out.present=true; out.count=inv.get_item_count({name='coal',quality='legendary'}); break end
    end
  end
end
rcon.print(helpers.table_to_json(out))
"@
}
function Cleanup([string[]]$Instances) {
    foreach ($instance in $Instances) {
        Remove-PlatformSurfacesWhere -Instance $instance -PredicateLua "string.find(p.name,'$prefix',1,true)" | Out-Null
        Invoke-Lua -Instance $instance -Code @"
local function clear(tbl)
  for key,value in pairs(tbl or {}) do
    if type(value)=='table' and type(value.platform_name)=='string' and string.find(value.platform_name,'$prefix',1,true) then tbl[key]=nil end
  end
end
clear(storage.locked_platforms); clear(storage.destination_holds); clear(storage.async_jobs)
remote.call('surface_export','configure',{test_force_item_loss=0})
game.tick_paused=false
rcon.print('clean')
"@ | Out-Null
    }
}
function Check-Zero([string]$Instance, [string]$Label) {
    $state = Invoke-Lua -Instance $Instance -ReturnJson -Code @"
local function n(tbl) local c=0 for _,v in pairs(tbl or {}) do if type(v)=='table' and type(v.platform_name)=='string' and string.find(v.platform_name,'$prefix',1,true) then c=c+1 end end return c end
local surfaces=0
for _,p in pairs(game.forces['player'].platforms or {}) do if string.find(p.name,'$prefix',1,true) then surfaces=surfaces+1 end end
rcon.print(helpers.table_to_json({surfaces=surfaces,locks=n(storage.locked_platforms),holds=n(storage.destination_holds),jobs=n(storage.async_jobs),paused=game.tick_paused==true}))
"@
    $ok = [int]$state.surfaces -eq 0 -and [int]$state.locks -eq 0 -and [int]$state.holds -eq 0 -and [int]$state.jobs -eq 0 -and $state.paused -eq $false
    Add-Result "specinv-clean-$Label" "$Label zero leftover state" $ok ($state | ConvertTo-Json -Compress)
}
function Run-Section([string]$Section) {
    $DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
    $src = "clusterio-host-$SourceHost-instance-1"
    $dst = "clusterio-host-$DestHost-instance-1"
    $srcContainer = "surface-export-host-$SourceHost"
    $dstContainer = "surface-export-host-$DestHost"
    $srcOut = "/clusterio/data/instances/$src/script-output"
    $dstOut = "/clusterio/data/instances/$dst/script-output"
    $name = "$prefix$Section-$(Get-Date -Format 'HHmmss')"
    Invoke-Lua -Instance $src -Code "remote.call('surface_export','configure',{debug_mode=true}) rcon.print('ok')" | Out-Null
    Invoke-Lua -Instance $dst -Code "remote.call('surface_export','configure',{debug_mode=true}) rcon.print('ok')" | Out-Null
    $build = Invoke-Lua -Instance $src -ReturnJson -Code @"
local out={success=false}
local ok,err=pcall(function()
 local f=game.forces['player']; local p=f.create_space_platform({name='$name',planet='nauvis',starter_pack='space-platform-starter-pack'})
 p.apply_starter_pack(); p.schedule={current=1,records={{station='nauvis'}}}; p.paused=true
 local tiles={}; for x=314,326 do for y=314,326 do tiles[#tiles+1]={name='space-platform-foundation',position={x,y}} end end
 p.surface.set_tiles(tiles,true,false,true,false)
 local e=p.surface.create_entity({name='burner-inserter',position={320,320},force=f}); e.active=false
 local inv=e.get_inventory(defines.inventory.fuel); local inserted=inv.insert({name='coal',quality='legendary',count=20})
 if inserted~=20 then error('legendary coal fixture write rejected: '..tostring(inserted)) end
 out.success=true; out.index=p.index; out.count=inv.get_item_count({name='coal',quality='legendary'})
end)
if not ok then out.error=tostring(err) end
rcon.print(helpers.table_to_json(out))
"@
    if (-not $build.success) { throw "Fixture failed: $($build.error)" }
    Add-Result "specinv-$Section-source" "Source physically contains 20 legendary coal" ([int]$build.count -eq 20) "count=$($build.count)"
    docker exec $srcContainer sh -c "rm -f $srcOut/debug_source_platform_$($name)_*.json 2>/dev/null" 2>$null | Out-Null
    docker exec $dstContainer sh -c "rm -f $dstOut/debug_import_result_$($name)_*.json $dstOut/debug_destination_platform_$($name)_*.json 2>/dev/null" 2>$null | Out-Null
    if ($Section -eq "loss") { Invoke-Lua -Instance $dst -Code "remote.call('surface_export','configure',{debug_mode=true,test_force_item_loss=1}) rcon.print('armed')" | Out-Null }
    $base = if ($Section -eq "loss") { [int]((docker exec $dstContainer sh -c "wc -l < /clusterio/data/instances/$dst/factorio-current.log").Trim()) } else { 0 }
    $destId = Get-ClusterioInstanceId -InstanceName $dst
    Send-Rcon -Instance $src -Command "/transfer-platform $($build.index) $destId" | Out-Null
    $resultFile = Wait-File $dst $dstContainer "debug_import_result_$($name)_*.json"
    $sourceFile = Wait-File $src $srcContainer "debug_source_platform_$($name)_*.json"
    $result = Read-DebugFile -Instance $dst -Container $dstContainer -Filename $resultFile
    $source = Read-DebugFile -Instance $src -Container $srcContainer -Filename $sourceFile
    $validation = Get-SafeProperty $result "validation_result"
    $payload = Count-Payload $source
    $export = Count-Key (Get-SafeProperty (Get-SafeProperty $source "verification") "item_counts") "coal:legendary"
    $expected = Count-Key (Get-SafeProperty $validation "expectedItemCounts") "coal:legendary"
    $actual = Count-Key (Get-SafeProperty $validation "actualItemCounts") "coal:legendary"
    Add-Result "specinv-$Section-payload" "Serialized entity payload contains 20 legendary coal" ($payload -eq 20) "payload=$payload"
    Add-Result "specinv-$Section-export" "Export verification contains exactly 20 legendary coal" ($export -eq 20) "export=$export"
    Add-Result "specinv-$Section-expected" "Gate expects exactly 20 legendary coal" ($expected -eq 20) "expected=$expected"
    if ($Section -eq "success") {
        Assert-TransferSucceeded -Result $result -Context "Specialized inventory transfer $name"
        $destFile = Wait-File $dst $dstContainer "debug_destination_platform_$($name)_*.json"
        $frozen = Count-Payload (Read-DebugFile -Instance $dst -Container $dstContainer -Filename $destFile)
        Add-Result "specinv-success-frozen" "Frozen destination contains 20 legendary coal" ($frozen -eq 20) "frozen=$frozen"
        Add-Result "specinv-success-actual" "Gate sees exactly 20 legendary coal" ($actual -eq 20) "actual=$actual"
        $live = Find-Fuel $dst $name
        Add-Result "specinv-success-live" "Live destination contains 20 legendary coal" ($live.present -eq $true -and [int]$live.count -eq 20) ($live | ConvertTo-Json -Compress)
        Add-Result "specinv-success-deleted" "Source deleted after exact success" (-not [bool](Get-PlatformIndex -Instance $src -PlatformName $name)) "source remained"
    } else {
        Start-Sleep -Seconds 2
        $log = (docker exec $dstContainer sh -c "tail -n +$($base + 1) /clusterio/data/instances/$dst/factorio-current.log") -join "`n"
        Add-Result "specinv-loss-hook" "Hook removed one legendary coal" ($log -match "Forced item loss: removed 1 coal \(quality=legendary\)") "hook did not target legendary coal"
        Add-Result "specinv-loss-verdict" "Loss fails at item gate" ((Get-SafeProperty $result "validation_success") -eq $false -and (Get-SafeProperty $validation "failedStage") -eq "items") "wrong verdict"
        Add-Result "specinv-loss-counts" "Gate reports legendary coal 20 to 19" ($expected -eq 20 -and $actual -eq 19) "expected=$expected actual=$actual"
        Add-Result "specinv-loss-source" "Source preserved" ([bool](Get-PlatformIndex -Instance $src -PlatformName $name)) "source missing"
        Add-Result "specinv-loss-dest" "Destination discarded" (-not [bool](Get-PlatformIndex -Instance $dst -PlatformName $name)) "destination remained"
    }
}

Write-TestHeader "Specialized Handler Inventory Accounting"
$instances = @("clusterio-host-1-instance-1", "clusterio-host-2-instance-1")
try { foreach ($section in $Sections) { Run-Section $section } }
finally { Cleanup $instances }
Check-Zero $instances[0] "host1"
Check-Zero $instances[1] "host2"
Write-TestSummary -Passed ($script:total - $script:failed) -Failed $script:failed
if ($script:failed -gt 0) { exit 1 }