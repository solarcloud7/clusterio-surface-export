# requires: running development cluster and the selected platform index
# produces: exact transfer completion with a released destination identity, or a nonzero exit
# does not: delete fixtures or replay uncertain requests
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [ValidateRange(1, 2147483647)] [int]$PlatformIndex,
    [Parameter(Mandatory=$true)] [ValidateSet("1to2", "2to1")] [string]$Direction,
    [ValidateRange(1, 3600)] [int]$TimeoutSec = 300
)
$ErrorActionPreference = "Stop"
& node "$PSScriptRoot/transfer-platform.mjs" --platform $PlatformIndex --direction $Direction --timeout-ms ($TimeoutSec * 1000)
exit $LASTEXITCODE
