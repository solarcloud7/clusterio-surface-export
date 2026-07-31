# IMPLEMENTATION for deploy.ps1 — prefer that entry point.
param (
    [switch]$SkipIncrement,
    [switch]$KeepData
)

$ErrorActionPreference = "Stop"

# Paths
$WorkspaceRoot = Resolve-Path "$PSScriptRoot/../.."
$PluginPathCandidates = @(
    (Join-Path $WorkspaceRoot "docker\seed-data\external_plugins\surface_export"),
    (Join-Path $WorkspaceRoot "docker\seed-data\external_plugins\surface-export")
)

$PluginPath = $PluginPathCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $PluginPath) {
    $Checked = $PluginPathCandidates -join ", "
    throw "Could not find surface-export plugin folder. Checked: $Checked"
}

$PluginJsonPath = Join-Path $PluginPath "package.json"
$ModuleJsonPath = Join-Path $PluginPath "module\module.json"

# 1. Increment Version
if (-not $SkipIncrement) {
    Write-Host "Reading version..." -ForegroundColor Cyan
    $PluginJson = Get-Content $PluginJsonPath -Raw | ConvertFrom-Json

    # Parse version (Simple Major.Minor.Patch)
    $VerParts = $PluginJson.version.Split('.')
    if ($VerParts.Count -ne 3) {
        Write-Error "Version format $($PluginJson.version) not supported for auto-increment. Expected X.Y.Z"
    }

    $NewPatch = [int]$VerParts[2] + 1
    $NewVersion = "{0}.{1}.{2}" -f $VerParts[0], $VerParts[1], $NewPatch

    Write-Host "Bumping version: $($PluginJson.version) -> $NewVersion" -ForegroundColor Green

    # Update Plugin package.json
    $PluginJson.version = $NewVersion
    $PluginJson | ConvertTo-Json -Depth 10 | Set-Content $PluginJsonPath -Encoding UTF8
    Write-Host "Updated plugin version in package.json" -ForegroundColor Green

    # Update Module module.json to match
    if (Test-Path $ModuleJsonPath) {
        $ModuleJson = Get-Content $ModuleJsonPath -Raw | ConvertFrom-Json
        $ModuleJson.version = $NewVersion
        $ModuleJson | ConvertTo-Json -Depth 10 | Set-Content $ModuleJsonPath -Encoding UTF8
        Write-Host "Updated module version in module/module.json" -ForegroundColor Green
    } else {
        Write-Warning "module.json not found at $ModuleJsonPath"
    }
} else {
    $PluginJson = Get-Content $PluginJsonPath -Raw | ConvertFrom-Json
    $NewVersion = $PluginJson.version
    Write-Host "Using existing version: $NewVersion" -ForegroundColor Yellow
}

# Both branches: keep the lockfile's version metadata in step with package.json (a -SkipIncrement
# run heals pre-existing drift too; idempotent — writes only on change). See tools/shared/version-utils.ps1.
. "$PSScriptRoot/../shared/version-utils.ps1"
Update-PackageLockVersion -LockPath (Join-Path $PluginPath "package-lock.json") -NewVersion $NewVersion
# Both branches call the stamp writer so version.lua tracks package.json — but note the asymmetry:
# -SkipIncrement heals lockfile+stamp drift, while module.json is only written in the bump branch
# above. test/module-version-stamp.test.cjs goes red if the three carriers ever disagree, so a
# pre-existing module.json drift surfaces in the suite rather than being silently healed here.
Update-ModuleVersionStamp -ModuleDir (Join-Path $PluginPath "module") -NewVersion $NewVersion

Write-Host "Using save-patched module architecture (no mod zip needed)" -ForegroundColor Cyan
Write-Host "Lua code in module/ directory will be patched into saves by Clusterio" -ForegroundColor Green

# 2. Verify env file exists
$EnvFile = Join-Path $WorkspaceRoot ".env"
if (-not (Test-Path $EnvFile)) {
    Write-Host "Creating .env from example..." -ForegroundColor Yellow
    Copy-Item (Join-Path $WorkspaceRoot ".env.example") $EnvFile
    Write-Warning "Please edit .env and set INIT_CLUSTERIO_ADMIN before running again."
    exit 1
}

