<#
.SYNOPSIS
    Active-state round-trip — an entity that is INACTIVE (active=false) on the source must arrive INACTIVE
    on the destination, and an inserter holding an item must keep that item regardless of its active state.

.DESCRIPTION
    Adversarial fixture for the frozen_states key-type bug (root-caused via a helpers.table_to_json probe on
    2.0.76): frozen_states is built on the SOURCE keyed by NUMERIC unit_number, then transmitted as JSON.
    JSON object keys are strings, so a numeric key 12917 comes back as "12917"; active_state_restoration's
    numeric lookup `frozen_states[entity_id]` then MISSES and every entity defaults to active — silently
    flipping inactive entities to ACTIVE on the destination. The lookup-tolerance fix (try the string key)
    alone would REGRESS held-item handling: an inactive inserter would move from the (buggy) active branch
    that restores its held item to the inactive branch that didn't — converting a state-only bug into a
    held-item LOSS. So the fix also restores held items in the inactive branch (activate -> set_stack ->
    deactivate, verified durable on 2.0.76).

    This pins BOTH halves with INDEPENDENT PHYSICAL reads on the destination (held_stack / active — never the
    validator's report):
      * an inactive+holding inserter arrives active=false  (the state fix; FAILS on the pre-fix code)
      * that inserter still holds its item                 (the held-item regression guard)
      * an active+holding inserter arrives active=true and still holds its item (baseline)

    NOTE: this does NOT assert an aggregate item total — `test` is a live crafting platform whose totals are
    not conserved across the transfer window (see the data-integrity-test-grounding memory). The invariant is
    measured at known POSITIONS (stable across transfer) by reading the physical held_stack directly.

.PARAMETER SourcePlatform
    Platform to clone as the transfer subject (default: test).
.PARAMETER SourceHost
    Host holding the source platform (default: auto-detect).
.PARAMETER Item
    A distinctive item to put in the inserters' hands (default: processing-unit).
.PARAMETER TimeoutSec
    Max seconds to wait for the destination import-result (default: 150).
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [string]$Item = "processing-unit",
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

Write-TestHeader "🧊 Active-State Round-Trip (inactive stays inactive; held item survives)"

if ($SourceHost -eq 0) {
    $SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
    if (-not $SourceHost) { Write-Status "Source platform '$SourcePlatform' not found on any host" -Type error; exit 1 }
}
$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance  = "clusterio-host-$SourceHost-instance-1"
$dstInstance  = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$srcSel = "${SourceHost}1"; $dstSel = "${DestHost}1"
$clone = "activestate-$(Get-Date -Format 'HHmmss')"
Write-Host "  host-$SourceHost -> host-$DestHost   clone: $clone   item: $Item" -ForegroundColor Gray
Write-Host ""

$failed = 0
$TOTAL_ASSERTIONS = 3

# 1. Clone.
Write-Status "Cloning '$SourcePlatform' -> '$clone'..." -Type info
$cl = New-TestPlatform -Instance $srcInstance -SourcePlatform $SourcePlatform -DestPlatform $clone
if (-not $cl.success) { Write-Status "Clone failed: $($cl.error)" -Type error; exit 1 }
if ($cl.job_id) {
    Wait-ForJob -Instances @($srcInstance) -MaxWaitSeconds 90 -CheckScript "local j=(storage.async_jobs or {})['$($cl.job_id)']; rcon.print(j == nil and 'true' or 'false')" | Out-Null
}
Start-Sleep -Seconds 1
$idx = Get-PlatformIndex -Instance $srcInstance -PlatformName $clone
if (-not $idx) { Write-Status "Clone did not materialize" -Type error; exit 1 }
Write-Status "Clone ready (index $idx)" -Type success

# 2. Build the fixture: two empty-handed inserters get a held item; one stays active, one is set inactive.
#    Record their positions (stable across transfer) so we can find them on the destination.
$fx = "/sc local function fp(n) for _,q in pairs(game.forces['player'].platforms or {}) do if q.name==n then return q end end end local p=fp('$clone') if not p then rcon.print('ERR=noplatform') return end local s=p.surface local found={} for _,e in pairs(s.find_entities_filtered({type='inserter'})) do if e.valid and e.held_stack and not e.held_stack.valid_for_read then found[#found+1]=e if #found>=2 then break end end end if #found<2 then rcon.print('ERR=needtwoinserters_got'..#found) return end local a=found[1] local b=found[2] pcall(function() a.held_stack.set_stack({name='$Item',count=1}) end) a.active=true pcall(function() b.held_stack.set_stack({name='$Item',count=1}) end) b.active=false rcon.print(string.format('APOS=%.3f,%.3f BPOS=%.3f,%.3f AHELD=%s BHELD=%s BACTIVE=%s', a.position.x,a.position.y,b.position.x,b.position.y, tostring(a.held_stack.valid_for_read), tostring(b.held_stack.valid_for_read), tostring(b.active)))"
$fout = (& "$repoRoot\tools\rcon.ps1" $srcSel $fx) -join " "
Write-Host "  fixture: $fout" -ForegroundColor DarkGray
if ($fout -notmatch 'APOS=([-\d.]+),([-\d.]+)\s+BPOS=([-\d.]+),([-\d.]+)') {
    Write-Status "Could not build the inserter fixture (got '$fout')" -Type error; exit 1
}
$ax = $Matches[1]; $ay = $Matches[2]; $bx = $Matches[3]; $by = $Matches[4]
if ($fout -notmatch 'AHELD=True' -or $fout -notmatch 'BHELD=True' -or $fout -notmatch 'BACTIVE=false') {
    Write-Status "Fixture preconditions not met (need AHELD/BHELD set and B inactive): $fout" -Type error; exit 1
}
Write-Status "Fixture: A active+held @($ax,$ay); B inactive+held @($bx,$by)" -Type success

# 3. Transfer.
$destId = Get-ClusterioInstanceId -InstanceName $dstInstance
docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
Write-Status "Transfer initiated..." -Type info

# 4. Wait for the import-result, then let the destination settle (activation phase).
$start = Get-Date; $found = $false
while (-not $found -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Seconds 2
    $files = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${clone}_*.json")
    if ($files.Count -gt 0) { $found = $true }
}
if (-not $found) {
    Write-Status "No import-result after ${TimeoutSec}s (transfer may have stalled)" -Type error
    Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
    Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null
    exit 1
}
Start-Sleep -Seconds 4

# 5. Inspect the destination inserters at the recorded positions (physical truth: active + held_stack).
$ix = "/sc local function fp(n) for _,q in pairs(game.forces['player'].platforms or {}) do if q.name==n then return q end end end local p=fp('$clone') if not p then rcon.print('ERR=noplatform') return end local s=p.surface local function ins(px,py) local es=s.find_entities_filtered({type='inserter',position={px,py},radius=0.4}) if #es==0 then return 'MISSING' end local e=es[1] local h=e.held_stack.valid_for_read and (e.held_stack.name..'x'..e.held_stack.count) or 'empty' return string.format('active=%s held=%s', tostring(e.active), h) end rcon.print('A '..ins($ax,$ay)) rcon.print('B '..ins($bx,$by))"
$iout = @(& "$repoRoot\tools\rcon.ps1" $dstSel $ix)
$iline = ($iout -join "`n")
Write-Host "  dest inserters:`n$iline" -ForegroundColor DarkGray

$aInfo = ($iout | Where-Object { $_ -match '^A ' }) -join " "
$bInfo = ($iout | Where-Object { $_ -match '^B ' }) -join " "

# --- Assertions (all read physical destination state, not the validator's report) ---

# A) THE STATE FIX: the inactive inserter must arrive inactive (pre-fix code flips it active).
if ($bInfo -match 'active=false') {
    Write-TestResult -TestId "as-inactive-kept" -TestName "Inactive inserter stays inactive across transfer (dest: $bInfo)" -Status "passed"
} else {
    Write-TestResult -TestId "as-inactive-kept" -TestName "Inactive inserter stays inactive across transfer" -Status "failed" -Message "expected dest active=false but got '$bInfo' -- frozen_states numeric key lost through JSON; entity wrongly defaulted to active"
    $failed++
}

# B) REGRESSION GUARD: the inactive inserter must STILL hold its item (the inactive-branch held restore).
if ($bInfo -match "held=$([regex]::Escape($Item))x") {
    Write-TestResult -TestId "as-inactive-held" -TestName "Inactive inserter keeps its held item (dest: $bInfo)" -Status "passed"
} else {
    Write-TestResult -TestId "as-inactive-held" -TestName "Inactive inserter keeps its held item" -Status "failed" -Message "expected dest held=${Item}x.. but got '$bInfo' -- the state fix dropped the held item for an inactive inserter (set_stack failed on the deactivated entity)"
    $failed++
}

# C) BASELINE: the active inserter must arrive active AND still hold its item.
if ($aInfo -match 'active=true' -and $aInfo -match "held=$([regex]::Escape($Item))x") {
    Write-TestResult -TestId "as-active-held" -TestName "Active inserter stays active and keeps its held item (dest: $aInfo)" -Status "passed"
} else {
    Write-TestResult -TestId "as-active-held" -TestName "Active inserter stays active and keeps its held item" -Status "failed" -Message "expected dest active=true + held=${Item}x.. but got '$aInfo'"
    $failed++
}

# 6. Cleanup both hosts (source is deleted on a successful transfer; remove dest clone + any source remnant).
Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null

Write-TestSummary -Passed ($TOTAL_ASSERTIONS - $failed) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
