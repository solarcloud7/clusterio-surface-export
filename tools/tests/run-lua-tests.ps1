param(
    [string[]]$Test = @(),
    [switch]$List
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
$workflow = Get-Content -Raw -LiteralPath "$repoRoot/.github/workflows/ci.yml"
$ciTests = @([regex]::Matches($workflow, '(?m)^\s+lua5\.2 (tests/[a-zA-Z0-9_./-]+\.lua)\s*$') |
    ForEach-Object { $_.Groups[1].Value })
if ($ciTests.Count -eq 0) { throw 'No Lua tests found in ci.yml; inspect the CI runner before proceeding.' }
if ($List) { $ciTests; exit 0 }
Write-Host 'Standalone Lua 5.2 unit checks; Factorio sandbox/API compatibility requires pinned-engine acceptance.'
if ($Test.Count -eq 0) { $Test = $ciTests }
foreach ($testPath in $Test) {
    if ($testPath -notin $ciTests) { throw "Not a CI Lua test: $testPath. Use -List for supported paths." }
}

docker version --format '{{.Server.Version}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop must be running.' }
$dockerfile = "$repoRoot/tools/clusterio/lua-tests.Dockerfile"
$recipeHash = (Get-FileHash -LiteralPath $dockerfile -Algorithm SHA256).Hash.ToLowerInvariant()
$image = "surface-export-lua-tests:$($recipeHash.Substring(0, 12))"
# Stdin sends only the reviewed Dockerfile, never the checkout as build context.
Get-Content -Raw -LiteralPath $dockerfile | docker build --tag $image -
if ($LASTEXITCODE -ne 0) { throw 'Lua test image build failed.' }

$runDirectory = Join-Path $repoRoot "ci-artifacts/lua-tests-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $runDirectory | Out-Null
$results = @()
foreach ($testPath in $Test) {
    $mounts = @(
        'docker/seed-data/external_plugins/surface_export/module',
        $testPath
    )
    if ($testPath -eq 'tests/mods/gateway-layout.lua') { $mounts += 'docker/seed-data/mods-src/surfexp_gateways' }
    if ($testPath -eq 'tests/lua/callback-profiler.lua') { $mounts += 'tests/instruments/callback-profile/probe.lua' }
    if ($testPath -eq 'tests/manual/transfer-reliability/performance.test.lua') {
        $mounts += 'tests/manual/transfer-reliability/performance.lua'
    }
    $dockerArgs = @('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '128m', '-w', '/repo')
    foreach ($relativePath in $mounts) {
        $sourcePath = (Resolve-Path -LiteralPath (Join-Path $repoRoot $relativePath)).Path
        $dockerArgs += @('--mount', "type=bind,src=$sourcePath,dst=/repo/$relativePath,readonly")
    }
    $dockerArgs += @($image, $testPath)
    $logPath = Join-Path $runDirectory ($testPath.Replace('/', '_') + '.log')
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    & docker @dockerArgs *> $logPath
    $testExit = $LASTEXITCODE
    $timer.Stop()
    Get-Content -LiteralPath $logPath
    $results += [ordered]@{ test = $testPath; exitCode = $testExit; elapsedMs = $timer.Elapsed.TotalMilliseconds; log = $logPath }
    if ($testExit -ne 0) { break }
}
[ordered]@{ image = $image; recipeSha256 = $recipeHash; requested = $Test; results = $results } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runDirectory 'result.json')
Write-Host "Lua test evidence: $runDirectory"
if (@($results | Where-Object { $_.exitCode -ne 0 }).Count -gt 0) { exit 1 }
