param (
    [switch]$SkipIncrement,
    [switch]$KeepData
)

$ErrorActionPreference = "Stop"

# Paths
$WorkspaceRoot = Resolve-Path "$PSScriptRoot/.."
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

# 1. Increment Version
if (-not $SkipIncrement) {
    Write-Host "Reading version..." -ForegroundColor Cyan
    $PluginJson = Get-Content $PluginJsonPath -Raw | ConvertFrom-Json

    # Parse version (Simple Major.Minor.Patch)
    $VerParts = $PluginJson.version.Split('.')
    if ($VerParts.Count -ne 3) {
        Write-Error "Version format $($PluginJson.version) not supported for auto-increment. Expected X.Y.Z"
    }

    $NewPatch = [int]$VerParts[2] + 1
    $NewVersion = "{0}.{1}.{2}" -f $VerParts[0], $VerParts[1], $NewPatch

    Write-Host "Bumping version: $($PluginJson.version) -> $NewVersion" -ForegroundColor Green

    # Update Plugin package.json
    $PluginJson.version = $NewVersion
    $PluginJson | ConvertTo-Json -Depth 10 | Set-Content $PluginJsonPath -Encoding UTF8
    Write-Host "Updated plugin version in package.json" -ForegroundColor Green

    # Update Module module.json to match
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

# Both branches: keep the lockfile's version metadata in step with package.json (a -SkipIncrement
# run heals pre-existing drift too; idempotent — writes only on change). See tools/version-utils.ps1.
. "$PSScriptRoot/version-utils.ps1"
Update-PackageLockVersion -LockPath (Join-Path $PluginPath "package-lock.json") -NewVersion $NewVersion

Write-Host "Using save-patched module architecture (no mod zip needed)" -ForegroundColor Cyan
Write-Host "Lua code in module/ directory will be patched into saves by Clusterio" -ForegroundColor Green

# 2. Verify env file exists
$EnvFile = Join-Path $WorkspaceRoot ".env"
if (-not (Test-Path $EnvFile)) {
    Write-Host "Creating .env from example..." -ForegroundColor Yellow
    Copy-Item (Join-Path $WorkspaceRoot ".env.example") $EnvFile
    Write-Warning "Please edit .env and set INIT_CLUSTERIO_ADMIN before running again."
    exit 1
}

# 3. Tear down existing cluster
Write-Host "Stopping existing cluster..." -ForegroundColor Cyan
Set-Location $WorkspaceRoot
docker compose down

# 4. Clean Docker volumes (unless -KeepData)
if (-not $KeepData) {
    Write-Host "Removing Docker volumes (clean slate)..." -ForegroundColor Yellow
    docker compose down -v 2>$null
} else {
    Write-Host "Keeping existing data volumes (-KeepData)" -ForegroundColor Yellow
}

# 5. Build plugin artifacts (node + web)
Write-Host "Building plugin artifacts (node + web)..." -ForegroundColor Cyan
Push-Location $PluginPath
try {
    if (Test-Path (Join-Path $PluginPath "package-lock.json")) {
        npm ci --silent 2>$null
    } else {
        npm install --silent 2>$null
    }
    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "Plugin build failed"
    }
    Write-Host "Plugin artifacts built successfully" -ForegroundColor Green
} finally {
    Pop-Location
}

# 6. Pull latest base images
Write-Host "Pulling latest base images..." -ForegroundColor Cyan
docker compose pull

# 7. Start the cluster
# Run up -d twice: first pass starts the controller; second pass ensures hosts
# are started after the controller is healthy (Docker Compose timing quirk with
# depends_on: service_healthy can leave dependent containers in Created state).
# The FIRST pass is ALLOWED to fail — recovering from that is the entire reason the retry exists.
# Only the second pass is load-bearing, so only it is checked. (An earlier commit on this branch
# deleted the retry in the same edit that made the downstream instance timeout fatal: two changes,
# one attribution. A compose hiccup that used to self-heal became a hard abort.)
Write-Host "Starting cluster..." -ForegroundColor Cyan
docker compose up -d
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw "docker compose up -d failed (exit $LASTEXITCODE) — refusing to report a started cluster." }

