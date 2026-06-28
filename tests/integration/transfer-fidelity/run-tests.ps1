<#
.SYNOPSIS
    Validator-counting drift sentinel — proves the validator's item accounting matches PHYSICAL reality,
    using two INDEPENDENT counting methods that must agree. Grounded in physical counts (get_item_count),
    never the validator's own loss report.

.DESCRIPTION
    The lesson this guards (see the data-integrity-test-grounding memory): a fidelity claim must be measured
    independently of the code under test. Here we cross-check the validator's exported item count
    (`expectedItemCounts`, produced by `count_all_items` over the serialized data) against an INDEPENDENT
    physical count of the same source (`get_item_count` over the live surface). These are two unrelated
    counting methods; they must agree (Phase-0 `src_phys == val_exp`). A divergence means the validator's
    counting has DRIFTED from physical reality — e.g. the serializer/count silently dropping an inventory
    type — which is exactly the meter-bug class that would otherwise pass unnoticed.

    NOTE on scope: this does NOT compare source-vs-destination physical totals. The `test` platform is a live
    crafting system, so its total item count is not conserved across the transfer window (machines consume
    inputs / produce outputs) — an aggregate src-vs-dst total is inherently noisy and is the wrong invariant.
    Robust physical preservation of a SPECIFIC item is covered by `ground-item-fidelity` (a distinctive,
    non-crafted item placed and verified exactly). This sentinel covers the complementary axis: meter drift.

.PARAMETER Items
    Representative high-count item types to count (default: a combat/asteroid-platform mix present on `test`).
.PARAMETER TolPct
    Tolerance as a fraction of the source total (default 0.005). The source is FROZEN before the physical
    snapshot (step 2), so there is NO craft-window: both meters count the same frozen state, and get_item_count
    already includes belt-line items (verified directly: get_item_count == get_transport_line per belt). The
    only residual is belt items shifting POSITION between the snapshot and the export's atomic belt scan, which
    conserves the COUNT (inserters frozen → nothing enters or leaves the belts). So the meters should agree to
    within a tiny floor; a real serializer MISCOUNT (a dropped/double-counted category) is orders of magnitude
    larger. (Earlier this carried a 1%→2% tolerance band-aid for what turned out to be benign craft-window;
    freezing fixes the clock instead of the number, so the tolerance is tight again.)
.PARAMETER TolAbs
    Minimum absolute tolerance (default 20).
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [string[]]$Items = @("railgun-ammo", "iron-plate", "copper-plate", "steel-plate", "piercing-rounds-magazine"),
    [double]$TolPct = 0.005,
    [int]$TolAbs = 20,
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

Write-TestHeader "🛰️ Validator-Counting Drift Sentinel (physical source == validator expected)"

if ($SourceHost -eq 0) {
    $SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
    if (-not $SourceHost) { Write-Status "Source platform '$SourcePlatform' not found on any host" -Type error; exit 1 }
}
$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance = "clusterio-host-$SourceHost-instance-1"
$dstInstance = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$srcSel = "${SourceHost}1"
$clone = "fidsentinel-$(Get-Date -Format 'HHmmss')"
$itemsLua = "'" + ($Items -join "','") + "'"
Write-Host "  host-$SourceHost -> host-$DestHost   clone: $clone" -ForegroundColor Gray
Write-Host "  items: $($Items -join ', ')" -ForegroundColor Gray
Write-Host ""

$failed = 0
$TOTAL_ASSERTIONS = 1

# Comprehensive PHYSICAL count of the tracked items: get_item_count over all non-item-entity entities
# (already includes belt-line items) + loose ground items. NO separate belt scan (would double-count).
# This is the independent source of truth — never the validator's report.
function Count-Set([string]$sel, [string]$name) {
    $lua = "/sc local function fp(n) for _,q in pairs(game.forces['player'].platforms or {}) do if q.name==n then return q end end end local p=fp('$name') if not p then rcon.print('TOTAL=-1') return end local items={$itemsLua} local want={} for _,n in ipairs(items) do want[n]=true end local s=p.surface local t=0 for _,e in ipairs(s.find_entities_filtered({type='item-entity'})) do if e.valid and e.stack and e.stack.valid_for_read and want[e.stack.name] then t=t+e.stack.count end end for _,e in ipairs(s.find_entities_filtered({})) do if e.valid and e.type~='item-entity' then for _,n in ipairs(items) do local ok,c=pcall(function() return e.get_item_count(n) end) if ok and c then t=t+c end end end end rcon.print('TOTAL='..t)"
    $raw = (& "$repoRoot\tools\rcon.ps1" $sel $lua) -join " "
    if ($raw -match 'TOTAL=(-?\d+)') { return [int]$Matches[1] } else { return -999 }
}

