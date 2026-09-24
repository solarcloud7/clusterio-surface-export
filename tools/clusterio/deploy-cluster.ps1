# requires: development compose stack and explicit ResetData for a disposable rebuild
# produces: rebuilt containers with existing volumes retained by default
# does not: accept stale Lua builds or deploy a production installation
param (
    [switch]$SkipIncrement,
    [switch]$KeepData,
    [switch]$ResetData
)

$ErrorActionPreference = "Stop"
if ($KeepData -and $ResetData) { throw '-KeepData and -ResetData cannot be combined.' }

$WorkspaceRoot = Resolve-Path "$PSScriptRoot/../.."
$PluginPathCandidates = @(
    (Join-Path $WorkspaceRoot "docker\seed-data\external_plugins\surface_export"),
    (Join-Path $WorkspaceRoot "docker\seed-data\external_plugins\surface-export")
)

$PluginPath = $PluginPathCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $PluginPath) {
    $Checked = $PluginPathCandidates -join ", "
    throw "Could not find surface-export plugin folder. Checked: $Checked"
}

$PluginJsonPath = Join-Path $PluginPath "package.json"
$ModuleJsonPath = Join-Path $PluginPath "module\module.json"
. "$PSScriptRoot/../shared/version-utils.ps1"
. "$PSScriptRoot/../shared/cluster-utils.ps1"
Assert-DevelopmentClusterCheckout

if ($ResetData -and -not $SkipIncrement) {
    Write-Host "Reading version..." -ForegroundColor Cyan
    $PluginJson = Get-Content $PluginJsonPath -Raw | ConvertFrom-Json

    $NewVersion = Get-NextPluginVersion $PluginJson.version

    Write-Host "Bumping version: $($PluginJson.version) -> $NewVersion" -ForegroundColor Green

    $PluginJson.version = $NewVersion
    $PluginJson | ConvertTo-Json -Depth 10 | Set-Content $PluginJsonPath -Encoding UTF8
    Write-Host "Updated plugin version in package.json" -ForegroundColor Green

    if (Test-Path $ModuleJsonPath) {
        $ModuleJson = Get-Content $ModuleJsonPath -Raw | ConvertFrom-Json
        $ModuleJson.version = $NewVersion
        $ModuleJson | ConvertTo-Json -Depth 10 | Set-Content $ModuleJsonPath -Encoding UTF8
        Write-Host "Updated module version in module/module.json" -ForegroundColor Green
    } else {
        Write-Warning "module.json not found at $ModuleJsonPath"
    }
} else {
    $PluginJson = Get-Content $PluginJsonPath -Raw | ConvertFrom-Json
    $NewVersion = $PluginJson.version
    Write-Host "Using existing version: $NewVersion" -ForegroundColor Yellow
}

Update-PackageLockVersion -LockPath (Join-Path $PluginPath "package-lock.json") -NewVersion $NewVersion
Update-ModuleVersionStamp -ModuleDir (Join-Path $PluginPath "module") -NewVersion $NewVersion
$ModuleBuildId = Update-ModuleBuildStamp -ModuleDir (Join-Path $PluginPath "module")

Write-Host "Using save-patched module architecture (no mod zip needed)" -ForegroundColor Cyan
Write-Host "Lua code in module/ directory will be patched into saves by Clusterio" -ForegroundColor Green

$EnvFile = Join-Path $WorkspaceRoot ".env"
if (-not (Test-Path $EnvFile)) {
    Write-Host "Creating .env from example..." -ForegroundColor Yellow
    Copy-Item (Join-Path $WorkspaceRoot ".env.example") $EnvFile
    throw "Created .env from .env.example — set INIT_CLUSTERIO_ADMIN (and FACTORIO_CLIENT_TAG if the client downloads) and run again."
}

