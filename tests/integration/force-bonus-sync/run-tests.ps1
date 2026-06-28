<#
.SYNOPSIS
    Pre-hydration force-sync test — a transfer to an UNDER-RESEARCHED destination force must still seat held
    items in full and pass the strict gate NATIVELY, because the import replicates the source force's
    inserter-capacity bonuses onto the dest before hydration. Grounded in PHYSICAL held counts.

.DESCRIPTION
    Root cause (see the held-item-loss-is-dest-force-research memory / CLAUDE.md Pitfall #28): a bulk-inserter
    hand's physical capacity is governed by the DESTINATION force's `bulk_inserter_capacity_bonus`
    (and normal inserters by `inserter_stack_size_bonus`) — research-derived scalars that live in the dest
    save, which the plugin did not transfer. On a force with bonus 0 each hand caps at ~1, so held items the
    source legitimately held are genuinely unplaceable and the strict gate correctly fails (this is exactly
    why CI, whose fresh host-2 seed has bonus 0, failed while a long-lived local host-2 with bonus 11 passed).

    The fix carries the source bonuses in the payload and RAISES the dest force (raise-only) before any entity
    is created. This test reproduces the adversarial condition ON PURPOSE — it forces the dest bonus to 0
    regardless of environment — then WITNESSES (not infers):
      A) the dest force bonus was RAISED back to the source value           (live read on the dest),
      B) the dest inserters PHYSICALLY hold ~the full source amount         (sum of held_stack.count),
      C) validation_success == true                                        (strict gate passes natively),
      D) forceDataMismatches recorded the raise                            (the warning fired).

    LITMUS (why this goes RED if the fix is reverted): without the force-sync, a bonus-0 dest caps each hand
    at ~1, so B collapses to ~(#inserters) instead of the full held total, and C flips to false (the strict
    gate detects the genuine shortfall). Setting the dest bonus to 0 here is SAFE: already-seated items are
    never ejected when a bonus drops (verified on 2.0.76), and host-2's import target is otherwise idle.

.PARAMETER SourcePlatform
    Platform to clone as the transfer subject (default: test — busy, with held inserters).
.PARAMETER HeldTolPct
    Tolerance on the dest-vs-source held total, as a fraction (default 0.12) — absorbs the inserter-motion
    noise on the live source clone while staying well under the cap-at-1 collapse the test must catch.
.PARAMETER HeldTolAbs
    Minimum absolute held tolerance (default 12).
.PARAMETER TimeoutSec
    Max seconds to wait for the destination import-result (default: 150).
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [double]$HeldTolPct = 0.12,
    [int]$HeldTolAbs = 12,
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

Write-TestHeader "🔬 Pre-Hydration Force Sync (under-researched dest -> held seated in full, gate passes)"

if ($SourceHost -eq 0) {
    $SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
    if (-not $SourceHost) { Write-Status "Source platform '$SourcePlatform' not found on any host" -Type error; exit 1 }
}
$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance  = "clusterio-host-$SourceHost-instance-1"
$dstInstance  = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$srcSel = "${SourceHost}1"
$dstSel = "${DestHost}1"
$clone = "forcesync-$(Get-Date -Format 'HHmmss')"
Write-Host "  host-$SourceHost -> host-$DestHost   clone: $clone" -ForegroundColor Gray
Write-Host ""

$failed = 0
$TOTAL_ASSERTIONS = 4

# PHYSICAL held-item total on a platform: sum of held_stack.count over every inserter. This is the
# independent source of truth (never the validator's self-report). Returns HELD=<total> INS=<holding inserters>.
function Get-HeldTotal([string]$sel, [string]$name) {
    $lua = "/sc local function fp(n) for _,q in pairs(game.forces['player'].platforms or {}) do if q.name==n then return q end end end local p=fp('$name') if not p then rcon.print('HELD=-1 INS=0') return end local s=p.surface local t=0 local ni=0 for _,e in ipairs(s.find_entities_filtered({type='inserter'})) do if e.valid and e.held_stack and e.held_stack.valid_for_read then t=t+e.held_stack.count ni=ni+1 end end rcon.print('HELD='..t..' INS='..ni)"
    $raw = (& "$repoRoot\tools\rcon.ps1" $sel $lua) -join " "
    if ($raw -match 'HELD=(-?\d+) INS=(\d+)') { return @{ held = [int]$Matches[1]; ins = [int]$Matches[2] } }
    return @{ held = -999; ins = 0 }
}

