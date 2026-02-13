# Check Clusterio Logs
Write-Host "=== Controller Logs (last 50 lines) ===" -ForegroundColor Cyan
docker logs surface-export-controller --tail 50

Write-Host "`n=== Host 1 Logs (last 30 lines) ===" -ForegroundColor Yellow
docker logs surface-export-host-1 --tail 30

Write-Host "`n=== Host 2 Logs (last 30 lines) ===" -ForegroundColor Yellow
docker logs surface-export-host-2 --tail 30

Write-Host "`n=== Instance 1 Factorio Log (last 30 lines) ===" -ForegroundColor Green
docker exec surface-export-host-1 tail -30 /clusterio/data/instances/clusterio-host-1-instance-1/factorio-current.log 2>$null

Write-Host "`n=== Instance 2 Factorio Log (last 30 lines) ===" -ForegroundColor Green
docker exec surface-export-host-2 tail -30 /clusterio/data/instances/clusterio-host-2-instance-1/factorio-current.log 2>$null

Write-Host "`n=== Instance Status ===" -ForegroundColor Cyan
docker exec surface-export-controller npx clusterioctl --config=/clusterio/tokens/config-control.json instance list 2>&1 | Select-Object -Skip 1
