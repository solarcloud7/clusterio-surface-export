function Invoke-WorkflowLock {
    param([Parameter(Mandatory)][scriptblock]$Action,
        [string]$Path = (Join-Path $PSScriptRoot '../../ci-artifacts/workflow.lock'))
    $lockPath = [IO.Path]::GetFullPath($Path)
    [IO.Directory]::CreateDirectory((Split-Path $lockPath)) | Out-Null
    $previous = $env:SE_WORKFLOW_TOKEN
    if (Test-Path -LiteralPath $lockPath) {
        $owner = Get-Content -LiteralPath $lockPath -Raw -Encoding utf8 | ConvertFrom-Json
        if ($previous -and $owner.token -eq $previous) { & $Action; return }
        throw "Build/deploy/browser workflow already owns $lockPath (PID $($owner.pid)). Wait for it to finish. After a crash, verify that owner has stopped before removing the lock."
    }
    # CreateNew is atomic; a competing writer cannot pass the existence check and also acquire it.
    $stream = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $env:SE_WORKFLOW_TOKEN = [guid]::NewGuid().ToString()
        $bytes = [Text.Encoding]::UTF8.GetBytes((@{ pid = $PID; token = $env:SE_WORKFLOW_TOKEN } | ConvertTo-Json -Compress))
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
        & $Action
    } finally {
        $env:SE_WORKFLOW_TOKEN = $previous
        $stream.Dispose()
        Remove-Item -LiteralPath $lockPath
    }
}
