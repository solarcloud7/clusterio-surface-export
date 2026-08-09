param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Target,
    [Parameter(Mandatory, Position = 1, ValueFromRemainingArguments)]
    [string[]]$Command
)

. "$PSScriptRoot\..\shared\cluster-utils.ps1"

$cmd = $Command -join " "

if ($Target -match '^([12])([12])$') {
    $inst = Get-InstanceByHostNumber $Matches[1]
    if (-not $inst) { Write-Error "No instance for host $($Matches[1]). Is the cluster up?"; exit 1 }
    $name = $inst.Name
} else {
    $name = $Target
}

Send-RCON -InstanceName $name -Command $cmd
