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
