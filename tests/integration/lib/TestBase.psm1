<#
.SYNOPSIS
    Shared integration test infrastructure for clusterio-surface-export.

.DESCRIPTION
    This module provides common functions for:
    - RCON communication with Clusterio instances
    - Platform cloning for isolated test surfaces
    - Debug file retrieval and parsing
    - Tick stepping for paused games
    - Test result reporting

    Each test uses its own cloned platform surface to avoid interference.
#>

# Module-level variables
$script:DefaultController = "surface-export-controller"
$script:ControlConfig = "/clusterio/tokens/config-control.json"

#region RCON Communication

<#
.SYNOPSIS
    Send an RCON command to a Clusterio instance.

.PARAMETER Instance
    Instance name (e.g., "clusterio-host-1-instance-1") or numeric ID (e.g., 1)

.PARAMETER Command
    The RCON command to execute

.PARAMETER Controller
    Docker container name of the controller (default: clusterio-controller)

.EXAMPLE
    Send-Rcon -Instance 1 -Command "/list-platforms"
#>
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

<#
.SYNOPSIS
    Execute Lua code on an instance via /sc command.

.PARAMETER Instance
    Instance name or ID

.PARAMETER Code
    Lua code to execute (will be wrapped with /sc)

.PARAMETER ReturnJson
    If specified, expects JSON result and parses it
#>
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

#endregion

#region Platform Management

<#
.SYNOPSIS
    Clone a platform to create an isolated test surface.

.PARAMETER Instance
    Instance name or ID where the platform exists

.PARAMETER SourcePlatform
    Name of the platform to clone

.PARAMETER DestPlatform
    Name for the cloned platform (default: auto-generated with timestamp)

.OUTPUTS
    PSCustomObject with clone result including job_id and platform_name
#>
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
    
    $luaCode = "local result = remote.call('surface_export', 'clone_platform', '$SourcePlatform', '$DestPlatform') rcon.print(helpers.table_to_json(result))"
    $result = Invoke-Lua -Instance $Instance -Code $luaCode -ReturnJson
    
    if (-not $result) {
        return @{ success = $false; error = "Failed to parse clone result" }
    }
    
    return $result
}

<#
.SYNOPSIS
    Get the index of a platform by name.

.PARAMETER Instance
    Instance name or ID

.PARAMETER PlatformName
    Name of the platform to look up
#>
function Get-PlatformIndex {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$PlatformName
    )
    
    $luaCode = "for i, p in pairs(game.forces.player.platforms) do if p.name == '$PlatformName' then rcon.print(i) return end end rcon.print('NOT_FOUND')"
    $result = Invoke-Lua -Instance $Instance -Code $luaCode
    
    if ($result -eq "NOT_FOUND") {
        return $null
    }
    
    return [int]$result
}

<#
.SYNOPSIS
    List all platforms on an instance.

.PARAMETER Instance
    Instance name or ID
#>
function Get-Platforms {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance
    )
    
    $output = Send-Rcon -Instance $Instance -Command "/list-platforms"
    return $output
}

<#
.SYNOPSIS
    Delete a platform by name.

.PARAMETER Instance
    Instance name or ID

.PARAMETER PlatformName
    Name of the platform to delete

.OUTPUTS
    Boolean indicating success
#>
function Remove-Platform {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$PlatformName
    )
    
    # Find platform index first
    $index = Get-PlatformIndex -Instance $Instance -PlatformName $PlatformName
    if (-not $index) {
        return $false
    }
    
    # Delete the platform (use destroy(0) for immediate deletion at end of tick)
    $luaCode = "local p = game.forces.player.platforms[$index] if p and p.valid then p.destroy(0) rcon.print('deleted') else rcon.print('not_found') end"
    $result = Invoke-Lua -Instance $Instance -Code $luaCode
    
    return $result -eq "deleted"
}

<#
.SYNOPSIS
    Clean up old test platforms matching a prefix.

.PARAMETER Instance
    Instance name or ID

.PARAMETER Prefix
    Platform name prefix to match (e.g., "entity-test-" or "integration-test-")

.PARAMETER KeepCount
    Number of most recent platforms to keep (default: 0 = delete all)

