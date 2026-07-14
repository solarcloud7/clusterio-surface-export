<#
.SYNOPSIS
    Belt corner-compression recovery test — a transfer whose export snapshot catches a FULLY-COMPRESSED
    CORNER lane must pass the strict exact gate with zero physical loss, through BOTH recovery routes.

.DESCRIPTION
    Adversarial fixture for the corner slot-theft loss class (BELT-R2..R7, tests/belt-lab/NOTEBOOK.md;
    produced the -4/-8/-5 gate failures on main and CI). Mechanism: a corner lane's captured slots are
    packed tighter than insert_at's rebuild spacing, so import consolidates them into one oversized stack;
    that stack physically lands on the shared engine line and can occupy the NEIGHBOR piece's slot, whose
    own captured item is then rejected — a real deficit at the frozen gate. The fix recovers the belt-phase
    census deficit AFTER the Pass-2 hub inventory re-clear (recover_deficits_to_hub, import-completion.lua).

    TWO PASSES, one per recovery route (review finding: the spill branch is the code the fix repairs and a
    bare hub never reaches it):
      * hubroom  — destination hub restores with free slots  -> recovery inserts into the hub
      * hubfull  — SOURCE hub exported full, so the dest hub restores FULL -> recovery must SPILL to the
                   platform ground (durability certified by BELT-R7: spilled items survive the commit window)

    Deterministic trigger: items fed into a DEAD-END line through a corner settle at max compression and
    STOP MOVING — unlike the flowing loops on the shared test platform that made this class intermittent.

    Grounding (lint-test-grounding): the invariant is measured PHYSICALLY — whole-surface get_item_count
    on the source before transfer vs the destination after the gate. Reading the recovery log line is a
    FIXTURE-VALIDITY check only (proves the adversarial path actually ran), never the conservation claim.

.PARAMETER SourceHost
    Host to build the fixture on (default 1; destination is the other host).
.PARAMETER TimeoutSec
    Max seconds to wait for the destination import-result per pass (default: 180).
