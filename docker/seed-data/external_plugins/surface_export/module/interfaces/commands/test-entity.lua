-- Command: /test-entity
-- Test importing a single entity from JSON for debugging

local Base = require("modules/surface_export/interfaces/commands/base")

Base.admin_command("test-entity",
  "Test import a single entity from JSON. Usage: /test-entity <json> OR /test-entity file:<filename>",
  function(cmd, ctx)
    local param = ctx.param
    
    if not param or param == "" then
      ctx.print("Usage: /test-entity <json>")
      ctx.print("       /test-entity file:<filename>")
      ctx.print("")
      ctx.print("Examples:")
      ctx.print('  /test-entity {"name":"iron-chest","position":{"x":0,"y":0}}')
      ctx.print("  /test-entity file:test_entity.json")
      ctx.print("")
      ctx.print("The entity will be created on your current surface at the specified position.")
      ctx.print("Use position override: /test-entity-at <x> <y> <json>")
      return
    end
    
    local entity_json
    
    -- Check if loading from file
    if param:sub(1, 5) == "file:" then
      local filename = param:sub(6)
      ctx.print("Loading entity from file: " .. filename)
      
      -- Try to read via remote interface (file reading is limited in Factorio)
      ctx.print("Note: File reading requires the data to be passed via RCON or remote interface")
      ctx.print("Use: remote.call('surface_export', 'test_import_entity', <json_string>)")
      return
    else
      entity_json = param
    end
    
    -- Get player's surface
    local surface_index = ctx.player and ctx.player.surface.index or 1
    
    -- Call the remote interface
    local result = remote.call("surface_export", "test_import_entity", entity_json, surface_index, nil)
    
    if not result then
      ctx.print("Error: test_import_entity returned nil")
      return
    end
    
    -- Print results
    ctx.print("═══════════════════════════════════════")
    ctx.print("🧪 Entity Test Result")
    ctx.print("═══════════════════════════════════════")
    
    if result.success then
      ctx.print("✓ SUCCESS - Entity created!")
      ctx.print("")
      ctx.print("Created Entity:")
      ctx.print("  Name: " .. (result.debug_info.entity_name or "?"))
      ctx.print("  Position: " .. serpent.line(result.debug_info.created_position or "?"))
      ctx.print("  Unit Number: " .. tostring(result.debug_info.created_unit_number or "?"))
      if result.debug_info.created_direction then
        ctx.print("  Direction: " .. result.debug_info.created_direction)
      end
    else
      ctx.print("✗ FAILED - Entity not created")
    end
    
    -- Print errors
    if result.errors and #result.errors > 0 then
      ctx.print("")
      ctx.print("Errors:")
      for _, err in ipairs(result.errors) do
        ctx.print("  ✗ " .. err)
      end
    end
    
    -- Print warnings
    if result.warnings and #result.warnings > 0 then
      ctx.print("")
      ctx.print("Warnings:")
      for _, warn in ipairs(result.warnings) do
        ctx.print("  ⚠ " .. warn)
      end
    end
    
    -- Print debug info
    if result.debug_info then
      ctx.print("")
      ctx.print("Debug Info:")
      ctx.print("  Surface: " .. (result.debug_info.surface_name or "?") .. " (index " .. tostring(result.debug_info.surface_index or "?") .. ")")
      ctx.print("  Target Position: " .. serpent.line(result.debug_info.target_position or "?"))
      if result.debug_info.prototype_type then
        ctx.print("  Prototype Type: " .. result.debug_info.prototype_type)
      end
      if result.debug_info.can_place_entity ~= nil then
        ctx.print("  Can Place: " .. tostring(result.debug_info.can_place_entity))
      end
      if result.debug_info.existing_entities then
        ctx.print("  Existing nearby: " .. table.concat(result.debug_info.existing_entities, ", "))
      end
    end
    
    ctx.print("═══════════════════════════════════════")
  end
)

-- Also add a variant that allows position override
Base.admin_command("test-entity-at",
  "Test import entity at specific position. Usage: /test-entity-at <x> <y> <json>",
  function(cmd, ctx)
    local params = Base.parse_params(ctx.param)
    
    if #params < 3 then
      ctx.print("Usage: /test-entity-at <x> <y> <json>")
      ctx.print("Example: /test-entity-at 5 -3 {\"name\":\"iron-chest\"}")
      return
    end
    
    local x = tonumber(params[1])
    local y = tonumber(params[2])
    
    if not x or not y then
      ctx.print("Error: x and y must be numbers")
      return
    end
    
    -- Reconstruct JSON from remaining params (in case it had spaces)
    local json_parts = {}
    for i = 3, #params do
      table.insert(json_parts, params[i])
    end
    local entity_json = table.concat(json_parts, " ")
    
    local surface_index = ctx.player and ctx.player.surface.index or 1
    local position_override = {x = x, y = y}
    
    local result = remote.call("surface_export", "test_import_entity", entity_json, surface_index, position_override)
    
    if not result then
      ctx.print("Error: test_import_entity returned nil")
      return
    end
    
    -- Print condensed results
    if result.success then
      ctx.print(string.format("✓ Created %s at {%g, %g}", 
        result.debug_info.entity_name or "entity",
        result.debug_info.created_position.x,
        result.debug_info.created_position.y))
    else
      ctx.print("✗ Failed to create entity")
      for _, err in ipairs(result.errors or {}) do
        ctx.print("  " .. err)
      end
    end
    
    for _, warn in ipairs(result.warnings or {}) do
      ctx.print("  ⚠ " .. warn)
    end
  end
)
