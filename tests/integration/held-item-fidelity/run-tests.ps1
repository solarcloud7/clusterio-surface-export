<#
.SYNOPSIS
    Held-item fidelity test — inserter held items must be handled correctly by the validation meter
    (Option B). Guards the code-review findings:
      #1 (silent loss): an INACTIVE inserter's held item is restored by nothing, so it must show as a
         VISIBLE loss (not be silently subtracted from expected).
      #3 (phantom gain): an ACTIVE inserter's held item IS restored, so it must NOT show as a gain.

.DESCRIPTION
    Places a distinctive item ($Item) as the held stack on one ACTIVE and one INACTIVE inserter of a cloned
    platform, transfers, and checks:
      A) physical: dest total == source total - 1  (the active held is preserved; only the inactive one is lost),
      B) meter:    the validation result reports that 1 as a LOSS (expected - actual == 1), not 0 (silent) and
                   not a gain (#3).
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [string]$Item = "uranium-235",
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

Write-TestHeader "🤏 Held-Item Fidelity (active held preserved; inactive held visible, not silent)"

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
$clone = "helditem-$(Get-Date -Format 'HHmmss')"
Write-Host "  host-$SourceHost -> host-$DestHost   clone: $clone   item: $Item" -ForegroundColor Gray
Write-Host ""

$failed = 0
$TOTAL_ASSERTIONS = 2

# Comprehensive count of $Item (ground + all inventories incl. inserter held + belts).
function Count-Item([string]$sel, [string]$name) {
    $lua = "/sc local function fp(n) for _,q in pairs(game.forces['player'].platforms or {}) do if q.name==n then return q end end end local p=fp('$name') if not p then rcon.print('TOTAL=-1') return end local s=p.surface local t=0 for _,e in ipairs(s.find_entities_filtered({type='item-entity'})) do if e.valid and e.stack and e.stack.valid_for_read and e.stack.name=='$Item' then t=t+e.stack.count end end for _,e in ipairs(s.find_entities_filtered({})) do if e.valid and e.type~='item-entity' then local ok,c=pcall(function() return e.get_item_count('$Item') end) if ok and c then t=t+c end end end rcon.print('TOTAL='..t)"
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

# 2. Put $Item held on one ACTIVE inserter and one INACTIVE inserter (set held while active, then deactivate).
$setup = "/sc local function fp(n) for _,q in pairs(game.forces['player'].platforms or {}) do if q.name==n then return q end end end local p=fp('$clone') if not p then rcon.print('ERR:noplatform') return end local s=p.surface local ins=s.find_entities_filtered({type='inserter'}) if #ins<2 then rcon.print('ERR:need2inserters('..#ins..')') return end local a=ins[1] local b=ins[2] a.active=true pcall(function() a.held_stack.set_stack({name='$Item',count=1}) end) b.active=true pcall(function() b.held_stack.set_stack({name='$Item',count=1}) end) b.active=false rcon.print('a_held='..tostring(a.held_stack.valid_for_read)..' a_active='..tostring(a.active)..' b_held='..tostring(b.held_stack.valid_for_read)..' b_active='..tostring(b.active))"
$setupOut = (& "$repoRoot\tools\rcon.ps1" $srcSel $setup) -join " "
Write-Status "Setup: $setupOut" -Type info
if ($setupOut -notmatch 'a_held=true.*a_active=true.*b_held=true.*b_active=false') {
    Write-Status "Could not construct the active+inactive held fixture ('$setupOut')" -Type error; exit 1
}

# 3. Source physical baseline.
$srcTotal = Count-Item $srcSel $clone
Write-Status "Source physical '$Item' total: $srcTotal" -Type info

# 4. Transfer.
$destId = Get-ClusterioInstanceId -InstanceName $dstInstance
docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
Write-Status "Transfer initiated..." -Type info

# 5. Wait for the import-result; settle.
$start = Get-Date; $rf = $null
while (-not $rf -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Seconds 2
    $f = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${clone}_*.json")
    if ($f.Count -gt 0) { $rf = $f[0] }
}
if (-not $rf) { Write-Status "No import-result after ${TimeoutSec}s" -Type error; exit 1 }
Start-Sleep -Seconds 4

# 6. Dest physical + the result's expected/actual for $Item.
$dstTotal = Count-Item $dstSel $clone
$rd = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $rf
$vr = Get-SafeProperty $rd "validation_result"
$expItem = [int](Get-SafeProperty (Get-SafeProperty $vr "expectedItemCounts") $Item)
$actItem = [int](Get-SafeProperty (Get-SafeProperty $vr "actualItemCounts") $Item)
Write-Status "Dest physical total: $dstTotal ;  result expected[$Item]=$expItem actual[$Item]=$actItem" -Type info

# A) Physical: the ACTIVE held survives, the INACTIVE held is lost -> exactly 1 fewer.
if ($srcTotal -ge 2 -and $dstTotal -eq ($srcTotal - 1)) {
    Write-TestResult -TestId "held-active-preserved" -TestName "Active inserter held item preserved; only the inactive one lost ($srcTotal -> $dstTotal)" -Status "passed"
} else {
    Write-TestResult -TestId "held-active-preserved" -TestName "Active inserter held item preserved; only the inactive one lost" -Status "failed" -Message "expected dest == src-1 ($($srcTotal-1)), got src=$srcTotal dest=$dstTotal (active held lost, or inactive unexpectedly restored)"
    $failed++
}

# B) Meter: the inactive held loss is VISIBLE (expected - actual == 1), not silently subtracted (==0) or a gain (<0).
$delta = $expItem - $actItem
if ($delta -eq 1) {
    Write-TestResult -TestId "held-inactive-visible" -TestName "Inactive held loss is VISIBLE in the meter (expected-actual=1), not silent or a phantom gain" -Status "passed"
} else {
    Write-TestResult -TestId "held-inactive-visible" -TestName "Inactive held loss is VISIBLE in the meter" -Status "failed" -Message "expected[$Item]-actual[$Item] = $delta (want 1; 0 = silent-subtraction regression #1; <0 = phantom gain regression #3)"
    $failed++
}

# 7. Cleanup.
Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null

Write-TestSummary -Passed ($TOTAL_ASSERTIONS - $failed) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
