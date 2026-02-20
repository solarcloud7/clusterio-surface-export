<#
.SYNOPSIS
    Runs platform transfer roundtrip integration tests.

.DESCRIPTION
    Clones a source platform to create an isolated test surface, transfers it 
    between instances, then validates that all entities, items, and fluids 
    were preserved correctly using debug JSON exports.

.PARAMETER TestId
    Run only a specific test by ID

.PARAMETER Category
    Run only tests in a specific category

.PARAMETER SourcePlatform
    The source platform to clone from (default: from test-cases.json)

.PARAMETER SourceHost
    Source host number (default: from test-cases.json)

.PARAMETER DestHost
    Destination host number (default: from test-cases.json)

.PARAMETER SkipTransfer
    Skip the transfer and use existing debug files

.PARAMETER ShowDetails
    Show detailed item/fluid mismatches

.PARAMETER TransferMode
    Transfer trigger path: rcon (/transfer-platform) or controller (StartPlatformTransferRequest, same as web UI)
#>

param(
    [string]$TestId = "",
    [string]$Category = "",
    [string]$SourcePlatform = "",
    [int]$SourceHost = 0,
    [int]$DestHost = 0,
    [switch]$SkipTransfer,
    [switch]$ShowDetails,
    [ValidateSet("rcon","controller")]
    [string]$TransferMode = "rcon"
)

$ErrorActionPreference = "Stop"

# Import shared test module
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

# Load test configuration
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TestSuite = Get-TestCases -Path (Join-Path $ScriptDir "test-cases.json")

# Apply defaults
if (-not $SourcePlatform) { $SourcePlatform = $TestSuite.sourcePlatform }
if ($SourceHost -eq 0) { $SourceHost = $TestSuite.defaultSourceHost }
if ($DestHost -eq 0) { $DestHost = $TestSuite.defaultDestHost }

# Instance configuration
$sourceInstance = "clusterio-host-$SourceHost-instance-1"
$destInstance = "clusterio-host-$DestHost-instance-1"
$sourceContainer = "surface-export-host-$SourceHost"
$destContainer = "surface-export-host-$DestHost"

function Convert-CanonicalJson {
    param(
        [Parameter(Mandatory = $false)]
        [AllowNull()]
        $Value
    )
    if ($null -eq $Value) { return "null" }
    return ($Value | ConvertTo-Json -Depth 100 -Compress)
}

function Append-TestMessage {
    param(
        [string]$Current,
        [string]$Next
    )
    if (-not $Current) { return $Next }
    return "$Current; $Next"
}

# Resolve actual Clusterio instance ID for destination
Write-Host "  Resolving destination instance ID..." -ForegroundColor Gray
$destInstanceId = Get-ClusterioInstanceId -InstanceName $destInstance
if (-not $destInstanceId) {
    Write-Status "Could not resolve Clusterio instance ID for '$destInstance'" -Type error
    exit 1
}
Write-Host "  Resolved: $destInstance -> $destInstanceId" -ForegroundColor Gray

# Filter tests
$FilteredTests = Select-Tests -TestSuite $TestSuite -TestId $TestId -Category $Category
if ($FilteredTests.Count -eq 0) {
    Write-Status "No tests match filters" -Type warning
    exit 0
}

# Generate unique test platform name
$TestRunId = Get-Date -Format "yyyyMMdd_HHmmss"
$TestPlatformName = "integration-test-$TestRunId"

# Display header
Write-TestHeader "🚀 Platform Roundtrip Integration Tests"

Write-Host "  Source Platform: $SourcePlatform" -ForegroundColor White
Write-Host "  Test Platform:   $TestPlatformName" -ForegroundColor White
Write-Host "  Source Host:     host-$SourceHost" -ForegroundColor Gray
Write-Host "  Dest Host:       host-$DestHost" -ForegroundColor Gray
Write-Host "  Transfer Mode:   $TransferMode" -ForegroundColor Gray
Write-Host ""

