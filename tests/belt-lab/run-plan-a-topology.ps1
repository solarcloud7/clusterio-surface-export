<#
.SYNOPSIS
    Reproduce the DUP-233855 baseline and the topology-first Phase A stop on Factorio 2.0.77.

.DESCRIPTION
    Imports the banked replay five times, asserts the deterministic -5 belt-phase deficit and existing
    recovery, extracts populated and cleared LuaTransportLine graphs from the first disposable replay,
    copies the raw graph JSON to an external evidence directory, and runs the canonical-ID analyzer.

    Every mutated platform name begins with plan-a-dup-control-. Cleanup runs in finally on both success
    and failure, unpauses the game, deletes only matching disposable surfaces, removes generated in-game
    files, and asserts zero jobs/locks/holds.
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$PayloadPath,
    [Parameter(Mandatory=$true)]
    [string]$BlackBoxPath,
    [int]$Runs = 5,
    [int]$TimeoutSec = 120,
    [string]$EvidenceDir = "C:\tmp\factorio-plan-a-phase-a"
)

$ErrorActionPreference = "Stop"
$modulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "integration\lib\TestBase.psm1"
Import-Module $modulePath -Force

$instance = "clusterio-host-2-instance-1"
$container = "surface-export-host-2"
$controller = "surface-export-controller"
$scriptOut = "/clusterio/data/instances/$instance/script-output"
$tag = Get-Date -Format "yyyyMMdd-HHmmss"
$prefix = "plan-a-dup-control-$tag-"
$controllerPayload = "/tmp/plan-a-DUP-233855-$tag.json"
$topologyScript = Get-Content -Raw (Join-Path $PSScriptRoot "plan_a_topology_probe.lua")
$analyzer = Join-Path $PSScriptRoot "analyze_plan_a_topology.mjs"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$payloadFull = (Resolve-Path $PayloadPath).Path
$blackBoxFull = (Resolve-Path $BlackBoxPath).Path
$instanceId = Get-ClusterioInstanceId -InstanceName $instance
if (-not $instanceId) { throw "could not resolve $instance" }

function Invoke-ProbeJson([string]$Code) {
    $raw = Invoke-Lua -Instance $instance -Code $Code
    try { return $raw | ConvertFrom-Json }
    catch { throw "invalid JSON from ${instance}: $raw" }
}

function Wait-ForImport([string]$Name) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        Start-Sleep -Milliseconds 500
        $state = Invoke-ProbeJson @"
local found=false
for _,p in pairs(game.forces.player.platforms or {}) do
  if p.valid and p.name=='$Name' then found=true end
end
local jobs=0 for _ in pairs(storage.async_jobs or {}) do jobs=jobs+1 end
rcon.print(helpers.table_to_json({found=found,jobs=jobs}))
"@
    } while ((-not $state.found -or $state.jobs -ne 0) -and (Get-Date) -lt $deadline)
    if (-not $state.found -or $state.jobs -ne 0) { throw "import timed out: $Name" }
}

