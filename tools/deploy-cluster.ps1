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
$DockerDir = Join-Path $WorkspaceRoot "docker"

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

# 5. Build web UI (so dist/ matches source)
Write-Host "Building web UI..." -ForegroundColor Cyan
Push-Location $PluginPath
try {
    npm install --silent 2>$null
    npm run build:web
    if ($LASTEXITCODE -ne 0) {
        throw "Web UI build failed"
    }
    Write-Host "Web UI built successfully" -ForegroundColor Green
} finally {
    Pop-Location
}

# 6. Pull latest base images
Write-Host "Pulling latest base images..." -ForegroundColor Cyan
docker compose pull

# 7. Start the cluster
Write-Host "Starting cluster..." -ForegroundColor Cyan
docker compose up -d

Write-Host "Cluster started with plugin version $NewVersion" -ForegroundColor Green
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
docker logs -f surface-export-controller 2>&1 | ForEach-Object {
    Write-Host $_
    if ($_ -match "Instance seeding complete|Mod seeding complete|Controller is ready|All hosts connected") {
        $initDone = $true
    }
    if ($sw.Elapsed.TotalSeconds -ge $timeout) {
        Write-Host "(Log streaming timeout after ${timeout}s)" -ForegroundColor Yellow
        return
    }
}

Write-Host "================================================" -ForegroundColor DarkGray

# 9. Retrieve admin token
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
Write-Host "Web UI: http://localhost:$((Get-Content $ControllerEnv | Where-Object { $_ -match 'CONTROLLER_HTTP_PORT=(\d+)' } | ForEach-Object { $Matches[1] }) ?? '8080')" -ForegroundColor Green
Write-Host ""
Write-Host "Cluster topology:" -ForegroundColor Cyan
Write-Host "  Controller (http://localhost:8080)" -ForegroundColor White
Write-Host "    ├── surface-export-host-1 (ports 34100-34109)" -ForegroundColor White
Write-Host "    │     └── clusterio-host-1-instance-1" -ForegroundColor White
Write-Host "    └── surface-export-host-2 (ports 34200-34209)" -ForegroundColor White
Write-Host "          └── clusterio-host-2-instance-1" -ForegroundColor White
Write-Host ""
