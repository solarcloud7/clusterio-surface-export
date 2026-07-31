# Patch and Reset Instances
# Hot-reload plugin code and reset instances to seed save without full cluster rebuild

param(
    [switch]$Help = $false,
    [switch]$LuaOnly = $false
)

if ($Help) {
    Write-Host @"
Patch and Reset Instances
==========================

Hot-reloads plugin code (Lua + TypeScript + web) and resets instances to seed save without
rebuilding containers. This is the one-shot for LUA changes (and any combination of changes).

Usage:
    .\patch-and-reset.ps1            # full: rebuild dist (node + web), reset saves, restart
    .\patch-and-reset.ps1 -LuaOnly   # fast path: SKIP the ~3-min container build; Lua is
                                     # save-patched from source, so dist/ is untouched by a
                                     # module/*.lua-only change. REFUSES to run if any TS/web
                                     # source is newer than the newest dist artifact (a stale
                                     # dist would silently ship old plugin code).

This script:
1. Bumps the plugin version (cache-bust marker)
2. Builds plugin artifacts (dist/node + dist/web) via tools/clusterio/build-plugin.ps1 — an isolated
   node:24 container, so it never pollutes the running cluster's bind-mounted node_modules
   (skipped by -LuaOnly, guarded by the staleness tripwire above)
3. Stops Factorio instances (keeps controller running)
4. Resets save files to seed saves (required to apply Lua code changes)
5. Restarts all containers (hosts + controller) — hosts load the new dist/node and re-patch
   saves with the latest Lua; the controller re-reads dist/web/manifest.json
6. BOOT CHECK: polls until both instances report running AND answer RCON with the plugin's
   remote interface present — a Lua error at save-load kills the headless server (exit 255),
   and before this check the only signal was the server dying later.

Note: Save reset is REQUIRED because Lua code is embedded in save files via save-patching.
      Without reset, old embedded script.dat prevents Lua code updates from taking effect.

      For a web-ONLY or TypeScript-ONLY change you do NOT need this heavy reset — use
      `tools/clusterio/build-plugin.ps1 web -RestartController` or `... node -RestartHosts` instead.
"@
    exit 0
}

$ErrorActionPreference = "Stop"

Write-Host "=== Patch and Reset Instances ===" -ForegroundColor Cyan
Write-Host ""

$WorkspaceRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

if ($LuaOnly) {
    # Fast path tripwire — checked FIRST, before the version bump mutates package.json (the bump
    # would otherwise always be the "newest source" and defeat this check). Lua is save-patched
    # from module/ SOURCE, so a Lua-only change never touches dist/; but if any TS/web source or
    # build config is newer than the newest dist artifact, a stale dist would silently ship old
    # plugin code — refuse instead of trusting the caller's claim.
    $pluginRoot = Join-Path $WorkspaceRoot "docker/seed-data/external_plugins/surface_export"
    $distNode = Join-Path $pluginRoot "dist/node"
    $distWeb = Join-Path $pluginRoot "dist/web"
    if (-not (Test-Path $distNode) -or -not (Test-Path $distWeb)) {
        throw "-LuaOnly refused: dist/node or dist/web is missing. Run without -LuaOnly to build first."
    }
    # The source set is the ENUMERATED build inputs (lib/, web/, plugin-root *.ts, tsconfig*.json,
    # webpack.config.js, .npmrc) — NOT a recursive walk of the plugin root. Review-caught defect:
    # a walk that included root .json/.js compared against files this script itself rewrites every
    # run (package.json/package-lock.json version bump) and against non-build files
    # (eslint.config.js, scripts/*), so run N's bump made run N+1 always refuse. Known accepted
    # gap: a DEPENDENCY-only edit (package.json) is not detected — after dependency changes, run
    # without -LuaOnly.
    $srcCandidates = @(
        Get-ChildItem (Join-Path $pluginRoot "lib"), (Join-Path $pluginRoot "web") -Recurse -File -ErrorAction Stop
        Get-ChildItem $pluginRoot -File | Where-Object {
            $_.Extension -in '.ts', '.tsx' -or $_.Name -like 'tsconfig*.json' -or $_.Name -eq 'webpack.config.js' -or $_.Name -eq '.npmrc'
        }
    )
    $srcNewest = $srcCandidates | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    $distNewest = Get-ChildItem $distNode, $distWeb -Recurse -File |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    # Empty dist dirs (interrupted build, wiped contents) must REFUSE, not fall through the
    # comparison as "fresh" — that fail-open was a review-caught defect.
    if (-not $distNewest) {
        throw "-LuaOnly refused: dist/node and dist/web exist but contain no files. Run without -LuaOnly to build first."
    }
    if (-not $srcNewest) {
        throw "-LuaOnly refused: found zero TS/web build inputs to compare against — this tree looks wrong; refusing to guess."
    }
    if ($srcNewest.LastWriteTimeUtc -gt $distNewest.LastWriteTimeUtc) {
        throw ("-LuaOnly refused: '$($srcNewest.FullName)' ($($srcNewest.LastWriteTimeUtc)) is newer than the newest dist artifact " +
            "'$($distNewest.Name)' ($($distNewest.LastWriteTimeUtc)). A stale dist would ship old plugin code — run without -LuaOnly.")
    }
    Write-Host "LuaOnly: dist/ is fresh (newest build input: $($srcNewest.Name)) — container build will be skipped" -ForegroundColor Yellow
    Write-Host ""
}

