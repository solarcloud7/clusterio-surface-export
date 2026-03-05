# Rebuild locally-modified Clusterio packages and restart containers.
#
# Compiles the full TypeScript dist directories that are bind-mounted
# into the containers via docker-compose.yml:
#   lib/dist/          → all containers (@clusterio/lib message types, schemas)
#   host/dist/node/    → surface-export-host-1, host-2
#   controller/dist/   → surface-export-controller (node + web)
#
# The lib, controller, and host dist directories are mounted as a unit so
# that server-side code, web UI, and message schemas all stay in sync.
#
# Usage:
#   ./tools/rebuild-clusterio.ps1              # rebuild + restart all
#   ./tools/rebuild-clusterio.ps1 -SkipRestart # rebuild only (no container restart)

param(
    [switch]$SkipRestart
)

$ErrorActionPreference = "Stop"
$clusterioDir = Join-Path $PSScriptRoot "..\clusterio"

Write-Host "Building Clusterio packages..." -ForegroundColor Cyan

# host package: contains export.ts -> export.js (references lib via tsconfig)
Write-Host "  tsc host (node)..." -NoNewline
& npx --prefix $clusterioDir tsc --build (Join-Path $clusterioDir "packages\host\tsconfig.node.json") --force 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host " FAILED" -ForegroundColor Red; exit 1 }
Write-Host " OK" -ForegroundColor Green

# controller package: contains routes.ts -> routes.js (references lib via tsconfig)
Write-Host "  tsc controller (node)..." -NoNewline
& npx --prefix $clusterioDir tsc --build (Join-Path $clusterioDir "packages\controller\tsconfig.node.json") --force 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host " FAILED" -ForegroundColor Red; exit 1 }
Write-Host " OK" -ForegroundColor Green

if (-not $SkipRestart) {
    Write-Host ""
    Write-Host "Restarting containers to pick up changes..." -ForegroundColor Cyan
    # Files are bind-mounted so a simple restart picks up the new JS (no recreate needed)
    docker compose restart surface-export-controller surface-export-host-1 surface-export-host-2
    Write-Host "Done." -ForegroundColor Green
    Write-Host ""
    Write-Host "Watch logs with:" -ForegroundColor DarkGray
    Write-Host "  docker logs -f surface-export-controller" -ForegroundColor DarkGray
    Write-Host "  docker logs -f surface-export-host-1" -ForegroundColor DarkGray
}
