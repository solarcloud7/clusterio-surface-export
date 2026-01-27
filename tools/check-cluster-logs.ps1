# Check Clusterio Logs
Write-Host "=== Controller Logs (last 50 lines) ===" -ForegroundColor Cyan
docker logs clusterio-controller --tail 50

Write-Host "`n=== Host 1 Logs (last 30 lines) ===" -ForegroundColor Yellow
docker logs clusterio-host-1 --tail 30

Write-Host "`n=== Host 2 Logs (last 30 lines) ===" -ForegroundColor Yellow
docker logs clusterio-host-2 --tail 30

Write-Host "`n=== Instance 1 Factorio Log (last 30 lines) ===" -ForegroundColor Green
Get-Content ".\docker\clusterio-containers\hosts\clusterio-host-1\instances\clusterio-host-1-instance-1\factorio-current.log" -Tail 30 -ErrorAction SilentlyContinue

Write-Host "`n=== Instance 2 Factorio Log (last 30 lines) ===" -ForegroundColor Green
Get-Content ".\docker\clusterio-containers\hosts\clusterio-host-2\instances\clusterio-host-2-instance-1\factorio-current.log" -Tail 30 -ErrorAction SilentlyContinue

Write-Host "`n=== Instance Status ===" -ForegroundColor Cyan
docker exec clusterio-controller npx clusterioctl instance list 2>&1 | Select-Object -Skip 1
