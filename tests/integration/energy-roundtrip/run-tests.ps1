<#
.SYNOPSIS
    Energy roundtrip — a charged accumulator (energy serialized ALWAYS) and a powered machine with a
    nonzero energy buffer (energy serialized when > 0) must keep their stored joules across a transfer.

.DESCRIPTION
    VALIDATED live (2.0.77, closer run) — originally authored ahead of the serializer capability it
    exercises; it now runs green against the shipped build and serves as the permanent regression tooth.

    Grounding (lint:test-grounding): assertions read the LIVE destination entity's physical entity.energy
    — NEVER a serializer self-report field. A fresh, unpowered entity has energy=0, so "substantially
    non-default on the destination" is the sharp signal that restoration ran; the bounded checks are
    cross-grounded against the frozen source read-back.

    Fixture (cheap — never the 1,359-entity clone): a bare platform (create_space_platform +
    apply_starter_pack), PAUSED before the fixture is built so buffers cannot tick-drift. Two entities are
    force-created near the hub on a starter platform that carries NO other electric participants (no
    generation, no other consumers — the hub itself provides no power), so their buffers have nothing to
    drain into. Every electric entity on a platform surface joins ONE network regardless of distance, so the
    offset is a historical placement convention with no electrical effect. The two entities:
      * an accumulator, entity.energy set to ~3 MJ (accumulator capacity is 5 MJ) — exercises the
        "accumulators always" branch; with no discharge demand it holds charge post-activation.
      * an electric assembling-machine with NO recipe (idle), entity.energy set > 0 — exercises the
        "others when > 0" branch; idle + unpowered it does no work, so its buffer holds.

    The energy-may-drain caveat: there is no clean hook to read the destination BEFORE activation on a
    SUCCESSFUL transfer (preserve/defer is a failure-path debug feature), and the contract says
    post-activation is what matters. Nothing else on the platform generates or consumes power, so the
    hold is near-exact; the bounds distinguish "restored" from "read the fresh-entity default of 0" while
    tolerating minor post-activation drain.

    Cluster-dependent assumptions (verify on execution; all RED-until-implementer):
      * accumulator + an electric assembling-machine force-create on a platform (create_entity bypasses
        platform build restrictions) and round-trip through export/import as ordinary entities. Creation
        AND destination-presence are grounded separately so "not transferable" is distinct from "energy
        not serialized".
      * a bare platform transfers end-to-end (the gate-success prerequisite surfaces it if not).
      * post-activation drain bounds: accumulator (no discharge demand) tight (10% or 50 kJ); idle
        machine (a live buffer may bleed) loose (>0 and within 50%). entity.energy may clamp to buffer
        capacity on set — the frozen read-back is used as the source-of-truth, so a clamp is absorbed.
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "🔋 Energy Roundtrip (accumulator + machine buffer survive a transfer)"

$clone     = "energyrt-$(Get-Date -Format 'HHmmss')"
$prefix    = "energyrt-"
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

    # 1. Build the frozen energy fixture on a bare, paused platform; read back the source joules.
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
  local acc
  for _, nm in ipairs({'accumulator'}) do
    local okc, e = pcall(function() return s.create_entity({name=nm, position={ox, oy}, force=force}) end)
    if okc and e and e.valid then acc = e; break end
  end
  if not (acc and acc.valid) then error('could not force-create an accumulator') end
  pcall(function() acc.energy = 3000000 end)
  local mach
  for _, nm in ipairs({'assembling-machine-2', 'chemical-plant', 'assembling-machine-1'}) do
    local okc, e = pcall(function() return s.create_entity({name=nm, position={ox+5, oy}, force=force}) end)
    if okc and e and e.valid then mach = e; break end
  end
  if not (mach and mach.valid) then error('could not force-create an electric machine') end
  pcall(function() mach.energy = 300000 end)
  out.index = platform.index
  out.name = platform.name
  out.acc_name = acc.name; out.acc_energy = acc.energy; out.acc_x = acc.position.x; out.acc_y = acc.position.y
  out.mach_name = mach.name; out.mach_energy = mach.energy; out.mach_x = mach.position.x; out.mach_y = mach.position.y
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
    $srcAccEnergy  = [double]$build.acc_energy
    $srcMachEnergy = [double]$build.mach_energy
    $accName       = [string]$build.acc_name
    $machName      = [string]$build.mach_name
    Write-Status "Fixture ready: $accName energy=$srcAccEnergy ; $machName energy=$srcMachEnergy" -Type success

    # A0. Fixture grounding: both entities actually hold energy on the source.
    Add-Result "energyrt-fixture-grounded" "Source accumulator and machine both hold energy (acc=$srcAccEnergy, mach=$srcMachEnergy)" `
        (($srcAccEnergy -gt 0) -and ($srcMachEnergy -gt 0)) "acc_energy=$srcAccEnergy mach_energy=$srcMachEnergy (fixture did not store energy)"

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
    #     the physical reads below would find nothing — surface the real cause here.
    Add-Result "energyrt-gate-passed" "Transfer passed the exact gate (destination committed)" `
        ($valSuccess -eq $true) "validation_success=$valSuccess failedStage=$failedStage — dest discarded on failure; physical reads below will be empty"

    # 4. Physically read the LIVE destination entities' energy.
    $dst = Invoke-Lua -Instance $dstInstance -ReturnJson -Code @"
