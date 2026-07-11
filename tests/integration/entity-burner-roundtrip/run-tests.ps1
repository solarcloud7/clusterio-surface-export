<#
.SYNOPSIS
    Entity-burner roundtrip — a mid-burn burner entity's active-fuel state must survive a transfer:
    the fuel inventory count is exact, currently_burning (name + quality) survives, and
    remaining_burning_fuel is restored (non-default, within a small justified bound).

.DESCRIPTION
    UNVALIDATED — authored ahead of the serializer capability it exercises (workstream 3c item 7). It
    is expected to be RED until the parallel implementer lands entity-burner serialization
    (specific_data.burner = { currently_burning = {name, quality} or nil, remaining_burning_fuel }
    restored post-creation). A closer agent executes it against the implementer's build.

    Grounding (lint:test-grounding): assertions read the LIVE destination entity physically
    (get_inventory(defines.inventory.fuel).get_item_count, burner.currently_burning,
    burner.remaining_burning_fuel) — NEVER a serializer self-report field. A fresh, never-ticked burner
    has currently_burning=nil and remaining_burning_fuel=0, so "non-default on the destination" is the
    sharp signal that restoration ran; the exact/bounded checks are cross-grounded against the frozen
    source read-back.

    DISTINCT-FUEL DISCRIMINATOR (the crux — a burner is engine-managed AFTER activation, unlike the
    energy/heat probes whose isolated entities are passive): the fuel INVENTORY holds coal, but
    currently_burning is set to a DIFFERENT fuel — solid-fuel. This defeats a false-green: an activated
    inserter with an empty energy buffer self-loads currently_burning from its fuel inventory whether or
    not the serializer restored anything — but a self-load shows COAL, so only a genuine restore shows
    SOLID-FUEL. remaining_burning_fuel is set to ~2 MJ; a self-loaded coal would read ~4 MJ (coal's full
    fuel_value), so the ~2 MJ bound also discriminates restore from self-load. The fuel-inventory coal
    count is exact when restored (currently_burning=solid-fuel means no coal is pulled) and drops by one
    on a self-load — so A3/A4/A7 are the load-bearing checks; A6 (remaining>0) is only a weak sanity
    check for a burner, because a self-load also yields remaining>0.

    Fixture (cheap — never the 1,359-entity clone): a bare platform (create_space_platform +
    apply_starter_pack), PAUSED before the fixture is built so the burner cannot tick before the transfer
    lock. A single burner entity is force-created on a foundation block far (offset 320) from the hub.
    The destination is read promptly after the import-result (short settle) to minimise post-activation
    mutation of the engine-managed burner fields.

    Cluster-dependent assumptions (verify on execution; all RED-until-implementer):
      * A burner ENTITY force-creates on a space platform. create_entity bypasses platform build
        restrictions (destination-hold force-creates a stone-furnace/pipe/tank on a platform), and the
        fixture tries burner-inserter FIRST (a self-loading inserter retains a restored currently_burning
        until its remaining fuel depletes), then stone-furnace — whichever places is used and reported.
      * A bare platform transfers end-to-end. The gate-success prerequisite check surfaces it if not.
      * Burner post-activation semantics at 2.0.77 (NOT in api-notes — the distinct-fuel design hedges
        both answers): an activated idle inserter retains a restored currently_burning; a self-load
        pulls the inventory fuel (coal), not solid-fuel. CLOSER NOTE: if execution shows the engine
        RESETS burner fuel on activation regardless of the serializer (e.g. a stone-furnace fallback
        drops a script-set currently_burning), this dimension needs a frozen PRE-activation read that the
        energy/heat probes do not — the "post-activation is what matters" justification does not transfer
        to an actively-managed burner.
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "🔥 Entity-Burner Roundtrip (mid-burn fuel state survives a transfer) — UNVALIDATED"

$clone     = "burnerrt-$(Get-Date -Format 'HHmmss')"
$prefix    = "burnerrt-"
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

    # 1. Build the frozen mid-burn fixture on a bare, paused platform; read back the source values.
    $build = Invoke-Lua -Instance $srcInstance -ReturnJson -Code @"
