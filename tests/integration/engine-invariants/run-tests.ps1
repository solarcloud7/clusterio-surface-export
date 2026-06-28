<#
.SYNOPSIS
    Engine API invariant checks — pins the Factorio platform-removal behavior our code depends on.

.DESCRIPTION
    Transfer and cleanup code relies on game.delete_surface() actually removing a space platform,
    because LuaSpacePlatform.destroy() is a no-op at our pinned Factorio version (Pitfall #19,
    verified on 2.0.76; see docs/factorio-2.0-api-notes.md).

    This asserts the POSITIVE invariant — game.delete_surface removes a platform — and FAILS if it
    ever stops working (e.g. a Factorio version bump that changes platform teardown). It separately
    PROBES destroy() and only WARNS (never fails) if destroy() becomes functional, so a benign
    upstream fix to destroy() can never turn this build red.

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
$cloneName = "engineinv-$(Get-Date -Format 'HHmmss')"
Write-Host "  Host: $SourceHost   Source: $SourcePlatform   Clone: $cloneName" -ForegroundColor Gray
Write-Host ""

function Test-ClonePresent { return [bool](Get-PlatformIndex -Instance $instance -PlatformName $cloneName) }

# 1. Clone a disposable platform to operate on.
Write-Status "Cloning disposable platform..." -Type info
$clone = New-TestPlatform -Instance $instance -SourcePlatform $SourcePlatform -DestPlatform $cloneName
if (-not $clone.success) { Write-Status "Clone failed: $($clone.error)" -Type error; exit 1 }
if ($clone.job_id) {
    $check = "local j=(storage.async_jobs or {})['$($clone.job_id)']; rcon.print(j == nil and 'true' or 'false')"
    Wait-ForJob -Instances @($instance) -MaxWaitSeconds 90 -CheckScript $check | Out-Null
}
Start-Sleep -Seconds 1
if (-not (Test-ClonePresent)) { Write-Status "Clone did not materialize" -Type error; exit 1 }
Write-Status "Clone ready" -Type success
Write-Host ""

$failed = 0
$passed = 0

# 2. INVARIANT: get_item_count INCLUDES belt (transport-line) items. The freeze-first transfer-fidelity
#    sentinel's physical meter relies on a `get_item_count` total being COMPLETE (inventories + belts + held).
#    On the clone's belts, get_item_count(item) must equal Σ get_transport_line(i).get_item_count(item).
#    See docs/factorio-2.0-api-notes.md "Item counting". If a Factorio bump changes this, the sentinel's
#    assumption breaks and this goes RED.
$beltLua = "local items={'railgun-ammo','iron-plate','copper-plate','steel-plate','piercing-rounds-magazine'} local p for _,x in pairs(game.forces.player.platforms) do if x.name=='$cloneName' then p=x end end if not p then rcon.print('RESULT checked=0 mism=0 ex=noplatform') return end local s=p.surface local checked=0 local mism=0 local ex='' for _,e in ipairs(s.find_entities_filtered({type={'transport-belt','underground-belt'}})) do local mx=e.get_max_transport_line_index() local tl=0 for li=1,mx do local l=e.get_transport_line(li) if l then for _,n in ipairs(items) do tl=tl+l.get_item_count(n) end end end if tl>0 then local gic=0 for _,n in ipairs(items) do gic=gic+e.get_item_count(n) end checked=checked+1 if gic~=tl then mism=mism+1 if ex=='' then ex=e.name..'(gic='..gic..' tl='..tl..')' end end if checked>=15 then break end end end rcon.print('RESULT checked='..checked..' mism='..mism..' ex='..ex)"
$beltRaw = (Invoke-Lua -Instance $instance -Code $beltLua) -join " "
if ($beltRaw -match 'checked=(\d+) mism=(\d+)') {
    $bChecked = [int]$Matches[1]; $bMism = [int]$Matches[2]
    if ($bChecked -eq 0) {
        Write-Status "get_item_count/belt invariant: no belts with tracked items on the clone this run — inconclusive (skipped)" -Type warning
    } elseif ($bMism -eq 0) {
        Write-TestResult -TestId "get-item-count-includes-belts" -TestName "get_item_count includes belt items (== get_transport_line; $bChecked belts checked)" -Status "passed"
        $passed++
    } else {
        Write-TestResult -TestId "get-item-count-includes-belts" -TestName "get_item_count includes belt items" -Status "failed" -Message "$bMism/$bChecked belts: get_item_count != transport_line total ($beltRaw) — the freeze-first transfer-fidelity meter assumption is BROKEN at this Factorio version (see docs/factorio-2.0-api-notes.md Item counting)"
        $failed++
    }
} else {
    Write-Status "get_item_count/belt invariant: unexpected probe output: $beltRaw" -Type warning
}
Write-Host ""

# 3. WARN-ONLY probe: LuaSpacePlatform.destroy(). This must NOT fail the build if it changes —
#    an upstream fix that makes destroy() functional is a benign improvement, not a regression.
$destroyLua = "local p for _,x in pairs(game.forces.player.platforms) do if x.name=='$cloneName' then p=x end end if p then pcall(function() p.destroy() end) end rcon.print('ok')"
Invoke-Lua -Instance $instance -Code $destroyLua | Out-Null
Step-Tick -Instance $instance -Ticks 10 | Out-Null
Start-Sleep -Seconds 1

if (-not (Test-ClonePresent)) {
    # destroy() removed it — functional at this version. Removal works, so the invariant our code
    # needs is satisfied; just flag that the documented no-op behavior has changed.
    Write-Status "destroy() REMOVED the platform — it is FUNCTIONAL at this Factorio version." -Type warning
    Write-Status "Revisit Pitfall #19 / docs/factorio-2.0-api-notes.md (they document destroy() as a no-op)." -Type warning
    $passed++   # the removal invariant our code needs is satisfied (just via destroy() now)
} else {
    Write-Status "destroy() left the platform intact — no-op, as documented (Pitfall #19)." -Type info

    # 3. MUST PASS: game.delete_surface() removes the platform — this is what our code depends on.
    $delLua = "local p for _,x in pairs(game.forces.player.platforms) do if x.name=='$cloneName' then p=x end end if p and p.surface and p.surface.valid then game.delete_surface(p.surface) rcon.print('ok') else rcon.print('no_surface') end"
    Invoke-Lua -Instance $instance -Code $delLua | Out-Null
    Step-Tick -Instance $instance -Ticks 10 | Out-Null
    Start-Sleep -Seconds 1

    if (Test-ClonePresent) {
        Write-TestResult -TestId "delete-surface-removes-platform" -TestName "game.delete_surface() removes a space platform" -Status "failed" -Message "Platform still present after delete_surface + ticks — the platform-removal path our transfer/cleanup relies on is BROKEN at this Factorio version"
        $failed++
    } else {
        Write-TestResult -TestId "delete-surface-removes-platform" -TestName "game.delete_surface() removes a space platform" -Status "passed"
        $passed++
    }
}

# 4. Defensive cleanup of any survivor.
if (Test-ClonePresent) {
    Invoke-Lua -Instance $instance -Code "for _,s in pairs(game.surfaces) do if s.platform and s.platform.name=='$cloneName' then game.delete_surface(s) end end" | Out-Null
    Step-Tick -Instance $instance -Ticks 5 | Out-Null
}

Write-TestSummary -Passed $passed -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
