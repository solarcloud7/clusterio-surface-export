param(
    [switch]$Help = $false,
    [switch]$LuaOnly = $false,
    [switch]$SkipIncrement,
    [ValidateRange(1, 3600)][int]$StartTimeoutSec = 180,
    [ValidateRange(1, 3600)][int]$StopTimeoutSec = 420
)

if ($Help) {
    Write-Host @"
Patch and Reset Instances
==========================

Hot-reloads plugin code (Lua + TypeScript + web) and resets instances to seed save without
rebuilding containers. Use this only when deliberately resetting fixture state.

Usage:
    .\patch-and-reset.ps1            # full: rebuild dist (node + web), reset worlds to the
                                     # seed saves (keeps every save), restart
    .\patch-and-reset.ps1 -LuaOnly   # fast path: SKIP the ~3-min container build; Lua is
                                     # save-patched from source, so dist/ is untouched by a
                                     # module/*.lua-only change. REFUSES to run if any build
                                     # input (lib/, shared/, web/, root TS and tsconfig files,
                                     # webpack.config.js, scripts/build-web.mjs,
                                     # scripts/web-assets.mjs) is newer than the build stamp
                                     # of dist/node or dist/web (a stale dist would silently
                                     # ship old plugin code).

This script:
1. Bumps stable plugin versions unless -SkipIncrement is set. Prereleases require -SkipIncrement.
2. Builds plugin artifacts (dist/node + dist/web) via tools/clusterio/build-plugin.ps1 — an isolated
   node:24 container, so it never pollutes the running cluster's bind-mounted node_modules
   (skipped by -LuaOnly, guarded by the staleness tripwire above)
3. Stops Factorio instances (keeps controller running), then archives each instance's
   surface_export_source_retirements.json by renaming it to
   surface_export_source_retirements.<yyyyMMdd-HHmmss>.bak.json in the same directory. The seed
   saves start a new world, so the old recovery history no longer applies; nothing is deleted
4. Uploads the seed saves (deliberate fixture reset). Existing saves, autosaves and backups
   are kept; nothing is deleted. Each upload is stored under a new name, which the boot check
   below requires each instance to have loaded
5. Restarts all containers (hosts + controller) — hosts load the new dist/node and re-patch
   saves with the latest Lua; the controller re-reads dist/web/manifest.json. Each instance start
   is bounded by -StartTimeoutSec (default 180). A start that does not return is diagnosed, its
   instance is stopped within -StopTimeoutSec (default 420, above the instances'
   factorio.shutdown_timeout of 300) and started once more on the same save; a second timeout
   fails the reset
6. BOOT CHECK: polls until both instances report running AND answer RCON with the plugin's
   remote interface present — a Lua error at save-load kills the headless server (exit 255),
   and before this check the only signal was the server dying later. It then runs
   tools/tests/cluster-readiness.mjs --runtime, which waits for startup source recovery and fails
   at once when the host log records a refused recovery.

Note: For code updates that preserve game state use deploy.ps1 -Scope plugin -KeepSaves.
      The pinned Clusterio host can patch existing saves before starting Factorio.

      For a web-ONLY or TypeScript-ONLY change you do NOT need this heavy reset — use
      ./tools/clusterio/deploy.ps1 -Scope artifacts -Target web -RestartController
      (or -Target node -RestartHosts) instead.
      NB: never use backticks in this help text. It is an expandable here-string, so PowerShell
      reads a backtick as its ESCAPE character: a markdown-style quote around 'tools/...' printed
      as a literal TAB followed by 'ools/...' for months before anyone ran -Help and noticed.
"@
    exit 0
}

