<#
.SYNOPSIS
    Gateway-guard self-test — pins the passenger HARD BLOCK + protective route for gateway transfers.

.DESCRIPTION
    The on-arrival gateway chooser (Model A, WS3) must NEVER start a transfer while anyone is aboard a
    platform parked at a surfaceless gateway (there is nowhere to disembark — they would be orphaned).
    core/gateway-guard.lua is the pure gate; this suite runs its in-module self-test via the
    surface_export.gateway_selftest remote (`require` does not resolve from the /sc sandbox, so the unit
    checks run in module context and report back, same pattern as version-dispatch).

    The load-bearing assertions are not just "the decision is correct" but that the PROTECTIVE ROUTE RAN:
    on every block (passenger / disconnected-character / not-docked / in-flight) the transfer start_fn is
    NEVER reached, and on a passenger block the eject_fn DID run. A green safety test must prove the bad
    outcome did not happen AND that the guard, not luck, prevented it.

    LITMUS (why this goes RED if the guard is weakened): drop the passenger check, or let evaluate eject at
    render time, or let a blocked path fall through to start_fn — any of those flips a self-test assertion
    and `failed` goes non-zero. Cluster-light: no clone or transfer, just the pure gate.

.PARAMETER SourceHost
    Host to query (default: auto-detect a host running the plugin; falls back to 1).
#>
param(
    [int]$SourceHost = 0
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "🛡  Gateway Guard (passenger hard-block + protective route)"

if ($SourceHost -eq 0) { $SourceHost = 1 }
$instance = "clusterio-host-$SourceHost-instance-1"
Write-Host "  Host: $SourceHost   Instance: $instance" -ForegroundColor Gray
Write-Host ""

$failed = 0

# In-module gateway-guard self-test (pure gate: evaluate + guard_and_transfer with fakes/spies).
$lua = "rcon.print(remote.call('surface_export', 'gateway_selftest_json'))"
$raw = (Invoke-Lua -Instance $instance -Code $lua | Out-String).Trim()
$result = $null
try { $result = $raw | ConvertFrom-Json } catch { }

if (-not $result) {
    Write-TestResult -TestId "gateway-selftest" -TestName "gateway-guard self-test runs" -Status "failed" -Message "No/invalid result from gateway_selftest_json: $raw"
    $failed++
} elseif ([int]$result.failed -gt 0 -or [int]$result.passed -le 0) {
    $detailMsgs = @()
    foreach ($d in $result.details) { if (-not $d.ok) { $detailMsgs += "$($d.name): $($d.msg)" } }
    Write-TestResult -TestId "gateway-selftest" -TestName "gateway-guard self-test passes" -Status "failed" -Message "passed=$($result.passed) failed=$($result.failed); $($detailMsgs -join '; ')"
    $failed++
} else {
    Write-TestResult -TestId "gateway-selftest" -TestName "gateway-guard self-test passes ($($result.passed) checks)" -Status "passed"
}

Write-TestSummary -Passed $(if ($failed -eq 0) { 1 } else { 0 }) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
