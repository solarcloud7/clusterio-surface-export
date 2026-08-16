$script:DefaultController = "surface-export-controller"
$script:ControlConfig = "/clusterio/tokens/config-control.json"

$script:TransferFixturePlatform = 'lab-transfer-fixture-v1'
$script:PadGridPlatform         = 'lab-omnibus-state-v1'
$script:OneOfEachStagingPlatform = 'oneofeach-staging-v1'

function Get-TransferFixturePlatform { return $script:TransferFixturePlatform }
function Get-PadGridPlatform { return $script:PadGridPlatform }

$script:ProtectedFixtures = @(
	$script:TransferFixturePlatform, $script:PadGridPlatform, $script:OneOfEachStagingPlatform,
	'test', 'spikedoom08', 'ptB'
)

function Get-ProtectedFixtures {
    return @($script:ProtectedFixtures)
}

function ConvertTo-LuaLiteral {
    param([Parameter(Mandatory=$true)][AllowEmptyString()][string]$Value)
    return $Value.Replace('\', '\\').Replace("'", "\'")
}


function Send-Rcon {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$Command,
        [string]$Controller = $script:DefaultController
    )
    
    $output = docker exec $Controller npx clusterioctl --log-level error instance send-rcon $Instance $Command --config $script:ControlConfig 2>&1
    return $output
}

function Invoke-Lua {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$Code,
        [switch]$ReturnJson
    )
    
    $command = "/sc $Code"
    $output = Send-Rcon -Instance $Instance -Command $command
    $result = ($output | Select-Object -Last 1)
    
    if ($ReturnJson) {
        try {
            return $result | ConvertFrom-Json
        } catch {
            Write-Warning "Failed to parse JSON result: $result"
            return $null
        }
    }
    
    return $result
}



$script:ExpectedFactorioVersion = "2.1.11"

function Assert-FactorioVersion {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [string]$Expected = $script:ExpectedFactorioVersion
    )

    $lua = "rcon.print(tostring((script and script.active_mods and script.active_mods.base) or (game.active_mods and game.active_mods.base) or 'unknown'))"
    $detected = (Invoke-Lua -Instance $Instance -Code $lua | Out-String).Trim()

    if (-not $detected -or $detected -eq "unknown") {
        throw "Version audit: could not read Factorio version from '$Instance' (RCON empty/unresponsive?)"
    }
    if ($detected -ne $Expected) {
        throw "Version audit FAILED on '$Instance': running Factorio $detected but tests are written for $Expected. " +
              "Bump `$script:ExpectedFactorioVersion + version-compat.lua PROFILES and re-verify against lua-api.factorio.com/$detected/."
    }
    Write-Status "Factorio version audited: $detected (matches expected)" -Type success
    return $detected
}



function New-TestPlatform {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$SourcePlatform,
        [string]$DestPlatform = ""
    )
    
    if (-not $DestPlatform) {
        $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $DestPlatform = "test-$timestamp"
    }
    
    $srcIndex = Get-PlatformIndex -Instance $Instance -PlatformName $SourcePlatform
    if ($null -eq $srcIndex) {
        return @{ success = $false; error = "Source platform '$SourcePlatform' not found" }
    }
    $destLua = ConvertTo-LuaLiteral $DestPlatform
    $luaCode = "local result = remote.call('surface_export', 'clone_platform', $srcIndex, '$destLua') rcon.print(helpers.table_to_json(result))"
    $result = Invoke-Lua -Instance $Instance -Code $luaCode -ReturnJson
    
    if (-not $result) {
        return @{ success = $false; error = "Failed to parse clone result" }
    }
    
    return $result
}

function Get-PlatformIndex {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$PlatformName
    )
    
    $nameLua = ConvertTo-LuaLiteral $PlatformName
    $luaCode = "local idx, count = nil, 0 for i, p in pairs(game.forces.player.platforms) do if p.name == '$nameLua' then idx = i; count = count + 1 end end if count == 0 then rcon.print('NOT_FOUND') elseif count > 1 then rcon.print('AMBIGUOUS ' .. count) else rcon.print(idx) end"
    $result = Invoke-Lua -Instance $Instance -Code $luaCode

    if ($result -eq "NOT_FOUND") {
        return $null
    }
    if ($result -match '^AMBIGUOUS\s+(\d+)') {
        throw "Get-PlatformIndex: $($Matches[1]) platforms are named '$PlatformName' — names are not unique; reference the platform by a unique name or its index."
    }

    return [int]$result
}

