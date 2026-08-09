[CmdletBinding()]
param(
    [int[]]$Hosts = @(1, 2),
    [string[]]$Prefixes = @('reprotest_', 'integration-test-', 'entity-test-', 'engineinv-', 'destroyprobe', 'mytestclone', 'mytestname', 'evac-coverage-probe', 'hub-req-sections-', 'gwpark-probe'),
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

    $literals = $doomed | ForEach-Object { "p.name == '" + ($_ -replace "'", "\'") + "'" }
    $predicate = "(" + ($literals -join " or ") + ")"
    $res = Remove-PlatformSurfacesWhere -Instance $instance -PredicateLua $predicate -WhatIf:$DryRun
    if (-not $DryRun -and $res.names.Count -gt 0) {
        Step-Tick -Instance $instance -Ticks 5 | Out-Null
    }
    $verb = if ($DryRun) { "would remove" } else { "removed" }
    $removedTotal += $res.names.Count
    Write-Host ("    {0} {1}: {2}" -f $verb, $res.names.Count, ($res.names -join ", ")) -ForegroundColor Green
}

$groupsRemovedTotal = 0
foreach ($h in $Hosts) {
    $instance = "clusterio-host-$h-instance-1"
    $prefixLua = ($Prefixes | ForEach-Object { "'" + ($_ -replace "'", "\'") + "'" }) -join ","
    $deleteLua = if ($DryRun) { "" } else { "for _, name in ipairs(doomed) do game.forces.player.delete_logistic_group(name) end " }
    $code = "local prefixes={$prefixLua} local doomed={} " +
        "for _, name in pairs(game.forces.player.get_logistic_groups()) do " +
        "for _, prefix in ipairs(prefixes) do " +
        "if name:sub(1, #prefix) == prefix then doomed[#doomed+1]=name break end end end " +
        $deleteLua +
        "rcon.print(helpers.table_to_json({count=#doomed, names=doomed}))"
    $raw = (Invoke-Lua -Instance $instance -Code $code) -join " "
    $jsonMatch = [regex]::Match($raw, '\{.*\}')
    if (-not $jsonMatch.Success) { throw "group sweep on host-$h returned no JSON: $raw" }
    $groups = $jsonMatch.Value | ConvertFrom-Json
    if ($groups.count -gt 0) {
        $names = @($groups.names)
        $verb = if ($DryRun) { "would remove" } else { "removed" }
        $groupsRemovedTotal += $groups.count
        Write-Host ("  host-{0} logistic groups: {1} {2}: {3}" -f $h, $verb, $groups.count, ($names -join ", ")) -ForegroundColor Green
    }
}

Write-Host ""
$verb = if ($DryRun) { "Would remove" } else { "Removed" }
Write-Host ("  {0} {1} platform(s) and {2} logistic group(s) across host(s) {3}." -f $verb, $removedTotal, $groupsRemovedTotal, ($Hosts -join ', ')) -ForegroundColor Cyan
if ($unknownTotal -and -not $IncludeUnknown) {
    Write-Host ("  {0} UNKNOWN platform(s) left alone — re-run with -IncludeUnknown to sweep them." -f $unknownTotal) -ForegroundColor Red
}
if ($strandedTotal) {
    Write-Host ("  {0} surfaceless platform(s) cannot be removed by any API; they clear on save reload." -f $strandedTotal) -ForegroundColor Red
}
Write-Host ""
