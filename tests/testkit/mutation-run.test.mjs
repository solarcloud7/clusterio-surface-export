import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	SUITES, checkoutFacts, laneRefusal, idleRefusal, readOutcome, combineVerdict, formatVerdict, mutationRun,
} from "../../tools/tests/testkit/mutation-run.mjs";

const MAIN = path.resolve("/repo");
const TARGET = path.resolve("/repo/tools/tests/testkit/mutation-run.mjs");

function outcome(suite, failed, names = []) {
	return { suite, failed, names };
}

function tempDir(t, prefix) {
	const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
	assert.ok(root.startsWith(realpathSync.native(tmpdir()) + path.sep));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
	return root;
}

function quietly(action) {
	const lines = [];
	const realLog = console.log;
	const realError = console.error;
	console.log = (...args) => lines.push(args.join(" "));
	console.error = (...args) => lines.push(args.join(" "));
	try {
		return { value: action(), lines };
	} finally {
		console.log = realLog;
		console.error = realError;
	}
}

test("both unit packages CI runs are in the suite table, and the repo-root one is not the container's", () => {
	assert.equal(SUITES.length, 2, "a mutation verdict drawn from one package is the whole defect");

	const plugin = SUITES.find(suite => suite.command === "docker");
	assert.ok(plugin, "the plugin package runs inside surface-export-host-1");
	assert.match(plugin.args.join(" "), /surface-export-host-1/);
	assert.match(plugin.args.join(" "), /external_plugins\/surface_export && npm test/);

	const root = SUITES.find(suite => suite !== plugin);
	assert.deepEqual(root.args, ["--test", "--test-reporter=spec", "tests/**/*.test.mjs"],
		"the glob is CI's — `node --test tests/` also runs non-test data modules");
	assert.match(root.name, /repo-root/);
});

test("THE measured defect: a kill in the repo-root package alone is a KILL", () => {
	const verdict = combineVerdict([
		outcome("plugin", 0),
		outcome("repo-root", 2, ["the guard refuses a worktree", "the guard names the tree"]),
	]);
	assert.equal(verdict.killed, true, "a guard with repo-root teeth reported SURVIVED — that is the bug");
	assert.equal(verdict.failed, 2);
	assert.match(formatVerdict(verdict), /the guard refuses a worktree/);
});

test("a kill in the plugin package alone is still a KILL", () => {
	const verdict = combineVerdict([outcome("plugin", 1, ["wire contract"]), outcome("repo-root", 0)]);
	assert.equal(verdict.killed, true);
});

test("SURVIVED requires BOTH packages green", () => {
	const verdict = combineVerdict([outcome("plugin", 0), outcome("repo-root", 0)]);
	assert.equal(verdict.killed, false);
	assert.equal(verdict.failed, 0);
});

test("both verdicts name every package exercised, and disclaim the ones that were not", () => {
	const survived = formatVerdict(combineVerdict([outcome("plugin-pkg", 0), outcome("root-pkg", 0)]));
	assert.match(survived, /MUTATION SURVIVED/);
	assert.match(survived, /suites exercised/);
	assert.match(survived, /plugin-pkg/);
	assert.match(survived, /root-pkg/);
	assert.match(survived, /integration suite and lint guards NOT run/,
		"an unscoped SURVIVED reads as 'nothing covers this' — the false-verdict class in a new costume");

	const killed = formatVerdict(combineVerdict([outcome("plugin-pkg", 1, ["x"]), outcome("root-pkg", 0)]));
	assert.match(killed, /MUTATION KILLED/);
	assert.match(killed, /plugin-pkg/);
	assert.match(killed, /root-pkg/);
});

test("a linked worktree is refused, and the refusal names the tree the suite actually loads", () => {
	const message = laneRefusal({
		invocationRoot: path.resolve("/repo/.claude/worktrees/agent-1"),
		mainRoot: MAIN,
		targetPath: path.resolve("/repo/.claude/worktrees/agent-1/lib/thing.ts"),
	});
	assert.ok(message, "mutating a worktree while the container tests the main tree is a guaranteed SURVIVED");
	assert.match(message, /main working tree/);
	assert.match(message, /agent-1/, "a refusal that does not show WHERE you are costs another lookup");
	assert.match(message, /surface-export-host-1/);
	assert.match(message, /bind-mounted/);
	assert.match(message, /false MUTATION SURVIVED/);
});

test("the main working tree passes the lane check", () => {
	assert.equal(laneRefusal({ invocationRoot: MAIN, mainRoot: MAIN, targetPath: TARGET }), null);
});