function Resolve-PlatformHost {
    param(
        [Parameter(Mandatory=$true)]
        [string]$PlatformName,
        [int[]]$Hosts = @(1, 2)
    )

    foreach ($h in $Hosts) {
        $instance = "clusterio-host-$h-instance-1"
        $idx = Get-PlatformIndex -Instance $instance -PlatformName $PlatformName
        if ($idx) { return $h }
    }
    return $null
}

function Get-Platforms {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance
    )
    
    $output = Send-Rcon -Instance $Instance -Command "/list-platforms"
    return $output
}

function Get-PlatformInventory {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance
    )

    $lua = @"
local out = {}
for _, force in pairs(game.forces) do
    for _, p in pairs(force.platforms or {}) do
        if p and p.valid then
            local s = p.surface
            local live = (s ~= nil and s.valid)
            out[#out+1] = {
                name = p.name,
                force = force.name,
                hasSurface = live,
                hasHub = (p.hub ~= nil and p.hub.valid) or false,
                entities = live and #s.find_entities_filtered{} or 0,
            }
        end
    end
end
rcon.print(helpers.table_to_json({platforms = out}))
"@
    $result = Invoke-Lua -Instance $Instance -Code $lua
    try {
        $parsed = $result | ConvertFrom-Json
        return @($parsed.platforms) | Where-Object { $_.name }
    } catch {
        Write-Warning "Failed to parse platform inventory: $result"
        return @()
    }
}

function Remove-PlatformSurfacesWhere {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$PredicateLua,
        [switch]$WhatIf
    )

    $protectedLua = ($script:ProtectedFixtures | ForEach-Object { "['" + $_ + "']=true" }) -join ", "
    $deleteStmt = if ($WhatIf) { "" } else { "if s.valid then game.delete_surface(s); deleted = deleted + 1 end" }
    $lua = @"
local protected = {$protectedLua}
local deleted = 0
local names = {}
for _, s in pairs(game.surfaces) do
    local p = s.platform
    if p and p.valid and not protected[p.name] and ($PredicateLua) then
        table.insert(names, p.name)
        $deleteStmt
    end
end
rcon.print(helpers.table_to_json({deleted = deleted, names = names}))
"@
    $result = Invoke-Lua -Instance $Instance -Code $lua
    try {
        $parsed = $result | ConvertFrom-Json
        $names = @($parsed.names) | Where-Object { $_ -is [string] -and $_.Length -gt 0 }
        return @{ deleted = [int]$parsed.deleted; names = @($names) }
    } catch {
        Write-Warning "Failed to parse delete result: $result"
        return @{ deleted = 0; names = @() }
    }
}

function Remove-TestSurfaces {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$TestName
    )
    
    $luaPat = $TestName -replace "'", ""
    $res = Remove-PlatformSurfacesWhere -Instance $Instance -PredicateLua "string.find(p.name, '$luaPat', 1, true)"
    return @{ deleted = $res.deleted; failed = 0; names = $res.names }
}



function Step-Tick {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [int]$Ticks = 60,
        [switch]$EnsurePaused
    )
    
    if ($EnsurePaused) {
        Invoke-Lua -Instance $Instance -Code "game.tick_paused = true" | Out-Null
    }
    
    $output = Send-Rcon -Instance $Instance -Command "/step-tick $Ticks"
    return $output
}

function Set-GamePaused {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [bool]$Pause = $true
    )
    
    $value = if ($Pause) { "true" } else { "false" }
    Invoke-Lua -Instance $Instance -Code "game.tick_paused = $value" | Out-Null
}



function Clear-DebugFiles {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$Container,
        [string]$Pattern = "debug_*.json"
    )
    
    docker exec $Container bash -c "rm -f /clusterio/data/instances/$Instance/script-output/$Pattern" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Clear-DebugFiles: docker exec failed (exit $LASTEXITCODE) — stale '$Pattern' files may survive on $Container and could satisfy a later poll."
    }
}

function Get-DebugFiles {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$Container,
        [string]$Pattern = "debug_*.json"
    )
    
    $files = docker exec $Container bash -c "ls -1 /clusterio/data/instances/$Instance/script-output/$Pattern 2>/dev/null" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $files -or $files -eq "") {
        return @()
    }
    
    $result = @($files -split "`n" | Where-Object { $_ -and $_ -ne "" })
    return $result
}

