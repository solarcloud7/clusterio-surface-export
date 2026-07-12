<#
.SYNOPSIS
    Circuit-config round-trip — a decider combinator's non-default parameters must arrive VERBATIM, both
    circuit wires (red + green) must be physically reconnected via the 2.0 wire-connector API, and the
    lamp's circuit condition must actually EVALUATE on the destination after activation.

.DESCRIPTION
    Tests EXISTING serializer functionality that never had a test: connection-scanner.lua
    (extract_circuit_connections / extract_control_behavior) and deserializer.lua
    (restore_control_behavior / restore_circuit_connections).

    Fixture (bare platform + script-built entities — never the 1,359-entity clone):
      constant-combinator (emits signal-A=5)
        --red wire--> decider-combinator input   (parameters: IF signal-A > 3 THEN output signal-B = 1)
        decider output --red wire--> small-lamp  (circuit condition: signal-B > 0  -> enabled)
                                     second lamp (circuit condition: signal-B > 10 -> stays DISABLED;
                                                  the negative control proving evaluation is not vacuous)
      steel-chest A --green wire--> steel-chest B  (the "green wire between two other entities")
      medium-electric-pole + solar-panel            (combinators need power to compute)

    Every assertion reads the property PHYSICALLY on the destination via RCON:
      * decider control_behavior.parameters field-by-field verbatim (condition signal/comparator/constant,
        output signal, copy_count_from_input) — source readback vs destination readback
      * wires via get_wire_connector(id).connections owner names (never the validator's report)
      * post-activation: lamp1 cb.disabled == false AND lamp2 cb.disabled == true (the condition EVALUATES)

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

Write-TestHeader "Circuit-Config Round-Trip (decider params verbatim; red+green wires reconnect; condition evaluates)"

$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance  = "clusterio-host-$SourceHost-instance-1"
$dstInstance  = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$name = "circuitcfg-$(Get-Date -Format 'HHmmss')-$([int](Get-Random -Minimum 100 -Maximum 999))"
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

function Compare-Field {
    param([string]$Id, [string]$Label, $Src, $Dst)
    Add-Result $Id "$Label verbatim (src='$Src' dst='$Dst')" (("$Src") -eq ("$Dst")) "source '$Src' vs destination '$Dst'"
}

function Invoke-ProbeJson {
    param([string]$Instance, [string]$Body)
    $lua = "local ok,result=pcall(function() $Body end); if not ok then rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) else rcon.print(helpers.table_to_json(result)) end"
    $raw = Invoke-Lua -Instance $Instance -Code $lua
    if (-not $raw) { throw "Empty RCON response from $Instance" }
    try { return $raw | ConvertFrom-Json } catch { throw "Invalid probe JSON from ${Instance}: $raw" }
}

# One read probe used on BOTH sides so source truth and destination truth come from the same instrument.
function Read-CircuitState {
    param([string]$Instance, [double]$Ox, [double]$Oy)
    $body = @"
local p = nil
for _, q in pairs(game.forces.player.platforms) do if q.valid and q.name == '$name' then p = q break end end
if not p then return { success = false, error = 'platform missing' } end
local s = p.surface
local ox, oy = $Ox, $Oy
-- Script-created 1x1 entities center at x+0.5,y+0.5; radius 0.8 reaches that 0.707 offset
-- while excluding the adjacent lamp whose center is 1.58 tiles from the requested coordinate.
local function at(nm, x, y)
    local es = s.find_entities_filtered({ name = nm, position = { x, y }, radius = 0.8 })
    return es[1]
end
local out = { success = true, tick = game.tick, platform_paused = p.paused }
local dec = at('decider-combinator', ox, oy)
local con = at('constant-combinator', ox - 3, oy)
local lamp = at('small-lamp', ox + 3, oy)
local lamp2 = at('small-lamp', ox + 4, oy)
local ca = at('steel-chest', ox - 3, oy + 3)
local cb2 = at('steel-chest', ox + 3, oy + 3)
out.have_decider = dec ~= nil
out.have_constant = con ~= nil
out.have_lamp = lamp ~= nil
out.have_lamp2 = lamp2 ~= nil
out.have_chest_a = ca ~= nil
out.have_chest_b = cb2 ~= nil
local function owners(entity, cid)
    local names = {}
    local okc, wc = pcall(function() return entity.get_wire_connector(cid, false) end)
    if okc and wc then
        for _, c in ipairs(wc.connections) do
            local o = c.target and c.target.owner
            if o and o.valid then names[#names + 1] = o.name end
        end
    end
    table.sort(names)
    return table.concat(names, ',')
end
if con then
    local ccb = con.get_control_behavior()
    local sec = ccb and ccb.get_section(1)
    local slot = sec and sec.get_slot(1)
    out.constant_slot_signal = slot and slot.value and slot.value.name
    out.constant_slot_min = slot and slot.min
end
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
        out.params_json = helpers.table_to_json(pr)
    end
    out.decider_in_red = owners(dec, defines.wire_connector_id.combinator_input_red)
    out.decider_out_red = owners(dec, defines.wire_connector_id.combinator_output_red)
    local oks, sig = pcall(function() return dcb.get_signal_last_tick({ type = 'virtual', name = 'signal-A' }) end)
    if oks then out.decider_in_signal_a = sig end
end
if lamp then
    local lcb = lamp.get_control_behavior()
    out.lamp_cb_present = lcb ~= nil
    out.lamp_status = lamp.status
    out.lamp_circuit_enable_disable = lcb and lcb.circuit_enable_disable
    if lcb then
        local okd, dis = pcall(function() return lamp.disabled_by_control_behavior end)
        out.lamp_disabled_read_ok = okd
        if okd then out.lamp_disabled = dis else out.lamp_disabled_error = tostring(dis) end
        local okc, cond = pcall(function() return lcb.circuit_condition end)
        if okc and cond then
            out.lamp_cond_signal = cond.first_signal and cond.first_signal.name
            out.lamp_cond_comparator = cond.comparator
            out.lamp_cond_constant = cond.constant
        end
    end
    out.lamp_red = owners(lamp, defines.wire_connector_id.circuit_red)
    local oks, v = pcall(function() return lamp.get_signal({ type = 'virtual', name = 'signal-B' }, defines.wire_connector_id.circuit_red) end)
    if oks then out.lamp_signal_b = v end
end
if lamp2 then
    local lcb2 = lamp2.get_control_behavior()
    out.lamp2_cb_present = lcb2 ~= nil
    out.lamp2_status = lamp2.status
    out.lamp2_circuit_enable_disable = lcb2 and lcb2.circuit_enable_disable
    if lcb2 then
        local okd, dis = pcall(function() return lamp2.disabled_by_control_behavior end)
        out.lamp2_disabled_read_ok = okd
        if okd then out.lamp2_disabled = dis else out.lamp2_disabled_error = tostring(dis) end
    end
end
if ca then out.chest_a_green = owners(ca, defines.wire_connector_id.circuit_green) end
return out
"@
    return Invoke-ProbeJson -Instance $Instance -Body $body
}

try {

Assert-FactorioVersion -Instance $srcInstance | Out-Null

# 1. Build the bare-platform fixture (cheapest fixture that proves the invariant — no 1,359-entity clone).
Write-Status "Building bare platform '$name' with circuit fixture..." -Type info
$fixtureBody = @"
local force = game.forces['player']
local p = force.create_space_platform({ name = '$name', planet = 'nauvis', starter_pack = 'space-platform-starter-pack' })
if not (p and p.valid) then return { success = false, error = 'create_space_platform failed' } end
p.apply_starter_pack()
  p.schedule = { current = 1, records = { { station = 'nauvis' } } }
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
local con = ent({ name = 'constant-combinator', position = { ox - 3, oy }, force = force })
local dec = ent({ name = 'decider-combinator', position = { ox, oy }, direction = defines.direction.north, force = force })
local lamp = ent({ name = 'small-lamp', position = { ox + 3, oy }, force = force })
local lamp2 = ent({ name = 'small-lamp', position = { ox + 4, oy }, force = force })
local ca = ent({ name = 'steel-chest', position = { ox - 3, oy + 3 }, force = force })
local cb2 = ent({ name = 'steel-chest', position = { ox + 3, oy + 3 }, force = force })
ent({ name = 'medium-electric-pole', position = { ox, oy + 2 }, force = force })
ent({ name = 'solar-panel', position = { ox, oy + 4 }, force = force })
-- Constant combinator: emit signal-A = 5 (2.0 sections API).
local ccb = con.get_or_create_control_behavior()
local sec = ccb.get_section(1)
if not sec then sec = ccb.add_section() end
sec.set_slot(1, { value = { type = 'virtual', name = 'signal-A', quality = 'normal', comparator = '=' }, min = 5 })
-- Decider: non-default parameters — IF signal-A > 3 THEN signal-B = 1 (copy_count_from_input = false).
local dcb = dec.get_or_create_control_behavior()
dcb.parameters = {
    conditions = { { first_signal = { type = 'virtual', name = 'signal-A' }, comparator = '>', constant = 3 } },
    outputs = { { signal = { type = 'virtual', name = 'signal-B' }, copy_count_from_input = false } },
}
-- Lamp circuit conditions: lamp1 enabled at signal-B > 0; lamp2 (negative control) needs signal-B > 10.
local lcb = lamp.get_or_create_control_behavior()
pcall(function() lcb.circuit_enable_disable = true end)  -- intentional probe: not all 2.0 lamp CBs expose it
lcb.circuit_condition = { first_signal = { type = 'virtual', name = 'signal-B' }, comparator = '>', constant = 0 }
local lcb2 = lamp2.get_or_create_control_behavior()
pcall(function() lcb2.circuit_enable_disable = true end)  -- intentional probe: same as above
lcb2.circuit_condition = { first_signal = { type = 'virtual', name = 'signal-B' }, comparator = '>', constant = 10 }
-- Wires (2.0 wire-connector API). Red: constant -> decider input; decider output -> lamp1 -> lamp2.
local w1 = con.get_wire_connector(defines.wire_connector_id.circuit_red, true)
    .connect_to(dec.get_wire_connector(defines.wire_connector_id.combinator_input_red, true), false)
local w2 = dec.get_wire_connector(defines.wire_connector_id.combinator_output_red, true)
    .connect_to(lamp.get_wire_connector(defines.wire_connector_id.circuit_red, true), false)
local w3 = lamp.get_wire_connector(defines.wire_connector_id.circuit_red, true)
    .connect_to(lamp2.get_wire_connector(defines.wire_connector_id.circuit_red, true), false)
-- Green: between two OTHER entities (the chests).
local w4 = ca.get_wire_connector(defines.wire_connector_id.circuit_green, true)
    .connect_to(cb2.get_wire_connector(defines.wire_connector_id.circuit_green, true), false)
return { success = true, index = p.index, ox = ox, oy = oy,
    wired = (w1 == true) and (w2 == true) and (w3 == true) and (w4 == true) }
"@
$fx = Invoke-ProbeJson -Instance $srcInstance -Body $fixtureBody
if (-not $fx.success) { Write-Status "Fixture build failed: $($fx.error)" -Type error; exit 1 }
if (-not $fx.wired) { Write-Status "Fixture wires did not all connect (connect_to returned false)" -Type error; exit 1 }
$ox = [double]$fx.ox; $oy = [double]$fx.oy
Write-Status "Fixture ready (platform index $($fx.index), origin $ox,$oy)" -Type success

# 2. Precondition: the circuit must WORK on the source before we blame the transfer. Let ticks flow so the
#    combinator computes, then require lamp1 enabled + lamp2 disabled (the fixture provably evaluates).
Start-Sleep -Seconds 3
$src = Read-CircuitState -Instance $srcInstance -Ox $ox -Oy $oy
if (-not $src.success) { Write-Status "Source read failed: $($src.error)" -Type error; exit 1 }
Write-Host "  source: params=[$($src.cond1_signal) $($src.cond1_comparator) $($src.cond1_constant) -> $($src.out1_signal)] lamp_disabled=$($src.lamp_disabled) lamp2_disabled=$($src.lamp2_disabled) signal-A(in)=$($src.decider_in_signal_a) cb1=$($src.lamp_cb_present)/read=$($src.lamp_disabled_read_ok)/err=$($src.lamp_disabled_error) cb2=$($src.lamp2_cb_present)/read=$($src.lamp2_disabled_read_ok)/err=$($src.lamp2_disabled_error) slot=: wires-in=[] wires-out=[] lamp-status=/enabled= lamp2-status=/enabled=" -ForegroundColor DarkGray
if ($src.lamp_disabled -ne $false -or $src.lamp2_disabled -ne $true) {
    Write-Status "Source fixture does not evaluate as designed (lamp_disabled=$($src.lamp_disabled), lamp2_disabled=$($src.lamp2_disabled)) — fixture bug, not a transfer bug" -Type error
    exit 1
}
Write-Status "Source circuit evaluates correctly (lamp1 on, lamp2 off)" -Type success

# 3. Transfer to the destination.
$idx = Get-PlatformIndex -Instance $srcInstance -PlatformName $name
if (-not $idx) { Write-Status "Platform index not found for '$name'" -Type error; exit 1 }
$destId = Get-ClusterioInstanceId -InstanceName $dstInstance
docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${name}_*.json 2>/dev/null" 2>$null | Out-Null
Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
Write-Status "Transfer initiated..." -Type info

# 4. Wait for the destination import-result (written regardless of pass/fail when debug_mode is on).
$start = Get-Date; $resultFile = $null
while (-not $resultFile -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Seconds 2
    $files = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${name}_*.json")
    if ($files.Count -gt 0) { $resultFile = $files[0] }
}
if (-not $resultFile) { Write-Status "No import-result after ${TimeoutSec}s (transfer may have stalled)" -Type error; exit 1 }
$resultData = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $resultFile
$valSuccess = Get-SafeProperty $resultData "validation_success"
Add-Result "ccr-gate-passed" "Transfer gate passed (validation_success=true)" ($valSuccess -eq $true) "validation_success=$valSuccess — on failure the destination is discarded and every physical read below will miss"

# 5. Let the destination settle (activation happens after the verdict; then ticks must flow for the
#    combinator to compute on the destination network) and read PHYSICAL destination state.
Start-Sleep -Seconds 5
$dst = Read-CircuitState -Instance $dstInstance -Ox $ox -Oy $oy
if (-not $dst.success) { Write-Status "Destination read failed: $($dst.error)" -Type error; exit 1 }
Write-Host "  dest:   params=[$($dst.cond1_signal) $($dst.cond1_comparator) $($dst.cond1_constant) -> $($dst.out1_signal)] lamp_disabled=$($dst.lamp_disabled) lamp2_disabled=$($dst.lamp2_disabled) in_red=[$($dst.decider_in_red)] out_red=[$($dst.decider_out_red)]" -ForegroundColor DarkGray

# --- Assertions (all physical destination reads) ---

Add-Result "ccr-entities-present" "All six circuit fixture entities present on destination" `
    (($dst.have_decider -eq $true) -and ($dst.have_constant -eq $true) -and ($dst.have_lamp -eq $true) -and ($dst.have_lamp2 -eq $true) -and ($dst.have_chest_a -eq $true) -and ($dst.have_chest_b -eq $true)) `
    "decider=$($dst.have_decider) constant=$($dst.have_constant) lamp=$($dst.have_lamp) lamp2=$($dst.have_lamp2) chestA=$($dst.have_chest_a) chestB=$($dst.have_chest_b)"

# Decider control_behavior.parameters — field-by-field verbatim against the SOURCE readback.
Compare-Field "ccr-param-cond-count" "Decider condition count" $src.cond_count $dst.cond_count
Compare-Field "ccr-param-cond-signal" "Decider condition first_signal" $src.cond1_signal $dst.cond1_signal
Compare-Field "ccr-param-cond-comparator" "Decider condition comparator" $src.cond1_comparator $dst.cond1_comparator
Compare-Field "ccr-param-cond-constant" "Decider condition constant" $src.cond1_constant $dst.cond1_constant
Compare-Field "ccr-param-out-count" "Decider output count" $src.out_count $dst.out_count
Compare-Field "ccr-param-out-signal" "Decider output signal" $src.out1_signal $dst.out1_signal
Compare-Field "ccr-param-out-copy" "Decider output copy_count_from_input" $src.out1_copy $dst.out1_copy
# Full-JSON comparison is informational only (serialization key order across instances is not guaranteed).
if (("$($src.params_json)") -ne ("$($dst.params_json)")) {
    Write-Status "INFO: full parameters JSON differs textually (field checks above are authoritative):" -Type warning
    Write-Host "    src: $($src.params_json)" -ForegroundColor DarkGray
    Write-Host "    dst: $($dst.params_json)" -ForegroundColor DarkGray
}

# Wires reconnected — read via get_wire_connector(...).connections on the DESTINATION.
Add-Result "ccr-wire-red-in" "Red wire constant->decider input reconnected (dest connections: [$($dst.decider_in_red)])" `
    (("$($dst.decider_in_red)") -match "constant-combinator") "decider input red connections: '$($dst.decider_in_red)'"
Add-Result "ccr-wire-red-out" "Red wire decider output->lamp reconnected (dest connections: [$($dst.decider_out_red)])" `
    (("$($dst.decider_out_red)") -match "small-lamp") "decider output red connections: '$($dst.decider_out_red)'"
Add-Result "ccr-wire-green" "Green wire chestA<->chestB reconnected (dest connections: [$($dst.chest_a_green)])" `
    (("$($dst.chest_a_green)") -match "steel-chest") "chest A green connections: '$($dst.chest_a_green)'"

# Lamp circuit condition restored verbatim.
Compare-Field "ccr-lamp-cond-signal" "Lamp circuit_condition first_signal" $src.lamp_cond_signal $dst.lamp_cond_signal
Compare-Field "ccr-lamp-cond-comparator" "Lamp circuit_condition comparator" $src.lamp_cond_comparator $dst.lamp_cond_comparator
Compare-Field "ccr-lamp-cond-constant" "Lamp circuit_condition constant" $src.lamp_cond_constant $dst.lamp_cond_constant

# Post-activation EVALUATION: the condition actually evaluates on the destination network.
# lamp1 (signal-B > 0) must be ENABLED; lamp2 (signal-B > 10) must stay DISABLED (negative control —
# proves the enabled state comes from real evaluation, not a default).
Add-Result "ccr-eval-lamp-on" "Lamp circuit condition evaluates TRUE post-activation (cb.disabled=false)" `
    ($dst.lamp_disabled -eq $false) "dest lamp cb.disabled=$($dst.lamp_disabled) (expected false; signal-B on lamp network: $($dst.lamp_signal_b))"
Add-Result "ccr-eval-lamp2-off" "Negative-control lamp stays disabled post-activation (cb.disabled=true)" `
    ($dst.lamp2_disabled -eq $true) "dest lamp2 cb.disabled=$($dst.lamp2_disabled) (expected true — if false, 'evaluation' was vacuous)"

} finally {
    # Guaranteed cleanup: best-effort unlock (a failed transfer can leave the source locked), then delete the
    # fixture platform on BOTH hosts (game.delete_surface is deferred to end of tick — step ticks after).
    foreach ($inst in @($srcInstance, $dstInstance)) {
        Invoke-Lua -Instance $inst -Code "pcall(function() remote.call('surface_export','unlock_platform','$name') end) rcon.print('ok')" | Out-Null
        Remove-PlatformSurfacesWhere -Instance $inst -PredicateLua "p.name == '$name'" | Out-Null
        Step-Tick -Instance $inst -Ticks 5 | Out-Null
    }
}

# Zero-leftover proof: the fixture platform must be GONE from both hosts.
foreach ($inst in @($srcInstance, $dstInstance)) {
    $left = Get-PlatformIndex -Instance $inst -PlatformName $name
    Add-Result "ccr-zero-leftover-$inst" "Zero leftovers on $inst" ($null -eq $left) "platform '$name' still present (index $left)"
}

Write-TestSummary -Passed ($script:total - $script:failed) -Failed $script:failed
if ($script:failed -gt 0) { exit 1 }
exit 0
