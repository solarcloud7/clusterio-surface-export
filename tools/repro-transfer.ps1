<#
.SYNOPSIS
    Deterministic end-to-end platform-transfer smoke driver for the LOCAL docker cluster.

    Clones a real source platform, transfers it across instances, waits for the destination's
    import-result signal, and reports PASS/FAIL with exit code 0/1. This is the driver the
    /repro-transfer skill points at — reproduce a transfer locally instead of parsing CI.

    Mirrors what CI's tests/integration/platform-roundtrip/run-tests.ps1 does, but self-contained
    and runnable against the running dev cluster with no CI env.
.PARAMETER SourceHost
    Host number holding the source platform (default 2 — the dev cluster's 'test' lives on host-2).
.PARAMETER SourcePlatform
    Name of the platform to clone as the transfer subject (default 'test', ~1359 entities, has a schedule).
.PARAMETER TimeoutSec
    Max seconds to wait for the destination import-result file (default 150).
.PARAMETER KeepResult
    Do not delete the transferred platform on the destination afterward.
.EXAMPLE
    ./tools/repro-transfer.ps1
.EXAMPLE
    ./tools/repro-transfer.ps1 -SourceHost 2 -SourcePlatform test -TimeoutSec 180
#>
[CmdletBinding()]
param(
    [ValidateSet("1", "2")] [string]$SourceHost = "2",
    [string]$SourcePlatform = "test",
    [int]$TimeoutSec = 150,
    [switch]$KeepResult
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\cluster-utils.ps1"

function Step($m) { Write-Host "  $m" -ForegroundColor Gray }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Die($m)  { Write-Host "  FAIL $m" -ForegroundColor Red; exit 1 }

$DestHost = if ($SourceHost -eq "1") { "2" } else { "1" }
$src = Get-InstanceByHostNumber $SourceHost
$dst = Get-InstanceByHostNumber $DestHost
if (-not $src -or -not $dst) { Die "could not discover both instances — is the cluster up? (docker ps)" }
$srcContainer = "surface-export-host-$SourceHost"
$dstContainer = "surface-export-host-$DestHost"
$dstScriptOut = "/clusterio/data/instances/$($dst.Name)/script-output"

# Unique per run. Get-Date is allowed in PowerShell (unlike workflow scripts).
$stamp = Get-Date -Format "HHmmss"
$clone = "reprotest_$stamp"

Write-Host "`n=== repro-transfer: $SourcePlatform on host-$SourceHost  ->  host-$DestHost ($clone) ===`n" -ForegroundColor Cyan

# 1. Clone the source platform (async import job on the source instance).
#    clone_platform keys the source on the unique per-force index. Resolve our known name -> index
#    here, failing loudly if it's ambiguous (names aren't unique). The index comes straight from the
#    pairs() loop, so it's already a Lua number passed unquoted to clone_platform.
Step "Cloning '$SourcePlatform' -> '$clone' on $($src.Name)..."
$cloneLua = "/sc local si,c=nil,0 for i,p in pairs(game.forces.player.platforms) do if p.name=='$SourcePlatform' then si=i; c=c+1 end end if c==0 then rcon.print('NOSRC') elseif c>1 then rcon.print('AMBIG '..c) else local ok,r=pcall(function() return remote.call('surface_export','clone_platform',si,'$clone') end) rcon.print(ok and (r.success and ('OK '..tostring(r.entity_count)) or ('ERR '..tostring(r.error))) or ('PCALL '..tostring(r))) end"
$cloneRes = (Send-RCON -InstanceName $src.Name -Command $cloneLua) -join " "
if ($cloneRes -match "NOSRC") { Die "source platform '$SourcePlatform' not found on $($src.Name)" }
if ($cloneRes -match "AMBIG\s+(\d+)") { Die "$($Matches[1]) platforms are named '$SourcePlatform' — ambiguous source; names aren't unique. Rename or pick a unique source." }
if ($cloneRes -notmatch "OK\s+(\d+)") { Die "clone failed: $cloneRes" }
$entityCount = $Matches[1]
Ok "clone queued ($entityCount entities)"

# 2. Wait for the async clone job to drain.
Step "Waiting for clone job to finish..."
$deadline = (Get-Date).AddSeconds(60)
do {
    Start-Sleep -Seconds 3
    $jobs = ((Send-RCON -InstanceName $src.Name -Command "/sc local n=0 for _ in pairs(storage.async_jobs or {}) do n=n+1 end rcon.print(n)") -join "").Trim()
} while ($jobs -ne "0" -and (Get-Date) -lt $deadline)
if ($jobs -ne "0") { Die "clone job did not finish within 60s (async_jobs=$jobs)" }
Ok "clone complete"

# 3. Resolve the clone's platform index on the source (per-force, 1-based).
$list = (Send-RCON -InstanceName $src.Name -Command "/list-platforms") -join "`n"
if ($list -notmatch "\[(\d+)\]\s+$([regex]::Escape($clone))\b") { Die "cloned platform '$clone' not found in /list-platforms" }
$idx = $Matches[1]
Ok "clone at index $idx"

# 4. Clear any stale result file, then trigger the transfer.
docker exec $dstContainer sh -c "rm -f $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null" 2>$null | Out-Null
Step "Triggering transfer (index $idx -> instance $($dst.Id))..."
$xfer = (Send-RCON -InstanceName $src.Name -Command "/transfer-platform $idx $($dst.Id)") -join "`n"
if ($xfer -match "Lock failed") { Die "transfer not initiated: $xfer" }
Ok "transfer initiated"

# 5. Poll the destination for the import-result signal (what the integration test waits on).
Step "Waiting for destination import-result (timeout ${TimeoutSec}s)..."
$start = Get-Date
$found = $false
while (-not $found -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Seconds 2
    $count = (docker exec $dstContainer sh -c "ls $dstScriptOut/debug_import_result_${clone}_*.json 2>/dev/null | wc -l" 2>$null).Trim()
    if ($count -match '^\d+$' -and [int]$count -gt 0) { $found = $true }
}
$elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds)
if (-not $found) { Die "no import-result on destination after ${TimeoutSec}s (transfer stalled — see ./tools/check-cluster-logs.ps1 -Grep 'sendRequest|validation|import_started')" }
Ok "import-result present (${elapsed}s)"

# 6. Confirm the platform landed on the destination (primary success signal) AND that the transfer
#    removed it from the source (game.delete_surface — Pitfall #19; a no-op would leave a duplicate).
$dstList = (Send-RCON -InstanceName $dst.Name -Command "/list-platforms") -join "`n"
$srcList = (Send-RCON -InstanceName $src.Name -Command "/list-platforms") -join "`n"
$onDest      = $dstList -match "\b$([regex]::Escape($clone))\b"
$goneFromSrc = -not ($srcList -match "\b$([regex]::Escape($clone))\b")
$valLine = (docker exec surface-export-controller sh -c "cat /clusterio/logs/cluster/cluster-*.log 2>/dev/null | grep -aoE '\""message\"":\""[^\""]*\""' | grep -E 'Validation: (SUCCESS|FAILED)' | tail -1" 2>$null)

Write-Host ""
if ($onDest) {
    Write-Host "  PASS  transfer completed — '$clone' is on $($dst.Name). $valLine" -ForegroundColor Green
    if (-not $goneFromSrc) { Write-Host "  WARN  source still has '$clone' — source delete did not take (check Pitfall #19)." -ForegroundColor DarkYellow }
    if (-not $KeepResult) {
        Step "Cleanup: deleting '$clone' on destination (game.delete_surface — Pitfall #19)..."
        $del = "/sc for _,s in pairs(game.surfaces) do if s.platform and s.platform.name=='$clone' then game.delete_surface(s) end end rcon.print('deleted')"
        Send-RCON -InstanceName $dst.Name -Command $del | Out-Null
        Ok "cleaned up"
    }
    exit 0
} else {
    Write-Host "  FAIL  import-result appeared but '$clone' is NOT on $($dst.Name) — validation likely failed/rolled back. $valLine" -ForegroundColor Red
    Write-Host "        Inspect: ./tools/check-cluster-logs.ps1 -Grep 'validation|rollback|Loss'" -ForegroundColor DarkYellow
    exit 1
}
