<#
.SYNOPSIS
    Build the surface_export plugin (TypeScript node bundle + webpack web bundle) in an
    isolated Node container — no host Node required, and without corrupting the running cluster.

.DESCRIPTION
    Why this exists (see the Web cache guard entry and build notes in CLAUDE.md):
      * The host's system Node install is currently broken — C:\Program Files\nodejs was
        removed but left on PATH, so `node` does not resolve in a plain shell.
      * Building in the live plugin dir is unsafe while the cluster runs: `npm install` there
        re-adds the `@clusterio/*` peers into the bind-mounted node_modules and breaks
        clusterioctl with "duplicate copy of @clusterio/lib" (CLAUDE.md, Hot-Reload section).

    This script sidesteps both by building in a throwaway node:24 container with:
      * the plugin dir bind-mounted  -> dist/ lands back on the host, so the cluster picks it up;
      * a NAMED VOLUME over node_modules -> the cluster's bind-mounted node_modules is never
        touched, and deps persist between runs for speed.
    It mirrors CI (npm ci against package-lock.json).

.PARAMETER Target
    all (default) | node | web — which build script to run.

.PARAMETER Fresh
    Drop the cached deps volume and run a clean `npm ci` (use after package.json/lock changes).

.PARAMETER RestartController
    After building, restart the controller so it re-reads dist/web/manifest.json. Required for
    web changes to show up, because the controller caches each plugin's manifest at startup.

.PARAMETER RestartHosts
    After building, restart both hosts so they reload dist/node/*.js. Required for TypeScript
    (node) changes to show up, because the hosts load the plugin's node bundle at startup.

.EXAMPLE
    ./tools/build-plugin.ps1 web -RestartController     # rebuild web UI and serve it live
.EXAMPLE
    ./tools/build-plugin.ps1 node -RestartHosts        # rebuild TypeScript and reload it on the hosts
.EXAMPLE
    ./tools/build-plugin.ps1 all -RestartController -RestartHosts   # full build + reload everything
.EXAMPLE
    ./tools/build-plugin.ps1                            # full build (node + web)
.EXAMPLE
    ./tools/build-plugin.ps1 -Fresh                     # clean reinstall + full build
#>
param(
    [ValidateSet('all', 'node', 'web')][string]$Target = 'all',
    [switch]$Fresh,
    [switch]$RestartController,
    [switch]$RestartHosts
)

$ErrorActionPreference = 'Stop'

$PluginPath = (Resolve-Path "$PSScriptRoot/../docker/seed-data/external_plugins/surface_export").Path
$DepsVolume = 'se_plugin_build_nm'
$Image = 'node:24-bookworm-slim'

# Fail fast with a clear message if the Docker daemon isn't reachable (otherwise the docker
# commands below fail with an opaque non-zero exit that reads like a build error).
docker version --format '{{.Server.Version}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Docker does not appear to be running. Start Docker Desktop and retry." }

$BuildScript = switch ($Target) {
    'web'  { 'npm run build:web' }
    'node' { 'npm run build:node' }
    default { 'npm run build' }
}

if ($Fresh) {
    Write-Host "Dropping cached deps volume ($DepsVolume) for a clean npm ci..." -ForegroundColor Yellow
    docker volume rm $DepsVolume 2>$null | Out-Null
}

# Inside the container: if deps are missing, `npm ci` installs them AND builds (its `prepare`
# lifecycle runs a full `npm run build`); if deps are already cached, run the requested build
# directly. The if/else avoids building twice on a fresh install.
$Inner = "set -e; echo '[node] '`$(node -v); " +
         "if [ ! -x node_modules/.bin/webpack-cli ]; then echo '[deps] npm ci (prepare runs a full build)'; npm ci --no-audit --no-fund; " +
         "else echo '[build] $BuildScript'; $BuildScript; fi; echo '[ok] build complete'"

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
