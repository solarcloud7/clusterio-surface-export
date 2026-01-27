<#
.SYNOPSIS
    Runs entity roundtrip integration tests.

.DESCRIPTION
    Creates an isolated test surface (cloned platform), then runs in-game entity 
    roundtrip tests via RCON. The Lua test runner creates entities, serializes them, 
    deserializes them, and compares the results.

.PARAMETER TestId
    Run only a specific test by ID

.PARAMETER Category
    Run only tests in a specific category

.PARAMETER SourcePlatform
    Platform to clone for test isolation (default: from test-cases.json)

.PARAMETER InstanceId
    Instance to run tests on (default: 1)

.PARAMETER ShowWarnings
    Show detailed warnings for each test

.PARAMETER ReuseTestPlatform
    Reuse existing test platform instead of creating new one
#>

param(
    [string]$TestId = "",
    [string]$Category = "",
    [string]$SourcePlatform = "",
    [int]$InstanceId = 1,
    [switch]$ShowWarnings,
    [switch]$ReuseTestPlatform
)

$ErrorActionPreference = "Stop"

# Import shared test module
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

# Load test configuration
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TestSuite = Get-TestCases -Path (Join-Path $ScriptDir "test-cases.json")

# Apply defaults
if (-not $SourcePlatform) { 
    $SourcePlatform = Get-SafeProperty $TestSuite "sourcePlatform"
    if (-not $SourcePlatform) { $SourcePlatform = "test" }
}

# Instance configuration
$instanceName = "clusterio-host-$InstanceId-instance-1"
$containerName = "clusterio-host-$InstanceId"

# Filter tests
$FilteredTests = Select-Tests -TestSuite $TestSuite -TestId $TestId -Category $Category
if ($FilteredTests.Count -eq 0) {
    Write-Status "No tests match filters" -Type warning
    exit 0
}

# Display header
Write-TestHeader "🧪 Entity Roundtrip Integration Tests"

if ($TestId) {
    Write-Host "  Filter: test_id = $TestId" -ForegroundColor Gray
}
if ($Category) {
    Write-Host "  Filter: category = $Category" -ForegroundColor Gray
}
Write-Host "  Instance: $InstanceId" -ForegroundColor Gray
Write-Host ""

# Create isolated test surface (unless reusing)
$TestPlatformName = $null
if (-not $ReuseTestPlatform) {
    $testSurface = New-IsolatedTestSurface -Instance $instanceName -TestPrefix "entity-test-" -SourcePlatform $SourcePlatform -ShowProgress
    $TestPlatformName = $testSurface.platformName
    
    if (-not $testSurface.success) {
        Write-Status "Using source platform directly (tests may affect it)" -Type warning
    }
} else {
    Write-Status "Reusing existing test platform" -Type info
}

# Build test suite object with filtered tests
$TestSuiteObj = @{
    description = $TestSuite.description
    tests = $FilteredTests
    basePosition = Get-SafeProperty $TestSuite "basePosition"
    positionIncrement = Get-SafeProperty $TestSuite "positionIncrement"
}

# Add test platform name if we created one
if ($TestPlatformName -and $TestPlatformName -ne $SourcePlatform) {
    $TestSuiteObj.testPlatform = $TestPlatformName
}

# Convert to JSON
$TestCasesJson = $TestSuiteObj | ConvertTo-Json -Depth 10 -Compress
$TestCasesJsonEscaped = $TestCasesJson -replace "'", "\'"

# Execute tests via RCON
Write-Host "  Running tests..." -ForegroundColor Gray

$luaCode = "local result = remote.call('surface_export', 'run_tests_json', '$TestCasesJsonEscaped') rcon.print(result)"
$output = Invoke-Lua -Instance $instanceName -Code $luaCode

# Parse results
$ResultsJson = $null
if ($output -match '(\{"passed":\d+.*\})$') {
    $ResultsJson = $Matches[1]
} elseif ($output -match '(\{"passed":\d+[^}]*"details":\[[^\]]*\][^}]*\})') {
    $ResultsJson = $Matches[1]
}

if (-not $ResultsJson) {
    Write-Status "Failed to parse test results" -Type error
    Write-Host ""
    Write-Host "  Raw output (last 2000 chars):" -ForegroundColor Yellow
    $OutputTrunc = if ($output.Length -gt 2000) { $output.Substring($output.Length - 2000) } else { $output }
    Write-Host $OutputTrunc -ForegroundColor Gray
    exit 1
}

$Results = $ResultsJson | ConvertFrom-Json

# Display results
Write-TestHeader "Test Results"

foreach ($detail in $Results.details) {
    $status = switch ($detail.status) {
        "passed"  { "passed" }
        "failed"  { "failed" }
        "skipped" { "skipped" }
        "error"   { "error" }
        default   { "error" }
    }
    
    Write-TestResult -TestId $detail.id -TestName $detail.name -Status $status -Message $detail.message
    
    if ($ShowWarnings -and $detail.warnings -and $detail.warnings.Count -gt 0) {
        foreach ($warning in $detail.warnings) {
            Write-Host "      ⚠️  $warning" -ForegroundColor DarkYellow
        }
    }
}

# Summary
Write-TestSummary -Passed $Results.passed -Failed $Results.failed -Skipped $Results.skipped

# Exit with appropriate code
if ($Results.failed -gt 0) {
    exit 1
}