local out = {acc_present=false, mach_present=false}
local ok, err = pcall(function()
  local function fp(n) for _,q in pairs(game.forces['player'].platforms or {}) do if q.name==n then return q end end end
  local p = fp('$clone'); if not (p and p.valid) then out.no_platform=true; return end
  local s = p.surface
  local acc
  for _, x in ipairs(s.find_entities_filtered({name='$accName', position={$($build.acc_x), $($build.acc_y)}, radius=3})) do if x.valid then acc = x; break end end
  if acc and acc.valid then out.acc_present = true; out.acc_energy = acc.energy end
  local mach
  for _, x in ipairs(s.find_entities_filtered({name='$machName', position={$($build.mach_x), $($build.mach_y)}, radius=3})) do if x.valid then mach = x; break end end
  if mach and mach.valid then out.mach_present = true; out.mach_energy = mach.energy end
end)
if not ok then out.error = tostring(err) end
rcon.print(helpers.table_to_json(out))
"@
    $accPresent  = ($dst -and $dst.acc_present -eq $true)
    $machPresent = ($dst -and $dst.mach_present -eq $true)
    $dstAccEnergy  = if ($accPresent) { [double]$dst.acc_energy } else { 0 }
    $dstMachEnergy = if ($machPresent) { [double]$dst.mach_energy } else { 0 }
    Write-Status "Dest: accumulator present=$accPresent energy=$dstAccEnergy ; machine present=$machPresent energy=$dstMachEnergy" -Type info

    # A2. Accumulator dest-presence.
    Add-Result "energyrt-acc-present" "Accumulator present on the destination platform" `
        $accPresent "accumulator absent on destination (dst=$($dst | ConvertTo-Json -Compress))"

    # A3. Accumulator energy substantially non-default (fresh accumulator default is 0). PRIMARY signal.
    Add-Result "energyrt-acc-nondefault" "Accumulator energy restored substantially non-zero (=$dstAccEnergy)" `
        ($accPresent -and ($dstAccEnergy -gt 1000000)) "dest acc energy=$dstAccEnergy (fresh default is 0; >1 MJ proves the 'accumulators always' restore ran)"

    # A4. Accumulator energy within a tight bound of the frozen source (no discharge demand -> holds).
    $accBound = [Math]::Max(50000.0, 0.10 * $srcAccEnergy)
    $accDelta = [Math]::Abs($dstAccEnergy - $srcAccEnergy)
    Add-Result "energyrt-acc-bounded" "Accumulator energy within bound (|$dstAccEnergy - $srcAccEnergy| <= $accBound)" `
        ($accPresent -and ($accDelta -le $accBound)) "delta=$accDelta exceeds bound=$accBound (isolated accumulator has no discharge demand; bound = 10% or 50 kJ)"

    # A5. Machine dest-presence.
    Add-Result "energyrt-mach-present" "Powered machine present on the destination platform" `
        $machPresent "machine absent on destination (dst=$($dst | ConvertTo-Json -Compress))"

    # A6. Machine buffer non-default (fresh machine default is 0). PRIMARY signal for the "others when >0" branch.
    Add-Result "energyrt-mach-nondefault" "Machine energy buffer restored non-zero (=$dstMachEnergy)" `
        ($machPresent -and ($dstMachEnergy -gt 0)) "dest machine energy=$dstMachEnergy (fresh default is 0; the non-accumulator energy branch did not restore)"

    # A7. Machine buffer within a loose bound of the frozen source (a live buffer may bleed post-activation).
    $machBound = 0.50 * $srcMachEnergy
    Add-Result "energyrt-mach-bounded" "Machine energy substantially preserved (>= 50% of source: $dstMachEnergy >= $machBound)" `
        ($machPresent -and ($dstMachEnergy -ge $machBound)) "dest machine energy=$dstMachEnergy < 50% of source $srcMachEnergy (loose bound: an idle buffer may bleed after activation)"
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
        Add-Result "energyrt-cleanup-host$($pair.h)" "Host-$($pair.h): zero fixture surfaces, zero leaked locks, game unpaused" `
            (([int]$left.surfaces -eq 0) -and ([int]$left.locks -eq 0) -and ($left.paused -eq $false)) `
            "surfaces=$($left.surfaces) locks=$($left.locks) paused=$($left.paused)"
    } catch {
        Add-Result "energyrt-cleanup-host$($pair.h)" "Host-$($pair.h): zero-leftover proof" $false $_.Exception.Message
    }
}

Write-TestSummary -Passed ($script:total - $script:failed) -Failed $script:failed
if ($script:failed -gt 0) { exit 1 }
exit 0
