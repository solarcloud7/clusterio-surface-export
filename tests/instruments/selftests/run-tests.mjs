#!/usr/bin/env node
// selftests — every in-module self-test, in ONE RCON call.
//
// These pin PURE logic (a decision function, a filter, a lock sweep, a version seam) against
// injected/fake inputs. They need the Factorio Lua runtime because `require` does not resolve from
// the /sc sandbox — but they need NO world, NO platform and NO transfer. They are unit tests that
// happen to live inside the engine.
//
// They used to be five near-identical PowerShell drivers (~250 lines total), each spawning its own
// pwsh, each doing exactly: one RCON call -> parse JSON -> report. Two more self-tests were
// registered in the remote interface and run by NOTHING — hold_aware_unlock (26 assertions) was
// dead coverage until this file picked it up.
//
// fluid-segment-law is deliberately NOT here: it builds and tears down its own scratch platform and
// is the fluid-law re-certification instrument, so it keeps its own driver and lifecycle.
//
// Usage:
//   node tests/instruments/selftests/run-tests.mjs
//   node tests/instruments/selftests/run-tests.mjs --instance <name>   (or env SE_LAB_INSTANCE)

import { execFileSync } from "node:child_process";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";

// Every self-test registered on the remote interface except fluid_segment_law (see header).
const SELFTESTS = [
	"version",
	"belt_side_restore",
	"gateway",
	"schedule",
	"transfer_lock",
	"no_tick_sync",
	"hold_aware_unlock",
];

const instanceArg = process.argv.indexOf("--instance");
const INSTANCE = instanceArg !== -1 ? process.argv[instanceArg + 1]
	: (process.env.SE_LAB_INSTANCE || "clusterio-host-1-instance-1");
if (!INSTANCE) throw new Error("--instance needs a value");

function rcon(command) {
	return execFileSync("docker", ["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", INSTANCE, command, "--config", CTL_CONFIG],
	{ encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }).trim();
}

// ONE call runs all of them. Only FAILING detail rows come back — a passing run returns counts, so
// the payload stays small regardless of how many assertions there are (95 at time of writing).
// Each self-test is pcall'd individually: one that throws is reported as a failure rather than
// taking the whole batch down with it.
const LUA = `/sc local names = {${SELFTESTS.map(n => `"${n}"`).join(",")}}
local out = {}
for _, name in ipairs(names) do
  local ok, r = pcall(function() return remote.call("surface_export", name .. "_selftest") end)
  if not ok then
    out[#out+1] = { name = name, errored = true, msg = tostring(r), passed = 0, failed = 1, total = 1 }
  elseif type(r) ~= "table" then
    out[#out+1] = { name = name, errored = true, msg = "non-table result: " .. tostring(r), passed = 0, failed = 1, total = 1 }
  else
    local passed, failed, total = r.passed, r.failed, r.total
    local fails = {}
    for _, d in ipairs(r.details or {}) do
      if not d.ok then fails[#fails+1] = { name = d.name, msg = d.msg } end
    end
    -- SHAPE HANDLING, fail-closed. Most self-tests return {passed,failed,total,details}. no_tick_sync
    -- returns {status="passed"|"unconstructible"} with no counts. An unrecognized shape must NOT
    -- become "0/0 PASS" — a vacuous pass is worse than no test, so it is reported as a FAILURE.
    if passed == nil or total == nil then
      if r.status ~= nil then
        local good = (r.status == "passed")
        out[#out+1] = { name = name, passed = good and 1 or 0, failed = good and 0 or 1, total = 1,
                        failures = good and {} or { { name = "status", msg = tostring(r.status) .. " " .. tostring(r.reason or "") } } }
        goto continue
      end
      local p, f = 0, 0
      for _, d in ipairs(r.details or {}) do if d.ok then p = p + 1 else f = f + 1 end end
      if p + f == 0 then
        out[#out+1] = { name = name, errored = true, passed = 0, failed = 1, total = 1,
                        msg = "self-test reported NO assertions and no status — refusing to call that a pass" }
        goto continue
      end
      passed, failed, total = p, f, p + f
    end
    out[#out+1] = { name = name, passed = passed, failed = failed or 0, total = total, failures = fails }
  end
  ::continue::
end
rcon.print(helpers.table_to_json({ ok = true, results = out }))`;

function main() {
	console.log(`selftests: running ${SELFTESTS.length} in-module self-tests on ${INSTANCE} in one call ...`);
	const raw = rcon(LUA).split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) || "";
	let parsed;
	try { parsed = JSON.parse(raw); }
	catch (error) { throw new Error(`Invalid JSON from ${INSTANCE}: ${raw}\n${error.message}`); }

	const results = parsed.results || [];
	if (results.length !== SELFTESTS.length) {
		console.error(`  expected ${SELFTESTS.length} results, got ${results.length} — a self-test did not report`);
	}

	let totalPassed = 0, totalFailed = 0, badSuites = 0;
	for (const r of results) {
		totalPassed += r.passed || 0;
		totalFailed += r.failed || 0;
		const bad = (r.failed || 0) > 0 || r.errored;
		if (bad) badSuites++;
		console.log(`  ${bad ? "FAIL" : "PASS"}  ${r.name}: ${r.passed || 0}/${r.total || 0}` +
			(r.errored ? `  ERRORED: ${r.msg}` : ""));
		// An EMPTY Lua table serializes to `{}` (object), not `[]` — the numeric-key coercion that
		// bites every Lua->JSON boundary in this repo. Normalize before iterating.
		const failures = Array.isArray(r.failures) ? r.failures : Object.values(r.failures || {});
		for (const f of failures) console.log(`          - ${f.name}: ${f.msg}`);
	}

	const ok = badSuites === 0 && totalFailed === 0 && results.length === SELFTESTS.length;
	console.log(`\n=== selftests: ${ok ? "ALL PASS" : "FAIL"} ` +
		`(${totalPassed} assertions across ${results.length} self-tests, ${totalFailed} failed) ===`);
	process.exit(ok ? 0 : 1);
}

main();
