<#
.SYNOPSIS
    Name-collision litmus (the index-as-join-key sweep). Two platforms on ONE force sharing the SAME name
    must be handled by their UNIQUE index, never by the collidable name:
      (#81) locking one must NOT report the other locked, and the sibling must be independently lockable;
      ([3]) transferring one by index must delete THAT one and leave the same-named sibling untouched.

.DESCRIPTION
    Platform `name` is mutable + non-unique (Factorio keys platforms by the unique `platform.index`). Before
    this sweep the lock registry + source delete were keyed by name → a name collision could lock/delete the
    WRONG platform. This proves the index keying:

    SETUP: clone the source twice, rename BOTH clones to the same name (premise: the engine allows it — the
    import auto-rename exists precisely because collisions are possible). If the rename does NOT produce two
    same-named platforms, the test FAILS LOUD (the #81/#3 premise would need revisiting).

    LITMUS (RED if the registry/delete revert to name keying):
      A) lock clone-A → registry has A's index, NOT B's index (no #81 false-positive);
      B) clone-B locks independently (name-keyed would refuse "already locked");
      C) transfer clone-A by index → strict gate passes;
      D) clone-A (its index) is GONE on the source;
      E) clone-B (same name, its index) SURVIVES on the source.

.PARAMETER SourcePlatform
    Platform to clone twice (default: test).
.PARAMETER TimeoutSec
    Max seconds to wait for the destination import-result (default: 180).