$ErrorActionPreference = "Stop"
. "$PSScriptRoot/../shared/workflow-lock.ps1"
. "$PSScriptRoot/../shared/cluster-utils.ps1"
Assert-DevelopmentClusterCheckout
Invoke-WorkflowLock {

Write-Host "=== Patch and Reset Instances ===" -ForegroundColor Cyan
Write-Host ""

$WorkspaceRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

if ($LuaOnly) {
    try {
        Assert-PluginArtifactsFresh -Remedy ("A stale dist would ship old plugin code. Use 'deploy.ps1 -Scope plugin -ResetSaves' (builds AND resets), " +
            "or call this script directly without -LuaOnly. Tree being checked: $WorkspaceRoot")
    } catch {
        throw "-LuaOnly refused: $($_.Exception.Message)"
    }
    Write-Host "LuaOnly: dist/ is fresh — container build will be skipped" -ForegroundColor Yellow
    Write-Host ""
}

Write-Host "Reading plugin version..." -ForegroundColor Yellow
$PluginJsonPath = Join-Path $WorkspaceRoot "docker/seed-data/external_plugins/surface_export/package.json"
$ModuleJsonPath = Join-Path $WorkspaceRoot "docker/seed-data/external_plugins/surface_export/module/module.json"

$PluginJson = Get-Content $PluginJsonPath -Raw | ConvertFrom-Json
. "$PSScriptRoot/../shared/version-utils.ps1"
$NewVersion = if ($SkipIncrement) { $PluginJson.version } else { Get-NextPluginVersion $PluginJson.version }
Write-Host "  $($PluginJson.version) → $NewVersion" -ForegroundColor Green

Update-JsonVersion -Path $PluginJsonPath -NewVersion $NewVersion

if (Test-Path $ModuleJsonPath) {
    Update-JsonVersion -Path $ModuleJsonPath -NewVersion $NewVersion
}

Update-PackageLockVersion -LockPath (Join-Path $WorkspaceRoot "docker/seed-data/external_plugins/surface_export/package-lock.json") -NewVersion $NewVersion
Update-ModuleVersionStamp -ModuleDir (Join-Path $WorkspaceRoot "docker/seed-data/external_plugins/surface_export/module") -NewVersion $NewVersion
$ModuleBuildId = Update-ModuleBuildStamp -ModuleDir (Join-Path $WorkspaceRoot "docker/seed-data/external_plugins/surface_export/module")
Write-Host "✓ Version updated" -ForegroundColor Green
Write-Host ""

if ($LuaOnly) {
    Write-Host "✓ LuaOnly: container build skipped (dist/ verified fresh before the version bump)" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host "Building plugin artifacts (node + web)..." -ForegroundColor Yellow
    & "$PSScriptRoot/build-plugin.ps1" all
    if ($LASTEXITCODE -ne 0) {
        throw "Plugin build failed"
    }
    Write-Host "✓ Plugin artifacts built" -ForegroundColor Green
    Write-Host ""
}

Write-Host "Checking cluster status..." -ForegroundColor Yellow
$controllerStatus = docker ps --filter "name=surface-export-controller" --format "{{.Status}}"
if (-not $controllerStatus) {
    Write-Host "ERROR: Clusterio controller is not running. Start cluster first with:" -ForegroundColor Red
    Write-Host "  docker compose up -d" -ForegroundColor Red
    throw "Clusterio controller is not running — start the cluster first (docker compose up -d)."
}
Write-Host "✓ Controller running" -ForegroundColor Green

Write-Host ""
$ctlConfig = @("--config", "/clusterio/tokens/config-control.json")

function Invoke-Step {
    param(
        [Parameter(Mandatory=$true)][string]$What,
        [Parameter(Mandatory=$true)][scriptblock]$Command,
        [switch]$AllowFail
    )
    $out = & $Command 2>&1
    $code = $LASTEXITCODE
    $text = ($out | Out-String).Trim()
    if ($code -ne 0) {
        if ($AllowFail) {
            Write-Host "  ~ $What — non-fatal failure (exit $code): $text" -ForegroundColor DarkYellow
        } else {
            Write-Host "  X $What FAILED (exit $code)" -ForegroundColor Red
            if ($text) { Write-Host "    $text" -ForegroundColor Red }
            throw "$What failed (exit $code). Refusing to continue and report a false success."
        }
    } elseif ($text -match 'error|Missing URL|not recognized|Cannot') {
        Write-Host "  ! $What — exit 0 but output looks like an error: $text" -ForegroundColor Yellow
    }
    return $text
}

function Invoke-InstanceLifecycle {
    param(
        [Parameter(Mandatory=$true)][string]$What,
        [Parameter(Mandatory=$true)][string]$BenignPattern,
        [Parameter(Mandatory=$true)][scriptblock]$Command
    )
    $out = Invoke-Step $What -AllowFail $Command
    if ($LASTEXITCODE -ne 0) {
        if ($out -match $BenignPattern) {
            Write-Host "    (already in the desired state — continuing)" -ForegroundColor DarkGray
        } else {
            throw "$What failed (exit $LASTEXITCODE): $out"
        }
    }
}


Write-Host "Saving every running instance before restart (no silent data loss)..." -ForegroundColor Yellow

$instanceList = Invoke-Step "enumerate running instances" {
    docker exec surface-export-controller npx clusterioctl $ctlConfig --log-level error instance list
}

$listedInstances = @(ConvertFrom-InstanceList -Raw @($instanceList | ForEach-Object { "$_" }))
$seedInstances = @{}
foreach ($seed in Get-SeededInstances) { $seedInstances[$seed.HostNumber] = $seed }
$hostInstances = @{}
foreach ($h in 1, 2) {
    $record = Select-InstanceForHost -Instances $listedInstances -HostNumber "$h" -SeedName $seedInstances[$h].Instance
    $hostInstances[$h] = [pscustomobject]@{ Id = $record.Id; Name = $record.Name; Dir = Get-InstanceDataDir -InstanceId $record.Id -HostNumber "$h" }
}

$pendingSaves = @()
foreach ($running in ($listedInstances | Where-Object { $_.Status -eq 'running' })) {
    $inst = $running.Name
    $hostContainer = "surface-export-host-$($running.Host)"
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Invoke-Step "save $inst before restart" -AllowFail {
        docker exec surface-export-controller npx clusterioctl $ctlConfig --log-level error `
            instance send-rcon $running.Id "/sc game.server_save('predeploy-$stamp')"
    } | Out-Null
    $pendingSaves += [pscustomobject]@{
        Instance  = $inst
        Container = $hostContainer
        Path      = "$(Get-InstanceDataDir -InstanceId $running.Id -HostNumber $running.Host)/saves/predeploy-$stamp.zip"
    }
}

if ($pendingSaves.Count -eq 0) {
    Write-Host "  (no running instances to save)" -ForegroundColor Gray
} else {
    Write-Host "  Waiting for save writes to land on disk..." -ForegroundColor Gray
    $saveDeadline = (Get-Date).AddSeconds(120)
    foreach ($p in $pendingSaves) {
        $lastSize = -1; $stable = 0; $landed = $false
        while ((Get-Date) -lt $saveDeadline) {
            $sizeText = (docker exec $p.Container sh -c "stat -c %s '$($p.Path)' 2>/dev/null" 2>&1 | Out-String).Trim()
            if ($sizeText -match '^\d+$') {
                $size = [int64]$sizeText
                if ($size -gt 0 -and $size -eq $lastSize) { $stable++ } else { $stable = 0 }
                $lastSize = $size
                if ($stable -ge 2) { $landed = $true; break }
            }
            Start-Sleep -Milliseconds 500
        }
        if ($landed) {
            Write-Host "    ✓ $($p.Instance): $([math]::Round($lastSize/1MB,2)) MB" -ForegroundColor Green
        } else {
            throw "Rescue save for '$($p.Instance)' never landed at $($p.Path) within 120s. Refusing to restart containers over unsaved work."
        }
    }
}

Write-Host ""
Write-Host "Stopping Factorio instances..." -ForegroundColor Yellow
Invoke-InstanceLifecycle "stop host-1 instance" 'not running' { docker exec surface-export-controller npx clusterioctl $ctlConfig instance stop $hostInstances[1].Id }
Invoke-InstanceLifecycle "stop host-2 instance" 'not running' { docker exec surface-export-controller npx clusterioctl $ctlConfig instance stop $hostInstances[2].Id }
Start-Sleep -Seconds 2
Write-Host "✓ Instances stopped" -ForegroundColor Green

Write-Host ""
Write-Host "Archiving source-recovery history (the seed saves start a new world; nothing is deleted)..." -ForegroundColor Yellow
$archiveStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$archiveScript = 'if [ ! -e "$1" ]; then echo absent; elif [ -e "$2" ]; then echo "destination exists: $2"; exit 3; else mv "$1" "$2" && [ -e "$2" ] && [ ! -e "$1" ] && echo archived; fi'
foreach ($h in 1, 2) {
    $journal = "$($hostInstances[$h].Dir)/surface_export_source_retirements.json"
    $archive = "$($hostInstances[$h].Dir)/surface_export_source_retirements.$archiveStamp.bak.json"
    $out = docker exec "surface-export-host-$h" sh -c $archiveScript sh $journal $archive 2>&1
    $code = $LASTEXITCODE
    $text = ($out | Out-String).Trim()
    if ($code -ne 0 -or $text -notin 'archived', 'absent') {
        throw "Archiving $journal on surface-export-host-$h failed (exit $code): $text. Instances are stopped; no seed save was uploaded."
    }
    if ($text -eq 'archived') {
        Write-Host "  ✓ $($hostInstances[$h].Name): $journal -> $archive" -ForegroundColor Green
    } else {
        Write-Host "  $($hostInstances[$h].Name): no $journal (nothing to archive)" -ForegroundColor Gray
    }
}

Write-Host ""
Write-Host "Uploading seed saves (existing saves are kept)..." -ForegroundColor Yellow
$seedSaveFiles = @{ 1 = 'lab-gallery-source.zip'; 2 = 'lab-gallery-destination.zip' }
$uploadedSaves = @{}
foreach ($h in 1, 2) {
    $seedSave = "/clusterio/seed-data/hosts/$($seedInstances[$h].Host)/$($seedInstances[$h].Instance)/$($seedSaveFiles[$h])"
    $uploadedSaves[$h] = Publish-SeedSave -InstanceId $hostInstances[$h].Id -SeedSavePath $seedSave
    Write-Host "  ✓ Uploaded $($seedSaveFiles[$h]) to $($hostInstances[$h].Name) as $($uploadedSaves[$h])" -ForegroundColor Green
}

Write-Host "  → Instances will re-patch seed saves with updated Lua code on start" -ForegroundColor Cyan

Write-Host ""
Write-Host "Restarting containers to pick up JavaScript changes..." -ForegroundColor Yellow
docker restart surface-export-host-1 surface-export-host-2 | Out-Null
Write-Host "  ✓ Hosts restarting" -ForegroundColor Green
docker restart surface-export-controller | Out-Null
Write-Host "  ✓ Controller restarting" -ForegroundColor Green

Write-Host "Waiting for containers to become healthy..." -ForegroundColor Yellow
$timeoutSec = 90
$elapsed = 0
$containers = @("surface-export-controller", "surface-export-host-1", "surface-export-host-2")
do {
    Start-Sleep -Seconds 3
    $elapsed += 3
    $allHealthy = $true
    foreach ($c in $containers) {
        # Deliberately quiet: health POLL inside a bounded loop. A transient failure just means
        $s = docker ps --filter "name=$c" --format "{{.Status}}" 2>$null
        if ($s -notmatch "\(healthy\)") { $allHealthy = $false }
    }
} while (-not $allHealthy -and $elapsed -lt $timeoutSec)

if ($allHealthy) {
    Write-Host "✓ All containers healthy" -ForegroundColor Green
} else {
    Write-Host "  ⚠ Containers may not be fully healthy yet — proceeding" -ForegroundColor Yellow
}
Write-Host ""

Write-Host ""
Write-Host "Disabling auto_pause on instances..." -ForegroundColor Yellow
$settingsBase = @{ auto_pause = $false; only_admins_can_pause_the_game = $true; autosave_interval = 10; autosave_slots = 5; non_blocking_saving = $true }

$inst1Settings = $settingsBase.Clone(); $inst1Settings["name"] = $hostInstances[1].Name
$inst2Settings = $settingsBase.Clone(); $inst2Settings["name"] = $hostInstances[2].Name

$inst1Json = ($inst1Settings | ConvertTo-Json -Compress)
$inst2Json = ($inst2Settings | ConvertTo-Json -Compress)

Invoke-Step "set host-1 factorio.settings" { docker exec surface-export-controller npx clusterioctl $ctlConfig instance config set $hostInstances[1].Id "factorio.settings" $inst1Json } | Out-Null
Invoke-Step "set host-2 factorio.settings" { docker exec surface-export-controller npx clusterioctl $ctlConfig instance config set $hostInstances[2].Id "factorio.settings" $inst2Json } | Out-Null
Write-Host "✓ auto_pause disabled" -ForegroundColor Green

Write-Host ""
Write-Host "Starting instances (loading patched plugin code)..." -ForegroundColor Yellow
foreach ($h in 1, 2) {
    Invoke-InstanceLifecycle "start host-$h instance" 'already running' {
        Start-InstanceWithDeadline -InstanceId $hostInstances[$h].Id -HostNumber "$h" -Save $uploadedSaves[$h] -DataDir $hostInstances[$h].Dir `
            -StartTimeoutSec $StartTimeoutSec -StopTimeoutSec $StopTimeoutSec
    }
}
Start-Sleep -Seconds 3
Write-Host "✓ Instances started" -ForegroundColor Green

Write-Host ""
Write-Host "Boot check: verifying the patched saves loaded with module version $NewVersion and build $ModuleBuildId..." -ForegroundColor Yellow
$versionProbe = Get-ModuleDeploymentProbe
foreach ($h in 1, 2) {
    $inst = $hostInstances[$h].Name
    $bootDeadline = (Get-Date).AddSeconds(90)
    $bootOk = $false
    $lastPing = ""
    $loaded = @()
    $loadedError = ""
    while ((Get-Date) -lt $bootDeadline) {
        # Deliberately quiet: RCON POLL inside a bounded loop — a transient failure just means
        $ping = docker exec surface-export-controller npx clusterioctl $ctlConfig --log-level error `
            instance send-rcon $hostInstances[$h].Id $versionProbe 2>&1
        $pingOk = $LASTEXITCODE -eq 0
        $lastPing = ($ping | Out-String).Trim()
        $bootOk = $pingOk -and (Test-ModuleDeploymentResponse -Output $lastPing -Version $NewVersion -BuildId $ModuleBuildId)
        if ($bootOk) {
            try { $loaded = @(Get-LoadedSave -InstanceId $hostInstances[$h].Id); $loadedError = "" }
            catch { $loaded = @(); $loadedError = $_.Exception.Message }
            if ($loaded.Count -eq 1 -and $loaded[0] -eq $uploadedSaves[$h]) { break }
        } elseif ($pingOk -and (Get-ModuleDeploymentResponse $lastPing)) { break }
        Start-Sleep -Seconds 3
    }
    if ($bootOk) {
        if ($loaded.Count -ne 1 -or $loaded[0] -ne $uploadedSaves[$h]) {
            $running = if ($loadedError) { "an unreadable save list ($loadedError)" } else { "'$($loaded -join ', ')'" }
            throw "$inst is running $running, not the uploaded seed save '$($uploadedSaves[$h])', after 90s. Nothing was deleted; load it with clusterioctl instance stop $($hostInstances[$h].Id), then instance start $($hostInstances[$h].Id) --save '$($uploadedSaves[$h])'."
        }
        Write-Host "  ✓ ${inst}: $($uploadedSaves[$h]) loaded, module version $NewVersion, build $ModuleBuildId answering" -ForegroundColor Green
    } else {
        Write-Host "  X ${inst} FAILED the boot check (no answer with module version $NewVersion within 90s)." -ForegroundColor Red
        $reported = Get-ModuleDeploymentResponse $lastPing
        if ($reported) {
            Write-Host "    The instance IS answering — but with STALE module code (reported: $reported)." -ForegroundColor Red
            Write-Host "    The save was not re-patched (a plain restart reuses old script.dat) — rerun patch-and-reset." -ForegroundColor Red
        } else {
            Write-Host "    A Lua error at save-load kills the server — read the actual error with:" -ForegroundColor Red
            Write-Host "    docker exec surface-export-host-$h sh -c 'tail -100 ""$($hostInstances[$h].Dir)/factorio-current.log""'" -ForegroundColor Red
        }
        throw "$inst did not come up with module version $NewVersion loaded. Do not trust this deploy."
    }
}
Write-Host "Boot check: waiting for startup source recovery on every instance..." -ForegroundColor Yellow
node "$PSScriptRoot/../tests/cluster-readiness.mjs" --runtime
if ($LASTEXITCODE -ne 0) {
    throw "Startup source recovery is not ready after the reset; exports would fail with 'Startup recovery is not ready'. Do not trust this deploy."
}
Write-Host "  ✓ Source recovery ready on every instance" -ForegroundColor Green
Write-Host ""
Write-Host "=== Patch and Reset Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Plugin changes from docker/seed-data/external_plugins/surface_export have been loaded." -ForegroundColor White
Write-Host "Instances have been reset to seed save state with fresh Lua code." -ForegroundColor White
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Check logs: .\tools\clusterio\check-cluster-logs.ps1" -ForegroundColor White
Write-Host "  2. Probe one transfer: node tools/surface-export/probe-transfer.mjs --fixture 21" -ForegroundColor White

exit 0
}
