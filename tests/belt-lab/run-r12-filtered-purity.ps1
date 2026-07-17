# BELT-R12 runner: side-scoped reconstruction of the owner's filtered-splitter fixture with the
# post-filter purity gate (items past a filter must not re-mix: every source-pure lane side must
# reconstruct single-name). Also proves splitter filter/priority + loader-filter settings clone.
# Precondition: the filtered fixture stands at x 100..121 (y 0..20) on lab-belt-r10-probe.
# Clone target: x 135..156 (DDX=35). PASS is self-grounding (same-execution source capture).
# Evidence lineage: NOTEBOOK BELT-R12 [empirical, 2.0.77].
param(
	[string]$InstanceName = 'surface-export-lab-gallery',
	[string[]]$Sections = @('clone','restore')
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\..\tools\cluster-utils.ps1"

$raw = Get-Content -Raw "$PSScriptRoot\side_restore_core.lua"
$body = (($raw -split "`r?`n") | Where-Object { $_ -notmatch '^\s*--' }) -join ' '
$params = "SRC_X1=100 SRC_X2=121 DDX=35"

$fail = $false
foreach ($sec in $Sections) {
	Write-Host "=== BELT-R12 section: $sec ==="
	$resp = Send-RCON -InstanceName $InstanceName -Command "/sc $params MODE='$sec' $body"
	Write-Host $resp
	$j = $null
	try { $j = $resp | ConvertFrom-Json } catch { Write-Host "FAIL: unparseable response: $($_.Exception.Message)"; $fail = $true; break }
	if (-not $j.success) { Write-Host "FAIL: section '$sec' success=false (abort=$($j.abort) error=$($j.error))"; $fail = $true; break }
	if ($sec -eq 'restore') {
		if (-not $j.pass) { Write-Host "FAIL: restore pass=false (stop=$($j.stop))"; $fail = $true; break }
		if (-not $j.purity_ok) { Write-Host "FAIL: purity gate violated"; $fail = $true; break }
		if ($j.pure_sides -lt 1) { Write-Host "FAIL: fixture degenerate — no pure sides found (purity gate had nothing to test)"; $fail = $true; break }
	}
}
if ($fail) { exit 1 }
Write-Host "BELT-R12 PASS"
exit 0
