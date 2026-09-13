function Get-NextPluginVersion {
    param([Parameter(Mandatory)][string]$Version)
    $match = [regex]::Match($Version, '\A(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<channel>alpha|beta|rc)\.(?<sequence>0|[1-9]\d*))?\z')
    if (-not $match.Success) { throw "Unsupported plugin version: $Version" }
    $base = '{0}.{1}' -f $match.Groups['major'].Value, $match.Groups['minor'].Value
    if ($match.Groups['channel'].Success) {
        throw "Automatic prerelease bumps are disabled for $Version. Choose release versions explicitly, or use -SkipIncrement with a deployment scope that supports it."
    }
    return '{0}.{1}' -f $base, (1 + [long]$match.Groups['patch'].Value)
}

function Get-ModuleVersionResponse {
    param([AllowEmptyString()][string]$Output)
    $match = [regex]::Match($Output, '(?m)^[\t ]*(?<version>\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?|stale-module-no-version-oracle)[\t ]*\r?$')
    if ($match.Success) { return $match.Groups['version'].Value }
    return $null
}

function Update-ModuleBuildStamp {
    param([Parameter(Mandatory)][string]$ModuleDir)
    $buildId = [guid]::NewGuid().ToString('N')
    $path = Join-Path (Resolve-Path -LiteralPath $ModuleDir).Path 'build-id.lua'
    [IO.File]::WriteAllText($path, "return `"$buildId`"`n", [Text.UTF8Encoding]::new($false, $true))
    return $buildId
}

function Get-ModuleDeploymentProbe {
    return "/sc local i=remote.interfaces['surface_export']; " +
        "rcon.print(helpers.table_to_json({version=i and i.get_module_version and remote.call('surface_export','get_module_version'), " +
        "buildId=i and i.get_module_build_id and remote.call('surface_export','get_module_build_id')}))"
}

function Get-ModuleDeploymentResponse {
    param([AllowEmptyString()][string]$Output)
    foreach ($line in ($Output -split "`r?`n")) {
        if (-not $line.TrimStart().StartsWith('{')) { continue }
        try { $record = ConvertFrom-Json -InputObject $line -ErrorAction Stop } catch { continue }
        if ($record.version -is [string] -and (Get-ModuleVersionResponse $record.version)) { return $record }
    }
    return $null
}

function Test-ModuleDeploymentResponse {
    param([AllowEmptyString()][string]$Output, [string]$Version, [string]$BuildId)
    if ($BuildId -cnotmatch '\A[a-f0-9]{32}\z') { return $false }
    $record = Get-ModuleDeploymentResponse $Output
    return $null -ne $record -and $record.version -ceq $Version -and
        $record.buildId -is [string] -and $record.buildId -ceq $BuildId
}

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
