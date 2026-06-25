<#
.SYNOPSIS
    Sweep leftover throwaway test/clone platform surfaces from the dev cluster.

.DESCRIPTION
    Routine test runs and repro-transfer create disposable platform clones
    (reprotest_*, integration-test-*, entity-test-*, test-<timestamp>, *probe*, mytestclone…).
    `platform.destroy()` is a no-op at our pinned Factorio (Pitfall #19), so this removes them via
    `game.delete_surface` — the only reliable path — on every host.

    Protected fixtures (test, spikedoom08, ptB) are NEVER deleted, regardless of prefix matching.

.PARAMETER Hosts
    Host numbers to sweep (default: 1, 2).

.PARAMETER Prefixes
    Platform-name prefixes treated as throwaway (default covers all the test/clone conventions).

.PARAMETER DryRun
    List what WOULD be deleted without deleting anything.

.EXAMPLE
    ./tools/cleanup-test-surfaces.ps1
.EXAMPLE
    ./tools/cleanup-test-surfaces.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [int[]]$Hosts = @(1, 2),
    # NB: deliberately NOT 'test-' — that would also match a real user platform like 'test-mainbase'
    # (the protected set only exact-matches 'test'). Suite clones use the specific prefixes below.
    [string[]]$Prefixes = @('reprotest_', 'integration-test-', 'entity-test-', 'engineinv-', 'destroyprobe', 'mytestclone', 'mytestname'),
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\cluster-utils.ps1"

# Fixtures that must never be deleted, regardless of prefix matching.
$protected = @('test', 'spikedoom08', 'ptB')

$prefixLua    = ($Prefixes  | ForEach-Object { "'" + ($_ -replace "'", "") + "'" }) -join ","
$protectedLua = ($protected | ForEach-Object { "['" + $_ + "']=true" }) -join ","
$mode = if ($DryRun) { 'dry' } else { 'delete' }

# A platform is a throwaway if its name starts with one of $Prefixes AND is not protected.
$lua = @"
/sc local prefixes={$prefixLua} local protected={$protectedLua} local mode='$mode'
local hits={}
for _,s in pairs(game.surfaces) do
  local p=s.platform
  if p and p.valid and not protected[p.name] then
    for _,pre in ipairs(prefixes) do
      if p.name:sub(1,#pre)==pre then
        table.insert(hits, p.name)
        if mode=='delete' and s.valid then game.delete_surface(s) end
        break
      end
    end
  end
end
rcon.print((mode=='delete' and 'DELETED ' or 'WOULDDELETE ')..#hits..(#hits>0 and (': '..table.concat(hits, ', ')) or ''))
"@

Write-Host "`n=== cleanup-test-surfaces ($mode; protected: $($protected -join ', ')) ===`n" -ForegroundColor Cyan
$total = 0
foreach ($h in $Hosts) {
    $instance = "clusterio-host-$h-instance-1"
    $res = (Send-RCON -InstanceName $instance -Command $lua) -join " "
    if (-not $DryRun) {
        # game.delete_surface is deferred to end of tick — step so the removal finalizes.
        Send-RCON -InstanceName $instance -Command "/step-tick 5" | Out-Null
    }
    if ($res -match '(DELETED|WOULDDELETE)\s+(\d+)') { $total += [int]$Matches[2] }
    Write-Host ("  host-{0}: {1}" -f $h, $res.Trim()) -ForegroundColor $(if ($res -match '\s0(\s|$)') { 'Gray' } else { 'Green' })
}
Write-Host ""
Write-Host ("  {0} {1} throwaway surface(s) across host(s) {2}." -f $(if ($DryRun) { 'Would remove' } else { 'Removed' }), $total, ($Hosts -join ', ')) -ForegroundColor Cyan
