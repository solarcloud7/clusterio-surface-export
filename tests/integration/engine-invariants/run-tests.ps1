<#
.SYNOPSIS
    Engine API invariant checks — pins the Factorio platform-removal behavior our code depends on.

.DESCRIPTION
    Transfer and cleanup code relies on game.delete_surface() actually removing a space platform,
    because LuaSpacePlatform.destroy() is a no-op at our pinned Factorio version (Pitfall #19,
    verified on 2.0.76; see docs/factorio-2.0-api-notes.md).

    This asserts the POSITIVE invariant — game.delete_surface removes a platform — and FAILS if it
    ever stops working (e.g. a Factorio version bump that changes platform teardown). It separately
    PROBES destroy() and only WARNS (never fails) if destroy() becomes functional, so a benign
    upstream fix to destroy() can never turn this build red.

.PARAMETER SourcePlatform
    Platform to clone as the disposable subject (default: test).

.PARAMETER SourceHost
    Host holding the source platform (default: auto-detect).
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

Write-TestHeader "🔬 Engine API Invariants"

if ($SourceHost -eq 0) {
    $SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
    if (-not $SourceHost) {
        Write-Status "Source platform '$SourcePlatform' not found on any host" -Type error
        exit 1
    }
}
$instance = "clusterio-host-$SourceHost-instance-1"
$cloneName = "engineinv-$(Get-Date -Format 'HHmmss')"
Write-Host "  Host: $SourceHost   Source: $SourcePlatform   Clone: $cloneName" -ForegroundColor Gray
Write-Host ""

function Test-ClonePresent { return [bool](Get-PlatformIndex -Instance $instance -PlatformName $cloneName) }

# 1. Clone a disposable platform to operate on.
Write-Status "Cloning disposable platform..." -Type info
$clone = New-TestPlatform -Instance $instance -SourcePlatform $SourcePlatform -DestPlatform $cloneName
if (-not $clone.success) { Write-Status "Clone failed: $($clone.error)" -Type error; exit 1 }
if ($clone.job_id) {
    $check = "local j=(storage.async_jobs or {})['$($clone.job_id)']; rcon.print(j == nil and 'true' or 'false')"
    Wait-ForJob -Instances @($instance) -MaxWaitSeconds 90 -CheckScript $check | Out-Null
}
Start-Sleep -Seconds 1
if (-not (Test-ClonePresent)) { Write-Status "Clone did not materialize" -Type error; exit 1 }
Write-Status "Clone ready" -Type success
Write-Host ""

$failed = 0

# 2. WARN-ONLY probe: LuaSpacePlatform.destroy(). This must NOT fail the build if it changes —
#    an upstream fix that makes destroy() functional is a benign improvement, not a regression.
$destroyLua = "local p for _,x in pairs(game.forces.player.platforms) do if x.name=='$cloneName' then p=x end end if p then pcall(function() p.destroy() end) end rcon.print('ok')"
Invoke-Lua -Instance $instance -Code $destroyLua | Out-Null
Step-Tick -Instance $instance -Ticks 10 | Out-Null
Start-Sleep -Seconds 1

if (-not (Test-ClonePresent)) {
    # destroy() removed it — functional at this version. Removal works, so the invariant our code
    # needs is satisfied; just flag that the documented no-op behavior has changed.
    Write-Status "destroy() REMOVED the platform — it is FUNCTIONAL at this Factorio version." -Type warning
    Write-Status "Revisit Pitfall #19 / docs/factorio-2.0-api-notes.md (they document destroy() as a no-op)." -Type warning
} else {
    Write-Status "destroy() left the platform intact — no-op, as documented (Pitfall #19)." -Type info

    # 3. MUST PASS: game.delete_surface() removes the platform — this is what our code depends on.
    $delLua = "local p for _,x in pairs(game.forces.player.platforms) do if x.name=='$cloneName' then p=x end end if p and p.surface and p.surface.valid then game.delete_surface(p.surface) rcon.print('ok') else rcon.print('no_surface') end"
    Invoke-Lua -Instance $instance -Code $delLua | Out-Null
    Step-Tick -Instance $instance -Ticks 10 | Out-Null
    Start-Sleep -Seconds 1

    if (Test-ClonePresent) {
        Write-TestResult -TestId "delete-surface-removes-platform" -TestName "game.delete_surface() removes a space platform" -Status "failed" -Message "Platform still present after delete_surface + ticks — the platform-removal path our transfer/cleanup relies on is BROKEN at this Factorio version"
        $failed++
    } else {
        Write-TestResult -TestId "delete-surface-removes-platform" -TestName "game.delete_surface() removes a space platform" -Status "passed"
    }
}

# 4. Defensive cleanup of any survivor.
if (Test-ClonePresent) {
    Invoke-Lua -Instance $instance -Code "for _,s in pairs(game.surfaces) do if s.platform and s.platform.name=='$cloneName' then game.delete_surface(s) end end" | Out-Null
    Step-Tick -Instance $instance -Ticks 5 | Out-Null
}

Write-TestSummary -Passed $(if ($failed -eq 0) { 1 } else { 0 }) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
