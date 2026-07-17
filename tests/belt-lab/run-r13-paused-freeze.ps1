# BELT-R13 runner: paused-platform belt freeze law, measured on the dedicated feeder-free probe
# strip of lab-omnibus-platform-v1 (six turbo belts at (-31.5..-26.5, 16.5) — outside every clone
# workspace, no feeders in reach).
# Proves:
#   1. seeded items hold position across elapsed ticks (per-line vector stable, tick advancing)
#   2. active=true writes to belts are REJECTED same-execution on a paused platform
#   3. insert_at works on the frozen lines, and the inserted item also holds position
#   4. cleanup returns the strip to empty (self-contained; leaves zero leftovers)
# All handles are fetched fresh per execution (BELT-R14: aged handles double-materialize).
# Evidence lineage: NOTEBOOK BELT-R13 [empirical, 2.0.77].
param(
	[string]$InstanceName = 'surface-export-lab-gallery',
	[int]$DriftSeconds = 8
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\..\tools\cluster-utils.ps1"

$raw = Get-Content -Raw "$PSScriptRoot\paused_freeze_probe.lua"
$body = (($raw -split "`r?`n") | Where-Object { $_ -notmatch '^\s*--' }) -join ' '

# CRITICAL (the artifact that faked a duplication hazard, 2026-07-17): Lua globals set by /sc
# PERSIST across RCON executions. Every probe call MUST set MODE explicitly — a read call that
# omits it inherits the previous call's mode and silently re-runs the mutation.
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

Write-Host "=== BELT-R13: frozen drift window (${DriftSeconds}s) ==="
Start-Sleep -Seconds $DriftSeconds
$t1 = Invoke-Probe $null
if ($t1.tick -le $s.tick) { Write-Host "FAIL: game tick did not advance — instrument invalid"; exit 1 }
if ($t1.vec -ne $s.vec) { Write-Host "FAIL: seeded items drifted while frozen ('$($s.vec)' -> '$($t1.vec)')"; exit 1 }

Write-Host "=== BELT-R13: thaw write-rejection (write true -> read -> re-freeze, one execution) ==="
$t2 = Invoke-Probe 'thaw'
if ($t2.active_after_write -ne 0) { Write-Host "FAIL: active=true stuck on $($t2.active_after_write) belts — freeze law does not hold"; exit 1 }

Write-Host "=== BELT-R13: post-thaw drift window (${DriftSeconds}s) ==="
Start-Sleep -Seconds $DriftSeconds
$t3 = Invoke-Probe $null
if ($t3.vec -ne $s.vec) { Write-Host "FAIL: items drifted after thaw attempt"; exit 1 }

Write-Host "=== BELT-R13: insert on frozen ==="
$t4 = Invoke-Probe 'insert'
if (-not $t4.insert_on_frozen) { Write-Host "FAIL: insert_at did not land on the frozen line"; exit 1 }
if ($t4.total -ne 4) { Write-Host "FAIL: total after insert is $($t4.total), expected 4"; exit 1 }

Write-Host "=== BELT-R13: inserted item holds (${DriftSeconds}s) ==="
Start-Sleep -Seconds $DriftSeconds
$t5 = Invoke-Probe $null
if ($t5.vec -ne $t4.vec) { Write-Host "FAIL: vector drifted after insert ('$($t4.vec)' -> '$($t5.vec)')"; exit 1 }
if ($t5.total -ne 4) { Write-Host "FAIL: total drifted after insert ($($t5.total) != 4) — see BELT-R14 double-materialization"; exit 1 }

Write-Host "=== BELT-R13: cleanup ==="
$t6 = Invoke-Probe 'cleanup'
if ($t6.total -ne 0) { Write-Host "FAIL: strip not empty after cleanup (total=$($t6.total))"; exit 1 }

Write-Host "BELT-R13 PASS (ticks $($s.tick)..$($t6.tick); frozen windows stable, active-write rejected, insert+hold verified, strip left empty)"
exit 0
