<#
.SYNOPSIS
    Circuit-latch state DOCUMENTATION test — does a self-feeding decider latch's HELD SIGNAL VALUE survive
    a transfer, or does it reset? This test documents measured behavior; it does not demand restoration.

.DESCRIPTION
    Fixture (bare platform + script-built entities): a decider combinator whose OUTPUT is red-wired back to
    its own INPUT (IF signal-S > 0 THEN signal-S = 1) — the classic SR latch. A seed constant combinator
    (signal-S = 1) is red-wired in, ticks flow so the latch grabs, then the seed is DESTROYED and we verify
    on the SOURCE that the latch keeps holding with no external input (two reads, ticks apart). Only then
    do we transfer.

    What MUST hold (real assertions, physical destination reads):
      * the latch structure survives: decider present, parameters intact field-by-field, and the SELF-wire
        (output red -> own input red) reconnected via get_wire_connector(...).connections
      * the transfer gate passed and the platform arrived

    What is DOCUMENTED (assertion passes EITHER WAY, records the measured fact):
      * the latch's held signal value after transfer + activation. Circuit-NETWORK signal values are engine
        simulation state the serializer does not capture (connection-scanner captures structure + parameters
        only), so the expected measurement is `latch-resets: true`. If measured true, the report must flag
        that docs/ENGINEERING_FAQ.md needs a warning row (docs are the closer's to edit, not this test's).
        Per the integration-probe discipline: assert measured behavior, not desired architecture.

    UNVALIDATED: authored offline against lua-api.factorio.com/2.0.77 + the plugin's scanner/deserializer
    shapes; never executed against the live cluster. A closer agent runs and fixes it.

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

Write-TestHeader "Circuit-Latch State (structure must survive; held VALUE is documented, not demanded)"

$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance  = "clusterio-host-$SourceHost-instance-1"
$dstInstance  = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$name = "circuitlatch-$(Get-Date -Format 'HHmmss')-$([int](Get-Random -Minimum 100 -Maximum 999))"
Write-Host "  host-$SourceHost -> host-$DestHost   platform: $name" -ForegroundColor Gray
Write-Host ""

# Derived summary counts — never hardcoded totals.
$script:failed = 0
$script:total = 0
function Add-Result {
    param([string]$Id, [string]$TestName, [bool]$Ok, [string]$Message = "")
    $script:total++
    if ($Ok) { Write-TestResult -TestId $Id -TestName $TestName -Status "passed" }
    else { Write-TestResult -TestId $Id -TestName $TestName -Status "failed" -Message $Message; $script:failed++ }
}

function Invoke-ProbeJson {
    param([string]$Instance, [string]$Body)
    $lua = "local ok,result=pcall(function() $Body end); if not ok then rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) else rcon.print(helpers.table_to_json(result)) end"
    $raw = Invoke-Lua -Instance $Instance -Code $lua
    if (-not $raw) { throw "Empty RCON response from $Instance" }
    try { return $raw | ConvertFrom-Json } catch { throw "Invalid probe JSON from ${Instance}: $raw" }
}

