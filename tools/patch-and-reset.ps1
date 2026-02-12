# Patch and Reset Instances
# Hot-reload plugin code and reset instances to seed save without full cluster rebuild

param(
    [switch]$Help = $false
)

if ($Help) {
    Write-Host @"
Patch and Reset Instances
==========================

Hot-reloads plugin code changes and restarts instances.

Usage:
    .\patch-and-reset.ps1

This script:
1. Stops Factorio instances (keeps controller running)
2. Restarts instances - Clusterio save-patches fresh Lua module code into existing save files
3. Save data (platforms, world state) is preserved across restarts

Note: Clusterio re-patches ALL module/ Lua files into the save zip on every instance start.
      The patch number is incremented, triggering on_server_startup for re-initialization.
      No need to delete saves — only stop and restart.
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
Write-Host "Stopping Factorio instances..." -ForegroundColor Yellow
docker exec surface-export-controller npx clusterioctl instance stop "clusterio-host-1-instance-1" 2>$null
docker exec surface-export-controller npx clusterioctl instance stop "clusterio-host-2-instance-1" 2>$null
Start-Sleep -Seconds 2
Write-Host "✓ Instances stopped" -ForegroundColor Green

# Reset saves (ALWAYS required to apply Lua code changes)
Write-Host ""
Write-Host "Resetting instance saves..." -ForegroundColor Yellow

# IMPORTANT: Clusterio re-patches Lua module code into save files on every instance start.
# We do NOT need to delete saves — the save-patcher replaces all module/ Lua files in the
# save zip and increments the patch number, which triggers re-initialization at runtime.
# Saves are preserved so test platforms and world state persist across hot-reloads.
Write-Host "  → Saves preserved (Clusterio save-patches fresh Lua on instance start)" -ForegroundColor Cyan

# Start instances
Write-Host ""
Write-Host "Starting instances (loading patched plugin code)..." -ForegroundColor Yellow
docker exec surface-export-controller npx clusterioctl instance start "clusterio-host-1-instance-1"
docker exec surface-export-controller npx clusterioctl instance start "clusterio-host-2-instance-1"
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