# Increment version to ensure no caching
Write-Host "Incrementing plugin version..." -ForegroundColor Yellow
$PluginJsonPath = Join-Path $WorkspaceRoot "docker/seed-data/external_plugins/surface_export/package.json"
$ModuleJsonPath = Join-Path $WorkspaceRoot "docker/seed-data/external_plugins/surface_export/module/module.json"

$PluginJson = Get-Content $PluginJsonPath -Raw | ConvertFrom-Json
$VerParts = $PluginJson.version.Split('.')
if ($VerParts.Count -ne 3) {
    Write-Error "Version format $($PluginJson.version) not supported. Expected X.Y.Z"
}

$NewPatch = [int]$VerParts[2] + 1
$NewVersion = "{0}.{1}.{2}" -f $VerParts[0], $VerParts[1], $NewPatch
Write-Host "  $($PluginJson.version) → $NewVersion" -ForegroundColor Green

$PluginJson.version = $NewVersion
$PluginJson | ConvertTo-Json -Depth 10 | Set-Content $PluginJsonPath -Encoding UTF8

if (Test-Path $ModuleJsonPath) {
    $ModuleJson = Get-Content $ModuleJsonPath -Raw | ConvertFrom-Json
    $ModuleJson.version = $NewVersion
    $ModuleJson | ConvertTo-Json -Depth 10 | Set-Content $ModuleJsonPath -Encoding UTF8
}

# Keep the lockfile's version metadata in step with package.json; see tools/shared/version-utils.ps1.
. "$PSScriptRoot/../shared/version-utils.ps1"
Update-PackageLockVersion -LockPath (Join-Path $WorkspaceRoot "docker/seed-data/external_plugins/surface_export/package-lock.json") -NewVersion $NewVersion
# Rewrite the runtime version oracle (module/version.lua) so the boot check below can prove THIS
# version is what actually loaded — not merely that some plugin answers (SC-72).
Update-ModuleVersionStamp -ModuleDir (Join-Path $WorkspaceRoot "docker/seed-data/external_plugins/surface_export/module") -NewVersion $NewVersion
Write-Host "✓ Version updated" -ForegroundColor Green
Write-Host ""

