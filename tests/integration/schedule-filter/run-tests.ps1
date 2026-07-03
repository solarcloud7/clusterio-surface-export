<#
.SYNOPSIS
    Schedule-filter self-test — pins WS1 unroutable-stop stripping + the never-strip-to-empty guard.

.DESCRIPTION
    On import onto a heterogeneous-mod destination, a schedule may carry stops for space-locations that do
    not exist here (phantom stops — the engine ACCEPTS an invalid station name, so they sit as dead stops).
    PlatformSchedule.filter_for_import strips them, but MUST NEVER strip the record list to empty (an empty
    schedule is engine-rejected, so a filter that empties it would INTRODUCE a fault). This suite runs the
    in-module self-test via the surface_export.schedule_selftest remote (`require` does not resolve from the
    /sc sandbox, so the unit checks run in module context and report back — same pattern as gateway-guard).

    Grounded on the LIVE prototype table: "nauvis" is a real space-location; a "surfexp_selftest_*" name is
    not. LITMUS (why this goes RED if the filter is weakened): remove the never-strip-to-empty guard, or
    strip routable/stationless records, or stop reporting dropped stops — any of those flips a self-test
    assertion and `failed` goes non-zero. Cluster-light: no clone or transfer, just the pure filter.

.PARAMETER SourceHost
    Host to query (default: auto-detect a host running the plugin; falls back to 1).
#>
param(
    [int]$SourceHost = 0
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "🗺  Schedule Filter (strip unroutable stops + never strip to empty)"

if ($SourceHost -eq 0) { $SourceHost = 1 }
$instance = "clusterio-host-$SourceHost-instance-1"
Write-Host "  Host: $SourceHost   Instance: $instance" -ForegroundColor Gray
Write-Host ""

$failed = 0

# In-module schedule-filter self-test (pure filter_for_import: strip, identity, never-empty, stationless).
$lua = "rcon.print(remote.call('surface_export', 'schedule_selftest_json'))"
$raw = (Invoke-Lua -Instance $instance -Code $lua | Out-String).Trim()
$result = $null
try { $result = $raw | ConvertFrom-Json } catch { }

if (-not $result) {
    Write-TestResult -TestId "schedule-selftest" -TestName "schedule-filter self-test runs" -Status "failed" -Message "No/invalid result from schedule_selftest_json: $raw"
    $failed++
} elseif ([int]$result.failed -gt 0 -or [int]$result.passed -le 0) {
    $detailMsgs = @()
    foreach ($d in $result.details) { if (-not $d.ok) { $detailMsgs += "$($d.name): $($d.msg)" } }
    Write-TestResult -TestId "schedule-selftest" -TestName "schedule-filter self-test passes" -Status "failed" -Message "passed=$($result.passed) failed=$($result.failed); $($detailMsgs -join '; ')"
    $failed++
} else {
    Write-TestResult -TestId "schedule-selftest" -TestName "schedule-filter self-test passes ($($result.passed) checks)" -Status "passed"
}

Write-TestSummary -Passed $(if ($failed -eq 0) { 1 } else { 0 }) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
