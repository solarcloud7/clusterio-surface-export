param(
	[switch]$Upload,
	[string]$ModPack = "Space Age 2.0"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$SrcDir = Join-Path $RepoRoot "docker/seed-data/mods-src/surfexp_gateways"
$ModsDir = Join-Path $RepoRoot "docker/seed-data/mods"

if (-not (Test-Path (Join-Path $SrcDir "info.json"))) { throw "Mod source not found at $SrcDir" }
$info = Get-Content (Join-Path $SrcDir "info.json") -Raw | ConvertFrom-Json
$modName = $info.name
$version = $info.version
$folder = "${modName}_${version}"
$zipPath = Join-Path $ModsDir "${folder}.zip"

Write-Host "Building $folder from $SrcDir" -ForegroundColor Cyan

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("surfexp_gw_build_" + [System.Guid]::NewGuid().ToString("N"))
$stageMod = Join-Path $stage $folder
New-Item -ItemType Directory -Path $stageMod -Force | Out-Null
Copy-Item -Path (Join-Path $SrcDir "*") -Destination $stageMod -Recurse -Force
$stagedReadme = Join-Path $stageMod "README.md"
if (Test-Path $stagedReadme) { Remove-Item $stagedReadme -Force }

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $stageMod -DestinationPath $zipPath -Force
Remove-Item -Path $stage -Recurse -Force
Write-Host "  -> $zipPath" -ForegroundColor Green

if (-not $Upload) {
	Write-Host "Done (build only). Re-run with -Upload to load it into the running cluster." -ForegroundColor Gray
	return
}

$ctl = 'npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error'
$zipName = "${folder}.zip"
Write-Host "Uploading $zipName to the cluster + adding to pack '$ModPack' + restarting hosts..." -ForegroundColor Cyan

docker cp "$zipPath" "surface-export-controller:/tmp/$zipName" | Out-Null
docker exec surface-export-controller sh -c "$ctl mod upload /tmp/$zipName" 2>&1 | Where-Object { $_ -notmatch 'clusterio-atlas' }
docker exec surface-export-controller sh -c "$ctl mod-pack edit `"$ModPack`" --add-mods ${modName}:${version}" 2>&1 | Where-Object { $_ -notmatch 'clusterio-atlas' }

Write-Host "Restarting hosts to reload the mod pack..." -ForegroundColor Cyan
docker restart surface-export-host-1 surface-export-host-2 | Out-Null

Write-Host "Done. Verify with:" -ForegroundColor Green
Write-Host "  ./tools/clusterio/rcon.ps1 11 `"/sc rcon.print(script.active_mods['$modName'])`"" -ForegroundColor Gray