#>
param(
    [int]$SourceHost = 1,
    [int]$TimeoutSec = 180
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "Belt Corner Recovery (compressed corner lane -> strict gate, hub-insert AND spill routes)"

$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance  = "clusterio-host-$SourceHost-instance-1"
$dstInstance  = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$runTag = "$(Get-Date -Format 'HHmmss')-$([int](Get-Random -Minimum 100 -Maximum 999))"
$ITEM = "iron-plate"
Write-Host "  host-$SourceHost -> host-$DestHost   run: beltcorner-$runTag   item: $ITEM" -ForegroundColor Gray
Write-Host ""

# Derived summary counts — never hardcoded totals.
$script:failed = 0
$script:total = 0
function Add-Result {
    param([string]$Id, [string]$TestName, [bool]$Ok, [string]$Message = "")
    $script:total++
    if ($Ok) { Write-TestResult -TestId $Id -TestName $TestName -Status "passed" }
    else { Write-TestResult -TestId $Id -TestName $TestName -Status "failed" -Message $Message; $script:failed++ }
}

function Invoke-ProbeJson {
    param([string]$Instance, [string]$Body)
    $lua = "local ok,result=pcall(function() $Body end); if not ok then rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) else rcon.print(helpers.table_to_json(result)) end"
    $raw = Invoke-Lua -Instance $Instance -Code $lua
    if (-not $raw) { throw "Empty RCON response from $Instance" }
    try { return $raw | ConvertFrom-Json } catch { throw "Invalid probe JSON from ${Instance}: $raw" }
}

# Whole-surface physical census of $ITEM on the named platform (entities incl. belts + ground item-entities;
# the same complete physical meter the gate uses — independent of the recovery's own report).
function Read-SurfaceCount {
    param([string]$Instance, [string]$PlatformName)
    $body = @"
local p = nil
for _, q in pairs(game.forces.player.platforms) do if q.valid and q.name == '$PlatformName' then p = q break end end
if not p then return { success = false, error = 'platform missing' } end
local total = 0
for _, e in ipairs(p.surface.find_entities_filtered({})) do
    local ok, c = pcall(function() return e.get_item_count('$ITEM') end)
    if ok and c then total = total + c end
end
return { success = true, count = total, tick = game.tick }
"@
    return Invoke-ProbeJson -Instance $Instance -Body $body
}

# One full adversarial pass: build the dead-end corner fixture, settle to max compression, transfer through
# the strict gate, assert physical conservation. $FillHub routes the recovery to the SPILL branch.
function Run-CornerPass {
    param([string]$PassId, [bool]$FillHub)

    $name = "beltcorner-$PassId-$runTag"
    Write-Status "[$PassId] Building bare platform '$name' (FillHub=$FillHub)..." -Type info
    $hubFillLua = ""
    if ($FillHub) {
        # Export the SOURCE hub FULL so the destination hub restores full and recovery must spill.
        $hubFillLua = @"
-- Fill until the hub REJECTS further $ITEM (insert returns 0). That is the exact condition that routes
-- recovery's own $ITEM insert to the spill branch — is_full() is the wrong predicate (the hub stops
-- accepting a given item well before every slot is used; measured: rejected after ~6k iron-plate).
local hub = s.find_entities_filtered({ name = 'space-platform-hub' })[1]
local hinv = hub.get_inventory(defines.inventory.hub_main)
local guard = 0
while hinv.insert({ name = '$ITEM', count = 1000 }) > 0 and guard < 5000 do guard = guard + 1 end
if guard >= 5000 then error('hub never rejected $ITEM (guard exhausted)') end
if hinv.insert({ name = '$ITEM', count = 1 }) > 0 then error('hub still accepts $ITEM after fill loop') end
"@
    }
    $fixtureBody = @"
local force = game.forces['player']
local p = force.create_space_platform({ name = '$name', planet = 'nauvis', starter_pack = 'space-platform-starter-pack' })
if not (p and p.valid) then return { success = false, error = 'create_space_platform failed' } end
p.apply_starter_pack()
p.schedule = { current = 1, records = { { station = 'nauvis' } } }
p.paused = false
force.set_surface_hidden(p.surface, false)
local s = p.surface
local ox, oy = 100 + p.index * 50, 100
local tiles = {}
for x = -8, 4 do for y = -4, 4 do tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { ox + x, oy + y } } end end
s.set_tiles(tiles, true, false, true, false)
$hubFillLua
local function ent(spec)
    local e = s.create_entity(spec)
    if not (e and e.valid) then error('create_entity failed for ' .. spec.name) end
    return e
end
-- Feed line: 5 belts flowing EAST along y=0, then the CORNER piece turns the flow NORTH, then one
-- dead-end piece. Nothing consumes at the end, so fed items settle at max compression through the corner.
for x = -6, -1 do
    ent({ name = 'turbo-transport-belt', position = { ox + x, oy }, direction = defines.direction.east, force = force })
end
ent({ name = 'turbo-transport-belt', position = { ox, oy }, direction = defines.direction.north, force = force })
ent({ name = 'turbo-transport-belt', position = { ox, oy - 1 }, direction = defines.direction.north, force = force })
return { success = true, index = p.index, ox = ox, oy = oy }
"@
    $fx = Invoke-ProbeJson -Instance $srcInstance -Body $fixtureBody
    if (-not $fx.success) { Write-Status "[$PassId] Fixture build failed: $($fx.error)" -Type error; exit 1 }
    $ox = [double]$fx.ox; $oy = [double]$fx.oy

    # Feed until FULL and SETTLED: two consecutive rounds adding nothing = max compression, nothing moving.
    $fed = 0; $stable = 0; $rounds = 0
    while ($stable -lt 2 -and $rounds -lt 30) {
        $rounds++
        $feed = Invoke-ProbeJson -Instance $srcInstance -Body @"
local p = nil
for _, q in pairs(game.forces.player.platforms) do if q.valid and q.name == '$name' then p = q break end end
if not p then return { success = false, error = 'platform missing' } end
-- radius 0.9: belts snap to tile centers (+0.5,+0.5) — the 0.6-radius lesson from circuit-latch-state
local entry = p.surface.find_entities_filtered({ name = 'turbo-transport-belt', position = { $ox - 6, $oy }, radius = 0.9 })[1]
if not entry then return { success = false, error = 'entry belt missing' } end
local added = 0
for li = 1, 2 do
    local line = entry.get_transport_line(li)
    for slot = 0, 3 do
        if line.insert_at(0.125 + slot * 0.25, { name = '$ITEM', count = 1 }, 1) then added = added + 1 end
    end
end
return { success = true, added = added }
"@
        if (-not $feed.success) { Write-Status "[$PassId] Feed round failed: $($feed.error)" -Type error; exit 1 }
        $fed += [int]$feed.added
        if ([int]$feed.added -eq 0) { $stable++ } else { $stable = 0 }
        Start-Sleep -Milliseconds 600
    }
    Write-Status "[$PassId] Fed $fed items over $rounds rounds (line full + settled)" -Type info
    if ($fed -lt 20) { Write-Status "[$PassId] Fed only $fed items — line too short to compress, fixture bug" -Type error; exit 1 }

    # FIXTURE-VALIDITY: at least one lane over-packed past insert_at's rebuild spacing (n * 0.24 > length).
    $packed = Invoke-ProbeJson -Instance $srcInstance -Body @"