function Read-DebugFile {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$Container,
        [Parameter(Mandatory=$true)]
        [string]$Filename
    )
    
    if (-not $Filename.StartsWith("/")) {
        $Filename = "/clusterio/data/instances/$Instance/script-output/$Filename"
    }
    
    $content = docker exec $Container cat $Filename 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $content) {
        return $null
    }
    
    try {
        return $content | ConvertFrom-Json
    } catch {
        Write-Warning "Failed to parse JSON from $Filename"
        return $null
    }
}



function Get-TestCases {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Path
    )
    
    if (-not (Test-Path $Path)) {
        throw "Test cases file not found: $Path"
    }
    
    return Get-Content $Path -Raw | ConvertFrom-Json
}

function Select-Tests {
    param(
        [Parameter(Mandatory=$true)]
        $TestSuite,
        [string]$TestId = "",
        [string]$Category = ""
    )
    
    $filtered = @()
    foreach ($test in $TestSuite.tests) {
        if ($TestId -and $test.id -ne $TestId) { continue }
        if ($Category -and $test.category -ne $Category) { continue }
        $filtered += $test
    }
    
    return $filtered
}

function Get-SafeProperty {
    param(
        [Parameter(Mandatory=$false)]
        [AllowNull()]
        $Object,
        [Parameter(Mandatory=$true)]
        [string]$PropertyName
    )
    
    if ($null -eq $Object) { return $null }
    
    $prop = $Object.PSObject.Properties[$PropertyName]
    if ($prop) {
        return $prop.Value
    }
    return $null
}
function Assert-TransferSucceeded {
    param(
        [Parameter(Mandatory=$false)]
        [AllowNull()]
        $Result,
        [string]$Context = "Transfer"
    )

    if ($null -eq $Result) {
        throw "$Context failed before destination census: debug result was missing or unreadable"
    }

    $success = Get-SafeProperty $Result "validation_success"
    if ($success -is [bool] -and $success) { return }

    $validation = Get-SafeProperty $Result "validation_result"
    $failedStage = Get-SafeProperty $validation "failedStage"
    if (-not $failedStage) { $failedStage = "not reported" }

    $errorText = Get-SafeProperty $Result "error"
    if (-not $errorText) { $errorText = Get-SafeProperty $validation "error" }
    if (-not $errorText) {
        $details = Get-SafeProperty $validation "mismatchDetails"
        if ($details -is [System.Array]) { $errorText = $details -join "; " }
        elseif ($null -ne $details) { $errorText = [string]$details }
    }
    if (-not $errorText) { $errorText = "not reported" }

    $blackBox = Get-SafeProperty $validation "failureBlackBox"
    $blackBoxPath = Get-SafeProperty $blackBox "file"
    if (-not $blackBoxPath) { $blackBoxPath = "not reported" }

    throw "$Context failed before destination census: validation_success=$success; failedStage=$failedStage; error=$errorText; blackBox=$blackBoxPath"
}



function Write-TestHeader {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Title
    )
    
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host ""
}

function Write-TestResult {
    param(
        [Parameter(Mandatory=$true)]
        [string]$TestId,
        [Parameter(Mandatory=$true)]
        [string]$TestName,
        [Parameter(Mandatory=$true)]
        [ValidateSet("passed", "failed", "skipped", "error")]
        [string]$Status,
        [string]$Message = ""
    )
    
    $icon = switch ($Status) {
        "passed"  { "✅" }
        "failed"  { "❌" }
        "skipped" { "⏭️ " }
        "error"   { "💥" }
    }
    
    $color = switch ($Status) {
        "passed"  { "Green" }
        "failed"  { "Red" }
        "skipped" { "Yellow" }
        "error"   { "Magenta" }
    }
    
    Write-Host "  $icon $TestId`: $TestName" -ForegroundColor $color
    
    if ($Message -and ($Status -eq "failed" -or $Status -eq "error")) {
        $parts = $Message -split ';'
        foreach ($part in $parts) {
            $trimmed = $part.Trim()
            if ($trimmed) {
                Write-Host "      $trimmed" -ForegroundColor DarkRed
            }
        }
    }
}

