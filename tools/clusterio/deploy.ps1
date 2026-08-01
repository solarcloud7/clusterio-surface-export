<#
.SYNOPSIS
    THE deploy entry point. One command, one explicit scope.

.DESCRIPTION
    There used to be three commands to choose between — build-plugin.ps1, patch-and-reset.ps1 and
    deploy-cluster.ps1 — and nothing in their names told you which one your change needed. That
    ambiguity is the bug this script fixes: you now pick a SCOPE, and the scope names say what gets
    torn down.

    The scopes form a ladder. Each does everything the one above it does, plus more:

      -Scope artifacts   Build dist/node + dist/web only. Nothing is stopped, no save is touched.
                         Use for TypeScript or web changes; add -RestartHosts to make the running
                         hosts pick up dist/node. The CONTROLLER is reconciled automatically — see
                         -RestartController.

      -Scope lua         FAST Lua redeploy: SKIPS the container build and resets the saves so
                         Clusterio re-patches the Lua from source. Refuses (loudly) if any TS/web
                         source is newer than dist/, because that would ship stale plugin code.

      -Scope plugin      Full plugin redeploy: build artifacts AND reset saves. Use when Lua and
                         TypeScript both changed.

      -Scope cluster     Full cluster rebuild: tear down, wipe volumes (unless -KeepData), rebuild
                         artifacts, pull base images, start fresh. The heaviest option — it destroys
                         cluster state.

    DESTRUCTIVENESS, since that is what you actually need to know before running one:
      artifacts  writes dist/ only
      lua        RESETS SAVES (disconnects players; predeploy-*.zip rescue saves are taken first)
      plugin     RESETS SAVES (same)
      cluster    DESTROYS VOLUMES unless -KeepData

    Implementation lives in one script per scope (build-plugin.ps1, patch-and-reset.ps1,
    deploy-cluster.ps1). They share the build (build-plugin.ps1) and the version bump
    (tools/shared/version-utils.ps1) — one implementation each, several callers. Prefer this entry
    point; the per-scope scripts remain callable for now but are not the documented path.

.PARAMETER Scope
    artifacts | lua | plugin | cluster. Required — there is deliberately no default, because every
    sensible default is someone else's accident.

.PARAMETER Target
    -Scope artifacts only: all (default) | node | web.

.PARAMETER Fresh
    -Scope artifacts only: drop the cached deps volume and run a clean npm ci.

.PARAMETER RestartController
    -Scope artifacts only, and rarely needed: force a controller restart even when it is already
    serving the built web bundle. You do NOT need this for web changes — after every artifacts build
    this script compares what the controller advertises against dist/web/manifest.json and restarts
    it when they differ. That is not a nicety: webpack deletes the old content-hashed chunks, so a
    controller left holding the previous manifest serves 404s and the plugin's UI dies with "Error
    loading module". Pass this only when CONTROLLER-side dist/node changed, which no manifest
    comparison can see. The other scopes restart the controller as part of their own sequence.

.PARAMETER RestartHosts
    -Scope artifacts only: restart both hosts afterwards (needed for TypeScript changes).

.PARAMETER SkipIncrement
    -Scope cluster only: do not bump the plugin version.

.PARAMETER KeepData
    -Scope cluster only: keep Docker volumes instead of wiping them.

.EXAMPLE
    ./tools/clusterio/deploy.ps1 -Scope artifacts -Target node -RestartHosts
.EXAMPLE
    ./tools/clusterio/deploy.ps1 -Scope lua
.EXAMPLE
    ./tools/clusterio/deploy.ps1 -Scope cluster -KeepData
#>
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

# A switch that silently does nothing is the same class of bug as a config key that is silently
# dropped: you believe you asked for something and nothing tells you otherwise. Refuse instead.
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
        $childArgs = @($Target)
        if ($Fresh) { $childArgs += '-Fresh' }
        if ($RestartHosts) { $childArgs += '-RestartHosts' }
        # -RestartController is deliberately NOT forwarded to build-plugin.ps1. The controller
        # restart is decided below by MEASURING whether it still serves the bundle on disk, so an
        # explicit request and a mandatory reconcile collapse into one restart instead of two.
        & (Join-Path $here 'build-plugin.ps1') @childArgs

        # The only scope that could leave the controller serving a deleted chunk. lua/plugin restart
        # it inside patch-and-reset.ps1; cluster gets a fresh one from compose up. Doing this here
        # rather than inside build-plugin.ps1 is deliberate: patch-and-reset.ps1 calls that script
        # mid-sequence and then issues clusterioctl commands, which a surprise controller restart
        # would break.
        Sync-ControllerWebBundle -Force:$RestartController
    }
    'lua' {
        & (Join-Path $here 'patch-and-reset.ps1') -LuaOnly
    }
    'plugin' {
        & (Join-Path $here 'patch-and-reset.ps1')
    }
    'cluster' {
        $childArgs = @()
        if ($SkipIncrement) { $childArgs += '-SkipIncrement' }
        if ($KeepData) { $childArgs += '-KeepData' }
        & (Join-Path $here 'deploy-cluster.ps1') @childArgs
    }
}

# No $LASTEXITCODE check here on purpose: every per-scope script reports failure with `throw` and
# never calls `exit`, and this script runs under $ErrorActionPreference = 'Stop', so a failure has
# already stopped us. After the call $LASTEXITCODE holds whatever the last native command inside
# left behind, so testing it would be a coin flip that can fail a healthy deploy.
Write-Host "`ndeploy -Scope ${Scope}: complete." -ForegroundColor Green