.OUTPUTS
    Number of platforms deleted
#>
function Clear-TestPlatforms {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$Prefix,
        [int]$KeepCount = 0
    )
    
    # Get all platforms matching prefix
    # Escape special Lua pattern characters (especially - which is common in prefixes)
    $luaPrefix = $Prefix -replace '([-%.%+%*%?%[%]%^%$%(%)%%])', '%$1'
    
    # Get matching platforms, sorted by name descending (newest first)
    # Then delete all except KeepCount newest in a single Lua call
    $luaCode = @"
local platforms = {}
for i, p in pairs(game.forces.player.platforms) do
    if p.name:find('^$luaPrefix') then
        table.insert(platforms, p)
    end
end
-- Sort by name descending (newest first based on timestamp in name)
table.sort(platforms, function(a, b) return a.name > b.name end)
-- Delete all except the first $KeepCount (use destroy(0) for immediate deletion at end of tick)
local deleted = 0
for i = $($KeepCount + 1), #platforms do
    if platforms[i] and platforms[i].valid then
        platforms[i].destroy(0)
        deleted = deleted + 1
    end
end
rcon.print(deleted)
"@
    
    $result = Invoke-Lua -Instance $Instance -Code $luaCode
    
    # Result is the count of deleted platforms
    if ($result -match '^\d+$') {
        return [int]$result
    }
    return 0
}

<#
.SYNOPSIS
    Get all surfaces from the game.

.PARAMETER Instance
    Instance name or ID

.OUTPUTS
    Array of surface objects with index, name, and platform properties
#>
function Get-Surfaces {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance
    )
    
    $luaCode = @"
local surfaces = {}
for _, surface in pairs(game.surfaces) do
    table.insert(surfaces, {
        index = surface.index,
        name = surface.name,
        is_platform = surface.platform ~= nil
    })
end
rcon.print(helpers.table_to_json(surfaces))
"@
    
    $result = Invoke-Lua -Instance $Instance -Code $luaCode
    
    try {
        return $result | ConvertFrom-Json
    } catch {
        Write-Warning "Failed to parse surfaces JSON: $result"
        return @()
    }
}

<#
.SYNOPSIS
    Delete test surfaces matching a name pattern.

.DESCRIPTION
    Uses the /delete-surfaces command to schedule deletion of all platform surfaces
    whose names contain the specified pattern. Only works on space platform surfaces.
    
    After calling this function, you must step at least one tick for the deletions
    to take effect (the platforms are scheduled for deletion at end of current tick).

.PARAMETER Instance
    Instance name or ID

.PARAMETER TestName
    The test name pattern to match (e.g., "entity-test-" or "integration-test-")
    Surfaces with names containing this string will be deleted.

.OUTPUTS
    Hashtable with:
    - deleted: Number of surfaces scheduled for deletion
    - failed: Number that failed to delete
    - names: Array of surface names that were scheduled for deletion
#>
function Remove-TestSurfaces {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$TestName
    )
    
    # First get matching surfaces so we can report what was deleted
    $surfaces = Get-Surfaces -Instance $Instance
    $matching = $surfaces | Where-Object { $_.is_platform -and $_.name -like "*$TestName*" }
    
    if ($matching.Count -eq 0) {
        return @{
            deleted = 0
            failed = 0
            names = @()
        }
    }
    
    # Use the /delete-surfaces command
    $output = Send-Rcon -Instance $Instance -Command "/delete-surfaces $TestName"
    
    # Parse the result to get counts
    $deleted = 0
    $failed = 0
    
    foreach ($line in $output) {
        if ($line -match 'Scheduled (\d+) for deletion, (\d+) failed') {
            $deleted = [int]$Matches[1]
            $failed = [int]$Matches[2]
        }
    }
    
    return @{
        deleted = $deleted
        failed = $failed
        names = @($matching | ForEach-Object { $_.name })
    }
}

<#
.SYNOPSIS
    Delete multiple surfaces by their exact names.

.DESCRIPTION
    Deletes specific surfaces by name. Only works on space platform surfaces.
    
    After calling this function, you must step at least one tick for the deletions
    to take effect.

