#Requires -Version 7

param(
	[switch]$Upload,
	[string]$ModPack = "Space Age 2.0",
	[switch]$SkipClientSync,
	[switch]$PruneOldClientVersions
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

if (-not $SkipClientSync) {
	# A client-sync failure must never abort the cluster upload below. Aborting would leave the
	# cluster on the OLD mod while the operator believes the build shipped — the same desync this
	# whole feature exists to remove, just pointing the other way.
	try {
		$appData = $env:APPDATA
		$clientMods = if ([string]::IsNullOrWhiteSpace($appData)) { $null } else { Join-Path $appData "Factorio/mods" }
		if (-not $clientMods -or -not (Test-Path $clientMods)) {
			$where = if ($clientMods) { $clientMods } else { '$env:APPDATA is not set' }
			Write-Host "Client sync SKIPPED: no Factorio user data ($where)" -ForegroundColor Yellow
			Write-Host "  Headless/CI has no local game install; the cluster copy is unaffected." -ForegroundColor Gray
		} else {
			$syncArgs = @{}
			if ($PruneOldClientVersions) { $syncArgs.PruneShadowing = $true }
			& (Join-Path $RepoRoot "tools/clusterio/sync-client-mods.ps1") @syncArgs

			$listPath = Join-Path $clientMods "mod-list.json"
			if (-not (Test-Path $listPath)) {
				throw "$listPath is missing — refusing to guess the mod list format."
			}
			$list = Get-Content $listPath -Raw | ConvertFrom-Json
			$entry = $list.mods | Where-Object { $_.name -eq $modName }
			$needsWrite = $true
			if (-not $entry) {
				$list.mods += [pscustomobject]@{ name = $modName; enabled = $true }
				Write-Host "  mod-list.json: added '$modName' (enabled)" -ForegroundColor Green
			} elseif (-not $entry.enabled) {
				$entry.enabled = $true
				Write-Host "  mod-list.json: '$modName' was DISABLED — enabled it" -ForegroundColor Yellow
			} else {
				$needsWrite = $false
				Write-Host "  mod-list.json: '$modName' already enabled" -ForegroundColor Gray
			}
			if ($needsWrite) {
				$backup = "$listPath.bak-surfexp"
				Copy-Item -Path $listPath -Destination $backup -Force
				# Temp + rename: an interrupted in-place write leaves the player with a truncated
				# mod-list.json, which disables every mod they have.
				$tmp = "$listPath.tmp-surfexp"
				$list | ConvertTo-Json -Depth 10 | Set-Content $tmp -Encoding utf8
				Move-Item -Path $tmp -Destination $listPath -Force
				Write-Host "  mod-list.json written (previous copy at $(Split-Path $backup -Leaf))" -ForegroundColor Gray
			}

			$others = Get-ChildItem $clientMods -Filter "${modName}_*.zip" |
				Where-Object { $_.Name -ne "${folder}.zip" }
			if ($others -and $PruneOldClientVersions) {
				$others | Remove-Item -Force
				Write-Host "  pruned $($others.Count) other client copy/copies: $($others.Name -join ', ')" -ForegroundColor Yellow
			} elseif ($others) {
				Write-Host "  $($others.Count) older copy/copies left in place (sync-client-mods refuses NEWER ones): $($others.Name -join ', ')" -ForegroundColor Gray
				Write-Host "  re-run with -PruneOldClientVersions to delete them" -ForegroundColor Gray
			}
			Write-Host "  Factorio reads mods at startup — restart the client if it is open." -ForegroundColor Gray
		}
	} catch {
		Write-Warning "Client sync FAILED — the cluster copy is unaffected and the upload continues: $_"
		Write-Warning "  Your local client may not match the server. Fix and re-run, or pass -SkipClientSync."
	}
}

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
