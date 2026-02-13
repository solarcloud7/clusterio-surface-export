# Factorio 2.0 Cargo Pod API Reference

This document covers the Lua API for cargo pods in Factorio 2.0, particularly relevant for platform export/import operations.

## Overview

Cargo pods are entities that transport items between surfaces (planets, platforms, etc.). The API provides full access to in-flight cargo, allowing us to capture items without waiting for pods to land.

## Key Entity Properties

### cargo_pod_state (Read Only)
Returns the current state of the cargo pod:
- `"awaiting_launch"` - Pod is waiting to be launched
- `"ascending"` - Pod is rising from origin
- `"surface_transition"` - Pod is transitioning between surfaces
- `"descending"` - Pod is descending to destination
- `"parking"` - Pod is parking at destination station

### cargo_pod_destination (Read/Write)
The destination of the cargo pod. Uses `CargoDestination` type.

### cargo_pod_origin (Read/Write)
The origin entity (must be a rocket silo, space platform hub, or cargo landing pad).

### Inventory Access
```lua
-- Cargo pod inventory: defines.inventory.cargo_unit
local inventory = cargo_pod.get_inventory(defines.inventory.cargo_unit)
```

## CargoDestination Type

```lua
{
    type = defines.cargo_destination,  -- Required
    station = LuaEntity?,              -- For station type (hub or landing pad)
    hatch = LuaCargoHatch?,            -- Optional specific hatch
    transform_launch_products = boolean?, -- Transform items with rocket_launch_products
    surface = SurfaceIdentification?,  -- For surface type
    position = MapPosition?,           -- Landing position for surface type
    land_at_exact_position = boolean?, -- Land exactly at position
    space_platform = LuaSpacePlatform? -- For starter pack delivery only
}
```

### defines.cargo_destination Types
- `invalid` - Default when created via script; setting destination launches it
- `orbit` - Cargo pod destroyed when ascent completes
- `station` - Any cargo landing pad or space platform hub
- `surface` - Land on a surface (switches to station if one is available)
- `space_platform` - Only for starter pack delivery to waiting platforms

## LuaSpacePlatform Methods

### can_leave_current_location()
Returns `true` when the space platform isn't waiting on any delivery from the planet.

**Note**: This is what we currently use to wait for deliveries. With direct pod inventory access, we can skip this wait entirely.

## Useful Methods

### Force Immediate Landing
```lua
-- Skip all descent animation and immediately deposit cargo
cargo_pod.force_finish_descending()
-- Raises: on_cargo_pod_finished_descending, on_cargo_pod_delivered_cargo
```

### Force Immediate Ascent  
```lua
-- Skip all ascent animation and immediately switch surface
cargo_pod.force_finish_ascending()
-- Raises: on_cargo_pod_finished_ascending
```

### Create Cargo Pod
```lua
-- On rocket silo, cargo landing pad, or space platform hub
local pod = entity.create_cargo_pod(cargo_hatch?)
-- Returns pod with invalid destination; set destination to launch
```

## Example: Capture In-Flight Cargo

```lua
--- Find all cargo pods delivering to a platform and capture their contents
--- @param surface LuaSurface: The platform surface
--- @param hub LuaEntity: The space platform hub
--- @return table: Array of in-flight cargo items
local function capture_incoming_cargo(surface, hub)
    local incoming_cargo = {}
    local pods = surface.find_entities_filtered({name = "cargo-pod"})
    
    for _, pod in ipairs(pods) do
        if pod.valid then
            local dest = pod.cargo_pod_destination
            local state = pod.cargo_pod_state
            
            -- Check pod destination and state
            local pod_info = {
                state = state,
                destination_type = dest.type,
                items = {}
            }
            
            -- Access the cargo pod's inventory
            local inventory = pod.get_inventory(defines.inventory.cargo_unit)
            if inventory then
                for i = 1, #inventory do
                    local stack = inventory[i]
                    if stack.valid_for_read then
                        table.insert(pod_info.items, {
                            name = stack.name,
                            count = stack.count,
                            quality = stack.quality and stack.quality.name or "normal"
                        })
                    end
                end
            end
            
            if #pod_info.items > 0 then
                table.insert(incoming_cargo, pod_info)
            end
        end
    end
    
    return incoming_cargo
end
```

## Example: Check If Platform Has Pending Deliveries

```lua
--- Check if a platform has any incoming cargo pods
--- @param platform LuaSpacePlatform: The platform to check
--- @return boolean: true if there are incoming pods
--- @return number: count of incoming pods
local function has_incoming_cargo(platform)
    local surface = platform.surface
    if not surface or not surface.valid then
        return false, 0
    end
    
    local pods = surface.find_entities_filtered({name = "cargo-pod"})
    local incoming_count = 0
    
    for _, pod in ipairs(pods) do
        local state = pod.cargo_pod_state
        -- Count pods that are descending or parking
        if state == "descending" or state == "parking" then
            incoming_count = incoming_count + 1
        end
    end
    
    return incoming_count > 0, incoming_count
end
```

## Export Strategy Options

### Option 1: Wait for Pods (Current Approach)
```lua
-- Wait until no cargo pods exist on surface
local pods = surface.find_entities_filtered({name = "cargo-pod"})
while #pods > 0 do
    -- Wait and retry
end
-- Then export
```

### Option 2: Capture In-Flight Cargo (Recommended)
```lua
-- Don't wait - capture pod contents directly
local incoming = capture_incoming_cargo(surface, hub)
-- Include in export data
export_data.incoming_cargo = incoming
-- On import, either:
-- A) Add items directly to hub inventory, or
-- B) Create new cargo pods with same contents
```

### Option 3: Force Immediate Landing
```lua
-- Force all pods to complete immediately
local pods = surface.find_entities_filtered({name = "cargo-pod"})
for _, pod in ipairs(pods) do
    if pod.cargo_pod_state == "descending" then
        pod.force_finish_descending()
    end
end
-- Then export normally
```

## Related Events

- `on_cargo_pod_started_ascending` - Pod begins ascent
- `on_cargo_pod_finished_ascending` - Pod completes ascent
- `on_cargo_pod_finished_descending` - Pod completes descent  
- `on_cargo_pod_delivered_cargo` - Pod deposits its cargo

## References

- [LuaEntity - Cargo Pod Properties](https://lua-api.factorio.com/latest/classes/LuaEntity.html)
- [CargoDestination Concept](https://lua-api.factorio.com/latest/concepts/CargoDestination.html)
- [LuaSpacePlatform](https://lua-api.factorio.com/latest/classes/LuaSpacePlatform.html)
- [defines.cargo_destination](https://lua-api.factorio.com/latest/defines.html#defines.cargo_destination)
- [defines.inventory.cargo_unit](https://lua-api.factorio.com/latest/defines.html#defines.inventory)
