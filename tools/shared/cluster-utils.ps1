#Requires -Version 7.3

$script:ControlConfig = "/clusterio/tokens/config-control.json"
$script:RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path

function ConvertTo-LuaLiteral {
    param([Parameter(Mandatory=$true)][AllowEmptyString()][string]$Value)
    return $Value.Replace('\', '\\').Replace("'", "\'")
}

. "$PSScriptRoot/instance-identity.ps1"

function Get-InstanceList {
    $raw = docker exec surface-export-controller npx clusterioctl --log-level error --config $script:ControlConfig instance list 2>&1
    if ($LASTEXITCODE -ne 0) { throw "clusterioctl instance list failed (exit $LASTEXITCODE): $(($raw | Out-String).Trim())" }
    return ConvertFrom-InstanceList -Raw @($raw | ForEach-Object { "$_" })
}

function Get-InstanceByHostNumber {
    param([Parameter(Mandatory)][string]$HostNumber)
    return Select-InstanceForHost -Instances @(Get-InstanceList) -HostNumber $HostNumber -SeedName (Get-SeedInstanceName -HostNumber $HostNumber)
}

function Get-InstanceDataDir {
    param(
        [Parameter(Mandatory)][string]$InstanceId,
        [Parameter(Mandatory)][string]$HostNumber
    )
    $container = "surface-export-host-$HostNumber"
    $raw = docker exec $container sh -c $script:InstanceDirsScript 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Listing instance directories on $container failed (exit $LASTEXITCODE): $(($raw | Out-String).Trim())" }
    return Select-InstanceDataDir -Raw @($raw | ForEach-Object { "$_" }) -InstanceId $InstanceId -Container $container
}

function Publish-SeedSave {
    param(
        [Parameter(Mandatory)][string]$InstanceId,
        [Parameter(Mandatory)][string]$SeedSavePath
    )
    $out = docker exec surface-export-controller npx clusterioctl --config $script:ControlConfig --log-level info instance save upload $InstanceId $SeedSavePath 2>&1
    $code = $LASTEXITCODE
    $text = ((@($out) | ForEach-Object { "$_" }) -join "`n") -replace "\x1b\[[0-9;]*m", ''
    if ($code -ne 0) { throw "Uploading $SeedSavePath to instance $InstanceId failed (exit $code): $($text.Trim())" }
    $stored = @([regex]::Matches($text, '(?m)Successfully uploaded as (.+?\.zip)\s*$') | ForEach-Object { $_.Groups[1].Value })
    if ($stored.Count -ne 1) {
        throw "Uploading $SeedSavePath to instance $InstanceId reported $($stored.Count) stored save names; expected one. Output: $(if ($text.Trim()) { $text.Trim() } else { '(empty)' })"
    }
    return $stored[0]
}

function Get-LoadedSave {
    param([Parameter(Mandatory)][string]$InstanceId)
    $raw = docker exec surface-export-controller npx clusterioctl --config $script:ControlConfig --log-level error instance save list $InstanceId 2>&1
    if ($LASTEXITCODE -ne 0) { throw "clusterioctl instance save list $InstanceId failed (exit $LASTEXITCODE): $(($raw | Out-String).Trim())" }
    $lines = @($raw | ForEach-Object { "$_" } | Where-Object { $_.Contains('|') })
    $header = if ($lines.Count) { @($lines[0] -split '\|' | ForEach-Object { $_.Trim() }) } else { @() }
    $nameAt = [Array]::IndexOf($header, 'name'); $loadedAt = [Array]::IndexOf($header, 'loaded')
    if ($nameAt -lt 0 -or $loadedAt -lt 0) { throw "clusterioctl instance save list $InstanceId has no name/loaded column: $(($raw | Out-String).Trim())" }
    return @($lines | Select-Object -Skip 1 | Where-Object { $_ -notmatch '^[-\s|]+$' } | ForEach-Object {
        $cells = @($_ -split '\|' | ForEach-Object { $_.Trim() })
        if ($cells.Count -gt $loadedAt -and $cells[$loadedAt] -eq 'true') { $cells[$nameAt] }
    })
}

$script:FactorioPidsScript = 'for p in /proc/[0-9]*; do tr ''\0'' ''\n'' < "$p/cmdline" 2>/dev/null | grep -Fqx -- "$1/config.ini" && echo "${p#/proc/}"; done; true'
$script:RconStartLineScript = 'grep -F "Starting RCON interface" "$1/factorio-current.log" 2>/dev/null | tail -n 1; true'
$script:StartClientSweepScript = 'for p in /proc/[0-9]*; do n=${p#/proc/}; [ "$n" = "$$" ] && continue; c=$(tr ''\0'' '' '' < "$p/cmdline" 2>/dev/null); case "$c" in *clusterioctl*" instance start $1 "*) kill -9 "$n" 2>/dev/null && echo "$n";; esac; done; true'

function Get-InstanceStartDiagnosis {
    param(
        [Parameter(Mandatory)][string]$InstanceId,
        [Parameter(Mandatory)][string]$HostNumber,
        [string]$DataDir
    )
    $container = "surface-export-host-$HostNumber"
    try {
        $row = @(Get-InstanceList | Where-Object { $_.Id -eq $InstanceId })
        $status = if ($row.Count) { $row[0].Status } else { "not listed" }
    } catch { $status = "unreadable ($($_.Exception.Message))" }
    if (-not $DataDir) {
        try { $DataDir = Get-InstanceDataDir -InstanceId $InstanceId -HostNumber $HostNumber }
        catch { return [pscustomobject]@{ Status = $status; PidsReadable = $false; FactorioPids = @(); RconLine = ""; RconTimestampInvalid = $false
            Text = "status '$status'; data directory unknown ($($_.Exception.Message))" } }
    }
    $pidOut = docker exec $container sh -c $script:FactorioPidsScript sh $DataDir 2>&1
    $pidsReadable = $LASTEXITCODE -eq 0
    $pids = @($pidOut | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '^\d+$' })
    $rconOut = docker exec $container sh -c $script:RconStartLineScript sh $DataDir 2>&1
    $rconLine = if ($LASTEXITCODE -eq 0) { (@($rconOut | ForEach-Object { "$_" }) -join "`n").TrimEnd() } else { "" }
    $invalid = [bool]$rconLine -and $rconLine -notmatch '^ {0,3}\d+\.\d+ '
    $processText = if (-not $pidsReadable) { "Factorio processes unreadable on $container ($(($pidOut | Out-String).Trim()))" }
        elseif ($pids.Count) { "Factorio running on $container as PID $($pids -join ', ')" }
        else { "no Factorio process for $DataDir on $container" }
    $rconText = if ($invalid) { "factorio-current.log started RCON with a non-seconds timestamp, so Clusterio never saw RCON ready: '$rconLine'" }
        elseif ($rconLine) { "factorio-current.log started RCON: '$rconLine'" }
        else { "factorio-current.log has no 'Starting RCON interface' line" }
    return [pscustomobject]@{
        Status               = $status
        PidsReadable         = $pidsReadable
        FactorioPids         = $pids
        RconLine             = $rconLine
        RconTimestampInvalid = $invalid
        Text                 = "status '$status'; $processText; $rconText"
    }
}

