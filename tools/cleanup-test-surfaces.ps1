<#
.SYNOPSIS
    Sweep leftover throwaway test/clone platform surfaces from the dev cluster.

.DESCRIPTION
    Routine test runs and repro-transfer create disposable platform clones
    (reprotest_*, integration-test-*, entity-test-*, engineinv-*, *probe*, mytestclone…). This removes
    them via game.delete_surface (platform.destroy() is a no-op — Pitfall #19), reusing TestBase's
    Remove-PlatformSurfacesWhere so the deletion logic AND the protected-fixtures list
    ($script:ProtectedFixtures = test/spikedoom08/ptB, never deleted) live in exactly one place.

.PARAMETER Hosts
    Host numbers to sweep (default: 1, 2).

.PARAMETER Prefixes
    Platform-name prefixes treated as throwaway. NB: deliberately NOT 'test-' — that would also match a
    real user platform like 'test-mainbase'; the suites' clones use the specific prefixes below.

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
    [string[]]$Prefixes = @('reprotest_', 'integration-test-', 'entity-test-', 'engineinv-', 'destroyprobe', 'mytestclone', 'mytestname'),
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "..\tests\integration\lib\TestBase.psm1") -Force

# Build a Lua predicate: platform name starts with any of the throwaway prefixes. The protected-fixture
# guard lives inside Remove-PlatformSurfacesWhere, so real fixtures are excluded regardless of prefixes.
$checks = $Prefixes | ForEach-Object {
    $pre = $_ -replace "'", ""
    "p.name:sub(1, $($pre.Length)) == '$pre'"
}
$predicate = "(" + ($checks -join " or ") + ")"

$mode = if ($DryRun) { 'dry-run' } else { 'delete' }
Write-Host "`n=== cleanup-test-surfaces ($mode; protected fixtures are never touched) ===`n" -ForegroundColor Cyan
$total = 0
foreach ($h in $Hosts) {
    $instance = "clusterio-host-$h-instance-1"
    $res = Remove-PlatformSurfacesWhere -Instance $instance -PredicateLua $predicate -WhatIf:$DryRun
    if (-not $DryRun -and $res.names.Count -gt 0) {
        # game.delete_surface is deferred to end of tick — step so the removal finalizes.
        Step-Tick -Instance $instance -Ticks 5 | Out-Null
    }
    $suffix = if ($res.names.Count) { ": " + ($res.names -join ", ") } else { "" }
    $verb = if ($DryRun) { "would remove" } else { "removed" }
    $total += $res.names.Count
    Write-Host ("  host-{0}: {1} {2} surface(s){3}" -f $h, $verb, $res.names.Count, $suffix) -ForegroundColor $(if ($res.names.Count) { 'Green' } else { 'Gray' })
}
Write-Host ""
Write-Host ("  {0} {1} throwaway surface(s) across host(s) {2}." -f $(if ($DryRun) { 'Would remove' } else { 'Removed' }), $total, ($Hosts -join ', ')) -ForegroundColor Cyan