# Build plugin artifacts (node + web) so dist/ matches source.
# IMPORTANT: build in the isolated container via build-plugin.ps1 — NEVER `npm install`/`npm run
# build` in the live plugin dir on a running cluster: it re-adds the @clusterio/* peers into the
# bind-mounted node_modules and breaks clusterioctl ("duplicate copy of @clusterio/lib").
if ($LuaOnly) {
    # Tripwire already passed (checked pre-bump, top of script) — dist/ is fresher than every source.
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

# Check if cluster is running
Write-Host "Checking cluster status..." -ForegroundColor Yellow
$controllerStatus = docker ps --filter "name=surface-export-controller" --format "{{.Status}}"
if (-not $controllerStatus) {
    Write-Host "ERROR: Clusterio controller is not running. Start cluster first with:" -ForegroundColor Red
    Write-Host "  docker compose up -d" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Controller running" -ForegroundColor Green

# Stop instances (use instance names, not numeric IDs which don't match)
Write-Host ""
# CORRECTION (2026-07-25): an earlier commit here claimed clusterioctl rejects the `--config=<path>`
# form and that all 11 calls in this script were failing silently. That was WRONG — measured in
# PowerShell, BOTH `--config=<path>` and `--config <path>` work, including the original single-string
# variable. The real variable is GIT BASH: MSYS mangles a leading /path into C:/Program Files/Git/...
# (proved: `docker run --rm alpine echo /clusterio/x` -> `C:/Program Files/Git/clusterio/x`), which is
# why the same command fails there and works with MSYS_NO_PATHCONV=1 or inside `sh -c '...'`. This
# script is PowerShell, so it was never affected. The array form is kept only because it is clearer.
$ctlConfig = @("--config", "/clusterio/tokens/config-control.json")

# ---------------------------------------------------------------------------------------------
# Every clusterioctl / docker-exec call in this script used to end in `2>$null`, so a FAILING call
# looked identical to a succeeding one. That is how the --config= bug above survived: 11 broken
# calls, zero output, script reports success. Route every meaningful call through this instead —
# it surfaces stderr and the exit code, and by default ABORTS rather than continuing on a lie.
#
# -AllowFail is for calls where failure is genuinely expected and harmless (e.g. deleting saves
# that may not exist). Those still LOG; they just do not abort. There is no silent path.
# ---------------------------------------------------------------------------------------------
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
        # Exit 0 with an error-shaped message is the other half of the trap (clusterioctl has done
        # exactly this). Surface it rather than let it scroll past.
        Write-Host "  ! $What — exit 0 but output looks like an error: $text" -ForegroundColor Yellow
    }
    return $text
}

# ---------------------------------------------------------------------------------------------
# clusterioctl exits 1 on the two BENIGN instance-lifecycle cases:
#   stop  on an already-stopped instance -> "Instance is not running."
#   start on an already-running instance -> "Instance is already running."
# Both are normal here: hosts auto-start their instances after a container restart, and this script
# is frequently run after an instance crashed. Routing those calls through a bare Invoke-Step made a
# FULLY SUCCESSFUL patch-and-reset abort and report failure.
#
# Tolerate ONLY the specific benign message; any other exit-1 is a real failure and still aborts.
# A blanket -AllowFail would have swallowed genuine start failures — the exact silence this file
# was rewritten to remove.
# ---------------------------------------------------------------------------------------------
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


# ---------------------------------------------------------------------------------------------
# SAVE EVERY RUNNING INSTANCE FIRST — including ones this script does not manage.
#
# This script stops the two SEEDED instances by name, but later hard-restarts the CONTAINERS
# (docker restart surface-export-host-1 surface-export-host-2). Any other instance living in those
# containers is killed mid-flight with no exit-save. That is not hypothetical: a hand-built pad
# gallery was lost to exactly this, and the response was a prose rule ("checkpoint before every
# deploy") that nothing enforced — so the hazard stayed armed.
#
# Enumerate every RUNNING instance and server_save it before anything stops. Seeded instances lose
# nothing by being saved (their saves are reset below anyway); unseeded ones are rescued.
# ---------------------------------------------------------------------------------------------
Write-Host "Saving every running instance before restart (no silent data loss)..." -ForegroundColor Yellow

# NOT -AllowFail, and NOT 2>$null. If the enumeration itself fails we do not know what is running,
# and the next thing this script does is hard-restart both host containers. Proceeding on a silently
# empty list is precisely how the pad gallery was lost. No list => no restart.
$instanceList = Invoke-Step "enumerate running instances" {
    docker exec surface-export-controller npx clusterioctl $ctlConfig --log-level error instance list
}

