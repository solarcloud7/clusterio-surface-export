param (
    [switch]$SkipIncrement,
    [switch]$KeepData
)

$ErrorActionPreference = "Stop"

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

if (-not $SkipIncrement) {
    Write-Host "Reading version..." -ForegroundColor Cyan
    $PluginJson = Get-Content $PluginJsonPath -Raw | ConvertFrom-Json

    $VerParts = $PluginJson.version.Split('.')
    if ($VerParts.Count -ne 3) {
        Write-Error "Version format $($PluginJson.version) not supported for auto-increment. Expected X.Y.Z"
    }

    $NewPatch = [int]$VerParts[2] + 1
    $NewVersion = "{0}.{1}.{2}" -f $VerParts[0], $VerParts[1], $NewPatch

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

. "$PSScriptRoot/../shared/version-utils.ps1"
Update-PackageLockVersion -LockPath (Join-Path $PluginPath "package-lock.json") -NewVersion $NewVersion
Update-ModuleVersionStamp -ModuleDir (Join-Path $PluginPath "module") -NewVersion $NewVersion

Write-Host "Using save-patched module architecture (no mod zip needed)" -ForegroundColor Cyan
Write-Host "Lua code in module/ directory will be patched into saves by Clusterio" -ForegroundColor Green

$EnvFile = Join-Path $WorkspaceRoot ".env"
if (-not (Test-Path $EnvFile)) {
    Write-Host "Creating .env from example..." -ForegroundColor Yellow
    Copy-Item (Join-Path $WorkspaceRoot ".env.example") $EnvFile
    Write-Warning "Please edit .env and set INIT_CLUSTERIO_ADMIN before running again."
    exit 1
}

Write-Host "Stopping existing cluster..." -ForegroundColor Cyan
Set-Location $WorkspaceRoot
docker compose down

if (-not $KeepData) {
    Write-Host "Removing Docker volumes (clean slate)..." -ForegroundColor Yellow
    $downOut = docker compose down -v 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host ($downOut | Out-String) -ForegroundColor Red
        throw "docker compose down -v failed (exit $LASTEXITCODE) — volumes were NOT wiped, so this is not the clean slate it claims. Re-run, or pass -KeepData if you meant to keep them."
    }
} else {
    Write-Host "Keeping existing data volumes (-KeepData)" -ForegroundColor Yellow
}

Write-Host "Building plugin artifacts (node + web)..." -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "build-plugin.ps1") all
Write-Host "Plugin artifacts built successfully" -ForegroundColor Green

Write-Host "Pulling latest base images..." -ForegroundColor Cyan
docker compose pull

Write-Host "Starting cluster..." -ForegroundColor Cyan
docker compose up -d
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw "docker compose up -d failed (exit $LASTEXITCODE) — refusing to report a started cluster." }

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

$warmupCeilingS = 3600
$warmupStallS = 300
$warmupSw = [System.Diagnostics.Stopwatch]::StartNew()
$lastClientMb = -1
$lastGrowthAt = Get-Date
while ($warmupSw.Elapsed.TotalSeconds -lt $warmupCeilingS) {
    # Deliberately quiet: this is a POLL over containers that may not exist yet.
    $health = @(docker ps --filter "name=surface-export-host-" --format "{{.Names}} {{.State}}" 2>$null |
        ForEach-Object { docker inspect --format "{{.State.Health.Status}}" ($_ -split " ")[0] 2>$null })
    if ($health.Count -ge 2 -and (@($health | Where-Object { $_ -ne "healthy" }).Count -eq 0)) { break }

    # Deliberately quiet: du fails while neither path exists yet. Both paths are required — the
    # entrypoint downloads to /tmp/factorio-client.tar.xz first and extracts into the volume after.
    $mbOut = docker exec surface-export-host-1 sh -c 'a=$(du -sm /opt/factorio-client 2>/dev/null | cut -f1); b=$(du -sm /tmp/factorio-client.tar.xz 2>/dev/null | cut -f1); echo $(( ${a:-0} + ${b:-0} ))' 2>$null
    $mb = 0
    if ($LASTEXITCODE -eq 0 -and $mbOut -match '^\d+') { $mb = [int]$Matches[0] }
    if ($mb -gt $lastClientMb) {
        if ($lastClientMb -ge 0) {
            $elapsed = [int]$warmupSw.Elapsed.TotalSeconds
            Write-Host "  [+${elapsed}s] cold client volume warming: ${mb} MB downloaded" -ForegroundColor Yellow
        }
        $lastClientMb = $mb
        $lastGrowthAt = Get-Date
    } elseif (((Get-Date) - $lastGrowthAt).TotalSeconds -gt $warmupStallS) {
        throw "Host warm-up stalled: hosts not healthy and the client volume stopped growing at ${mb} MB for ${warmupStallS}s."
    }
    Start-Sleep -Seconds 15
}
if ($warmupSw.Elapsed.TotalSeconds -ge $warmupCeilingS) {
    throw "Host warm-up exceeded ${warmupCeilingS}s. The cluster is NOT deployed."
}

