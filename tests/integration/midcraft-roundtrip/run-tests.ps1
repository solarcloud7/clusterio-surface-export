<#
.SYNOPSIS
    Mid-craft roundtrip — a machine frozen MID-CRAFT must survive the export/import pipeline without
    losing (RESET-LOSS) or duplicating (PHANTOM-GAIN) the value embodied in its crafting_progress.
    Grounded in PHYSICAL item counts (entity get_item_count), never a validator self-report.

.DESCRIPTION
    Physics under test (see tests/midcraft-lab/NOTEBOOK.md): Factorio consumes ingredients at craft
    START, so a mid-craft machine holds value in NO inventory — only in crafting_progress. The
    serializer exports crafting_progress (export_scanners/entity-handlers.lua) and the deserializer
    restores it via SIMPLE_RESTORE_RULES (core/deserializer.lua).

    Fixture: one assembling-machine-1 (recipe iron-gear-wheel, 2 plates -> 1 gear), script-fed exactly
    4 iron plates, frozen mid-craft via the machine.active shutter (2 plates consumed by the in-flight
    craft, 2 physical in input). Same-instance clone_platform runs the full pipeline; the registered
    non-destructive test_defer_clone_activation flag holds the clone DEACTIVATED for a pristine frozen
    census, then this test activates it and physically counts the settled end state.

    AUTHORED 2026-07-11, NEVER EXECUTED (no cluster access at authoring time) — the closer validates it
    against the live cluster alongside the MC1 lab rung.

.PARAMETER InstanceId
    Instance to run on (default 1; the whole test is same-instance).

.PARAMETER CloneTimeoutSec
    Max seconds to wait for the clone import job (default 150).
#>
param(
    [int]$InstanceId = 1,
    [int]$CloneTimeoutSec = 150
)

# ============================================================================================
# EXPECTED_BEHAVIOR — parameterized on the MC1 lab rung's measured outcome.
#
#   'resume' (authored default): asserts RESUME-CLEAN — the crafting_progress write TAKES on the
#            frozen destination, and on activation the in-flight craft completes EXACTLY ONCE
#            (outputs +1, inputs consumed once; embodied value conserved).
#
#   'refund': THE CLOSER FLIPS THIS if MC1 measured RESET-LOSS or PHANTOM-GAIN and the adjudicated
#            refund-not-resume fix landed — asserts the destination frozen state instead has
#            progress 0, inputs restored +2 (the consumed ingredients refunded), outputs unchanged.
#
# Both modes share the same post-activation conservation assertion (derived from the dest frozen
# reading), so a refund destination must still turn its refunded plates into gears.
# ============================================================================================
$EXPECTED_BEHAVIOR = 'resume'

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "🧪 Mid-Craft Roundtrip (crafting_progress embodied value, mode: $EXPECTED_BEHAVIOR)"

if ($EXPECTED_BEHAVIOR -notin @('resume', 'refund')) {
    Write-Status "EXPECTED_BEHAVIOR must be 'resume' or 'refund' (got '$EXPECTED_BEHAVIOR')" -Type error
    exit 1
}

$instance = "clusterio-host-$InstanceId-instance-1"
Assert-FactorioVersion -Instance $instance | Out-Null

$stamp = Get-Date -Format 'HHmmss'
$fixture = "midcraft-rt-src-$stamp"
$clone = "midcraft-rt-dst-$stamp"
Write-Host "  instance: $instance   fixture: $fixture   clone: $clone" -ForegroundColor Gray
Write-Host ""

# Derived counts — every assertion routes through here; totals are never hardcoded.
$script:passed = 0
$script:failed = 0
function Add-Check([string]$Id, [string]$Name, [bool]$Ok, [string]$Message = "") {
    if ($Ok) {
        Write-TestResult -TestId $Id -TestName $Name -Status "passed"
        $script:passed++
    } else {
        Write-TestResult -TestId $Id -TestName $Name -Status "failed" -Message $Message
        $script:failed++
    }
}

# PHYSICAL machine reading on a platform found by (per-run unique) name. Plates/gears via
# entity get_item_count — the independent physical count, not any validator report.
function Read-Machine([string]$name) {
    $lua = "local p for _,x in pairs(game.forces.player.platforms) do if x.valid and x.name=='$name' then p=x break end end local m = p and p.surface.find_entities_filtered({name='assembling-machine-1'})[1] or nil if m and m.valid then rcon.print(helpers.table_to_json({success=true,tick=game.tick,active=m.active,platform_paused=p.paused,no_power=(m.status==defines.entity_status.no_power),low_power=(m.status==defines.entity_status.low_power),progress=m.crafting_progress,input=m.get_item_count('iron-plate'),output=m.get_item_count('iron-gear-wheel')})) else rcon.print(helpers.table_to_json({success=false,error='platform or machine missing: $name'})) end"
    return Invoke-Lua -Instance $instance -Code $lua -ReturnJson
}