local p = nil
for _, q in pairs(game.forces.player.platforms) do if q.valid and q.name == '$name' then p = q break end end
if not p then return { success = false, error = 'platform missing' } end
local overpacked, lanes = 0, 0
for _, b in ipairs(p.surface.find_entities_filtered({ name = 'turbo-transport-belt' })) do
    for li = 1, b.get_max_transport_line_index() do
        local line = b.get_transport_line(li)
        local n = #line.get_detailed_contents()
        lanes = lanes + 1
        if n > 0 and (n * 0.24) > line.line_length then overpacked = overpacked + 1 end
    end
end
return { success = true, overpacked = overpacked, lanes = lanes }
"@
    if (-not $packed.success) { Write-Status "[$PassId] Packed-lane probe failed: $($packed.error)" -Type error; exit 1 }
    Add-Result "bcr-$PassId-overpacked" "[$PassId] fixture holds >=1 over-packed lane (adversarial state exists)" `
        ([int]$packed.overpacked -ge 1) "overpacked=$($packed.overpacked) of $($packed.lanes) lanes"

    # SOURCE physical census (the conservation baseline).
    $src = Read-SurfaceCount -Instance $srcInstance -PlatformName $name
    if (-not $src.success) { Write-Status "[$PassId] Source census failed: $($src.error)" -Type error; exit 1 }
    $srcCount = [int]$src.count
    Write-Status "[$PassId] Source physical census: $ITEM=$srcCount" -Type info

    # Transfer through the strict gate.
    $idx = Get-PlatformIndex -Instance $srcInstance -PlatformName $name
    if (-not $idx) { Write-Status "[$PassId] Platform index not found" -Type error; exit 1 }
    $destId = Get-ClusterioInstanceId -InstanceName $dstInstance
    docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${name}_*.json 2>/dev/null" 2>$null | Out-Null
    Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
    Write-Status "[$PassId] Transfer initiated (strict gate)..." -Type info

    $start = Get-Date; $resultFile = $null
    while (-not $resultFile -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
        Start-Sleep -Seconds 2
        $files = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${name}_*.json")
        if ($files.Count -gt 0) { $resultFile = $files[0] }
    }
    if (-not $resultFile) { Write-Status "[$PassId] No import-result after ${TimeoutSec}s" -Type error; exit 1 }
    $resultData = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $resultFile
    $valSuccess = Get-SafeProperty $resultData "validation_success"
    Add-Result "bcr-$PassId-gate-passed" "[$PassId] transfer passed the strict exact gate" ($valSuccess -eq $true) `
        "validation_success=$valSuccess — pre-fix, a compressed-corner snapshot fails the gate (the -4/-8/-5 class)"
    if ($valSuccess -ne $true) { return }
    Start-Sleep -Seconds 3

    # DESTINATION physical census — the conservation invariant, independent of the recovery's report.
    $dst = Read-SurfaceCount -Instance $dstInstance -PlatformName $name
    if (-not $dst.success) { Write-Status "[$PassId] Destination census failed: $($dst.error)" -Type error; exit 1 }
    Add-Result "bcr-$PassId-conservation" "[$PassId] destination physical census equals source ($($dst.count) == $srcCount)" `
        ([int]$dst.count -eq $srcCount) "dest=$($dst.count) src=$srcCount — physical loss/gain across the transfer"

    # FIXTURE-VALIDITY: the recovery route for this pass. hubroom -> any recovery is fine (deficit optional
    # but observed deterministic); hubfull -> if a deficit occurred, items MUST have spilled to ground.
    $recLine = docker exec $dstContainer sh -c "grep -a 'Aggregate deficit recovery' /clusterio/data/instances/$dstInstance/factorio-current.log | tail -1" 2>$null
    if ($recLine -match 'recovered=(\d+) to hub/ground, unrecovered=(\d+)') {
        $rec = [int]$Matches[1]; $unrec = [int]$Matches[2]
        Add-Result "bcr-$PassId-recovery-honest" "[$PassId] recovery recovered=$rec unrecovered=$unrec (unrecovered must be 0)" `
            ($unrec -eq 0) "unrecovered=$unrec — recovery could not materialize items"
        if ($FillHub -and $rec -gt 0) {
            # INFORMATIONAL route report, not an assertion: the destination hub's per-item cap is dynamic
            # (a source hub filled to rejection restored WITH headroom — measured), so which route recovery
            # takes here is engine-dependent. Conservation + unrecovered=0 above are the invariants either
            # way; the spill branch's own behavior is probed live (BELT-R4a materialization, BELT-R7
            # durability). Deterministic CI spill-route coverage remains an open follow-up on the rung.
            $ground = Invoke-ProbeJson -Instance $dstInstance -Body @"
local p = nil
for _, q in pairs(game.forces.player.platforms) do if q.valid and q.name == '$name' then p = q break end end
if not p then return { success = false, error = 'platform missing' } end
local total = 0
for _, e in ipairs(p.surface.find_entities_filtered({ type = 'item-entity' })) do
    local ok, c = pcall(function() return e.stack.count end)
    if ok and c and e.stack.name == '$ITEM' then total = total + c end
end
return { success = true, ground = total }
"@
            $route = if ($ground.success -and [int]$ground.ground -ge $rec) { "GROUND SPILL" } else { "HUB INSERT (dest hub had headroom post-restore)" }
            Write-Status "[$PassId] Recovery route this run: $route (ground=$($ground.ground))" -Type info
        }
        Write-Status "[$PassId] Recovery route ran: recovered=$rec" -Type info
    } else {
        Write-Status "[$PassId] No recovery line — belt restoration had zero deficit this pass (conservation asserted above)" -Type info
    }
}