local out = {success=false}
local ok, err = pcall(function()
  local force = game.forces['player']
  local platform = force.create_space_platform({name='$clone', planet='nauvis', starter_pack='space-platform-starter-pack'})
  if not (platform and platform.valid) then error('create_space_platform failed') end
  platform.apply_starter_pack()
  if not (platform.surface and platform.surface.valid) then error('starter pack left no surface') end
  platform.paused = true
  force.set_surface_hidden(platform.surface, false)
  local s = platform.surface
  local ox, oy = 320, 320
  local tiles = {}
  for x=-6,6 do for y=-6,6 do tiles[#tiles+1] = {name='space-platform-foundation', position={ox+x, oy+y}} end end
  s.set_tiles(tiles, true, false, true, false)
  local e
  for _, nm in ipairs({'burner-inserter', 'stone-furnace'}) do
    local okc, ent = pcall(function() return s.create_entity({name=nm, position={ox, oy}, force=force}) end)
    if okc and ent and ent.valid then e = ent; break end
  end
  if not (e and e.valid) then error('could not force-create a burner entity (burner-inserter/stone-furnace)') end
  local fi = e.get_inventory(defines.inventory.fuel)
  if not fi then error('burner entity has no fuel inventory') end
  fi.insert({name='coal', count=10})
  local b = e.burner
  if not b then error('entity exposes no LuaBurner') end
  -- currently_burning is set to solid-fuel, DISTINCT from the coal in the fuel inventory, so a
  -- post-activation self-load (which pulls the inventory fuel, coal) cannot masquerade as a restore.
  pcall(function() b.currently_burning = {name='solid-fuel', quality='normal'} end)
  if not b.currently_burning then pcall(function() b.currently_burning = 'solid-fuel' end) end
  pcall(function() b.remaining_burning_fuel = 2000000 end)
  out.entity_name = e.name
  out.x = e.position.x
  out.y = e.position.y
  out.index = platform.index
  out.name = platform.name
  out.fuel_coal = fi.get_item_count('coal')
  out.remaining = b.remaining_burning_fuel or 0
  local cb = b.currently_burning
  if cb then
    local n = cb.name; if type(n) == 'table' then n = n.name end; out.cb_name = n
    local q = cb.quality; if type(q) == 'table' then q = q.name end; out.cb_quality = q
  end
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
    $srcFuel      = [int]$build.fuel_coal
    $srcRemaining = [double]$build.remaining
    $srcCbName    = [string]$build.cb_name
    $srcCbQuality = [string]$build.cb_quality
    $entityName   = [string]$build.entity_name
    Write-Status "Fixture ready: entity='$entityName' fuel_coal=$srcFuel currently_burning=$srcCbName/$srcCbQuality remaining=$srcRemaining" -Type success

    # A0. Fixture grounding: the source really holds a mid-burn state (else the roundtrip proves nothing).
    Add-Result "burnerrt-fixture-grounded" "Source burner is mid-burn (coal in fuel inv, currently_burning=solid-fuel — DISTINCT from inventory fuel, remaining>0)" `
        (($srcFuel -gt 0) -and ($srcCbName -eq "solid-fuel") -and ($srcRemaining -gt 0)) `
        "fuel_coal=$srcFuel cb_name=$srcCbName remaining=$srcRemaining (fixture did not reach a mid-burn state)"

    # 2. Transfer the bare platform host -> host.
    $destId = Get-ClusterioInstanceId -InstanceName $dstInstance
    docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
    Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
    Write-Status "Transfer initiated..." -Type info

    # 3. Wait for the destination import-result, then let activation settle.
    $start = Get-Date; $resultFile = $null
    while (-not $resultFile -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
        Start-Sleep -Seconds 2
        $files = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${clone}_*.json" | Sort-Object -Descending)
        if ($files.Count -gt 0) { $resultFile = $files[0] }
    }
    if (-not $resultFile) { throw "No import-result after ${TimeoutSec}s (transfer may have stalled)" }
    # Short settle only: the burner is engine-managed once activated, so read it promptly to minimise
    # post-activation mutation of currently_burning / remaining_burning_fuel.
    Start-Sleep -Seconds 1

    $resultData  = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $resultFile
    $valSuccess  = Get-SafeProperty $resultData "validation_success"
    $failedStage = Get-SafeProperty (Get-SafeProperty $resultData "validation_result") "failedStage"

    # A1. Gate-success PREREQUISITE (not grounding): on a gate failure the destination is discarded, so
    #     an item/fluid reconciliation bug for currently_burning coal would make the physical reads below
    #     find nothing — surface the real cause here rather than mislabel it as "burner state lost".
    Add-Result "burnerrt-gate-passed" "Transfer passed the exact gate (destination committed)" `
        ($valSuccess -eq $true) "validation_success=$valSuccess failedStage=$failedStage — dest discarded on failure; physical reads below will be empty"

    # 4. Physically read the LIVE destination entity.
    $dst = Invoke-Lua -Instance $dstInstance -ReturnJson -Code @"
local out = {present=false}
local ok, err = pcall(function()
  local function fp(n) for _,q in pairs(game.forces['player'].platforms or {}) do if q.name==n then return q end end end
  local p = fp('$clone'); if not (p and p.valid) then out.no_platform=true; return end
  local s = p.surface
  local e
  for _, x in ipairs(s.find_entities_filtered({name='$entityName', position={$($build.x), $($build.y)}, radius=3})) do
    if x.valid then e = x; break end
  end
  if not (e and e.valid) then out.no_entity=true; return end
  out.present = true
  local fi = e.get_inventory(defines.inventory.fuel)
  out.fuel_coal = fi and fi.get_item_count('coal') or -1
  local b = e.burner
  if b then
    out.remaining = b.remaining_burning_fuel or 0
    local cb = b.currently_burning
    if cb then
      local n = cb.name; if type(n) == 'table' then n = n.name end; out.cb_name = n
      local q = cb.quality; if type(q) == 'table' then q = q.name end; out.cb_quality = q
    end
  end
end)
if not ok then out.error = tostring(err) end
rcon.print(helpers.table_to_json(out))
"@
    $dstPresent = ($dst -and $dst.present -eq $true)
    $dstFuel      = if ($dstPresent) { [int]$dst.fuel_coal } else { -1 }
    $dstRemaining = if ($dstPresent) { [double]$dst.remaining } else { 0 }
    $dstCbName    = if ($dstPresent) { [string]$dst.cb_name } else { "" }
    $dstCbQuality = if ($dstPresent) { [string]$dst.cb_quality } else { "" }
    Write-Status "Dest: present=$dstPresent fuel_coal=$dstFuel currently_burning=$dstCbName/$dstCbQuality remaining=$dstRemaining" -Type info

    # A2. Dest-presence (separates "entity not transferable" from "burner state lost").
    Add-Result "burnerrt-dest-present" "Burner entity present on the destination platform" `
        $dstPresent "dst=$($dst | ConvertTo-Json -Compress) (entity absent on destination)"

    # A3. Fuel inventory count exact (the pre-existing inventory path).
    Add-Result "burnerrt-fuel-exact" "Fuel inventory coal count exact across transfer ($srcFuel -> $dstFuel)" `
        ($dstPresent -and ($dstFuel -eq $srcFuel)) "source fuel_coal=$srcFuel dest fuel_coal=$dstFuel"

    # A4. currently_burning name survives — LOAD-BEARING. Source burns solid-fuel while the fuel
    #     inventory holds coal, so dest=solid-fuel proves a genuine restore; dest=coal would mean a
    #     post-activation self-load (restore did NOT run); dest=empty means it was dropped.
    Add-Result "burnerrt-currently-burning-name" "currently_burning item name survives, distinct from inventory fuel ($srcCbName -> $dstCbName)" `
        ($dstPresent -and ($dstCbName -eq $srcCbName) -and ($dstCbName -ne "")) "source cb_name=$srcCbName dest cb_name=$dstCbName (dest='coal' => self-loaded inventory fuel, not restored)"

    # A5. currently_burning quality survives.
    Add-Result "burnerrt-currently-burning-quality" "currently_burning quality survives ($srcCbQuality -> $dstCbQuality)" `
        ($dstPresent -and ($dstCbQuality -eq $srcCbQuality) -and ($dstCbQuality -ne "")) "source cb_quality=$srcCbQuality dest cb_quality=$dstCbQuality"

    # A6. remaining_burning_fuel present — WEAK SANITY ONLY (a post-activation self-load also yields
    #     remaining>0), so this does not by itself prove the new capability; A4 + A7 do.
    Add-Result "burnerrt-remaining-present" "remaining_burning_fuel present on the destination (weak sanity: =$dstRemaining)" `
        ($dstPresent -and ($dstRemaining -gt 0)) "dest remaining_burning_fuel=$dstRemaining (no active-fuel state at all)"

    # A7. remaining_burning_fuel within a justified bound of the frozen source — LOAD-BEARING. A restored
    #     solid-fuel burn reads ~2 MJ; a self-loaded coal reads ~4 MJ (coal's full fuel_value), which the
    #     bound rejects. Bound = 5% or 50 kJ: absorbs the initial buffer-fill draw + JSON float round-trip.
    $remainBound = [Math]::Max(50000.0, 0.05 * $srcRemaining)
    $remainDelta = [Math]::Abs($dstRemaining - $srcRemaining)
    Add-Result "burnerrt-remaining-bounded" "remaining_burning_fuel within bound (|$dstRemaining - $srcRemaining| <= $remainBound)" `
        ($dstPresent -and ($remainDelta -le $remainBound)) "delta=$remainDelta exceeds bound=$remainBound (a self-loaded coal would read ~4 MJ vs the restored ~2 MJ)"
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
        Add-Result "burnerrt-cleanup-host$($pair.h)" "Host-$($pair.h): zero fixture surfaces, zero leaked locks, game unpaused" `
            (([int]$left.surfaces -eq 0) -and ([int]$left.locks -eq 0) -and ($left.paused -eq $false)) `
            "surfaces=$($left.surfaces) locks=$($left.locks) paused=$($left.paused)"
    } catch {
        Add-Result "burnerrt-cleanup-host$($pair.h)" "Host-$($pair.h): zero-leftover proof" $false $_.Exception.Message
    }
}

Write-TestSummary -Passed ($script:total - $script:failed) -Failed $script:failed
if ($script:failed -gt 0) { exit 1 }
exit 0