$envValues = @{}
foreach ($envLine in Get-Content $EnvFile) {
    if ($envLine -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') { $envValues[$Matches[1]] = $Matches[2] }
}
$seeded = Get-SeededInstances
$expectedInstances = @($seeded | Select-Object -ExpandProperty Instance)
$expectedHostContainers = @($seeded | Select-Object -ExpandProperty Container -Unique)
$pinnedFactorioVersions = @($seeded | ForEach-Object {
    (Get-Content (Join-Path $WorkspaceRoot "docker/seed-data/hosts/$($_.Host)/$($_.Instance)/instance.json") -Raw | ConvertFrom-Json).'factorio.version'
} | Sort-Object -Unique)
if ($pinnedFactorioVersions.Count -ne 1) { throw "instance.json files disagree on factorio.version: $($pinnedFactorioVersions -join ', ')" }
$pinnedFactorioVersion = $pinnedFactorioVersions[0]
if ($envValues['FACTORIO_USERNAME'] -and $envValues['FACTORIO_TOKEN']) {
    $clientTag = if ($envValues['FACTORIO_CLIENT_TAG']) { $envValues['FACTORIO_CLIENT_TAG'] } else { 'stable' }
    if ($clientTag -ne $pinnedFactorioVersion) {
        throw "FACTORIO_CLIENT_TAG is '$clientTag' but instance.json pins factorio.version $pinnedFactorioVersion — the client download would fill the client volume with the wrong engine. Set FACTORIO_CLIENT_TAG=$pinnedFactorioVersion in .env."
    }
}
$exportHostNumber = if ($envValues['EXPORT_HOST']) { $envValues['EXPORT_HOST'] } else { '1' }
$clientContainer = "surface-export-host-$exportHostNumber"

Write-Host "Stopping existing cluster..." -ForegroundColor Cyan
Set-Location $WorkspaceRoot
docker compose down
if ($LASTEXITCODE -ne 0) { throw 'docker compose down failed; deployment stopped.' }

if ($ResetData) {
    Write-Host "Removing Docker volumes (clean slate)..." -ForegroundColor Yellow
    $downOut = docker compose down -v 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host ($downOut | Out-String) -ForegroundColor Red
        throw "docker compose down -v failed (exit $LASTEXITCODE); reset may be partial. Inspect the remaining volumes before retrying."
    }
} else {
    Write-Host "Keeping existing data volumes" -ForegroundColor Yellow
}

Write-Host "Building plugin artifacts (node + web)..." -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "build-plugin.ps1") all
Write-Host "Plugin artifacts built successfully" -ForegroundColor Green

Write-Host "Pulling latest base images..." -ForegroundColor Cyan
docker compose pull

$composeText = Get-Content (Join-Path $WorkspaceRoot "docker-compose.yml") -Raw
$externalVolumes = @([regex]::Matches($composeText, '(?m)^  ([A-Za-z0-9_.-]+):[^\r\n]*\r?\n\s+external:\s*true') | ForEach-Object { $_.Groups[1].Value })
if ($externalVolumes.Count -eq 0) { throw "docker-compose.yml declares no external volume — the client-volume convention moved; update this script." }
foreach ($volume in $externalVolumes) {
    docker volume create $volume | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker volume create $volume failed (exit $LASTEXITCODE)" }
    Write-Host "External volume ready: $volume" -ForegroundColor Green
}

Write-Host "Starting cluster..." -ForegroundColor Cyan
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw "docker compose up -d failed (exit $LASTEXITCODE) — refusing to report a started cluster." }
$deploySw = [System.Diagnostics.Stopwatch]::StartNew()

Write-Host ""

Write-Host "Controller Logs (streaming - waiting for initialization):" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor DarkGray

$timeout = 120
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$initDone = $false

Start-Sleep -Seconds 3

$logJob = Start-Job -ScriptBlock {
    docker logs -f surface-export-controller 2>&1
}
try {
    while ($true) {
        $lines = Receive-Job $logJob
        foreach ($line in $lines) {
            Write-Host $line
            if ($line -match "Seeding complete") {
                $initDone = $true
            }
        }
        if ($initDone) { break }
        if ($sw.Elapsed.TotalSeconds -ge $timeout) {
            Write-Host "(Log streaming timeout after ${timeout}s)" -ForegroundColor Yellow
            break
        }
        Start-Sleep -Milliseconds 200
    }
} finally {
    if ($logJob) {
        # Deliberately quiet: best-effort teardown of the log-streaming job in a finally block —
        Stop-Job $logJob -ErrorAction SilentlyContinue
        Remove-Job $logJob -ErrorAction SilentlyContinue
    }
}

Write-Host "================================================" -ForegroundColor DarkGray

Write-Host ""
Write-Host "Waiting for instances to start..." -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor DarkGray