function Stop-InstanceStartClient {
    param([Parameter(Mandatory)][string]$InstanceId)
    $out = docker exec surface-export-controller sh -c $script:StartClientSweepScript sh $InstanceId 2>&1
    return @($out | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '^\d+$' })
}

function Stop-InstanceWithDeadline {
    param(
        [Parameter(Mandatory)][string]$InstanceId,
        [Parameter(Mandatory)][string]$HostNumber,
        [Parameter(Mandatory)][string]$DataDir,
        [ValidateRange(1, 3600)][int]$TimeoutSec = 420
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $out = docker exec surface-export-controller timeout -k 10 $TimeoutSec npx clusterioctl --config $script:ControlConfig --log-level error instance stop $InstanceId 2>&1
    $stopText = "exit $LASTEXITCODE$(if ("$out".Trim()) { ": $(($out | Out-String).Trim())" })"
    while ($true) {
        $diagnosis = Get-InstanceStartDiagnosis -InstanceId $InstanceId -HostNumber $HostNumber -DataDir $DataDir
        if ($diagnosis.Status -eq 'stopped' -and $diagnosis.PidsReadable -and -not @($diagnosis.FactorioPids).Count) { return $diagnosis }
        if ((Get-Date) -ge $deadline) {
            throw "Instance $InstanceId did not stop within ${TimeoutSec}s (clusterioctl instance stop $stopText): $($diagnosis.Text). Nothing was deleted."
        }
        Start-Sleep -Seconds 3
    }
}

function Stop-HostInstances {
    param(
        [Parameter(Mandatory)][string[]]$HostNumber,
        [ValidateRange(1, 3600)][int]$TimeoutSec = 420
    )
    foreach ($instance in @(Get-InstanceList | Where-Object { $_.Host -in $HostNumber -and $_.Status -notin 'stopped', 'unknown', 'unassigned' })) {
        Write-Host "Stopping $($instance.Name) (status $($instance.Status)) so its host saves it before the container restarts..." -ForegroundColor Yellow
        $dataDir = Get-InstanceDataDir -InstanceId $instance.Id -HostNumber $instance.Host
        Stop-InstanceWithDeadline -InstanceId $instance.Id -HostNumber $instance.Host -DataDir $dataDir -TimeoutSec $TimeoutSec | Out-Null
    }
}

function Start-InstanceWithDeadline {
    param(
        [Parameter(Mandatory)][string]$InstanceId,
        [Parameter(Mandatory)][string]$HostNumber,
        [string]$Save,
        [string]$DataDir,
        [ValidateRange(1, 3600)][int]$StartTimeoutSec = 180,
        [ValidateRange(1, 3600)][int]$StopTimeoutSec = 420
    )
    $saveArgs = @()
    if ($Save) { $saveArgs = @('--save', $Save) }
    $diagnoses = @()
    foreach ($attempt in 1, 2) {
        $out = docker exec surface-export-controller timeout -k 10 $StartTimeoutSec npx clusterioctl --config $script:ControlConfig --log-level error instance start $InstanceId @saveArgs 2>&1
        $code = $LASTEXITCODE
        if ($code -notin 124, 137) {
            $global:LASTEXITCODE = $code
            return $out
        }
        if (-not $DataDir) { try { $DataDir = Get-InstanceDataDir -InstanceId $InstanceId -HostNumber $HostNumber } catch { $DataDir = "" } }
        $diagnosis = Get-InstanceStartDiagnosis -InstanceId $InstanceId -HostNumber $HostNumber -DataDir $DataDir
        $diagnoses += "attempt ${attempt}: $($diagnosis.Text)"
        Write-Host "  ! instance start $InstanceId did not return within ${StartTimeoutSec}s (attempt $attempt): $($diagnosis.Text)" -ForegroundColor Yellow
        $killed = @(Stop-InstanceStartClient -InstanceId $InstanceId)
        if ($killed.Count) { Write-Host "    killed the waiting clusterioctl client (PID $($killed -join ', '))" -ForegroundColor DarkYellow }
        if ($attempt -eq 2) { break }
        if (-not $DataDir) { throw "instance start $InstanceId did not return within ${StartTimeoutSec}s and its data directory is unknown, so it was not stopped or retried. $($diagnoses -join ' ') Nothing was deleted." }
        Write-Host "    stopping instance $InstanceId (waits up to ${StopTimeoutSec}s for Clusterio's shutdown timeout)..." -ForegroundColor DarkYellow
        Stop-InstanceWithDeadline -InstanceId $InstanceId -HostNumber $HostNumber -DataDir $DataDir -TimeoutSec $StopTimeoutSec | Out-Null
        Write-Host "    retrying instance start $InstanceId once$(if ($Save) { " with --save $Save" })" -ForegroundColor DarkYellow
    }
    throw "instance start $InstanceId$(if ($Save) { " --save $Save" }) did not return within ${StartTimeoutSec}s twice; the instance was left as it is. $($diagnoses -join ' ') Nothing was deleted."
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

function Assert-PluginArtifactsFresh {
    param([string]$Remedy = "Run deploy.ps1 -Scope plugin -KeepSaves to build and reload.")
    $pluginRoot = Join-Path $script:RepoRoot 'docker/seed-data/external_plugins/surface_export'
    $inputs = @(
        Get-ChildItem "$pluginRoot/lib", "$pluginRoot/shared", "$pluginRoot/web" -File -Recurse
        Get-ChildItem $pluginRoot -File | Where-Object { $_.Extension -in '.ts', '.tsx' -or $_.Name -like 'tsconfig*.json' -or $_.Name -eq 'webpack.config.js' }
        Get-Item "$pluginRoot/scripts/build-web.mjs", "$pluginRoot/scripts/web-assets.mjs"
    )
    $newestInput = $inputs | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    $newest = $newestInput.LastWriteTimeUtc
    foreach ($tree in 'node', 'web') {
        $stamp = Join-Path $pluginRoot "dist/$tree/.prepare-build-stamp"
        if (-not (Test-Path $stamp) -or (Get-Item -Force $stamp).LastWriteTimeUtc -lt $newest) {
            throw "dist/$tree is missing or older than the build inputs (newest: $($newestInput.FullName)). $Remedy"
        }
    }
}

function Test-LinkedWorktree {
    param([Parameter(Mandatory)][string]$Root)
    $dirs = @(git -C $Root rev-parse --path-format=absolute --git-dir --git-common-dir)
    if ($LASTEXITCODE -ne 0 -or $dirs.Count -ne 2) {
        throw "Cannot tell whether $Root is the main checkout (git exit $LASTEXITCODE)."
    }
    return [IO.Path]::GetFullPath($dirs[0]) -ne [IO.Path]::GetFullPath($dirs[1])
}

function Get-BuildDependencyVolume {
    param([Parameter(Mandatory)][string]$Root)
    if (-not (Test-LinkedWorktree -Root $Root)) { return 'se_plugin_build_nm' }
    $key = [Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Root).TrimEnd('\', '/').ToLowerInvariant())
    return 'se_plugin_build_nm_' + [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($key)).Substring(0, 12).ToLowerInvariant()
}

function Assert-DevelopmentClusterCheckout {
    param([string]$Root = $script:RepoRoot)
    $here = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $rows = @(docker ps -a --format '{{.Names}}|{{.Label "com.docker.compose.project.working_dir"}}')
    if ($LASTEXITCODE -ne 0) {
        throw "docker ps failed (exit $LASTEXITCODE); cannot tell which checkout runs the development cluster. Nothing was changed."
    }
    $cluster = @($rows | ForEach-Object { $name, $dir = "$_" -split '\|', 2; [pscustomobject]@{ Name = $name; Dir = $dir } } |
        Where-Object Name -in 'surface-export-controller', 'surface-export-host-1', 'surface-export-host-2')
    foreach ($container in $cluster) {
        if (-not $container.Dir) {
            throw "$($container.Name) was not started by docker compose, so the checkout it mounts is unknown. Nothing was changed."
        }
        $source = [IO.Path]::GetFullPath($container.Dir).TrimEnd('\', '/')
        if (-not [string]::Equals($source, $here, $(if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }))) {
            throw ("The development cluster ($($container.Name)) runs from $source, not from this checkout ($here). " +
                "Deploy and restart from $source; build-plugin.ps1 -OutputDirectory builds in isolation. Nothing was changed.")
        }
    }
    if (-not $cluster.Count -and (Test-LinkedWorktree -Root $here)) {
        throw "No development cluster exists and $here is a linked worktree. Start the cluster from the main checkout. Nothing was changed."
    }
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

function Get-SeededInstances {
    $hostsDir = Join-Path $script:RepoRoot "docker/seed-data/hosts"
    if (-not (Test-Path $hostsDir)) { throw "No seed-data hosts directory at $hostsDir." }
    $records = @()
    foreach ($hostDir in (Get-ChildItem $hostsDir -Directory | Sort-Object Name)) {
        if ($hostDir.Name -notmatch '(\d+)$') { throw "$($hostDir.FullName) does not end in a host number — the container name cannot be derived." }
        $hostNumber = [int]$Matches[1]
        foreach ($instanceDir in (Get-ChildItem $hostDir.FullName -Directory | Sort-Object Name)) {
            $records += [pscustomobject]@{
                Host       = $hostDir.Name
                HostNumber = $hostNumber
                Container  = "surface-export-host-$hostNumber"
                Instance   = $instanceDir.Name
            }
        }
    }
    if (-not $records) { throw "$hostsDir names no seeded instance — a gate over this set would gate on nothing." }
    return $records
}

function Get-SeededInstanceNames {
    return @(Get-SeededInstances | Select-Object -ExpandProperty Instance)
}

function Test-ScenarioMigrationFailure {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Log,
        [Parameter(Mandatory)][string]$Instance
    )
    $marker = "Error during auto startup for ${Instance}:"
    $at = $Log.IndexOf($marker)
    if ($at -lt 0) { return $false }
    $next = $Log.IndexOf("Error during auto startup for ", $at + $marker.Length)
    $detail = if ($next -lt 0) { $Log.Substring($at) } else { $Log.Substring($at, $next - $at) }
    return $detail.Contains('clusterio_private.update_instance') -and
        $detail.Contains("attempt to index global 'clusterio_private' (a nil value)")
}