test("a target outside the main working tree is refused even from inside it", () => {
	const message = laneRefusal({
		invocationRoot: MAIN,
		mainRoot: MAIN,
		targetPath: path.resolve("/elsewhere/clone/lib/thing.ts"),
	});
	assert.match(message, /outside the main working tree/);
});

test("module/ Lua is still refused", () => {
	const message = laneRefusal({
		invocationRoot: MAIN,
		mainRoot: MAIN,
		targetPath: path.resolve("/repo/docker/seed-data/external_plugins/surface_export/module/core/gateway.lua"),
	});
	assert.match(message, /package\.loaded rebind/);
});

test("the lane comparison is case-insensitive on Windows", { skip: process.platform !== "win32" }, () => {
	assert.equal(laneRefusal({
		invocationRoot: "C:\\Repo\\FactorioSurfaceExport",
		mainRoot: "c:\\repo\\factoriosurfaceexport",
		targetPath: "C:\\Repo\\FactorioSurfaceExport\\lib\\thing.ts",
	}), null, "a drive-letter case difference is not a different checkout");
});

test("a leftover sidecar refuses BEFORE the dirty check — it is the more actionable one", () => {
	const message = idleRefusal({
		sidecarPath: "/repo/lib/thing.ts.mutation-backup",
		sidecarExists: true,
		dirtyEntries: ["?? lib/thing.ts.mutation-backup", " M lib/thing.ts"],
	});
	assert.match(message, /died before restoring/);
	assert.doesNotMatch(message, /not idle/, "the sidecar IS the dirt — reporting it as generic dirt hides the fix");
});

test("an uncommitted change refuses, lists the paths, and says why the measurement would be confounded", () => {
	const message = idleRefusal({
		sidecarPath: "/repo/lib/thing.ts.mutation-backup",
		sidecarExists: false,
		dirtyEntries: [" M lib/other.ts", "?? scratch.mjs"],
	});
	assert.match(message, /not idle/);
	assert.match(message, /2 uncommitted change/);
	assert.match(message, /lib\/other\.ts/);
	assert.match(message, /scratch\.mjs/);
	assert.match(message, /confounded/);
	assert.match(message, /Commit or stash/);
});

test("a long dirty list is truncated with a count, not dumped", () => {
	const entries = Array.from({ length: 30 }, (_, index) => ` M lib/file-${index}.ts`);
	const message = idleRefusal({ sidecarPath: "/x.mutation-backup", sidecarExists: false, dirtyEntries: entries });
	assert.match(message, /30 uncommitted change/);
	assert.match(message, /and 18 more/);
});

test("an idle tree with no sidecar passes", () => {
	assert.equal(idleRefusal({ sidecarPath: "/x.mutation-backup", sidecarExists: false, dirtyEntries: [] }), null);
});

test("readOutcome reads the fail count and the dead test names, and refuses to guess at unparseable output", () => {
	const parsed = readOutcome("pkg", ["✔ this one lives (1.1ms)", "✖ this one dies (2.2ms)", "ℹ pass 1", "ℹ fail 1",
		"✖ failing tests:", "✖ this one dies (2.2ms)"].join("\n"));
	assert.equal(parsed.failed, 1);
	assert.deepEqual(parsed.names, ["this one dies"], "the summary repeat must not double-count");
	assert.equal(parsed.suite, "pkg");

	assert.equal(readOutcome("pkg", "ℹ fail 0").failed, 0);
	assert.throws(() => readOutcome("pkg", "docker: no such container"), /could not read a fail count from the pkg/,
		"a suite that never ran must not read as a suite that passed");
});

const ORIGINAL = "export const limit = 5;\n";

function ritualFixture(t, prefix, rootPackageFailsWhenMutated = true) {
	const root = tempDir(t, prefix);
	const target = path.join(root, "guard.mjs");
	writeFileSync(target, ORIGINAL);

	const seen = [];
	const builds = [];
	const hooks = {
		checkoutFacts: () => ({ invocationRoot: root, mainRoot: root }),
		workingTreeChanges: () => [],
		buildNode: cwd => { builds.push(cwd); assert.equal(path.resolve(cwd), root, "a build targets the mutated tree"); },
		runSuites: cwd => {
			assert.equal(path.resolve(cwd), root, "a suite run must target the mutated tree");
			seen.push(readFileSync(target, "utf8"));
			const mutantIsInPlace = seen.at(-1) !== ORIGINAL;
			const rootFails = mutantIsInPlace && rootPackageFailsWhenMutated;
			return [
				outcome("plugin-pkg", 0),
				outcome("root-pkg", rootFails ? 1 : 0, rootFails ? ["the guard's own test"] : []),
			];
		},
	};
	return { root, target, seen, builds, hooks };
}

