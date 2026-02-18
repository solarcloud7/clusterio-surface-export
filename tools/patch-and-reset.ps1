# Patch and Reset Instances
# Hot-reload plugin code and reset instances to seed save without full cluster rebuild

param(
    [switch]$Help = $false
)

if ($Help) {
    Write-Host @"
Patch and Reset Instances
==========================

Hot-reloads plugin code changes and resets instances to seed save without rebuilding containers.

Usage:
    .\patch-and-reset.ps1

This script:
1. Stops Factorio instances (keeps controller running)
2. Resets save files to seed saves (required to apply Lua code changes)
3. Restarts instances (picks up plugin code changes from docker/seed-data/external_plugins/surface_export)

Note: Save reset is REQUIRED because Lua code is embedded in save files via save-patching.
      Without reset, old embedded script.dat prevents Lua code updates from taking effect.
"@
    exit 0
}

$ErrorActionPreference = "Stop"

Write-Host "=== Patch and Reset Instances ===" -ForegroundColor Cyan
Write-Host ""

# Increment version to ensure no caching
Write-Host "Incrementing plugin version..." -ForegroundColor Yellow
$WorkspaceRoot = Split-Path $PSScriptRoot -Parent
$PluginJsonPath = Join-Path $WorkspaceRoot "docker/seed-data/external_plugins/surface_export/package.json"
$ModuleJsonPath = Join-Path $WorkspaceRoot "docker/seed-data/external_plugins/surface_export/module/module.json"

$PluginJson = Get-Content $PluginJsonPath -Raw | ConvertFrom-Json
$VerParts = $PluginJson.version.Split('.')
if ($VerParts.Count -ne 3) {
    Write-Error "Version format $($PluginJson.version) not supported. Expected X.Y.Z"
}

$NewPatch = [int]$VerParts[2] + 1
$NewVersion = "{0}.{1}.{2}" -f $VerParts[0], $VerParts[1], $NewPatch
Write-Host "  $($PluginJson.version) → $NewVersion" -ForegroundColor Green

$PluginJson.version = $NewVersion
$PluginJson | ConvertTo-Json -Depth 10 | Set-Content $PluginJsonPath -Encoding UTF8

if (Test-Path $ModuleJsonPath) {
    $ModuleJson = Get-Content $ModuleJsonPath -Raw | ConvertFrom-Json
    $ModuleJson.version = $NewVersion
    $ModuleJson | ConvertTo-Json -Depth 10 | Set-Content $ModuleJsonPath -Encoding UTF8
}
Write-Host "✓ Version updated" -ForegroundColor Green
Write-Host ""

# Build web UI (so dist/ matches source)
Write-Host "Building web UI..." -ForegroundColor Yellow
$PluginDir = Join-Path $WorkspaceRoot "docker/seed-data/external_plugins/surface_export"
Push-Location $PluginDir
try {
    npm install --silent 2>$null
    npm run build:web
    if ($LASTEXITCODE -ne 0) {
        throw "Web UI build failed"
    }
    Write-Host "✓ Web UI built" -ForegroundColor Green
} finally {
    Pop-Location
}
Write-Host ""

# Check if cluster is running
Write-Host "Checking cluster status..." -ForegroundColor Yellow
$controllerStatus = docker ps --filter "name=surface-export-controller" --format "{{.Status}}"
if (-not $controllerStatus) {
    Write-Host "ERROR: Clusterio controller is not running. Start cluster first with:" -ForegroundColor Red
    Write-Host "  docker compose up -d" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Controller running" -ForegroundColor Green

# Stop instances (use instance names, not numeric IDs which don't match)
Write-Host ""
$ctlConfig = "--config=/clusterio/tokens/config-control.json"

Write-Host "Stopping Factorio instances..." -ForegroundColor Yellow
docker exec surface-export-controller npx clusterioctl $ctlConfig instance stop "clusterio-host-1-instance-1" 2>$null
docker exec surface-export-controller npx clusterioctl $ctlConfig instance stop "clusterio-host-2-instance-1" 2>$null
Start-Sleep -Seconds 2
Write-Host "✓ Instances stopped" -ForegroundColor Green

# Reset saves (ALWAYS required to apply Lua code changes)
Write-Host ""
Write-Host "Resetting instance saves to seed saves..." -ForegroundColor Yellow

# Load save names from .env file
$envPath = "docker/.env"
$instance1SaveName = "test.zip"  # Default
$instance2SaveName = "MinSeed.zip"  # Default

if (Test-Path $envPath) {
    Get-Content $envPath | ForEach-Object {
        if ($_ -match '^INSTANCE1_SAVE_NAME=(.+)$') {
            $instance1SaveName = $matches[1]
        }
        if ($_ -match '^INSTANCE2_SAVE_NAME=(.+)$') {
            $instance2SaveName = $matches[1]
        }
    }
}

# IMPORTANT: Clusterio stores instance data under /clusterio/data/instances/
# Lua module code is embedded in save files via save-patching during instance start.
# To apply Lua code changes, we MUST delete old saves and re-upload the seed saves
# so Clusterio re-patches them with the updated module code.

# Instance 1 - Delete old saves and re-upload seed save
$inst1SavePath = "/clusterio/data/instances/clusterio-host-1-instance-1/saves"
docker exec surface-export-host-1 sh -c "rm -f $inst1SavePath/*.zip" 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ Cleared instance 1 saves" -ForegroundColor Green
} else {
    Write-Host "  ✗ Failed to clear instance 1 saves" -ForegroundColor Red
}
$inst1SeedSave = "/clusterio/seed-data/hosts/clusterio-host-1/clusterio-host-1-instance-1/test1.zip"
docker exec surface-export-controller npx clusterioctl $ctlConfig --log-level error instance save upload "clusterio-host-1-instance-1" $inst1SeedSave 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ Re-uploaded seed save for instance 1 (test1.zip)" -ForegroundColor Green
} else {
    Write-Host "  ✗ Failed to upload seed save for instance 1" -ForegroundColor Red
}

