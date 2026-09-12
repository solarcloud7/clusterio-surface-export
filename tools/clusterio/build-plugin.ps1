param(
    [ValidateSet('all', 'node', 'web', 'lint', 'test', 'smoke')][string]$Target = 'all',
    [switch]$Fresh,
    [switch]$RestartController,
    [switch]$RestartHosts,
    [string]$OutputDirectory,
    [string]$PackageDirectory
)

$ErrorActionPreference = 'Stop'

$PluginPath = (Resolve-Path "$PSScriptRoot/../../docker/seed-data/external_plugins/surface_export").Path
$DepsVolume = 'se_plugin_build_nm'
$Image = 'node:24-bookworm-slim'
$OutputMount = @()
$PackageMount = @()
if ($PackageDirectory) {
    if (-not $OutputDirectory) { throw 'A staged package requires isolated build output.' }
    $RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
    $ArtifactRoot = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'ci-artifacts')) + [IO.Path]::DirectorySeparatorChar
    $PackageCandidate = if ([IO.Path]::IsPathRooted($PackageDirectory)) { $PackageDirectory } else { Join-Path $RepoRoot $PackageDirectory }
    $StagedPackage = (Resolve-Path -LiteralPath $PackageCandidate).Path
    if (-not $StagedPackage.StartsWith($ArtifactRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Staged packages must be under ci-artifacts.'
    }
    $PluginPath = $StagedPackage
}
if ($OutputDirectory) {
    if ($RestartController -or $RestartHosts) { throw 'An isolated build cannot restart the development cluster.' }
    $RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
    $OutputCandidate = if ([IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory } else { Join-Path $RepoRoot $OutputDirectory }
    $ResolvedOutput = [IO.Path]::GetFullPath($OutputCandidate)
    $ArtifactRoot = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'ci-artifacts')) + [IO.Path]::DirectorySeparatorChar
    if (-not $ResolvedOutput.StartsWith($ArtifactRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Isolated build output must be under ci-artifacts.'
    }
    New-Item -ItemType Directory -Force -Path $ResolvedOutput | Out-Null
}

. "$PSScriptRoot/../shared/workflow-lock.ps1"
Invoke-WorkflowLock {
$lockPath = Join-Path $PluginPath 'package-lock.json'
$LockSnapshot = Join-Path ([IO.Path]::GetTempPath()) ("se-build-lock-" + [guid]::NewGuid().ToString('N') + '.json')
try {
[IO.File]::WriteAllBytes($LockSnapshot, [IO.File]::ReadAllBytes($lockPath))
$lockHash = (Get-FileHash -LiteralPath $LockSnapshot -Algorithm SHA256).Hash

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
         "if [ ! -x node_modules/.bin/webpack-cli ] || [ ! -f node_modules/.se-build-lock-sha256 ] || " +
         "[ `"`$(cat node_modules/.se-build-lock-sha256)`" != '$lockHash' ]; then " +
         "echo '[deps] npm ci'; rm -f node_modules/.se-build-lock-sha256; SE_SKIP_PREPARE=1 npm ci --no-audit --no-fund; " +
         "echo '$lockHash' > node_modules/.se-build-lock-sha256; fi; " +
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
if ($PackageDirectory -and $Target -in @('lint', 'test', 'smoke')) {
    $PackageMount = @('--mount', "type=bind,src=$PluginPath,dst=$WorkDir")
}
docker run --rm `
    @OutputMount `
    @PackageMount `
    --mount "type=bind,src=$MountSrc,dst=$MountDst" `
    --mount "type=bind,src=$LockSnapshot,dst=$WorkDir/package-lock.json,readonly" `
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
} finally {
    if (Test-Path -LiteralPath $LockSnapshot) { Remove-Item -LiteralPath $LockSnapshot -Force -ErrorAction Stop }
}
}
