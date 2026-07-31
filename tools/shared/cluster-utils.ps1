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
    $raw = docker exec surface-export-controller npx clusterioctl --log-level error --config $script:ControlConfig instance list 2>&1

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

<#
.SYNOPSIS
    Read the controller's transaction-log store. The ONE path for this purpose.

.DESCRIPTION
    list-transaction-logs.ps1 and get-transaction-log.ps1 each carried their own copy of this
    docker exec, and the copies had ALREADY DRIFTED: one appended `2>&1`, while the other carried a
    comment explaining that `2>&1` corrupts the JSON because unrelated Docker warnings on stderr get
    interleaved into the payload. One script documented the bug the other still had, and nothing
    could tell you which was right. Hence one implementation.

    Returns the parsed log array, an empty array when the store is present but empty, or $null when
    the store does not exist yet (the caller decides how to phrase that).

.PARAMETER Container
    Controller container name. Defaults to this cluster's controller.
#>
function Get-TransactionLogStore {
    param(
        [string]$Container = "surface-export-controller",
        [string]$StorePath = "/clusterio/data/database/surface_export_transaction_logs.json"
    )

    # Deliberately NO 2>&1 — stderr must stay OUT of the JSON. The exit code is the success signal.
    $raw = docker exec $Container cat $StorePath
    if ($LASTEXITCODE -ne 0) { return $null }

    $json = ($raw -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($json)) { return @() }

    # Keep the friendly parse diagnostic that only ONE of the two former copies had — a raw
    # ConvertFrom-Json failure here reads as an opaque PowerShell error about the store's contents.
    try {
        return $json | ConvertFrom-Json
    } catch {
        Write-Host "Failed to parse the transaction log store ($StorePath). Content preview:" -ForegroundColor Red
        Write-Host ($json.Substring(0, [Math]::Min(400, $json.Length))) -ForegroundColor Gray
        throw
    }
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
    # Do NOT swallow stderr. This used to end in `2>$null` with no exit-code check, which made
    # instance-down, a bad token, an RCON timeout, and a genuinely EMPTY Lua reply all look
    # identical: an empty string. Callers then reported "no platforms" for a dead cluster.
    # A transport failure is now LOUD; an empty reply from a healthy instance still returns empty,
    # which is the one case callers legitimately need to distinguish.
    $out = docker exec surface-export-controller npx clusterioctl --log-level error `
        instance send-rcon $InstanceName $Command --config $script:ControlConfig 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Send-RCON failed on '$InstanceName' (exit $LASTEXITCODE): $(($out | Out-String).Trim())"
    }
    return $out
}
