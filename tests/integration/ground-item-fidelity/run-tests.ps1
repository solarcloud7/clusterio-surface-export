<#
.SYNOPSIS
    Ground-item fidelity test — loose items on a platform's ground must survive a transfer (100% item
    fidelity). Guards the silent ground-item loss bug (the async export path used to drop them entirely).

.DESCRIPTION
    Ground items (item-entity / "item-on-ground") occur naturally on platforms (asteroid-destroyed
    entities spill their contents, mining/deconstruction, inserter overflow). The async export path used
    to serialize them as stackless records that couldn't be restored AND weren't counted in validation —
    so they vanished silently and the source was deleted. This pins the fix: place N known ground items on
    a clone, transfer, and assert the COMPREHENSIVE total (ground + inventories + belts) is preserved, and
    that the items were actually restored back onto the destination's ground (mechanism witness).

.PARAMETER SourcePlatform
    Platform to clone as the transfer subject (default: test).

.PARAMETER SourceHost
    Host holding the source platform (default: auto-detect).

.PARAMETER Item
    A distinctive item to place on the ground and track (default: processing-unit).

.PARAMETER TimeoutSec
    Max seconds to wait for the destination import-result (default: 150).
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [string]$Item = "processing-unit",
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

Write-TestHeader "📦 Ground-Item Fidelity (loose ground items survive a transfer — 100%)"

if ($SourceHost -eq 0) {
    $SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
    if (-not $SourceHost) { Write-Status "Source platform '$SourcePlatform' not found on any host" -Type error; exit 1 }
}
$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance  = "clusterio-host-$SourceHost-instance-1"
$dstInstance  = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$srcSel = "${SourceHost}1"; $dstSel = "${DestHost}1"
$clone = "groundfid-$(Get-Date -Format 'HHmmss')"
Write-Host "  host-$SourceHost -> host-$DestHost   clone: $clone   item: $Item" -ForegroundColor Gray
Write-Host ""

$failed = 0
$TOTAL_ASSERTIONS = 2

# Comprehensive count of $Item on a platform: ground + all entity inventories + belt transport lines.
function Count-Item([string]$sel, [string]$name) {
    $lua = "/sc local function fp(n) for _,q in pairs(game.forces['player'].platforms or {}) do if q.name==n then return q end end end local p=fp('$name') if not p then rcon.print('GROUND=-1 TOTAL=-1') return end local s=p.surface local g=0 for _,e in ipairs(s.find_entities_filtered({type='item-entity'})) do if e.valid and e.stack and e.stack.valid_for_read and e.stack.name=='$Item' then g=g+e.stack.count end end local t=g for _,e in ipairs(s.find_entities_filtered({})) do if e.valid and e.type~='item-entity' then local ok,c=pcall(function() return e.get_item_count('$Item') end) if ok and c then t=t+c end end end for _,e in ipairs(s.find_entities_filtered({type={'transport-belt','underground-belt','splitter','linked-belt','loader','loader-1x1'}})) do if e.valid then local ok,mx=pcall(function() return e.get_max_transport_line_index() end) if ok and mx then for li=1,mx do local tl=e.get_transport_line(li) if tl then t=t+tl.get_item_count('$Item') end end end end end rcon.print('GROUND='..g..' TOTAL='..t)"
    return (& "$repoRoot\tools\rcon.ps1" $sel $lua) -join " "
}
function Parse([string]$out, [string]$key) { if ($out -match "$key=(-?\d+)") { return [int]$Matches[1] } else { return -999 } }

# 1. Clone.
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

# 2. Place known ground items near the hub on open (non-colliding) tiles.
$placeLua = "/sc local function fp(n) for _,q in pairs(game.forces['player'].platforms or {}) do if q.name==n then return q end end end local p=fp('$clone') if not p then rcon.print('ERR') return end local s=p.surface local hx,hy=0,0 if p.hub and p.hub.valid then hx=p.hub.position.x hy=p.hub.position.y end local placed=0 for i=1,30 do local base={x=hx-8+(i%12),y=hy+6+math.floor(i/12)} local pos=s.find_non_colliding_position('item-on-ground',base,15,0.25) if pos then local e=s.create_entity({name='item-on-ground',position=pos,stack={name='$Item',count=1}}) if e and e.valid then placed=placed+1 end end end rcon.print('PLACED='..placed)"
$placeOut = (& "$repoRoot\tools\rcon.ps1" $srcSel $placeLua) -join " "
$placed = Parse $placeOut "PLACED"
Write-Status "Placed $placed '$Item' ground item(s) on the clone" -Type info
if ($placed -lt 1) { Write-Status "Could not place any ground items (placement returned '$placeOut')" -Type error; exit 1 }

# 3. Comprehensive source count (pre-transfer baseline).
$srcOut = Count-Item $srcSel $clone
$srcGround = Parse $srcOut "GROUND"; $srcTotal = Parse $srcOut "TOTAL"
Write-Status "Source: ground=$srcGround total=$srcTotal" -Type info

# 4. Transfer.
$destId = Get-ClusterioInstanceId -InstanceName $dstInstance
docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
Write-Status "Transfer initiated..." -Type info

# 5. Wait for the import-result, then let the destination settle (activation).
$start = Get-Date; $resultFile = $null
while (-not $resultFile -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Seconds 2
    $files = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${clone}_*.json")
    if ($files.Count -gt 0) { $resultFile = $files[0] }
}
if (-not $resultFile) { Write-Status "No import-result after ${TimeoutSec}s (transfer may have stalled)" -Type error; exit 1 }
$resultData = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $resultFile
try {
    Assert-TransferSucceeded -Result $resultData -Context "Ground-item transfer '$clone'"
} catch {
    Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
    Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null
    throw
}
Start-Sleep -Seconds 4

# 6. Comprehensive destination count.
$dstOut = Count-Item $dstSel $clone
$dstGround = Parse $dstOut "GROUND"; $dstTotal = Parse $dstOut "TOTAL"
Write-Status "Dest:   ground=$dstGround total=$dstTotal" -Type info

# --- Assertions ---
# A) 100% fidelity: comprehensive total preserved (none of the placed ground items lost).
if ($srcTotal -ge 0 -and $dstTotal -eq $srcTotal) {
    Write-TestResult -TestId "groundfid-total-preserved" -TestName "Comprehensive '$Item' total preserved across transfer ($srcTotal -> $dstTotal)" -Status "passed"
} else {
    Write-TestResult -TestId "groundfid-total-preserved" -TestName "Comprehensive '$Item' total preserved across transfer" -Status "failed" -Message "source total=$srcTotal but dest total=$dstTotal (lost $($srcTotal - $dstTotal) '$Item') -- ground items dropped on transfer"
    $failed++
}

# B) Mechanism witness: the ground items were actually restored onto the destination's ground.
if ($dstGround -ge 1) {
    Write-TestResult -TestId "groundfid-restored-to-ground" -TestName "Ground items restored onto the destination ground (ground=$dstGround)" -Status "passed"
} else {
    Write-TestResult -TestId "groundfid-restored-to-ground" -TestName "Ground items restored onto the destination ground" -Status "failed" -Message "dest ground count=$dstGround (expected >=1); ground restoration path did not run"
    $failed++
}

# 7. Cleanup both hosts (source is deleted on a successful transfer; remove dest clone + any source remnant).
Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null

Write-TestSummary -Passed ($TOTAL_ASSERTIONS - $failed) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
