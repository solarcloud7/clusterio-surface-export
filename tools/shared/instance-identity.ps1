# requires: clusterioctl `instance list` output (name | id | assignedHost | status columns); for data
#           directories, the output of $InstanceDirsScript run in the instance's host container
# produces: parsed instance rows, the one instance assigned to a host number, and the host data
#           directory whose instance.json carries a given instance id
# does not: run docker, rename or assign instances, choose between several instances on one host, or
#           treat seed or data directory names as live identity

$script:InstanceDirsScript = 'for f in /clusterio/data/instances/*/instance.json; do [ -f "$f" ] && printf ''%s\t'' "$f" && tr -d ''\n\r'' < "$f" && echo; done'

function ConvertFrom-InstanceList {
    param([Parameter(Mandatory)][AllowEmptyString()][AllowEmptyCollection()][string[]]$Raw)

    $lines = @(($Raw -join "`n") -split "\r?\n" | Where-Object { $_.Contains('|') })
    $header = if ($lines.Count) { @($lines[0] -split '\|' | ForEach-Object { $_.Trim() }) } else { @() }
    $missing = @('name', 'id', 'assignedHost', 'status') | Where-Object { $_ -cnotin $header }
    if ($missing) {
        $text = ($Raw -join "`n").Trim()
        throw "clusterioctl instance list has no $($missing -join '/') column; raw output: $(if ($text) { $text.Substring(0, [Math]::Min(500, $text.Length)) } else { '(empty)' })"
    }
    $instances = @()
    foreach ($line in ($lines | Select-Object -Skip 1)) {
        if ($line -match '^[-\s|]+$') { continue }
        $parts = @($line -split '\|' | ForEach-Object { $_.Trim() })
        $cell = { param($column) $index = [Array]::IndexOf($header, $column); if ($index -lt $parts.Count) { $parts[$index] } else { '' } }
        if (-not (& $cell 'name')) { continue }
        $instances += [PSCustomObject]@{
            Name     = & $cell 'name'
            Id       = & $cell 'id'
            Host     = & $cell 'assignedHost'
            GamePort = & $cell 'gamePort'
            Status   = & $cell 'status'
        }
    }
    return $instances
}

function Select-InstanceForHost {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Instances,
        [Parameter(Mandatory)][string]$HostNumber
    )
    $match = @($Instances | Where-Object { $_.Host -eq $HostNumber })
    if ($match.Count -ne 1) {
        $known = ($Instances | ForEach-Object { "$($_.Name) (id $($_.Id), host $($_.Host))" }) -join ', '
        throw "Host $HostNumber has $($match.Count) assigned instance(s); expected exactly one. Instances: $(if ($known) { $known } else { 'none' })."
    }
    return $match[0]
}

function Select-InstanceDataDir {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][AllowEmptyCollection()][string[]]$Raw,
        [Parameter(Mandatory)][string]$InstanceId,
        [Parameter(Mandatory)][string]$Container
    )
    $dirs = @($Raw | Where-Object { $_.Contains("`t") } | ForEach-Object {
        $file, $json = $_ -split "`t", 2
        [pscustomobject]@{ Dir = $file -replace '/instance\.json$', ''; Id = [string](($json | ConvertFrom-Json).'instance.id') }
    })
    $match = @($dirs | Where-Object { $_.Id -eq $InstanceId })
    if ($match.Count -ne 1) {
        throw "$Container has $($match.Count) instance directories for instance $InstanceId (found: $(($dirs | ForEach-Object { "$($_.Dir)=$($_.Id)" }) -join ', '))."
    }
    return $match[0].Dir
}
