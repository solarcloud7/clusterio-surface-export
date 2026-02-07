param (
    [switch]$ForceBaseBuild,
    [switch]$SkipIncrement
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

# 2. Build Base Image (skip if exists unless -ForceBaseBuild)
Set-Location $DockerDir
$imageExists = docker image inspect factorio-surface-export/base:latest 2>$null
if ($ForceBaseBuild -or -not $imageExists) {
    Write-Host "Building Base Image..." -ForegroundColor Cyan
    docker-compose -f docker-compose.clusterio.yml build base
    if ($LASTEXITCODE -ne 0) { throw "Base image build failed" }
} else {
    Write-Host "Base image already exists, skipping build (use -ForceBaseBuild to rebuild)" -ForegroundColor Yellow
}

# 3. Clean & Rebuild Cluster
Write-Host "Rebuilding Cluster..." -ForegroundColor Cyan
Set-Location $DockerDir
docker-compose -f docker-compose.clusterio.yml down

# Clean Data (Optional but recommended for dev)
Write-Host "Cleaning container data..." -ForegroundColor Yellow
Remove-Item -Recurse -Force "clusterio-containers\controller\*" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "clusterio-containers\hosts\*" -ErrorAction SilentlyContinue

# Bring up cluster (plugin mounted from seed-data/external_plugins/)
docker-compose -f docker-compose.clusterio.yml up -d --build

Write-Host "Cluster started with version $NewVersion" -ForegroundColor Green

# Follow init logs in real-time (will automatically stop when container exits)
Write-Host "`nClusterio Init Logs (streaming):" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor DarkGray

# Check if init container exists before trying to follow logs
$initExists = docker ps -a --filter "name=clusterio-init" --format "{{.Names}}" 2>$null
if ($initExists) {
    docker logs -f clusterio-init 2>&1
} else {
    Write-Host "clusterio-init container not found (may have already completed and been removed)" -ForegroundColor Yellow
}

Write-Host "================================================" -ForegroundColor DarkGray
Write-Host "Init container completed" -ForegroundColor Green

$ConfigControlPath = Join-Path $DockerDir "clusterio-containers/controller/config-control.json"
if (Test-Path $ConfigControlPath) {
    $ConfigControl = Get-Content $ConfigControlPath -Raw | ConvertFrom-Json
    Write-Host "`nAdmin Token: $($ConfigControl.'control.controller_token')" -ForegroundColor Yellow
} else {
    Write-Host "`nconfig-control.json not found yet. Run: docker exec clusterio-controller npx clusteriocontroller --log-level error bootstrap generate-user-token admin" -ForegroundColor Yellow
}