# 1. Clone.
$cl = New-TestPlatform -Instance $srcInstance -SourcePlatform $SourcePlatform -DestPlatform $clone
if (-not $cl.success) { Write-Status "Clone failed: $($cl.error)" -Type error; exit 1 }
if ($cl.job_id) {
    Wait-ForJob -Instances @($srcInstance) -MaxWaitSeconds 90 -CheckScript "local j=(storage.async_jobs or {})['$($cl.job_id)']; rcon.print(j == nil and 'true' or 'false')" | Out-Null
}
Start-Sleep -Seconds 1
$idx = Get-PlatformIndex -Instance $srcInstance -PlatformName $clone
if (-not $idx) { Write-Status "Clone did not materialize" -Type error; exit 1 }
Write-Status "Clone ready (index $idx)" -Type success

# 2. FREEZE the source's crafting before measuring — the gold-standard "fix the clock". We set active=false
#    directly on the producing/consuming entities (assemblers, furnaces, etc.) + inserters, stopping
#    PRODUCTION of the tracked items so their TOTAL is conserved — item movement along belts/inserters only
#    changes location, not count. This is deliberately NOT lock_platform_for_transfer: that "locked-for-
#    transfer" state stalls the subsequent transfer's export. The transfer still does its own lock and captures
#    frozen_states normally; these entities simply arrive inactive on the (immediately-deleted) dest clone.
Invoke-Lua -Instance $srcInstance -Code "local function fp(n) for _,q in pairs(game.forces['player'].platforms or {}) do if q.name==n then return q end end end local p=fp('$clone') if not p then rcon.print('no clone') return end local n=0 for _,e in ipairs(p.surface.find_entities_filtered({type={'assembling-machine','furnace','inserter','lab','chemical-plant','oil-refinery','rocket-silo','mining-drill','boiler','generator','reactor','burner-generator','agricultural-tower'}})) do if e.valid and e.active then e.active=false n=n+1 end end rcon.print('froze '..n..' producing entities')" | Out-Null
Start-Sleep -Seconds 1   # let any in-flight crafts settle

# 3. Physical source count on the FROZEN platform (the independent truth; no craft-window now).
$srcTotal = Count-Set $srcSel $clone
if ($srcTotal -lt 1) { Write-Status "Source physical total invalid ($srcTotal) — fixture has none of the tracked items?" -Type error; exit 1 }
Write-Status "Source physical total (frozen, tracked items): $srcTotal" -Type info

# 3. Transfer (so the export produces the validator's expectedItemCounts in the import-result).
$destId = Get-ClusterioInstanceId -InstanceName $dstInstance
docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
Write-Status "Transfer initiated..." -Type info

# 4. Read the validator's expected (from count_all_items over the serialized export).
$start = Get-Date; $rf = $null
while (-not $rf -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Seconds 2
    $f = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${clone}_*.json")
    if ($f.Count -gt 0) { $rf = $f[0] }
}
if (-not $rf) { Write-Status "No import-result after ${TimeoutSec}s (transfer may have stalled)" -Type error; exit 1 }
Start-Sleep -Seconds 2
$rd = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $rf
$exp = Get-SafeProperty $rd "validation_result" | ForEach-Object { Get-SafeProperty $_ "expectedItemCounts" }
$valExpTotal = 0
foreach ($n in $Items) { $valExpTotal += [int](Get-SafeProperty $exp $n) }
Write-Status "Validator expected total (count_all_items): $valExpTotal" -Type info

$tol = [Math]::Max($TolAbs, [int]($srcTotal * $TolPct))

# METER DRIFT — the validator's count must agree with the independent physical count of the same source.
$meterDelta = [Math]::Abs($srcTotal - $valExpTotal)
if ($meterDelta -le $tol) {
    Write-TestResult -TestId "fid-meter-no-drift" -TestName "Validator expected agrees with physical source (src=$srcTotal val_exp=$valExpTotal, |Δ|=$meterDelta <= $tol)" -Status "passed"
} else {
    Write-TestResult -TestId "fid-meter-no-drift" -TestName "Validator expected agrees with physical source" -Status "failed" -Message "physical src=$srcTotal but validator expected=$valExpTotal |Δ|=$meterDelta > tol=$tol — the validator's item count has DRIFTED from physical reality (serializer/count regression)"
    $failed++
}

# 5. Cleanup (the transfer deletes the source on success; remove the dest clone + any source remnant).
Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null

Write-TestSummary -Passed ($TOTAL_ASSERTIONS - $failed) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
