<#
.SYNOPSIS
    Transfer-fidelity sentinel — proves item fidelity with INDEPENDENT physical counts, and detects meter
    drift. Grounded in physical truth (get_item_count over both surfaces), NEVER the validator's own report.

.DESCRIPTION
    The lesson this guards (see the data-integrity-test-grounding memory): a fidelity test that asserts on the
    validator's `totalItemLoss` would go green on a broken meter. This test instead measures the invariant
    independently — physical item totals on the source (pre-transfer) and destination (post-activation) — and
    additionally cross-checks the validator's `expectedItemCounts` against the physical source (two independent
    counting methods that must agree → catches meter drift, e.g. the held-item phantom).

    Assertions (aggregate over a representative set of high-count items):
      A) PHYSICAL FIDELITY (independent of the validator): dest_total ~= source_total → items not lost.
      B) METER ACCURACY (drift detector): validator expected ~= physical source → the meter matches reality.

.PARAMETER Items
    Representative high-count item types to track (default: a combat/asteroid-platform mix present on `test`).
.PARAMETER TolPct
    Tolerance as a fraction of the source total, for belt/crafting drift (default 0.01 = 1%).
.PARAMETER TolAbs
    Minimum absolute tolerance (default 50) so tiny totals aren't held to an unrealistically tight bound.
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [string[]]$Items = @("railgun-ammo", "iron-plate", "copper-plate", "steel-plate", "piercing-rounds-magazine"),
    [double]$TolPct = 0.01,
    [int]$TolAbs = 50,
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

Write-TestHeader "🛰️ Transfer Fidelity Sentinel (physical counts — independent of the validator)"

if ($SourceHost -eq 0) {
    $SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
    if (-not $SourceHost) { Write-Status "Source platform '$SourcePlatform' not found on any host" -Type error; exit 1 }
}
$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance = "clusterio-host-$SourceHost-instance-1"
$dstInstance = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$srcSel = "${SourceHost}1"; $dstSel = "${DestHost}1"
$clone = "fidsentinel-$(Get-Date -Format 'HHmmss')"
$itemsLua = "'" + ($Items -join "','") + "'"
Write-Host "  host-$SourceHost -> host-$DestHost   clone: $clone" -ForegroundColor Gray
Write-Host "  items: $($Items -join ', ')" -ForegroundColor Gray
Write-Host ""

$failed = 0
$TOTAL_ASSERTIONS = 2

# Comprehensive PHYSICAL count of the tracked items on a platform: get_item_count over all non-item-entity
# entities (which already includes belt-line items) + loose ground items. NO separate belt scan (would
# double-count belts). This is the independent source of truth — never the validator's report.
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

# 2. Physical source baseline (the independent truth, pre-transfer).
$srcTotal = Count-Set $srcSel $clone
if ($srcTotal -lt 1) { Write-Status "Source physical total invalid ($srcTotal) — fixture has none of the tracked items?" -Type error; exit 1 }
Write-Status "Source physical total (tracked items): $srcTotal" -Type info

# 3. Transfer.
$destId = Get-ClusterioInstanceId -InstanceName $dstInstance
docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
Write-Status "Transfer initiated..." -Type info

# 4. Wait for import-result; settle (let activation finish so held items are restored).
$start = Get-Date; $rf = $null
while (-not $rf -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Seconds 2
    $f = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${clone}_*.json")
    if ($f.Count -gt 0) { $rf = $f[0] }
}
if (-not $rf) { Write-Status "No import-result after ${TimeoutSec}s (transfer may have stalled)" -Type error; exit 1 }
Start-Sleep -Seconds 4

# 5. Physical destination total (independent) + the validator's expected for the tracked items (for drift).
$dstTotal = Count-Set $dstSel $clone
$rd = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $rf
$exp = Get-SafeProperty $rd "validation_result" | ForEach-Object { Get-SafeProperty $_ "expectedItemCounts" }
$valExpTotal = 0
foreach ($n in $Items) { $valExpTotal += [int](Get-SafeProperty $exp $n) }
Write-Status "Dest physical total: $dstTotal ;  validator expected total: $valExpTotal" -Type info

$tol = [Math]::Max($TolAbs, [int]($srcTotal * $TolPct))

# A) PHYSICAL FIDELITY — measured independently of the validator. Fidelity means NO net LOSS; a net GAIN is
# legitimate (machines craft during the post-activation settle — Pitfall #15), so this is a loss-only bound.
$physLoss = $srcTotal - $dstTotal   # positive = net loss (the failure direction); negative = net gain (crafting)
if ($physLoss -le $tol) {
    Write-TestResult -TestId "fid-no-physical-loss" -TestName "No net physical item LOSS across transfer (src=$srcTotal dst=$dstTotal, net loss=$physLoss <= $tol; post-activation crafting gains tolerated)" -Status "passed"
} else {
    Write-TestResult -TestId "fid-no-physical-loss" -TestName "No net physical item LOSS across transfer" -Status "failed" -Message "src=$srcTotal dst=$dstTotal net loss=$physLoss > tol=$tol — REAL fidelity regression (independent of the validator)"
    $failed++
}

# B) METER DRIFT — the validator's expected must agree with the physical source (two independent meters).
$meterDelta = [Math]::Abs($srcTotal - $valExpTotal)
if ($meterDelta -le $tol) {
    Write-TestResult -TestId "fid-meter-no-drift" -TestName "Validator expected agrees with physical source (src=$srcTotal val_exp=$valExpTotal, |Δ|=$meterDelta <= $tol)" -Status "passed"
} else {
    Write-TestResult -TestId "fid-meter-no-drift" -TestName "Validator expected agrees with physical source" -Status "failed" -Message "physical src=$srcTotal but validator expected=$valExpTotal |Δ|=$meterDelta > tol=$tol — the meter has DRIFTED from physical reality"
    $failed++
}

# 6. Cleanup (all paths reached here; early exits above are pre-transfer so they leak nothing transferable).
Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null

Write-TestSummary -Passed ($TOTAL_ASSERTIONS - $failed) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
