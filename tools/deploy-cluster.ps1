param (
    [switch]$SkipIncrement,
    [switch]$KeepData
)

$ErrorActionPreference = "Stop"

# Paths
$WorkspaceRoot = Resolve-Path "$PSScriptRoot/.."
$ExternalPlugins = Join-Path $WorkspaceRoot "docker\seed-data\external_plugins"

# Plugins built host-side. The host image's install-plugins.sh runs
# `npm install --omit=dev`, which cannot run tsc, so each plugin's dist/ MUST be
# compiled here before the cluster mounts it. surface_export may live under either
# folder spelling; clusterio-atlas is fixed.
$PluginSpecs = @(
    @{ Name = "surface_export";  Candidates = @("surface_export", "surface-export") },
    @{ Name = "clusterio-atlas"; Candidates = @("clusterio-atlas") }
)

$Plugins = @()
foreach ($spec in $PluginSpecs) {
    $path = $spec.Candidates |
        ForEach-Object { Join-Path $ExternalPlugins $_ } |
        Where-Object { Test-Path $_ } |
        Select-Object -First 1
    if (-not $path) {
        throw "Could not find plugin '$($spec.Name)'. Checked: $($spec.Candidates -join ', ') under $ExternalPlugins"
    }
    $Plugins += [pscustomobject]@{ Name = $spec.Name; Path = $path; Version = $null }
}

# 1. Increment Version (per plugin: package.json + module/module.json in lockstep)
function Update-PluginVersion {
    param([string]$PluginPath, [switch]$Skip)
    $pkgPath = Join-Path $PluginPath "package.json"
    $modPath = Join-Path $PluginPath "module\module.json"
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    if ($Skip) {
        Write-Host "  $(Split-Path $PluginPath -Leaf): using existing version $($pkg.version)" -ForegroundColor Yellow
        return $pkg.version
    }
    $parts = $pkg.version.Split('.')
    if ($parts.Count -ne 3) { throw "Version '$($pkg.version)' not X.Y.Z in $pkgPath" }
    $new = "{0}.{1}.{2}" -f $parts[0], $parts[1], ([int]$parts[2] + 1)
    $pkg.version = $new
    $pkg | ConvertTo-Json -Depth 10 | Set-Content $pkgPath -Encoding UTF8
    if (Test-Path $modPath) {
        $mod = Get-Content $modPath -Raw | ConvertFrom-Json
        $mod.version = $new
        $mod | ConvertTo-Json -Depth 10 | Set-Content $modPath -Encoding UTF8
    }
    Write-Host "  $(Split-Path $PluginPath -Leaf): $($parts -join '.') -> $new" -ForegroundColor Green
    return $new
}

Write-Host "Versioning plugins..." -ForegroundColor Cyan
foreach ($p in $Plugins) {
    $p.Version = Update-PluginVersion -PluginPath $p.Path -Skip:$SkipIncrement
}
# Reported in the final summary / startup message.
$NewVersion = ($Plugins | Where-Object { $_.Name -eq "surface_export" }).Version

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
    docker compose down -v 2>$null
} else {
    Write-Host "Keeping existing data volumes (-KeepData)" -ForegroundColor Yellow
}

# 5. Build plugin artifacts (host-side — mandatory; in-container install can't run tsc)
Write-Host "Building plugin artifacts..." -ForegroundColor Cyan
foreach ($p in $Plugins) {
    Write-Host "  Building $($p.Name)..." -ForegroundColor Cyan
    Push-Location $p.Path
    try {
        if (Test-Path (Join-Path $p.Path "package-lock.json")) {
            npm ci --silent 2>$null
        } else {
            npm install --silent 2>$null
        }
        npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Plugin build failed: $($p.Name)"
        }
        Write-Host "  $($p.Name) built" -ForegroundColor Green
    } finally {
        Pop-Location
    }
}
Write-Host "All plugin artifacts built successfully" -ForegroundColor Green

# 6. Pull latest base images
Write-Host "Pulling latest base images..." -ForegroundColor Cyan
docker compose pull

# 7. Start the cluster
# Run up -d twice: first pass starts the controller; second pass ensures hosts
# are started after the controller is healthy (Docker Compose timing quirk with
# depends_on: service_healthy can leave dependent containers in Created state).
Write-Host "Starting cluster..." -ForegroundColor Cyan
docker compose up -d
docker compose up -d

Write-Host "Cluster started with plugin version $NewVersion" -ForegroundColor Green
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
    Write-Host "(Instance startup timeout after ${instanceTimeout}s)" -ForegroundColor Yellow
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
            try { $adminToken | Set-Clipboard; Write-Host "(Copied to clipboard)" -ForegroundColor Green } catch {}
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
