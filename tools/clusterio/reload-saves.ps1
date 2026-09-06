# Internal implementation for deploy.ps1 -KeepSaves. Never deletes or replaces saves.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../shared/cluster-utils.ps1"
. "$PSScriptRoot/../shared/workflow-lock.ps1"

Invoke-WorkflowLock {

function Invoke-Control {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Arguments)
    $result = docker exec surface-export-controller npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        $verb = ($Arguments | Select-Object -First 2) -join ' '
        throw "Clusterio command '$verb' failed (exit $LASTEXITCODE). Inspect sanitized cluster logs."
    }
    return ($result | Out-String).Trim()
}

$instances = @(Get-InstanceList)
if ($instances.Count -ne 2 -or @($instances | Where-Object { $_.Status -ne 'running' }).Count) {
    throw 'Save-preserving reload requires both existing instances running. Refusing to guess which world to load.'
}
foreach ($instance in $instances) {
    $config = Invoke-Control instance config list $instance.Name
    if ($config -notmatch '(?m)^factorio.enable_save_patching\s+true\s*$' -or $config -notmatch '(?m)^instance.auto_start\s+true\s*$') {
        throw "$($instance.Name): save patching and auto-start must be enabled for a preserving host reload. Nothing has been stopped."
    }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$evidence = Join-Path $PSScriptRoot "../../ci-artifacts/predeploy-$stamp.json"
node "$PSScriptRoot/../tests/cluster-readiness.mjs" --runtime --capture-world --snapshot $evidence
if ($LASTEXITCODE -ne 0) { throw 'Cannot capture existing world before reload.' }

foreach ($instance in $instances) {
    Invoke-Control instance send-rcon $instance.Name "/sc game.server_save('predeploy-$stamp')" | Out-Null
}
foreach ($instance in $instances) {
    $container = "surface-export-host-$($instance.Host)"
    $save = "/clusterio/data/instances/$($instance.Name)/saves/predeploy-$stamp.zip"
    $deadline = (Get-Date).AddSeconds(120)
    $last = ''; $stable = 0
    do {
        $size = (docker exec $container stat -c %s $save 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $size -match '^\d+$' -and [long]$size -gt 0) {
            if ($size -eq $last) { $stable++ } else { $stable = 0 }
            $last = $size
        }
        if ($stable -ge 2) { break }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    if ($stable -lt 2) { throw "Backup not confirmed for $($instance.Name). Refusing to stop either instance." }
    Write-Host "Backup confirmed: ${container}:$save"
}
foreach ($instance in $instances) { Invoke-Control instance stop $instance.Name | Out-Null }
Sync-ControllerWebBundle -Force
docker restart surface-export-host-1 surface-export-host-2 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Host restart failed; backups and existing saves are retained.' }
node "$PSScriptRoot/../tests/cluster-readiness.mjs" --runtime --compare $evidence
if ($LASTEXITCODE -ne 0) { throw "Preserving reload did not pass verification. Before-state: $evidence. Existing saves and backups are retained." }
Write-Host 'Verified Lua version, surface/platform census and player positions after preserving reload.'
}
