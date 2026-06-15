<#
.SYNOPSIS
    Agent-friendly one-shot RCON wrapper.

    The `rc11`/`rc21`/`rclist` aliases live in the user's INTERACTIVE PowerShell profile and
    are NOT available in the non-interactive shell an AI agent / CI runs in. Use this instead.
    Thin wrapper over Send-RCON in cluster-utils.ps1 (no new logic — just a standalone entry point).
.PARAMETER Target
    Either the "HI" shorthand (host digit + instance digit), e.g. 11 = host-1/instance-1,
    21 = host-2/instance-1 — or a full instance name like "clusterio-host-1-instance-1".
.PARAMETER Command
    The RCON command (quote it), e.g. "/list-platforms" or "/sc rcon.print(game.tick)".
.EXAMPLE
    ./tools/rcon.ps1 11 "/list-platforms"
.EXAMPLE
    ./tools/rcon.ps1 21 "/sc rcon.print(#game.surfaces)"
#>
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Target,
    [Parameter(Mandatory, Position = 1, ValueFromRemainingArguments)]
    [string[]]$Command
)

. "$PSScriptRoot\cluster-utils.ps1"

$cmd = $Command -join " "

if ($Target -match '^([12])([12])$') {
    # Digit 1 = host, digit 2 = instance. This cluster runs exactly one instance per host
    # (clusterio-host-N-instance-1), so the instance digit is informational only — resolution
    # is by host. If multi-instance is ever added, select on $Matches[2] here.
    $inst = Get-InstanceByHostNumber $Matches[1]
    if (-not $inst) { Write-Error "No instance for host $($Matches[1]). Is the cluster up?"; exit 1 }
    $name = $inst.Name
} else {
    $name = $Target
}

Send-RCON -InstanceName $name -Command $cmd
