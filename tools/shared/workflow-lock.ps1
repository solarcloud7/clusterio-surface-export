function Get-WorkflowLockSource {
    $checkout = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $source = [ordered]@{ checkout = $checkout; branch = $null; commit = $null; startedAt = [DateTime]::UtcNow.ToString('o') }
    # Deliberately quiet: existence probe; a machine without git still takes the lock, recording no branch or commit.
    if (-not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) { return $source }
    $branch = git -C $checkout rev-parse --abbrev-ref HEAD 2>$null
    if ($LASTEXITCODE -eq 0) { $source.branch = "$branch".Trim() }
    $commit = git -C $checkout rev-parse --short=12 HEAD 2>$null
    if ($LASTEXITCODE -eq 0) { $source.commit = "$commit".Trim() }
    return $source
}

function Test-WorkflowLockOwnerGone($owner) {
    $ownerPid = 0
    if (-not [int]::TryParse("$($owner.pid)", [ref]$ownerPid) -or $ownerPid -le 0) { return $false }
    $process = $null
    try { $process = Get-Process -Id $ownerPid -ErrorAction Stop } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { return $true }
    $started = $owner.startedAt
    if ($started -isnot [DateTime]) {
        $parsed = [DateTime]::MinValue
        if (-not [DateTime]::TryParse("$started", [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed)) { return $false }
        $started = $parsed
    }
    # A process that started after the lock was written reused the recorded PID. An unreadable
    # start time (another user's process) counts as a live owner.
    $processStart = $null
    try { $processStart = $process.StartTime } catch [System.ComponentModel.Win32Exception] { return $false }
    return $processStart.ToUniversalTime() -gt $started.ToUniversalTime().AddSeconds(2)
}

function Invoke-WorkflowLock {
    param([Parameter(Mandatory)][scriptblock]$Action,
        [string]$Path = (Join-Path $PSScriptRoot '../../ci-artifacts/workflow.lock'))
    $lockPath = [IO.Path]::GetFullPath($Path)
    [IO.Directory]::CreateDirectory((Split-Path $lockPath)) | Out-Null
    $previous = $env:SE_WORKFLOW_TOKEN
    $source = Get-WorkflowLockSource
    if (Test-Path -LiteralPath $lockPath) {
        $owner = Get-Content -LiteralPath $lockPath -Raw -Encoding utf8 | ConvertFrom-Json
        if ($previous -and $owner.token -eq $previous) { & $Action; return }
        if ($owner.token -and (Test-WorkflowLockOwnerGone $owner)) {
            $current = Get-Content -LiteralPath $lockPath -Raw -Encoding utf8 | ConvertFrom-Json
            if ($current.token -eq $owner.token) {
                Remove-Item -LiteralPath $lockPath
                Write-Warning "Reclaimed a stale workflow lock: PID $($owner.pid) (branch $($owner.branch) at $($owner.commit), started $($owner.startedAt)) is no longer running."
            }
        }
    }
    if (Test-Path -LiteralPath $lockPath) {
        $owner = Get-Content -LiteralPath $lockPath -Raw -Encoding utf8 | ConvertFrom-Json
        throw "Build/deploy/browser workflow already owns $lockPath (PID $($owner.pid), branch $($owner.branch) at $($owner.commit), started $($owner.startedAt)). Wait for it to finish. After a crash, verify that owner has stopped before removing the lock."
    }
    # CreateNew is atomic; a competing writer cannot pass the existence check and also acquire it.
    $stream = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $env:SE_WORKFLOW_TOKEN = [guid]::NewGuid().ToString()
        $bytes = [Text.Encoding]::UTF8.GetBytes((([ordered]@{ pid = $PID; token = $env:SE_WORKFLOW_TOKEN } + $source) | ConvertTo-Json -Compress))
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
        & $Action
    } finally {
        $env:SE_WORKFLOW_TOKEN = $previous
        $stream.Dispose()
        Remove-Item -LiteralPath $lockPath
    }
}