$pendingSaves = @()
foreach ($line in ($instanceList -split "`r?`n")) {
    # "name | id | assignedHost | gamePort | status | ..." — only running instances can be saved.
    # ONE regex capturing BOTH name and assignedHost. A second -match to grab the host would clobber
    # $Matches — the same defect that produced 3 empty names here, and that made the deploy script's
    # version assertion compare against an instance name. Header/separator rows fail this pattern.
    if ($line -match '^\s*([A-Za-z0-9._-]+)\s*\|\s*\d+\s*\|\s*(\d+)\s*\|\s*\d+\s*\|\s*running\s*\|') {
        $inst = $Matches[1]
        $hostContainer = "surface-export-host-$($Matches[2])"
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        # Route through Invoke-Step: this used to print "✓ saved" unconditionally, so a FAILED
        # rescue-save looked identical to a successful one — the very pattern this block exists to
        # prevent. -AllowFail because one un-saveable instance must not abort rescuing the others.
        Invoke-Step "save $inst before restart" -AllowFail {
            docker exec surface-export-controller npx clusterioctl $ctlConfig --log-level error `
                instance send-rcon $inst "/sc game.server_save('predeploy-$stamp')"
        } | Out-Null
        $pendingSaves += [pscustomobject]@{
            Instance  = $inst
            Container = $hostContainer
            Path      = "/clusterio/data/instances/$inst/saves/predeploy-$stamp.zip"
        }
    }
}

if ($pendingSaves.Count -eq 0) {
    Write-Host "  (no running instances to save)" -ForegroundColor Gray
} else {
    # POLL for the file, do not sleep and hope. This script sets non_blocking_saving=$true below, so
    # game.server_save returns BEFORE the write lands — a fixed Start-Sleep is a guess that silently
    # becomes wrong on a bigger save or a slower disk. Wait for the file to exist AND stop growing.
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
            # Loud, and fatal. The whole point of this block is that unsaved work must not be
            # restarted over. If the rescue save did not land, do not proceed to restart.
            throw "Rescue save for '$($p.Instance)' never landed at $($p.Path) within 120s. Refusing to restart containers over unsaved work."
        }
    }
}

Write-Host ""
Write-Host "Stopping Factorio instances..." -ForegroundColor Yellow
Invoke-InstanceLifecycle "stop host-1 instance" 'not running' { docker exec surface-export-controller npx clusterioctl $ctlConfig instance stop "clusterio-host-1-instance-1" }
Invoke-InstanceLifecycle "stop host-2 instance" 'not running' { docker exec surface-export-controller npx clusterioctl $ctlConfig instance stop "clusterio-host-2-instance-1" }
Start-Sleep -Seconds 2
Write-Host "✓ Instances stopped" -ForegroundColor Green

# Reset saves (ALWAYS required to apply Lua code changes)
Write-Host ""
Write-Host "Resetting instance saves to seed saves..." -ForegroundColor Yellow

# Load save names from .env file
# (Removed: INSTANCE1/2_SAVE_NAME parsing. It read `docker/.env`, a file that does not exist, and
# the parsed values were never used again — the seed paths below are hardcoded. Dead config that
# looked configurable.)

# IMPORTANT: Clusterio stores instance data under /clusterio/data/instances/
# Lua module code is embedded in save files via save-patching during instance start.
# To apply Lua code changes, we MUST delete old saves and re-upload the seed saves
# so Clusterio re-patches them with the updated module code.

# Instance 1 - Delete old saves and re-upload seed save. PREDEPLOY RESCUE SAVES ARE PRESERVED:
# the rescue block above saves every running world, and this delete step used to REMOVE ITS OWN
# RESCUE - measured 2026-07-28: an owner-hand-built fixture (the 92,50 pairing rig) existed only
# in the live world and was destroyed with no recovery path. Never again: predeploy-*.zip survives
# every reset (clean them up manually once banked).
$inst1SavePath = "/clusterio/data/instances/clusterio-host-1-instance-1/saves"
Invoke-Step "clear host-1 saves" -AllowFail { docker exec surface-export-host-1 sh -c "find $inst1SavePath -maxdepth 1 -name \"*.zip\" ! -name \"predeploy-*.zip\" -delete" } | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ Cleared instance 1 saves" -ForegroundColor Green
} else {
    Write-Host "  ✗ Failed to clear instance 1 saves" -ForegroundColor Red
}
$inst1SeedSave = "/clusterio/seed-data/hosts/clusterio-host-1/clusterio-host-1-instance-1/lab-gallery-source.zip"
Invoke-Step "upload host-1 seed save" { docker exec surface-export-controller npx clusterioctl $ctlConfig --log-level error instance save upload "clusterio-host-1-instance-1" $inst1SeedSave } | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ Re-uploaded seed save for instance 1 (lab-gallery-source.zip)" -ForegroundColor Green
} else {
    Write-Host "  ✗ Failed to upload seed save for instance 1" -ForegroundColor Red
}

# Instance 2 - Delete old saves and re-upload seed save
$inst2SavePath = "/clusterio/data/instances/clusterio-host-2-instance-1/saves"
Invoke-Step "clear host-2 saves" -AllowFail { docker exec surface-export-host-2 sh -c "find $inst2SavePath -maxdepth 1 -name \"*.zip\" ! -name \"predeploy-*.zip\" -delete" } | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ Cleared instance 2 saves" -ForegroundColor Green
} else {
    Write-Host "  ✗ Failed to clear instance 2 saves" -ForegroundColor Red
}
$inst2SeedSave = "/clusterio/seed-data/hosts/clusterio-host-2/clusterio-host-2-instance-1/lab-gallery-destination.zip"
Invoke-Step "upload host-2 seed save" { docker exec surface-export-controller npx clusterioctl $ctlConfig --log-level error instance save upload "clusterio-host-2-instance-1" $inst2SeedSave } | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ Re-uploaded seed save for instance 2 (lab-gallery-destination.zip)" -ForegroundColor Green
} else {
    Write-Host "  ✗ Failed to upload seed save for instance 2" -ForegroundColor Red
}

Write-Host "  → Instances will re-patch seed saves with updated Lua code on start" -ForegroundColor Cyan

# Restart containers to pick up JavaScript changes (instance.js, controller.js, messages.js)
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
        # "not healthy yet" and the loop retries; the timeout below is the real gate.
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

# Ensure auto_pause is disabled (headless servers must tick continuously for async processing)
Write-Host ""
Write-Host "Disabling auto_pause on instances..." -ForegroundColor Yellow
$settingsBase = @{ auto_pause = $false; only_admins_can_pause_the_game = $true; autosave_interval = 10; autosave_slots = 5; non_blocking_saving = $true }

$inst1Settings = $settingsBase.Clone(); $inst1Settings["name"] = "instance 1"
$inst2Settings = $settingsBase.Clone(); $inst2Settings["name"] = "instance 2"

$inst1Json = ($inst1Settings | ConvertTo-Json -Compress)
$inst2Json = ($inst2Settings | ConvertTo-Json -Compress)

Invoke-Step "set host-1 factorio.settings" { docker exec surface-export-controller npx clusterioctl $ctlConfig instance config set "clusterio-host-1-instance-1" "factorio.settings" $inst1Json } | Out-Null
Invoke-Step "set host-2 factorio.settings" { docker exec surface-export-controller npx clusterioctl $ctlConfig instance config set "clusterio-host-2-instance-1" "factorio.settings" $inst2Json } | Out-Null
Write-Host "✓ auto_pause disabled" -ForegroundColor Green

# Start instances (may already be running if hosts auto-started them after container restart)
Write-Host ""
Write-Host "Starting instances (loading patched plugin code)..." -ForegroundColor Yellow
Invoke-InstanceLifecycle "start host-1 instance" 'already running' { docker exec surface-export-controller npx clusterioctl $ctlConfig instance start "clusterio-host-1-instance-1" }
Invoke-InstanceLifecycle "start host-2 instance" 'already running' { docker exec surface-export-controller npx clusterioctl $ctlConfig instance start "clusterio-host-2-instance-1" }
Start-Sleep -Seconds 3
Write-Host "✓ Instances started" -ForegroundColor Green

# ---------------------------------------------------------------------------------------------
# BOOT CHECK — did the patched save actually LOAD, and is it running THIS version?
#
# A Lua error during save-patching/save-load kills the headless server (exit 255) — the fixture-
# meters incident shipped exactly that through a full patch-and-reset, and the only signal was the
# instance dying with this script long gone reporting success. Poll each instance until it answers
# RCON; a crashed instance never answers and fails loud here, pointing at the log with the error.
#
# VERSION, not just presence (SC-72): a plain restart reuses the old patched script.dat, so "the
# plugin answers" is satisfiable by STALE code. The probe asks the module for its version stamp
# (module/version.lua, rewritten by the bump above) and only $NewVersion passes.
# ---------------------------------------------------------------------------------------------
Write-Host ""
Write-Host "Boot check: verifying the patched saves loaded with module version $NewVersion..." -ForegroundColor Yellow
$versionProbe = "/sc local i = remote.interfaces['surface_export'] " +
    "if not i then rcon.print('plugin-missing') " +
    "elseif not i['get_module_version'] then rcon.print('stale-module-no-version-oracle') " +
    "else rcon.print(remote.call('surface_export','get_module_version')) end"
foreach ($h in 1, 2) {
    $inst = "clusterio-host-$h-instance-1"
    $bootDeadline = (Get-Date).AddSeconds(90)
    $bootOk = $false
    $lastPing = ""
    while ((Get-Date) -lt $bootDeadline) {
        # Deliberately quiet: RCON POLL inside a bounded loop — a transient failure just means
        # "still booting" and the loop retries; the throw below is the real gate.
        $ping = docker exec surface-export-controller npx clusterioctl $ctlConfig --log-level error `
            instance send-rcon $inst $versionProbe 2>&1
        $lastPing = ($ping | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $lastPing -match "(?m)^\s*$([regex]::Escape($NewVersion))\s*$") { $bootOk = $true; break }
        # A WELL-FORMED wrong answer is final: a loaded save's stamp never changes without another
        # patch, so a stale version/sentinel will not become $NewVersion by polling — break to the
        # failure branch now instead of burning the full deadline (review note).
        if ($LASTEXITCODE -eq 0 -and $lastPing -match '(?m)^\s*(\d+\.\d+\.\d+|stale-module-no-version-oracle)\s*$') { break }
        Start-Sleep -Seconds 3
    }
    if ($bootOk) {
        Write-Host "  ✓ ${inst}: patched save loaded, module version $NewVersion answering" -ForegroundColor Green
    } else {
        Write-Host "  X ${inst} FAILED the boot check (no answer with module version $NewVersion within 90s)." -ForegroundColor Red
        if ($lastPing -match '(?m)^\s*(\d+\.\d+\.\d+|stale-module-no-version-oracle)\s*$') {
            Write-Host "    The instance IS answering — but with STALE module code (reported: $($Matches[1]))." -ForegroundColor Red
            Write-Host "    The save was not re-patched (a plain restart reuses old script.dat) — rerun patch-and-reset." -ForegroundColor Red
        } else {
            Write-Host "    A Lua error at save-load kills the server — read the actual error with:" -ForegroundColor Red
            Write-Host "    docker exec surface-export-host-$h sh -c 'tail -100 /clusterio/data/instances/$inst/factorio-current.log'" -ForegroundColor Red
        }
        throw "$inst did not come up with module version $NewVersion loaded. Do not trust this deploy."
    }
}
Write-Host ""
Write-Host "=== Patch and Reset Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Plugin changes from docker/seed-data/external_plugins/surface_export have been loaded." -ForegroundColor White
Write-Host "Instances have been reset to seed save state with fresh Lua code." -ForegroundColor White
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Check logs: .\tools\clusterio\check-cluster-logs.ps1" -ForegroundColor White
Write-Host "  2. Test export: docker exec surface-export-controller npx clusterioctl instance send-rcon 1 '/export-platform 2 2'" -ForegroundColor White
Write-Host "  3. Test import: docker exec surface-export-controller npx clusterioctl instance send-rcon 2 '/import-platform <filename>'" -ForegroundColor White

# Reaching here means every fail-fast step above passed ($ErrorActionPreference=Stop, plus explicit
# `throw`/`exit 1` on build + health failures). The final `instance start` still leaks a non-zero
# $LASTEXITCODE when an instance was already running — Invoke-InstanceLifecycle deliberately tolerates
# that message rather than aborting, but it cannot un-set the native exit code. Without this, a fully
# SUCCESSFUL run would report exit 1, confusing automation/CI and masking real failures.
exit 0
