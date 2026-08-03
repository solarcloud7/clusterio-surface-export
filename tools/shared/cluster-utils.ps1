<#
.SYNOPSIS
    Shared utility functions for cluster management scripts.
    Dot-source this file to use: . "$PSScriptRoot\cluster-utils.ps1"
#>

$script:ControlConfig = "/clusterio/tokens/config-control.json"
$script:RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path

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
        [string]$Container,
        [string]$StorePath
    )

    # Resolved from tools/shared/cluster-paths.json, the one address BOTH languages read (Node reads
    # it in tools/tests/testkit/log-query.mjs). Read INSIDE the function, not at dot-source time: a
    # missing or malformed JSON must break only this function, not every script that dot-sources this
    # library — Get-InstanceList and Sync-ControllerWebBundle have no business failing over a
    # constant they never use. Literal fallbacks keep it working if the file is ever unreadable.
    if (-not $Container -or -not $StorePath) {
        $pathsFile = Join-Path $PSScriptRoot 'cluster-paths.json'
        if (Test-Path $pathsFile) {
            $store = (Get-Content $pathsFile -Raw | ConvertFrom-Json).transactionLogStore
            if (-not $Container) { $Container = $store.container }
            if (-not $StorePath) { $StorePath = $store.path }
        }
        if (-not $Container) { $Container = "surface-export-controller" }
        if (-not $StorePath) { $StorePath = "/clusterio/data/database/surface_export_transaction_logs.json" }
    }

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

<#
.SYNOPSIS
    Make the controller serve the web bundle that is actually on disk; restart it if it does not.

.DESCRIPTION
    The controller reads each plugin's dist/web/manifest.json ONCE, at startup, and thereafter
    advertises the chunk filenames it found there. Webpack output is content-hashed and a rebuild
    DELETES the old chunks. So rebuilding the web bundle against a running controller does not leave
    the UI stale — it leaves it BROKEN: the controller keeps advertising a filename that no longer
    exists, every client 404s on it, and the plugin renders as "Error loading module" in the plugin
    table with "Failed to load plugin info for surface_export" in the browser console.

    Measured on this cluster 2026-07-31: /api/plugins advertised surface_export.96c2ec22….js (404 —
    the controller had been up since before the rebuild) while disk held surface_export.db7298f5….js
    (200). Restarting the controller fixed it.

    This MEASURES the invariant — what the controller serves vs what is on disk — instead of
    inferring it from which build target ran. That matters twice over: a build can rewrite dist/web
    even when you asked for `node` (on a cold deps volume build-plugin.ps1 runs `npm ci`, whose
    `prepare` lifecycle runs the FULL build), and a mismatch left behind by some earlier build that
    never restarted anything gets healed here too.

.PARAMETER Force
    Restart even when the bundles already agree — for controller-side dist/node changes, which this
    function cannot detect (the controller loads its own node entrypoint at startup as well).
#>
function Sync-ControllerWebBundle {
    param(
        [switch]$Force,
        [string]$Container = "surface-export-controller",
        [int]$TimeoutSec = 90
    )

    $manifestPath = Join-Path $script:RepoRoot "docker/seed-data/external_plugins/surface_export/dist/web/manifest.json"
    if (-not (Test-Path $manifestPath)) {
        throw "No web manifest at $manifestPath — the build did not produce dist/web."
    }
    $onDisk = (Get-Content $manifestPath -Raw | ConvertFrom-Json).'surface_export.js'
    if (-not $onDisk) {
        throw "dist/web/manifest.json has no 'surface_export.js' entry — the web build output is malformed."
    }

    $running = docker ps --filter "name=$Container" --format "{{.Names}}"
    if ($LASTEXITCODE -ne 0) { throw "docker ps failed (exit $LASTEXITCODE) while looking for $Container." }
    if (-not $running) {
        Write-Host "Controller is not running — nothing to reconcile (it will read the new manifest when it starts)." -ForegroundColor Yellow
        return
    }

    $advertised = Get-ControllerAdvertisedWebBundle -Container $Container
    if ($advertised -eq $onDisk -and -not $Force) {
        Write-Host "Controller already serves the built bundle ($onDisk)." -ForegroundColor Green
        return
    }

    if ($Force -and $advertised -eq $onDisk) {
        Write-Host "Bundles agree; restarting anyway as requested (controller-side node code)." -ForegroundColor Cyan
    } else {
        Write-Host "Controller is serving a bundle that is no longer on disk — restarting it." -ForegroundColor Yellow
        Write-Host "  serving: $advertised" -ForegroundColor Gray
        Write-Host "  on disk: $onDisk" -ForegroundColor Gray
    }

    docker restart $Container | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Controller restart failed (exit $LASTEXITCODE) — the new bundle is not being served." }

    # Re-read the manifest every iteration instead of comparing against the snapshot taken above.
    # The container's boot `npm install` runs the plugin's `prepare` script, which is a full
    # `npm run build` — so starting the controller REWRITES dist/web before it serves anything, and
    # the bundle we built a moment ago may no longer be the bundle on disk. Measured 2026-07-31: the
    # isolated build produced surface_export.db7298f5….js (webpack 5.105.2, lockfile-pinned via
    # `npm ci`) and the controller's boot build replaced it with surface_export.0dd67d36….js
    # (webpack 5.108.4, resolved by `npm install`). Pinning the comparison to the pre-restart
    # snapshot made this function fail on a cluster that was in fact perfectly consistent.
    # The invariant that matters is the live one: what the controller serves == what is on disk now.
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        # Deliberately quiet: bounded poll while the controller boots. $null just means "not up
        # yet" and the loop retries; the throw below is the real gate, never a silent pass.
        $advertised = Get-ControllerAdvertisedWebBundle -Container $Container
        if ($advertised) {
            # /api/plugins answering means the entrypoint (install + build) already finished, so the
            # manifest is settled by the time we read it here.
            $onDisk = (Get-Content $manifestPath -Raw | ConvertFrom-Json).'surface_export.js'
            if ($advertised -eq $onDisk) {
                Write-Host "Controller restarted and is serving $onDisk." -ForegroundColor Green
                return
            }
        }
        Start-Sleep -Seconds 3
    }
    throw ("Controller did not serve the bundle on disk within ${TimeoutSec}s. " +
        "On disk $onDisk, still advertising '$advertised'.")
}

<#
.SYNOPSIS
    The surface_export web chunk the controller is currently advertising, or $null if unavailable.
    Helper for Sync-ControllerWebBundle; /api/plugins needs no auth.
#>
function Get-ControllerAdvertisedWebBundle {
    param([string]$Container = "surface-export-controller")

    # Deliberately NO 2>&1 — stderr must stay OUT of the JSON (see Get-TransactionLogStore: merging
    # the streams is how a Docker warning ends up interleaved into a payload we then fail to parse).
    $raw = docker exec $Container sh -c 'curl -s --max-time 5 http://localhost:8080/api/plugins'
    if ($LASTEXITCODE -ne 0) { return $null }

    $json = ($raw -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($json)) { return $null }

    try {
        $plugins = $json | ConvertFrom-Json
    } catch {
        Write-Host "Could not parse /api/plugins from ${Container}: $($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
    return ($plugins | Where-Object { $_.name -eq 'surface_export' }).web.main
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
