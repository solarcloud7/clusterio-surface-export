<#
.SYNOPSIS
    Passenger-evacuate test (Layer 1). A platform transferred with someone aboard must EVACUATE them to a
    planet (Nauvis) BEFORE the source surface is deleted — never orphan a player, never duplicate.

.DESCRIPTION
    Replaces the old passenger HARD-BLOCK. A transfer is now allowed with passengers aboard; the SOLE
    source-delete chokepoint (delete_platform_for_transfer -> Gateway.evacuate_passengers) teleports aboard
    players AND abandoned character bodies to a non-colliding Nauvis position, THEN deletes the surface via
    GameUtils.delete_platform.

    WITNESSES (live reads on both instances):
      A) transfer validation passed                          (validation_success == true),
      B) source platform deleted                             (two-phase commit),
      C) destination has the transferred platform            (exactly the one copy),
      D) the aboard character was EVACUATED to Nauvis        (Nauvis character count +1, PHYSICAL).

    LITMUS (why this goes RED if evacuation is reverted): without evacuate-before-delete, the spawned aboard
    character is destroyed together with the source surface -> Nauvis character count is unchanged (D fails)
    = the player/character was orphaned. (CI covers the abandoned-character path; a live connected
    remote-view passenger is verified manually.)

.PARAMETER SourcePlatform
    Platform to clone as the transfer subject (default: test).
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

Write-TestHeader "🛟 Passenger Evacuate (transfer with someone aboard -> evacuated to Nauvis, not orphaned)"

$SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
if (-not $SourceHost) { Write-Status "Source platform '$SourcePlatform' not found on any host" -Type error; exit 1 }
$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance  = "clusterio-host-$SourceHost-instance-1"
$dstInstance  = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$clone = "evactest-$(Get-Date -Format 'HHmmss')"
Write-Host "  host-$SourceHost -> host-$DestHost   clone: $clone" -ForegroundColor Gray
Write-Host ""

$failed = 0
$TOTAL_ASSERTIONS = 5

# Character entities on the source instance's Nauvis (the evacuation destination).
function Get-NauvisChars([string]$instance) {
    $lua = "local s=game.surfaces['nauvis'] rcon.print('NCHARS='..(s and s.count_entities_filtered{type='character'} or -1))"
    $raw = (Invoke-Lua -Instance $instance -Code $lua | Out-String)
    if ($raw -match 'NCHARS=(-?\d+)') { return [int]$Matches[1] }
    return -999
}

# Character entities on a named platform's surface (the clone is uniquely timestamped, so a name lookup is
# unambiguous at this tooling boundary). Used on the DEST to assert the aboard character was NOT duplicated
# there: Layer 1 evacuates passengers to the SOURCE's planet, they do NOT travel with the platform. A character
# is a passenger (a player's body), excluded from the export scan; if one appears on the dest, the export is
# copying it AND evacuation is teleporting the source original = cross-instance duplication. Returns -1 if no
# surface with that platform name exists.
function Get-PlatformChars([string]$instance, [string]$name) {
    $lua = "local c=-1 for _,s in pairs(game.surfaces) do if s.valid and s.platform and s.platform.name=='$name' then c=s.count_entities_filtered{type='character'} break end end rcon.print('PCHARS='..c)"
    $raw = (Invoke-Lua -Instance $instance -Code $lua | Out-String)
    if ($raw -match 'PCHARS=(-?\d+)') { return [int]$Matches[1] }
    return -999
}

