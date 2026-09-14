# requires: the development cluster and a uniquely named source fixture
# produces: the shared transfer probe verdict and guarded cleanup
# does not: maintain a separate transfer or cleanup implementation
[CmdletBinding()]
param(
    [ValidateSet("1", "2")] [string]$SourceHost = "2",
    [string]$SourcePlatform = "test",
    [ValidateRange(1, 3600)] [int]$TimeoutSec = 150,
    [switch]$KeepResult
)

$ErrorActionPreference = "Stop"
$direction = if ($SourceHost -eq "1") { "1to2" } else { "2to1" }
$probeArgs = @("$PSScriptRoot/probe-transfer.mjs", "--source-platform", $SourcePlatform,
    "--direction", $direction, "--timeout-ms", [string]($TimeoutSec * 1000))
if ($KeepResult) { $probeArgs += "--keep" }
& node @probeArgs
exit $LASTEXITCODE