$expectedInstances = @(Get-ChildItem (Join-Path $PSScriptRoot '..\..\docker\seed-data\hosts\*\*') -Directory |
    Select-Object -ExpandProperty Name)
if ($expectedInstances.Count -eq 0) {
    throw "No instance dirs under docker/seed-data/hosts — cannot know what 'all instances running' means."
}
Write-Host "Expecting $($expectedInstances.Count) instance(s): $($expectedInstances -join ', ')" -ForegroundColor Cyan

$instanceTimeout = 300
$instanceSw = [System.Diagnostics.Stopwatch]::StartNew()
$lastStates = @{}
$instancesDone = $false

while (-not $instancesDone -and $instanceSw.Elapsed.TotalSeconds -lt $instanceTimeout) {
    Start-Sleep -Seconds 3

    # Deliberately quiet: this is a POLL. The controller legitimately refuses while still booting,
    $listOut = docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error instance list 2>/dev/null' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $listOut) { continue }

    $stateMap = @{}
    foreach ($line in ($listOut -split "`n")) {
        if ($line -match '(clusterio-\S+-instance-\d+).*\b(running|starting|stopped|stopping|creating_save|unassigned)\b') {
            $stateMap[$Matches[1]] = $Matches[2]
        }
    }

    foreach ($name in ($stateMap.Keys | Sort-Object)) {
        $state = $stateMap[$name]
        if ($lastStates[$name] -ne $state) {
            $stateColor = switch ($state) {
                "running"       { "Green"  }
                "stopped"       { "Red"    }
                "creating_save" { "Cyan"   }
                default         { "Yellow" }
            }
            $elapsed = [int]$instanceSw.Elapsed.TotalSeconds
            Write-Host "  [+${elapsed}s] $name -> $state" -ForegroundColor $stateColor
            $lastStates[$name] = $state
        }
    }

    $missing = @($expectedInstances | Where-Object { -not $stateMap.ContainsKey($_) -or $stateMap[$_] -ne "running" })
    if ($missing.Count -eq 0) {
        $instancesDone = $true
    }
}

Write-Host "================================================" -ForegroundColor DarkGray
if ($instancesDone) {
    $elapsed = [int]$instanceSw.Elapsed.TotalSeconds
    Write-Host "All instances running! (+${elapsed}s)" -ForegroundColor Green
} else {
    Write-Host "X Instance startup TIMED OUT after ${instanceTimeout}s" -ForegroundColor Red
    throw "Instances did not reach running within ${instanceTimeout}s. The cluster is NOT deployed; do not trust a later success message."
}

Write-Host ""
Write-Host "Verifying the save-patched module VERSION on both instances..." -ForegroundColor Cyan
$versionProbe = "/sc local i = remote.interfaces['surface_export'] " +
    "if not i then rcon.print('plugin-missing') " +
    "elseif not i['get_module_version'] then rcon.print('stale-module-no-version-oracle') " +
    "else rcon.print(remote.call('surface_export','get_module_version')) end"
foreach ($probeInstance in @("clusterio-host-1-instance-1", "clusterio-host-2-instance-1")) {
    $probe = docker exec surface-export-controller npx clusterioctl --config /clusterio/tokens/config-control.json `
        --log-level error instance send-rcon $probeInstance $versionProbe 2>&1
    $probeText = ($probe | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $probeText -match 'plugin-missing' -or
        -not ($probeText -match '(?m)^\s*(\d+\.\d+\.\d+|stale-module-no-version-oracle)\s*$')) {
        throw "surface_export interface is NOT loaded on ${probeInstance} (exit $LASTEXITCODE): $probeText"
    }
    $reported = $Matches[1]
    if ($reported -eq 'stale-module-no-version-oracle') { $reported = "a pre-oracle module (no version stamp)" }
    if ($reported -eq $NewVersion) {
        Write-Host "  OK - $probeInstance runs module version $reported" -ForegroundColor Green
    } elseif ($KeepData) {
        Write-Host "  ~ $probeInstance runs $reported (deploy is $NewVersion) — EXPECTED with -KeepData: kept saves keep their old patched Lua" -ForegroundColor Yellow
    } else {
        throw "$probeInstance runs STALE module code ($reported) after a full deploy (expected $NewVersion). The save was not re-patched — do not trust this deploy."
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