# 3. Tear down existing cluster
Write-Host "Stopping existing cluster..." -ForegroundColor Cyan
Set-Location $WorkspaceRoot
docker compose down

# 4. Clean Docker volumes (unless -KeepData)
if (-not $KeepData) {
    Write-Host "Removing Docker volumes (clean slate)..." -ForegroundColor Yellow
    # NOT silent: the default deploy path promises a fresh seed, and this line IS that promise.
    # If the wipe fails the cluster comes up on STALE data and every later success message lies.
    # `down -v` on an already-down cluster succeeds, so a non-zero exit here is a real failure.
    $downOut = docker compose down -v 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host ($downOut | Out-String) -ForegroundColor Red
        throw "docker compose down -v failed (exit $LASTEXITCODE) — volumes were NOT wiped, so this is not the clean slate it claims. Re-run, or pass -KeepData if you meant to keep them."
    }
} else {
    Write-Host "Keeping existing data volumes (-KeepData)" -ForegroundColor Yellow
}

# 5. Build plugin artifacts (node + web)
# ONE build path for the whole repo: build-plugin.ps1. This step used to carry its own `npm ci` +
# `npm run build` run directly in the live plugin dir — a second implementation of the same purpose,
# using the method the plugin docs explicitly forbid: installing there re-adds the `@clusterio/*`
# peers into the bind-mounted node_modules (npm 7+ auto-installs peers) and breaks clusterioctl with
# "duplicate copy of @clusterio/lib". It also required host Node, which build-plugin.ps1 exists to
# avoid. Two copies of one purpose is how the methods drift apart unnoticed — they already had.
# build-plugin.ps1 needs only a running Docker daemon (it builds in a throwaway node:24 container
# with a named volume shadowing node_modules), so it is safe here with the cluster torn down.
#
# Failure propagates as a TERMINATING ERROR, not an exit code: build-plugin.ps1 reports every
# failure with `throw` and never calls `exit`, and this script runs under $ErrorActionPreference =
# "Stop". Do NOT add a `$LASTEXITCODE -ne 0` check here — after the call that variable still holds
# whatever the last native command inside left behind, so the check would be a coin flip that can
# fail a perfectly good deploy.
Write-Host "Building plugin artifacts (node + web)..." -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "build-plugin.ps1") all
Write-Host "Plugin artifacts built successfully" -ForegroundColor Green

# 6. Pull latest base images
Write-Host "Pulling latest base images..." -ForegroundColor Cyan
docker compose pull

# 7. Start the cluster
# Run up -d twice: first pass starts the controller; second pass ensures hosts
# are started after the controller is healthy (Docker Compose timing quirk with
# depends_on: service_healthy can leave dependent containers in Created state).
# The FIRST pass is ALLOWED to fail — recovering from that is the entire reason the retry exists.
# Only the second pass is load-bearing, so only it is checked. (An earlier commit on this branch
# deleted the retry in the same edit that made the downstream instance timeout fatal: two changes,
# one attribution. A compose hiccup that used to self-heal became a hard abort.)
Write-Host "Starting cluster..." -ForegroundColor Cyan
docker compose up -d
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw "docker compose up -d failed (exit $LASTEXITCODE) — refusing to report a started cluster." }

# NOTE: this printed "Cluster started with plugin version $NewVersion" using the version it had just
# WRITTEN to package.json — never a value read back from the running cluster. A deploy that silently
# failed to take still announced the new version, which is exactly the "old code after deploy"
# confusion the pitfall corpus documented. The real assertion happens after startup, below.
Write-Host ""

# 8. Follow controller logs until initialization completes
Write-Host "Controller Logs (streaming - waiting for initialization):" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor DarkGray

# Stream controller logs for up to 120 seconds, stop when we see seeding complete
$timeout = 120
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$initDone = $false

# Wait a moment for the container to start
Start-Sleep -Seconds 3

