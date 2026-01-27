# Integration Test Library

Shared infrastructure for running integration tests against the Clusterio cluster.

## Module: TestBase.psm1

A PowerShell module providing common functions for:
- RCON communication with Clusterio instances
- Platform cloning for isolated test surfaces
- Debug file retrieval and parsing
- Tick stepping for paused games
- Test result formatting and reporting

## Key Features

### Isolated Test Surfaces

Each test creates its own cloned platform surface to prevent tests from interfering with each other:

```powershell
# Clone a platform for testing
$result = New-TestPlatform -Instance 1 -SourcePlatform "test" -DestPlatform "my-test-123"

# The clone uses the export/import system - a true deep copy
```

### Safe Property Access

Use `Get-SafeProperty` to safely access properties that may not exist (avoids strict mode errors):

```powershell
$value = Get-SafeProperty $object "propertyName"  # Returns $null if missing
```

### Tick Control

For paused games, step ticks to process async operations:

```powershell
Step-Tick -Instance 1 -Ticks 60 -EnsurePaused
```

## Exported Functions

### RCON Communication
| Function | Description |
|----------|-------------|
| `Send-Rcon` | Send raw RCON command |
| `Invoke-Lua` | Execute Lua code via /sc |

### Platform Management
| Function | Description |
|----------|-------------|
| `New-TestPlatform` | Clone a platform for isolated testing |
| `Get-PlatformIndex` | Get platform index by name |
| `Get-Platforms` | List all platforms |

### Tick Control
| Function | Description |
|----------|-------------|
| `Step-Tick` | Step game ticks |
| `Set-GamePaused` | Pause/unpause game |

### Debug Files
| Function | Description |
|----------|-------------|
| `Clear-DebugFiles` | Remove debug files |
| `Get-DebugFiles` | List debug files |
| `Read-DebugFile` | Read and parse debug JSON |

### Test Infrastructure
| Function | Description |
|----------|-------------|
| `Get-TestCases` | Load test-cases.json |
| `Select-Tests` | Filter tests by ID/category |
| `Get-SafeProperty` | Safe property access |

### Output
| Function | Description |
|----------|-------------|
| `Write-TestHeader` | Write section header |
| `Write-TestResult` | Write pass/fail result |
| `Write-TestSummary` | Write summary stats |
| `Write-Status` | Write status message |

### Transfer Operations
| Function | Description |
|----------|-------------|
| `Wait-ForJob` | Wait for async job completion |
| `Start-PlatformTransfer` | Initiate platform transfer |

## Usage in Tests

```powershell
# Import the module
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force

# Load and filter tests
$TestSuite = Get-TestCases -Path "test-cases.json"
$Tests = Select-Tests -TestSuite $TestSuite -Category "items"

# Create isolated test surface
$clone = New-TestPlatform -Instance 1 -SourcePlatform "test"

# Run test operations...

# Display results
Write-TestHeader "Results"
Write-TestResult -TestId "test-1" -TestName "My Test" -Status "passed"
Write-TestSummary -Passed 1 -Failed 0
```

## Adding New Integration Tests

1. Create a new directory under `tests/integration/`
2. Create `test-cases.json` with your test definitions
3. Create `run-tests.ps1` that imports `TestBase.psm1`
4. Use `New-TestPlatform` to create isolated test surfaces
5. Use the shared functions for RCON, tick stepping, and output
