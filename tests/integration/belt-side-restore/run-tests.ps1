<#
.SYNOPSIS
    Production side-scoped belt restore self-test.

.DESCRIPTION
    Runs the production BeltRestoration.restore_side_groups helper against deterministic fake transport
    lines. The fixture aliases one physical line through two windows, leaks the first legendary insertion
    onto a neighbour that already holds normal items, then accepts the retry on the intended side.

    RED-ON-REVERT: a per-handle scalar census double-counts the accepted insertion; quality-blind leak
    rollback removes a normal plate and leaves the leaked legendary plate behind.
#>
param([int]$SourceHost = 1)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "Side-scoped belt restore (aliased windows + mixed-quality leak)"
$instance = "clusterio-host-$SourceHost-instance-1"
$raw = (Invoke-Lua -Instance $instance -Code "rcon.print(remote.call('surface_export', 'belt_side_restore_selftest_json'))" | Out-String).Trim()
$result = $null
try { $result = $raw | ConvertFrom-Json } catch { }

$failed = 0
if (-not $result) {
    Write-TestResult -TestId "belt-side-restore-selftest" -TestName "self-test runs" -Status "failed" -Message "No/invalid result: $raw"
    $failed++
} elseif ([int]$result.failed -gt 0 -or [int]$result.passed -le 0) {
    $messages = @($result.details | Where-Object { -not $_.ok } | ForEach-Object { "$($_.name): $($_.msg)" })
    Write-TestResult -TestId "belt-side-restore-selftest" -TestName "production helper passes" -Status "failed" -Message ($messages -join "; ")
    $failed++
} else {
    Write-TestResult -TestId "belt-side-restore-selftest" -TestName "production helper passes ($($result.passed) checks)" -Status "passed"
}

Write-TestSummary -Passed $(if ($failed -eq 0) { 1 } else { 0 }) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
