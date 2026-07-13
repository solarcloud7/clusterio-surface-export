<#
.SYNOPSIS
    Equipment-grid + burner-equipment round-trip — an equipment grid (with a burner equipment mid-burn,
    when the prototype set has one) must arrive with equipment, energy, and burner state intact.

.DESCRIPTION
    Tests EXISTING serializer functionality that never had a test: inventory-scanner.lua
    extract_equipment_grid() and deserializer.lua restore_equipment_grid() (equipment placement, energy,
    and burner currently_burning / remaining_burning_fuel / fuel inventory).

    FIXTURE IS RUNTIME-PROBED — see README.md in this directory (PLATFORM-FIXTURE-UNCERTAIN):
      * gridded holder: tries spidertron -> tank -> car via script create_entity (surface-condition bypass
        unverified at 2.0.77); falls back to a steel chest holding a power-armor ITEM whose stack.grid
        exercises the same scanner/deserializer pair via the item path.
      * burner equipment: probes every prototypes.equipment entry (grid.put -> check .burner). Vanilla
        2.0.77 is believed to have NONE — in that case the burner assertions are reported as SKIPPED and
        the grid/energy assertions still run against a battery-equipment mid-charge.

    All assertions are physical destination reads (grid contents, equipment energy, burner fields, fuel
    inventory counts via get_item_count) — never the validator's report.

    VALIDATED live (2.0.77, closer run) — originally authored offline; it now runs green against the shipped build.

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

Write-TestHeader "Equipment-Grid Burner Round-Trip (grid contents, energy, mid-burn state)"

$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance  = "clusterio-host-$SourceHost-instance-1"
$dstInstance  = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$name = "equipburn-$(Get-Date -Format 'HHmmss')-$([int](Get-Random -Minimum 100 -Maximum 999))"
Write-Host "  host-$SourceHost -> host-$DestHost   platform: $name" -ForegroundColor Gray
Write-Host ""

# Derived summary counts — never hardcoded totals.
$script:failed = 0
$script:total = 0
$script:skipped = 0
function Add-Result {
    param([string]$Id, [string]$TestName, [bool]$Ok, [string]$Message = "")
    $script:total++
    if ($Ok) { Write-TestResult -TestId $Id -TestName $TestName -Status "passed" }
    else { Write-TestResult -TestId $Id -TestName $TestName -Status "failed" -Message $Message; $script:failed++ }
}
function Add-Skipped {
    param([string]$Id, [string]$TestName)
    $script:skipped++
    Write-TestResult -TestId $Id -TestName $TestName -Status "skipped"
}

function Invoke-ProbeJson {
    param([string]$Instance, [string]$Body)
    $lua = "local ok,result=pcall(function() $Body end); if not ok then rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) else rcon.print(helpers.table_to_json(result)) end"
    $raw = Invoke-Lua -Instance $Instance -Code $lua
    if (-not $raw) { throw "Empty RCON response from $Instance" }
    try { return $raw | ConvertFrom-Json } catch { throw "Invalid probe JSON from ${Instance}: $raw" }
}