#>
param(
    [string]$SourcePlatform = "test",
    [int]$TimeoutSec = 180
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "🔑 Name-Collision (two same-named platforms -> keyed by unique index, not name)"

$SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
if (-not $SourceHost) { Write-Status "Source platform '$SourcePlatform' not found on any host" -Type error; exit 1 }
$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance  = "clusterio-host-$SourceHost-instance-1"
$dstInstance  = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$ts = Get-Date -Format 'HHmmss'
$cloneA = "collA-$ts"; $cloneB = "collB-$ts"
$dupName = "DUP-$ts"
Write-Host "  host-$SourceHost -> host-$DestHost   clones: $cloneA, $cloneB  -> both renamed '$dupName'" -ForegroundColor Gray
Write-Host ""

$failed = 0
$TOTAL_ASSERTIONS = 5

# Is the platform at $idx locked? Reads the index-keyed registry DIRECTLY (storage is reachable from /sc;
# `require` is not). Returns "true"/"false"/"nil-store".
function Get-LockedByIndex([string]$instance, [int]$idx) {
    $lua = "rcon.print('LK='..tostring(storage.locked_platforms ~= nil and storage.locked_platforms[$idx] ~= nil))"
    $raw = (Invoke-Lua -Instance $instance -Code $lua | Out-String)
    if ($raw -match 'LK=(true|false)') { return $Matches[1] }
    return "?"
}
function Get-PlatformNameByIndex([string]$instance, [int]$idx) {
    $lua = "local p=game.forces['player'].platforms[$idx] rcon.print('PN='..((p and p.valid) and p.name or '<gone>'))"
    $raw = (Invoke-Lua -Instance $instance -Code $lua | Out-String)
    if ($raw -match 'PN=(.+)') { return $Matches[1].Trim() }
    return "?"
}

try {
    # ---- Clone twice + rename BOTH to the same name. ----
    foreach ($clone in @($cloneA, $cloneB)) {
        Write-Status "Cloning '$SourcePlatform' -> '$clone'..." -Type info
        $cl = New-TestPlatform -Instance $srcInstance -SourcePlatform $SourcePlatform -DestPlatform $clone
        if (-not $cl.success) { Write-Status "Clone '$clone' failed: $($cl.error)" -Type error; exit 1 }
        if ($cl.job_id) {
            Wait-ForJob -Instances @($srcInstance) -MaxWaitSeconds 120 -CheckScript "local j=(storage.async_jobs or {})['$($cl.job_id)']; rcon.print(j == nil and 'true' or 'false')" | Out-Null
        }
        Start-Sleep -Seconds 1
    }
    $idxA = Get-PlatformIndex -Instance $srcInstance -PlatformName $cloneA
    $idxB = Get-PlatformIndex -Instance $srcInstance -PlatformName $cloneB
    if (-not $idxA -or -not $idxB) { Write-Status "Clones did not materialize (idxA=$idxA idxB=$idxB)" -Type error; exit 1 }
    if ($idxA -eq $idxB) { Write-Status "Both clones resolved to the same index ($idxA) — cannot test" -Type error; exit 1 }

    # Rename both to the SAME name.
    Invoke-Lua -Instance $srcInstance -Code "game.forces['player'].platforms[$idxA].name='$dupName' game.forces['player'].platforms[$idxB].name='$dupName' rcon.print('renamed')" | Out-Null
    $nameA = Get-PlatformNameByIndex $srcInstance $idxA
    $nameB = Get-PlatformNameByIndex $srcInstance $idxB
    Write-Status "After rename: index $idxA name='$nameA', index $idxB name='$nameB'" -Type info
    if ($nameA -ne $dupName -or $nameB -ne $dupName) {
        # Premise failed — the engine did not let two platforms share a name. Fail loud: the #81/#3 rationale
        # (and this test) assumes platform names can collide; if they truly cannot, revisit it.
        Write-TestResult -TestId "nc-premise" -TestName "Two platforms on one force CAN share a name (collision premise)" -Status "failed" -Message "rename did not yield two '$dupName' platforms (got '$nameA' / '$nameB') — engine may enforce unique platform names"
        Write-TestSummary -Passed 0 -Failed $TOTAL_ASSERTIONS
        exit 1
    }

    # ---- A) lock clone-A → registry keyed by A's index, NOT B's (no #81 false-positive). ----
    Invoke-Lua -Instance $srcInstance -Code "local ok,err=remote.call('surface_export','lock_platform_for_transfer',$idxA,'player') rcon.print('lockA='..tostring(ok)..' '..tostring(err))" | Out-Null
    $lockedA = Get-LockedByIndex $srcInstance $idxA
    $lockedB = Get-LockedByIndex $srcInstance $idxB
    Write-Status "After locking index ${idxA}: locked[$idxA]=$lockedA  locked[$idxB]=$lockedB" -Type info
    if ($lockedA -eq "true" -and $lockedB -eq "false") {
        Write-TestResult -TestId "nc-lock-per-index" -TestName "Locking one platform does NOT report its same-named sibling locked (#81)" -Status "passed"
    } else {
        Write-TestResult -TestId "nc-lock-per-index" -TestName "Locking one platform does NOT report its same-named sibling locked (#81)" -Status "failed" -Message "expected locked[$idxA]=true locked[$idxB]=false, got $lockedA / $lockedB (name-keyed registry would mark BOTH)"
        $failed++
    }

    # ---- B) clone-B locks INDEPENDENTLY (name-keyed registry would refuse 'already locked'). ----
    $lockBraw = (Invoke-Lua -Instance $srcInstance -Code "local ok,err=remote.call('surface_export','lock_platform_for_transfer',$idxB,'player') rcon.print('lockB='..tostring(ok)..'|'..tostring(err))" | Out-String)
    Write-Status ("lock B result: " + ($lockBraw.Trim() -replace '\s+',' ')) -Type info
    if ($lockBraw -match 'lockB=true') {
        Write-TestResult -TestId "nc-lock-independent" -TestName "Same-named sibling is independently lockable (not a name collision)" -Status "passed"
    } else {
        Write-TestResult -TestId "nc-lock-independent" -TestName "Same-named sibling is independently lockable" -Status "failed" -Message "lock of index $idxB did not succeed: $($lockBraw.Trim())"
        $failed++
    }
    # Unlock both before the transfer.
    Invoke-Lua -Instance $srcInstance -Code "remote.call('surface_export','unlock_platform',$idxA) remote.call('surface_export','unlock_platform',$idxB) rcon.print('unlocked')" | Out-Null
    Start-Sleep -Seconds 1

    # ---- C/D/E) transfer clone-A BY INDEX → A deleted, B (same name) survives. ----
    $destId = Get-ClusterioInstanceId -InstanceName $dstInstance
    docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${dupName}_*.json 2>/dev/null" 2>$null | Out-Null
    Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idxA $destId" | Out-Null
    Write-Status "/transfer-platform $idxA $destId fired (index $idxA must be deleted; index $idxB must survive)..." -Type info

    $start = Get-Date; $resultFile = $null
    while (-not $resultFile -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
        Start-Sleep -Seconds 2
        $files = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${dupName}_*.json")
        if ($files.Count -gt 0) { $resultFile = $files[0] }
    }
    if (-not $resultFile) { Write-Status "No import-result after ${TimeoutSec}s (transfer stalled)" -Type error; exit 1 }
    Start-Sleep -Seconds 5  # let the source delete settle

    $resultData = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $resultFile
    $valSuccess = if ($resultData) { Get-SafeProperty $resultData "validation_success" } else { $null }
    $nameAfterA = Get-PlatformNameByIndex $srcInstance $idxA
    $nameAfterB = Get-PlatformNameByIndex $srcInstance $idxB
    Write-Status "After transfer of index ${idxA}: source index $idxA -> '$nameAfterA', index $idxB -> '$nameAfterB'" -Type info

    # C) validation passed
    if ($valSuccess -eq $true) {
        Write-TestResult -TestId "nc-validated" -TestName "Transfer of index $idxA completed + strict gate passed" -Status "passed"
    } else {
        Write-TestResult -TestId "nc-validated" -TestName "Transfer of index $idxA completed + strict gate passed" -Status "failed" -Message "validation_success=$valSuccess"
        $failed++
    }

    # D) the TRANSFERRED index is gone
    if ($nameAfterA -eq "<gone>") {
        Write-TestResult -TestId "nc-correct-deleted" -TestName "The transferred platform (index $idxA) was deleted" -Status "passed"
    } else {
        Write-TestResult -TestId "nc-correct-deleted" -TestName "The transferred platform (index $idxA) was deleted" -Status "failed" -Message "index $idxA still present as '$nameAfterA' (delete resolved the wrong platform?)"
        $failed++
    }

    # E) the same-named SIBLING survived
    if ($nameAfterB -eq $dupName) {
        Write-TestResult -TestId "nc-sibling-survives" -TestName "Same-named sibling (index $idxB) SURVIVED — name did not delete the wrong one ([3])" -Status "passed"
    } else {
        Write-TestResult -TestId "nc-sibling-survives" -TestName "Same-named sibling (index $idxB) SURVIVED" -Status "failed" -Message "index $idxB is now '$nameAfterB' (expected '$dupName') — the name-collision deleted the WRONG platform"
        $failed++
    }

    Write-TestSummary -Passed ($TOTAL_ASSERTIONS - $failed) -Failed $failed
    if ($failed -gt 0) { exit 1 }
    exit 0
}
finally {
    # Best-effort cleanup: unlock + remove both clones (by name) on source, and any copy on dest.
    Invoke-Lua -Instance $srcInstance -Code "for idx,_ in pairs(storage.locked_platforms or {}) do pcall(function() remote.call('surface_export','unlock_platform',idx) end) end rcon.print('unlocked-all')" | Out-Null
    Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$dupName' or p.name == '$cloneA' or p.name == '$cloneB'" | Out-Null
    Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$dupName'" | Out-Null
}