# NOTE: this printed "Cluster started with plugin version $NewVersion" using the version it had just
# WRITTEN to package.json — never a value read back from the running cluster. A deploy that silently
# failed to take still announced the new version, which is exactly the "old code after deploy"
# confusion the pitfall corpus documented. The real assertion happens after startup, below.
Write-Host ""

# 8. Follow controller logs until initialization completes
Write-Host "Controller Logs (streaming - waiting for initialization):" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor DarkGray

# Stream controller logs for up to 120 seconds, stop when we see seeding complete
$timeout = 120
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$initDone = $false

# Wait a moment for the container to start
Start-Sleep -Seconds 3

# Follow logs and look for initialization markers
# Use a job so we can break out early when seeding completes
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
        Stop-Job $logJob -ErrorAction SilentlyContinue
        Remove-Job $logJob -ErrorAction SilentlyContinue
    }
}

Write-Host "================================================" -ForegroundColor DarkGray

# 9. Wait for instances to reach running state
Write-Host ""
Write-Host "Waiting for instances to start..." -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor DarkGray

$instanceTimeout = 300
$instanceSw = [System.Diagnostics.Stopwatch]::StartNew()
$lastStates = @{}
$instancesDone = $false

while (-not $instancesDone -and $instanceSw.Elapsed.TotalSeconds -lt $instanceTimeout) {
    Start-Sleep -Seconds 3

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

    $nonRunning = @($stateMap.Values | Where-Object { $_ -ne "running" })
    if ($stateMap.Count -gt 0 -and $nonRunning.Count -eq 0) {
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

# ---- POST-DEPLOY LIVENESS PROBE ----
# What this proves, and what it does NOT, stated plainly.
#
# The previous version of this block claimed to "verify the running cluster loaded $NewVersion" by
# cat-ing module.json out of host-1. It was wrong twice over:
#   1. docker-compose.yml bind-mounts ./docker/seed-data/external_plugins into BOTH hosts, so that
#      cat re-read the exact file this script had just written at the top. A tautology, not a check.
#   2. `docker exec ... 2>&1` yields a string ARRAY. `-match` against a collection FILTERS and does
#      not populate $Matches, so it silently reused the capture from the instance poll loop above
#      and compared the version against an instance NAME — hard-failing every single deploy.
#
# There is no runtime version oracle to fix this with: no Lua reads module.json, and clusterioctl
# prints no plugin version. So assert only what is genuinely observable — that each instance is up
# and its save-patched module answers RCON.
#
# LIMIT: this is a LIVENESS check, not a freshness check. On `-SkipIncrement -KeepData` the volumes
# and their already-patched saves survive, so Lua edits do NOT take and this probe still goes green.
# Only the default `down -v` path re-seeds and re-patches.
Write-Host ""
Write-Host "Verifying the save-patched module answers on both instances..." -ForegroundColor Cyan
foreach ($probeInstance in @("clusterio-host-1-instance-1", "clusterio-host-2-instance-1")) {
    $probe = docker exec surface-export-controller npx clusterioctl --config /clusterio/tokens/config-control.json `
        --log-level error instance send-rcon $probeInstance "/sc rcon.print(remote.interfaces['surface_export'] ~= nil)" 2>&1
    $probeText = ($probe | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $probeText -notmatch 'true') {
        throw "surface_export interface is NOT loaded on ${probeInstance} (exit $LASTEXITCODE): $probeText"
    }
    Write-Host "  OK - $probeInstance has the surface_export interface loaded" -ForegroundColor Green
}

# 10. Retrieve admin token
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
            try { $adminToken | Set-Clipboard; Write-Host "(Copied to clipboard)" -ForegroundColor Green } catch {}
        }
    } catch {
        Write-Host "Could not parse token from config" -ForegroundColor Yellow
    }
} else {
    Write-Host "Token not available yet. Retrieve later with:" -ForegroundColor Yellow
    Write-Host "  docker exec surface-export-controller cat /clusterio/tokens/config-control.json" -ForegroundColor DarkGray
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
