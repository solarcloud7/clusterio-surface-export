<#
.SYNOPSIS
    Spoilage round-trip — a spoilable stack set MID-DECAY via script must arrive with its spoil_percent
    intact (within a justified tick-drift bound) and its item count EXACT.

.DESCRIPTION
    Tests EXISTING serializer functionality that never had a test: inventory-scanner.lua captures
    `stack.spoil_percent` per item stack and deserializer.lua (restore path, `item_data.spoil_percent`)
    writes it back on the destination stack.

    Fixture (bare platform + script-built entities): a steel chest holding a spoilable stack (bioflux
    preferred — hours-long spoil time means the stack cannot fully spoil mid-transfer and detonate the
    exact item gate; nutrients fallback if bioflux is unavailable) with spoil_percent scripted to ~0.5.

    Assertions (all physical destination reads):
      * item count EXACT — chest.get_item_count(item) == inserted count AND the whole-surface physical
        sum over entities equals it (independent of the validator's report)
      * spoil_percent within the drift bound derived below
      * spoil_percent NEVER decreased (decay is monotone; a lower value would mean a restore-time reset)

    DRIFT BOUND JUSTIFICATION: spoil_percent advances by 1/spoil_ticks per game tick while the item exists.
    Between our SOURCE readback and our DESTINATION readback, game ticks elapse on the source (until the
    surface is torn down) and on the destination (after import) — never concurrently for the same stack, so
    total extra decay <= elapsed_wallclock_seconds * 60 ticks/s / spoil_ticks (both instances run ~60 UPS).
    We multiply by 1.5 for UPS jitter / catch-up ticks and add 0.01 float slop. spoil_ticks is read
    PHYSICALLY from the item prototype on the source; if unreadable we fall back to a conservative 0.2.

    UNVALIDATED: authored offline against lua-api.factorio.com/2.0.77 + the plugin's scanner/deserializer
    shapes; never executed against the live cluster. A closer agent runs and fixes it.

.PARAMETER SourceHost
    Host to build the fixture on (default 1; destination is the other host).
.PARAMETER ItemCount
    Spoilable items to insert (default 50).
.PARAMETER TimeoutSec
    Max seconds to wait for the destination import-result (default: 180).
#>
param(
    [int]$SourceHost = 1,
    [int]$ItemCount = 50,
    [int]$TimeoutSec = 180
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "Spoilage Round-Trip (mid-decay spoil_percent survives; item count exact)"

$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance  = "clusterio-host-$SourceHost-instance-1"
$dstInstance  = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$name = "spoilrt-$(Get-Date -Format 'HHmmss')-$([int](Get-Random -Minimum 100 -Maximum 999))"
Write-Host "  host-$SourceHost -> host-$DestHost   platform: $name" -ForegroundColor Gray
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

# One read probe used on BOTH sides: physical chest count, whole-surface physical sum, and the stack's
# spoil_percent found by scanning the chest inventory (slot position is not guaranteed across restore).
function Read-SpoilState {
    param([string]$Instance, [double]$Ox, [double]$Oy, [string]$Item)
    $body = @"
local p = nil
for _, q in pairs(game.forces.player.platforms) do if q.valid and q.name == '$name' then p = q break end end
if not p then return { success = false, error = 'platform missing' } end
local s = p.surface
local out = { success = true, tick = game.tick, platform_paused = p.paused }
-- The bare fixture surface holds exactly one steel-chest. Locate it by name: a position+radius search
-- misses it because create_entity snaps the 1x1 chest to tile-center (ox+0.5, oy+0.5), which is 0.707
-- from the integer {ox,oy} — outside a 0.6 radius. Name-only is exact for this single-chest fixture.
local chest = s.find_entities_filtered({ name = 'steel-chest' })[1]
out.have_chest = chest ~= nil
if chest then
    out.chest_count = chest.get_item_count('$Item')
    local inv = chest.get_inventory(defines.inventory.chest)
    if inv then
        for i = 1, #inv do
            local st = inv[i]
            if st.valid_for_read and st.name == '$Item' then
                out.stack_count = st.count
                local oks, sp = pcall(function() return st.spoil_percent end)
                if oks then out.spoil_percent = sp end
                break
            end
        end
    end
end
local total = 0
for _, e in pairs(s.find_entities_filtered({})) do total = total + e.get_item_count('$Item') end
out.surface_total = total
-- Spoilage byproduct presence: if any spoilage appeared, the stack (partially) spoiled through 100%.
local spoil_total = 0
for _, e in pairs(s.find_entities_filtered({})) do spoil_total = spoil_total + e.get_item_count('spoilage') end
out.spoilage_byproduct_total = spoil_total
return out
"@
    return Invoke-ProbeJson -Instance $Instance -Body $body
}

try {

Assert-FactorioVersion -Instance $srcInstance | Out-Null

# 1. Build the bare-platform fixture: steel chest + spoilable stack at ~50% decay.
Write-Status "Building bare platform '$name' with mid-decay spoilable stack..." -Type info
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
for x = -3, 3 do for y = -3, 3 do tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { ox + x, oy + y } } end end
s.set_tiles(tiles, true, false, true, false)
-- Prefer a SLOW spoiler (bioflux, ~2h) so the stack cannot cross 100% mid-transfer and change the item
-- census the exact gate counts; fall back to nutrients if bioflux is not in this prototype set.
local item = nil
for _, cand in ipairs({ 'bioflux', 'nutrients' }) do
    if prototypes.item[cand] then item = cand break end
end
if not item then return { success = false, error = 'no spoilable prototype (bioflux/nutrients) on this instance' } end
local chest = s.create_entity({ name = 'steel-chest', position = { ox, oy }, force = force })
if not (chest and chest.valid) then return { success = false, error = 'chest create failed' } end
local inserted = chest.insert({ name = item, count = $ItemCount })
local inv = chest.get_inventory(defines.inventory.chest)
local stack = nil
for i = 1, #inv do
    local st = inv[i]
    if st.valid_for_read and st.name == item then stack = st break end
end
if not stack then return { success = false, error = 'inserted stack not found' } end
local okw, errw = pcall(function() stack.spoil_percent = 0.5 end)
local spoil_ticks = nil
local okt, ticks = pcall(function() return prototypes.item[item].spoil_ticks end)
if okt and type(ticks) == 'number' and ticks > 0 then spoil_ticks = ticks end
return { success = true, index = p.index, ox = ox, oy = oy, item = item, inserted = inserted,
    spoil_write_ok = okw, spoil_write_err = okw and nil or tostring(errw),
    spoil_percent = stack.spoil_percent, spoil_ticks = spoil_ticks }
"@
$fx = Invoke-ProbeJson -Instance $srcInstance -Body $fixtureBody
if (-not $fx.success) { Write-Status "Fixture build failed: $($fx.error)" -Type error; exit 1 }
if ([int]$fx.inserted -ne $ItemCount) { Write-Status "Only $($fx.inserted)/$ItemCount items inserted" -Type error; exit 1 }
if (-not $fx.spoil_write_ok) { Write-Status "spoil_percent write failed: $($fx.spoil_write_err)" -Type error; exit 1 }
$spoilAfterWrite = [double]$fx.spoil_percent
if ($spoilAfterWrite -lt 0.45 -or $spoilAfterWrite -gt 0.55) {
    Write-Status "spoil_percent readback $spoilAfterWrite not ~0.5 — the mid-decay write did not take" -Type error
    exit 1
}
$ox = [double]$fx.ox; $oy = [double]$fx.oy
$item = [string]$fx.item
$spoilTicks = if ($fx.spoil_ticks) { [double]$fx.spoil_ticks } else { 0 }
Write-Status "Fixture ready: $ItemCount x $item at spoil_percent=$spoilAfterWrite (spoil_ticks=$spoilTicks)" -Type success

# 2. Source truth snapshot + wall-clock anchor for the drift bound.
$srcReadAt = Get-Date
$src = Read-SpoilState -Instance $srcInstance -Ox $ox -Oy $oy -Item $item
if (-not $src.success) { Write-Status "Source read failed: $($src.error)" -Type error; exit 1 }
Write-Host "  source: chest=$($src.chest_count) surface=$($src.surface_total) spoil=$($src.spoil_percent)" -ForegroundColor DarkGray

# 3. Transfer to the destination.
$idx = Get-PlatformIndex -Instance $srcInstance -PlatformName $name
if (-not $idx) { Write-Status "Platform index not found for '$name'" -Type error; exit 1 }
$destId = Get-ClusterioInstanceId -InstanceName $dstInstance
docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${name}_*.json 2>/dev/null" 2>$null | Out-Null
Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
Write-Status "Transfer initiated..." -Type info

# 4. Wait for the destination import-result.
$start = Get-Date; $resultFile = $null
while (-not $resultFile -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Seconds 2
    $files = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${name}_*.json")
    if ($files.Count -gt 0) { $resultFile = $files[0] }
}
if (-not $resultFile) { Write-Status "No import-result after ${TimeoutSec}s (transfer may have stalled)" -Type error; exit 1 }
$resultData = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $resultFile
$valSuccess = Get-SafeProperty $resultData "validation_success"
Add-Result "spo-gate-passed" "Transfer gate passed (validation_success=true)" ($valSuccess -eq $true) "validation_success=$valSuccess — on failure the destination is discarded and every physical read below will miss"
# Grounding: HARD-STOP before any destination census — on a gate failure the destination is discarded, so
# the physical chest reads below would census a platform that does not exist and silently mis-measure.
Assert-TransferSucceeded -Result $resultData -Context "Spoilage transfer"

# 5. Physical destination read (post-activation).
Start-Sleep -Seconds 4
$dst = Read-SpoilState -Instance $dstInstance -Ox $ox -Oy $oy -Item $item
if (-not $dst.success) { Write-Status "Destination read failed: $($dst.error)" -Type error; exit 1 }
$elapsedSec = ((Get-Date) - $srcReadAt).TotalSeconds
Write-Host "  dest:   chest=$($dst.chest_count) surface=$($dst.surface_total) spoil=$($dst.spoil_percent) (elapsed ${elapsedSec}s)" -ForegroundColor DarkGray

# --- Assertions (all physical destination reads) ---

Add-Result "spo-chest-present" "Fixture chest present on destination" ($dst.have_chest -eq $true) "chest missing at ($ox,$oy)"

# Item count EXACT — physical chest count and independent whole-surface physical sum.
Add-Result "spo-count-exact-chest" "Chest item count exact ($($dst.chest_count)/$ItemCount $item)" `
    ([int]$dst.chest_count -eq $ItemCount) "dest chest holds $($dst.chest_count), expected exactly $ItemCount"
Add-Result "spo-count-exact-surface" "Whole-surface physical count exact ($($dst.surface_total)/$ItemCount $item)" `
    ([int]$dst.surface_total -eq $ItemCount) "dest surface physical sum $($dst.surface_total), expected exactly $ItemCount"
Add-Result "spo-no-spoilage-byproduct" "No spoilage byproduct appeared (stack never crossed 100%)" `
    ([int]$dst.spoilage_byproduct_total -eq 0) "found $($dst.spoilage_byproduct_total) spoilage on the destination — the stack decayed through 100% during the test window (fixture spoiler too fast?)"

# spoil_percent within the derived drift bound (see .DESCRIPTION for the justification).
$srcSpoil = [double]$src.spoil_percent
$dstSpoil = if ($null -ne $dst.spoil_percent) { [double]$dst.spoil_percent } else { -1 }
$maxDrift = if ($spoilTicks -gt 0) { (($elapsedSec * 60.0) / $spoilTicks) * 1.5 + 0.01 } else { 0.2 }
Add-Result "spo-spoil-present" "spoil_percent readable on destination stack" ($dstSpoil -ge 0) "no $item stack with readable spoil_percent found in the dest chest"
Add-Result "spo-spoil-monotone" "spoil_percent never decreased (src=$srcSpoil dst=$dstSpoil)" `
    ($dstSpoil -ge ($srcSpoil - 0.000001)) "dest spoil_percent $dstSpoil < source $srcSpoil — restore reset the decay clock"
Add-Result "spo-spoil-within-drift" "spoil_percent within drift bound (delta=$([math]::Round($dstSpoil - $srcSpoil, 6)) <= $([math]::Round($maxDrift, 6)))" `
    (($dstSpoil - $srcSpoil) -le $maxDrift) "dest spoil_percent $dstSpoil exceeds source $srcSpoil by more than the justified bound $maxDrift (elapsed ${elapsedSec}s, spoil_ticks=$spoilTicks) — spoil state was likely NOT serialized and the stack restored fresh-then-decayed, or restored at a wrong value"

} finally {
    # Guaranteed cleanup: best-effort unlock, then delete the fixture platform on BOTH hosts.
    foreach ($inst in @($srcInstance, $dstInstance)) {
        Invoke-Lua -Instance $inst -Code "pcall(function() remote.call('surface_export','unlock_platform','$name') end) rcon.print('ok')" | Out-Null
        Remove-PlatformSurfacesWhere -Instance $inst -PredicateLua "p.name == '$name'" | Out-Null
        Step-Tick -Instance $inst -Ticks 5 | Out-Null
    }
}

# Zero-leftover proof: the fixture platform must be GONE from both hosts.
foreach ($inst in @($srcInstance, $dstInstance)) {
    $left = Get-PlatformIndex -Instance $inst -PlatformName $name
    Add-Result "spo-zero-leftover-$inst" "Zero leftovers on $inst" ($null -eq $left) "platform '$name' still present (index $left)"
}

Write-TestSummary -Passed ($script:total - $script:failed) -Failed $script:failed
if ($script:failed -gt 0) { exit 1 }
exit 0