# Instance 2 - Delete old saves and re-upload seed save
$inst2SavePath = "/clusterio/data/instances/clusterio-host-2-instance-1/saves"
docker exec surface-export-host-2 sh -c "rm -f $inst2SavePath/*.zip" 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ Cleared instance 2 saves" -ForegroundColor Green
} else {
    Write-Host "  ✗ Failed to clear instance 2 saves" -ForegroundColor Red
}
$inst2SeedSave = "/clusterio/seed-data/hosts/clusterio-host-2/clusterio-host-2-instance-1/test2.zip"
docker exec surface-export-controller npx clusterioctl $ctlConfig --log-level error instance save upload "clusterio-host-2-instance-1" $inst2SeedSave 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ Re-uploaded seed save for instance 2 (test2.zip)" -ForegroundColor Green
} else {
    Write-Host "  ✗ Failed to upload seed save for instance 2" -ForegroundColor Red
}

Write-Host "  → Instances will re-patch seed saves with updated Lua code on start" -ForegroundColor Cyan

# Restart containers to pick up JavaScript changes (instance.js, controller.js, messages.js)
Write-Host ""
Write-Host "Restarting containers to pick up JavaScript changes..." -ForegroundColor Yellow
docker restart surface-export-host-1 surface-export-host-2 | Out-Null
Write-Host "  ✓ Hosts restarting" -ForegroundColor Green
docker restart surface-export-controller | Out-Null
Write-Host "  ✓ Controller restarting" -ForegroundColor Green

Write-Host "Waiting for containers to become healthy..." -ForegroundColor Yellow
$timeoutSec = 90
$elapsed = 0
$containers = @("surface-export-controller", "surface-export-host-1", "surface-export-host-2")
do {
    Start-Sleep -Seconds 3
    $elapsed += 3
    $allHealthy = $true
    foreach ($c in $containers) {
        $s = docker ps --filter "name=$c" --format "{{.Status}}" 2>$null
        if ($s -notmatch "\(healthy\)") { $allHealthy = $false }
    }
} while (-not $allHealthy -and $elapsed -lt $timeoutSec)

if ($allHealthy) {
    Write-Host "✓ All containers healthy" -ForegroundColor Green
} else {
    Write-Host "  ⚠ Containers may not be fully healthy yet — proceeding" -ForegroundColor Yellow
}
Write-Host ""

# Ensure auto_pause is disabled (headless servers must tick continuously for async processing)
Write-Host ""
Write-Host "Disabling auto_pause on instances..." -ForegroundColor Yellow
$settingsBase = @{ auto_pause = $false; only_admins_can_pause_the_game = $true; autosave_interval = 10; autosave_slots = 5; non_blocking_saving = $true }

$inst1Settings = $settingsBase.Clone(); $inst1Settings["name"] = "instance 1"
$inst2Settings = $settingsBase.Clone(); $inst2Settings["name"] = "instance 2"

$inst1Json = ($inst1Settings | ConvertTo-Json -Compress)
$inst2Json = ($inst2Settings | ConvertTo-Json -Compress)

docker exec surface-export-controller npx clusterioctl $ctlConfig instance config set "clusterio-host-1-instance-1" "factorio.settings" $inst1Json 2>$null
docker exec surface-export-controller npx clusterioctl $ctlConfig instance config set "clusterio-host-2-instance-1" "factorio.settings" $inst2Json 2>$null
Write-Host "✓ auto_pause disabled" -ForegroundColor Green

# Start instances (may already be running if hosts auto-started them after container restart)
Write-Host ""
Write-Host "Starting instances (loading patched plugin code)..." -ForegroundColor Yellow
docker exec surface-export-controller npx clusterioctl $ctlConfig instance start "clusterio-host-1-instance-1" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Instance 1 already running" -ForegroundColor DarkGray
}
docker exec surface-export-controller npx clusterioctl $ctlConfig instance start "clusterio-host-2-instance-1" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Instance 2 already running" -ForegroundColor DarkGray
}
Start-Sleep -Seconds 3
Write-Host "✓ Instances started" -ForegroundColor Green
Write-Host ""
Write-Host "=== Patch and Reset Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Plugin changes from docker/seed-data/external_plugins/surface_export have been loaded." -ForegroundColor White
Write-Host "Instances have been reset to seed save state with fresh Lua code." -ForegroundColor White
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Check logs: .\tools\check-cluster-logs.ps1" -ForegroundColor White
Write-Host "  2. Test export: docker exec surface-export-controller npx clusterioctl instance send-rcon 1 '/export-platform 2 2'" -ForegroundColor White
Write-Host "  3. Test import: docker exec surface-export-controller npx clusterioctl instance send-rcon 2 '/import-platform <filename>'" -ForegroundColor White
