# Entity Roundtrip Integration Tests

This test suite validates that entities can be correctly serialized and deserialized
through the surface_export plugin's export/import pipeline.

## Quick Start

```powershell
# Run all tests
.\run-tests.ps1

# Run with verbose output
.\run-tests.ps1 -Verbose

# Run a specific test
.\run-tests.ps1 -TestId "gun-turret-priorities"

# Run all tests in a category
.\run-tests.ps1 -Category "turrets"
```

## Prerequisites

- Docker running with Clusterio cluster deployed
- Instance 1 must be running and accessible via RCON
- The `surface_export` plugin must be loaded

## Test Case Structure

Tests are defined in `test-cases.json`. Each test has:

```json
{
  "id": "unique-test-id",
  "name": "Human readable name",
  "category": "category-name",
  "entity": {
    "name": "entity-prototype-name",
    "direction": 0,
    "specific_data": {
      // Entity-specific data to import
    }
  },
  "expect": {
    "success": true,
    "max_mismatches": 0,
    "fields_must_exist": ["field1", "field2"],
    "allowed_mismatch_fields": ["field_that_may_differ"]
  }
}
```

### Categories

| Category | Description |
|----------|-------------|
| `containers` | Chests, storage containers |
| `belts` | Transport belts, underground belts, splitters |
| `turrets` | Gun turrets, laser turrets, fluid turrets |
| `inserters` | All inserter types |
| `fluids` | Storage tanks, pipes |
| `production` | Assemblers, furnaces, chemical plants |
| `power` | Accumulators, boilers, solar panels |
| `logistics` | Roboports, radar |
| `combinators` | Circuit network components |
| `trains` | Locomotives, wagons (often skipped due to track requirements) |

### Expectations

- `success`: Whether entity creation should succeed
- `max_mismatches`: Maximum allowed field mismatches in roundtrip comparison
- `fields_must_exist`: Fields that must be present in exported data
- `allowed_mismatch_fields`: Fields where mismatches are acceptable (e.g., dynamic values)
- `notes`: Documentation about why certain expectations are set

### Skipping Tests

Tests that require special setup can be skipped:

```json
{
  "id": "cargo-wagon-items",
  "skip": true,
  "skip_reason": "Requires track placement first",
  ...
}
```

## Adding New Tests

1. Open `test-cases.json`
2. Add a new test object to the `tests` array
3. Use an existing test as a template
4. Run the test to verify it works:
   ```powershell
   .\run-tests.ps1 -TestId "your-new-test-id" -Verbose
   ```

## How It Works

1. The test runner reads test definitions from `test-cases.json`
2. For each test:
   - Assigns a unique position (to avoid entity collisions)
   - Sends the entity data to `remote.call("surface_export", "test_import_entity", ...)`
   - The Lua function:
     - Creates the entity using `Deserializer.create_entity()`
     - Restores state using `Deserializer.restore_entity_state()`
     - Restores inventories using `Deserializer.restore_inventories()`
     - Re-exports the entity using `EntityScanner.serialize_entity()`
     - Compares input vs output
   - The test runner checks if results match expectations

## Troubleshooting

### "No JSON response received"
- Check that the cluster is running: `docker ps`
- Check instance status: `docker exec clusterio-controller npx clusterioctl instance list`

### Entity creation failures
- The entity prototype might not exist (mod not loaded)
- Position might be blocked
- Run with `-Verbose` to see detailed error messages

### Unexpected mismatches
- Some fields are dynamically generated on export (e.g., `quality: "normal"`)
- Fluid amounts may have precision differences
- Energy levels decay over time

## CI/CD Integration

The script exits with code 0 on success, 1 on any failures:

```yaml
- name: Run Integration Tests
  run: |
    cd tests/integration/entity-roundtrip
    ./run-tests.ps1
```
