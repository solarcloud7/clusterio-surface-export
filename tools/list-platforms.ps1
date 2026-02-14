<#
.SYNOPSIS
    Lists platforms on one or both Factorio instances.
.PARAMETER Instance
    Instance number (1 or 2). If omitted, lists both.
#>
param(
    [ValidateSet("1","2","")]
    [string]$Instance = ""
)

. "$PSScriptRoot\cluster-utils.ps1"

if ($Instance -eq "" -or $Instance -eq "1") {
    $Inst1 = Get-InstanceByHostNumber "1"
    Write-Host "=== Instance 1 ($($Inst1.Name)) ===" -ForegroundColor Cyan
    Send-RCON -InstanceName $Inst1.Name -Command "/list-platforms"
}

if ($Instance -eq "" -or $Instance -eq "2") {
    $Inst2 = Get-InstanceByHostNumber "2"
    Write-Host "=== Instance 2 ($($Inst2.Name)) ===" -ForegroundColor Cyan
    Send-RCON -InstanceName $Inst2.Name -Command "/list-platforms"
}
