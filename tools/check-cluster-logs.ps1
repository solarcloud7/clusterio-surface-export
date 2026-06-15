<#
.SYNOPSIS
    Dump the cluster's logs from the places they ACTUALLY live.

    KEY GOTCHA this script exists to defeat: a plugin's `this.logger.info/error(...)`
    output (controller AND instance/host plugins) does NOT reliably appear in
    `docker logs`. It lands in JSON log FILES on disk:
      - Controller: /clusterio/logs/cluster/cluster-YYYY-MM-DD.log  (aggregated: everything)
      - Host:       /clusterio/logs/host/host-YYYY-MM-DD.log         (that host's plugins)
      - Factorio:   /clusterio/data/instances/<instance>/factorio-current.log (engine + Lua log())
    `docker logs surface-export-host-1 | grep surface_export` returns NOTHING — look in the files.
.PARAMETER Grep
    Case-insensitive filter applied to the plugin JSON logs (default: error|transfer|import|export).
.PARAMETER Lines
    How many tail lines of docker/factorio logs to show (default 30).
.EXAMPLE
    ./tools/check-cluster-logs.ps1
.EXAMPLE
    ./tools/check-cluster-logs.ps1 -Grep "sendRequest|handleRequest|undefined"
#>
param(
    [string]$Grep = "error|transfer|import|export|validation",
    [int]$Lines = 30
)

Write-Host "=== Plugin logs (cluster aggregated JSON — the BEST place to trace a transfer) ===" -ForegroundColor Magenta
Write-Host "  /clusterio/logs/cluster/cluster-*.log  filtered by: $Grep" -ForegroundColor DarkGray
# Glob all cluster-*.log (date-rotated; container clock is UTC so don't compute the date host-side).
docker exec surface-export-controller sh -c "cat /clusterio/logs/cluster/cluster-*.log 2>/dev/null | grep -aoE '\""message\"":\""[^\""]*\""' | grep -iE '$Grep'" 2>$null | Select-Object -Last 40

Write-Host "`n=== Controller docker stdout (controller-origin plugin logs only) ===" -ForegroundColor Cyan
docker logs surface-export-controller --tail 50 2>&1 | Select-String -Pattern "surface_export" | Select-Object -Last 20

foreach ($h in 1, 2) {
    Write-Host "`n=== Host $h plugin logs (host JSON file — instance this.logger lands here) ===" -ForegroundColor Yellow
    docker exec "surface-export-host-$h" sh -c "cat /clusterio/logs/host/host-*.log 2>/dev/null | grep -aoE '\""message\"":\""[^\""]*\""' | grep -iE '$Grep'" 2>$null | Select-Object -Last 15

    Write-Host "`n=== Host $h Factorio log (engine + Lua [Script]) ===" -ForegroundColor Green
    docker exec "surface-export-host-$h" sh -c "tail -$Lines /clusterio/data/instances/clusterio-host-$h-instance-1/factorio-current.log 2>/dev/null" 2>$null
}

Write-Host "`n=== Instance Status ===" -ForegroundColor Cyan
docker exec surface-export-controller sh -c "npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error instance list" 2>$null
