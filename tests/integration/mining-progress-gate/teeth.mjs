#!/usr/bin/env node
// requires: the cluster up with the fix deployed; run from the repo root
// produces: exit 0 only if the suite goes RED under a live rebind of service_pending_mining_progress to
//           drop-at-deadline (no dormancy) AND is GREEN again after the original is restored
// does not: touch source files — the mutant lives in package.loaded on host-2 for the duration of one
//           suite run and is restored in a finally

import { spawnSync } from "node:child_process";
import { lua, REPO_ROOT } from "../../lab-gallery/batch-lifecycle.mjs";

const HOST = 2;
const MODULE_KEY = "__level__/modules/surface_export/import_phases/active_state_restoration.lua";
const SUITE = "tests/integration/mining-progress-gate/run-tests.mjs";

const MUTANTS = {
	"drop-at-deadline": {
		expectRed: /the record for the DEACTIVATED drill was given up/,
		deadline: "",
	},
	"never-expire": {
		expectRed: /the record for the ACTIVE drill over bare foundation is still pending/,
		deadline: "\n      elseif true then\n"
			+ "        rec.expires_tick = game.tick + M.MINING_PROGRESS_BUDGET_TICKS\n"
			+ "        done = false",
	},
};
const mutantName = process.argv[2] ?? "drop-at-deadline";
const mutant = MUTANTS[mutantName];
if (!mutant) {
	console.error(`unknown mutant '${mutantName}'; known: ${Object.keys(MUTANTS).join(", ")}`);
	process.exit(2);
}

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
        done = false${mutant.deadline}
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
	const r = spawnSync(process.execPath, [SUITE], { cwd: REPO_ROOT, encoding: "utf8" });
	if (r.error) throw new Error(`could not spawn the suite: ${r.error.message}`);
	process.stdout.write(r.stdout ?? "");
	process.stderr.write(r.stderr ?? "");
	console.log(`##### ${label}: exit ${r.status}`);
	return { status: r.status, output: r.stdout ?? "" };
}

let mutantRun = null;
let restoredRun = null;
let armed = false;
try {
	const arm = lua(HOST, MUTANT);
	if (!arm || arm.success !== true || arm.rebound !== true) {
		throw new Error(`mutant did not arm: ${JSON.stringify(arm)}`);
	}
	armed = true;
	console.log(`mutant '${mutantName}' armed on service_pending_mining_progress`);
	mutantRun = runSuite(`MUTANT ${mutantName} (expect RED)`);
} finally {
	if (armed) {
		let restored = null;
		try {
			restored = lua(HOST, RESTORE);
		} catch (restoreErr) {
			console.error(`restore threw: ${restoreErr.message}`);
		}
		console.log(`restore: ${JSON.stringify(restored)}`);
		if (!restored || restored.success !== true) {
			console.error(`RESTORE FAILED — host-2 is still running mutant '${mutantName}' in package.loaded; `
				+ "redeploy Lua (deploy.ps1 -Scope lua) before trusting host-2");
			process.exit(2);
		}
		restoredRun = runSuite("RESTORED (expect GREEN)");
	}
}

const redForTheRightReason = mutantRun !== null && mutantRun.status !== 0 && mutant.expectRed.test(mutantRun.output);
const killed = redForTheRightReason && restoredRun.status === 0;
console.log(`\nteeth '${mutantName}': mutant exit=${mutantRun && mutantRun.status} `
	+ `red-for-the-right-reason=${redForTheRightReason} restored exit=${restoredRun.status} `
	+ `-> ${killed ? "KILLED" : "SURVIVED"}`);
process.exit(killed ? 0 : 1);