function Remove-DisposablePlatforms {
    return Invoke-ProbeJson @"
local deleted={}
local delete_failures={}
game.tick_paused=false
for _,s in pairs(game.surfaces) do
  local p=s.platform
  if p and p.valid and string.find(p.name,'$prefix',1,true)==1 then
    pcall(function() remote.call('surface_export','unlock_platform',p.index) end)
    local name=p.name
    local ok,err=pcall(function() game.delete_surface(s) end)
    if ok then deleted[#deleted+1]=name
    else delete_failures[#delete_failures+1]={name=name,error=tostring(err)} end
  end
end
__belt_plan_a_platform_name=nil
local jobs=0 for _ in pairs(storage.async_jobs or {}) do jobs=jobs+1 end
local locks=0 for _ in pairs(storage.locked_platforms or {}) do locks=locks+1 end
local holds=0 for _ in pairs(storage.destination_holds or {}) do holds=holds+1 end
rcon.print(helpers.table_to_json({deleted=deleted,delete_failures=delete_failures,delete_failure_count=#delete_failures,jobs=jobs,locks=locks,holds=holds,paused=game.tick_paused}))
"@
}

$runEvidence = @()
$graphFiles = @()
try {
    Assert-FactorioVersion -Instance $instance | Out-Null
    New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
    docker cp $payloadFull "${controller}:$controllerPayload" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "failed to copy replay payload into controller" }

    for ($run = 1; $run -le $Runs; $run++) {
        $name = "$prefix$run"
        $logStart = [int](docker exec $container sh -c "wc -l < $scriptOut/../factorio-current.log")
        $upload = docker exec $controller sh -c "npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error surface-export upload-import $controllerPayload $instanceId player $name"
        if ($LASTEXITCODE -ne 0) { throw "upload-import failed for run ${run}: $upload" }
        Wait-ForImport -Name $name

        $log = docker exec $container sh -c "tail -n +$($logStart + 1) $scriptOut/../factorio-current.log"
        $beltLine = @($log | Select-String -SimpleMatch "596 belts: expected=15866 actual=15861 delta=-5 consolidated_lines=47")
        $recoveryLine = @($log | Select-String -SimpleMatch "Aggregate deficit recovery: recovered=5 to hub/ground, unrecovered=0")
        if ($beltLine.Count -ne 1 -or $recoveryLine.Count -ne 1) {
            throw "run $run did not reproduce exact -5 plus recovery (belt=$($beltLine.Count), recovery=$($recoveryLine.Count))"
        }
        $runEvidence += [pscustomobject]@{run=$run; platform=$name; belt_delta=-5; recovery=5; unrecovered=0}

        if ($run -eq 1) {
            $raw = Send-Rcon -Instance $instance -Command ("/sc __belt_plan_a_platform_name='$name'; " + $topologyScript)
            $summaryLine = $raw | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
            if (-not $summaryLine) { throw "topology probe returned no JSON" }
            $summary = $summaryLine | ConvertFrom-Json
            if ($summary.populated.nodes -ne 1490 -or $summary.cleared.nodes -ne 1490) { throw "unexpected topology node count" }

            foreach ($filename in @($summary.populated_file, $summary.cleared_file)) {
                $local = Join-Path $EvidenceDir $filename
                docker cp "${container}:$scriptOut/$filename" $local | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "failed to copy raw topology evidence $filename" }
                $graphFiles += $local
            }

            $analysisRaw = & node $analyzer $graphFiles[0] $graphFiles[1] $payloadFull $blackBoxFull
            $analysisExit = $LASTEXITCODE
            $analysisText = $analysisRaw -join "`n"
            $analysis = $analysisText | ConvertFrom-Json
            $analysisText | Set-Content -LiteralPath (Join-Path $EvidenceDir "plan-a-topology-analysis-$tag.json")
            if ($analysisExit -eq 0 -or $analysis.knownChain.oneToOneEligible -ne $false) {
                throw "expected the approved one-to-one eligibility rule to stop on the known endpoints"
            }
            Invoke-Lua -Instance $instance -Code "game.tick_paused=false;rcon.print('unpaused')" | Out-Null
        }

        Remove-DisposablePlatforms | Out-Null
    }

    $runEvidence | ConvertTo-Json -Depth 4
    Write-Host "Raw graph and analyzer evidence: $EvidenceDir"
    Write-Host "PHASE A STOP REPRODUCED: exact known loss endpoints are in ambiguous components."
}
finally {
    try {
        $cleanup = Remove-DisposablePlatforms
        if ($cleanup.delete_failure_count -ne 0 -or $cleanup.jobs -ne 0 -or $cleanup.locks -ne 0 -or $cleanup.holds -ne 0 -or $cleanup.paused -ne $false) {
            throw "cleanup not zero: $($cleanup | ConvertTo-Json -Compress)"
        }
    } catch { Write-Error "Phase A cleanup failed: $_" }
    try { docker exec $container sh -c "rm -f $scriptOut/plan_a_topology_*${prefix}*.json" | Out-Null } catch {}
    try { docker exec $controller sh -c "rm -f $controllerPayload" | Out-Null } catch {}
}
