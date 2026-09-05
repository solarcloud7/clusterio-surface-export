#Requires -Version 7
# requires: docker/seed-data/mods/*.zip (the set the cluster seeds); a local Factorio user dir
# produces: every seed zip present in %APPDATA%/Factorio/mods with byte-identical content —
#           missing zips copied, same-name-different-hash zips overwritten (stale rebuilds)
# does not: touch mod-list.json, delete client-only mods or older versions, or contact the
#           cluster — file presence and bytes only; a missing client install is a quiet skip

param(
	[switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$SeedMods = Join-Path $RepoRoot "docker/seed-data/mods"

$appData = $env:APPDATA
$clientMods = if ([string]::IsNullOrWhiteSpace($appData)) { $null } else { Join-Path $appData "Factorio/mods" }
if (-not $clientMods -or -not (Test-Path $clientMods)) {
	$where = if ($clientMods) { $clientMods } else { '$env:APPDATA is not set' }
	Write-Host "sync-client-mods SKIPPED: no Factorio user data ($where)" -ForegroundColor Yellow
	exit 0
}

$zips = @(Get-ChildItem $SeedMods -Filter "*.zip")
if ($zips.Count -eq 0) { throw "No zips under $SeedMods — nothing to sync is a broken premise, not a no-op." }

$copied = 0; $repaired = 0; $unchanged = 0
foreach ($zip in $zips) {
	$dest = Join-Path $clientMods $zip.Name
	if (-not (Test-Path $dest)) {
		if (-not $DryRun) { Copy-Item $zip.FullName $dest }
		Write-Host "  copied:   $($zip.Name)" -ForegroundColor Green
		$copied++
		continue
	}
	$srcHash = (Get-FileHash $zip.FullName -Algorithm SHA256).Hash
	$dstHash = (Get-FileHash $dest -Algorithm SHA256).Hash
	if ($srcHash -ne $dstHash) {
		if (-not $DryRun) { Copy-Item $zip.FullName $dest -Force }
		Write-Host "  repaired: $($zip.Name) (client bytes differed under the same filename)" -ForegroundColor Yellow
		$repaired++
	} else {
		$unchanged++
	}
}

$verb = if ($DryRun) { "would sync" } else { "synced" }
Write-Host "sync-client-mods: $verb $($zips.Count) seed zip(s) -> $clientMods (copied=$copied repaired=$repaired unchanged=$unchanged)" -ForegroundColor Cyan
if (($copied + $repaired) -gt 0 -and -not $DryRun) {
	Write-Host "  Factorio reads mods at startup — restart the client if it is open." -ForegroundColor Gray
}
