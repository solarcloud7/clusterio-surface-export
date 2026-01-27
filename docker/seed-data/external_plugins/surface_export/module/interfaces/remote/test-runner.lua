-- Integration Test Runner
-- Reads test cases from JSON file and executes them
-- Returns structured results for external test harness

local json = require("modules/surface_export/core/json")
local test_import_entity = require("modules/surface_export/interfaces/remote/test-import-entity")

local TestRunner = {}

--- Run all tests from a JSON test suite
--- @param test_suite_json string: JSON string containing test suite
--- @param options table|nil: { category = "filter", test_id = "specific_test", verbose = false }
--- @return table: Results with passed, failed, skipped, details
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
  
  -- Parse test suite JSON
  local ok, test_suite = pcall(json.decode, test_suite_json)
  if not ok then
    table.insert(results.errors, "Failed to parse test suite JSON: " .. tostring(test_suite))
    return results
  end
  
  if not test_suite.tests or type(test_suite.tests) ~= "table" then
    table.insert(results.errors, "Test suite missing 'tests' array")
    return results
  end
  
  -- Position tracking
  local base_x = test_suite.basePosition and test_suite.basePosition.x or 100
  local base_y = test_suite.basePosition and test_suite.basePosition.y or 100
  local increment = test_suite.positionIncrement or 5
  local current_x = base_x
  local current_y = base_y
  
  -- Run each test
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
    
    -- Filter by category
    if options.category and test_case.category ~= options.category then
      test_result.status = "skipped"
      test_result.message = "Filtered by category"
      results.skipped = results.skipped + 1
      table.insert(results.details, test_result)
      goto continue
    end
    
    -- Filter by test_id
    if options.test_id and test_case.id ~= options.test_id then
      test_result.status = "skipped"
      test_result.message = "Filtered by test_id"
      results.skipped = results.skipped + 1
      table.insert(results.details, test_result)
      goto continue
    end
    
    -- Skip if marked skip
    if test_case.skip then
      test_result.status = "skipped"
      test_result.message = test_case.skip_reason or "Marked as skip"
      results.skipped = results.skipped + 1
      table.insert(results.details, test_result)
      goto continue
    end
    
    -- Prepare entity data with position
    local entity_data = test_case.input
    entity_data.position = { x = current_x, y = current_y }
    
    -- Run the test
    local run_ok, result = pcall(function()
      return test_import_entity(entity_data, nil, nil)
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
    
    -- Copy warnings
    test_result.warnings = result.warnings or {}
    test_result.mismatches = result.comparison_summary and result.comparison_summary.mismatches or 0
    
    -- Evaluate success
    local expect = test_case.expect or { success = true, max_mismatches = 0 }
    local passed = true
    local fail_reasons = {}
    
    -- Check entity creation success
    if expect.success and not result.success then
      passed = false
      table.insert(fail_reasons, "Entity creation failed")
      if result.errors then
        for _, err in ipairs(result.errors) do
          table.insert(fail_reasons, "  - " .. err)
        end
      end
    end
    
    -- Check mismatch count
    if passed and test_result.mismatches > (expect.max_mismatches or 0) then
      -- Check if mismatches are in allowed list
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
    
    -- Move to next position
    current_x = current_x + increment
    if current_x > 200 then
      current_x = base_x
      current_y = current_y + increment
    end
    
    ::continue::
  end
  
  return results
end

--- Format results as a simple string for RCON output
--- @param results table: Results from run_tests
--- @return string: Formatted results
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
