function Update-JsonVersion {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$NewVersion)
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $full = (Resolve-Path -LiteralPath $Path).Path
    $raw = [IO.File]::ReadAllText($full, $encoding)
    $version = [regex]::new('("version"\s*:\s*")[^"]+(")')
    $updated = $version.Replace($raw, ('${1}' + $NewVersion + '${2}'), 1)
    if (($updated | ConvertFrom-Json).version -ne $NewVersion) { throw "Cannot update root version in $Path" }
    [IO.File]::WriteAllText($full, $updated, $encoding)
}

function Update-ModuleVersionStamp {
    param(
        [Parameter(Mandatory)][string]$ModuleDir,
        [Parameter(Mandatory)][string]$NewVersion
    )
    if (-not (Test-Path $ModuleDir)) {
        throw "Update-ModuleVersionStamp: module directory not found at $ModuleDir"
    }
    $stampPath = Join-Path (Resolve-Path $ModuleDir).Path "version.lua"
    $ending = if ((Test-Path $stampPath) -and [IO.File]::ReadAllText($stampPath).Contains("`r`n")) { "`r`n" } else { "`n" }
    [System.IO.File]::WriteAllText($stampPath, "return `"$NewVersion`"$ending", [Text.UTF8Encoding]::new($false, $true))
    Write-Host "Updated module/version.lua stamp -> $NewVersion" -ForegroundColor Green
}

function Update-PackageLockVersion {
    param(
        [Parameter(Mandatory)][string]$LockPath,
        [Parameter(Mandatory)][string]$NewVersion
    )
    if (-not (Test-Path $LockPath)) {
        Write-Warning "package-lock.json not found at $LockPath; skipping lockfile version sync"
        return
    }
    $raw = [System.IO.File]::ReadAllText((Resolve-Path $LockPath).Path, [Text.UTF8Encoding]::new($false, $true))
    $rootPattern = '^(\s*\{\s*"name":\s*"[^"]+",\s*"version":\s*")[^"]+(")'
    $pkgPattern  = '("packages":\s*\{\s*"":\s*\{\s*"name":\s*"[^"]+",\s*"version":\s*")[^"]+(")'
    $updated = $raw -replace $rootPattern, ('${1}' + $NewVersion + '${2}')
    $updated = $updated -replace $pkgPattern, ('${1}' + $NewVersion + '${2}')

    $escaped = [regex]::Escape($NewVersion)
    $rootOk = $updated -match ('^(\s*\{\s*"name":\s*"[^"]+",\s*"version":\s*")' + $escaped + '(")')
    $pkgOk  = $updated -match ('("packages":\s*\{\s*"":\s*\{\s*"name":\s*"[^"]+",\s*"version":\s*")' + $escaped + '(")')
    if (-not ($rootOk -and $pkgOk)) {
        Write-Warning ("package-lock.json version sync did not match the expected format; lockfile left " +
            "unchanged (npm may rewrite it on its next lifecycle run). Update the patterns in tools/shared/version-utils.ps1.")
        return
    }
    if ($updated -ne $raw) {
        [System.IO.File]::WriteAllText((Resolve-Path $LockPath).Path, $updated, [Text.UTF8Encoding]::new($false, $true))
        Write-Host "Updated package-lock.json version metadata -> $NewVersion" -ForegroundColor Green
    }
}