# Capture prior config BEFORE arming anything, so the finally can restore it on every exit path.
$prior = Invoke-Lua -Instance $instance -Code "local c=storage.surface_export_config or {} rcon.print(helpers.table_to_json({debug_mode=c.debug_mode==true,had_debug=c.debug_mode~=nil}))" -ReturnJson

try {
    # 1. Fixture: platform + inactive AM1 (recipe write-asserted) + EEI power + exactly 4 plates.
    Write-Status "Building mid-craft fixture '$fixture'..." -Type info
    $fixtureLua = "local force=game.forces.player local p=force.create_space_platform({name='$fixture',planet='nauvis',starter_pack='space-platform-starter-pack'}) p.apply_starter_pack()
  p.schedule = { current = 1, records = { { station = 'nauvis' } } } p.paused=false force.set_surface_hidden(p.surface,false) local ox,oy=100+p.index*50,100 local tiles={} for x=-8,8 do for y=-8,8 do tiles[#tiles+1]={name='space-platform-foundation',position={ox+x,oy+y}} end end p.surface.set_tiles(tiles,true,false,true,false) local m=p.surface.create_entity({name='assembling-machine-1',position={ox,oy},force=force}) m.active=false pcall(function() m.set_recipe('iron-gear-wheel') end) local got=(m.get_recipe and m.get_recipe()) and m.get_recipe().name or 'nil' local eei=p.surface.create_entity({name='electric-energy-interface',position={ox+5,oy},force=force}) pcall(function() eei.energy=eei.electric_buffer_size end) p.surface.create_entity({name='medium-electric-pole',position={ox+3,oy},force=force}) local ins=m.insert({name='iron-plate',count=4}) rcon.print(helpers.table_to_json({success=(got=='iron-gear-wheel' and ins==4),recipe=got,inserted=ins,index=p.index,tick=game.tick}))"
    $setup = Invoke-Lua -Instance $instance -Code $fixtureLua -ReturnJson
    if (-not $setup -or -not $setup.success) {
        Write-Status "Fixture failed (recipe/insert write-assert): $($setup | ConvertTo-Json -Compress)" -Type error
        exit 1
    }

    # 2. Drive to mid-craft with the machine.active shutter (activate -> ~220ms of real ticks ->
    #    deactivate+read in ONE Lua execution). Read the ACHIEVED progress — never assume 0.5.
    Write-Status "Driving to a mid-craft freeze (shutter slices)..." -Type info
    $findM = "local p for _,x in pairs(game.forces.player.platforms) do if x.valid and x.name=='$fixture' then p=x break end end local m=p.surface.find_entities_filtered({name='assembling-machine-1'})[1]"
    $srcFrozen = $null
    for ($slice = 1; $slice -le 24 -and -not $srcFrozen; $slice++) {
        Invoke-Lua -Instance $instance -Code "$findM m.active=true rcon.print('on')" | Out-Null
        Start-Sleep -Milliseconds 220
        $r = Invoke-Lua -Instance $instance -Code "$findM m.active=false rcon.print(helpers.table_to_json({success=true,tick=game.tick,active=m.active,no_power=(m.status==defines.entity_status.no_power),low_power=(m.status==defines.entity_status.low_power),progress=m.crafting_progress,input=m.get_item_count('iron-plate'),output=m.get_item_count('iron-gear-wheel')}))" -ReturnJson
        if (-not $r -or -not $r.success) { Write-Status "Shutter read failed on slice $slice" -Type error; exit 1 }
        if ($r.no_power -or $r.low_power) { Write-Status "Instrument failure: machine unpowered during drive (slice $slice)" -Type error; exit 1 }
        if ($r.progress -gt 0.05 -and $r.progress -lt 0.95) { $srcFrozen = $r }
        elseif ($r.input -eq 0 -and $r.output -ge 2 -and -not ($r.progress -gt 0)) {
            Write-Status "Instrument failure: fixture exhausted before a mid-craft freeze landed (slice $slice)" -Type error
            exit 1
        }
    }
    if (-not $srcFrozen) { Write-Status "Instrument failure: no mid-craft freeze in 24 shutter slices" -Type error; exit 1 }
    Write-Status "Source frozen (tick $($srcFrozen.tick)): progress=$($srcFrozen.progress) input=$($srcFrozen.input) output=$($srcFrozen.output)" -Type info

    # 3. Arm the (registered, non-destructive) defer flag so the clone stays DEACTIVATED, then clone.
    Invoke-Lua -Instance $instance -Code "remote.call('surface_export','configure',{debug_mode=true,test_defer_clone_activation=true}) rcon.print('armed')" | Out-Null
    $cl = Invoke-Lua -Instance $instance -Code "local r=remote.call('surface_export','clone_platform',$($setup.index),'$clone') rcon.print(helpers.table_to_json(r))" -ReturnJson
    if (-not $cl -or -not $cl.success) { Write-Status "Clone failed: $($cl | ConvertTo-Json -Compress)" -Type error; exit 1 }
    Write-Status "Clone queued (job $($cl.job_id)) — waiting for the import to complete..." -Type info
    $jobDone = Wait-ForJob -Instances @($instance) -MaxWaitSeconds $CloneTimeoutSec -CheckScript "local j=storage.async_jobs or {} local id='$($cl.job_id)' rcon.print((j[id]==nil and j[tonumber(id) or -1]==nil) and 'true' or 'false')"
    if (-not $jobDone) { Write-Status "Clone import job did not complete within ${CloneTimeoutSec}s" -Type error; exit 1 }
    Start-Sleep -Seconds 1

    # 4. FROZEN destination census (machine must still be deactivated or the census is contaminated).
    $dstFrozen = Read-Machine $clone
    if (-not $dstFrozen -or -not $dstFrozen.success) { Write-Status "Dest frozen read failed: $($dstFrozen | ConvertTo-Json -Compress)" -Type error; exit 1 }
    if ($dstFrozen.active -ne $false) {
        Write-Status "Instrument failure: test_defer_clone_activation did not hold — dest machine is ACTIVE, frozen census contaminated" -Type error
        exit 1
    }
    Write-Status "Dest frozen (tick $($dstFrozen.tick)): progress=$($dstFrozen.progress) input=$($dstFrozen.input) output=$($dstFrozen.output)" -Type info

    # --- Frozen-stage assertions (mode-specific) ---
    if ($EXPECTED_BEHAVIOR -eq 'resume') {
        Add-Check "mc-frozen-progress" "crafting_progress write TOOK on the frozen dest (src=$($srcFrozen.progress) dst=$($dstFrozen.progress))" `
            (([math]::Abs($dstFrozen.progress - $srcFrozen.progress) -lt 0.02) -and ($dstFrozen.progress -gt 0.05)) `
            "dest frozen progress=$($dstFrozen.progress) vs source $($srcFrozen.progress) — the SIMPLE_RESTORE_RULES crafting_progress write did not survive on a fresh deactivated machine (RESET-LOSS signature; see tests/midcraft-lab/NOTEBOOK.md)"
        Add-Check "mc-frozen-inputs" "dest frozen input plates match source ($($srcFrozen.input))" `
            ($dstFrozen.input -eq $srcFrozen.input) `
            "dest input=$($dstFrozen.input), source=$($srcFrozen.input) — physical input inventory did not round-trip"
        Add-Check "mc-frozen-outputs" "dest frozen output gears match source ($($srcFrozen.output))" `
            ($dstFrozen.output -eq $srcFrozen.output) `
            "dest output=$($dstFrozen.output), source=$($srcFrozen.output) — output inventory did not round-trip"
    } else {
        # 'refund' mode: the adjudicated fix refunds the consumed ingredients instead of resuming.
        Add-Check "mc-frozen-progress-zero" "dest frozen crafting_progress is 0 (refund, not resume)" `
            ($dstFrozen.progress -lt 0.001) `
            "dest frozen progress=$($dstFrozen.progress) — expected 0 under refund-not-resume"
        Add-Check "mc-frozen-inputs-refunded" "dest frozen input plates = source + 2 (consumed ingredients refunded)" `
            ($dstFrozen.input -eq ($srcFrozen.input + 2)) `
            "dest input=$($dstFrozen.input), expected $($srcFrozen.input + 2) — the in-flight craft's consumed ingredients were not refunded"
        Add-Check "mc-frozen-outputs" "dest frozen output gears unchanged ($($srcFrozen.output))" `
            ($dstFrozen.output -eq $srcFrozen.output) `
            "dest output=$($dstFrozen.output), source=$($srcFrozen.output) — outputs must be unchanged under refund"
    }

    # 5. Activate the clone and let it settle (>=120 ticks + two identical consecutive physical reads).
    $act = Invoke-Lua -Instance $instance -Code "local p for _,x in pairs(game.forces.player.platforms) do if x.valid and x.name=='$clone' then p=x break end end for _,e in pairs(p.surface.find_entities_filtered({})) do pcall(function() e.active=true end) end local eei=p.surface.find_entities_filtered({name='electric-energy-interface'})[1] if eei then pcall(function() eei.energy=eei.electric_buffer_size end) end p.paused=false rcon.print(helpers.table_to_json({success=true,tick=game.tick}))" -ReturnJson
    if (-not $act -or -not $act.success) { Write-Status "Clone activation failed" -Type error; exit 1 }
    $deadline = (Get-Date).AddSeconds(60)
    $prev = $null
    $final = $null
    while (-not $final -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 1
        $r = Read-Machine $clone
        if (-not $r -or -not $r.success) { Write-Status "Settle read failed" -Type error; exit 1 }
        if ($prev -and (($r.tick - $act.tick) -ge 120) -and ($prev.input -eq $r.input) -and ($prev.output -eq $r.output) -and ([math]::Abs($prev.progress - $r.progress) -lt 0.001)) {
            $final = $r
        }
        $prev = $r
    }
    if (-not $final) { Write-Status "Destination never settled within 60s after activation" -Type error; exit 1 }
    if ($final.no_power -or $final.low_power) { Write-Status "Instrument failure: dest machine unpowered post-activation" -Type error; exit 1 }
    Write-Status "Dest settled (tick $($final.tick), +$($final.tick - $act.tick) ticks): progress=$($final.progress) input=$($final.input) output=$($final.output)" -Type info

    # --- Post-activation conservation (both modes; expectations DERIVED from the dest frozen reading:
    #     every frozen plate becomes gears, plus one gear for a frozen in-flight craft). ---
    $inFlight = 0
    if ($dstFrozen.progress -gt 0.001 -and $dstFrozen.progress -lt 0.999) { $inFlight = 1 }
    $expGears = $dstFrozen.output + $inFlight + [math]::Floor($dstFrozen.input / 2)
    $expPlates = $dstFrozen.input % 2
    Add-Check "mc-final-gears" "settled dest gears = $expGears (physical; in-flight craft completed exactly $inFlight time(s), inputs consumed once)" `
        ($final.output -eq $expGears) `
        "settled gears=$($final.output), expected $expGears (frozen: output=$($dstFrozen.output) input=$($dstFrozen.input) in_flight=$inFlight) — embodied value was lost or duplicated across activation"
    Add-Check "mc-final-plates" "settled dest plates = $expPlates (physical; no unconsumed or phantom inputs)" `
        ($final.input -eq $expPlates) `
        "settled plates=$($final.input), expected $expPlates — inputs were not consumed exactly once"

    Write-TestSummary -Passed $script:passed -Failed $script:failed
    if ($script:failed -gt 0) { exit 1 }
    exit 0
}
finally {
    # Disarm the defer flag + restore prior debug_mode, remove BOTH platforms, and prove zero leftovers —
    # on EVERY exit path (PowerShell runs finally even on exit).
    try {
        Invoke-Lua -Instance $instance -Code "remote.call('surface_export','configure',{test_defer_clone_activation=false}) rcon.print('disarmed')" | Out-Null
        if ($prior -and $prior.had_debug -and -not $prior.debug_mode) {
            Invoke-Lua -Instance $instance -Code "remote.call('surface_export','configure',{debug_mode=false}) rcon.print('debug restored')" | Out-Null
        }
    } catch { Write-Status "Cleanup: config restore failed: $_" -Type warning }
    try {
        Remove-PlatformSurfacesWhere -Instance $instance -PredicateLua "string.find(p.name, 'midcraft-rt-', 1, true) == 1" | Out-Null
        Start-Sleep -Seconds 1
        $left = Invoke-Lua -Instance $instance -Code "local n=0 for _,x in pairs(game.forces.player.platforms) do if x.valid and string.find(x.name,'midcraft-rt-',1,true)==1 then n=n+1 end end rcon.print(n)"
        if ([int]$left -gt 0) {
            Write-Status "ZERO-LEFTOVER FAILED: $left midcraft-rt-* platform(s) remain" -Type error
            exit 1
        }
        Write-Status "Cleanup verified: zero midcraft-rt-* leftovers, defer flag disarmed" -Type success
    } catch { Write-Status "Cleanup: surface removal/verify failed: $_" -Type warning; exit 1 }
}
