param(
    [ValidateSet('all', 'node', 'web')][string]$Target = 'all',
    [switch]$Fresh,
    [switch]$RestartController,
    [switch]$RestartHosts
)

$ErrorActionPreference = 'Stop'

$PluginPath = (Resolve-Path "$PSScriptRoot/../../docker/seed-data/external_plugins/surface_export").Path
$DepsVolume = 'se_plugin_build_nm'
$Image = 'node:24-bookworm-slim'

docker version --format '{{.Server.Version}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Docker does not appear to be running. Start Docker Desktop and retry." }

$BuildScript = switch ($Target) {
    'web'  { 'npm run build:browser && npm run build:web' }
    'node' { 'npm run build:node' }
    default { 'npm run build' }
}

if ($Fresh) {
    Write-Host "Dropping cached deps volume ($DepsVolume) for a clean npm ci..." -ForegroundColor Yellow
    # Deliberately quiet: the volume may not exist yet, which is the normal first-run case.
    docker volume rm $DepsVolume 2>$null | Out-Null
}

$Inner = "set -e; echo '[node] '`$(node -v); " +
         "if [ ! -x node_modules/.bin/webpack-cli ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then " +
         "echo '[deps] npm ci'; npm ci --no-audit --no-fund; fi; " +
         "echo '[build] $BuildScript'; $BuildScript; echo '[ok] build complete'"

Write-Host "Building plugin ($Target) in $Image ..." -ForegroundColor Cyan
docker run --rm `
    --mount "type=bind,src=$PluginPath,dst=/app" `
    -v "${DepsVolume}:/app/node_modules" `
    -w /app `
    $Image `
    sh -c $Inner

if ($LASTEXITCODE -ne 0) { throw "Plugin build failed (exit $LASTEXITCODE)" }

if ($RestartController) {
    Write-Host "Restarting controller to re-read dist/web/manifest.json ..." -ForegroundColor Cyan
    docker restart surface-export-controller | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Controller restart failed (exit $LASTEXITCODE) — build succeeded, but the new bundle isn't being served yet." }
    Write-Host "Controller restarted. Hard-reload not needed — chunks are content-hashed." -ForegroundColor Green
}

if ($RestartHosts) {
    Write-Host "Restarting hosts to reload dist/node/*.js ..." -ForegroundColor Cyan
    docker restart surface-export-host-1 surface-export-host-2 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Host restart failed (exit $LASTEXITCODE) — build succeeded, but the new node bundle isn't loaded yet." }
    Write-Host "Hosts restarted." -ForegroundColor Green
}

Write-Host "Done: $Target build complete." -ForegroundColor Green