# One read probe used on BOTH sides. Locates the grid via the recorded fixture_kind, then reads equipment
# names (sorted), battery energy, and burner state defensively (currently_burning return shape varies).
function Read-GridState {
    param([string]$Instance, [double]$Ox, [double]$Oy, [string]$FixtureKind)
    $body = @"
local p = nil
for _, q in pairs(game.forces.player.platforms) do if q.valid and q.name == '$name' then p = q break end end
if not p then return { success = false, error = 'platform missing' } end
local s = p.surface
local out = { success = true, tick = game.tick, platform_paused = p.paused }
local grid = nil
if '$FixtureKind' == 'power-armor-stack' then
    local chest = s.find_entities_filtered({ name = 'steel-chest', position = { $Ox, $Oy }, radius = 0.6 })[1]
    out.have_holder = chest ~= nil
    if chest then
        out.armor_count = chest.get_item_count('power-armor')
        local inv = chest.get_inventory(defines.inventory.chest)
        if inv then
            for i = 1, #inv do
                local st = inv[i]
                if st.valid_for_read and st.name == 'power-armor' then
                    local okg, g = pcall(function() return st.grid end)
                    if okg and g and g.valid then grid = g end
                    break
                end
            end
        end
    end
else
    local holder = s.find_entities_filtered({ name = '$FixtureKind', position = { $Ox, $Oy }, radius = 2.5 })[1]
    out.have_holder = holder ~= nil
    if holder then
        local okg, g = pcall(function() return holder.grid end)
        if okg and g and g.valid then grid = g end
    end
end
out.have_grid = grid ~= nil
if grid then
    local names = {}
    for _, eq in ipairs(grid.equipment) do names[#names + 1] = eq.name end
    table.sort(names)
    out.equipment_names = table.concat(names, ',')
    out.equipment_count = #grid.equipment
    for _, eq in ipairs(grid.equipment) do
        if eq.name == 'battery-equipment' or eq.name == 'battery-mk2-equipment' then
            out.battery_energy = eq.energy
            out.battery_max = eq.max_energy
        end
        local okb, b = pcall(function() return eq.burner end)
        if okb and b then
            out.burner_equipment = eq.name
            local okc, cur = pcall(function() return b.currently_burning end)
            if okc and cur then
                if type(cur) == 'string' then out.burning_name = cur
                else
                    local n = cur.name
                    if type(n) == 'string' then out.burning_name = n
                    else
                        local okn, nn = pcall(function() return n.name end)
                        if okn then out.burning_name = nn end
                    end
                end
            end
            local okr, rem = pcall(function() return b.remaining_burning_fuel end)
            if okr then out.remaining_fuel = rem end
            local oki, cnt = pcall(function() return b.inventory.get_item_count('coal') end)
            if oki then out.burner_coal = cnt end
        end
    end
end
return out
"@
    return Invoke-ProbeJson -Instance $Instance -Body $body
}

try {

Assert-FactorioVersion -Instance $srcInstance | Out-Null

# 1. Build the bare-platform fixture with runtime probes (see README.md — PLATFORM-FIXTURE-UNCERTAIN).
Write-Status "Building bare platform '$name' with equipment-grid fixture (runtime-probed)..." -Type info
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
for x = -5, 5 do for y = -5, 5 do tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { ox + x, oy + y } } end end
s.set_tiles(tiles, true, false, true, false)
-- Probe 1: a platform-placeable gridded ENTITY (script create_entity may bypass surface conditions).
local holder, fixture_kind, grid = nil, nil, nil
for _, k in ipairs({ 'spidertron', 'tank', 'car' }) do
    local okc, e = pcall(function() return s.create_entity({ name = k, position = { ox, oy }, force = force }) end)
    if okc and e and e.valid then
        local okg, g = pcall(function() return e.grid end)
        if okg and g and g.valid then holder, fixture_kind, grid = e, k, g break end
        e.destroy()
    end
end
-- Fallback: power-armor ITEM in a chest — same scanner/deserializer pair via the stack.grid path.
if not grid then
    local chest = s.create_entity({ name = 'steel-chest', position = { ox, oy }, force = force })
    if not (chest and chest.valid) then return { success = false, error = 'no gridded vehicle placed AND chest create failed' } end
    if chest.insert({ name = 'power-armor', count = 1 }) ~= 1 then return { success = false, error = 'power-armor insert failed' } end
    local inv = chest.get_inventory(defines.inventory.chest)
    local stack = nil
    for i = 1, #inv do
        local st = inv[i]
        if st.valid_for_read and st.name == 'power-armor' then stack = st break end
    end
    if not stack then return { success = false, error = 'power-armor stack not found after insert' } end
    local okg, g = pcall(function() return stack.grid end)
    if not (okg and g and g.valid) then
        pcall(function() stack.create_grid() end)  -- intentional probe: grid may or may not auto-exist
        okg, g = pcall(function() return stack.grid end)
    end
    if not (okg and g and g.valid) then return { success = false, error = 'no equipment grid on power-armor stack' } end
    fixture_kind, grid = 'power-armor-stack', g
end
-- Probe 2: a BURNER equipment anywhere in the prototype set (vanilla 2.0.77 believed to have none).
local burner_eq_name, beq = nil, nil
for eq_name, _ in pairs(prototypes.equipment) do
    local okp, eq = pcall(function() return grid.put({ name = eq_name }) end)
    if okp and eq then
        local okb, b = pcall(function() return eq.burner end)
        if okb and b then burner_eq_name, beq = eq_name, eq break end
        grid.take({ equipment = eq })
    end
end
local burner = { available = burner_eq_name ~= nil }
if beq then
    local b = beq.burner
    local oki, ins = pcall(function() return b.inventory.insert({ name = 'coal', count = 5 }) end)
    burner.fuel_inserted = oki and ins or 0
    local okc, errc = pcall(function() b.currently_burning = 'coal' end)
    burner.set_burning_ok = okc
    if not okc then burner.set_burning_err = tostring(errc) end
    local okr, errr = pcall(function() b.remaining_burning_fuel = 2000000 end)
    burner.set_remaining_ok = okr
    if not okr then burner.set_remaining_err = tostring(errr) end
end
-- Battery mid-charge: the always-available grid-state fixture (nothing on this platform charges/drains it).
local bat = grid.put({ name = 'battery-equipment' })
if not bat then return { success = false, error = 'battery-equipment did not fit the grid' } end
bat.energy = bat.max_energy * 0.5
return { success = true, index = p.index, ox = ox, oy = oy, fixture_kind = fixture_kind,
    burner = burner, battery_energy = bat.energy, battery_max = bat.max_energy }
"@
$fx = Invoke-ProbeJson -Instance $srcInstance -Body $fixtureBody
if (-not $fx.success) { Write-Status "Fixture build failed: $($fx.error)" -Type error; exit 1 }
$ox = [double]$fx.ox; $oy = [double]$fx.oy
$fixtureKind = [string]$fx.fixture_kind
$burnerAvailable = ($fx.burner.available -eq $true)
Write-Status "Fixture ready: kind=$fixtureKind burner_equipment_available=$burnerAvailable battery=$($fx.battery_energy)/$($fx.battery_max)" -Type success
if ($fixtureKind -eq "power-armor-stack") {
    Write-Status "PLATFORM-FIXTURE-UNCERTAIN: no gridded vehicle placed on the platform; using the power-armor item-stack grid path (see README.md)" -Type warning
}
if (-not $burnerAvailable) {
    Write-Status "PLATFORM-FIXTURE-UNCERTAIN: no burner equipment in this prototype set; burner assertions will be SKIPPED (see README.md)" -Type warning
} elseif (-not (($fx.burner.set_burning_ok -eq $true) -and ($fx.burner.set_remaining_ok -eq $true))) {
    Write-Status "Burner mid-burn writes failed (burning_ok=$($fx.burner.set_burning_ok) err=$($fx.burner.set_burning_err); remaining_ok=$($fx.burner.set_remaining_ok) err=$($fx.burner.set_remaining_err))" -Type error
    exit 1
}

# 2. Source truth snapshot.
$src = Read-GridState -Instance $srcInstance -Ox $ox -Oy $oy -FixtureKind $fixtureKind
if (-not $src.success) { Write-Status "Source read failed: $($src.error)" -Type error; exit 1 }
if ($src.have_grid -ne $true) { Write-Status "Source grid not readable back — fixture bug" -Type error; exit 1 }
Write-Host "  source: equipment=[$($src.equipment_names)] battery=$($src.battery_energy)/$($src.battery_max) burner=$($src.burner_equipment) burning=$($src.burning_name) remaining=$($src.remaining_fuel) coal=$($src.burner_coal)" -ForegroundColor DarkGray

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
Add-Result "eqb-gate-passed" "Transfer gate passed (validation_success=true)" ($valSuccess -eq $true) "validation_success=$valSuccess — on failure the destination is discarded and every physical read below will miss"

# 5. Physical destination read (post-activation).
Start-Sleep -Seconds 4
$dst = Read-GridState -Instance $dstInstance -Ox $ox -Oy $oy -FixtureKind $fixtureKind
if (-not $dst.success) { Write-Status "Destination read failed: $($dst.error)" -Type error; exit 1 }
Write-Host "  dest:   equipment=[$($dst.equipment_names)] battery=$($dst.battery_energy)/$($dst.battery_max) burner=$($dst.burner_equipment) burning=$($dst.burning_name) remaining=$($dst.remaining_fuel) coal=$($dst.burner_coal)" -ForegroundColor DarkGray

# --- Assertions (all physical destination reads) ---

Add-Result "eqb-holder-present" "Grid holder ($fixtureKind) present on destination" ($dst.have_holder -eq $true) "holder missing at ($ox,$oy)"
if ($fixtureKind -eq "power-armor-stack") {
    Add-Result "eqb-armor-count" "power-armor item count exact ($($dst.armor_count)/1)" ([int]$dst.armor_count -eq 1) "dest chest holds $($dst.armor_count) power-armor, expected exactly 1"
}
Add-Result "eqb-grid-present" "Equipment grid present on destination" ($dst.have_grid -eq $true) "no valid grid on the destination holder"
Add-Result "eqb-equipment-list" "Equipment list matches source exactly (src=[$($src.equipment_names)] dst=[$($dst.equipment_names)])" `
    (("$($src.equipment_names)") -eq ("$($dst.equipment_names)")) "source '[$($src.equipment_names)]' vs destination '[$($dst.equipment_names)]'"

# Battery energy: deserializer restores eq.energy verbatim and nothing on this platform charges or drains
# the grid, so a 1%-of-max tolerance covers only float/serialization slop.
$srcBat = [double]$src.battery_energy; $dstBat = if ($null -ne $dst.battery_energy) { [double]$dst.battery_energy } else { -1 }
$batTol = [double]$src.battery_max * 0.01
Add-Result "eqb-battery-energy" "Battery equipment energy survives (src=$srcBat dst=$dstBat tol=$batTol)" `
    (($dstBat -ge 0) -and ([math]::Abs($dstBat - $srcBat) -le $batTol)) "dest battery energy $dstBat vs source $srcBat (tolerance $batTol)"

if ($burnerAvailable) {
    Add-Result "eqb-burner-present" "Burner equipment ($($src.burner_equipment)) present on destination grid" `
        (("$($dst.burner_equipment)") -eq ("$($src.burner_equipment)")) "src '$($src.burner_equipment)' vs dst '$($dst.burner_equipment)'"
    Add-Result "eqb-burning-item" "currently_burning survives (src='$($src.burning_name)' dst='$($dst.burning_name)')" `
        (("$($dst.burning_name)") -eq ("$($src.burning_name)")) "src '$($src.burning_name)' vs dst '$($dst.burning_name)'"
    # remaining_burning_fuel: must arrive positive and never ABOVE the source value plus slop — the burner
    # can only burn DOWN after activation; a higher value would mean a fresh (re-lit) burn, not a restore.
    $srcRem = [double]$src.remaining_fuel; $dstRem = if ($null -ne $dst.remaining_fuel) { [double]$dst.remaining_fuel } else { -1 }
    Add-Result "eqb-remaining-fuel" "remaining_burning_fuel mid-burn survives (src=$srcRem dst=$dstRem)" `
        (($dstRem -gt 0) -and ($dstRem -le ($srcRem * 1.01))) "dest remaining_burning_fuel $dstRem vs source $srcRem (expected 0 < dst <= src)"
    Add-Result "eqb-burner-fuel-inv" "Burner fuel inventory count exact (src=$($src.burner_coal) dst=$($dst.burner_coal))" `
        ([int]$dst.burner_coal -eq [int]$src.burner_coal) "dest burner coal $($dst.burner_coal) vs source $($src.burner_coal)"
} else {
    # PLATFORM-FIXTURE-UNCERTAIN: no burner equipment in this prototype set (expected on vanilla 2.0.77).
    Add-Skipped "eqb-burner-present" "Burner equipment round-trip SKIPPED — no burner equipment prototype available (see README.md)"
    Add-Skipped "eqb-burning-item" "currently_burning round-trip SKIPPED — no burner equipment prototype available"
    Add-Skipped "eqb-remaining-fuel" "remaining_burning_fuel round-trip SKIPPED — no burner equipment prototype available"
    Add-Skipped "eqb-burner-fuel-inv" "Burner fuel inventory round-trip SKIPPED — no burner equipment prototype available"
}

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
    Add-Result "eqb-zero-leftover-$inst" "Zero leftovers on $inst" ($null -eq $left) "platform '$name' still present (index $left)"
}

Write-TestSummary -Passed ($script:total - $script:failed) -Failed $script:failed -Skipped $script:skipped
if ($script:failed -gt 0) { exit 1 }
exit 0