# Step 1: Verify debug mode is enabled
Write-Host "  Verifying debug mode..." -ForegroundColor Gray
$debugCheck = Invoke-Lua -Instance $sourceInstance -Code "rcon.print(storage.surface_export_config and storage.surface_export_config.debug_mode and 'enabled' or 'disabled')"
if ($debugCheck -ne "enabled") {
    Write-Status "Debug mode not enabled on source instance" -Type error
    exit 1
}
Write-Status "Debug mode enabled" -Type success

if (-not $SkipTransfer) {
    # Step 2: Clean up old test surfaces on destination instance
    Write-Host "  Cleaning up old test surfaces on destination..." -ForegroundColor Gray
    $dstCleanup = Remove-TestSurfaces -Instance $destInstance -TestName "integration-test-"
    if ($dstCleanup.deleted -gt 0) {
        Write-Status "Scheduled $($dstCleanup.deleted) dest old surface(s) for deletion" -Type success
    }
    Start-Sleep -Seconds 1
    
    # Step 3: Clear previous debug files
    Write-Host "  Clearing previous debug files..." -ForegroundColor Gray
    Clear-DebugFiles -Instance $sourceInstance -Container $sourceContainer
    Clear-DebugFiles -Instance $destInstance -Container $destContainer
    
    # Step 4: Create isolated test surface (handles cleanup + clone on source)
    $testSurface = New-IsolatedTestSurface -Instance $sourceInstance -TestPrefix "integration-test-" -SourcePlatform $SourcePlatform -ShowProgress
    $TestPlatformName = $testSurface.platformName
    
    if (-not $testSurface.success) {
        Write-Status "Clone failed: $($testSurface.error)" -Type error
        exit 1
    }
    Write-Status "Cloned $($testSurface.entityCount) entities to '$TestPlatformName'" -Type success
    
    # Step 5: Get cloned platform index
    Write-Host "  Looking up cloned platform index..." -ForegroundColor Gray
    $platformIndex = Get-PlatformIndex -Instance $sourceInstance -PlatformName $TestPlatformName
    if (-not $platformIndex) {
        Write-Status "Cloned platform '$TestPlatformName' not found" -Type error
        exit 1
    }
    Write-Status "Cloned platform at index $platformIndex" -Type success
    
    # Step 6: Transfer the cloned platform
    Write-Host "  Triggering platform transfer..." -ForegroundColor Gray
    $transferResult = Start-PlatformTransfer -SourceInstance $sourceInstance -DestInstanceId $destInstanceId -PlatformIndex $platformIndex -TransferMode $TransferMode
    Write-Status "Transfer initiated" -Type success
    
    # Step 7: Wait for transfer to complete
    Write-Host "  Waiting for transfer completion..." -ForegroundColor Gray
    $startTime = Get-Date
    $maxWait = 180
    $found = $false
    
    while (-not $found -and ((Get-Date) - $startTime).TotalSeconds -lt $maxWait) {
        # Wait for async processing to complete
        Start-Sleep -Seconds 1
        
        # Check for import result debug file (always generated on transfer completion)
        $resultFiles = @(Get-DebugFiles -Instance $destInstance -Container $destContainer -Pattern "debug_import_result_*.json")
        if ($resultFiles -and $resultFiles.Count -gt 0) {
            $found = $true
        }
    }
    
    $elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds)
    if ($found) {
        Write-Status "Transfer completed (${elapsed}s)" -Type success
    } else {
        Write-Status "Transfer timed out after ${maxWait}s" -Type error
        exit 1
    }
}

# Step 8: Retrieve debug files
Write-Host ""
Write-Host "  Retrieving debug files..." -ForegroundColor Gray

$sourceFiles = @(Get-DebugFiles -Instance $sourceInstance -Container $sourceContainer -Pattern "debug_source_*.json")
$destFiles = @(Get-DebugFiles -Instance $destInstance -Container $destContainer -Pattern "debug_destination_*.json")
$resultFiles = @(Get-DebugFiles -Instance $destInstance -Container $destContainer -Pattern "debug_import_result_*.json")

if (-not $sourceFiles -or $sourceFiles.Count -eq 0 -or -not $destFiles -or $destFiles.Count -eq 0) {
    Write-Status "Debug files not found" -Type error
    Write-Host "    Source files: $($sourceFiles.Count)" -ForegroundColor DarkYellow
    Write-Host "    Dest files: $($destFiles.Count)" -ForegroundColor DarkYellow
    exit 1
}

