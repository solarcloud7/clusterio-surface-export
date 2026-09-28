# requires: the surface-export-controller container; for a host shorthand, clusterioctl instance list naming
#           the instance assigned to that host
# produces: one instance's reply to one RCON command. Target is an instance name or id, or the host shorthand
#           <host><slot> (11 = host 1, 21 = host 2, 31 = host 3); the trailing slot is the instance's place on
#           the host and must be 1, because each host runs one instance. A numeric target of two or three digits is
#           always read as the shorthand; a longer number is an instance id
# does not: start a stopped instance, retry a failed command, accept a slot other than 1, or take a two- or
#           three-digit instance id
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Target,
    [Parameter(Mandatory, Position = 1, ValueFromRemainingArguments)]
    [string[]]$Command
)

. "$PSScriptRoot\..\shared\cluster-utils.ps1"

$cmd = $Command -join " "

if ($Target -match '^([1-9]\d?)(\d)$') {
    if ($Matches[2] -ne '1') {
        throw "Target '$Target' names slot $($Matches[2]) on host $($Matches[1]); each host runs one instance, so use '$($Matches[1])1' or the instance name or id."
    }
    $name = (Get-InstanceByHostNumber $Matches[1]).Id
} else {
    $name = $Target
}

Send-RCON -InstanceName $name -Command $cmd
