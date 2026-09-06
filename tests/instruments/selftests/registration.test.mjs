import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..", "..");
const remoteInterface = path.join(repoRoot, "docker", "seed-data", "external_plugins",
	"surface_export", "module", "interfaces", "remote-interface.lua");

const DEDICATED_RUNNERS = {
	// Needs two RCON callbacks and raw profiler log parsing; the generic single-call runner cannot verify waits.
	timing: path.join(repoRoot, "tools", "surface-export", "probe-timing.mjs"),
	fluid_segment_law: path.join(repoRoot, "tests", "instruments", "fluid-segment-law", "run-tests.mjs"),
	pole_copper_prune: path.join(repoRoot, "tests", "instruments", "pole-copper-prune", "run-tests.mjs"),
};

function registeredSelftests() {
	const src = fs.readFileSync(remoteInterface, "utf8");
	const names = new Set();
	for (const m of src.matchAll(/^\s{2,}(\w+)_selftest\s*=\s*\w+_selftest,\s*$/gm)) {
		names.add(m[1]);
	}
	return names;
}

test("the selftests instrument runs every self-test the remote interface exposes", () => {
	const registered = registeredSelftests();
	assert.ok(registered.size >= 8,
		`expected the remote interface to expose at least 8 self-tests, parsed ${registered.size} — ` +
		"if this dropped, the registration format changed and this test is no longer reading the " +
		"emitter it claims to read");

	const instrument = fs.readFileSync(path.join(here, "run-tests.mjs"), "utf8");
	const listed = new Set(
		[...instrument.matchAll(/^\t"(\w+)",$/gm)].map(m => m[1]));
	assert.ok(listed.size > 0, "failed to parse the instrument's SELFTESTS list");

	const missing = [...registered].filter(n => !listed.has(n) && !(n in DEDICATED_RUNNERS));
	assert.deepEqual(missing, [],
		`these self-tests are registered on the remote interface but run NOWHERE: ${missing.join(", ")}. ` +
		"Add them to SELFTESTS in tests/instruments/selftests/run-tests.mjs, or give them a dedicated " +
		"runner and record it in DEDICATED_RUNNERS with the reason.");

	const stale = [...listed].filter(n => !registered.has(n));
	assert.deepEqual(stale, [],
		`the instrument lists self-tests the remote interface does not expose: ${stale.join(", ")}. ` +
		"remote.call would fail on these — the batch reports them as errors rather than skipping, but " +
		"a stale name is still a lie about what is covered.");
});

test("every dedicated-runner exclusion points at a runner that exists", () => {
	for (const [name, runner] of Object.entries(DEDICATED_RUNNERS)) {
		assert.ok(fs.existsSync(runner),
			`${name} is excluded from the batch runner because it has its own driver, but that driver ` +
			`is not at ${runner} — the exclusion is now a hole, which is precisely the rot this file exists to stop`);
	}
});

test("the instrument itself has a standing caller in the integration suite", () => {
	const shim = path.join(repoRoot, "tests", "integration", "selftests", "run-tests.mjs");
	assert.ok(fs.existsSync(shim),
		"tests/integration/selftests/run-tests.mjs must exist so the integration suite runs the batch");
	const src = fs.readFileSync(shim, "utf8");
	assert.match(src, /"instruments",\s*"selftests"/,
		"the shim must spawn the selftests instrument");
	assert.match(src, /process\.exit\(result\.status \?\? 1\)/,
		"the shim must propagate the instrument's exit status — a shim that always exits 0 turns the " +
		"standing invocation into a standing green light");
});