function Write-TestSummary {
    param(
        [int]$Passed = 0,
        [int]$Failed = 0,
        [int]$Skipped = 0
    )
    
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "  Summary" -ForegroundColor Cyan
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host ""
    
    $totalRun = $Passed + $Failed
    $passRate = if ($totalRun -gt 0) { [math]::Round(($Passed / $totalRun) * 100, 1) } else { 0 }
    
    Write-Host "  ✅ Passed:  $Passed" -ForegroundColor Green
    Write-Host "  ❌ Failed:  $Failed" -ForegroundColor $(if ($Failed -gt 0) { "Red" } else { "Gray" })
    if ($Skipped -gt 0) {
        Write-Host "  ⏭️  Skipped: $Skipped" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "  Pass Rate: $passRate% ($Passed/$totalRun)" -ForegroundColor $(if ($passRate -eq 100) { "Green" } elseif ($passRate -ge 80) { "Yellow" } else { "Red" })
    Write-Host ""
}

function Write-Status {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,
        [ValidateSet("info", "success", "warning", "error")]
        [string]$Type = "info"
    )
    
    $icon = switch ($Type) {
        "info"    { "  " }
        "success" { "✓" }
        "warning" { "⚠️" }
        "error"   { "❌" }
    }
    
    $color = switch ($Type) {
        "info"    { "Gray" }
        "success" { "Green" }
        "warning" { "Yellow" }
        "error"   { "Red" }
    }
    
    Write-Host "  $icon $Message" -ForegroundColor $color
}



function Wait-ForJob {
    param(
        [Parameter(Mandatory=$true)]
        [string[]]$Instances,
        [int]$MaxWaitSeconds = 30,
        [string]$CheckScript = ""
    )
    
    $startTime = Get-Date
    $done = $false
    
    while (-not $done -and ((Get-Date) - $startTime).TotalSeconds -lt $MaxWaitSeconds) {
        Start-Sleep -Seconds 1
        
        if ($CheckScript) {
            $result = Invoke-Lua -Instance $Instances[0] -Code $CheckScript
            if ($result -eq "true") {
                $done = $true
            }
        } else {
            $done = $true
        }
    }
    
    return $done
}

function Start-PlatformTransfer {
    param(
        [Parameter(Mandatory=$true)]
        [string]$SourceInstance,
        [Parameter(Mandatory=$true)]
        [int]$DestInstanceId,
        [Parameter(Mandatory=$true)]
        [int]$PlatformIndex,
        [ValidateSet("rcon", "controller")]
        [string]$TransferMode = "rcon"
    )

    if ($TransferMode -eq "controller") {
        $sourceInstanceId = Get-ClusterioInstanceId -InstanceName $SourceInstance
        if (-not $sourceInstanceId) {
            throw "Could not resolve source instance ID for '$SourceInstance'"
        }
        $output = docker exec $script:DefaultController npx clusterioctl --config $script:ControlConfig surface-export start-transfer $sourceInstanceId $PlatformIndex $DestInstanceId player 2>&1
        return $output
    }

    $command = "/transfer-platform $PlatformIndex $DestInstanceId"
    $output = Send-Rcon -Instance $SourceInstance -Command $command
    return $output
}

function Get-ClusterioInstanceId {
    param(
        [Parameter(Mandatory=$true)]
        [string]$InstanceName,
        [string]$Controller = $script:DefaultController
    )
    
    $output = docker exec $Controller bash -c "npx clusterioctl --config $script:ControlConfig instance list 2>/dev/null"
    foreach ($line in $output) {
        if ($line -match "^\s*$([regex]::Escape($InstanceName))\s*\|\s*(\d+)") {
            return [long]$Matches[1]
        }
    }
    
    Write-Warning "Could not resolve instance ID for '$InstanceName'"
    return $null
}


Export-ModuleMember -Function @(
    'Send-Rcon',
    'Invoke-Lua',

    'Assert-FactorioVersion',

    'New-TestPlatform',
    'Get-PlatformIndex',
    'Resolve-PlatformHost',
    'Get-Platforms',
    'Remove-PlatformSurfacesWhere',
    'Get-PlatformInventory',
    'Get-ProtectedFixtures',
    'Remove-TestSurfaces',
    
    'Step-Tick',
    'Set-GamePaused',
    
    'Clear-DebugFiles',
    'Get-DebugFiles',
    'Read-DebugFile',
    
    'Get-TestCases',
    'Select-Tests',
    'Get-SafeProperty',
    'Assert-TransferSucceeded',
    
    'Write-TestHeader',
    'Write-TestResult',
    'Write-TestSummary',
    'Write-Status',
    
    'Wait-ForJob',
    'Start-PlatformTransfer',
    
    'Get-ClusterioInstanceId',

    'Get-TransferFixturePlatform',
    'Get-PadGridPlatform'
)
