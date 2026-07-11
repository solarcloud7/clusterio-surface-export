<#
.SYNOPSIS
    Heat roundtrip — a heat-carrying entity's heat-buffer temperature must survive a transfer
    (restored non-default, within a small justified bound of the frozen source value).

.DESCRIPTION
    UNVALIDATED — authored ahead of the serializer capability it exercises (workstream 3c item 9). It is
    expected to be RED until the parallel implementer lands entity-heat serialization
    (specific_data.temperature = entity.temperature — the entity heat buffer, NOT a fluid temperature —
    restored post-creation). A closer agent executes it against the implementer's build.

    Grounding (lint:test-grounding): the assertion reads the LIVE destination entity's physical
    entity.temperature — NEVER a serializer self-report field. A fresh heat entity sits at its default
    (~15 °C), so "substantially non-default on the destination" is the sharp signal that restoration ran;
    the bounded check is cross-grounded against the frozen source read-back.

    Fixture (cheap — never the 1,359-entity clone): a bare platform (create_space_platform +
    apply_starter_pack), PAUSED before the fixture is built. A single heat entity is force-created on a
    foundation block far (offset 320) from the hub and set to a distinctive 500 °C. Because it is
    isolated (no adjacent heat entity to conduct into), Factorio's heat model conserves its buffer — it
    holds temperature post-activation, so the bound only absorbs settling + float round-trip.

    Cluster-dependent assumptions (verify on execution; all RED-until-implementer):
      * a heat-carrying entity force-creates on a platform. create_entity bypasses platform build
        restrictions; the fixture tries heat-pipe, then nuclear-reactor, then heat-exchanger — whichever
        places is used and reported. Creation AND destination-presence are grounded separately.
      * a bare platform transfers end-to-end (the gate-success prerequisite surfaces it if not).
      * the isolated heat entity holds its buffer post-activation (no heat neighbour to conduct into); the
        bound (25 °C or 5%) absorbs settling. entity.temperature may clamp to the prototype max on set —
        the frozen read-back is the source-of-truth, so a clamp is absorbed.
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "🌡️ Heat Roundtrip (entity heat-buffer temperature survives a transfer) — UNVALIDATED"

$clone     = "heatrt-$(Get-Date -Format 'HHmmss')"
$prefix    = "heatrt-"
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

    # 1. Build the frozen heat fixture on a bare, paused platform; read back the source temperature.
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
  for x=-8,8 do for y=-8,8 do tiles[#tiles+1] = {name='space-platform-foundation', position={ox+x, oy+y}} end end
  s.set_tiles(tiles, true, false, true, false)
  local h
  for _, nm in ipairs({'heat-pipe', 'nuclear-reactor', 'heat-exchanger'}) do
    local okc, e = pcall(function() return s.create_entity({name=nm, position={ox, oy}, force=force}) end)
    if okc and e and e.valid then h = e; break end
  end
  if not (h and h.valid) then error('could not force-create a heat-carrying entity (heat-pipe/nuclear-reactor/heat-exchanger)') end
  pcall(function() h.temperature = 500 end)
  out.index = platform.index
  out.name = platform.name
  out.h_name = h.name
  out.h_temp = h.temperature
  out.h_x = h.position.x
  out.h_y = h.position.y
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
    $srcTemp   = [double]$build.h_temp
    $heatName  = [string]$build.h_name
    Write-Status "Fixture ready: entity='$heatName' temperature=$srcTemp" -Type success

    # A0. Fixture grounding: the source heat entity is genuinely hot (well above the ~15 C default).
    Add-Result "heatrt-fixture-grounded" "Source heat entity is hot (temperature=$srcTemp, well above the ~15 C default)" `
        ($srcTemp -gt 100) "h_temp=$srcTemp (fixture did not raise the heat buffer)"

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
    Start-Sleep -Seconds 4

    $resultData  = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $resultFile
    $valSuccess  = Get-SafeProperty $resultData "validation_success"
    $failedStage = Get-SafeProperty (Get-SafeProperty $resultData "validation_result") "failedStage"

    # A1. Gate-success PREREQUISITE (not grounding): on a gate failure the destination is discarded, so
    #     the physical read below would find nothing — surface the real cause here.
    Add-Result "heatrt-gate-passed" "Transfer passed the exact gate (destination committed)" `
        ($valSuccess -eq $true) "validation_success=$valSuccess failedStage=$failedStage — dest discarded on failure; the physical read below will be empty"

    # 4. Physically read the LIVE destination entity's heat-buffer temperature.
    $dst = Invoke-Lua -Instance $dstInstance -ReturnJson -Code @"
local out = {present=false}
local ok, err = pcall(function()
  local function fp(n) for _,q in pairs(game.forces['player'].platforms or {}) do if q.name==n then return q end end end
  local p = fp('$clone'); if not (p and p.valid) then out.no_platform=true; return end
  local s = p.surface
  local e
  for _, x in ipairs(s.find_entities_filtered({name='$heatName', position={$($build.h_x), $($build.h_y)}, radius=3})) do
    if x.valid then e = x; break end
  end
  if not (e and e.valid) then out.no_entity=true; return end
  out.present = true
  local okt, t = pcall(function() return e.temperature end)
  if okt then out.h_temp = t end
end)
if not ok then out.error = tostring(err) end
rcon.print(helpers.table_to_json(out))
"@
    $dstPresent = ($dst -and $dst.present -eq $true)
    $dstTemp    = if ($dstPresent -and ($null -ne $dst.h_temp)) { [double]$dst.h_temp } else { -1 }
    Write-Status "Dest: present=$dstPresent temperature=$dstTemp" -Type info

    # A2. Dest-presence (separates "entity not transferable" from "temperature lost").
    Add-Result "heatrt-dest-present" "Heat entity present on the destination platform" `
        $dstPresent "dst=$($dst | ConvertTo-Json -Compress) (entity absent on destination)"

    # A3. Temperature substantially non-default (fresh heat entity sits at ~15 C). PRIMARY signal.
    Add-Result "heatrt-temp-nondefault" "Heat-buffer temperature restored well above the ~15 C default (=$dstTemp)" `
        ($dstPresent -and ($dstTemp -gt 100)) "dest temperature=$dstTemp (fresh default ~15 C; >100 C proves the heat-buffer restore ran)"

    # A4. Temperature within a justified bound of the frozen source value (isolated -> holds).
    $tempBound = [Math]::Max(25.0, 0.05 * $srcTemp)
    $tempDelta = [Math]::Abs($dstTemp - $srcTemp)
    Add-Result "heatrt-temp-bounded" "Heat-buffer temperature within bound (|$dstTemp - $srcTemp| <= $tempBound)" `
        ($dstPresent -and ($dstTemp -ge 0) -and ($tempDelta -le $tempBound)) "delta=$tempDelta exceeds bound=$tempBound (isolated heat entity conducts nowhere; bound = 25 C or 5%)"
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
        Add-Result "heatrt-cleanup-host$($pair.h)" "Host-$($pair.h): zero fixture surfaces, zero leaked locks, game unpaused" `
            (([int]$left.surfaces -eq 0) -and ([int]$left.locks -eq 0) -and ($left.paused -eq $false)) `
            "surfaces=$($left.surfaces) locks=$($left.locks) paused=$($left.paused)"
    } catch {
        Add-Result "heatrt-cleanup-host$($pair.h)" "Host-$($pair.h): zero-leftover proof" $false $_.Exception.Message
    }
}

Write-TestSummary -Passed ($script:total - $script:failed) -Failed $script:failed
if ($script:failed -gt 0) { exit 1 }
exit 0