$hostBootStallS = 300
$deployCeilingS = 3600
$pollS = 5
$lastHostStatuses = ""
$lastClientMb = 0
$lastProgressS = $deploySw.Elapsed.TotalSeconds
while ($true) {
    $elapsedS = [int]$deploySw.Elapsed.TotalSeconds
    if ($elapsedS -ge $deployCeilingS) { throw "Host warm-up exceeded ${deployCeilingS}s. The cluster is NOT deployed." }
    $statuses = @{}
    foreach ($container in $expectedHostContainers) {
        # Deliberately quiet: this is a POLL — a container that does not exist yet reads as absent.
        $status = docker inspect --format "{{.State.Health.Status}}" $container 2>$null
        $statuses[$container] = if ($LASTEXITCODE -eq 0 -and $status) { "$status".Trim() } else { "absent" }
    }
    $statusLine = ($expectedHostContainers | ForEach-Object { "$_=$($statuses[$_])" }) -join " "
    if (@($statuses.Values | Where-Object { $_ -ne "healthy" }).Count -eq 0) {
        Write-Host "  [+${elapsedS}s] hosts healthy: $statusLine" -ForegroundColor Green
        break
    }
    if ($statusLine -ne $lastHostStatuses) {
        Write-Host "  [+${elapsedS}s] hosts: $statusLine" -ForegroundColor Yellow
        $lastHostStatuses = $statusLine
        $lastProgressS = $deploySw.Elapsed.TotalSeconds
    }
    # Deliberately quiet: this is a POLL — the client host may not exist yet.
    $clientOut = docker exec $clientContainer sh -c 'if [ -x /opt/factorio-client/bin/x64/factorio ]; then echo ready; else a=$(du -sm /opt/factorio-client 2>/dev/null | cut -f1); b=$(du -sm /tmp/factorio-client.tar.xz 2>/dev/null | cut -f1); echo $(( ${a:-0} + ${b:-0} )); fi' 2>$null
    if ($LASTEXITCODE -eq 0 -and "$clientOut" -match '^\d+') {
        $mb = [int]$Matches[0]
        if ($mb -gt $lastClientMb) {
            Write-Host "  [+${elapsedS}s] client volume filling: ${mb} MB" -ForegroundColor Yellow
            $lastClientMb = $mb
            $lastProgressS = $deploySw.Elapsed.TotalSeconds
        }
    }
    if (($deploySw.Elapsed.TotalSeconds - $lastProgressS) -gt $hostBootStallS) {
        throw "Host boot stalled for ${hostBootStallS}s with no health change and no client-volume growth: $statusLine (client: $clientOut). The cluster is NOT deployed."
    }
    Start-Sleep -Seconds $pollS
}

Write-Host "Expecting $($expectedInstances.Count) instance(s): $($expectedInstances -join ', ')" -ForegroundColor Cyan
$instanceTimeout = 300
$stoppedFailFastS = 30
$phaseStartS = $deploySw.Elapsed.TotalSeconds
$lastStates = @{}
$stoppedSince = @{}
$instancesDone = $false

while (-not $instancesDone -and ($deploySw.Elapsed.TotalSeconds - $phaseStartS) -lt $instanceTimeout) {
    Start-Sleep -Seconds 3

    # Deliberately quiet: this is a POLL. The controller legitimately refuses while still booting,
    $listOut = docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error instance list 2>/dev/null' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $listOut) { continue }

    $stateMap = @{}
    foreach ($line in ($listOut -split "`n")) {
        if ($line -match '(clusterio-\S+-instance-\d+).*\b(running|starting|stopped|stopping|creating_save|exporting_data|unassigned|unknown|deleted)\b') {
            $stateMap[$Matches[1]] = $Matches[2]
        }
    }

    $nowS = $deploySw.Elapsed.TotalSeconds
    foreach ($name in ($stateMap.Keys | Sort-Object)) {
        $state = $stateMap[$name]
        if ($lastStates[$name] -ne $state) {
            $stateColor = switch ($state) {
                "running"       { "Green"  }
                "stopped"       { "Red"    }
                "creating_save" { "Cyan"   }
                default         { "Yellow" }
            }
            Write-Host "  [+$([int]$nowS)s] $name -> $state" -ForegroundColor $stateColor
            $lastStates[$name] = $state
        }
        if ($state -eq "stopped") {
            if (-not $stoppedSince.ContainsKey($name)) {
                $stoppedSince[$name] = $nowS
            } elseif (($nowS - $stoppedSince[$name]) -ge $stoppedFailFastS -and $expectedInstances -contains $name) {
                throw "$name has been 'stopped' for ${stoppedFailFastS}s — a save-load failure, not a slow boot. Read /clusterio/data/instances/$name/factorio-current.log on its host. The cluster is NOT deployed."
            }
        } else {
            $stoppedSince.Remove($name)
        }
    }

    $missing = @($expectedInstances | Where-Object { -not $stateMap.ContainsKey($_) -or $stateMap[$_] -ne "running" })
    if ($missing.Count -eq 0) {
        $instancesDone = $true
    }
}

