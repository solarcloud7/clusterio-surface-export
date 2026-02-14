<#
.SYNOPSIS
    Shows fluid restoration and loss analysis logs from a Factorio instance.
.PARAMETER Instance
    Instance number (1 or 2). Default: 2 (typical import destination).
.PARAMETER Lines
    Number of matching lines to show. Default: 50.
.PARAMETER Pattern
    Log pattern to grep for. Default: key import/transfer patterns.
#>
param(
    [ValidateSet("1","2")]
    [string]$Instance = "2",

    [int]$Lines = 50,

    [ValidateSet("all","fluids","loss","import","transfer")]
    [string]$Pattern = "all"
)

$Patterns = @{
    "all"      = "Loss Analysis|Fluid Restore|fluid restoration|Post-activation|TransferValidation|Import\]"
    "fluids"   = "Fluid Restore|fluid restoration|Post-activation|segment|high-temp|RECONCILED"
    "loss"     = "Loss Analysis"
    "import"   = "Import\]|Validation\]|Fluid Restore"
    "transfer" = "transfer|Transfer|export|Export"
}

$GrepPattern = $Patterns[$Pattern]
$HostContainer = "surface-export-host-$Instance"
$LogPath = "/clusterio/data/instances/clusterio-host-$Instance-instance-1/factorio-current.log"

Write-Host "=== Instance $Instance Factorio Logs ($Pattern) ===" -ForegroundColor Cyan
Write-Host "Container: $HostContainer" -ForegroundColor DarkGray
Write-Host "Pattern: $GrepPattern" -ForegroundColor DarkGray
Write-Host ""

docker exec $HostContainer grep -E $GrepPattern $LogPath | Select-Object -Last $Lines
