<#
.SYNOPSIS
    Belt corner-compression recovery test — a transfer whose export snapshot catches a FULLY-COMPRESSED
    CORNER lane must pass the strict exact gate with zero physical loss.

.DESCRIPTION
    Adversarial fixture for the corner slot-theft loss class (BELT-R2..R6, tests/belt-lab/NOTEBOOK.md;
    produced the -4/-8/-5 gate failures on main and CI). Mechanism: a corner lane's captured slots are
    packed tighter than insert_at's minimum spacing, so import consolidates them into one oversized stack;
    that stack physically lands on the shared engine line and can occupy the NEIGHBOR piece's slot, whose
    own captured item is then rejected — a real deficit at the frozen gate. The fix recovers the belt-phase
    census deficit into the hub AFTER the Pass-2 hub inventory re-clear (recover_deficits_to_hub,
    import-completion.lua).

    Deterministic trigger: items fed into a DEAD-END line through a corner settle at max compression and
    STOP MOVING — unlike the flowing loops on the shared test platform that made this class intermittent.

    Grounding (lint-test-grounding): the invariant is measured PHYSICALLY — whole-surface get_item_count
    on the source before transfer vs the destination after the gate. Reading the recovery log line is a
    FIXTURE-VALIDITY check only (proves the adversarial path actually ran), never the conservation claim.

.PARAMETER SourceHost
    Host to build the fixture on (default 1; destination is the other host).
.PARAMETER TimeoutSec
    Max seconds to wait for the destination import-result (default: 180).
