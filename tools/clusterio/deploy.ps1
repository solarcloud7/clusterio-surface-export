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
    [switch]$KeepData
)

$ErrorActionPreference = 'Stop'

$scopeParams = @{
    artifacts = @('Target', 'Fresh', 'RestartController', 'RestartHosts')
    lua       = @()
    plugin    = @()
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

switch ($Scope) {
    'artifacts' {
        $childArgs = @{ Target = $Target }
        if ($Fresh) { $childArgs.Fresh = $true }
        if ($RestartHosts) { $childArgs.RestartHosts = $true }
        & (Join-Path $here 'build-plugin.ps1') @childArgs

        Sync-ControllerWebBundle -Force:$RestartController
    }
    'lua' {
        & (Join-Path $here 'patch-and-reset.ps1') -LuaOnly
    }
    'plugin' {
        & (Join-Path $here 'patch-and-reset.ps1')
    }
    'cluster' {
        $childArgs = @{}
        if ($SkipIncrement) { $childArgs.SkipIncrement = $true }
        if ($KeepData) { $childArgs.KeepData = $true }
        & (Join-Path $here 'deploy-cluster.ps1') @childArgs
    }
}

Write-Host "`ndeploy -Scope ${Scope}: complete." -ForegroundColor Green
