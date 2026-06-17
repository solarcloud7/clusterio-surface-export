<#
.SYNOPSIS
    Build the surface_export plugin (TypeScript node bundle + webpack web bundle) in an
    isolated Node container — no host Node required, and without corrupting the running cluster.

.DESCRIPTION
    Why this exists (see docs/static-asset-caching.md and CLAUDE.md):
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

.EXAMPLE
    ./tools/build-plugin.ps1 web -RestartController     # rebuild web UI and serve it live
.EXAMPLE
    ./tools/build-plugin.ps1                            # full build (node + web)
.EXAMPLE
    ./tools/build-plugin.ps1 -Fresh                     # clean reinstall + full build
#>
param(
    [ValidateSet('all', 'node', 'web')][string]$Target = 'all',
    [switch]$Fresh,
    [switch]$RestartController
)

$ErrorActionPreference = 'Stop'

$PluginPath = (Resolve-Path "$PSScriptRoot/../docker/seed-data/external_plugins/surface_export").Path
$DepsVolume = 'se_plugin_build_nm'
$Image = 'node:24-bookworm-slim'

$BuildScript = switch ($Target) {
    'web'  { 'npm run build:web' }
    'node' { 'npm run build:node' }
    default { 'npm run build' }
}

if ($Fresh) {
    Write-Host "Dropping cached deps volume ($DepsVolume) for a clean npm ci..." -ForegroundColor Yellow
    docker volume rm $DepsVolume 2>$null | Out-Null
}

# Inside the container: install deps into the named volume only if missing, then build.
# (npm ci's `prepare` lifecycle already runs a full build on first install.)
$Inner = "set -e; echo '[node] '`$(node -v); " +
         "if [ ! -x node_modules/.bin/webpack-cli ]; then echo '[deps] npm ci'; npm ci --no-audit --no-fund; fi; " +
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
    Write-Host "Controller restarted. Hard-reload not needed — chunks are content-hashed." -ForegroundColor Green
}

Write-Host "Done: $Target build complete." -ForegroundColor Green
