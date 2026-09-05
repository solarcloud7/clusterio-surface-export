#Requires -Version 7
# requires: docker/seed-data/mods/*.zip (the set the cluster seeds); a local Factorio user dir
# produces: every seed zip present in %APPDATA%/Factorio/mods with byte-identical content — missing
#           zips copied, same-name-different-bytes zips overwritten (stale rebuilds) — and a refusal
#           (throw) when a NEWER version of a seeded mod sits beside it, because Factorio loads the
#           newest zip present; -PruneShadowing deletes those newer zips instead
# does not: touch mod-list.json, delete client-only mods or OLDER versions, or contact the cluster;
#           a missing client install is a quiet skip

param(
	[switch]$DryRun,
	[switch]$PruneShadowing
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$SeedMods = Join-Path $RepoRoot "docker/seed-data/mods"

if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
	Write-Host "sync-client-mods SKIPPED: `$env:APPDATA is not set" -ForegroundColor Yellow
	exit 0
}
$clientMods = Join-Path $env:APPDATA "Factorio/mods"
if (-not (Test-Path $clientMods)) {
	Write-Host "sync-client-mods SKIPPED: no Factorio user data ($clientMods)" -ForegroundColor Yellow
	exit 0
}

$zips = @(Get-ChildItem $SeedMods -Filter "*.zip")
if ($zips.Count -eq 0) { throw "No zips under $SeedMods — nothing to sync is a broken premise, not a no-op." }

function Split-ModZipName([string]$fileName) {
	if ($fileName -match '^(?<name>.+)_(?<version>\d+\.\d+\.\d+)\.zip$') {
		return [pscustomobject]@{ Name = $Matches.name; Version = [version]$Matches.version }
	}
	return $null
}

$counts = @{ copied = 0; repaired = 0; unchanged = 0 }
foreach ($zip in $zips) {
	$dest = Join-Path $clientMods $zip.Name
	$state = if (-not (Test-Path $dest)) { "copied" }
		elseif ((Get-Item $dest).Length -ne $zip.Length) { "repaired" }
		elseif ((Get-FileHash $zip.FullName -Algorithm SHA256).Hash -ne (Get-FileHash $dest -Algorithm SHA256).Hash) { "repaired" }
		else { "unchanged" }
	if ($state -ne "unchanged") {
		if (-not $DryRun) { Copy-Item $zip.FullName $dest -Force }
		$note = if ($state -eq "repaired") { " (client bytes differed under the same filename)" } else { "" }
		Write-Host "  ${state}: $($zip.Name)$note" -ForegroundColor $(if ($state -eq "copied") { "Green" } else { "Yellow" })
	}
	$counts[$state]++
}

$shadowing = @()
foreach ($zip in $zips) {
	$seed = Split-ModZipName $zip.Name
	if (-not $seed) { continue }
	foreach ($candidate in Get-ChildItem $clientMods -Filter "$($seed.Name)_*.zip") {
		$parsed = Split-ModZipName $candidate.Name
		if ($parsed -and $parsed.Name -eq $seed.Name -and $parsed.Version -gt $seed.Version) { $shadowing += $candidate }
	}
}
if ($shadowing.Count -gt 0 -and $PruneShadowing -and -not $DryRun) {
	foreach ($file in $shadowing) {
		Remove-Item $file.FullName -Force
		Write-Host "  pruned newer: $($file.Name)" -ForegroundColor Yellow
	}
	$shadowing = @()
}

$verb = if ($DryRun) { "would sync" } else { "synced" }
Write-Host "sync-client-mods: $verb $($zips.Count) seed zip(s) -> $clientMods (copied=$($counts.copied) repaired=$($counts.repaired) unchanged=$($counts.unchanged))" -ForegroundColor Cyan
if (($counts.copied + $counts.repaired) -gt 0 -and -not $DryRun) {
	Write-Host "  Factorio reads mods at startup — restart the client if it is open." -ForegroundColor Gray
}
if ($shadowing.Count -gt 0) {
	throw "NEWER client copies shadow the seeded versions and Factorio loads the newest zip present: $($shadowing.Name -join ', '). A join would be refused on a mod-version mismatch. Re-run with -PruneShadowing to delete them."
}
