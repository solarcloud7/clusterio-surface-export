[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('artifacts', 'lua', 'plugin', 'cluster')]
    [string]$Scope,

    [ValidateSet('all', 'node', 'web')][string]$Target = 'all',
    [switch]$Fresh,
    [switch]$RestartController,
    [switch]$RestartHosts,
    [switch]$SkipIncrement,
    [switch]$KeepData,
    [switch]$KeepSaves
)

$ErrorActionPreference = 'Stop'

$scopeParams = @{
    artifacts = @('Target', 'Fresh', 'RestartController', 'RestartHosts')
    lua       = @('KeepSaves')
    plugin    = @('KeepSaves')
    cluster   = @('SkipIncrement', 'KeepData')
}
$suppliedNames = @($PSBoundParameters.Keys | Where-Object { $_ -ne 'Scope' -and $_ -notin @('Verbose', 'Debug', 'ErrorAction', 'WarningAction', 'InformationAction', 'ErrorVariable', 'WarningVariable', 'InformationVariable', 'OutVariable', 'OutBuffer', 'PipelineVariable') })
$rejected = @($suppliedNames | Where-Object { $_ -notin $scopeParams[$Scope] })
if ($rejected.Count -gt 0) {
    $allowed = if ($scopeParams[$Scope].Count) { $scopeParams[$Scope] -join ', ' } else { '(none)' }
    throw ("-Scope $Scope does not accept: $($rejected -join ', '). Accepted for this scope: $allowed. " +
        "Refusing rather than ignoring the flag — a silently dropped switch is how you end up believing " +
        "you deployed something you did not.")
}

$here = $PSScriptRoot
. (Join-Path $here '../shared/cluster-utils.ps1')
. (Join-Path $here '../shared/workflow-lock.ps1')

Invoke-WorkflowLock {
switch ($Scope) {
    'artifacts' {
        $childArgs = @{ Target = $Target }
        if ($Fresh) { $childArgs.Fresh = $true }
        & (Join-Path $here 'build-plugin.ps1') @childArgs

        Sync-ControllerWebBundle -Force:$RestartController
        if ($RestartHosts) {
            docker restart surface-export-host-1 surface-export-host-2 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Host restart failed.' }
        }
        node "$here/../tests/cluster-readiness.mjs" --runtime
        if ($LASTEXITCODE -ne 0) { throw 'Deployment runtime readiness failed.' }
    }
    'lua' {
        if ($KeepSaves) { Assert-PluginArtifactsFresh; & (Join-Path $here 'reload-saves.ps1') }
        else { & (Join-Path $here 'patch-and-reset.ps1') -LuaOnly }
    }
    'plugin' {
        if ($KeepSaves) {
            & (Join-Path $here 'build-plugin.ps1') all
            & (Join-Path $here 'reload-saves.ps1')
        } else { & (Join-Path $here 'patch-and-reset.ps1') }
    }
    'cluster' {
        $childArgs = @{}
        if ($SkipIncrement) { $childArgs.SkipIncrement = $true }
        if ($KeepData) { $childArgs.KeepData = $true }
        & (Join-Path $here 'deploy-cluster.ps1') @childArgs
    }
}

Write-Host "`ndeploy -Scope ${Scope}: complete." -ForegroundColor Green
}