.PARAMETER Instance
    Instance name or ID

.PARAMETER SurfaceNames
    Array of surface names to delete

.OUTPUTS
    Hashtable with:
    - deleted: Number of surfaces scheduled for deletion
    - failed: Number that failed to delete
#>
function Remove-SurfacesByName {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string[]]$SurfaceNames
    )
    
    if ($SurfaceNames.Count -eq 0) {
        return @{
            deleted = 0
            failed = 0
        }
    }
    
    # Build a Lua table of names to delete
    $namesJson = ($SurfaceNames | ForEach-Object { "`"$_`"" }) -join ","
    
    $luaCode = @"
local names_to_delete = {$namesJson}
local name_set = {}
for _, name in ipairs(names_to_delete) do
    name_set[name] = true
end

local deleted = 0
local failed = 0

for _, surface in pairs(game.surfaces) do
    if name_set[surface.name] and surface.platform then
        local platform = surface.platform
        if platform and platform.valid then
            platform.destroy(0)
            deleted = deleted + 1
        else
            failed = failed + 1
        end
    end
end

rcon.print(helpers.table_to_json({deleted = deleted, failed = failed}))
"@
    
    $result = Invoke-Lua -Instance $Instance -Code $luaCode
    
    try {
        $parsed = $result | ConvertFrom-Json
        return @{
            deleted = $parsed.deleted
            failed = $parsed.failed
        }
    } catch {
        Write-Warning "Failed to parse delete result: $result"
        return @{
            deleted = 0
            failed = $SurfaceNames.Count
        }
    }
}

<#
.SYNOPSIS
    Create an isolated test surface with automatic cleanup of old test surfaces.

.DESCRIPTION
    This function handles the complete workflow for creating an isolated test surface:
    1. Cleans up old test surfaces matching the test prefix
    2. Steps ticks to finalize any scheduled deletions
    3. Generates a unique test surface name with timestamp
    4. Clones the source platform to create the test surface
    5. Steps ticks to wait for clone completion

.PARAMETER Instance
    Instance name or ID (e.g., "clusterio-host-1-instance-1")

.PARAMETER TestPrefix
    Prefix for test surface names (e.g., "entity-test-" or "integration-test-")
    Old surfaces matching this prefix will be cleaned up.

.PARAMETER SourcePlatform
    Name of the platform to clone (default: "test")

.PARAMETER ShowProgress
    If true, write progress messages to console

.OUTPUTS
    Hashtable with:
    - success: Boolean indicating if surface was created
    - platformName: Name of the created test surface (or source platform if failed)
    - entityCount: Number of entities cloned (if successful)
    - cleanedUp: Number of old surfaces cleaned up
    - error: Error message (if failed)
#>
function New-IsolatedTestSurface {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$TestPrefix,
        [string]$SourcePlatform = "test",
        [switch]$ShowProgress
    )
    
    $result = @{
        success = $false
        platformName = $SourcePlatform
        entityCount = 0
        cleanedUp = 0
        error = $null
    }
    
    # Step 1: Clean up old test surfaces
    if ($ShowProgress) {
        Write-Host "  Cleaning up old test surfaces..." -ForegroundColor Gray
    }
    
    $cleanup = Remove-TestSurfaces -Instance $Instance -TestName $TestPrefix
    $result.cleanedUp = $cleanup.deleted
    
    if ($ShowProgress -and $cleanup.deleted -gt 0) {
        Write-Status "Scheduled $($cleanup.deleted) old test surface(s) for deletion" -Type success
    }
    
    # Step 2: Wait briefly for any scheduled deletions to process
    Start-Sleep -Seconds 1
    
    # Step 3: Generate unique test surface name
    $TestRunId = Get-Date -Format "yyyyMMdd_HHmmss"
    $TestPlatformName = "$TestPrefix$TestRunId"
    
    # Step 4: Clone the source platform
    if ($ShowProgress) {
        Write-Host "  Creating isolated test surface..." -ForegroundColor Gray
    }
    
    $cloneResult = New-TestPlatform -Instance $Instance -SourcePlatform $SourcePlatform -DestPlatform $TestPlatformName
    
    if (-not $cloneResult.success) {
        $result.error = $cloneResult.error
        if ($ShowProgress) {
            Write-Status "Failed to create test surface: $($cloneResult.error)" -Type error
            Write-Status "Using source platform directly (tests may affect it)" -Type warning
        }
        return $result
    }
    
    $result.success = $true
    $result.platformName = $TestPlatformName
    $result.entityCount = $cloneResult.entity_count
    
    if ($ShowProgress) {
        Write-Status "Created test surface '$TestPlatformName'" -Type success
    }
    
    # Step 5: Wait for clone import job to complete
    # The clone starts an async import job that processes entities in batches per tick.
    # We must wait for it to finish before the surface has all entities.
    $jobId = $cloneResult.job_id
    if ($jobId) {
        if ($ShowProgress) {
            Write-Host "  Waiting for clone import job '$jobId' to complete..." -ForegroundColor Gray
        }
        
        $checkScript = "local jobs = storage.async_jobs or {}; local j = jobs['$jobId']; rcon.print(j == nil and 'true' or 'false')"
        $jobDone = Wait-ForJob -Instances @($Instance) -MaxWaitSeconds 60 -CheckScript $checkScript
        
        if (-not $jobDone) {
            if ($ShowProgress) {
                Write-Status "Clone import job '$jobId' timed out after 60s" -Type warning
            }
        } elseif ($ShowProgress) {
            Write-Status "Clone import job completed" -Type success
        }
    } else {
        # Fallback: no job_id returned, wait for processing
        Start-Sleep -Seconds 5
    }
    
    return $result
}

#endregion

#region Tick Control

<#
.SYNOPSIS
    Step game ticks on an instance (for paused games).

.PARAMETER Instance
    Instance name or ID

.PARAMETER Ticks
    Number of ticks to step (default: 60)

.PARAMETER EnsurePaused
    If true, pause the game first if not already paused
#>
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

<#
.SYNOPSIS
    Pause or unpause the game on an instance.

.PARAMETER Instance
    Instance name or ID

.PARAMETER Pause
    True to pause, false to unpause
#>
function Set-GamePaused {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [bool]$Pause = $true
    )
    
    $value = if ($Pause) { "true" } else { "false" }
    Invoke-Lua -Instance $Instance -Code "game.tick_paused = $value" | Out-Null
}

#endregion

#region Debug Files

<#
.SYNOPSIS
    Clear debug files from an instance.

.PARAMETER Instance
    Instance name (e.g., "clusterio-host-1-instance-1")

.PARAMETER Container
    Docker container name (e.g., "clusterio-host-1")

.PARAMETER Pattern
    File pattern to clear (default: "debug_*.json")
#>
function Clear-DebugFiles {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$Container,
        [string]$Pattern = "debug_*.json"
    )
    
    docker exec $Container bash -c "rm -f /clusterio/data/instances/$Instance/script-output/$Pattern" 2>$null
}

<#
.SYNOPSIS
    Get debug files from an instance.

.PARAMETER Instance
    Instance name

.PARAMETER Container
    Docker container name

.PARAMETER Pattern
    File pattern to list (default: "debug_*.json")

.OUTPUTS
    Array of filenames
#>
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

<#
.SYNOPSIS
    Read and parse a debug JSON file from an instance.

.PARAMETER Instance
    Instance name

.PARAMETER Container
    Docker container name

.PARAMETER Filename
    Full path or just filename in script-output
#>
function Read-DebugFile {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Instance,
        [Parameter(Mandatory=$true)]
        [string]$Container,
        [Parameter(Mandatory=$true)]
        [string]$Filename
    )
    
    # If just a filename, prepend path
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

#endregion

#region Test Infrastructure

<#
.SYNOPSIS
    Load test cases from a JSON file.

.PARAMETER Path
    Path to test-cases.json file
#>
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

<#
.SYNOPSIS
    Filter test cases by ID and/or category.

.PARAMETER TestSuite
    The test suite object (from Get-TestCases)

.PARAMETER TestId
    Filter by specific test ID

.PARAMETER Category
    Filter by category
#>
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

<#
.SYNOPSIS
    Safely get a property value from a PSObject, returning $null if not present.

.PARAMETER Object
    The object to query

.PARAMETER PropertyName
    The property name to look up
#>
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

#endregion

#region Output Formatting

<#
.SYNOPSIS
    Write a test header banner.

.PARAMETER Title
    The test suite title
#>
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

<#
.SYNOPSIS
    Write a test result line.

.PARAMETER TestId
    The test ID

.PARAMETER TestName
    The test name

.PARAMETER Status
    Status: passed, failed, skipped, error

.PARAMETER Message
    Optional failure message
#>
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
        Write-Host "      $Message" -ForegroundColor DarkRed
    }
}

<#
.SYNOPSIS
    Write a test summary.

.PARAMETER Passed
    Number of passed tests

.PARAMETER Failed
    Number of failed tests

.PARAMETER Skipped
    Number of skipped tests
#>
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

<#
.SYNOPSIS
    Write a status message with icon.

.PARAMETER Message
    The message to display

.PARAMETER Type
    Message type: info, success, warning, error
#>
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

#endregion

#region Transfer Operations

<#
.SYNOPSIS
    Wait for an async job to complete by stepping ticks.

.PARAMETER Instances
    Array of instance names/IDs to step ticks on

.PARAMETER MaxWaitSeconds
    Maximum time to wait (default: 30)

.PARAMETER CheckScript
    Optional Lua code that returns "true" when job is complete
#>
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
        # Wait for async processing (game ticks continuously on headless server)
        Start-Sleep -Seconds 1
        
        if ($CheckScript) {
            $result = Invoke-Lua -Instance $Instances[0] -Code $CheckScript
            if ($result -eq "true") {
                $done = $true
            }
        } else {
            # If no check script, just wait for ticks to process
            $done = $true
        }
    }
    
    return $done
}

<#
.SYNOPSIS
    Initiate a platform transfer between instances.

.PARAMETER SourceInstance
    Source instance name or ID

.PARAMETER DestInstanceId
    Destination instance ID (numeric)

.PARAMETER PlatformIndex
    Index of the platform to transfer
#>
function Start-PlatformTransfer {
    param(
        [Parameter(Mandatory=$true)]
        [string]$SourceInstance,
        [Parameter(Mandatory=$true)]
        [int]$DestInstanceId,
        [Parameter(Mandatory=$true)]
        [int]$PlatformIndex
    )
    
    $command = "/transfer-platform $PlatformIndex $DestInstanceId"
    $output = Send-Rcon -Instance $SourceInstance -Command $command
    return $output
}

<#
.SYNOPSIS
    Resolve a Clusterio instance name to its numeric instance ID.

.PARAMETER InstanceName
    The instance name (e.g., "clusterio-host-2-instance-1")

.PARAMETER Controller
    Docker container name of the controller

.EXAMPLE
    Get-ClusterioInstanceId -InstanceName "clusterio-host-2-instance-1"
    # Returns: 96699824
#>
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

#endregion

# Export module members
Export-ModuleMember -Function @(
    # RCON
    'Send-Rcon',
    'Invoke-Lua',
    
    # Platform Management
    'New-TestPlatform',
    'Get-PlatformIndex',
    'Get-Platforms',
    'Remove-Platform',
    'Clear-TestPlatforms',
    
    # Surface Management
    'Get-Surfaces',
    'Remove-TestSurfaces',
    'Remove-SurfacesByName',
    'New-IsolatedTestSurface',
    
    # Tick Control
    'Step-Tick',
    'Set-GamePaused',
    
    # Debug Files
    'Clear-DebugFiles',
    'Get-DebugFiles',
    'Read-DebugFile',
    
    # Test Infrastructure
    'Get-TestCases',
    'Select-Tests',
    'Get-SafeProperty',
    
    # Output
    'Write-TestHeader',
    'Write-TestResult',
    'Write-TestSummary',
    'Write-Status',
    
    # Transfer
    'Wait-ForJob',
    'Start-PlatformTransfer',
    
    # Instance Resolution
    'Get-ClusterioInstanceId'
)
