# BELT-R13 runner: paused-platform belt physics, measured on the dedicated feeder-free probe
# strip of lab-omnibus-platform-v1 (six east-facing turbo belts at (-31.5..-26.5, 16.5), dead-end
# at the east end — outside every clone workspace, no feeders in reach).
# Proves the CORRECTED law set (the earlier "engine-frozen" claim is retracted — see NOTEBOOK
# BELT-R13 + RETRACTIONS):
#   1. belts on a paused platform MOVE: seeded items flow east and compress at the dead end,
#      while the seeded total is exactly CONSERVED (distinct-stack census)
#   2. active=true writes to belt-class entities are REJECTED same-execution
#   3. insert_at works on the paused platform and CONSERVES (no duplication)
#   4. cleanup returns the strip to empty (self-contained; zero leftovers)
# CRITICAL (the artifact that faked a duplication hazard, 2026-07-17): Lua globals set by /sc
# PERSIST across RCON executions. Every probe call MUST set MODE explicitly — a read call that
# omits it inherits the previous call's mode and silently re-runs the mutation.
param(
	[string]$InstanceName = 'surface-export-lab-gallery',
	[int]$DriftSeconds = 8
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\..\tools\cluster-utils.ps1"

$raw = Get-Content -Raw "$PSScriptRoot\paused_freeze_probe.lua"
$body = (($raw -split "`r?`n") | Where-Object { $_ -notmatch '^\s*--' }) -join ' '

function Invoke-Probe([string]$mode) {
	if (-not $mode) { $mode = 'read' }
	$cmd = "/sc MODE='$mode' $body"
	$resp = Send-RCON -InstanceName $InstanceName -Command $cmd
	Write-Host $resp
	$j = $resp | ConvertFrom-Json
	if (-not $j.success) { throw "probe failed: abort=$($j.abort) error=$($j.error)" }
	return $j
}

Write-Host "=== BELT-R13: pre-clean + seed ==="
$null = Invoke-Probe 'cleanup'
$s = Invoke-Probe 'seed'
if ($s.seeded -ne 3 -or $s.total -ne 3) { Write-Host "FAIL: seeding (seeded=$($s.seeded) total=$($s.total))"; exit 1 }
if (-not $s.platform_paused) { Write-Host "FAIL: platform not paused — this rung measures the paused regime only"; exit 1 }

Write-Host "=== BELT-R13: movement + conservation window (${DriftSeconds}s) ==="
Start-Sleep -Seconds $DriftSeconds
$t1 = Invoke-Probe $null
if ($t1.tick -le $s.tick) { Write-Host "FAIL: game tick did not advance — instrument invalid"; exit 1 }
if ($t1.total -ne 3) { Write-Host "FAIL: conservation violated after movement window (total=$($t1.total), expected 3)"; exit 1 }
if ($t1.vec -eq $s.vec) { Write-Host "FAIL: items did NOT move ('$($s.vec)' unchanged) — contradicts the movement law; investigate before banking"; exit 1 }

Write-Host "=== BELT-R13: thaw write-rejection (write true -> read -> re-freeze, one execution) ==="
$t2 = Invoke-Probe 'thaw'
if ($t2.active_after_write -ne 0) { Write-Host "FAIL: active=true stuck on $($t2.active_after_write) belts — write-rejection law does not hold"; exit 1 }
if ($t2.total -ne 3) { Write-Host "FAIL: conservation violated by thaw probe (total=$($t2.total))"; exit 1 }

Write-Host "=== BELT-R13: insert conserves ==="
$t4 = Invoke-Probe 'insert'
if (-not $t4.insert_ok) { Write-Host "FAIL: insert_at did not land"; exit 1 }
if ($t4.total -ne 4) { Write-Host "FAIL: total after insert is $($t4.total), expected 4"; exit 1 }

Write-Host "=== BELT-R13: post-insert conservation window (${DriftSeconds}s) ==="
Start-Sleep -Seconds $DriftSeconds
$t5 = Invoke-Probe $null
if ($t5.total -ne 4) { Write-Host "FAIL: conservation violated after insert (total=$($t5.total), expected 4 — a gain here is the retracted-duplication signature, a loss is new)"; exit 1 }

Write-Host "=== BELT-R13: cleanup ==="
$t6 = Invoke-Probe 'cleanup'
if ($t6.total -ne 0) { Write-Host "FAIL: strip not empty after cleanup (total=$($t6.total))"; exit 1 }

Write-Host "BELT-R13 PASS (ticks $($s.tick)..$($t6.tick); movement confirmed, totals conserved 3/3 then 4/4, active-write rejected, strip left empty)"
exit 0
