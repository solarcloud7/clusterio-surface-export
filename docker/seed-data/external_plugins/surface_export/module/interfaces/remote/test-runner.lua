local json = require("modules/surface_export/core/json")
local test_import_entity = require("modules/surface_export/interfaces/remote/test-import-entity")

local TestRunner = {}

function TestRunner.run_tests(test_suite_json, options)
  options = options or {}
  
  local results = {
    passed = 0,
    failed = 0,
    skipped = 0,
    total = 0,
    details = {},
    errors = {}
  }
  
  local ok, test_suite = pcall(json.decode, test_suite_json)
  if not ok then
    table.insert(results.errors, "Failed to parse test suite JSON: " .. tostring(test_suite))
    return results
  end
  
  if not test_suite.tests or type(test_suite.tests) ~= "table" then
    table.insert(results.errors, "Test suite missing 'tests' array")
    return results
  end
  
  local base_x = test_suite.basePosition and test_suite.basePosition.x or 100
  local base_y = test_suite.basePosition and test_suite.basePosition.y or 100
  local increment = test_suite.positionIncrement or 5
  local current_x = base_x
  local current_y = base_y

  local test_surface
  if test_suite.testPlatform then
    for _, s in pairs(game.surfaces) do
      if s.platform and s.platform.name == test_suite.testPlatform then test_surface = s break end
    end
  end
  if not test_surface then
    local p1 = game.get_player(1)
    test_surface = (p1 and p1.surface) or game.surfaces[1]
  end
  local target_surface_index = test_surface.index
  local anchor = { x = base_x, y = base_y }
  if test_surface.platform and test_surface.platform.hub and test_surface.platform.hub.valid then
    anchor = test_surface.platform.hub.position
  end
  
  for _, test_case in ipairs(test_suite.tests) do
    results.total = results.total + 1
    
    local test_result = {
      id = test_case.id,
      name = test_case.name,
      category = test_case.category,
      status = "pending",
      message = "",
      mismatches = 0,
      warnings = {}
    }
    
    if options.category and test_case.category ~= options.category then
      test_result.status = "skipped"
      test_result.message = "Filtered by category"
      results.skipped = results.skipped + 1
      table.insert(results.details, test_result)
      goto continue
    end
    
    if options.test_id and test_case.id ~= options.test_id then
      test_result.status = "skipped"
      test_result.message = "Filtered by test_id"
      results.skipped = results.skipped + 1
      table.insert(results.details, test_result)
      goto continue
    end
    
    if test_case.skip then
      test_result.status = "skipped"
      test_result.message = test_case.skip_reason or "Marked as skip"
      results.skipped = results.skipped + 1
      table.insert(results.details, test_result)
      goto continue
    end
    
    local entity_data = test_case.input
    local placed = nil
    if test_surface and entity_data.name and prototypes.entity[entity_data.name] then
      placed = test_surface.find_non_colliding_position(entity_data.name, anchor, 128, 1)
    end
    entity_data.position = placed or { x = anchor.x + (current_x - base_x), y = anchor.y + (current_y - base_y) }

    local run_ok, result = pcall(function()
      return test_import_entity(entity_data, target_surface_index, nil)
    end)
    
    if not run_ok then
      test_result.status = "error"
      test_result.message = "Test threw error: " .. tostring(result)
      results.failed = results.failed + 1
      table.insert(results.details, test_result)
      goto continue
    end
    
    if not result then
      test_result.status = "error"
      test_result.message = "test_import_entity returned nil"
      results.failed = results.failed + 1
      table.insert(results.details, test_result)
      goto continue
    end
    
    test_result.warnings = result.warnings or {}
    test_result.mismatches = result.comparison_summary and result.comparison_summary.mismatches or 0
    test_result.fluid_verification = result.fluid_verification
    
    local expect = test_case.expect or { success = true, max_mismatches = 0 }
    local passed = true
    local fail_reasons = {}
    
    if expect.success == false then
      if result.success then
        passed = false
        table.insert(fail_reasons, "Expected entity creation to FAIL, but it succeeded")
      elseif expect.errorContains then
        local matched = false
        for _, err in ipairs(result.errors or {}) do
          if string.find(err, expect.errorContains, 1, true) then matched = true break end
        end
        if not matched then
          passed = false
          table.insert(fail_reasons, "Expected an error containing '" .. expect.errorContains ..
            "', got: " .. table.concat(result.errors or {}, " | "))
        end
      end
    elseif expect.success and not result.success then
      passed = false
      table.insert(fail_reasons, "Entity creation failed")
      if result.errors then
        for _, err in ipairs(result.errors) do
          table.insert(fail_reasons, "  - " .. err)
        end
      end
    end
    
    if passed and expect.verifyFluids and result.fluid_verification then
      local fv = result.fluid_verification
      if expect.fluidWriteRejected then
        if fv.write_rejected <= 0 then
          passed = false
          table.insert(fail_reasons, "Expected fluid write rejection but none occurred")
        end
      else
        if not fv.passed then
          passed = false
          table.insert(fail_reasons, string.format(
            "Fluid verification failed: expected %.1f, got %.1f (write_rejected=%.1f)",
            fv.expected or 0, fv.actual or 0, fv.write_rejected or 0))
        end
        if fv.write_rejected and fv.write_rejected > 0 then
          passed = false
          table.insert(fail_reasons, string.format(
            "Unexpected fluid write rejection: %.1f units rejected by engine",
            fv.write_rejected))
        end
      end
    end

    if passed and test_result.mismatches > (expect.max_mismatches or 0) then
      local allowed = expect.allowed_mismatches or {}
      local all_allowed = true
      
      for _, warning in ipairs(test_result.warnings) do
        local field = string.match(warning, "Roundtrip mismatch for '([^']+)'")
        if field then
          local is_allowed = false
          for _, allowed_field in ipairs(allowed) do
            if field == allowed_field then
              is_allowed = true
              break
            end
          end
          if not is_allowed then
            all_allowed = false
            break
          end
        end
      end
      
      if not all_allowed then
        passed = false
        table.insert(fail_reasons, string.format("Too many mismatches: %d (max: %d)", 
          test_result.mismatches, expect.max_mismatches or 0))
        for _, warning in ipairs(test_result.warnings) do
          if string.find(warning, "Roundtrip mismatch") then
            table.insert(fail_reasons, warning)
          end
        end
      end
    end
    
    if passed then
      test_result.status = "passed"
      test_result.message = "OK"
      results.passed = results.passed + 1
    else
      test_result.status = "failed"
      test_result.message = table.concat(fail_reasons, "; ")
      results.failed = results.failed + 1
    end
    
    table.insert(results.details, test_result)
    
    current_x = current_x + increment
    if current_x > 200 then
      current_x = base_x
      current_y = current_y + increment
    end
    
    ::continue::
  end
  
  return results
end

function TestRunner.format_results(results)
  local lines = {}
  
  table.insert(lines, "")
  table.insert(lines, "═══════════════════════════════════════")
  table.insert(lines, "  Integration Test Results")
  table.insert(lines, "═══════════════════════════════════════")
  table.insert(lines, "")
  
  for _, detail in ipairs(results.details) do
    local icon = "?"
    if detail.status == "passed" then
      icon = "✓"
    elseif detail.status == "failed" then
      icon = "✗"
    elseif detail.status == "skipped" then
      icon = "○"
    elseif detail.status == "error" then
      icon = "!"
    end
    
    table.insert(lines, string.format("  %s %s: %s", icon, detail.id, detail.name))
    
    if detail.status == "failed" or detail.status == "error" then
      table.insert(lines, "      " .. detail.message)
    end
  end
  
  table.insert(lines, "")
  table.insert(lines, "═══════════════════════════════════════")
  table.insert(lines, string.format("  Passed: %d | Failed: %d | Skipped: %d", 
    results.passed, results.failed, results.skipped))
  table.insert(lines, "═══════════════════════════════════════")
  
  return table.concat(lines, "\n")
end

return TestRunner