try {
    # ---- Clone a disposable subject on the source. ----
    Write-Status "Cloning '$SourcePlatform' -> '$clone'..." -Type info
    $cl = New-TestPlatform -Instance $srcInstance -SourcePlatform $SourcePlatform -DestPlatform $clone
    if (-not $cl.success) { Write-Status "Clone failed: $($cl.error)" -Type error; exit 1 }
    if ($cl.job_id) {
        Wait-ForJob -Instances @($srcInstance) -MaxWaitSeconds 120 -CheckScript "local j=(storage.async_jobs or {})['$($cl.job_id)']; rcon.print(j == nil and 'true' or 'false')" | Out-Null
    }
    Start-Sleep -Seconds 1
    $idx = Get-PlatformIndex -Instance $srcInstance -PlatformName $clone
    if (-not $idx) { Write-Status "Clone did not materialize" -Type error; exit 1 }

    # ---- Baseline Nauvis characters, then spawn an aboard character on the clone surface. ----
    $nauvisBefore = Get-NauvisChars $srcInstance
    Write-Status "Nauvis characters before: $nauvisBefore" -Type info
    $spawn = (Invoke-Lua -Instance $srcInstance -Code "local p=game.forces['player'].platforms[$idx] local e=p.surface.create_entity{name='character', position={0,0}} rcon.print((e and e.valid) and 'SPAWNED' or 'FAIL')" | Out-String)
    if ($spawn -notmatch 'SPAWNED') { Write-Status "Failed to spawn aboard character on clone" -Type error; exit 1 }
    Write-Status "Spawned an aboard character on '$clone'." -Type info

    # ---- Transfer the clone (with the aboard character) to the destination. ----
    $destId = Get-ClusterioInstanceId -InstanceName $dstInstance
    docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
    Send-Rcon -Instance $srcInstance -Command "/transfer-platform $idx $destId" | Out-Null
    Write-Status "/transfer-platform $idx $destId fired (the aboard character must be evacuated, not deleted)..." -Type info

    # ---- Wait for the import-result on the destination. ----
    $start = Get-Date; $resultFile = $null
    while (-not $resultFile -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
        Start-Sleep -Seconds 2
        $files = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${clone}_*.json")
        if ($files.Count -gt 0) { $resultFile = $files[0] }
    }
    if (-not $resultFile) { Write-Status "No import-result after ${TimeoutSec}s (transfer stalled)" -Type error; exit 1 }
    Start-Sleep -Seconds 5   # let the source delete + evacuation settle

    $resultData = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $resultFile
    $valSuccess = if ($resultData) { Get-SafeProperty $resultData "validation_success" } else { $null }
    $nauvisAfter = Get-NauvisChars $srcInstance
    $srcGone = (Invoke-Lua -Instance $srcInstance -Code "local f=false for _,s in pairs(game.surfaces) do if s.platform and s.platform.name=='$clone' then f=true end end rcon.print('SRCGONE='..tostring(not f))" | Out-String)
    $dstPresent = Get-PlatformIndex -Instance $dstInstance -PlatformName $clone

    # ---- A) validation passed ----
    if ($valSuccess -eq $true) {
        Write-TestResult -TestId "ev-validated" -TestName "Transfer completed + strict gate passed (validation_success=true)" -Status "passed"
    } else {
        Write-TestResult -TestId "ev-validated" -TestName "Transfer completed + strict gate passed" -Status "failed" -Message "validation_success=$valSuccess"
        $failed++
    }

    # ---- B) source deleted ----
    if ($srcGone -match 'SRCGONE=true') {
        Write-TestResult -TestId "ev-source-deleted" -TestName "Source platform deleted after successful transfer (two-phase commit)" -Status "passed"
    } else {
        Write-TestResult -TestId "ev-source-deleted" -TestName "Source platform deleted after successful transfer" -Status "failed" -Message "source '$clone' still present on $srcInstance"
        $failed++
    }

    # ---- C) destination has the platform (one copy) ----
    if ($dstPresent) {
        Write-TestResult -TestId "ev-dest-present" -TestName "Destination has the transferred platform" -Status "passed"
    } else {
        Write-TestResult -TestId "ev-dest-present" -TestName "Destination has the transferred platform" -Status "failed" -Message "'$clone' not found on $dstInstance"
        $failed++
    }

    # ---- D) the aboard character was EVACUATED to Nauvis (not lost with the surface) ----
    $delta = $nauvisAfter - $nauvisBefore
    Write-Status "Nauvis characters after: $nauvisAfter (delta $delta)" -Type info
    if ($delta -ge 1) {
        Write-TestResult -TestId "ev-evacuated" -TestName "Aboard character EVACUATED to Nauvis (count +$delta), not orphaned" -Status "passed"
    } else {
        Write-TestResult -TestId "ev-evacuated" -TestName "Aboard character EVACUATED to Nauvis" -Status "failed" -Message "Nauvis char delta=$delta (expected >=1) — the aboard character was lost with the deleted surface (no evacuation)"
        $failed++
    }

    # ---- E) the character must NOT also be DUPLICATED onto the destination (Layer 1: passengers don't travel) ----
    # Litmus for the cross-instance duplication the export scan would otherwise cause (character serialized →
    # recreated on dest AND evacuated to source-Nauvis). The dest platform must have ZERO characters.
    if ($dstPresent) {
        $dstChars = Get-PlatformChars $dstInstance $clone
        Write-Status "Destination platform characters: $dstChars (must be 0 — passenger evacuated to source, not transported)" -Type info
        if ($dstChars -eq 0) {
            Write-TestResult -TestId "ev-no-dup" -TestName "Aboard character NOT duplicated onto destination (dest char count = 0)" -Status "passed"
        } elseif ($dstChars -lt 0) {
            # -1 (no surface matched the name) / -999 (RCON/parse error) are MEASUREMENT failures, not a
            # duplication signal — fail explicitly as "could not measure" so a transient hiccup can't read
            # as a false cross-instance-duplication regression.
            Write-TestResult -TestId "ev-no-dup" -TestName "Aboard character NOT duplicated onto destination" -Status "failed" -Message "could not measure dest platform characters (got $dstChars — surface name-scan/RCON error); not a duplication signal"
            $failed++
        } else {
            Write-TestResult -TestId "ev-no-dup" -TestName "Aboard character NOT duplicated onto destination" -Status "failed" -Message "dest platform has $dstChars character(s) — the passenger was COPIED to the dest AND evacuated to source-Nauvis (cross-instance duplication)"
            $failed++
        }
    } else {
        Write-TestResult -TestId "ev-no-dup" -TestName "Aboard character NOT duplicated onto destination" -Status "failed" -Message "dest platform not present — cannot check for duplication"
        $failed++
    }

    Write-TestSummary -Passed ($TOTAL_ASSERTIONS - $failed) -Failed $failed
    if ($failed -gt 0) { exit 1 }
    exit 0
}
finally {
    Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
    Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null
    # Best-effort: remove the anonymous evacuated test characters from Nauvis (player-controlled bodies are
    # left untouched) so repeated runs start from a clean baseline.
    Invoke-Lua -Instance $srcInstance -Code "local s=game.surfaces['nauvis'] if s then for _,c in pairs(s.find_entities_filtered{type='character'}) do if c.valid and not c.player then c.destroy() end end end rcon.print('cleaned')" | Out-Null
}
