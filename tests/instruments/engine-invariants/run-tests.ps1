param(
    [string]$SourcePlatform = "",
    [int]$SourceHost = 0
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "integration\lib\TestBase.psm1"
Import-Module $ModulePath -Force
if (-not $SourcePlatform) { $SourcePlatform = Get-TransferFixturePlatform }

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

function New-DisposableClone {
    $name = "engineinv-$(Get-Date -Format 'HHmmssfff')"
    $c = New-TestPlatform -Instance $instance -SourcePlatform $SourcePlatform -DestPlatform $name
    if (-not $c.success) { Write-Status "Clone failed: $($c.error)" -Type error; exit 1 }
    if ($c.job_id) {
        $check = "local jobs=(storage.async_jobs or {}) local busy=jobs['$($c.job_id)'] ~= nil " +
            "if not busy then for _, j in pairs(jobs) do if j.platform_name == '$name' then busy = true end end end " +
            "rcon.print(busy and 'false' or 'true')"
        Wait-ForJob -Instances @($instance) -MaxWaitSeconds 90 -CheckScript $check | Out-Null
    }
    Start-Sleep -Seconds 1
    if (-not (Test-PlatformPresent -Name $name)) { Write-Status "Clone '$name' did not materialize" -Type error; exit 1 }
    return $name
}

$failed = 0
$passed = 0

Write-Status "Cloning disposable platform..." -Type info
$cloneName = New-DisposableClone
Write-Status "Clone ready: $cloneName" -Type success
Write-Host ""

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

    if ($bChecked -eq 0) {
        Write-TestResult -TestId "get-item-count-belt-meter" -TestName "get_item_count belt meter == physical unique-stack total" -Status "failed" -Message "No transport-belt on the clone carried any tracked item (bchecked=0) — a clone of '$SourcePlatform' must have belt items; the probe or fixture is broken ($meterRaw)"
        $failed++
    } elseif ($bMeter -ne $bPhys) {
        Write-TestResult -TestId "get-item-count-belt-meter" -TestName "get_item_count belt meter == physical unique-stack total" -Status "failed" -Message "meter=$bMeter != physical=$bPhys over $bChecked belts — get_item_count is dropping belt items or double-counting shared runs; the get_item_count completeness engine-fact is BROKEN at this Factorio version (see a measurement taken now (the engine-notes doc was deleted 2026-08-11) Item counting)"
        $failed++
    } else {
        Write-TestResult -TestId "get-item-count-belt-meter" -TestName "get_item_count belt meter == physical unique-stack total ($bChecked belts, $bMeter items)" -Status "passed"
        $passed++
    }

    if ($hBad -gt 0) {
        Write-TestResult -TestId "get-item-count-includes-held" -TestName "get_item_count includes inserter held_stack" -Status "failed" -Message "$hBad/$hChecked holding inserters report get_item_count < held count (e.g. $($Matches[0])) — held items are EXCLUDED from get_item_count; the freeze-first meter would silently miss them"
        $failed++
    } elseif ($hChecked -gt 0) {
        Write-TestResult -TestId "get-item-count-includes-held" -TestName "get_item_count includes inserter held_stack ($hChecked holding inserters)" -Status "passed"
        $passed++
    } else {
        Write-Status "get_item_count/held invariant: no inserter holding an item on the clone this snapshot — held inclusion not exercised this run (belt meter still asserted; held inclusion is verified in a measurement taken now (the engine-notes doc was deleted 2026-08-11))" -Type warning
    }
} else {
    Write-TestResult -TestId "get-item-count-belt-meter" -TestName "get_item_count meter invariant" -Status "failed" -Message "Unexpected probe output (Lua probe errored or returned an unparseable string): $meterRaw"
    $failed++
}
Write-Host ""

