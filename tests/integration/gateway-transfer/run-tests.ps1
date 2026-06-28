<#
.SYNOPSIS
    Gateway transfer end-to-end test (Phase 1a). A platform parked at a gateway, transferred via
    /gateway-transfer, must arrive on the destination PAUSED, parked AT the gateway, with the gateway
    hop STRIPPED from its itinerary and full entity fidelity — and the source must be deleted.

.DESCRIPTION
    The surfexp_gateways data mod adds surfaceless `space-location` gateways (surfexp_gateway_1..N). The
    plugin unlocks them on startup, detects when a platform parks at one, and the /gateway-transfer command
    runs the normal two-phase-commit transfer. On import the destination recognises the gateway from the
    schedule's CURRENT record, strips the gateway hop, and parks the platform AT the gateway, paused.

    WITNESSES (not infers), all via live reads on the destination + the import-result file:
      A) the gateway is discovered + unlocked on the source        (is_space_location_unlocked),
      B) the transfer completed and validation passed              (validation_success == true),
      C) the landed platform is PAUSED                             (platform.paused == true),
      D) it is parked AT the gateway                               (space_location == surfexp_gateway_1),
      E) the gateway hop was STRIPPED                              (no surfexp_gateway_ record remains),
      F) entity fidelity                                           (dest entity count ~= source, PHYSICAL),
      G) the source platform was deleted                           (two-phase commit).

    LITMUS (why this goes RED if the gateway logic is reverted): without the import-side finalization the
    platform arrives UNPAUSED and flies the restored schedule back to the gateway (C/D flip, E shows the
    gateway record still present); without discover_and_unlock the route to the gateway fails (A flips).

.PARAMETER SourcePlatform
    Platform to clone as the transfer subject (default: test — a realistic, schedule-bearing platform).
.PARAMETER Gateway
    Gateway space-location to park at + transfer through (default: surfexp_gateway_1).
.PARAMETER EntityTolPct
    Tolerance on dest-vs-source physical entity count, as a fraction (default 0.02).
.PARAMETER TimeoutSec
    Max seconds to wait for the destination import-result (default: 180).