#>
param(
    [int]$SourceHost = 1,
    [int]$TimeoutSec = 180
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "Belt Corner Recovery (compressed corner lane -> strict gate must still pass, zero loss)"

$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance  = "clusterio-host-$SourceHost-instance-1"
$dstInstance  = "clusterio-host-$DestHost-instance-1"
$srcContainer = "surface-export-host-$SourceHost"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$name = "beltcorner-$(Get-Date -Format 'HHmmss')-$([int](Get-Random -Minimum 100 -Maximum 999))"
$ITEM = "iron-plate"
Write-Host "  host-$SourceHost -> host-$DestHost   platform: $name   item: $ITEM" -ForegroundColor Gray
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

# Whole-surface physical census of $ITEM on the named platform (entities incl. belts + ground; the same
# complete physical meter the gate uses — independent of the recovery's own report).
function Read-SurfaceCount {
    param([string]$Instance)
    $body = @"
local p = nil
for _, q in pairs(game.forces.player.platforms) do if q.valid and q.name == '$name' then p = q break end end
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

try {

Assert-FactorioVersion -Instance $srcInstance | Out-Null

# 1. Bare platform + dead-end belt run THROUGH a corner. Items flow east along y=0, turn the corner at
#    (ox,0) heading north, and dead-end one tile up — the whole run settles at max compression.
Write-Status "Building bare platform '$name' with dead-end corner belt run..." -Type info
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
if (-not $fx.success) { Write-Status "Fixture build failed: $($fx.error)" -Type error; exit 1 }
$ox = [double]$fx.ox; $oy = [double]$fx.oy
Write-Status "Fixture ready (platform index $($fx.index), origin $ox,$oy)" -Type success

# 2. Feed the line until FULL and SETTLED: top up the entry belt each round while items flow toward the
#    dead end; stop when two consecutive rounds add nothing (max compression reached, nothing moving).
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
    if (-not $feed.success) { Write-Status "Feed round failed: $($feed.error)" -Type error; exit 1 }
    $fed += [int]$feed.added
    if ([int]$feed.added -eq 0) { $stable++ } else { $stable = 0 }
    Start-Sleep -Milliseconds 600
}
Write-Status "Fed $fed items over $rounds rounds (line full + settled)" -Type info
if ($fed -lt 20) { Write-Status "Fixture fed only $fed items — line too short to compress, fixture bug" -Type error; exit 1 }

# 3. FIXTURE-VALIDITY: at least one lane on the run must be over-packed past insert_at's rebuild spacing
#    (n * 0.24 > lane length) — i.e. the import-side consolidation/deficit class WILL be exercised.
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
if (-not $packed.success) { Write-Status "Packed-lane probe failed: $($packed.error)" -Type error; exit 1 }
Add-Result "bcr-fixture-overpacked" "Fixture holds >=1 over-packed lane (n*0.24 > lane length) — the adversarial state exists" `
    ([int]$packed.overpacked -ge 1) "overpacked=$($packed.overpacked) of $($packed.lanes) lanes — fixture failed to reach the compression state"

# 4. SOURCE physical census (the conservation baseline).
$src = Read-SurfaceCount -Instance $srcInstance
if (-not $src.success) { Write-Status "Source census failed: $($src.error)" -Type error; exit 1 }
$srcCount = [int]$src.count
Write-Status "Source physical census: $ITEM=$srcCount" -Type info
if ($srcCount -lt $fed) { Write-Status "Source census $srcCount < fed $fed — items leaked pre-transfer, fixture bug" -Type error; exit 1 }

# 5. Transfer to the destination through the strict gate.
$idx = Get-PlatformIndex -Instance $srcInstance -PlatformName $name
if (-not $idx) { Write-Status "Platform index not found for '$name'" -Type error; exit 1 }
$destId = Get-ClusterioInstanceId -InstanceName $dstInstance
docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${name}_*.json 2>/dev/null" 2>$null | Out-Null
$markStart = Get-Date
Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
Write-Status "Transfer initiated (strict gate)..." -Type info

$start = Get-Date; $resultFile = $null
while (-not $resultFile -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Seconds 2
    $files = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${name}_*.json")
    if ($files.Count -gt 0) { $resultFile = $files[0] }
}
if (-not $resultFile) { Write-Status "No import-result after ${TimeoutSec}s (transfer stalled)" -Type error; exit 1 }
$resultData = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $resultFile
$valSuccess = Get-SafeProperty $resultData "validation_success"
Add-Result "bcr-gate-passed" "Transfer passed the strict exact gate (validation_success=true)" ($valSuccess -eq $true) `
    "validation_success=$valSuccess — pre-fix, a compressed-corner snapshot fails the gate with a small belt deficit (the -4/-8/-5 class)"
if ($valSuccess -ne $true) {
    Write-TestSummary -Passed ($script:total - $script:failed) -Failed ($script:failed + 1)
    exit 1
}
Start-Sleep -Seconds 3

# 6. DESTINATION physical census — the conservation invariant, measured independently of the recovery's
#    report. Exact equality: the gate is exact, and recovery moves items to the hub (same surface).
$dst = Read-SurfaceCount -Instance $dstInstance
if (-not $dst.success) { Write-Status "Destination census failed: $($dst.error)" -Type error; exit 1 }
Add-Result "bcr-physical-conservation" "Destination physical census equals source ($($dst.count) == $srcCount)" `
    ([int]$dst.count -eq $srcCount) "dest=$($dst.count) src=$srcCount — physical loss/gain across the transfer"

# 7. FIXTURE-VALIDITY (not the invariant): if belt restoration left a deficit, the recovery log must show
#    it recovered (recovered>0, unrecovered=0). If NO deficit occurred this run, that is a fixture-power
#    note, not a failure — conservation (step 6) is the invariant either way; record which route ran.
$recLine = docker exec $dstContainer sh -c "grep -a 'Aggregate deficit recovery' /clusterio/data/instances/$dstInstance/factorio-current.log | tail -1" 2>$null
if ($recLine -match 'recovered=(\d+) to hub/ground, unrecovered=(\d+)') {
    $rec = [int]$Matches[1]; $unrec = [int]$Matches[2]
    Add-Result "bcr-recovery-honest" "Belt deficit recovery reported recovered=$rec unrecovered=$unrec (unrecovered must be 0)" `
        ($unrec -eq 0) "unrecovered=$unrec — recovery could not materialize items; gate should have failed"
    Write-Status "Recovery route ran this pass: recovered=$rec" -Type info
} else {
    Write-Status "No recovery line — belt restoration had zero deficit this pass (conservation still asserted above)" -Type info
}

Write-TestSummary -Passed ($script:total - $script:failed) -Failed $script:failed
if ($script:failed -gt 0) { exit 1 }
exit 0

}
finally {
    # Cleanup EVERY state layer on BOTH hosts, keyed by unique index resolved from this run's name.
    foreach ($inst in @($srcInstance, $dstInstance)) {
        try {
            Invoke-Lua -Instance $inst -Code @"
for _, q in pairs(game.forces.player.platforms) do
    if q.valid and q.name == '$name' then
        remote.call('surface_export', 'unlock_platform', q.index)
        if q.surface then game.delete_surface(q.surface) end
    end
end
rcon.print('cleanup done')
"@ | Out-Null
        } catch { Write-Host "  cleanup on ${inst}: $_" -ForegroundColor DarkYellow }
    }
}
