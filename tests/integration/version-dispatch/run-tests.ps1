<#
.SYNOPSIS
    Version-dispatch layer checks — pins the version-compat.lua behavior export/import relies on.

.DESCRIPTION
    The mod dispatches version-sensitive API behavior (belt insert_at order, platform teardown, ...)
    through utils/version-compat.lua, keyed on the engine version. This suite:
      1. Audits the running Factorio version (must be the one the dispatch profiles target).
      2. Runs the in-module version-compat self-test (parse/runtime_bucket/profile resolution/migrate)
         via the surface_export.version_selftest remote — `require` does not resolve from the /sc
         sandbox, so the pure-function unit checks run in module context and report back.
    Cluster-light: no clone or transfer. A drift-detector for the dispatch seam itself.

.PARAMETER SourceHost
    Host to query (default: auto-detect a host running the plugin; falls back to 1).
#>
param(
    [int]$SourceHost = 0
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "🔀 Version Dispatch Layer"

if ($SourceHost -eq 0) { $SourceHost = 1 }
$instance = "clusterio-host-$SourceHost-instance-1"
Write-Host "  Host: $SourceHost   Instance: $instance" -ForegroundColor Gray
Write-Host ""

$failed = 0

# 1. Version audit — fail loudly if the engine isn't the version the dispatch profiles target.
try {
    $detected = Assert-FactorioVersion -Instance $instance
    Write-TestResult -TestId "version-audit" -TestName "Engine version matches the dispatch target" -Status "passed"
} catch {
    Write-TestResult -TestId "version-audit" -TestName "Engine version matches the dispatch target" -Status "failed" -Message $_.Exception.Message
    $failed++
}

# 2. In-module version-compat self-test (pure functions: parse/bucket/resolve/migrate).
$lua = "rcon.print(remote.call('surface_export', 'version_selftest_json'))"
$raw = (Invoke-Lua -Instance $instance -Code $lua | Out-String).Trim()
$result = $null
try { $result = $raw | ConvertFrom-Json } catch { }

if (-not $result) {
    Write-TestResult -TestId "version-selftest" -TestName "version-compat self-test runs" -Status "failed" -Message "No/invalid result from version_selftest_json: $raw"
    $failed++
} elseif ([int]$result.failed -gt 0 -or [int]$result.passed -le 0) {
    $detailMsgs = @()
    foreach ($d in $result.details) { if (-not $d.ok) { $detailMsgs += "$($d.name): $($d.msg)" } }
    Write-TestResult -TestId "version-selftest" -TestName "version-compat self-test passes" -Status "failed" -Message "passed=$($result.passed) failed=$($result.failed); $($detailMsgs -join '; ')"
    $failed++
} else {
    Write-TestResult -TestId "version-selftest" -TestName "version-compat self-test passes ($($result.passed) checks)" -Status "passed"
}

Write-TestSummary -Passed $(if ($failed -eq 0) { 2 } else { 2 - $failed }) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
