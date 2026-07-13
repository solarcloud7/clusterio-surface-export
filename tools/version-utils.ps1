# Shared version helpers for the plugin bump scripts (patch-and-reset.ps1, deploy-cluster.ps1).
# Dot-source:  . "$PSScriptRoot/version-utils.ps1"
# Compatible with Windows PowerShell 5.1 and pwsh 7 (no 6+-only parameters).

function Update-PackageLockVersion {
    <#
    .SYNOPSIS
        Keep package-lock.json's version metadata in sync with package.json after a version bump.
    .DESCRIPTION
        npm rewrites the entire lockfile on its next lifecycle run whenever the lockfile's root
        "version" fields disagree with package.json (root-caused: the bump scripts updated
        package.json/module.json but never the lockfile, so agents kept reverting lockfile churn
        nobody intended). Targeted text replacement preserves every other byte of the lockfile.

        Deliberately NON-FATAL: if the lockfile format ever drifts past the regexes, this warns
        and returns instead of throwing — the callers have already written package.json and
        module.json, and aborting there would strand a half-bumped tree with the deploy never run.
        A failed sync merely resumes the pre-fix churn behavior, loudly.
    #>
    param(
        [Parameter(Mandatory)][string]$LockPath,
        [Parameter(Mandatory)][string]$NewVersion
    )
    if (-not (Test-Path $LockPath)) {
        Write-Warning "package-lock.json not found at $LockPath; skipping lockfile version sync"
        return
    }
    $raw = [System.IO.File]::ReadAllText((Resolve-Path $LockPath).Path)
    # The two fields npm compares against package.json: the root "version" (immediately after the
    # root "name") and packages."" "version".
    $rootPattern = '^(\s*\{\s*"name":\s*"[^"]+",\s*"version":\s*")[^"]+(")'
    $pkgPattern  = '("packages":\s*\{\s*"":\s*\{\s*"name":\s*"[^"]+",\s*"version":\s*")[^"]+(")'
    $updated = $raw -replace $rootPattern, ('${1}' + $NewVersion + '${2}')
    $updated = $updated -replace $pkgPattern, ('${1}' + $NewVersion + '${2}')

    # Self-check with the same anchored patterns (no JSON re-parse: -AsHashtable is pwsh 6+ only).
    $escaped = [regex]::Escape($NewVersion)
    $rootOk = $updated -match ('^(\s*\{\s*"name":\s*"[^"]+",\s*"version":\s*")' + $escaped + '(")')
    $pkgOk  = $updated -match ('("packages":\s*\{\s*"":\s*\{\s*"name":\s*"[^"]+",\s*"version":\s*")' + $escaped + '(")')
    if (-not ($rootOk -and $pkgOk)) {
        Write-Warning ("package-lock.json version sync did not match the expected format; lockfile left " +
            "unchanged (npm may rewrite it on its next lifecycle run). Update the patterns in tools/version-utils.ps1.")
        return
    }
    if ($updated -ne $raw) {
        # WriteAllText writes UTF-8 without BOM on both 5.1 and 7 (Set-Content -Encoding UTF8 adds a BOM on 5.1).
        [System.IO.File]::WriteAllText((Resolve-Path $LockPath).Path, $updated)
        Write-Host "Updated package-lock.json version metadata -> $NewVersion" -ForegroundColor Green
    }
}