Write-Host "================================================" -ForegroundColor DarkGray
if ($instancesDone) {
    $elapsed = [int]$deploySw.Elapsed.TotalSeconds
    Write-Host "All instances running! (+${elapsed}s)" -ForegroundColor Green
} else {
    $holdouts = @($expectedInstances | Where-Object { -not $lastStates.ContainsKey($_) -or $lastStates[$_] -ne "running" } |
        ForEach-Object { "$_=$(if ($lastStates.ContainsKey($_)) { $lastStates[$_] } else { 'never registered' })" }) -join ", "
    Write-Host "X Instance startup TIMED OUT after ${instanceTimeout}s: $holdouts" -ForegroundColor Red
    throw "Instances did not reach running within ${instanceTimeout}s ($holdouts). The cluster is NOT deployed; do not trust a later success message."
}

Write-Host ""
Write-Host "Verifying the save-patched module VERSION on every seeded instance..." -ForegroundColor Cyan
$versionProbe = Get-ModuleDeploymentProbe
foreach ($probeInstance in $expectedInstances) {
    $probe = docker exec surface-export-controller npx clusterioctl --config /clusterio/tokens/config-control.json `
        --log-level error instance send-rcon $probeInstance $versionProbe 2>&1
    $probeText = ($probe | Out-String).Trim()
    $reported = Get-ModuleDeploymentResponse $probeText
    if ($LASTEXITCODE -ne 0 -or $probeText -match 'plugin-missing' -or
        -not $reported) {
        throw "surface_export interface is NOT loaded on ${probeInstance} (exit $LASTEXITCODE): $probeText"
    }
    if (Test-ModuleDeploymentResponse -Output $probeText -Version $NewVersion -BuildId $ModuleBuildId) {
        Write-Host "  OK - $probeInstance runs module version $($reported.version), build $($reported.buildId)" -ForegroundColor Green
    } else {
        throw "$probeInstance runs STALE module code ($($reported.version), build $($reported.buildId)); expected $NewVersion, build $ModuleBuildId. Deployment verification failed."
    }
}

Write-Host ""
Write-Host "Retrieving admin token..." -ForegroundColor Cyan
Start-Sleep -Seconds 2

$tokenJson = docker exec surface-export-controller cat /clusterio/tokens/config-control.json 2>$null
if ($LASTEXITCODE -eq 0 -and $tokenJson) {
    try {
        $tokenConfig = $tokenJson | ConvertFrom-Json
        $adminToken = $tokenConfig.'control.controller_token'
        if ($adminToken) {
            Write-Host "Admin Token: $adminToken" -ForegroundColor Yellow
            try { $adminToken | Set-Clipboard; Write-Host "(Copied to clipboard)" -ForegroundColor Green }
            catch { Write-Host "(Clipboard unavailable — copy the token above manually)" -ForegroundColor DarkGray }
        }
    } catch {
        Write-Host "Could not parse token from config" -ForegroundColor Yellow
    }
} else {
    Write-Host "Token not available yet. Retrieve later with:" -ForegroundColor Yellow
    Write-Host "  docker exec surface-export-controller cat /clusterio/tokens/config-control.json" -ForegroundColor DarkGray
}

try {
    & (Join-Path $PSScriptRoot 'sync-client-mods.ps1')
} catch {
    Write-Warning "sync-client-mods failed — the cluster is deployed and unaffected; run it by hand: $_"
}

Write-Host ""
$httpPort = (Get-Content $EnvFile | Where-Object { $_ -match '^CONTROLLER_HTTP_PORT=(\d+)' } | ForEach-Object { $Matches[1] } | Select-Object -First 1) ?? "8080"
Write-Host "Web UI: http://localhost:$httpPort" -ForegroundColor Green
Write-Host ""
Write-Host "Cluster topology:" -ForegroundColor Cyan
Write-Host "  Controller (http://localhost:$httpPort)" -ForegroundColor White
Write-Host "    ├── surface-export-host-1 (ports 34100-34109)" -ForegroundColor White
Write-Host "    │     └── clusterio-host-1-instance-1" -ForegroundColor White
Write-Host "    └── surface-export-host-2 (ports 34200-34209)" -ForegroundColor White
Write-Host "          └── clusterio-host-2-instance-1" -ForegroundColor White
Write-Host ""
