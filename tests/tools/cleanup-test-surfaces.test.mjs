import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import luaparse from "../../docker/seed-data/external_plugins/surface_export/scripts/vendor/luaparse.cjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..");
const sweeperPath = path.join(repoRoot, "tools", "tests", "cleanup-test-surfaces.ps1");
const selftestPath = path.join(repoRoot, "docker", "seed-data", "external_plugins", "surface_export",
	"module", "interfaces", "remote", "no-tick-sync-selftest.lua");

const sweeper = fs.readFileSync(sweeperPath, "utf8");
const selftest = fs.readFileSync(selftestPath, "utf8");

function defaultPrefixes() {
	const m = sweeper.match(/\$Prefixes\s*=\s*@\(([^)]*)\)/);
	assert.ok(m, "could not parse the default -Prefixes array out of cleanup-test-surfaces.ps1");
	return [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((q) => q[1].replace(/''/g, "'"));
}

function scratchSurfacePrefix() {
	const m = selftest.match(/^local LAB_PREFIX = "([^"]+)"$/m);
	assert.ok(m, "could not parse LAB_PREFIX out of no-tick-sync-selftest.lua");
	return m[1];
}

function plainSurfaceSweepLua({ dryRun }) {
	const deleteBranch = sweeper.match(/\$deleteLua = if \(\$DryRun\) \{ "" \} else \{ "((?:[^"\\]|\\.)*)" \}[\s\S]*?names=names\}\)\)"/);
	assert.ok(deleteBranch, "could not locate the plain-surface sweep block in cleanup-test-surfaces.ps1");
	const block = deleteBranch[0];
	const deleteStatement = dryRun ? "" : deleteBranch[1];

	const expression = block.slice(block.indexOf("$code ="));
	const marked = expression.replace(/^\s*\$deleteLua\s*\+\s*$/m, '"<<DELETE>>" +');
	assert.notEqual(marked, expression, "the sweep block no longer splices $deleteLua — the -DryRun path is unverified");

	const literals = [...marked.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((q) => q[1]);
	assert.ok(literals.length >= 4, `expected the sweep Lua to be built from several literals, parsed ${literals.length}`);

	return literals.join("")
		.replace("<<DELETE>>", deleteStatement)
		.replace("$prefixLua", "'lab-scratch-','other-'")
		.replace("$protectedLua", "['lab-transfer-fixture-v1']=true");
}

test("the selftest's scratch-surface prefix is one the sweeper actually sweeps", () => {
	const prefix = scratchSurfacePrefix();
	assert.ok(defaultPrefixes().includes(prefix),
		`no_tick_sync's scratch surfaces are named ${prefix}* but that prefix is not in the default ` +
		"-Prefixes of tools/tests/cleanup-test-surfaces.ps1 — a leak would be unsweepable");
});

test("the plain-surface sweep Lua parses, on both the sweep and the -DryRun path", () => {
	for (const dryRun of [false, true]) {
		const code = plainSurfaceSweepLua({ dryRun });
		luaparse.parse(code, { luaVersion: "5.2" });
	}
});

test("the plain-surface sweep never reaches a platform surface, a protected fixture, or an undeletable surface", () => {
	const code = plainSurfaceSweepLua({ dryRun: false });
	assert.match(code, /s\.platform == nil/,
		"without this filter the plain-surface pass would double-sweep platform surfaces the platform pass owns");
	assert.match(code, /not protected\[s\.name\]/, "protected fixtures must be excluded by name");
	assert.match(code, /s\.deletable/, "nauvis and any other undeletable surface must be excluded by the engine's own answer");
	assert.match(code, /s\.name:sub\(1, #prefix\) == prefix/, "only prefix-matched surfaces may be swept");
});

test("-DryRun sweeps nothing", () => {
	assert.doesNotMatch(plainSurfaceSweepLua({ dryRun: true }), /delete_surface/,
		"the audit mode must not delete");
	assert.match(plainSurfaceSweepLua({ dryRun: false }), /delete_surface/,
		"the sweep mode must delete — a sweeper that reports without removing is the leak it exists to fix");
});

test("the selftest deletes its scratch surface on the error path too, and demotes status on a leak", () => {
	const wrapper = selftest.slice(selftest.indexOf("local function no_tick_sync_selftest"));
	assert.ok(wrapper.length > 0, "could not locate the no_tick_sync_selftest wrapper");

	const pcallAt = wrapper.indexOf("pcall(run_lab");
	const cleanupAt = wrapper.indexOf("delete_scratch(surface");
	const errorReturnAt = wrapper.indexOf("if not ok then");
	assert.ok(pcallAt !== -1 && cleanupAt !== -1 && errorReturnAt !== -1,
		"the wrapper must run the lab under pcall and clean up through delete_scratch");
	assert.ok(cleanupAt > pcallAt && cleanupAt < errorReturnAt,
		"delete_scratch must run after the lab and before the error return, so a throw cannot skip it");

	assert.match(wrapper, /result\.status = "leaked"/,
		"a leak must demote status — the batch runner reads only status, so a leak reported beside a " +
		"passed status is a vacuous green");
});
