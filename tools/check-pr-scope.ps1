[CmdletBinding()]
param([string]$Base)

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

    # Deliberately quiet: this is an EXISTENCE PROBE. A missing ref is the question being asked,
    $output = & git -C $Repository rev-parse --verify --quiet "$Ref^{commit}" 2>$null
    if ($LASTEXITCODE -eq 0) {
        return ($output -join "`n").Trim()
    }
    return '<missing>'
}

function Resolve-PullRequestBase {
    # Deliberately quiet: existence probe for the optional GitHub CLI; without it the base is main.
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { return 'main', 'default; gh is not installed' }
    $output = & gh pr view --json 'number,baseRefName,state' 2>&1
    if ($LASTEXITCODE -ne 0) { return 'main', "default; gh found no pull request for this branch: $(($output -join ' ').Trim())" }
    $pullRequest = (@($output | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] }) -join "`n") | ConvertFrom-Json
    if ($pullRequest.state -ne 'OPEN') { return 'main', "default; pull request #$($pullRequest.number) is $($pullRequest.state)" }
    return $pullRequest.baseRefName, "pull request #$($pullRequest.number)"
}

try {
    $repository = Invoke-GitCapture @('rev-parse', '--show-toplevel')
    Invoke-GitCapture @('-C', $repository, 'fetch', '--prune', 'origin') | Out-Null

    $baseSource = 'given with -Base'
    if (-not $Base) { $Base, $baseSource = Resolve-PullRequestBase }
    $Base = $Base -replace '^origin/', ''
    $originBase = "origin/$Base"

    $head = Invoke-GitCapture @('-C', $repository, 'rev-parse', 'HEAD')
    $localCommit = Resolve-OptionalCommit -Repository $repository -Ref $Base
    $originCommit = Resolve-OptionalCommit -Repository $repository -Ref $originBase
    if ($originCommit -eq '<missing>') {
        throw "$originBase is missing after git fetch --prune origin"
    }
    $mergeBase = Invoke-GitCapture @('-C', $repository, 'merge-base', $originBase, 'HEAD')

    $commits = Invoke-GitCapture @('-C', $repository, 'log', '--oneline', "$originBase..HEAD")
    if (-not $commits) { $commits = '(none)' }
    $diffStat = Invoke-GitCapture @('-C', $repository, 'diff', '--stat', "$originBase...HEAD")
    if (-not $diffStat) { $diffStat = '(no changes)' }

    $lockPath = 'docker/seed-data/external_plugins/surface_export/package-lock.json'
    & git -C $repository diff --quiet "$originBase...HEAD" -- $lockPath
    $lockExit = $LASTEXITCODE
    if ($lockExit -gt 1) {
        throw 'git diff could not determine package-lock.json scope'
    }
    $lockDiffers = if ($lockExit -eq 1) { 'YES' } else { 'no' }

    Write-Output "Repository:    $repository"
    Write-Output "Base:          $originBase ($baseSource)"
    Write-Output "HEAD:          $head"
    Write-Output ('{0,-14} {1}' -f "Local ${Base}:", $localCommit)
    Write-Output ('{0,-14} {1}' -f "Origin ${Base}:", $originCommit)
    Write-Output "Merge base:    $mergeBase"
    Write-Output "package-lock.json differs: $lockDiffers"
    Write-Output ''
    Write-Output "Commits in $originBase..HEAD:"
    Write-Output $commits
    Write-Output ''
    Write-Output "Diff stat for $originBase...HEAD:"
    Write-Output $diffStat

    & git -C $repository merge-base --is-ancestor $originBase HEAD
    if ($LASTEXITCODE -eq 1) {
        [Console]::Error.WriteLine("Scope check: FAIL - $originBase is not an ancestor of HEAD. Rebase or merge the freshly fetched base before opening the PR.")
        exit 1
    }
    if ($LASTEXITCODE -ne 0) {
        throw "git merge-base --is-ancestor $originBase HEAD failed unexpectedly"
    }

    Write-Output ''
    Write-Output "Scope check: PASS - $originBase is an ancestor of HEAD."
    exit 0
} catch {
    [Console]::Error.WriteLine("Scope check: ERROR - $($_.Exception.Message)")
    exit 2
}