# Read the most recent files
$sourceFile = $sourceFiles | Select-Object -Last 1
$destFile = $destFiles | Select-Object -Last 1
$resultFile = if ($resultFiles.Count -gt 0) { $resultFiles | Select-Object -Last 1 } else { $null }

$sourceData = Read-DebugFile -Instance $sourceInstance -Container $sourceContainer -Filename $sourceFile
$destData = Read-DebugFile -Instance $destInstance -Container $destContainer -Filename $destFile
$resultData = if ($resultFile) { Read-DebugFile -Instance $destInstance -Container $destContainer -Filename $resultFile } else { $null }

Write-Status "Debug files retrieved" -Type success

# Extract metrics for comparison
# Source debug files use stats.entity_count
# Destination debug files use entity_count directly
$sourceStats = Get-SafeProperty $sourceData "stats"
$sourceEntityCount = Get-SafeProperty $sourceStats "entity_count"
if (-not $sourceEntityCount) {
    $sourceEntityCount = Get-SafeProperty $sourceData "entity_count"
}

$destStats = Get-SafeProperty $destData "stats"
$destEntityCount = Get-SafeProperty $destStats "entity_count"
if (-not $destEntityCount) {
    $destEntityCount = Get-SafeProperty $destData "entity_count"
}

$sourceVerification = Get-SafeProperty $sourceData "verification"
$destVerification = Get-SafeProperty $destData "verification"
$sourceItemCounts = Get-SafeProperty $sourceVerification "item_counts"
$destItemCounts = Get-SafeProperty $destVerification "item_counts"
$sourceFluidCounts = Get-SafeProperty $sourceVerification "fluid_counts"
$destFluidCounts = Get-SafeProperty $destVerification "fluid_counts"

# Build item/fluid comparison
$itemMismatches = @()
$fluidMismatches = @()

if ($sourceItemCounts) {
    foreach ($prop in $sourceItemCounts.PSObject.Properties) {
        $srcVal = $prop.Value
        $dstVal = Get-SafeProperty $destItemCounts $prop.Name
        if ($srcVal -ne $dstVal) {
            $itemMismatches += @{ Item = $prop.Name; Source = $srcVal; Dest = $dstVal }
        }
    }
}

if ($sourceFluidCounts) {
    foreach ($prop in $sourceFluidCounts.PSObject.Properties) {
        $srcVal = $prop.Value
        $dstVal = Get-SafeProperty $destFluidCounts $prop.Name
        if ([math]::Abs($srcVal - $dstVal) -gt 0.1) {
            $fluidMismatches += @{ Fluid = $prop.Name; Source = $srcVal; Dest = $dstVal }
        }
    }
}

# Build schedule fidelity comparisons (records, wait_conditions, interrupts)
$sourcePlatformData = Get-SafeProperty $sourceData "platform"
$destPlatformData = Get-SafeProperty $destData "platform"
$sourceSchedule = Get-SafeProperty $sourcePlatformData "schedule"
$destSchedule = Get-SafeProperty $destPlatformData "schedule"

$sourceScheduleRecords = @()
$destScheduleRecords = @()
$sourceScheduleInterrupts = @()
$destScheduleInterrupts = @()

if ($null -ne $sourceSchedule) {
    $sourceRecordsRaw = Get-SafeProperty $sourceSchedule "records"
    $sourceInterruptsRaw = Get-SafeProperty $sourceSchedule "interrupts"
    if ($null -ne $sourceRecordsRaw) { $sourceScheduleRecords = @($sourceRecordsRaw) }
    if ($null -ne $sourceInterruptsRaw) { $sourceScheduleInterrupts = @($sourceInterruptsRaw) }
}
if ($null -ne $destSchedule) {
    $destRecordsRaw = Get-SafeProperty $destSchedule "records"
    $destInterruptsRaw = Get-SafeProperty $destSchedule "interrupts"
    if ($null -ne $destRecordsRaw) { $destScheduleRecords = @($destRecordsRaw) }
    if ($null -ne $destInterruptsRaw) { $destScheduleInterrupts = @($destInterruptsRaw) }
}