#>
param(
    [string]$SourcePlatform = "test",
    [string]$Gateway = "surfexp_gateway_1",
    [double]$EntityTolPct = 0.02,
    [int]$TimeoutSec = 180
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

Write-TestHeader "🛰  Gateway Transfer (park at gateway -> transfer -> arrive paused, hop stripped)"

$SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
if (-not $SourceHost) { Write-Status "Source platform '$SourcePlatform' not found on any host" -Type error; exit 1 }
$DestHost = if ($SourceHost -eq 1) { 2 } else { 1 }
$srcInstance  = "clusterio-host-$SourceHost-instance-1"
$dstInstance  = "clusterio-host-$DestHost-instance-1"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$dstInstance/script-output"
$clone = "gwtest-$(Get-Date -Format 'HHmmss')"
Write-Host "  host-$SourceHost -> host-$DestHost   gateway: $Gateway   clone: $clone" -ForegroundColor Gray
Write-Host ""

$failed = 0
$TOTAL_ASSERTIONS = 7

# Physical entity count on a named platform (independent of any validator self-report).
function Get-EntityCount([string]$instance, [string]$name) {
    $lua = "local function fp(n) for _,q in pairs(game.forces['player'].platforms or {}) do if q.name==n then return q end end end local p=fp('$name') if not p then rcon.print('ENT=-1') return end rcon.print('ENT='..#p.surface.find_entities_filtered{})"
    $raw = (Invoke-Lua -Instance $instance -Code $lua | Out-String)
    if ($raw -match 'ENT=(-?\d+)') { return [int]$Matches[1] }
    return -999
}

# Landed-platform state probe → "PAUSED=.. LOC=.. HASGW=.. ENT=.." (one line, parsed below).
function Get-LandedState([string]$instance, [string]$name) {
    $lua = @"
local function fp(n) for _,q in pairs(game.forces['player'].platforms or {}) do if q.name==n then return q end end end
local p=fp('$name') if not p then rcon.print('MISSING') return end
local hasgw=false local oks,sc=pcall(function() return p.get_schedule() end)
if oks and sc then local okr,recs=pcall(function() return sc.get_records() end) if okr and recs then
  for _,r in ipairs(recs) do if type(r.station)=='string' and r.station:sub(1,16)=='surfexp_gateway_' then hasgw=true end end end end
rcon.print('PAUSED='..tostring(p.paused)..' LOC='..tostring(p.space_location and p.space_location.name or 'nil')..' HASGW='..tostring(hasgw)..' ENT='..#p.surface.find_entities_filtered{})
"@
    return (Invoke-Lua -Instance $instance -Code $lua | Out-String).Trim()
}

try {
    # ---- A) Gateway discovered + unlocked on the source (startup discover_and_unlock). ----
    $unlocked = (Invoke-Lua -Instance $srcInstance -Code "local f=game.forces['player'] local ok,v=pcall(function() return f.is_space_location_unlocked('$Gateway') end) rcon.print('UNLOCKED='..tostring(ok and v))" | Out-String)
    if ($unlocked -match 'UNLOCKED=true') {
        Write-TestResult -TestId "gw-unlocked" -TestName "Gateway '$Gateway' discovered + unlocked on source (startup)" -Status "passed"
    } else {
        Write-TestResult -TestId "gw-unlocked" -TestName "Gateway '$Gateway' discovered + unlocked on source" -Status "failed" -Message "is_space_location_unlocked('$Gateway') not true on $srcInstance — discover_and_unlock did not run (mod missing / reverted?)"
        $failed++
    }

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

    # ---- Route the clone to the gateway with a holding wait condition; wait until it PARKS there. ----
    Write-Status "Routing '$clone' -> '$Gateway' (holding wait condition)..." -Type info
    Invoke-Lua -Instance $srcInstance -Code "local p=game.forces['player'].platforms[$idx] local s=p.get_schedule() local i=s.add_record({station='$Gateway', wait_conditions={{type='time', ticks=7200, compare_type='or'}}}) s.go_to_station(i) s.set_stopped(false) rcon.print('routed')" | Out-Null

    $parked = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Seconds 2
        $st = (Invoke-Lua -Instance $srcInstance -Code "local p=game.forces['player'].platforms[$idx] local sps=defines.space_platform_state rcon.print(tostring(p.state==sps.waiting_at_station)..' '..tostring(p.space_location and p.space_location.name))" | Out-String)
        if ($st -match "true\s+$([regex]::Escape($Gateway))") { $parked = $true; break }
    }
    if (-not $parked) { Write-Status "Clone never parked at '$Gateway' (route failed)" -Type error; exit 1 }
    Write-Status "Parked at '$Gateway'." -Type info

    # Capture the SOURCE physical entity count (fidelity baseline) while it is parked.
    $srcEnt = Get-EntityCount $srcInstance $clone
    Write-Status "Source entity count: $srcEnt" -Type info

    # ---- Fire /gateway-transfer to the destination. ----
    $destId = Get-ClusterioInstanceId -InstanceName $dstInstance
    docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
    Send-Rcon -Instance $srcInstance -Command "/gateway-transfer $idx $destId" | Out-Null
    Write-Status "/gateway-transfer $idx $destId fired (waiting for destination import)..." -Type info

    # ---- Wait for the import-result on the destination. ----
    $start = Get-Date; $resultFile = $null
    while (-not $resultFile -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
        Start-Sleep -Seconds 2
        $files = @(Get-DebugFiles -Instance $dstInstance -Container $dstContainer -Pattern "debug_import_result_${clone}_*.json")
        if ($files.Count -gt 0) { $resultFile = $files[0] }
    }
    if (-not $resultFile) { Write-Status "No import-result after ${TimeoutSec}s (transfer may have stalled)" -Type error; exit 1 }
    Start-Sleep -Seconds 5   # let a few ticks pass — PROVES the platform does not fly off after arrival

    $resultData = Read-DebugFile -Instance $dstInstance -Container $dstContainer -Filename $resultFile
    if (-not $resultData) { Write-Status "Could not parse import-result $resultFile" -Type error; exit 1 }
    $valSuccess = Get-SafeProperty $resultData "validation_success"

    # Live reads on the destination landed platform.
    $landed = Get-LandedState $dstInstance $clone
    Write-Status "Landed state: $landed" -Type info
    $dstEnt = Get-EntityCount $dstInstance $clone

    # ---- B) validation passed ----
    if ($valSuccess -eq $true) {
        Write-TestResult -TestId "gw-validated" -TestName "Transfer completed + strict gate passed (validation_success=true)" -Status "passed"
    } else {
        Write-TestResult -TestId "gw-validated" -TestName "Transfer completed + strict gate passed" -Status "failed" -Message "validation_success=$valSuccess"
        $failed++
    }

    # ---- C) arrived PAUSED ----
    if ($landed -match 'PAUSED=true') {
        Write-TestResult -TestId "gw-paused" -TestName "Landed platform is PAUSED" -Status "passed"
    } else {
        Write-TestResult -TestId "gw-paused" -TestName "Landed platform is PAUSED" -Status "failed" -Message "expected PAUSED=true in: $landed — import-side gateway finalization did not pause (reverted?)"
        $failed++
    }

    # ---- D) parked AT the gateway ----
    if ($landed -match "LOC=$([regex]::Escape($Gateway))(\s|$)") {
        Write-TestResult -TestId "gw-at-gateway" -TestName "Landed platform parked AT '$Gateway'" -Status "passed"
    } else {
        Write-TestResult -TestId "gw-at-gateway" -TestName "Landed platform parked AT '$Gateway'" -Status "failed" -Message "expected LOC=$Gateway in: $landed"
        $failed++
    }

    # ---- E) gateway hop STRIPPED ----
    if ($landed -match 'HASGW=false') {
        Write-TestResult -TestId "gw-hop-stripped" -TestName "Gateway hop stripped from landed schedule (no surfexp_gateway_ record)" -Status "passed"
    } else {
        Write-TestResult -TestId "gw-hop-stripped" -TestName "Gateway hop stripped from landed schedule" -Status "failed" -Message "expected HASGW=false in: $landed — strip_gateway_records did not run"
        $failed++
    }

    # ---- F) physical entity fidelity (independent of the validator) ----
    $entTol = [Math]::Max(2, [int]($srcEnt * $EntityTolPct))
    $entDelta = [Math]::Abs($srcEnt - $dstEnt)
    if ($srcEnt -gt 0 -and $dstEnt -gt 0 -and $entDelta -le $entTol) {
        Write-TestResult -TestId "gw-entity-fidelity" -TestName "Dest entity count matches source physically (src=$srcEnt dst=$dstEnt, |Δ|=$entDelta <= $entTol)" -Status "passed"
    } else {
        Write-TestResult -TestId "gw-entity-fidelity" -TestName "Dest entity count matches source physically" -Status "failed" -Message "src=$srcEnt dst=$dstEnt |Δ|=$entDelta > tol=$entTol"
        $failed++
    }

    # ---- G) source deleted (two-phase commit) ----
    $srcGone = (Invoke-Lua -Instance $srcInstance -Code "local f=false for _,s in pairs(game.surfaces) do if s.platform and s.platform.name=='$clone' then f=true end end rcon.print('SRCGONE='..tostring(not f))" | Out-String)
    if ($srcGone -match 'SRCGONE=true') {
        Write-TestResult -TestId "gw-source-deleted" -TestName "Source platform deleted after successful transfer" -Status "passed"
    } else {
        Write-TestResult -TestId "gw-source-deleted" -TestName "Source platform deleted after successful transfer" -Status "failed" -Message "source '$clone' still present on $srcInstance"
        $failed++
    }

    Write-TestSummary -Passed ($TOTAL_ASSERTIONS - $failed) -Failed $failed
    if ($failed -gt 0) { exit 1 }
    exit 0
}
finally {
    Remove-PlatformSurfacesWhere -Instance $dstInstance -PredicateLua "p.name == '$clone'" | Out-Null
    Remove-PlatformSurfacesWhere -Instance $srcInstance -PredicateLua "p.name == '$clone'" | Out-Null
}
