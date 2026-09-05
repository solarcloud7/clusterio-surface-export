#!/usr/bin/env node
// requires: an idle local cluster; the production configure and reapply remotes
// produces: physical lock checks for missing/empty/hub/multi active lists and repeat calls
// does not: retain configuration or unlock changes; each force's exact original state is restored
import assert from "node:assert/strict";
import { lua, preflightState, assertLeaseClean } from "../../lab-gallery/batch-lifecycle.mjs";

const HOST = 1;
assertLeaseClean(HOST, preflightState(HOST), "gateway-lock-state");
const result = lua(HOST, `
local original_config = storage.surface_export_config
local gates, before = {}, {}
for name in pairs(prototypes.space_location) do
  if string.sub(name, 1, 16) == 'surfexp_gateway_' then gates[#gates + 1] = name end
end
table.sort(gates)
if #gates ~= 5 then return {success=false, error='expected five gateway prototypes'} end
for name, force in pairs(game.forces) do
  before[name] = {}
  for _, gate in ipairs(gates) do before[name][gate] = force.is_space_location_unlocked(gate) end
end
local checks = {}
local ok, err = pcall(function()
  -- A private config table prevents configure() from mutating the original table by reference.
  storage.surface_export_config = {}
  for key, value in pairs(original_config or {}) do storage.surface_export_config[key] = value end
  local cases = {
    {name='missing', all=true},
    {name='empty', names={}},
    {name='hub', names={'surfexp_gateway_hub'}},
    {name='multi', names={'surfexp_gateway_1','surfexp_gateway_2','surfexp_gateway_3','surfexp_gateway_4'}},
  }
  for _, case in ipairs(cases) do
    if case.all then storage.surface_export_config.active_gateways = nil
    else
      local json = case.name == 'empty' and '[]' or helpers.table_to_json(case.names)
      remote.call('surface_export', 'configure', {active_gateways_json=json})
    end
    if ${process.argv.includes("--fail-after-config")} then error('injected failure after configuration') end
    local wanted = {}
    for _, name in ipairs(case.names or {}) do wanted[name] = true end
    for repetition=0,2 do
      if case.all or repetition > 0 then remote.call('surface_export','reapply_gateway_locks') end
      for _, force in pairs(game.forces) do
        for _, gate in ipairs(gates) do
          local expected = case.all == true or wanted[gate] == true
          assert(force.is_space_location_unlocked(gate) == expected,
            case.name .. ': wrong physical lock for ' .. gate .. ' on ' .. force.name)
        end
      end
    end
    checks[#checks + 1] = case.name
  end
end)
storage.surface_export_config = original_config
local cleanup_errors = {}
for name, states in pairs(before) do
  local force = game.forces[name]
  for gate, unlocked in pairs(states) do
    local restored, restore_err = pcall(function()
      if unlocked then force.unlock_space_location(gate) else force.lock_space_location(gate) end
      assert(force.is_space_location_unlocked(gate) == unlocked, 'lock readback differs')
    end)
    if not restored then cleanup_errors[#cleanup_errors + 1] = name .. '/' .. gate .. ': ' .. tostring(restore_err) end
  end
end
return {success=ok, error=not ok and tostring(err) or nil, checks=checks,
  restored=(#cleanup_errors == 0 and storage.surface_export_config == original_config),
  cleanup_errors=cleanup_errors, engine=script.active_mods.base}
`);
console.log(JSON.stringify(result));
assert.equal(result.restored, true, "gateway cleanup failed");
assert.equal(result.success, true, result.error);
console.log("gateway-lock-state: ALL PASS");
