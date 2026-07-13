# Shared version helpers for the plugin bump scripts (patch-and-reset.ps1, deploy-cluster.ps1).
# Dot-source:  . "$PSScriptRoot/version-utils.ps1"

function Update-PackageLockVersion {
    <#
    .SYNOPSIS
        Keep package-lock.json's version metadata in sync with package.json after a version bump.
    .DESCRIPTION
        npm rewrites the entire lockfile on its next lifecycle run whenever the lockfile's root
        "version" fields disagree with package.json (root-caused: the bump scripts updated
        package.json/module.json but never the lockfile, so agents kept reverting lockfile churn
        nobody intended). Targeted text replacement preserves every other byte of the lockfile.
    #>
    param(
        [Parameter(Mandatory)][string]$LockPath,
        [Parameter(Mandatory)][string]$NewVersion
    )
    if (-not (Test-Path $LockPath)) {
        Write-Warning "package-lock.json not found at $LockPath; skipping lockfile version sync"
        return
    }
    $raw = Get-Content $LockPath -Raw
    # The two fields npm compares against package.json: the root "version" (immediately after the
    # root "name") and packages."" "version".
    $updated = $raw -replace '(?s)^(\s*\{\s*"name":\s*"[^"]+",\s*"version":\s*")[^"]+(")', ('${1}' + $NewVersion + '${2}')
    $updated = $updated -replace '("packages":\s*\{\s*"":\s*\{\s*"name":\s*"[^"]+",\s*"version":\s*")[^"]+(")', ('${1}' + $NewVersion + '${2}')

    $check = $updated | ConvertFrom-Json -AsHashtable
    if ($check['version'] -ne $NewVersion -or $check['packages']['']['version'] -ne $NewVersion) {
        throw "package-lock.json version sync failed: expected both version fields to become $NewVersion (lockfile format changed?)"
    }
    if ($updated -ne $raw) {
        Set-Content $LockPath $updated -NoNewline -Encoding UTF8
        Write-Host "Updated package-lock.json version metadata -> $NewVersion" -ForegroundColor Green
    }
}
