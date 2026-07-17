# BELT-R10 runner: the insert_at write-frame offset law, one variable (belt tier), rerunnable.
# Per tier, in ONE atomic execution: isolated-belt offset arm (insert_at(0.5) reads back at
# 0.5 - belt_speed exactly), two-belt underflow arm (a below-floor write clamps to the line start), overflow arm (a write past line_length places nothing),
# then full scratch cleanup with a leftover assert.
# The TIER global is injected explicitly on EVERY call (RCON /sc globals persist across
# executions — the lab hazard that once fabricated a duplication claim).
# Evidence lineage: NOTEBOOK BELT-R10 [empirical, 2.0.77].
param(
	[string]$InstanceName = 'surface-export-lab-gallery'
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\..\tools\cluster-utils.ps1"

$raw = Get-Content -Raw "$PSScriptRoot\frame_offset_probe.lua"
$body = (($raw -split "`r?`n") | Where-Object { $_ -notmatch '^\s*--' }) -join ' '

$tiers = @('transport-belt','fast-transport-belt','express-transport-belt','turbo-transport-belt')
$fail = $false
foreach ($tier in $tiers) {
	Write-Host "=== BELT-R10 tier: $tier ==="
	$resp = Send-RCON -InstanceName $InstanceName -Command "/sc TIER='$tier' $body"
	Write-Host $resp
	$j = $null
	try { $j = $resp | ConvertFrom-Json } catch { Write-Host "FAIL: unparseable response"; $fail = $true; break }
	if (-not $j.success) { Write-Host "FAIL: $tier success=false (abort=$($j.abort) error=$($j.error))"; $fail = $true; break }
	if (-not $j.pass) {
		Write-Host "FAIL: $tier (offset_exact=$($j.offset_exact) under_clamp_ok=$($j.under_clamp_ok) over_rejected=$($j.over_rejected) leftover=$($j.cleanup_leftover))"
		$fail = $true; break
	}
}
if ($fail) { exit 1 }
Write-Host "BELT-R10 PASS (all four tiers: offset = belt_speed exactly, underflow clamps to line start, overflow rejects, scratch clean)"
exit 0