$sourceWaitConditions = @()
foreach ($record in @($sourceScheduleRecords)) {
    if ($null -ne $record) {
        $sourceWaitConditions += ,(Get-SafeProperty $record "wait_conditions")
    }
}

$destWaitConditions = @()
foreach ($record in @($destScheduleRecords)) {
    if ($null -ne $record) {
        $destWaitConditions += ,(Get-SafeProperty $record "wait_conditions")
    }
}

$sourceScheduleRecordCount = @($sourceScheduleRecords).Count
$destScheduleRecordCount = @($destScheduleRecords).Count
$sourceScheduleInterruptCount = @($sourceScheduleInterrupts).Count
$destScheduleInterruptCount = @($destScheduleInterrupts).Count

$scheduleRecordsMatch = (Convert-CanonicalJson $sourceScheduleRecords) -eq (Convert-CanonicalJson $destScheduleRecords)
$scheduleWaitConditionsMatch = (Convert-CanonicalJson $sourceWaitConditions) -eq (Convert-CanonicalJson $destWaitConditions)
$scheduleInterruptsMatch = (Convert-CanonicalJson $sourceScheduleInterrupts) -eq (Convert-CanonicalJson $destScheduleInterrupts)

# Run test assertions
Write-TestHeader "Test Results"

$passed = 0
$failed = 0
$skipped = 0