function Get-Bonus([string]$sel) {
    $lua = "/sc rcon.print('BONUS='..game.forces['player'].bulk_inserter_capacity_bonus..' STACK='..game.forces['player'].inserter_stack_size_bonus)"
    $raw = (& "$repoRoot\tools\rcon.ps1" $sel $lua) -join " "
    if ($raw -match 'BONUS=(-?\d+) STACK=(-?\d+)') { return @{ bulk = [int]$Matches[1]; stack = [int]$Matches[2] } }
    return @{ bulk = -999; stack = -999 }
}

# 1. Clone a disposable busy platform on the source (carries held inserters at the source's researched cap).
Write-Status "Cloning '$SourcePlatform' -> '$clone'..." -Type info
$cl = New-TestPlatform -Instance $srcInstance -SourcePlatform $SourcePlatform -DestPlatform $clone
if (-not $cl.success) { Write-Status "Clone failed: $($cl.error)" -Type error; exit 1 }
if ($cl.job_id) {
    Wait-ForJob -Instances @($srcInstance) -MaxWaitSeconds 90 -CheckScript "local j=(storage.async_jobs or {})['$($cl.job_id)']; rcon.print(j == nil and 'true' or 'false')" | Out-Null
}
Start-Sleep -Seconds 1
$idx = Get-PlatformIndex -Instance $srcInstance -PlatformName $clone
if (-not $idx) { Write-Status "Clone did not materialize" -Type error; exit 1 }

# 2. Capture the SOURCE force bonus + physical held total (the target the dest must reach).
$srcBonus = Get-Bonus $srcSel
$srcHeld  = Get-HeldTotal $srcSel $clone
Write-Status "Source: bonus(bulk=$($srcBonus.bulk) stack=$($srcBonus.stack))  held=$($srcHeld.held) over $($srcHeld.ins) inserters" -Type info
if ($srcBonus.bulk -le 0) { Write-Status "Source bulk bonus is $($srcBonus.bulk) — fixture not researched, test can't discriminate" -Type error; exit 1 }
if ($srcHeld.held -lt 1) { Write-Status "Source held total is $($srcHeld.held) — fixture has no held items" -Type error; exit 1 }

# 3. ADVERSARIAL SETUP: force the destination force UNDER-researched (bonus 0) so the import must repair it.
#    Safe: seated items are never ejected on a bonus drop, and host-$DestHost's import target is idle.
Invoke-Lua -Instance $dstInstance -Code "local f=game.forces['player'] f.bulk_inserter_capacity_bonus=0 f.inserter_stack_size_bonus=0 rcon.print('dest bonus zeroed: '..f.bulk_inserter_capacity_bonus)" | Out-Null
$destBefore = Get-Bonus $dstSel
Write-Status "Destination forced under-researched: bonus(bulk=$($destBefore.bulk) stack=$($destBefore.stack))" -Type info

# 4. Transfer. The import's Phase-0 force-sync must raise the dest bonus and seat the held items in full.
$destId = Get-ClusterioInstanceId -InstanceName $dstInstance
docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
Write-Status "Transfer initiated (expecting NATIVE strict-gate pass on the repaired dest)" -Type info

# 5. Wait for the import-result file (written regardless of pass/fail).
$start = Get-Date; $resultFile = $null
while (-not $resultFile -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Seconds 2
    $files = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${clone}_*.json")
    if ($files.Count -gt 0) { $resultFile = $files[0] }
}
if (-not $resultFile) { Write-Status "No import-result after ${TimeoutSec}s (transfer may have stalled)" -Type error; exit 1 }
Start-Sleep -Seconds 3

