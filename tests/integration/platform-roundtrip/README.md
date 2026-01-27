# Platform Roundtrip Integration Tests

Tests that validate full platform transfers between Clusterio instances preserve all entities, items, and fluids correctly.

## Key Feature: Repeatable Tests

Tests can be run **multiple times without redeploying the cluster**. This works because:

1. Each test run **clones** the source platform to a unique timestamped name
2. The **clone** (not the original) is transferred and destroyed
3. The **original platform remains intact** for subsequent test runs

## How It Works

1. **Clone** the source platform (e.g., "test") to a unique test platform (e.g., "integration-test-20260126_143052")
2. **Clear** previous debug files from both instances
3. **Transfer** the cloned platform via RCON command
4. **Step ticks** on both instances (game may be paused)
5. **Wait** for debug files to appear on destination
6. **Parse** source, destination, and import result JSON files
7. **Compare** entity counts, item totals, and fluid totals
8. **Report** test results with pass/fail status

The clone step uses the same export/import system as transfers, ensuring it's a true deep copy.

## Prerequisites

1. **Clusterio cluster running** with at least 2 host instances
2. **Debug mode enabled** on both instances (configured in `clusterio-init.sh`)
3. **A platform exists** on the source instance (default: "test" platform)

## Running Tests

```powershell
# Run all tests (clones "test" platform)
.\run-tests.ps1

# Run a specific test
.\run-tests.ps1 -TestId "test-platform-basic"

# Run tests in a category
.\run-tests.ps1 -Category "items"

# Clone a different source platform
.\run-tests.ps1 -SourcePlatform "my-platform"

# Use existing debug files (skip clone/transfer)
.\run-tests.ps1 -SkipTransfer

# Show detailed mismatches
.\run-tests.ps1 -ShowDetails

# Custom source/destination hosts
.\run-tests.ps1 -SourceHost 1 -DestHost 2
```

## Test Cases

Tests are defined in `test-cases.json`. Each test specifies:

- **id**: Unique test identifier
- **name**: Human-readable test name
- **category**: Test category for filtering
- **expect**: Expected validation results

### Categories

- `platform` - Basic platform transfer validation
- `items` - Item count preservation tests
- `fluids` - Fluid amount preservation tests

## Debug Files

When `debug_mode` is enabled, the plugin exports:

| File | Description |
|------|-------------|
| `debug_source_platform_{name}_{tick}.json` | Source platform snapshot (before transfer) |
| `debug_destination_platform_{name}_{tick}.json` | Destination platform snapshot (after import) |
| `debug_import_result_{name}_{tick}.json` | Import validation summary |

## Adding New Tests

Edit `test-cases.json` to add new test cases:

```json
{
  "id": "my-new-test",
  "name": "My new platform test",
  "category": "platform",
  "platform": "test",
  "description": "Description of what this tests",
  "expect": {
    "validation_success": true,
    "itemCountMatch": true,
    "fluidCountMatch": true,
    "entityCountMatch": true,
    "itemTotalsMatch": true,
    "fluidTotalsMatch": true
  }
}
```

### Available Expectations

| Expectation | Description |
|-------------|-------------|
| `validation_success` | Import validation passed |
| `itemCountMatch` | Built-in item count validation passed |
| `fluidCountMatch` | Built-in fluid count validation passed |
| `entityCountMatch` | Source and destination entity counts match |
| `itemTotalsMatch` | All item type totals match (from debug JSON) |
| `fluidTotalsMatch` | All fluid type totals match (from debug JSON) |