$proxySetupLua = @"
local p for _,x in pairs(game.forces.player.platforms) do if x.name=='$cloneName' then p=x end end
if not p then rcon.print('RESULT err=noplatform') return end
local s=p.surface local hub=p.hub
if not (hub and hub.valid) then rcon.print('RESULT err=nohub') return end
local ctl local ctl_inv
for _,e in ipairs(s.find_entities_filtered({type={'container','logistic-container'}})) do if e.valid then ctl=e ctl_inv=defines.inventory.chest break end end
if not ctl then for _,e in ipairs(s.find_entities_filtered({type={'assembling-machine','furnace'}})) do if e.valid then ctl=e ctl_inv=defines.inventory.crafter_input break end end end
if not ctl then rcon.print('RESULT err=noctl') return end
local hp=s.create_entity{name='item-request-proxy', position=hub.position, force=p.force, target=hub, modules={{id={name='iron-plate'}, items={in_inventory={{inventory=defines.inventory.hub_main, stack=0, count=10}}}}}}
local cp=s.create_entity{name='item-request-proxy', position=ctl.position, force=p.force, target=ctl, modules={{id={name='iron-plate'}, items={in_inventory={{inventory=ctl_inv, stack=0, count=10}}}}}}
local mf=0 for _,pt in pairs(hub.get_logistic_point()) do for _,sec in pairs(pt.sections or {}) do if sec.is_manual then mf=mf+sec.filters_count end end end
rcon.print('RESULT created_hub='..tostring(hp~=nil and hp.valid)..' created_ctl='..tostring(cp~=nil and cp.valid)..' ctl_unit='..tostring(ctl.unit_number)..' mf0='..mf..' iron0='..hub.get_item_count('iron-plate'))
"@
$proxySetupRaw = (Invoke-Lua -Instance $instance -Code $proxySetupLua) -join " "
if ($proxySetupRaw -match 'created_hub=true created_ctl=true ctl_unit=(\d+) mf0=(\d+) iron0=(\d+)') {
    $ctlUnit = [int]$Matches[1]; $mf0 = [int]$Matches[2]; $iron0 = [int]$Matches[3]
    Step-Tick -Instance $instance -Ticks 10 | Out-Null
    Start-Sleep -Seconds 1
    $proxyMeasureLua = @"
local p for _,x in pairs(game.forces.player.platforms) do if x.name=='$cloneName' then p=x end end
if not p then rcon.print('RESULT err=noplatform') return end
local s=p.surface local hub=p.hub
local hubp=0 local ctlp=0
for _,pr in ipairs(s.find_entities_filtered({type='item-request-proxy'})) do
  local t=pr.valid and pr.proxy_target or nil
  if t and t.name=='space-platform-hub' then hubp=hubp+1 elseif t and t.unit_number==$ctlUnit then ctlp=ctlp+1 end
end
local mf=0 for _,pt in pairs(hub.get_logistic_point()) do for _,sec in pairs(pt.sections or {}) do if sec.is_manual then mf=mf+sec.filters_count end end end
rcon.print('RESULT hubp='..hubp..' ctlp='..ctlp..' mf1='..mf..' iron1='..hub.get_item_count('iron-plate'))
"@
    $proxyMeasureRaw = (Invoke-Lua -Instance $instance -Code $proxyMeasureLua) -join " "
    if ($proxyMeasureRaw -match 'hubp=(\d+) ctlp=(\d+) mf1=(\d+) iron1=(\d+)') {
        $hubP = [int]$Matches[1]; $ctlP = [int]$Matches[2]; $mf1 = [int]$Matches[3]; $iron1 = [int]$Matches[4]
        if ($hubP -eq 0 -and $ctlP -ge 1 -and $mf1 -eq $mf0 -and $iron1 -eq $iron0) {
            Write-TestResult -TestId "hub-proxy-annihilation" -TestName "hub-targeted item-request-proxy is engine-destroyed, request NOT preserved (control proxy survives)" -Status "passed"
            $passed++
        } elseif ($hubP -gt 0) {
            Write-TestResult -TestId "hub-proxy-annihilation" -TestName "hub-targeted item-request-proxy is engine-destroyed" -Status "failed" -Message "hub-targeted proxy PERSISTED ($hubP present after 10 ticks) — the engine now keeps them, so a pending hub proxy is exportable state the sections-only model (hub-request-sections) does not carry; revisit a measurement taken now (the engine-notes doc was deleted 2026-08-11)"
            $failed++
        } elseif ($ctlP -eq 0) {
            Write-TestResult -TestId "hub-proxy-annihilation" -TestName "hub-targeted item-request-proxy is engine-destroyed (control proxy survives)" -Status "failed" -Message "the CONTROL container-targeted proxy ALSO vanished — the differential is invalid (probe broken, or proxies no longer persist at all, which breaks proxy transfer support)"
            $failed++
        } else {
            Write-TestResult -TestId "hub-proxy-annihilation" -TestName "hub-targeted proxy request is annihilated (not delivered/merged)" -Status "failed" -Message "hub state CHANGED after the proxy died: manual filters $mf0 -> $mf1, iron $iron0 -> $iron1 — the request was preserved somewhere; the sections-only serialization model needs re-measuring"
            $failed++
        }
    } else {
        Write-TestResult -TestId "hub-proxy-annihilation" -TestName "hub proxy annihilation invariant" -Status "failed" -Message "Unexpected measure-probe output: $proxyMeasureRaw"
        $failed++
    }
} else {
    Write-TestResult -TestId "hub-proxy-annihilation" -TestName "hub proxy annihilation invariant" -Status "failed" -Message "Unexpected setup-probe output (both proxies must CREATE valid on the clone): $proxySetupRaw"
    $failed++
}
Write-Host ""

$destroyLua = "local p for _,x in pairs(game.forces.player.platforms) do if x.name=='$cloneName' then p=x end end if p then pcall(function() p.destroy() end) end rcon.print('ok')"
Invoke-Lua -Instance $instance -Code $destroyLua | Out-Null
Step-Tick -Instance $instance -Ticks 10 | Out-Null
Start-Sleep -Seconds 1

if (-not (Test-PlatformPresent -Name $cloneName)) {
    Write-Status "destroy() REMOVED the platform — it is FUNCTIONAL at this Factorio version." -Type warning
    Write-Status "Revisit platform.destroy is a no-op / a measurement taken now (the engine-notes doc was deleted 2026-08-11) (they document destroy() as a no-op)." -Type warning
    Write-Status "Re-cloning so the delete_surface MUST-PASS still runs on a live platform..." -Type info
    $cloneName = New-DisposableClone
} else {
    Write-Status "destroy() left the platform intact — no-op, as documented (platform.destroy is a no-op)." -Type info
}
Write-Host ""

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

if (Test-PlatformPresent -Name $cloneName) {
    Invoke-Lua -Instance $instance -Code "for _,s in pairs(game.surfaces) do if s.platform and s.platform.name=='$cloneName' then game.delete_surface(s) end end" | Out-Null
    Step-Tick -Instance $instance -Ticks 5 | Out-Null
}

Write-TestSummary -Passed $passed -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
