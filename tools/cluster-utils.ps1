<#
.SYNOPSIS
    Shared utility functions for cluster management scripts.
    Dot-source this file to use: . "$PSScriptRoot\cluster-utils.ps1"
#>

$script:ControlConfig = "/clusterio/tokens/config-control.json"

function ConvertTo-LuaLiteral {
    <#
    .SYNOPSIS
        Escape a string for safe embedding inside a Lua single-quoted '...' literal.
    .DESCRIPTION
        RCON snippets interpolate values (e.g. platform names) into Lua source. Send-RCON passes the
        command to `docker exec` as a single argv element — PowerShell native invocation, no shell layer —
        so the ONLY quoting that matters is Lua's. Escape backslash first, then the single quote, so a
        name like "Bob's Platform" can't break the literal (or inject Lua). A no-op for ordinary names.
    #>
    param([Parameter(Mandatory=$true)][AllowEmptyString()][string]$Value)
    return $Value.Replace('\', '\\').Replace("'", "\'")
}

function Get-InstanceList {
    <#
    .SYNOPSIS
        Dynamically discovers instance names and IDs from the cluster.
    .OUTPUTS
        Array of objects with Name, Id, Host, GamePort, Status properties.
    #>
    $raw = docker exec surface-export-controller npx clusterioctl --log-level error --config=$script:ControlConfig instance list 2>&1

    # Skip header lines (first 2: column headers + separator)
    $lines = ($raw -split "`n") | Select-Object -Skip 2 | Where-Object { $_.Trim() -ne "" }

    $instances = @()
    foreach ($line in $lines) {
        $parts = $line -split '\|' | ForEach-Object { $_.Trim() }
        if ($parts.Count -ge 2) {
            $instances += [PSCustomObject]@{
                Name     = $parts[0]
                Id       = $parts[1]
                Host     = $parts[2]
                GamePort = $parts[3]
                Status   = $parts[4]
            }
        }
    }
    return $instances
}

function Get-InstanceByHostNumber {
    <#
    .SYNOPSIS
        Returns instance info for a given host number (1 or 2).
    .PARAMETER HostNumber
        The host number (1 or 2).
    #>
    param([string]$HostNumber)

    $all = Get-InstanceList
    $match = $all | Where-Object { $_.Name -match "host-$HostNumber" }
    if (-not $match) {
        Write-Error "No instance found for host number $HostNumber"
        return $null
    }
    return $match
}

function Send-RCON {
    <#
    .SYNOPSIS
        Sends an RCON command to a named instance.
    #>
    param(
        [string]$InstanceName,
        [string]$Command
    )
    docker exec surface-export-controller npx clusterioctl --log-level error instance send-rcon $InstanceName $Command --config $script:ControlConfig 2>$null
}