# Follow logs and look for initialization markers
# Use a job so we can break out early when seeding completes
$logJob = Start-Job -ScriptBlock {
    docker logs -f surface-export-controller 2>&1
}
try {
    while ($true) {
        $lines = Receive-Job $logJob
        foreach ($line in $lines) {
            Write-Host $line
            if ($line -match "Seeding complete") {
                $initDone = $true
            }
        }
        if ($initDone) { break }
        if ($sw.Elapsed.TotalSeconds -ge $timeout) {
            Write-Host "(Log streaming timeout after ${timeout}s)" -ForegroundColor Yellow
            break
        }
        Start-Sleep -Milliseconds 200
    }
} finally {
    if ($logJob) {
        # Deliberately quiet: best-effort teardown of the log-streaming job in a finally block —
        # the job may have already completed/failed, and teardown noise would mask the real outcome.
        Stop-Job $logJob -ErrorAction SilentlyContinue
        Remove-Job $logJob -ErrorAction SilentlyContinue
    }
}

Write-Host "================================================" -ForegroundColor DarkGray

# 9. Wait for instances to reach running state
Write-Host ""
Write-Host "Waiting for instances to start..." -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor DarkGray

$instanceTimeout = 300
$instanceSw = [System.Diagnostics.Stopwatch]::StartNew()
$lastStates = @{}
$instancesDone = $false

while (-not $instancesDone -and $instanceSw.Elapsed.TotalSeconds -lt $instanceTimeout) {
    Start-Sleep -Seconds 3

    # Deliberately quiet: this is a POLL. The controller legitimately refuses while still booting,
    # and the exit code IS checked on the next line — a failure retries rather than being swallowed.
    $listOut = docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error instance list 2>/dev/null' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $listOut) { continue }

    $stateMap = @{}
    foreach ($line in ($listOut -split "`n")) {
        if ($line -match '(clusterio-\S+-instance-\d+).*\b(running|starting|stopped|stopping|creating_save|unassigned)\b') {
            $stateMap[$Matches[1]] = $Matches[2]
        }
    }

    foreach ($name in ($stateMap.Keys | Sort-Object)) {
        $state = $stateMap[$name]
        if ($lastStates[$name] -ne $state) {
            $stateColor = switch ($state) {
                "running"       { "Green"  }
                "stopped"       { "Red"    }
                "creating_save" { "Cyan"   }
                default         { "Yellow" }
            }
            $elapsed = [int]$instanceSw.Elapsed.TotalSeconds
            Write-Host "  [+${elapsed}s] $name -> $state" -ForegroundColor $stateColor
            $lastStates[$name] = $state
        }
    }

    $nonRunning = @($stateMap.Values | Where-Object { $_ -ne "running" })
    if ($stateMap.Count -gt 0 -and $nonRunning.Count -eq 0) {
        $instancesDone = $true
    }
}

Write-Host "================================================" -ForegroundColor DarkGray
if ($instancesDone) {
    $elapsed = [int]$instanceSw.Elapsed.TotalSeconds
    Write-Host "All instances running! (+${elapsed}s)" -ForegroundColor Green
} else {
    Write-Host "X Instance startup TIMED OUT after ${instanceTimeout}s" -ForegroundColor Red
    throw "Instances did not reach running within ${instanceTimeout}s. The cluster is NOT deployed; do not trust a later success message."
}

# ---- POST-DEPLOY VERSION PROBE ----
# What this proves, and what it does NOT, stated plainly.
#
# An earlier version of this block claimed to "verify the running cluster loaded $NewVersion" by
# cat-ing module.json out of host-1 — a tautology (the bind mount re-read the file this script had
# just written), broken further by `-match` on a string ARRAY (filters, never populates $Matches).
# Its replacement could only assert liveness, because there was no runtime version oracle.
#
# The oracle exists now (SC-72): module/version.lua is rewritten by the bump above and the LIVE
# module returns it via remote.call('surface_export','get_module_version') — an answer from inside
# the patched save, not from the file this script wrote. `-match` runs on Out-String output (a
# single string), so $Matches is populated correctly.
#
# LIMIT, honestly held: on `-KeepData` the volumes and their already-patched saves survive, so Lua
# edits do NOT take and a version MISMATCH is the expected outcome — reported as a loud warning,
# not a failure. Every other path hard-fails on mismatch.
Write-Host ""
Write-Host "Verifying the save-patched module VERSION on both instances..." -ForegroundColor Cyan
$versionProbe = "/sc local i = remote.interfaces['surface_export'] " +
    "if not i then rcon.print('plugin-missing') " +
    "elseif not i['get_module_version'] then rcon.print('stale-module-no-version-oracle') " +
    "else rcon.print(remote.call('surface_export','get_module_version')) end"
