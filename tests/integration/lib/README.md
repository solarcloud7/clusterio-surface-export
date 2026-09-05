# Integration Test Library

Shared infrastructure for running integration tests against the Clusterio cluster.

## Module: TestBase.psm1

A PowerShell module providing common functions for:
- RCON communication with Clusterio instances
- Platform cloning for isolated test surfaces
- Debug file retrieval and parsing
- Tick waiting for async operations
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

### Async Wait

Wait for async operations to complete (uses `Start-Sleep` under the hood):

```powershell
Step-Tick -Instance 1 -Ticks 60
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

### Async Wait
| Function | Description |
|----------|-------------|
| `Step-Tick` | Wait for async processing (Start-Sleep) |
| `Set-GamePaused` | Pause/unpause game |

### Debug Files
| Function | Description |
|----------|-------------|
| `Clear-DebugFiles` | Remove debug files |
| `Get-DebugFiles` | List debug files |
| `Read-DebugFile` | Read and parse debug JSON |
| `Assert-TransferSucceeded` | Stop success-path tests on a failed verdict before destination census |

### Test Infrastructure
| Function | Description |
|----------|-------------|
| `Get-TestCases` | Load a `test-cases.json` definitions file — no such file exists in the repo and no test calls this (legacy, unused) |
| `Select-Tests` | Filter a loaded test suite by ID/category (legacy, unused — pairs with `Get-TestCases`) |
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
2. Create `run-tests.mjs` or `run-tests.ps1` in it — `tools/tests/run-integration-tests.mjs`
   auto-discovers both shapes; nothing else needs editing
3. A `.ps1` runner may import `TestBase.psm1` for RCON, platform cloning, tick stepping, and
   output helpers; `.mjs` runners are the majority shape, and 11 of the 30 share
   `tests/lab-gallery/batch-lifecycle.mjs` for RCON/sleep helpers
4. Use `New-TestPlatform` (or `clone_platform` via RCON) for isolated test surfaces, and register
   any new surface-name prefix in `tools/tests/cleanup-test-surfaces.ps1`
