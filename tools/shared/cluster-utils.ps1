$script:ControlConfig = "/clusterio/tokens/config-control.json"
$script:RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path

function ConvertTo-LuaLiteral {
    param([Parameter(Mandatory=$true)][AllowEmptyString()][string]$Value)
    return $Value.Replace('\', '\\').Replace("'", "\'")
}

function Get-InstanceList {
    $raw = docker exec surface-export-controller npx clusterioctl --log-level error --config $script:ControlConfig instance list 2>&1

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
    param([string]$HostNumber)

    $all = Get-InstanceList
    $match = $all | Where-Object { $_.Name -match "host-$HostNumber" }
    if (-not $match) {
        Write-Error "No instance found for host number $HostNumber"
        return $null
    }
    return $match
}

function Get-TransactionLogStore {
    param(
        [string]$Container,
        [string]$StorePath
    )

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

    $raw = docker exec $Container cat $StorePath
    if ($LASTEXITCODE -ne 0) { return $null }

    $json = ($raw -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($json)) { return @() }

    try {
        return $json | ConvertFrom-Json
    } catch {
        Write-Host "Failed to parse the transaction log store ($StorePath). Content preview:" -ForegroundColor Red
        Write-Host ($json.Substring(0, [Math]::Min(400, $json.Length))) -ForegroundColor Gray
        throw
    }
}

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

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        # Deliberately quiet: bounded poll while the controller boots. $null just means "not up
        $advertised = Get-ControllerAdvertisedWebBundle -Container $Container
        if ($advertised) {
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

function Get-ControllerAdvertisedWebBundle {
    param([string]$Container = "surface-export-controller")

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
    param(
        [string]$InstanceName,
        [string]$Command
    )
    $out = docker exec surface-export-controller npx clusterioctl --log-level error `
        instance send-rcon $InstanceName $Command --config $script:ControlConfig 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Send-RCON failed on '$InstanceName' (exit $LASTEXITCODE): $(($out | Out-String).Trim())"
    }
    return $out
}
