#!/usr/bin/env node
// requires: the cluster up with the fix deployed; run from the repo root
// produces: exit 0 only if the suite goes RED under a live rebind of service_pending_mining_progress to
//           drop-at-deadline (no dormancy) AND is GREEN again after the original is restored
// does not: touch source files — the mutant lives in package.loaded on host-2 for the duration of one
//           suite run and is restored in a finally

import { spawnSync } from "node:child_process";
import { lua } from "../../lab-gallery/batch-lifecycle.mjs";

const HOST = 2;
const MODULE_KEY = "__level__/modules/surface_export/import_phases/active_state_restoration.lua";
const SUITE = "tests/integration/mining-progress-gate/run-tests.mjs";

const MUTANT = `local M = package.loaded['${MODULE_KEY}']
if type(M) ~= 'table' then return { success = false, error = 'module not loaded' } end
M._teeth_original = M._teeth_original or M.service_pending_mining_progress
M.service_pending_mining_progress = function()
  local pending = storage.pending_mining_progress
  if not pending or #pending == 0 then return end
  local keep = {}
  for _, rec in ipairs(pending) do
    local done = true
    if rec.entity and rec.entity.valid then
      local ok, bound = pcall(function() return rec.entity.mining_target ~= nil end)
      if ok and bound then
        for _, f in ipairs({ 'mining_progress', 'bonus_mining_progress' }) do
          if rec[f] then pcall(function() rec.entity[f] = rec[f] end) end
        end
      elseif game.tick < rec.expires_tick then
        done = false
      end
    end
    if not done then keep[#keep + 1] = rec end
  end
  storage.pending_mining_progress = (#keep > 0) and keep or nil
end
return { success = true, rebound = (M.service_pending_mining_progress ~= M._teeth_original) }`;

const RESTORE = `local M = package.loaded['${MODULE_KEY}']
if type(M) ~= 'table' or type(M._teeth_original) ~= 'function' then
  return { success = false, error = 'nothing to restore' }
end
M.service_pending_mining_progress = M._teeth_original
M._teeth_original = nil
return { success = true }`;

function runSuite(label) {
	console.log(`\n##### ${label}: ${SUITE}`);
	const r = spawnSync(process.execPath, [SUITE], { stdio: "inherit" });
	console.log(`##### ${label}: exit ${r.status}`);
	return r.status;
}

let mutantExit = null;
let restoredExit = null;
try {
	const armed = lua(HOST, MUTANT);
	if (!armed || armed.success !== true || armed.rebound !== true) {
		throw new Error(`mutant did not arm: ${JSON.stringify(armed)}`);
	}
	console.log("mutant armed: service_pending_mining_progress drops at deadline, no dormancy");
	mutantExit = runSuite("MUTANT (expect RED)");
} finally {
	const restored = lua(HOST, RESTORE);
	console.log(`restore: ${JSON.stringify(restored)}`);
	if (!restored || restored.success !== true) {
		console.error("RESTORE FAILED — redeploy Lua before trusting host-2");
		process.exit(2);
	}
	restoredExit = runSuite("RESTORED (expect GREEN)");
}

const killed = mutantExit !== 0 && restoredExit === 0;
console.log(`\nteeth: mutant exit=${mutantExit} restored exit=${restoredExit} -> ${killed ? "KILLED" : "SURVIVED"}`);
process.exit(killed ? 0 : 1);