foreach ($test in $FilteredTests) {
    $testPassed = $true
    $message = ""
    
    $expect = Get-SafeProperty $test "expect"
    if (-not $expect) {
        Write-TestResult -TestId $test.id -TestName $test.name -Status "skipped" -Message "No expectations defined"
        $skipped++
        continue
    }
    
    # Check validation_success
    $expectValidation = Get-SafeProperty $expect "validation_success"
    if ($null -ne $expectValidation) {
        $actualValidation = Get-SafeProperty $resultData "validation_success"
        if ($actualValidation -ne $expectValidation) {
            $testPassed = $false
            $message = "validation_success = $actualValidation, expected $expectValidation"
        }
    }
    
    # Check itemCountMatch
    $expectItemCount = Get-SafeProperty $expect "itemCountMatch"
    if ($expectItemCount -eq $true) {
        $actualItemMatch = Get-SafeProperty (Get-SafeProperty $resultData "validation_result") "itemCountMatch"
        if ($actualItemMatch -ne $true) {
            $testPassed = $false
            $message = "itemCountMatch = $actualItemMatch"
        }
    }
    
    # Check fluidCountMatch
    $expectFluidCount = Get-SafeProperty $expect "fluidCountMatch"
    if ($expectFluidCount -eq $true) {
        $actualFluidMatch = Get-SafeProperty (Get-SafeProperty $resultData "validation_result") "fluidCountMatch"
        if ($actualFluidMatch -ne $true) {
            $testPassed = $false
            $message = "fluidCountMatch = $actualFluidMatch"
        }
    }
    
    # Check entityCountMatch (exact)
    $expectEntityCount = Get-SafeProperty $expect "entityCountMatch"
    if ($expectEntityCount -eq $true) {
        if ($sourceEntityCount -ne $destEntityCount) {
            $testPassed = $false
            $message = "Entity count mismatch: source=$sourceEntityCount, dest=$destEntityCount"
        }
    }
    
    # Check entityCountMatchWithHubTolerance (allows -1 for auto-created hub)
    $expectEntityHubTol = Get-SafeProperty $expect "entityCountMatchWithHubTolerance"
    if ($expectEntityHubTol -eq $true) {
        $diff = $sourceEntityCount - $destEntityCount
        if ($diff -lt 0 -or $diff -gt 1) {
            $testPassed = $false
            $message = "Entity count mismatch: source=$sourceEntityCount, dest=$destEntityCount (diff=$diff)"
        }
    }
    
    # Check itemTotalsMatch
    $expectItemTotals = Get-SafeProperty $expect "itemTotalsMatch"
    if ($expectItemTotals -eq $true) {
        if ($itemMismatches.Count -gt 0) {
            $testPassed = $false
            $message = "$($itemMismatches.Count) item type(s) mismatched"
        }
    }
    
    # Check fluidTotalsMatch
    $expectFluidTotals = Get-SafeProperty $expect "fluidTotalsMatch"
    if ($expectFluidTotals -eq $true) {
        if ($fluidMismatches.Count -gt 0) {
            $testPassed = $false
            $message = "$($fluidMismatches.Count) fluid type(s) mismatched"
        }
    }

    # Check schedule record fidelity
    $expectScheduleRecords = Get-SafeProperty $expect "scheduleRecordsMatch"
    if ($expectScheduleRecords -eq $true) {
        if (-not $scheduleRecordsMatch) {
            $testPassed = $false
            $message = Append-TestMessage $message "Schedule records mismatch: source=$sourceScheduleRecordCount, dest=$destScheduleRecordCount"
        }
    }

    # Check schedule wait-condition fidelity (nested in records)
    $expectScheduleWaitConditions = Get-SafeProperty $expect "scheduleWaitConditionsMatch"
    if ($expectScheduleWaitConditions -eq $true) {
        if (-not $scheduleWaitConditionsMatch) {
            $testPassed = $false
            $message = Append-TestMessage $message "Schedule wait_conditions mismatch"
        }
    }

    # Check schedule interrupt fidelity
    $expectScheduleInterrupts = Get-SafeProperty $expect "scheduleInterruptsMatch"
    if ($expectScheduleInterrupts -eq $true) {
        if (-not $scheduleInterruptsMatch) {
            $testPassed = $false
            $message = Append-TestMessage $message "Schedule interrupts mismatch: source=$sourceScheduleInterruptCount, dest=$destScheduleInterruptCount"
        }
    }
    
    # Record result
    if ($testPassed) {
        $passed++
        Write-TestResult -TestId $test.id -TestName $test.name -Status "passed"
    } else {
        $failed++
        Write-TestResult -TestId $test.id -TestName $test.name -Status "failed" -Message $message
        
        # Show details if requested
        if ($ShowDetails) {
            if ($expectItemTotals -and $itemMismatches.Count -gt 0) {
                foreach ($m in $itemMismatches) {
                    Write-Host "      ⚠️  $($m.Item): source=$($m.Source), dest=$($m.Dest)" -ForegroundColor DarkYellow
                }
            }
            if ($expectFluidTotals -and $fluidMismatches.Count -gt 0) {
                foreach ($m in $fluidMismatches) {
                    Write-Host "      ⚠️  $($m.Fluid): source=$($m.Source), dest=$($m.Dest)" -ForegroundColor DarkYellow
                }
            }
            if ($expectScheduleRecords -and -not $scheduleRecordsMatch) {
                Write-Host "      ⚠️  Schedule records differ: source=$sourceScheduleRecordCount, dest=$destScheduleRecordCount" -ForegroundColor DarkYellow
            }
            if ($expectScheduleWaitConditions -and -not $scheduleWaitConditionsMatch) {
                Write-Host "      ⚠️  Schedule wait_conditions differ between source and destination records" -ForegroundColor DarkYellow
            }
            if ($expectScheduleInterrupts -and -not $scheduleInterruptsMatch) {
                Write-Host "      ⚠️  Schedule interrupts differ: source=$sourceScheduleInterruptCount, dest=$destScheduleInterruptCount" -ForegroundColor DarkYellow
            }
        }
    }
}

# Display summary
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Summary" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Source Platform: $SourcePlatform" -ForegroundColor Gray
Write-Host "  Test Platform:   $TestPlatformName" -ForegroundColor Gray
Write-Host "  Source Entities: $sourceEntityCount" -ForegroundColor Gray
Write-Host "  Dest Entities:   $destEntityCount" -ForegroundColor Gray
Write-Host "  Source Schedule: $sourceScheduleRecordCount records, $sourceScheduleInterruptCount interrupts" -ForegroundColor Gray
Write-Host "  Dest Schedule:   $destScheduleRecordCount records, $destScheduleInterruptCount interrupts" -ForegroundColor Gray
Write-Host ""

Write-TestSummary -Passed $passed -Failed $failed -Skipped $skipped

# Exit with appropriate code
if ($failed -gt 0) {
    exit 1
}
