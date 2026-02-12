# Show Clusterio Cluster Status
Write-Host "=== Cluster Status ===" -ForegroundColor Cyan
Write-Host ""

# Show Docker containers
docker ps --filter "name=clusterio" --format "table {{.Names}}`t{{.Status}}`t{{.Ports}}"

Write-Host ""
Write-Host "=== Plugin Version ===" -ForegroundColor Cyan

# Get dev plugin version
$DevPluginPath = "$PSScriptRoot\..\docker\seed-data\external_plugins\surface_export\package.json"
if (Test-Path $DevPluginPath) {
    $DevPlugin = Get-Content $DevPluginPath -Raw | ConvertFrom-Json
    Write-Host "Dev Plugin (package.json):     $($DevPlugin.version)" -ForegroundColor Green
} else {
    Write-Host "Dev Plugin (package.json):     NOT FOUND" -ForegroundColor Red
}

# Get module version
$ModuleJsonPath = "$PSScriptRoot\..\docker\seed-data\external_plugins\surface_export\module\module.json"
if (Test-Path $ModuleJsonPath) {
    $ModuleJson = Get-Content $ModuleJsonPath -Raw | ConvertFrom-Json
    if ($ModuleJson.version -eq $DevPlugin.version) {
        Write-Host "Module (module.json):          $($ModuleJson.version)" -ForegroundColor Green
    } else {
        Write-Host "Module (module.json):          $($ModuleJson.version) (MISMATCH!)" -ForegroundColor Red
    }
} else {
    Write-Host "Module (module.json):          NOT FOUND" -ForegroundColor Red
}

Write-Host ""
Write-Host "Note: Save-patched modules don't appear in game.mods" -ForegroundColor DarkGray
Write-Host "      Check clusterio.json in saves to see deployed module version" -ForegroundColor DarkGray

Write-Host ""
Write-Host "=== Instance Status ===" -ForegroundColor Cyan

# Show Clusterio instances
docker exec surface-export-controller npx clusterioctl instance list 2>&1 | Select-Object -Skip 1
