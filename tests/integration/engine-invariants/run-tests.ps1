<#
.SYNOPSIS
    Engine API invariant checks — pins the Factorio behaviors our transfer/cleanup code depends on.

.DESCRIPTION
    Two independent invariants, asserted on a disposable clone:

    1. get_item_count is a COMPLETE, non-double-counting physical meter (a standing ENGINE-FACT
       regression, not tied to any one meter — the production census reads through InventoryScanner,
       not get_item_count). The invariant: LuaEntity.get_item_count(item) summed over every entity
       must (a) INCLUDE belt-line + inserter-held items and (b) NOT
       over-count belts that share a run. We ground this against an INDEPENDENT truth — the count
       of unique physical item stacks (get_detailed_contents().unique_id, which cannot be inflated
       by a whole-line counting change) — NOT against a sibling belt API that moves in lockstep
       with get_item_count. See docs/factorio-2.0-api-notes.md "Item counting".

    2. game.delete_surface() removes a space platform, because LuaSpacePlatform.destroy() is a no-op
       at our pinned Factorio version (Pitfall #19, verified 2.0.76). destroy() is probed WARN-ONLY
       (a benign upstream fix that makes it functional must never fail the build); delete_surface is
       the MUST-PASS our code actually relies on, and is asserted UNCONDITIONALLY on a live clone.

    Every probe path fails CLOSED: an unparseable probe, a missing fixture, or a broken invariant
    turns the build RED. A guard that silently skips its own invariant is worse than no guard.

.PARAMETER SourcePlatform
    Platform to clone as the disposable subject (default: test).

.PARAMETER SourceHost
    Host holding the source platform (default: auto-detect).
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "🔬 Engine API Invariants"

if ($SourceHost -eq 0) {
    $SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
    if (-not $SourceHost) {
        Write-Status "Source platform '$SourcePlatform' not found on any host" -Type error
        exit 1
    }
}
$instance = "clusterio-host-$SourceHost-instance-1"
Write-Host "  Host: $SourceHost   Source: $SourcePlatform" -ForegroundColor Gray
Write-Host ""

function Test-PlatformPresent { param([string]$Name) return [bool](Get-PlatformIndex -Instance $instance -PlatformName $Name) }

# Clone a disposable platform; returns the clone name (or exits on failure).
function New-DisposableClone {
    $name = "engineinv-$(Get-Date -Format 'HHmmssfff')"
    $c = New-TestPlatform -Instance $instance -SourcePlatform $SourcePlatform -DestPlatform $name
    if (-not $c.success) { Write-Status "Clone failed: $($c.error)" -Type error; exit 1 }
    if ($c.job_id) {
        $check = "local j=(storage.async_jobs or {})['$($c.job_id)']; rcon.print(j == nil and 'true' or 'false')"
        Wait-ForJob -Instances @($instance) -MaxWaitSeconds 90 -CheckScript $check | Out-Null
    }
    Start-Sleep -Seconds 1
    if (-not (Test-PlatformPresent -Name $name)) { Write-Status "Clone '$name' did not materialize" -Type error; exit 1 }
    return $name
}

$failed = 0
$passed = 0

# 1. Clone the disposable subject.
Write-Status "Cloning disposable platform..." -Type info
$cloneName = New-DisposableClone
Write-Status "Clone ready: $cloneName" -Type success
Write-Host ""

# 2. INVARIANT: get_item_count is a COMPLETE, non-double-counting physical meter.
#    (a) Belts: meter = Σ get_item_count over transport-belts must EQUAL the independent physical
#        total = Σ stack.count over unique get_detailed_contents().unique_id stacks. If get_item_count
#        ever drops belt items, meter < phys (RED); if it ever counts a shared run whole-line per belt
#        (double-count), meter > phys (RED). The unique_id total is the independent ground — it cannot
#        be inflated by a counting-semantics change, so this is NOT a sibling-API tautology.
#    (b) Held: every inserter currently holding item X must report get_item_count(X) >= held count
#        (the freeze-first meter relies on held items being included). Held items are transient (depend
#        on inserter swing-phase at the snapshot), so "none holding this run" WARNS rather than fails;
#        belt items are statically present on a clone of the source, so bchecked==0 is a real breakage.
$meterLua = @"
local items={'railgun-ammo','iron-plate','copper-plate','steel-plate','piercing-rounds-magazine','sulfur','iron-gear-wheel','copper-cable','electronic-circuit'}
local iset={} for _,n in ipairs(items) do iset[n]=true end
local p for _,x in pairs(game.forces.player.platforms) do if x.name=='$cloneName' then p=x end end
if not p then rcon.print('RESULT err=noplatform') return end
local s=p.surface
local bmeter=0 local bphys=0 local seen={} local bchecked=0
for _,e in ipairs(s.find_entities_filtered({type='transport-belt'})) do
  local has=false
  for _,n in ipairs(items) do local c=e.get_item_count(n) if c>0 then bmeter=bmeter+c has=true end end
  if has then bchecked=bchecked+1 end
  for li=1,e.get_max_transport_line_index() do
    local l=e.get_transport_line(li)
    if l then for _,d in ipairs(l.get_detailed_contents()) do
      local st=d.stack
      if st and st.valid_for_read and iset[st.name] and d.unique_id and not seen[d.unique_id] then seen[d.unique_id]=true bphys=bphys+st.count end
    end end
  end
end
local hchecked=0 local hbad=0 local hex=''
for _,e in ipairs(s.find_entities_filtered({type='inserter'})) do
  if e.valid then local hs=e.held_stack
    if hs and hs.valid_for_read and hs.count>0 then
      hchecked=hchecked+1
      if e.get_item_count(hs.name) < hs.count then hbad=hbad+1 if hex=='' then hex=e.name..'/'..hs.name end end
    end
  end
end
rcon.print('RESULT bchecked='..bchecked..' bmeter='..bmeter..' bphys='..bphys..' hchecked='..hchecked..' hbad='..hbad..' hex='..hex)
"@
$meterRaw = (Invoke-Lua -Instance $instance -Code $meterLua) -join " "
if ($meterRaw -match 'bchecked=(\d+) bmeter=(\d+) bphys=(\d+) hchecked=(\d+) hbad=(\d+)') {
    $bChecked = [int]$Matches[1]; $bMeter = [int]$Matches[2]; $bPhys = [int]$Matches[3]
    $hChecked = [int]$Matches[4]; $hBad = [int]$Matches[5]

    # (a) Belt meter completeness + no double-count.
    if ($bChecked -eq 0) {
        Write-TestResult -TestId "get-item-count-belt-meter" -TestName "get_item_count belt meter == physical unique-stack total" -Status "failed" -Message "No transport-belt on the clone carried any tracked item (bchecked=0) — a clone of '$SourcePlatform' must have belt items; the probe or fixture is broken ($meterRaw)"
        $failed++
    } elseif ($bMeter -ne $bPhys) {
        Write-TestResult -TestId "get-item-count-belt-meter" -TestName "get_item_count belt meter == physical unique-stack total" -Status "failed" -Message "meter=$bMeter != physical=$bPhys over $bChecked belts — get_item_count is dropping belt items or double-counting shared runs; the get_item_count completeness engine-fact is BROKEN at this Factorio version (see docs/factorio-2.0-api-notes.md Item counting)"
        $failed++
    } else {
        Write-TestResult -TestId "get-item-count-belt-meter" -TestName "get_item_count belt meter == physical unique-stack total ($bChecked belts, $bMeter items)" -Status "passed"
        $passed++
    }

    # (b) Held-item inclusion.
    if ($hBad -gt 0) {
        Write-TestResult -TestId "get-item-count-includes-held" -TestName "get_item_count includes inserter held_stack" -Status "failed" -Message "$hBad/$hChecked holding inserters report get_item_count < held count (e.g. $($Matches[0])) — held items are EXCLUDED from get_item_count; the freeze-first meter would silently miss them"
        $failed++
    } elseif ($hChecked -gt 0) {
        Write-TestResult -TestId "get-item-count-includes-held" -TestName "get_item_count includes inserter held_stack ($hChecked holding inserters)" -Status "passed"
        $passed++
    } else {
        Write-Status "get_item_count/held invariant: no inserter holding an item on the clone this snapshot — held inclusion not exercised this run (belt meter still asserted; held inclusion is verified in docs/factorio-2.0-api-notes.md)" -Type warning
    }
} else {
    # Fail CLOSED: an unparseable probe (e.g. a Lua API change that breaks the probe itself) must go
    # RED, never degrade to a green warning — that is the exact engine-drift this guard exists to catch.
    Write-TestResult -TestId "get-item-count-belt-meter" -TestName "get_item_count meter invariant" -Status "failed" -Message "Unexpected probe output (Lua probe errored or returned an unparseable string): $meterRaw"
    $failed++
}
Write-Host ""

# 3. WARN-ONLY probe: LuaSpacePlatform.destroy(). This must NEVER fail the build if it changes — an
#    upstream fix that makes destroy() functional is a benign improvement, not a regression. It is NOT
#    credited as a pass either: destroy() is not the removal path our code uses, so its behavior is
#    purely informational. If destroy() DOES consume the clone, we re-clone so the delete_surface
#    MUST-PASS below always runs on a live subject.
$destroyLua = "local p for _,x in pairs(game.forces.player.platforms) do if x.name=='$cloneName' then p=x end end if p then pcall(function() p.destroy() end) end rcon.print('ok')"
Invoke-Lua -Instance $instance -Code $destroyLua | Out-Null
Step-Tick -Instance $instance -Ticks 10 | Out-Null
Start-Sleep -Seconds 1

if (-not (Test-PlatformPresent -Name $cloneName)) {
    Write-Status "destroy() REMOVED the platform — it is FUNCTIONAL at this Factorio version." -Type warning
    Write-Status "Revisit Pitfall #19 / docs/factorio-2.0-api-notes.md (they document destroy() as a no-op)." -Type warning
    Write-Status "Re-cloning so the delete_surface MUST-PASS still runs on a live platform..." -Type info
    $cloneName = New-DisposableClone
} else {
    Write-Status "destroy() left the platform intact — no-op, as documented (Pitfall #19)." -Type info
}
Write-Host ""

# 4. MUST PASS: game.delete_surface() removes the platform — the removal path our transfer/cleanup
#    code actually depends on. Asserted UNCONDITIONALLY on the (possibly re-cloned) live subject.
$delLua = "local p for _,x in pairs(game.forces.player.platforms) do if x.name=='$cloneName' then p=x end end if p and p.surface and p.surface.valid then game.delete_surface(p.surface) rcon.print('ok') else rcon.print('no_surface') end"
Invoke-Lua -Instance $instance -Code $delLua | Out-Null
Step-Tick -Instance $instance -Ticks 10 | Out-Null
Start-Sleep -Seconds 1

if (Test-PlatformPresent -Name $cloneName) {
    Write-TestResult -TestId "delete-surface-removes-platform" -TestName "game.delete_surface() removes a space platform" -Status "failed" -Message "Platform still present after delete_surface + ticks — the platform-removal path our transfer/cleanup relies on is BROKEN at this Factorio version"
    $failed++
} else {
    Write-TestResult -TestId "delete-surface-removes-platform" -TestName "game.delete_surface() removes a space platform" -Status "passed"
    $passed++
}

# 5. Defensive cleanup of any survivor.
if (Test-PlatformPresent -Name $cloneName) {
    Invoke-Lua -Instance $instance -Code "for _,s in pairs(game.surfaces) do if s.platform and s.platform.name=='$cloneName' then game.delete_surface(s) end end" | Out-Null
    Step-Tick -Instance $instance -Ticks 5 | Out-Null
}

Write-TestSummary -Passed $passed -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