foreach ($probeInstance in @("clusterio-host-1-instance-1", "clusterio-host-2-instance-1")) {
    $probe = docker exec surface-export-controller npx clusterioctl --config /clusterio/tokens/config-control.json `
        --log-level error instance send-rcon $probeInstance $versionProbe 2>&1
    $probeText = ($probe | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $probeText -match 'plugin-missing' -or
        -not ($probeText -match '(?m)^\s*(\d+\.\d+\.\d+|stale-module-no-version-oracle)\s*$')) {
        throw "surface_export interface is NOT loaded on ${probeInstance} (exit $LASTEXITCODE): $probeText"
    }
    $reported = $Matches[1]
    if ($reported -eq 'stale-module-no-version-oracle') { $reported = "a pre-oracle module (no version stamp)" }
    if ($reported -eq $NewVersion) {
        Write-Host "  OK - $probeInstance runs module version $reported" -ForegroundColor Green
    } elseif ($KeepData) {
        Write-Host "  ~ $probeInstance runs $reported (deploy is $NewVersion) — EXPECTED with -KeepData: kept saves keep their old patched Lua" -ForegroundColor Yellow
    } else {
        throw "$probeInstance runs STALE module code ($reported) after a full deploy (expected $NewVersion). The save was not re-patched — do not trust this deploy."
    }
}

# 10. Retrieve admin token
Write-Host ""
Write-Host "Retrieving admin token..." -ForegroundColor Cyan
Start-Sleep -Seconds 2

$tokenJson = docker exec surface-export-controller cat /clusterio/tokens/config-control.json 2>$null
if ($LASTEXITCODE -eq 0 -and $tokenJson) {
    try {
        $tokenConfig = $tokenJson | ConvertFrom-Json
        $adminToken = $tokenConfig.'control.controller_token'
        if ($adminToken) {
            Write-Host "Admin Token: $adminToken" -ForegroundColor Yellow
            try { $adminToken | Set-Clipboard; Write-Host "(Copied to clipboard)" -ForegroundColor Green }
            catch { Write-Host "(Clipboard unavailable — copy the token above manually)" -ForegroundColor DarkGray }
        }
    } catch {
        Write-Host "Could not parse token from config" -ForegroundColor Yellow
    }
} else {
    Write-Host "Token not available yet. Retrieve later with:" -ForegroundColor Yellow
    Write-Host "  docker exec surface-export-controller cat /clusterio/tokens/config-control.json" -ForegroundColor DarkGray
}

Write-Host ""
$httpPort = (Get-Content $EnvFile | Where-Object { $_ -match '^CONTROLLER_HTTP_PORT=(\d+)' } | ForEach-Object { $Matches[1] } | Select-Object -First 1) ?? "8080"
Write-Host "Web UI: http://localhost:$httpPort" -ForegroundColor Green
Write-Host ""
Write-Host "Cluster topology:" -ForegroundColor Cyan
Write-Host "  Controller (http://localhost:$httpPort)" -ForegroundColor White
Write-Host "    ├── surface-export-host-1 (ports 34100-34109)" -ForegroundColor White
Write-Host "    │     └── clusterio-host-1-instance-1" -ForegroundColor White
Write-Host "    └── surface-export-host-2 (ports 34200-34209)" -ForegroundColor White
Write-Host "          └── clusterio-host-2-instance-1" -ForegroundColor White
Write-Host ""
