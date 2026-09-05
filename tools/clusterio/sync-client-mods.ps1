#Requires -Version 7
# requires: docker/seed-data/mods/*.zip (the set the cluster seeds); a local Factorio user dir
# produces: every seed zip present in %APPDATA%/Factorio/mods with byte-identical content — missing
#           zips copied, same-name-different-bytes zips overwritten (stale rebuilds) — and a refusal
#           (throw) when a NEWER version of a seeded mod sits beside it, because Factorio loads the
#           newest zip present; -PruneShadowing deletes those newer zips instead. -ModName scopes
#           copying, validation and pruning to one exact mod name. -ModVersion selects an exact
#           version with -ModName (the gateway builder selects the version it just built).
#           Duplicate seeds are accepted only when filename-last and numeric-newest agree.
# does not: touch mod-list.json, delete client-only mods or OLDER versions, or contact the cluster;
#           a missing client install is a quiet skip

param(
	[switch]$DryRun,
	[switch]$PruneShadowing,
	[ValidatePattern('^[A-Za-z0-9_-]+$')]
	[string]$ModName,
	[ValidatePattern('^\d+\.\d+\.\d+$')]
	[string]$ModVersion
)

$ErrorActionPreference = "Stop"
if ($ModVersion -and -not $ModName) { throw '-ModVersion requires -ModName.' }
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$SeedMods = Join-Path $RepoRoot "docker/seed-data/mods"

if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
	Write-Host "sync-client-mods SKIPPED: `$env:APPDATA is not set" -ForegroundColor Yellow
	return
}
$clientMods = Join-Path $env:APPDATA "Factorio/mods"
if (-not (Test-Path $clientMods)) {
	Write-Host "sync-client-mods SKIPPED: no Factorio user data ($clientMods)" -ForegroundColor Yellow
	return
}

$zips = @(Get-ChildItem -LiteralPath $SeedMods -Filter "*.zip" -File)
if ($zips.Count -eq 0) { throw "No zips under $SeedMods — nothing to sync is a broken premise, not a no-op." }

function Split-ModZipName([string]$fileName) {
	if ($fileName -match '^(?<name>.+)_(?<version>\d+\.\d+\.\d+)\.zip$') {
		return [pscustomobject]@{ Name = $Matches.name; Version = [version]$Matches.version }
	}
	return $null
}

$groups = [System.Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
foreach ($zip in $zips) {
	$parsed = Split-ModZipName $zip.Name
	if ($ModName -and (-not $parsed -or $parsed.Name -cne $ModName)) { continue }
	if (-not $parsed) { throw "Cannot parse seed mod filename '$($zip.Name)' as name_x.y.z.zip." }
	if ($ModVersion -and $parsed.Version -ne [version]$ModVersion) { continue }
	if (-not $groups.ContainsKey($parsed.Name)) { $groups[$parsed.Name] = @() }
	$groups[$parsed.Name] += [pscustomobject]@{ File = $zip; Version = $parsed.Version }
}
if ($groups.Count -eq 0) { throw "No seed zips selected for mod '$ModName'." }

$selected = @()
$latest = [System.Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
foreach ($name in $groups.Keys) {
	$versions = $groups[$name]
	$newest = $versions | Sort-Object Version -Descending | Select-Object -First 1
	# The pinned seed-mods.sh passes a POSIX filename-sorted list to Clusterio's last-write-wins map.
	$names = [string[]]@($versions | ForEach-Object { $_.File.Name })
	[Array]::Sort($names, [StringComparer]::Ordinal)
	if ($names[-1] -cne $newest.File.Name) {
		throw "Ambiguous seed versions for '$name': cluster seeding selects '$($names[-1])' by filename, but the client selects '$($newest.File.Name)' by version. Remove obsolete seed versions before syncing: $($names -join ', '). No client files changed."
	}
	$latest[$name] = $newest.Version
	$selected += $versions | ForEach-Object { $_.File }
}
$zips = @($selected | Sort-Object Name)

# Preflight the complete plan before any copy or deletion; enumerate each client file only once.
$shadowing = @(foreach ($candidate in Get-ChildItem -LiteralPath $clientMods -Filter '*.zip' -File) {
	$parsed = Split-ModZipName $candidate.Name
	if ($parsed -and $latest.ContainsKey($parsed.Name) -and $parsed.Version -gt $latest[$parsed.Name]) {
		$candidate
	}
})
if ($shadowing.Count -gt 0 -and -not $PruneShadowing) {
	throw "NEWER client copies shadow the selected seed versions: $($shadowing.Name -join ', '). No client files changed. Re-run with -PruneShadowing to delete them."
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

foreach ($file in $shadowing) {
	if ($DryRun) {
		Write-Host "  would prune newer: $($file.Name)" -ForegroundColor Yellow
	} else {
		Remove-Item -LiteralPath $file.FullName -Force
		Write-Host "  pruned newer: $($file.Name)" -ForegroundColor Yellow
	}
}

$verb = if ($DryRun) { "would sync" } else { "synced" }
Write-Host "sync-client-mods: $verb $($zips.Count) seed zip(s) -> $clientMods (copied=$($counts.copied) repaired=$($counts.repaired) unchanged=$($counts.unchanged))" -ForegroundColor Cyan
if (($counts.copied + $counts.repaired) -gt 0 -and -not $DryRun) {
	Write-Host "  Factorio reads mods at startup — restart the client if it is open." -ForegroundColor Gray
}
