# How the Mod Works

## Architecture Overview

FactorioSurfaceExport is designed to capture complete game state from a Factorio surface with **zero item loss or duplication**. The mod uses a multi-phase scanning and verification system.

## Core Components

### 1. Entity Scanner (`scripts/entity-scanner.lua`)

Recursively scans all entities on a surface, capturing:
- **Entity data**: Name, position, direction, orientation
- **Configuration**: Recipe settings, module configurations, filters
- **Inventories**: All item slots across all inventory types
- **Fluids**: Fluid boxes with exact amounts and temperatures
- **Special cases**: Belt contents, inserter hands, loader states

The scanner uses **entity handlers** to process each entity type appropriately.

### 2. Entity Handlers (`scripts/entity-handlers.lua`)

Type-specific serialization for complex entities:
- **Assembling machines**: Recipe, progress, crafting speed modifiers
- **Inserters**: Hand contents, pickup/drop positions, filters
- **Transport belts**: Every item on the belt with exact position
- **Fluid systems**: All fluid boxes, connections, and exact fluid amounts
- **Logistic systems**: Network assignments, filters, requests
- **Circuit networks**: Wire connections, conditions, signals

Each handler ensures **complete state capture** for its entity type.

### 3. Inventory Scanner (`scripts/inventory-scanner.lua`)

Counts every item in every possible location:
- Player inventories (main, armor, weapons, ammo, trash)
- Entity inventories (fuel, input, output, modules, burnt result)
- Items on belts and in inserter hands
- Items on the ground
- Items in corpses
- Ghost items (construction/deconstruction)

Returns a **complete item manifest** used for verification.

### 4. Serializer (`scripts/serializer.lua`)

Converts Lua game objects into JSON-compatible data structures:
- Handles Factorio-specific types (LuaEntity, LuaInventory)
- Preserves exact floating-point positions
- Maintains entity references and connections
- Creates wire connection maps for circuit networks

### 5. Deserializer (`scripts/deserializer.lua`)

Reconstructs entities from serialized data:
- Creates entities in correct order (bases before attachments)
- Restores all inventories with exact contents
- Rebuilds circuit wire connections
- Applies all entity settings and configurations

### 6. Verification System (`scripts/verification.lua`)

Ensures data integrity through:
- **Item counting**: Before and after comparison
- **Checksum generation**: Hash of serialized data
- **Metadata tracking**: Export timestamp, Factorio version, schema version

### 7. Safety Wrapper (`scripts/safety.lua`)

Provides error handling and logging:
- Wraps all external calls in pcall for safety
- Detailed error messages for debugging
- Progress logging for large exports

## Data Flow

### Export Process

```
1. User calls export command
   ↓
2. Entity Scanner walks the surface
   ↓
3. Entity Handlers serialize each entity type
   ↓
4. Inventory Scanner counts all items
   ↓
5. Serializer converts to JSON
   ↓
6. Verification calculates checksum
   ↓
7. Write to script-output/surface_<name>_<tick>.json
```

### Import Process

```
1. User calls import with filename and target surface
   ↓
2. Read JSON from script-output/
   ↓
3. Deserializer parses entity data
   ↓
4. Create entities in dependency order
   ↓
5. Restore inventories and settings
   ↓
6. Rebuild circuit connections
   ↓
7. Verification counts items
   ↓
8. Compare with export manifest
```

## Key Design Decisions

### Zero Loss Guarantee

The mod achieves zero loss through:
- **Comprehensive scanning**: Every entity type has a handler
- **Exact state capture**: No approximations or simplifications
- **Verification at both ends**: Export and import checksums
- **Atomic operations**: All-or-nothing restores

### JSON Format

Uses JSON for:
- **Human readability**: Easy debugging and inspection
- **Cross-platform compatibility**: Works with any JSON parser
- **Clustorio integration**: Standard format for file transfer
- **Version tracking**: Schema version field for future compatibility

### Modular Architecture

Separate concerns:
- Scanner finds entities
- Handlers know how to serialize each type
- Inventory counter provides verification
- Serializer handles format conversion

This makes it easy to:
- Add new entity types
- Debug specific issues
- Extend for new features
- Maintain code quality

## Integration Points

### Remote Interface

Exposes two main functions:
```lua
remote.call("FactorioSurfaceExport", "export_surface", surface_index)
remote.call("FactorioSurfaceExport", "import_surface", filename, surface_index)
```

### File System

- Exports to: `script-output/surface_<name>_<tick>.json`
- Imports from: `script-output/<filename>`

### Clustorio Integration

Clustorio plugins can:
1. Call remote interface via RCON
2. Transfer JSON files between instances
3. Trigger imports on target instances
4. Verify transfers via checksums

## Future Enhancements

Potential improvements:
- Incremental/delta exports for efficiency
- Compression for large surfaces
- Parallel processing for massive bases
- Streaming import for memory efficiency
- Blueprint integration
