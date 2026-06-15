# Build the locally-checked-out Clusterio fork and (re)start the dev cluster running it, via the
# docker-compose.clusterio-src.yml override — so you can test a Clusterio core change alongside the
# surface_export plugin in the full 2-host Docker cluster.
#
# The fork lives in the SIBLING checkout ../clusterio (override with $env:CLUSTERIO_SRC). This is the
# "full-cluster integration" loop; for fast core iteration prefer Clusterio's native pnpm dev env.
# See CLAUDE.md "Clusterio core development" for the full workflow + compatibility caveats.
#
# Usage:
#   ./tools/rebuild-clusterio.ps1            # pnpm build the fork, then bring the cluster up on it
#   ./tools/rebuild-clusterio.ps1 -SkipUp    # build only (no container recreate)
#
# To revert the cluster to the published image:
#   docker compose up -d --force-recreate

param(
    [switch]$SkipUp
)

$ErrorActionPreference = "Stop"

# Resolve the fork checkout: $env:CLUSTERIO_SRC if set, else the sibling ../clusterio (source/clusterio).
$forkDir = if ($env:CLUSTERIO_SRC) { $env:CLUSTERIO_SRC } else { Join-Path $PSScriptRoot "..\..\clusterio" }
if (-not (Test-Path (Join-Path $forkDir "pnpm-workspace.yaml"))) {
    Write-Host "Clusterio fork not found at '$forkDir'." -ForegroundColor Red
    Write-Host "Set `$env:CLUSTERIO_SRC to your fork checkout (origin = your fork, upstream = clusterio/clusterio)." -ForegroundColor Red
    exit 1
}
$forkDir = (Resolve-Path $forkDir).Path
$repoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

Write-Host "Building Clusterio fork at $forkDir (pnpm build)..." -ForegroundColor Cyan
Push-Location $forkDir
try {
    & pnpm build
    if ($LASTEXITCODE -ne 0) { Write-Host "pnpm build FAILED" -ForegroundColor Red; exit 1 }
} finally {
    Pop-Location
}
Write-Host "Build OK" -ForegroundColor Green

if (-not $SkipUp) {
    Write-Host ""
    Write-Host "Recreating cluster with the fork override (docker-compose.clusterio-src.yml)..." -ForegroundColor Cyan
    $env:CLUSTERIO_SRC = $forkDir   # consumed by the override's bind-mount paths
    docker compose `
        -f (Join-Path $repoDir "docker-compose.yml") `
        -f (Join-Path $repoDir "docker-compose.clusterio-src.yml") `
        up -d --force-recreate surface-export-controller surface-export-host-1 surface-export-host-2
    Write-Host ""
    Write-Host "Done — the cluster is now running the fork build from $forkDir." -ForegroundColor Green
    Write-Host "If instances fail to start, the fork branch is likely too diverged from the plugin's pinned" -ForegroundColor DarkGray
    Write-Host "@clusterio version; build a closer branch or use the native pnpm dev env (see CLAUDE.md)." -ForegroundColor DarkGray
    Write-Host "Revert with:  docker compose up -d --force-recreate" -ForegroundColor DarkGray
}