# One read probe used on BOTH sides. The latch value is read from the decider's own input network
# (output is wired back to input, so a held latch shows signal-S >= 1 on its input last tick).
function Read-LatchState {
    param([string]$Instance, [double]$Ox, [double]$Oy)
    $body = @"
local p = nil
for _, q in pairs(game.forces.player.platforms) do if q.valid and q.name == '$name' then p = q break end end
if not p then return { success = false, error = 'platform missing' } end
local s = p.surface
local ox, oy = $Ox, $Oy
local out = { success = true, tick = game.tick, platform_paused = p.paused }
local es = s.find_entities_filtered({ name = 'decider-combinator', position = { ox, oy }, radius = 0.6 })
local dec = es[1]
out.have_decider = dec ~= nil
out.have_seed_constant = s.find_entities_filtered({ name = 'constant-combinator', position = { ox - 3, oy }, radius = 0.6 })[1] ~= nil
if dec then
    local dcb = dec.get_control_behavior()
    local pok, pr = pcall(function() return dcb.parameters end)
    if pok and pr then
        local c1 = pr.conditions and pr.conditions[1]
        local o1 = pr.outputs and pr.outputs[1]
        out.cond_count = pr.conditions and #pr.conditions or 0
        out.out_count = pr.outputs and #pr.outputs or 0
        if c1 then
            out.cond1_signal = c1.first_signal and c1.first_signal.name
            out.cond1_comparator = c1.comparator
            out.cond1_constant = c1.constant
        end
        if o1 then
            out.out1_signal = o1.signal and o1.signal.name
            out.out1_copy = o1.copy_count_from_input == true
        end
    end
    -- Self-wire: the input red connector must reach a connector OWNED BY THE SAME UNIT.
    local self_wired = false
    local other_owner_names = {}
    local okc, wc = pcall(function() return dec.get_wire_connector(defines.wire_connector_id.combinator_input_red, false) end)
    if okc and wc then
        for _, c in ipairs(wc.connections) do
            local o = c.target and c.target.owner
            if o and o.valid then
                if o.unit_number == dec.unit_number then self_wired = true
                else other_owner_names[#other_owner_names + 1] = o.name end
            end
        end
    end
    out.self_wired = self_wired
    table.sort(other_owner_names)
    out.other_input_owners = table.concat(other_owner_names, ',')
    local oks, sig = pcall(function() return dcb.get_signal_last_tick({ type = 'virtual', name = 'signal-S' }) end)
    if oks then out.latch_value = sig end
end
return out
"@
    return Invoke-ProbeJson -Instance $Instance -Body $body
}

try {

Assert-FactorioVersion -Instance $srcInstance | Out-Null

# 1. Build the bare-platform latch fixture.
Write-Status "Building bare platform '$name' with self-feeding latch..." -Type info
$fixtureBody = @"
local force = game.forces['player']
local p = force.create_space_platform({ name = '$name', planet = 'nauvis', starter_pack = 'space-platform-starter-pack' })
if not (p and p.valid) then return { success = false, error = 'create_space_platform failed' } end
p.apply_starter_pack()
p.paused = false
force.set_surface_hidden(p.surface, false)
local s = p.surface
local ox, oy = 100 + p.index * 50, 100
local tiles = {}
for x = -6, 6 do for y = -6, 6 do tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { ox + x, oy + y } } end end
s.set_tiles(tiles, true, false, true, false)
local function ent(spec)
    local e = s.create_entity(spec)
    if not (e and e.valid) then error('create_entity failed for ' .. spec.name) end
    return e
end
local dec = ent({ name = 'decider-combinator', position = { ox, oy }, direction = defines.direction.north, force = force })
local seed = ent({ name = 'constant-combinator', position = { ox - 3, oy }, force = force })
ent({ name = 'medium-electric-pole', position = { ox, oy + 2 }, force = force })
ent({ name = 'solar-panel', position = { ox, oy + 4 }, force = force })
-- Latch: IF signal-S > 0 THEN signal-S = 1 (copy_count_from_input = false), output fed back to input.
local dcb = dec.get_or_create_control_behavior()
dcb.parameters = {
    conditions = { { first_signal = { type = 'virtual', name = 'signal-S' }, comparator = '>', constant = 0 } },
    outputs = { { signal = { type = 'virtual', name = 'signal-S' }, copy_count_from_input = false } },
}
local wself = dec.get_wire_connector(defines.wire_connector_id.combinator_output_red, true)
    .connect_to(dec.get_wire_connector(defines.wire_connector_id.combinator_input_red, true), false)
-- Seed: constant emits signal-S = 1 into the latch input (removed after the latch grabs).
local ccb = seed.get_or_create_control_behavior()
local sec = ccb.get_section(1)
if not sec then sec = ccb.add_section() end
sec.set_slot(1, { value = { type = 'virtual', name = 'signal-S', quality = 'normal', comparator = '=' }, min = 1 })
local wseed = seed.get_wire_connector(defines.wire_connector_id.circuit_red, true)
    .connect_to(dec.get_wire_connector(defines.wire_connector_id.combinator_input_red, true), false)
return { success = true, index = p.index, ox = ox, oy = oy, wired = (wself == true) and (wseed == true) }
"@
$fx = Invoke-ProbeJson -Instance $srcInstance -Body $fixtureBody
if (-not $fx.success) { Write-Status "Fixture build failed: $($fx.error)" -Type error; exit 1 }
if (-not $fx.wired) { Write-Status "Latch/seed wires did not connect (connect_to returned false)" -Type error; exit 1 }
$ox = [double]$fx.ox; $oy = [double]$fx.oy
Write-Status "Fixture ready (platform index $($fx.index), origin $ox,$oy)" -Type success

# 2. Let the latch grab the seed, then REMOVE the seed and prove the latch holds on the SOURCE with no
#    external input (otherwise transferring it proves nothing).
Start-Sleep -Seconds 3
$pre = Read-LatchState -Instance $srcInstance -Ox $ox -Oy $oy
if (-not $pre.success) { Write-Status "Source pre-read failed: $($pre.error)" -Type error; exit 1 }
if (-not ([int]$pre.latch_value -ge 1)) {
    Write-Status "Latch never grabbed the seed on the source (signal-S=$($pre.latch_value)) — fixture bug, not a transfer bug" -Type error
    exit 1
}
Invoke-ProbeJson -Instance $srcInstance -Body @"
local p = nil
for _, q in pairs(game.forces.player.platforms) do if q.valid and q.name == '$name' then p = q break end end
if not p then return { success = false, error = 'platform missing' } end
local seed = p.surface.find_entities_filtered({ name = 'constant-combinator', position = { $ox - 3, $oy }, radius = 0.6 })[1]
if seed then seed.destroy() end
return { success = true, seed_removed = seed ~= nil }
"@ | Out-Null
Start-Sleep -Seconds 2
$srcA = Read-LatchState -Instance $srcInstance -Ox $ox -Oy $oy
Start-Sleep -Seconds 1
$srcB = Read-LatchState -Instance $srcInstance -Ox $ox -Oy $oy
Write-Host "  source latch after seed removal: read1=$($srcA.latch_value) read2=$($srcB.latch_value) (ticks $($srcA.tick)->$($srcB.tick))" -ForegroundColor DarkGray
if (-not (([int]$srcA.latch_value -ge 1) -and ([int]$srcB.latch_value -ge 1))) {
    Write-Status "Latch did not HOLD on the source after seed removal (reads $($srcA.latch_value)/$($srcB.latch_value)) — fixture bug, not a transfer bug" -Type error
    exit 1
}
$srcLatchValue = [int]$srcB.latch_value
Write-Status "Source latch holds signal-S=$srcLatchValue with no external input" -Type success

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
Add-Result "cls-gate-passed" "Transfer gate passed (validation_success=true)" ($valSuccess -eq $true) "validation_success=$valSuccess — on failure the destination is discarded and every physical read below will miss"

# 5. Read the destination after activation + settled ticks (a surviving latch needs ticks to re-assert;
#    a reset latch needs ticks to prove it stays at 0 rather than being mid-boot).
Start-Sleep -Seconds 5
$dst = Read-LatchState -Instance $dstInstance -Ox $ox -Oy $oy
if (-not $dst.success) { Write-Status "Destination read failed: $($dst.error)" -Type error; exit 1 }
Start-Sleep -Seconds 1
$dst2 = Read-LatchState -Instance $dstInstance -Ox $ox -Oy $oy
Write-Host "  dest latch: read1=$($dst.latch_value) read2=$($dst2.latch_value) self_wired=$($dst.self_wired)" -ForegroundColor DarkGray

# --- Assertions: STRUCTURE must survive (physical destination reads) ---

Add-Result "cls-decider-present" "Latch decider present on destination" ($dst.have_decider -eq $true) "decider missing at ($ox,$oy)"
Add-Result "cls-seed-stays-gone" "Seed constant (destroyed pre-export) did not resurrect on destination" `
    ($dst.have_seed_constant -ne $true) "a constant-combinator exists at the seed position — export captured a stale entity"
Add-Result "cls-self-wire" "Self-feedback wire (output red -> own input red) reconnected on destination" `
    ($dst.self_wired -eq $true) "decider input red connections do not include the decider itself (other owners: '$($dst.other_input_owners)')"
Add-Result "cls-params-signal" "Latch condition signal verbatim (src='$($srcB.cond1_signal)' dst='$($dst.cond1_signal)')" `
    (("$($srcB.cond1_signal)") -eq ("$($dst.cond1_signal)")) "src '$($srcB.cond1_signal)' vs dst '$($dst.cond1_signal)'"
Add-Result "cls-params-comparator" "Latch condition comparator verbatim (src='$($srcB.cond1_comparator)' dst='$($dst.cond1_comparator)')" `
    (("$($srcB.cond1_comparator)") -eq ("$($dst.cond1_comparator)")) "src '$($srcB.cond1_comparator)' vs dst '$($dst.cond1_comparator)'"
Add-Result "cls-params-output" "Latch output signal verbatim (src='$($srcB.out1_signal)' dst='$($dst.out1_signal)')" `
    (("$($srcB.out1_signal)") -eq ("$($dst.out1_signal)")) "src '$($srcB.out1_signal)' vs dst '$($dst.out1_signal)'"

# --- DOCUMENTATION result: the held VALUE. Passes either way; records the measured fact. ---
# Circuit-network signal values are engine simulation state; connection-scanner serializes structure and
# parameters only, so the expected measurement is latch-resets=true. This is a measured-behavior record
# (integration-probe discipline rule 7), NOT a fidelity demand — flipping this to a hard assertion is a
# separate, adjudicated design decision.
$dstLatchValue = [int]$dst2.latch_value
$latchResets = -not ($dstLatchValue -ge 1)
Add-Result "cls-latch-behavior-documented" "Latch state across transfer DOCUMENTED (latch-resets: $($latchResets.ToString().ToLower()); src=$srcLatchValue dst=$dstLatchValue)" $true
Write-Host ""
Write-Host "  LATCH-STATE-DOCUMENTED: latch-resets=$($latchResets.ToString().ToLower()) source_signal_S=$srcLatchValue dest_signal_S=$dstLatchValue" -ForegroundColor Yellow
if ($latchResets) {
    Write-Host "  NOTE: docs/ENGINEERING_FAQ.md needs a warning row — circuit-network SIGNAL STATE (latches," -ForegroundColor Yellow
    Write-Host "  counters) does NOT survive a transfer; only circuit STRUCTURE (wires, parameters) does." -ForegroundColor Yellow
    Write-Host "  Do not edit the FAQ from this test; that is the docs owner's change." -ForegroundColor Yellow
} else {
    Write-Host "  NOTE: measured latch VALUE survived the transfer — update this test's documentation if this" -ForegroundColor Yellow
    Write-Host "  reproduces (the serializer is not known to capture network state; investigate the mechanism)." -ForegroundColor Yellow
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
    Add-Result "cls-zero-leftover-$inst" "Zero leftovers on $inst" ($null -eq $left) "platform '$name' still present (index $left)"
}

Write-TestSummary -Passed ($script:total - $script:failed) -Failed $script:failed
if ($script:failed -gt 0) { exit 1 }
exit 0
