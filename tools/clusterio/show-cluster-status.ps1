# requires: Docker; the running surface-export-controller container for the instance list
# produces: this deployment's running containers (surface-export-controller, surface-export-host-N) with status and
#           ports, the plugin and module versions in the checkout the script runs from, and the controller's
#           clusterioctl instance list
# does not: list stopped containers or another cluster's containers (atlas-*), report the module version a running
#           save has loaded, or change cluster state
Write-Host "=== Cluster Status ===" -ForegroundColor Cyan
Write-Host ""

docker ps --filter 'name=^surface-export-(controller|host-[0-9]+)$' --format "table {{.Names}}`t{{.Status}}`t{{.Ports}}"

Write-Host ""
Write-Host "=== Plugin Version ===" -ForegroundColor Cyan

$DevPluginPath = "$PSScriptRoot\..\..\docker\seed-data\external_plugins\surface_export\package.json"
if (Test-Path $DevPluginPath) {
    $DevPlugin = Get-Content $DevPluginPath -Raw | ConvertFrom-Json
    Write-Host "Dev Plugin (package.json):     $($DevPlugin.version)" -ForegroundColor Green
} else {
    Write-Host "Dev Plugin (package.json):     NOT FOUND" -ForegroundColor Red
}

$ModuleJsonPath = "$PSScriptRoot\..\..\docker\seed-data\external_plugins\surface_export\module\module.json"
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

docker exec surface-export-controller npx clusterioctl --config /clusterio/tokens/config-control.json instance list 2>&1 | Select-Object -Skip 1