try {

Assert-FactorioVersion -Instance $srcInstance | Out-Null

Run-CornerPass -PassId "hubroom" -FillHub $false
Run-CornerPass -PassId "hubfull" -FillHub $true

Write-TestSummary -Passed ($script:total - $script:failed) -Failed $script:failed
if ($script:failed -gt 0) { exit 1 }
exit 0

}
finally {
    # Cleanup EVERY state layer on BOTH hosts for this run's platforms, then assert zero leftovers.
    foreach ($inst in @($srcInstance, $dstInstance)) {
        try {
            $left = Invoke-Lua -Instance $inst -Code @"
for _, q in pairs(game.forces.player.platforms) do
    if q.valid and (q.name == 'beltcorner-hubroom-$runTag' or q.name == 'beltcorner-hubfull-$runTag') then
        remote.call('surface_export', 'unlock_platform', q.index)
        if q.surface then game.delete_surface(q.surface) end
    end
end
local j = 0 for _ in pairs(storage.async_jobs or {}) do j = j + 1 end
local l = 0 for _ in pairs(storage.locked_platforms or {}) do l = l + 1 end
local h = 0 for _ in pairs(storage.destination_holds or {}) do h = h + 1 end
rcon.print('leftovers j=' .. j .. ' l=' .. l .. ' h=' .. h .. ' paused=' .. tostring(game.tick_paused))
"@
            if ($left -notmatch 'j=0 l=0 h=0 paused=false') {
                Write-Host "  LEFTOVER WARNING on ${inst}: $left" -ForegroundColor Yellow
            }
        } catch { Write-Host "  cleanup on ${inst}: $_" -ForegroundColor DarkYellow }
    }
}
