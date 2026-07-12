[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Invoke-GitCapture {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $output = & git @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed:`n$($output -join "`n")"
    }
    return ($output -join "`n").Trim()
}

function Resolve-OptionalCommit {
    param(
        [Parameter(Mandatory)][string]$Repository,
        [Parameter(Mandatory)][string]$Ref
    )

    $output = & git -C $Repository rev-parse --verify --quiet "$Ref^{commit}" 2>$null
    if ($LASTEXITCODE -eq 0) {
        return ($output -join "`n").Trim()
    }
    return '<missing>'
}

try {
    $repository = Invoke-GitCapture @('rev-parse', '--show-toplevel')
    Invoke-GitCapture @('-C', $repository, 'fetch', '--prune', 'origin') | Out-Null

    $head = Invoke-GitCapture @('-C', $repository, 'rev-parse', 'HEAD')
    $localMain = Resolve-OptionalCommit -Repository $repository -Ref 'main'
    $originMain = Resolve-OptionalCommit -Repository $repository -Ref 'origin/main'
    if ($originMain -eq '<missing>') {
        throw 'origin/main is missing after git fetch --prune origin'
    }
    $mergeBase = Invoke-GitCapture @('-C', $repository, 'merge-base', 'origin/main', 'HEAD')

    $commits = Invoke-GitCapture @('-C', $repository, 'log', '--oneline', 'origin/main..HEAD')
    if (-not $commits) { $commits = '(none)' }
    $diffStat = Invoke-GitCapture @('-C', $repository, 'diff', '--stat', 'origin/main...HEAD')
    if (-not $diffStat) { $diffStat = '(no changes)' }

    $lockPath = 'docker/seed-data/external_plugins/surface_export/package-lock.json'
    & git -C $repository diff --quiet 'origin/main...HEAD' -- $lockPath
    $lockExit = $LASTEXITCODE
    if ($lockExit -gt 1) {
        throw 'git diff could not determine package-lock.json scope'
    }
    $lockDiffers = if ($lockExit -eq 1) { 'YES' } else { 'no' }

    Write-Output "Repository:    $repository"
    Write-Output "HEAD:          $head"
    Write-Output "Local main:    $localMain"
    Write-Output "Origin main:   $originMain"
    Write-Output "Merge base:    $mergeBase"
    Write-Output "package-lock.json differs: $lockDiffers"
    Write-Output ''
    Write-Output 'Commits in origin/main..HEAD:'
    Write-Output $commits
    Write-Output ''
    Write-Output 'Diff stat for origin/main...HEAD:'
    Write-Output $diffStat

    & git -C $repository merge-base --is-ancestor origin/main HEAD
    if ($LASTEXITCODE -eq 1) {
        [Console]::Error.WriteLine('Scope check: FAIL - origin/main is not an ancestor of HEAD. Rebase or merge the freshly fetched base before opening the PR.')
        exit 1
    }
    if ($LASTEXITCODE -ne 0) {
        throw 'git merge-base --is-ancestor origin/main HEAD failed unexpectedly'
    }

    Write-Output ''
    Write-Output 'Scope check: PASS - origin/main is an ancestor of HEAD.'
    exit 0
} catch {
    [Console]::Error.WriteLine("Scope check: ERROR - $($_.Exception.Message)")
    exit 2
}
