<#
.SYNOPSIS
    Transfers a platform between Factorio instances.
.PARAMETER PlatformIndex
    The platform index to transfer (use list-platforms.ps1 to find it).
.PARAMETER Direction
    Transfer direction: "1to2" or "2to1".
#>
param(
    [Parameter(Mandatory=$true)]
    [int]$PlatformIndex,

    [Parameter(Mandatory=$true)]
    [ValidateSet("1to2","2to1")]
    [string]$Direction
)

. "$PSScriptRoot\cluster-utils.ps1"

# Discover instance names and IDs dynamically
$Inst1 = Get-InstanceByHostNumber "1"
$Inst2 = Get-InstanceByHostNumber "2"
if (-not $Inst1 -or -not $Inst2) {
    Write-Error "Could not discover both instances. Is the cluster running?"
    exit 1
}

if ($Direction -eq "1to2") {
    $SourceInstance = $Inst1.Name
    $DestId = $Inst2.Id
    Write-Host "Transferring platform [$PlatformIndex] from $($Inst1.Name) → $($Inst2.Name)..." -ForegroundColor Cyan
} else {
    $SourceInstance = $Inst2.Name
    $DestId = $Inst1.Id
    Write-Host "Transferring platform [$PlatformIndex] from $($Inst2.Name) → $($Inst1.Name)..." -ForegroundColor Cyan
}

Send-RCON -InstanceName $SourceInstance -Command "/transfer-platform $PlatformIndex $DestId"

Write-Host ""
Write-Host "Waiting for transfer to complete..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

Write-Host ""
Write-Host "=== Post-Transfer Platform State ===" -ForegroundColor Green
& "$PSScriptRoot\list-platforms.ps1"
