<#
.SYNOPSIS
    Item-grid + recipe-quality roundtrip — the adversarial fixture shipped WITH the review fixes:
    a gridded, QUALITY-equipped power armor stored INSIDE A CHEST (the slotted set_stack restore path)
    must arrive with its grid contents, equipment quality, and buffer levels intact; and a crafting
    machine's NON-NORMAL recipe quality must survive the transfer.

.DESCRIPTION
    Review findings this is the permanent tooth for (PR #102 adversarial review):
      * deserializer slotted set_stack path dropped equipment grids / nested inventories entirely —
        a chest-stored power armor arrived with an EMPTY grid, gate-blind (neither gate counter recurses
        into item.grid). Fixed by running full restore_item_properties on the slotted path.
      * restore_equipment_grid's grid.put() omitted quality — every restored piece silently downgraded
        to normal, gate-blind. Fixed by passing equip_data.quality at put() time.
      * recipe quality was NEVER captured (LuaEntity.get_recipe_quality() does not exist at 2.0.77 — the
        old probe swallowed) and the restore relied on a nonexistent recipe_quality attribute (its
        SIMPLE_RESTORE row always threw into safecall). Fixed: quality is get_recipe()'s SECOND return
        on export and rides set_recipe(name, quality) atomically on restore.

    Grounding (lint:test-grounding): every assertion is a PHYSICAL destination read — the armor stack's
    live grid.equipment (names, quality, energy, shield) and the machine's live get_recipe() second
    return. Never a validator self-report. Fresh defaults are sharp: a fresh-put grid piece is NORMAL
    quality with 0 energy/shield, and a recipe set without quality reads NORMAL — so any non-default
    destination reading proves the specific restore ran.

    Fixture (cheap — bare platform, no clone): a PAUSED bare platform far from the hub carrying
      * steel chest -> power-armor-mk2 with grid: battery-mk2-equipment (quality legendary, energy 5 MJ)
        + energy-shield-mk2-equipment (quality uncommon, shield seeded to ~half capacity)
      * assembling-machine-2 with set_recipe('iron-gear-wheel', 'uncommon'), no ingredients (idle).
    The armor is in a chest (not worn) and the machine is unpowered/ingredient-less, so post-activation
    drift is nil; bounds are tight.
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "🛡️ Item-Grid + Recipe-Quality Roundtrip (chest-stored gridded armor + quality recipe survive)"

$clone     = "itemgridrt-$(Get-Date -Format 'HHmmss')"
$prefix    = "itemgridrt-"
$srcInstance = $null
$dstInstance = $null
$dstContainer = $null
$script:total  = 0
$script:failed = 0

function Add-Result {
    param([string]$Id, [string]$Name, [bool]$Ok, [string]$Message = "")
    $script:total++
    if ($Ok) { Write-TestResult -TestId $Id -TestName $Name -Status passed }
    else { Write-TestResult -TestId $Id -TestName $Name -Status failed -Message $Message; $script:failed++ }
}

# One physical read probe used on BOTH sides: the armor stack's grid contents + the machine's recipe pair.
function Read-GridState {
    param([string]$Instance)
    return Invoke-Lua -Instance $Instance -ReturnJson -Code @"
local out = {chest_present=false, armor_present=false, grid_present=false, mach_present=false}
local ok, err = pcall(function()
  local function fp(n) for _,q in pairs(game.forces['player'].platforms or {}) do if q.valid and q.name==n then return q end end end
  local p = fp('$clone'); if not (p and p.valid) then out.no_platform=true; return end
  local s = p.surface
  local chest = s.find_entities_filtered({name='steel-chest'})[1]
  out.chest_present = chest ~= nil
  if chest then
    local inv = chest.get_inventory(defines.inventory.chest)
    for i = 1, #inv do
      local st = inv[i]
      if st.valid_for_read and st.name == 'power-armor-mk2' then
        out.armor_present = true
        local grid = st.grid
        out.grid_present = grid ~= nil and grid.valid
        if out.grid_present then
          local eq = {}
          for _, e in ipairs(grid.equipment) do
            eq[#eq+1] = {
              name = e.name,
              quality = e.quality and e.quality.name or 'normal',
              energy = e.energy,
              shield = (e.max_shield and e.max_shield > 0) and e.shield or nil,
              max_shield = e.max_shield
            }
          end
          out.equipment = eq
        end
        break
      end
    end
  end
  local mach = s.find_entities_filtered({name='assembling-machine-2'})[1]
  out.mach_present = mach ~= nil
  if mach then
    local r, q = mach.get_recipe()
    out.recipe = r and r.name
    out.recipe_quality = q and q.name or 'normal'
  end
end)
if not ok then out.error = tostring(err) end
rcon.print(helpers.table_to_json(out))
"@
}

try {
    if ($SourceHost -eq 0) {
        $SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
        if (-not $SourceHost) { throw "Reference platform '$SourcePlatform' not found on any host (used only to pick the source host)" }
    }
    $DestHost     = if ($SourceHost -eq 1) { 2 } else { 1 }
    $srcInstance  = "clusterio-host-$SourceHost-instance-1"
    $dstInstance  = "clusterio-host-$DestHost-instance-1"
    $dstContainer = "surface-export-host-$DestHost"
    $dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
    Assert-FactorioVersion -Instance $srcInstance | Out-Null
    Write-Host "  host-$SourceHost -> host-$DestHost   platform: $clone" -ForegroundColor Gray
    Write-Host ""

    # 1. Build the fixture on a bare, paused platform.
    $build = Invoke-Lua -Instance $srcInstance -ReturnJson -Code @"
local out = {success=false}
local ok, err = pcall(function()
  local force = game.forces['player']
  local platform = force.create_space_platform({name='$clone', planet='nauvis', starter_pack='space-platform-starter-pack'})
  if not (platform and platform.valid) then error('create_space_platform failed') end
  platform.apply_starter_pack()
  platform.schedule = { current = 1, records = { { station = 'nauvis' } } }
  if not (platform.surface and platform.surface.valid) then error('starter pack left no surface') end
  platform.paused = true
  force.set_surface_hidden(platform.surface, false)
  local s = platform.surface
  local ox, oy = 320, 320
  local tiles = {}
  for x=-6,6 do for y=-6,6 do tiles[#tiles+1] = {name='space-platform-foundation', position={ox+x, oy+y}} end end
  s.set_tiles(tiles, true, false, true, false)
  local chest = s.create_entity({name='steel-chest', position={ox, oy}, force=force})
  if not (chest and chest.valid) then error('chest create failed') end
  chest.insert({name='power-armor-mk2', count=1})
  local inv = chest.get_inventory(defines.inventory.chest)
  local armor
  for i = 1, #inv do local st = inv[i] if st.valid_for_read and st.name=='power-armor-mk2' then armor = st break end end
  if not armor then error('armor stack not found after insert') end
  local grid = armor.grid
  if not grid then error('armor has no grid') end
  local batt = grid.put({name='battery-mk2-equipment', quality='legendary'})
  if not batt then error('battery put failed') end
  batt.energy = 5000000
  local shieldEq = grid.put({name='energy-shield-mk2-equipment', quality='uncommon'})
  if not shieldEq then error('shield put failed') end
  local half = math.floor(shieldEq.max_shield / 2)
  shieldEq.shield = half
  local mach = s.create_entity({name='assembling-machine-2', position={ox+5, oy}, force=force})
  if not (mach and mach.valid) then error('machine create failed') end
  mach.set_recipe('iron-gear-wheel', 'uncommon')
  local r, q = mach.get_recipe()
  out.index = platform.index
  out.batt_quality = batt.quality and batt.quality.name
  out.batt_energy = batt.energy
  out.shield_quality = shieldEq.quality and shieldEq.quality.name
  out.shield_value = shieldEq.shield
  out.shield_max = shieldEq.max_shield
  out.recipe = r and r.name
  out.recipe_quality = q and q.name
  out.success = true
end)
if not ok then out.error = tostring(err) end
rcon.print(helpers.table_to_json(out))
"@
    if (-not $build -or -not $build.success) {
        throw "Fixture build failed: $(if ($build) { $build.error } else { 'no JSON returned' })"
    }
    Start-Sleep -Seconds 2
    $idx = Get-PlatformIndex -Instance $srcInstance -PlatformName $clone
    if (-not $idx) { throw "Fixture platform '$clone' did not materialize" }
    $srcBattEnergy  = [double]$build.batt_energy
    $srcShieldValue = [double]$build.shield_value
    Write-Status "Fixture ready: battery=$($build.batt_quality)/$srcBattEnergy J, shield=$($build.shield_quality)/$srcShieldValue of $($build.shield_max), recipe=$($build.recipe)/$($build.recipe_quality)" -Type success

    # A0. Fixture grounding: the SOURCE physically holds the non-default states we claim to transfer.
    Add-Result "igr-fixture-grounded" "Source holds legendary battery (energy>0), uncommon shield (>0), uncommon recipe" `
        (($build.batt_quality -eq 'legendary') -and ($srcBattEnergy -gt 0) -and
         ($build.shield_quality -eq 'uncommon') -and ($srcShieldValue -gt 0) -and
         ($build.recipe -eq 'iron-gear-wheel') -and ($build.recipe_quality -eq 'uncommon')) `
        "fixture readback: $($build | ConvertTo-Json -Compress)"

    # 2. Transfer the bare platform host -> host.
    $destId = Get-ClusterioInstanceId -InstanceName $dstInstance
    docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
    Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
    Write-Status "Transfer initiated..." -Type info

    # 3. Wait for the destination import-result, adjudicate the verdict, then settle.
    $start = Get-Date; $resultFile = $null
    while (-not $resultFile -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
        Start-Sleep -Seconds 2
        $files = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${clone}_*.json" | Sort-Object -Descending)
        if ($files.Count -gt 0) { $resultFile = $files[0] }
    }
    if (-not $resultFile) { throw "No import-result after ${TimeoutSec}s (transfer may have stalled)" }
    $resultData  = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $resultFile
    $valSuccess  = Get-SafeProperty $resultData "validation_success"
    $failedStage = Get-SafeProperty (Get-SafeProperty $resultData "validation_result") "failedStage"
    Add-Result "igr-gate-passed" "Transfer passed the exact gate (destination committed)" `
        ($valSuccess -eq $true) "validation_success=$valSuccess failedStage=$failedStage — dest discarded on failure; physical reads below will be empty"
    Assert-TransferSucceeded -Result $resultData -Context "Item-grid transfer"
    Start-Sleep -Seconds 4

    # 4. Physically read the LIVE destination.
    $dst = Read-GridState -Instance $dstInstance
    Write-Status "Dest: chest=$($dst.chest_present) armor=$($dst.armor_present) grid=$($dst.grid_present) equipment=$(($dst.equipment | ConvertTo-Json -Compress)) recipe=$($dst.recipe)/$($dst.recipe_quality)" -Type info

    # A1. The chest-stored armor + its grid arrived at all (the finding-1 tooth: pre-fix the grid was EMPTY).
    Add-Result "igr-armor-present" "Chest-stored power armor present on destination" ($dst.armor_present -eq $true) "armor stack missing from destination chest"
    Add-Result "igr-grid-present" "Armor equipment grid present on destination" ($dst.grid_present -eq $true) "armor arrived without a grid"
    $eqCount = if ($dst.equipment) { @($dst.equipment).Count } else { 0 }
    Add-Result "igr-grid-populated" "Grid holds both equipment pieces ($eqCount/2)" ($eqCount -eq 2) "grid equipment count=$eqCount (pre-fix: slotted set_stack path dropped grid restoration entirely -> 0)"

    $battery = if ($dst.equipment) { @($dst.equipment) | Where-Object { $_.name -eq 'battery-mk2-equipment' } | Select-Object -First 1 } else { $null }
    $shield  = if ($dst.equipment) { @($dst.equipment) | Where-Object { $_.name -eq 'energy-shield-mk2-equipment' } | Select-Object -First 1 } else { $null }

    # A2. Equipment QUALITY survives (the finding-3 tooth: pre-fix grid.put omitted quality -> normal).
    Add-Result "igr-battery-quality" "Battery equipment quality survives (legendary -> '$($battery.quality)')" `
        ($battery -and $battery.quality -eq 'legendary') "battery quality='$($battery.quality)' (fresh-put default is normal)"
    Add-Result "igr-shield-quality" "Shield equipment quality survives (uncommon -> '$($shield.quality)')" `
        ($shield -and $shield.quality -eq 'uncommon') "shield quality='$($shield.quality)' (fresh-put default is normal)"

    # A3. Buffer levels survive (fresh-put defaults are 0; the armor is chest-stored so nothing drains).
    $battEnergy = if ($battery) { [double]$battery.energy } else { 0 }
    $battBound = [Math]::Max(50000.0, 0.10 * $srcBattEnergy)
    Add-Result "igr-battery-energy" "Battery energy within bound (|$battEnergy - $srcBattEnergy| <= $battBound)" `
        ($battery -and ([Math]::Abs($battEnergy - $srcBattEnergy) -le $battBound)) "dest battery energy=$battEnergy vs source $srcBattEnergy (fresh-put default is 0)"
    $shieldValue = if ($shield) { [double]$shield.shield } else { 0 }
    $shieldBound = [Math]::Max(5.0, 0.10 * $srcShieldValue)
    Add-Result "igr-shield-value" "Shield charge within bound (|$shieldValue - $srcShieldValue| <= $shieldBound)" `
        ($shield -and ([Math]::Abs($shieldValue - $srcShieldValue) -le $shieldBound)) "dest shield=$shieldValue vs source $srcShieldValue (fresh-put default is 0)"

    # A4. Recipe QUALITY survives (the finding-11 tooth: pre-fix quality was never captured NOR restorable).
    Add-Result "igr-recipe-name" "Machine recipe name survives ('$($dst.recipe)')" `
        ($dst.mach_present -eq $true -and $dst.recipe -eq 'iron-gear-wheel') "dest recipe='$($dst.recipe)'"
    Add-Result "igr-recipe-quality" "Machine recipe QUALITY survives (uncommon -> '$($dst.recipe_quality)')" `
        ($dst.recipe_quality -eq 'uncommon') "dest recipe_quality='$($dst.recipe_quality)' (a set_recipe without quality reads normal)"
}
finally {
    if ($srcInstance) { try { Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "string.find(p.name, '$prefix', 1, true)" | Out-Null } catch {} }
    if ($dstInstance) { try { Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "string.find(p.name, '$prefix', 1, true)" | Out-Null } catch {} }
    foreach ($inst in @($srcInstance, $dstInstance)) {
        if (-not $inst) { continue }
        try {
            Invoke-Lua -Instance $inst -Code @"
local cleared = 0
if storage.locked_platforms then
  for key, lock in pairs(storage.locked_platforms) do
    if type(lock) == 'table' and type(lock.platform_name) == 'string' and string.find(lock.platform_name, '$prefix', 1, true) then
      storage.locked_platforms[key] = nil; cleared = cleared + 1
    end
  end
end
rcon.print('cleared ' .. cleared)
"@ | Out-Null
        } catch {}
    }
    if ($srcInstance) { try { Step-Tick -Instance $srcInstance -Ticks 5 | Out-Null } catch {} }
}

# Zero-leftover proof: no fixture surfaces and no leaked locks on either host, game unpaused.
foreach ($pair in @(@{ i = $srcInstance; h = $SourceHost }, @{ i = $dstInstance; h = $DestHost })) {
    if (-not $pair.i) { continue }
    try {
        $left = Invoke-Lua -Instance $pair.i -ReturnJson -Code @"
local surfaces = 0
for _, s in pairs(game.surfaces) do
  local pf = s.platform
  if pf and pf.valid and string.find(pf.name, '$prefix', 1, true) then surfaces = surfaces + 1 end
end
local locks = 0
if storage.locked_platforms then
  for _, lock in pairs(storage.locked_platforms) do
    if type(lock) == 'table' and type(lock.platform_name) == 'string' and string.find(lock.platform_name, '$prefix', 1, true) then locks = locks + 1 end
  end
end
rcon.print(helpers.table_to_json({surfaces=surfaces, locks=locks, paused=game.tick_paused == true}))
"@
        Add-Result "igr-cleanup-host$($pair.h)" "Host-$($pair.h): zero fixture surfaces, zero leaked locks, game unpaused" `
            (([int]$left.surfaces -eq 0) -and ([int]$left.locks -eq 0) -and ($left.paused -eq $false)) `
            "surfaces=$($left.surfaces) locks=$($left.locks) paused=$($left.paused)"
    } catch {
        Add-Result "igr-cleanup-host$($pair.h)" "Host-$($pair.h): zero-leftover proof" $false $_.Exception.Message
    }
}

Write-TestSummary -Passed ($script:total - $script:failed) -Failed $script:failed
if ($script:failed -gt 0) { exit 1 }
exit 0
