<#
.SYNOPSIS
    Audit and sweep leftover platforms on the dev cluster.

.DESCRIPTION
    Inventories EVERY platform on each host and classifies it, rather than only matching a
    hand-maintained prefix list:

      PROTECTED  a fixture from TestBase's protected list — never deleted, never proposed
      THROWAWAY  matches a known disposable prefix (reprotest_, integration-test-, …) — swept
      UNKNOWN    neither — REPORTED LOUDLY, and only swept with -IncludeUnknown

    Why the UNKNOWN class exists: the prefix list only catches leftovers whose author remembered
    to name them for it. A probe named outside the list used to be invisible, so the sweep printed
    "clean" while the leak sat there. Classification makes an unrecognized platform a finding
    instead of a silence — and never deletes it without an explicit switch, because "unrecognized"
    also describes a real platform someone is building on.

    Surfaceless platforms (starter pack never materialized) are reported as UNREMOVABLE. That is
    not a tool limitation: game.delete_surface has nothing to delete, and platform.destroy() is
    inert — measured on 2.1.11 across the no-arg, (0) and (60) forms, matching what
    GameUtils.delete_platform already documents. They clear when the instance reloads a save.

    Deletion goes through TestBase's Remove-PlatformSurfacesWhere, so the removal primitive and the
    protected-fixtures list stay in exactly one place.

.PARAMETER Hosts
    Host numbers to sweep (default: 1, 2).

.PARAMETER Prefixes
    Platform-name prefixes treated as throwaway. NB: deliberately NOT 'test-' — that would also match a
    real user platform like 'test-mainbase'; the suites' clones use the specific prefixes below.

.PARAMETER IncludeUnknown
    Also delete platforms that match no known prefix (protected fixtures are still excluded).
    Read the audit output first — this is the switch that can remove someone's work.

.PARAMETER DryRun
    Report the classification without deleting anything.

.EXAMPLE
    ./tools/tests/cleanup-test-surfaces.ps1 -DryRun
.EXAMPLE
    ./tools/tests/cleanup-test-surfaces.ps1
.EXAMPLE
    ./tools/tests/cleanup-test-surfaces.ps1 -DryRun -IncludeUnknown
#>
[CmdletBinding()]
param(
    [int[]]$Hosts = @(1, 2),
    [string[]]$Prefixes = @('reprotest_', 'integration-test-', 'entity-test-', 'engineinv-', 'destroyprobe', 'mytestclone', 'mytestname'),
    [switch]$IncludeUnknown,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "..\..\tests\integration\lib\TestBase.psm1") -Force

$protected = Get-ProtectedFixtures
$mode = if ($DryRun) { 'audit' } else { 'sweep' }
Write-Host "`n=== cleanup-test-surfaces ($mode; protected fixtures are never touched) ===`n" -ForegroundColor Cyan

$removedTotal = 0
$unknownTotal = 0
$strandedTotal = 0

foreach ($h in $Hosts) {
    $instance = "clusterio-host-$h-instance-1"
    $inventory = Get-PlatformInventory -Instance $instance

    Write-Host ("  host-{0} — {1} platform(s)" -f $h, @($inventory).Count) -ForegroundColor White
    if (-not @($inventory).Count) { Write-Host "    (none)" -ForegroundColor DarkGray; continue }

    $doomed = @()
    foreach ($p in $inventory) {
        $class =
            if ($protected -contains $p.name) { 'PROTECTED' }
            elseif ($Prefixes | Where-Object { $p.name.StartsWith($_) }) { 'THROWAWAY' }
            else { 'UNKNOWN' }

        $notes = @()
        if (-not $p.hasSurface) { $notes += 'NO SURFACE — unremovable, clears on save reload'; $strandedTotal++ }
        if (-not $p.hasHub) { $notes += 'no hub (not transferable)' }
        $note = if ($notes.Count) { "  [" + ($notes -join '; ') + "]" } else { "" }

        $colour = switch ($class) { 'PROTECTED' { 'DarkGray' } 'THROWAWAY' { 'Yellow' } default { 'Red' } }
        Write-Host ("    {0,-10} {1,-34} force={2,-8} entities={3}{4}" -f $class, $p.name, $p.force, $p.entities, $note) -ForegroundColor $colour

        if ($class -eq 'UNKNOWN') { $unknownTotal++ }
        if ($p.hasSurface -and ($class -eq 'THROWAWAY' -or ($class -eq 'UNKNOWN' -and $IncludeUnknown))) {
            $doomed += $p.name
        }
    }

    if (-not $doomed.Count) { Write-Host "    nothing to sweep on this host" -ForegroundColor DarkGray; continue }

    # Delete by EXACT name (built from the audit above) rather than re-matching prefixes, so what gets
    # removed is exactly what was just printed.
    $literals = $doomed | ForEach-Object { "p.name == '" + ($_ -replace "'", "\'") + "'" }
    $predicate = "(" + ($literals -join " or ") + ")"
    $res = Remove-PlatformSurfacesWhere -Instance $instance -PredicateLua $predicate -WhatIf:$DryRun
    if (-not $DryRun -and $res.names.Count -gt 0) {
        # game.delete_surface is deferred to end of tick — step so the removal finalizes.
        Step-Tick -Instance $instance -Ticks 5 | Out-Null
    }
    $verb = if ($DryRun) { "would remove" } else { "removed" }
    $removedTotal += $res.names.Count
    Write-Host ("    {0} {1}: {2}" -f $verb, $res.names.Count, ($res.names -join ", ")) -ForegroundColor Green
}

Write-Host ""
$verb = if ($DryRun) { "Would remove" } else { "Removed" }
Write-Host ("  {0} {1} platform(s) across host(s) {2}." -f $verb, $removedTotal, ($Hosts -join ', ')) -ForegroundColor Cyan
if ($unknownTotal -and -not $IncludeUnknown) {
    Write-Host ("  {0} UNKNOWN platform(s) left alone — re-run with -IncludeUnknown to sweep them." -f $unknownTotal) -ForegroundColor Red
}
if ($strandedTotal) {
    Write-Host ("  {0} surfaceless platform(s) cannot be removed by any API; they clear on save reload." -f $strandedTotal) -ForegroundColor Red
}
Write-Host ""
