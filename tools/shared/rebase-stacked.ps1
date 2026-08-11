# rebase-stacked — re-park a stacked branch after its base was squash-merged.
# requires: a clean working tree; the SHA of the old base's tip (the last commit that got squashed)
# produces: the branch rebased --onto the fresh base, a diff-stat sanity report, and — always — the
#           CI reminder block, because a squash-merged base ORPHANS check runs and a head with zero
#           runs looks exactly like a green one in the PR list
# does not: push unless -Push, resolve conflicts (it stops and tells you), or delete the old base
param(
    [Parameter(Mandatory)][string]$OldBaseTip,
    [string]$Branch,
    [string]$BaseRef = 'origin/main',
    [switch]$Push
)

$ErrorActionPreference = 'Stop'

$dirty = git status --porcelain
if ($dirty) {
    throw "Working tree is not clean — commit or stash first. A rebase over uncommitted work is how edits get lost:`n$dirty"
}

if (-not $Branch) { $Branch = (git branch --show-current).Trim() }
if (-not $Branch) { throw "Detached HEAD — pass -Branch explicitly." }

git fetch origin --prune
if ($LASTEXITCODE -ne 0) { throw "git fetch failed (exit $LASTEXITCODE)" }

git cat-file -e "$OldBaseTip^{commit}" 2>$null
if ($LASTEXITCODE -ne 0) { throw "'$OldBaseTip' is not a commit — pass the tip of the branch that was squash-merged." }

Write-Host "Rebasing $Branch --onto $BaseRef, dropping everything up to $OldBaseTip ..." -ForegroundColor Cyan
git rebase --onto $BaseRef $OldBaseTip $Branch
if ($LASTEXITCODE -ne 0) {
    throw "Rebase stopped (likely conflicts). Resolve and 'git rebase --continue', or 'git rebase --abort'. This tool does not guess resolutions."
}

Write-Host "`nCommits now on $Branch beyond ${BaseRef}:" -ForegroundColor Cyan
git log --oneline "$BaseRef..$Branch"
Write-Host "`nDiff stat vs ${BaseRef}:" -ForegroundColor Cyan
git diff --stat "$BaseRef...$Branch" | Select-Object -Last 5

if ($Push) {
    git push --force-with-lease origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "push failed (exit $LASTEXITCODE)" }
    Write-Host "Pushed." -ForegroundColor Green
}

$head = (git rev-parse --short $Branch).Trim()
Write-Host "`n=== REMINDER — do this before calling the PR ready ===" -ForegroundColor Yellow
Write-Host "The squash-merge that made this rebase necessary ORPHANS CI runs: the PR can show a" -ForegroundColor Yellow
Write-Host "previous head's green while THIS head ($head) has zero check runs. Verify with:" -ForegroundColor Yellow
Write-Host "    gh pr checks <PR#>        # and confirm the runs are for $head, not an older SHA"
if ($Push) {
    # Deliberately quiet on failure: gh may be unauthenticated in some shells; the reminder above
    # stands on its own and the check below is best-effort convenience.
    $checks = gh pr list --head $Branch --json number --jq '.[0].number' 2>$null
    if ($? -and $checks) {
        Write-Host "`nChecks on PR #${checks} right now:" -ForegroundColor Cyan
        gh pr checks $checks 2>$null | Out-Host
        if (-not $?) { Write-Host "  (none reported yet — that IS the orphaned state; re-check in a minute)" -ForegroundColor Yellow }
    }
}