$resultData = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $resultFile
if (-not $resultData) { Write-Status "Could not parse import-result $resultFile" -Type error; exit 1 }
$valResult  = Get-SafeProperty $resultData "validation_result"
$valSuccess = Get-SafeProperty $resultData "validation_success"
$fdm        = Get-SafeProperty $valResult "forceDataMismatches"

# Live post-transfer reads on the destination.
$destAfter = Get-Bonus $dstSel
$dstHeld   = Get-HeldTotal $dstSel $clone
Write-Status "Destination after import: bonus(bulk=$($destAfter.bulk) stack=$($destAfter.stack))  held=$($dstHeld.held) over $($dstHeld.ins) inserters" -Type info

$heldTol = [Math]::Max($HeldTolAbs, [int]($srcHeld.held * $HeldTolPct))

# --- Assertions ---

# A) The dest force bonus was RAISED back to (at least) the source value.
if ($destAfter.bulk -ge $srcBonus.bulk) {
    Write-TestResult -TestId "forcesync-bonus-raised" -TestName "Dest bonus raised to source ($($destBefore.bulk) -> $($destAfter.bulk), source=$($srcBonus.bulk))" -Status "passed"
} else {
    Write-TestResult -TestId "forcesync-bonus-raised" -TestName "Dest bonus raised to source" -Status "failed" -Message "dest bulk bonus after import = $($destAfter.bulk) < source $($srcBonus.bulk) — pre-hydration force-sync did not run (reverted?)"
    $failed++
}

# B) The dest PHYSICALLY holds ~the full source amount (NOT capped at ~1/hand). Independent of the gate.
$heldDelta = [Math]::Abs($srcHeld.held - $dstHeld.held)
if ($dstHeld.held -gt 0 -and $heldDelta -le $heldTol) {
    Write-TestResult -TestId "forcesync-held-preserved" -TestName "Dest inserters physically hold full source amount (src=$($srcHeld.held) dst=$($dstHeld.held), |Δ|=$heldDelta <= $heldTol)" -Status "passed"
} else {
    Write-TestResult -TestId "forcesync-held-preserved" -TestName "Dest inserters physically hold full source amount" -Status "failed" -Message "src held=$($srcHeld.held) but dst held=$($dstHeld.held) |Δ|=$heldDelta > tol=$heldTol — held items capped on the under-researched dest (force-sync failed)"
    $failed++
}

# C) The strict gate PASSED natively (no gate-side hack, the repaired dest is a complete physical reality).
if ($valSuccess -eq $true) {
    Write-TestResult -TestId "forcesync-gate-passed" -TestName "Strict gate passes natively on the repaired dest (validation_success=true)" -Status "passed"
} else {
    Write-TestResult -TestId "forcesync-gate-passed" -TestName "Strict gate passes natively on the repaired dest" -Status "failed" -Message "validation_success=$valSuccess — the dest could not hold the held items even after force-sync (incomplete bonus coverage?)"
    $failed++
}

# D) The force-mismatch warning was recorded (so the raise-only side effect is visible/auditable).
$bulkEntry = $null
if ($fdm) { $bulkEntry = @($fdm) | Where-Object { $_.property -eq "bulk_inserter_capacity_bonus" } | Select-Object -First 1 }
if ($bulkEntry -and [int]$bulkEntry.destination -eq 0 -and [int]$bulkEntry.synced_to -ge $srcBonus.bulk) {
    Write-TestResult -TestId "forcesync-warning-recorded" -TestName "forceDataMismatches recorded the raise (dest 0 -> $([int]$bulkEntry.synced_to))" -Status "passed"
} else {
    Write-TestResult -TestId "forcesync-warning-recorded" -TestName "forceDataMismatches recorded the raise" -Status "failed" -Message "no bulk_inserter_capacity_bonus mismatch entry (dest=0 -> source) found in forceDataMismatches — the warning did not fire"
    $failed++
}

# 6. Cleanup: remove the clone on both hosts. The dest bonus is left raised (intended, raise-only) — and the
#    transfer's own sync already restored it from the forced 0, so the cluster is left in a sane state.
Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null

Write-TestSummary -Passed ($TOTAL_ASSERTIONS - $failed) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
