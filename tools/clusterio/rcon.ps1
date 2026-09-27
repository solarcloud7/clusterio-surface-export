param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Target,
    [Parameter(Mandatory, Position = 1, ValueFromRemainingArguments)]
    [string[]]$Command
)

. "$PSScriptRoot\..\shared\cluster-utils.ps1"

$cmd = $Command -join " "

if ($Target -match '^([12])([12])$') {
    $name = (Get-InstanceByHostNumber $Matches[1]).Id
} else {
    $name = $Target
}

Send-RCON -InstanceName $name -Command $cmd
