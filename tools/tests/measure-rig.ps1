#!/usr/bin/env pwsh
# requires: Windows PowerShell 7+ with Get-NetTCPConnection/Get-NetUDPEndpoint, docker (compose v2),
#           node on PATH, and a plugin source whose dist/ is already built
#           (./tools/clusterio/build-plugin.ps1 all)
# produces: a disposable sx-measure-* cluster from the SAME pinned images and seed-data convention as
#           docker-compose.yml, a per-phase timing line, one RCON reply per seeded rig instance, and a
#           teardown that removes the rig's own containers, volumes and network
# does not: touch the live surface-export-* cluster, the atlas-* cluster, or any volume it did not
#           create; does not: verify the live cluster's deploy state — a rig reading measures the
#           MOUNTED plugin source, never deploy-truth; does not: persist anything after down;
#           does not: publish game ports unless -PublishGamePorts; does not: install a game client or
#           run export-data, so the rig web UI has no icons

[CmdletBinding()]
param(
	[Parameter(Mandatory)]
	[ValidateSet("up", "probe", "down", "run", "status")]
	[string]$Action,

	[string]$PluginPath,
	[string]$ImageTag,
	[string]$Command,
	[string]$Instance,
	[int]$ControllerPort = 8070,
	[switch]$PublishGamePorts,
	[switch]$Reuse,
	[switch]$AllowSharedPluginMount,
	[int]$ReadyTimeoutSec = 600
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$RigProject = "sx-measure"
$RigFilter = "sx-measure"
$RigController = "sx-measure-controller"
$RigContainers = @("sx-measure-controller", "sx-measure-host-1", "sx-measure-host-2")
$CtlConfig = "/clusterio/tokens/config-control.json"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$ComposeFile = Join-Path $PSScriptRoot "measure-rig.compose.yml"
$GamePortsFile = Join-Path $PSScriptRoot "measure-rig.gameports.yml"
$SeedData = Join-Path $RepoRoot "docker\seed-data"
$RigHostDirs = @("clusterio-host-1", "clusterio-host-2")
$GameUdpPorts = 34400..34419
$ReadySentinel = "rig-plugin-ready"

$DefaultProbe = "/sc local i = remote.interfaces['surface_export'] " +
	"rcon.print(helpers.table_to_json({tick=game.tick, iface=(i~=nil), " +
	"module_version=(i and i['get_module_version'] and remote.call('surface_export','get_module_version') or 'none')}))"

function Assert-SwitchScope {
	$upOnly = @{ Reuse = $Reuse; PublishGamePorts = $PublishGamePorts; AllowSharedPluginMount = $AllowSharedPluginMount }
	$probeOnly = @{ Command = $Command; Instance = $Instance }

	if ($Action -notin @("up", "run")) {
		foreach ($name in $upOnly.Keys) {
			if ($upOnly[$name]) { throw "-$name belongs to -Action up/run, not -Action $Action. Refusing rather than ignoring it." }
		}
	}
	if ($Action -notin @("probe", "run")) {
		foreach ($name in $probeOnly.Keys) {
			if ($probeOnly[$name]) { throw "-$name belongs to -Action probe/run, not -Action $Action. Refusing rather than ignoring it." }
		}
	}
}

function ConvertTo-ComparablePath {
	param([Parameter(Mandatory)][string]$Path)

	$normalized = $Path -replace '\\', '/'
	$normalized = $normalized -replace '^/run/desktop/mnt/host/', ''
	$normalized = $normalized -replace '^/mnt/', ''
	$normalized = $normalized -replace '^([A-Za-z]):', '$1'
	return $normalized.TrimEnd('/').ToLowerInvariant()
}

function Test-PathOverlap {
	param([Parameter(Mandatory)][string]$Left, [Parameter(Mandatory)][string]$Right)

	if ($Left -eq $Right) { return $true }
	if ($Left.StartsWith("$Right/")) { return $true }
	if ($Right.StartsWith("$Left/")) { return $true }
	return $false
}

function Get-EnvFileValue {
	param([Parameter(Mandatory)][string]$Key)

	foreach ($file in @((Join-Path $RepoRoot ".env"), (Join-Path $RepoRoot ".env.example"))) {
		if (-not (Test-Path $file)) { continue }
		$match = Get-Content $file | Where-Object { $_ -match "^\s*$Key=(.+)$" } | Select-Object -First 1
		if ($match) {
			$match -match "^\s*$Key=(.+)$" | Out-Null
			$value = $Matches[1].Trim()
			if ($value) { return [PSCustomObject]@{ Value = $value; Source = $file } }
		}
	}
	return $null
}

function Resolve-PluginRoot {
	if ($PluginPath) {
		if (-not (Test-Path $PluginPath)) { throw "-PluginPath '$PluginPath' does not exist." }
		return (Resolve-Path $PluginPath).Path
	}
	$default = Join-Path $RepoRoot "docker\seed-data\external_plugins"
	if (-not (Test-Path $default)) { throw "No plugin source at $default — pass -PluginPath explicitly." }
	return (Resolve-Path $default).Path
}

function Initialize-RigEnvironment {
	param([Parameter(Mandatory)][string]$PluginRoot)

	if ($ImageTag) {
		$tag = $ImageTag
		$tagSource = "-ImageTag"
	} else {
		$resolved = Get-EnvFileValue -Key "CLUSTERIO_IMAGE_TAG"
		if (-not $resolved) { throw "CLUSTERIO_IMAGE_TAG is in neither $RepoRoot\.env nor .env.example — pass -ImageTag." }
		$tag = $resolved.Value
		$tagSource = $resolved.Source
	}

	$modPack = Get-EnvFileValue -Key "DEFAULT_MOD_PACK"
	if (-not $modPack) { throw "DEFAULT_MOD_PACK is in neither $RepoRoot\.env nor .env.example." }

	$env:SX_MEASURE_IMAGE_TAG = $tag
	$env:SX_MEASURE_MOD_PACK = $modPack.Value
	$env:SX_MEASURE_SEED_DATA = ($SeedData -replace '\\', '/')
	$env:SX_MEASURE_PLUGINS = ($PluginRoot -replace '\\', '/')
	$env:SX_MEASURE_CONTROLLER_PORT = "$ControllerPort"

	Write-Host "Rig image tag:   $tag (from $tagSource)" -ForegroundColor Gray
	Write-Host "Rig mod pack:    $($modPack.Value)" -ForegroundColor Gray
	Write-Host "Rig seed data:   $env:SX_MEASURE_SEED_DATA" -ForegroundColor Gray
	Write-Host "Rig plugin src:  $env:SX_MEASURE_PLUGINS" -ForegroundColor Gray
}

function Get-ComposeArgs {
	$composeArgs = @("compose", "-p", $RigProject, "-f", $ComposeFile)
	if ($PublishGamePorts) { $composeArgs += @("-f", $GamePortsFile) }
	return $composeArgs
}

function Get-SeededInstanceNames {
	$hostsDir = Join-Path $SeedData "hosts"
	if (-not (Test-Path $hostsDir)) { throw "No seed-data hosts directory at $hostsDir." }

	$hostDirs = @(Get-ChildItem $hostsDir -Directory | Sort-Object Name | Select-Object -ExpandProperty Name)
	if (Compare-Object $hostDirs $RigHostDirs) {
		throw ("The rig declares exactly $($RigHostDirs -join ', ') but seed-data/hosts holds $($hostDirs -join ', '). " +
			"Update measure-rig.compose.yml (services + HOST_COUNT) before the rig can seed this convention.")
	}

	$names = @()
	foreach ($hostDir in $hostDirs) {
		foreach ($instanceDir in (Get-ChildItem (Join-Path $hostsDir $hostDir) -Directory | Sort-Object Name)) {
			$names += $instanceDir.Name
		}
	}
	if (-not $names) { throw "seed-data/hosts names no instance — the rig boot check would gate on nothing." }
	return $names
}

function Get-RigContainerNames {
	$names = docker ps -a --filter "name=$RigFilter" --format "{{.Names}}"
	if ($LASTEXITCODE -ne 0) { throw "docker ps failed (exit $LASTEXITCODE) — cannot tell whether a rig is already up." }
	return @($names | Where-Object { $_ })
}

function Get-RigVolumeNames {
	$names = docker volume ls --filter "name=$RigFilter" --format "{{.Name}}"
	if ($LASTEXITCODE -ne 0) { throw "docker volume ls failed (exit $LASTEXITCODE)." }
	return @($names | Where-Object { $_ })
}

function Get-RigNetworkNames {
	$names = docker network ls --filter "name=$RigFilter" --format "{{.Name}}"
	if ($LASTEXITCODE -ne 0) { throw "docker network ls failed (exit $LASTEXITCODE)." }
	return @($names | Where-Object { $_ })
}

function Assert-PluginBuilt {
	param([Parameter(Mandatory)][string]$PluginRoot)

	$pluginDir = Join-Path $PluginRoot "surface_export"
	if (-not (Test-Path $pluginDir)) { throw "No surface_export plugin under $PluginRoot." }

	$decideScript = Join-Path $pluginDir "scripts\prepare-build.mjs"
	if (-not (Test-Path $decideScript)) { throw "No build oracle at $decideScript." }

	$raw = & node $decideScript --decide
	if ($LASTEXITCODE -ne 0) { throw "prepare-build --decide failed (exit $LASTEXITCODE): $($raw | Out-String)" }
	$verdict = ($raw | Out-String).Trim() | ConvertFrom-Json
	if ($verdict.build) {
		throw ("The mounted plugin source has no usable dist/: $($verdict.why). " +
			"Build it first (./tools/clusterio/build-plugin.ps1 all) — the container install runs " +
			"npm install --omit=dev, which cannot build and only WARNS when it fails.")
	}

	$required = @("dist\node\index.js", "dist\node\instance.js", "dist\node\controller.js",
		"dist\node\control.js", "dist\web\manifest.json")
	$missing = @($required | Where-Object { -not (Test-Path (Join-Path $pluginDir $_)) })
	if ($missing) {
		throw ("The mounted plugin source is missing declared entrypoints: $($missing -join ', '). " +
			"Run ./tools/clusterio/build-plugin.ps1 all.")
	}
	Write-Host "Plugin dist:     built ($($verdict.why))" -ForegroundColor Gray
}

function Assert-PluginMountUnshared {
	param([Parameter(Mandatory)][string]$PluginRoot)

	$target = ConvertTo-ComparablePath -Path $PluginRoot
	$names = docker ps --format "{{.Names}}"
	if ($LASTEXITCODE -ne 0) { throw "docker ps failed (exit $LASTEXITCODE) — cannot tell whether another cluster mounts this plugin source." }
	$others = @($names | Where-Object { $_ -and ($_ -notin $RigContainers) })
	if (-not $others) { return }

	$format = '{{$n := .Name}}{{range .Mounts}}{{if eq .Type "bind"}}{{$n}}|{{.Source}}{{"\n"}}{{end}}{{end}}'
	$rows = docker inspect -f $format @others
	if ($LASTEXITCODE -ne 0) { throw "docker inspect failed (exit $LASTEXITCODE) — cannot tell whether another cluster mounts this plugin source." }

	$clashes = @()
	foreach ($row in $rows) {
		if (-not $row -or $row -notmatch '^\s*/?([^|]+)\|(.+)$') { continue }
		$container = $Matches[1].Trim()
		$source = ConvertTo-ComparablePath -Path $Matches[2].Trim()
		if (Test-PathOverlap -Left $target -Right $source) { $clashes += "$container ($($Matches[2].Trim()))" }
	}
	if (-not $clashes) { return }

	if ($AllowSharedPluginMount) {
		Write-Host "Plugin source is also mounted by: $($clashes -join ', ') — proceeding on -AllowSharedPluginMount." -ForegroundColor Yellow
		return
	}
	throw ("The plugin source $PluginRoot is bind-mounted by a RUNNING container: $($clashes -join ', '). " +
		"The rig's entrypoint runs npm install in it, which mutates that cluster's plugin tree. " +
		"Point -PluginPath at your own checkout, or pass -AllowSharedPluginMount if you own that cluster too.")
}

function Assert-PortsFree {
	$wantTcp = @($ControllerPort)
	$wantUdp = @()
	if ($PublishGamePorts) { $wantUdp = $GameUdpPorts }

	foreach ($cmdlet in @("Get-NetTCPConnection", "Get-NetUDPEndpoint")) {
		try {
			Get-Command $cmdlet | Out-Null
		} catch {
			throw "$cmdlet is unavailable here ($($_.Exception.Message)) — refusing to bind rig ports without checking them first."
		}
	}

	$tcpBusy = @(Get-NetTCPConnection -State Listen | Where-Object { $wantTcp -contains $_.LocalPort } |
		ForEach-Object { "tcp/$($_.LocalPort) (pid $($_.OwningProcess))" } | Sort-Object -Unique)
	$udpBusy = @(Get-NetUDPEndpoint | Where-Object { $wantUdp -contains $_.LocalPort } |
		ForEach-Object { "udp/$($_.LocalPort) (pid $($_.OwningProcess))" } | Sort-Object -Unique)

	$dockerRows = docker ps --format "{{.Names}} {{.Ports}}"
	if ($LASTEXITCODE -ne 0) { throw "docker ps failed (exit $LASTEXITCODE) — cannot check published ports." }
	$dockerBusy = @()
	foreach ($row in $dockerRows) {
		if (-not $row) { continue }
		$container = ($row -split "\s+", 2)[0]
		if ($container -in $RigContainers) { continue }
		foreach ($published in ([regex]::Matches($row, ':(\d+)(?:-(\d+))?->'))) {
			$from = [int]$published.Groups[1].Value
			$to = if ($published.Groups[2].Success) { [int]$published.Groups[2].Value } else { $from }
			foreach ($port in $from..$to) {
				if (($wantTcp -contains $port) -or ($wantUdp -contains $port)) { $dockerBusy += "$port ($container)" }
			}
		}
	}

	$busy = @($tcpBusy + $udpBusy + ($dockerBusy | Sort-Object -Unique))
	if ($busy) {
		throw ("The rig's port block is already bound: $($busy -join ', '). " +
			"Free it, or pass -ControllerPort <n> / drop -PublishGamePorts.")
	}
	$udpLabel = if ($PublishGamePorts) { "udp $($GameUdpPorts[0])-$($GameUdpPorts[-1])" } else { "no game ports published" }
	Write-Host "Rig port block:  tcp $ControllerPort, $udpLabel — free" -ForegroundColor Gray
}

function Get-ContainerHealth {
	param([Parameter(Mandatory)][string]$Name)

	$status = docker inspect -f "{{.State.Health.Status}}" $Name
	if ($LASTEXITCODE -ne 0) { return "absent" }
	return ($status | Out-String).Trim()
}

function Invoke-RigCtl {
	param([Parameter(Mandatory)][string[]]$CtlArgs)

	$out = docker exec $RigController npx clusterioctl --config $CtlConfig --log-level error @CtlArgs 2>&1
	return [PSCustomObject]@{ ExitCode = $LASTEXITCODE; Text = ($out | Out-String).Trim() }
}

function Show-RigDiagnostics {
	Write-Host "--- rig diagnostics ---" -ForegroundColor Yellow
	$list = Invoke-RigCtl -CtlArgs @("instance", "list")
	Write-Host "instance list (exit $($list.ExitCode)):" -ForegroundColor Yellow
	Write-Host $list.Text
	foreach ($container in $RigContainers) {
		$logs = docker logs --tail 40 $container 2>&1
		Write-Host "--- $container (tail 40, exit $LASTEXITCODE) ---" -ForegroundColor Yellow
		Write-Host (($logs | Out-String).Trim())
	}
}

function Wait-RigReady {
	param([Parameter(Mandatory)][string[]]$InstanceNames)

	$deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
	$phaseWatch = [System.Diagnostics.Stopwatch]::StartNew()

	while ((Get-Date) -lt $deadline) {
		$health = Get-ContainerHealth -Name $RigController
		if ($health -eq "healthy") { break }
		if ($health -eq "absent") { throw "$RigController is not running — the rig never came up." }
		Start-Sleep -Seconds 3
	}
	if ((Get-ContainerHealth -Name $RigController) -ne "healthy") {
		Show-RigDiagnostics
		throw "The rig controller never became healthy within ${ReadyTimeoutSec}s."
	}
	Write-Host ("  [+{0:n0}s] controller healthy" -f $phaseWatch.Elapsed.TotalSeconds) -ForegroundColor Green

	while ((Get-Date) -lt $deadline) {
		docker exec $RigController test -f /clusterio/data/.seed-complete
		if ($LASTEXITCODE -eq 0) { break }
		Start-Sleep -Seconds 3
	}
	docker exec $RigController test -f /clusterio/data/.seed-complete
	if ($LASTEXITCODE -ne 0) {
		Show-RigDiagnostics
		throw "Seeding never completed (no /clusterio/data/.seed-complete) within ${ReadyTimeoutSec}s."
	}
	Write-Host ("  [+{0:n0}s] seeding complete" -f $phaseWatch.Elapsed.TotalSeconds) -ForegroundColor Green

	$running = @()
	while ((Get-Date) -lt $deadline) {
		$list = Invoke-RigCtl -CtlArgs @("instance", "list")
		if ($list.ExitCode -eq 0) {
			$running = @()
			foreach ($line in ($list.Text -split "`n")) {
				$cells = $line -split '\|' | ForEach-Object { $_.Trim() }
				if ($cells.Count -ge 5 -and ($cells[0] -in $InstanceNames) -and $cells[4] -eq "running") { $running += $cells[0] }
			}
			if (-not (Compare-Object @($running | Sort-Object -Unique) @($InstanceNames | Sort-Object))) { break }
		}
		Start-Sleep -Seconds 5
	}
	if (Compare-Object @($running | Sort-Object -Unique) @($InstanceNames | Sort-Object)) {
		Show-RigDiagnostics
		throw "Not every seeded instance reached running within ${ReadyTimeoutSec}s (running: $($running -join ', '))."
	}
	Write-Host ("  [+{0:n0}s] instances running: $($InstanceNames -join ', ')" -f $phaseWatch.Elapsed.TotalSeconds) -ForegroundColor Green

	$readyProbe = "/sc rcon.print(remote.interfaces['surface_export'] and '$ReadySentinel' or 'rig-plugin-missing')"
	$pending = @($InstanceNames)
	$lastReply = @{}
	while ((Get-Date) -lt $deadline -and $pending.Count -gt 0) {
		$stillPending = @()
		foreach ($name in $pending) {
			$reply = Invoke-RigCtl -CtlArgs @("instance", "send-rcon", $name, $readyProbe)
			$lastReply[$name] = "exit $($reply.ExitCode): $($reply.Text)"
			if ($reply.ExitCode -eq 0 -and $reply.Text -match "(?m)^\s*$ReadySentinel\s*$") { continue }
			$stillPending += $name
		}
		$pending = $stillPending
		if ($pending.Count -gt 0) { Start-Sleep -Seconds 5 }
	}
	if ($pending.Count -gt 0) {
		foreach ($name in $pending) { Write-Host "  $name last reply: $($lastReply[$name])" -ForegroundColor Red }
		Show-RigDiagnostics
		throw "The surface_export module never loaded on: $($pending -join ', ') (within ${ReadyTimeoutSec}s)."
	}
	Write-Host ("  [+{0:n0}s] boot check green — every seeded instance answers RCON with the plugin loaded" -f $phaseWatch.Elapsed.TotalSeconds) -ForegroundColor Green
}

function Invoke-RigUp {
	$pluginRoot = Resolve-PluginRoot
	$instanceNames = Get-SeededInstanceNames

	$existing = Get-RigContainerNames
	if ($existing -and -not $Reuse) {
		throw ("A rig is already present ($($existing -join ', ')). A rig left up is a defect: " +
			"run -Action down to destroy it, or -Action up -Reuse to deliberately attach to it.")
	}

	Assert-PluginBuilt -PluginRoot $pluginRoot
	Assert-PluginMountUnshared -PluginRoot $pluginRoot
	if (-not $existing) { Assert-PortsFree }
	Initialize-RigEnvironment -PluginRoot $pluginRoot

	$composeArgs = Get-ComposeArgs
	$watch = [System.Diagnostics.Stopwatch]::StartNew()

	Write-Host "Pulling rig images..." -ForegroundColor Cyan
	docker @composeArgs pull
	if ($LASTEXITCODE -ne 0) { throw "docker compose pull failed (exit $LASTEXITCODE)." }
	Write-Host ("  pull: {0:n0}s" -f $watch.Elapsed.TotalSeconds) -ForegroundColor Gray

	$upStart = $watch.Elapsed.TotalSeconds
	Write-Host "Starting the rig..." -ForegroundColor Cyan
	docker @composeArgs up -d
	if ($LASTEXITCODE -ne 0) { throw "docker compose up -d failed (exit $LASTEXITCODE)." }

	Wait-RigReady -InstanceNames $instanceNames
	Write-Host ("Rig ready in {0:n0}s (bring-up {1:n0}s, pull {2:n0}s)." -f
		$watch.Elapsed.TotalSeconds, ($watch.Elapsed.TotalSeconds - $upStart), $upStart) -ForegroundColor Green
	Write-Host "Rig web UI: http://localhost:$ControllerPort (admin sx-measure-admin; no icons — export-data is off)" -ForegroundColor Gray
}

function Invoke-RigProbe {
	$instanceNames = Get-SeededInstanceNames
	$targets = $instanceNames
	if ($Instance) {
		if ($Instance -match '^\d+$') {
			$targets = @($instanceNames | Where-Object { $_ -match "host-$Instance\b" })
		} else {
			$targets = @($instanceNames | Where-Object { $_ -eq $Instance })
		}
		if (-not $targets) { throw "-Instance '$Instance' matches none of: $($instanceNames -join ', ')." }
	}

	$probeCommand = if ($Command) { $Command } else { $DefaultProbe }
	Write-Host "Probe: $probeCommand" -ForegroundColor Cyan
	foreach ($name in $targets) {
		$reply = Invoke-RigCtl -CtlArgs @("instance", "send-rcon", $name, $probeCommand)
		if ($reply.ExitCode -ne 0) { throw "Probe failed on $name (exit $($reply.ExitCode)): $($reply.Text)" }
		Write-Host "  $name -> $($reply.Text)" -ForegroundColor White
	}
}

function Invoke-RigDown {
	$pluginRoot = Resolve-PluginRoot
	Initialize-RigEnvironment -PluginRoot $pluginRoot
	$composeArgs = Get-ComposeArgs

	Write-Host "Destroying the rig (containers, volumes, network)..." -ForegroundColor Cyan
	docker @composeArgs down -v --remove-orphans
	if ($LASTEXITCODE -ne 0) { throw "docker compose down -v failed (exit $LASTEXITCODE) — the rig's volumes were NOT destroyed." }

	$leftovers = @()
	foreach ($name in (Get-RigContainerNames)) { $leftovers += "container $name" }
	foreach ($name in (Get-RigVolumeNames)) { $leftovers += "volume $name" }
	foreach ($name in (Get-RigNetworkNames)) { $leftovers += "network $name" }
	if ($leftovers) { throw "Rig teardown left: $($leftovers -join ', ') — remove them before the next run." }
	Write-Host "Rig destroyed: zero sx-measure containers, volumes and networks remain." -ForegroundColor Green
}

function Show-RigStatus {
	$containers = Get-RigContainerNames
	$volumes = Get-RigVolumeNames
	$networks = Get-RigNetworkNames
	Write-Host "Rig containers: $(if ($containers) { $containers -join ', ' } else { 'none' })"
	Write-Host "Rig volumes:    $(if ($volumes) { $volumes -join ', ' } else { 'none' })"
	Write-Host "Rig networks:   $(if ($networks) { $networks -join ', ' } else { 'none' })"
	if ($containers -or $volumes -or $networks) {
		Write-Host "A rig left up is a defect — destroy it with -Action down." -ForegroundColor Yellow
	}
}

Assert-SwitchScope

switch ($Action) {
	"up" { Invoke-RigUp }
	"probe" { Invoke-RigProbe }
	"down" { Invoke-RigDown }
	"status" { Show-RigStatus }
	"run" {
		$failure = $null
		try {
			Invoke-RigUp
			Invoke-RigProbe
		} catch {
			$failure = $_
		}
		try {
			Invoke-RigDown
		} catch {
			if ($failure) { Write-Host "Teardown ALSO failed: $($_.Exception.Message)" -ForegroundColor Red }
			else { $failure = $_ }
		}
		if ($failure) { throw $failure }
	}
}
