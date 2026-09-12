param(
    [ValidateSet('all', 'node', 'web', 'lint', 'test', 'smoke')][string]$Target = 'all',
    [switch]$Fresh,
    [switch]$RestartController,
    [switch]$RestartHosts,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'

$PluginPath = (Resolve-Path "$PSScriptRoot/../../docker/seed-data/external_plugins/surface_export").Path
$DepsVolume = 'se_plugin_build_nm'
$Image = 'node:24-bookworm-slim'
$OutputMount = @()
if ($OutputDirectory) {
    if ($RestartController -or $RestartHosts) { throw 'An isolated build cannot restart the development cluster.' }
    $RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
    $ResolvedOutput = [IO.Path]::GetFullPath((Join-Path $RepoRoot $OutputDirectory))
    $ArtifactRoot = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'ci-artifacts')) + [IO.Path]::DirectorySeparatorChar
    if (-not $ResolvedOutput.StartsWith($ArtifactRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Isolated build output must be under ci-artifacts.'
    }
    New-Item -ItemType Directory -Force -Path $ResolvedOutput | Out-Null
}

. "$PSScriptRoot/../shared/workflow-lock.ps1"
Invoke-WorkflowLock {
$lockPath = Join-Path $PluginPath 'package-lock.json'
$lockHash = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash

docker version --format '{{.Server.Version}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Docker does not appear to be running. Start Docker Desktop and retry." }

$BuildScript = switch ($Target) {
    'web'  { 'npm run build:browser; npm run build:web' }
    'node' { 'npm run build:node' }
    'lint' { 'npm run lint' }
    'test' { 'npm test' }
    'smoke' { 'npm run test:lifecycle' }
    default { 'npm run build' }
}

if ($Fresh) {
    Write-Host "Dropping cached deps volume ($DepsVolume) for a clean npm ci..." -ForegroundColor Yellow
    # Deliberately quiet: the volume may not exist yet, which is the normal first-run case.
    docker volume rm $DepsVolume 2>$null | Out-Null
}

$Inner = "set -e; echo '[node] '`$(node -v); " +
         "if [ ! -x node_modules/.bin/webpack-cli ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then " +
         "echo '[deps] npm ci'; SE_SKIP_PREPARE=1 npm ci --no-audit --no-fund; fi; " +
         "echo '[build] $BuildScript'; $BuildScript; echo '[ok] build complete'"

if ($Target -in @('lint', 'test', 'smoke')) {
    $RepoPath = (Resolve-Path "$PSScriptRoot/../..").Path
    $MountSrc = $RepoPath
    $MountDst = '/repo'
    $WorkDir = '/repo/docker/seed-data/external_plugins/surface_export'
} else {
    $MountSrc = $PluginPath
    $MountDst = '/app'
    $WorkDir = '/app'
}

Write-Host "Building plugin ($Target) in $Image ..." -ForegroundColor Cyan
if ($OutputDirectory) { $OutputMount = @('--mount', "type=bind,src=$ResolvedOutput,dst=$WorkDir/dist") }
docker run --rm `
    @OutputMount `
    --mount "type=bind,src=$MountSrc,dst=$MountDst" `
    --mount "type=bind,src=$lockPath,dst=$WorkDir/package-lock.json,readonly" `
    -v "${DepsVolume}:$WorkDir/node_modules" `
    -w $WorkDir `
    $Image `
    sh -c $Inner

if ($LASTEXITCODE -ne 0) { throw "Plugin build failed (exit $LASTEXITCODE)" }
if ((Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash -ne $lockHash) {
    throw 'package-lock.json changed during the build. Stop and inspect the concurrent writer; dependency metadata must stay unchanged.'
}

if ($RestartController) {
    Write-Host "Restarting controller to re-read dist/web/manifest.json ..." -ForegroundColor Cyan
    docker restart surface-export-controller | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Controller restart failed (exit $LASTEXITCODE) — build succeeded, but the new bundle isn't being served yet." }
    Write-Host "Controller restarted. Hard-reload not needed — chunks are content-hashed." -ForegroundColor Green
}

if ($RestartHosts) {
    Write-Host "Restarting hosts to reload dist/node/*.js ..." -ForegroundColor Cyan
    docker restart surface-export-host-1 surface-export-host-2 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Host restart failed (exit $LASTEXITCODE) — build succeeded, but the new node bundle isn't loaded yet." }
    Write-Host "Hosts restarted." -ForegroundColor Green
}

Write-Host "Done: $Target build complete." -ForegroundColor Green
}
