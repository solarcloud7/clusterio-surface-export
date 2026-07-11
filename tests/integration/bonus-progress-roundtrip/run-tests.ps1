<#
.SYNOPSIS
    bonus_progress roundtrip — a crafter's accumulated productivity progress (bonus_progress) must
    survive the export/import pipeline. Physical reads on the live entity, frozen (pre-activation)
    census via the registered test_defer_clone_activation flag.

.DESCRIPTION
    The export side already captures bonus_progress (export_scanners/entity-handlers.lua, assembling-
    machine handler); this test codes AGAINST THE LANDING of the restore side — the implementer agent
    is adding `{ field = "bonus_progress", safecall = true }` to SIMPLE_RESTORE_RULES in
    core/deserializer.lua. Until that row lands, the bp-restored assertion is EXPECTED RED (the value
    is exported but never written back); after it lands this test pins the behavior permanently.

    Fixture: one assembling-machine-2 (2 module slots) with 2 productivity modules and recipe
    iron-gear-wheel, kept INACTIVE the whole time (no power needed, no crafting confound), with
    bonus_progress set to ~0.5 via script and READ BACK (write-assert — if the source write itself
    doesn't take, the test cannot discriminate and fails loudly as an instrument error).

    AUTHORED 2026-07-11, NEVER EXECUTED (no cluster access at authoring time) — the closer validates
    against the live cluster after the deserializer row lands.

.PARAMETER InstanceId
    Instance to run on (default 1; the whole test is same-instance).

.PARAMETER CloneTimeoutSec
    Max seconds to wait for the clone import job (default 150).
#>
param(
    [int]$InstanceId = 1,
    [int]$CloneTimeoutSec = 150
)

# The value scripted onto the source machine. ~0.5 per the T1C brief; the ASSERTION target is the
# source READ-BACK value, never this constant (derive from measurement, don't assume the write took).
$TARGET_BONUS = 0.5

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "🧪 bonus_progress Roundtrip (productivity progress survives export/import)"

$instance = "clusterio-host-$InstanceId-instance-1"
Assert-FactorioVersion -Instance $instance | Out-Null

$stamp = Get-Date -Format 'HHmmss'
$fixture = "bonus-rt-src-$stamp"
$clone = "bonus-rt-dst-$stamp"
Write-Host "  instance: $instance   fixture: $fixture   clone: $clone" -ForegroundColor Gray
Write-Host ""

# Derived counts — totals come from recorded results, never hardcoded.
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

# PHYSICAL machine reading (AM2) on a platform found by per-run unique name. Module count is a
# physical entity get_item_count, not any validator report.
function Read-Machine([string]$name) {
    $lua = "local p for _,x in pairs(game.forces.player.platforms) do if x.valid and x.name=='$name' then p=x break end end local m = p and p.surface.find_entities_filtered({name='assembling-machine-2'})[1] or nil if m and m.valid then rcon.print(helpers.table_to_json({success=true,tick=game.tick,active=m.active,platform_paused=p.paused,bonus_progress=m.bonus_progress,modules=m.get_item_count('productivity-module'),recipe=(m.get_recipe and m.get_recipe()) and m.get_recipe().name or 'nil'})) else rcon.print(helpers.table_to_json({success=false,error='platform or machine missing: $name'})) end"
    return Invoke-Lua -Instance $instance -Code $lua -ReturnJson
}

# Capture prior config BEFORE arming anything, so the finally restores it on every exit path.
$prior = Invoke-Lua -Instance $instance -Code "local c=storage.surface_export_config or {} rcon.print(helpers.table_to_json({debug_mode=c.debug_mode==true,had_debug=c.debug_mode~=nil}))" -ReturnJson

try {
    # 1. Fixture: platform + INACTIVE AM2 + recipe + 2 productivity modules + scripted bonus_progress,
    #    all write-asserted (recipe read back, module insert count checked, bonus_progress read back).
    Write-Status "Building bonus_progress fixture '$fixture'..." -Type info
    $fixtureLua = "local force=game.forces.player local p=force.create_space_platform({name='$fixture',planet='nauvis',starter_pack='space-platform-starter-pack'}) p.apply_starter_pack() p.paused=false force.set_surface_hidden(p.surface,false) local ox,oy=100+p.index*50,100 local tiles={} for x=-8,8 do for y=-8,8 do tiles[#tiles+1]={name='space-platform-foundation',position={ox+x,oy+y}} end end p.surface.set_tiles(tiles,true,false,true,false) local m=p.surface.create_entity({name='assembling-machine-2',position={ox,oy},force=force}) m.active=false pcall(function() m.set_recipe('iron-gear-wheel') end) local got=(m.get_recipe and m.get_recipe()) and m.get_recipe().name or 'nil' local modinv=m.get_module_inventory() local mods=(modinv and modinv.insert({name='productivity-module',count=2})) or 0 local wok=pcall(function() m.bonus_progress=$TARGET_BONUS end) rcon.print(helpers.table_to_json({success=(got=='iron-gear-wheel' and mods==2),recipe=got,modules=mods,write_ok=wok,bonus_progress=m.bonus_progress,index=p.index,tick=game.tick}))"
    $setup = Invoke-Lua -Instance $instance -Code $fixtureLua -ReturnJson
    if (-not $setup -or -not $setup.success) {
        Write-Status "Fixture failed (recipe/module write-assert): $($setup | ConvertTo-Json -Compress)" -Type error
        exit 1
    }
    # Write-assert on the source: if bonus_progress itself didn't take, the fixture cannot discriminate.
    if ([math]::Abs($setup.bonus_progress - $TARGET_BONUS) -gt 0.001) {
        Write-Status "Instrument failure: bonus_progress write did not take on the SOURCE (wanted $TARGET_BONUS, read back $($setup.bonus_progress)) — investigate whether bonus_progress requires an in-flight craft before asserting anything about restore" -Type error
        exit 1
    }
    $srcBonus = $setup.bonus_progress
    Write-Status "Source: bonus_progress=$srcBonus, modules=$($setup.modules), recipe=$($setup.recipe)" -Type info

    # 2. Arm the (registered, non-destructive) defer flag so the clone stays DEACTIVATED — an active
    #    machine could craft and MOVE bonus_progress before we read it — then clone.
    Invoke-Lua -Instance $instance -Code "remote.call('surface_export','configure',{debug_mode=true,test_defer_clone_activation=true}) rcon.print('armed')" | Out-Null
    $cl = Invoke-Lua -Instance $instance -Code "local r=remote.call('surface_export','clone_platform',$($setup.index),'$clone') rcon.print(helpers.table_to_json(r))" -ReturnJson
    if (-not $cl -or -not $cl.success) { Write-Status "Clone failed: $($cl | ConvertTo-Json -Compress)" -Type error; exit 1 }
    Write-Status "Clone queued (job $($cl.job_id)) — waiting for the import to complete..." -Type info
    $jobDone = Wait-ForJob -Instances @($instance) -MaxWaitSeconds $CloneTimeoutSec -CheckScript "local j=storage.async_jobs or {} local id='$($cl.job_id)' rcon.print((j[id]==nil and j[tonumber(id) or -1]==nil) and 'true' or 'false')"
    if (-not $jobDone) { Write-Status "Clone import job did not complete within ${CloneTimeoutSec}s" -Type error; exit 1 }
    Start-Sleep -Seconds 1

    # 3. Frozen destination census.
    $dst = Read-Machine $clone
    if (-not $dst -or -not $dst.success) { Write-Status "Dest read failed: $($dst | ConvertTo-Json -Compress)" -Type error; exit 1 }
    if ($dst.active -ne $false) {
        Write-Status "Instrument failure: test_defer_clone_activation did not hold — dest machine is ACTIVE, bonus_progress reading may be contaminated by crafting" -Type error
        exit 1
    }
    Write-Status "Dest frozen (tick $($dst.tick)): bonus_progress=$($dst.bonus_progress), modules=$($dst.modules), recipe=$($dst.recipe)" -Type info

    # --- Assertions ---
    # A) THE assertion: bonus_progress survived to the destination. EXPECTED RED until the implementer's
    #    SIMPLE_RESTORE_RULES row `{ field = "bonus_progress", safecall = true }` lands in
    #    core/deserializer.lua (the export side already captures it).
    Add-Check "bp-restored" "dest bonus_progress matches source ($srcBonus -> $($dst.bonus_progress))" `
        ([math]::Abs($dst.bonus_progress - $srcBonus) -le 0.001) `
        "dest bonus_progress=$($dst.bonus_progress), source=$srcBonus — the SIMPLE_RESTORE_RULES bonus_progress restore row is missing or its write did not take on a fresh deactivated machine"

    # B) The productivity modules physically arrived (context that makes bonus_progress meaningful).
    Add-Check "bp-modules" "dest machine physically holds 2 productivity modules (got $($dst.modules))" `
        ($dst.modules -eq 2) `
        "dest module count=$($dst.modules), expected 2 — module inventory did not round-trip"

    # C) The recipe context survived (bonus_progress is per-recipe crafting state).
    Add-Check "bp-recipe" "dest recipe is iron-gear-wheel (got $($dst.recipe))" `
        ($dst.recipe -eq 'iron-gear-wheel') `
        "dest recipe=$($dst.recipe), expected iron-gear-wheel"

    Write-TestSummary -Passed $script:passed -Failed $script:failed
    if ($script:failed -gt 0) { exit 1 }
    exit 0
}
finally {
    # Disarm the defer flag + restore prior debug_mode, remove BOTH platforms, prove zero leftovers —
    # on EVERY exit path (PowerShell runs finally even on exit).
    try {
        Invoke-Lua -Instance $instance -Code "remote.call('surface_export','configure',{test_defer_clone_activation=false}) rcon.print('disarmed')" | Out-Null
        if ($prior -and $prior.had_debug -and -not $prior.debug_mode) {
            Invoke-Lua -Instance $instance -Code "remote.call('surface_export','configure',{debug_mode=false}) rcon.print('debug restored')" | Out-Null
        }
    } catch { Write-Status "Cleanup: config restore failed: $_" -Type warning }
    try {
        Remove-PlatformSurfacesWhere -Instance $instance -PredicateLua "string.find(p.name, 'bonus-rt-', 1, true) == 1" | Out-Null
        Start-Sleep -Seconds 1
        $left = Invoke-Lua -Instance $instance -Code "local n=0 for _,x in pairs(game.forces.player.platforms) do if x.valid and string.find(x.name,'bonus-rt-',1,true)==1 then n=n+1 end end rcon.print(n)"
        if ([int]$left -gt 0) {
            Write-Status "ZERO-LEFTOVER FAILED: $left bonus-rt-* platform(s) remain" -Type error
            exit 1
        }
        Write-Status "Cleanup verified: zero bonus-rt-* leftovers, defer flag disarmed" -Type success
    } catch { Write-Status "Cleanup: surface removal/verify failed: $_" -Type warning; exit 1 }
}