test("the ritual runs BOTH packages against the mutant, restores the file, and re-checks BOTH", t => {
	const { root, target, seen, builds, hooks } = ritualFixture(t, "mutation-run-e2e-");
	const original = ORIGINAL;

	const { value: killed, lines } = quietly(() => mutationRun(
		{ file: "guard.mjs", find: "limit = 5", replace: "limit = 500", cwd: root }, hooks));

	assert.equal(killed, true, "only the repo-root package had teeth — that must still be a KILL");
	assert.equal(seen.length, 2, "one run against the mutant, one to verify the restore");
	assert.match(seen[0], /limit = 500/);
	assert.equal(seen[1], original);
	assert.equal(builds.length, 2, "the mutant build and the restore build");
	assert.equal(readFileSync(target, "utf8"), original, "the restore cannot be skipped");
	assert.equal(existsSync(`${target}.mutation-backup`), false, "the sidecar must not outlive the run");
	assert.match(lines.join("\n"), /restore verified green in both suites/);
	assert.match(lines.join("\n"), /MUTATION KILLED/);
});

test("--baseline measures BOTH packages first, then proceeds with the ritual", t => {
	const { root, seen, hooks } = ritualFixture(t, "mutation-run-baseline-green-");

	const { value: killed } = quietly(() => mutationRun(
		{ file: "guard.mjs", find: "limit = 5", replace: "limit = 500", baseline: true, cwd: root }, hooks));

	assert.equal(killed, true);
	assert.equal(seen.length, 3, "baseline, mutant, restore-verify");
	assert.equal(seen[0], ORIGINAL, "the baseline runs against the UNmutated file");
});

test("--baseline refuses on a red repo-root package, before anything is mutated", t => {
	const { root, target, seen, builds, hooks } = ritualFixture(t, "mutation-run-baseline-red-");
	const red = {
		...hooks,
		buildNode: hooks.buildNode,
		runSuites: cwd => hooks.runSuites(cwd).map(result =>
			result.suite === "root-pkg" ? outcome("root-pkg", 3, ["an unrelated red test"]) : result),
	};

	let thrown = null;
	quietly(() => {
		try {
			mutationRun({ file: "guard.mjs", find: "limit = 5", replace: "limit = 500", baseline: true, cwd: root }, red);
		} catch (error) {
			thrown = error;
		}
	});

	assert.ok(thrown, "a baseline blind to the repo-root package makes every later verdict meaningless");
	assert.match(thrown.message, /ALREADY red \(3 failing\)/);
	assert.match(thrown.message, /an unrelated red test/);
	assert.equal(seen.length, 1, "the baseline is the only run — the ritual must not start");
	assert.equal(builds.length, 0);
	assert.equal(readFileSync(target, "utf8"), ORIGINAL);
	assert.equal(existsSync(`${target}.mutation-backup`), false, "no sidecar before a passing baseline");
});

test("the ritual refuses linked-worktree checkout facts before touching the target file", t => {
	const root = tempDir(t, "mutation-run-lane-");
	const linked = tempDir(t, "mutation-run-linked-");
	const linkedTarget = path.join(linked, "guard.mjs");
	writeFileSync(linkedTarget, "export const limit = 5;\n");

	let thrown = null;
	const hooks = {
		checkoutFacts: () => ({ invocationRoot: linked, mainRoot: root }),
		workingTreeChanges: () => assert.fail("a refused lane must not read dirty state"),
		buildNode: () => assert.fail("a refused run must not build"),
		runSuites: () => assert.fail("a refused run must not run a suite"),
	};
	try {
		mutationRun({ file: "guard.mjs", find: "limit = 5", replace: "limit = 500", cwd: linked }, hooks);
	} catch (error) {
		thrown = error;
	}

	assert.ok(thrown, "the measured incident: an agent ran this from a worktree and got a no-teeth verdict");
	assert.match(thrown.message, /not the repository's main working tree/);
	assert.match(thrown.message, /false MUTATION SURVIVED/);
	assert.equal(readFileSync(linkedTarget, "utf8"), "export const limit = 5;\n", "the file must be untouched");
	assert.equal(existsSync(`${linkedTarget}.mutation-backup`), false, "no sidecar on a refused run");
});

test("checkout facts reject an ordinary directory without creating repository metadata", t => {
	const root = tempDir(t, "mutation-run-no-repo-");
	assert.throws(() => checkoutFacts(root), /not a git working tree/);
	assert.equal(existsSync(path.join(root, ".git")), false);
});
