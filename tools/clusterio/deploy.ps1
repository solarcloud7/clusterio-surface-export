# requires: development cluster, built dependencies and explicit reset authorization for disposable state
# produces: selected deployment, preserving saves and volumes unless reset is requested
# does not: deploy a production Clusterio installation
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
    [switch]$KeepSaves,
    [switch]$ResetSaves,
    [switch]$ResetData
)

$ErrorActionPreference = 'Stop'

$scopeParams = @{
    artifacts = @('Target', 'Fresh', 'RestartController', 'RestartHosts')
    lua       = @('KeepSaves', 'ResetSaves', 'SkipIncrement')
    plugin    = @('KeepSaves', 'ResetSaves', 'SkipIncrement')
    cluster   = @('SkipIncrement', 'KeepData', 'ResetData')
}
$suppliedNames = @($PSBoundParameters.Keys | Where-Object { $_ -ne 'Scope' -and $_ -notin @('Verbose', 'Debug', 'ErrorAction', 'WarningAction', 'InformationAction', 'ErrorVariable', 'WarningVariable', 'InformationVariable', 'OutVariable', 'OutBuffer', 'PipelineVariable') })
$rejected = @($suppliedNames | Where-Object { $_ -notin $scopeParams[$Scope] })
if (($KeepSaves -and $ResetSaves) -or ($KeepData -and $ResetData)) {
    throw 'Choose preservation or reset; Keep and Reset switches cannot be combined.'
}
if ($Scope -in @('lua', 'plugin') -and -not $ResetSaves -and $PSBoundParameters.ContainsKey('SkipIncrement')) {
    throw 'Save-preserving deployment already preserves the version; -SkipIncrement requires -ResetSaves for Lua/plugin scopes.'
}
if ($rejected.Count -gt 0) {
    $allowed = if ($scopeParams[$Scope].Count) { $scopeParams[$Scope] -join ', ' } else { '(none)' }
    throw ("-Scope $Scope does not accept: $($rejected -join ', '). Accepted for this scope: $allowed. " +
        "Refusing rather than ignoring the flag — a silently dropped switch is how you end up believing " +
        "you deployed something you did not.")
}

$here = $PSScriptRoot
. (Join-Path $here '../shared/cluster-utils.ps1')
. (Join-Path $here '../shared/workflow-lock.ps1')
Assert-DevelopmentClusterCheckout

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
        if (-not $ResetSaves) { Assert-PluginArtifactsFresh; & (Join-Path $here 'reload-saves.ps1') }
        else { & (Join-Path $here 'patch-and-reset.ps1') -LuaOnly -SkipIncrement:$SkipIncrement }
    }
    'plugin' {
        if (-not $ResetSaves) {
            & (Join-Path $here 'build-plugin.ps1') all
            & (Join-Path $here 'reload-saves.ps1')
        } else { & (Join-Path $here 'patch-and-reset.ps1') -SkipIncrement:$SkipIncrement }
    }
    'cluster' {
        $childArgs = @{}
        if ($SkipIncrement) { $childArgs.SkipIncrement = $true }
        if ($ResetData) { $childArgs.ResetData = $true }
        & (Join-Path $here 'deploy-cluster.ps1') @childArgs
    }
}

Write-Host "`ndeploy -Scope ${Scope}: complete." -ForegroundColor Green
}
