# BELT-R11 runner: side-scoped reverse-first-fit reconstruction of the saturated green omnibus
# circuit (mixed copper/iron, splitter, underground pair, sideloads) on lab-belt-r10-probe.
# Precondition: the omnibus fixture stands at x 74..86 (y 0..20) on the platform, populated.
# Clone target: x 164..176 (DDX=90, virgin ground east of the R12 clone area).
# Sections: clone (wipe + re-clone geometry incl. loaders/chests + settings), restore (atomic
# side-scoped reconstruction + leak map + verify). PASS is self-grounding: clone-by-name totals
# must equal the same-execution captured source totals; no hardcoded counts.
# Evidence lineage: NOTEBOOK BELT-R11 [empirical, 2.0.77].
param(
	[string]$InstanceName = 'surface-export-lab-gallery',
	[string[]]$Sections = @('clone','restore')
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\..\tools\cluster-utils.ps1"

$raw = Get-Content -Raw "$PSScriptRoot\side_restore_core.lua"
$body = (($raw -split "`r?`n") | Where-Object { $_ -notmatch '^\s*--' }) -join ' '
$params = "SRC_X1=74 SRC_X2=86 DDX=90"

$fail = $false
foreach ($sec in $Sections) {
	Write-Host "=== BELT-R11 section: $sec ==="
	$resp = Send-RCON -InstanceName $InstanceName -Command "/sc $params MODE='$sec' $body"
	Write-Host $resp
	$j = $null
	try { $j = $resp | ConvertFrom-Json } catch { Write-Host "FAIL: unparseable response: $($_.Exception.Message)"; $fail = $true; break }
	if (-not $j.success) { Write-Host "FAIL: section '$sec' success=false (abort=$($j.abort) error=$($j.error))"; $fail = $true; break }
	if ($sec -eq 'restore' -and -not $j.pass) { Write-Host "FAIL: restore pass=false (stop=$($j.stop))"; $fail = $true; break }
}
if ($fail) { exit 1 }
Write-Host "BELT-R11 PASS"
exit 0
