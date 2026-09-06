// mutation-run — the mutate -> build -> test -> restore ritual with a restore that cannot be skipped.
// requires: docker (container build + host-1 test run); invocation from the repository's MAIN working tree
//           (the one bind-mounted into surface-export-host-1), with nothing uncommitted in it
// produces: BOTH unit suites CI runs, reported per suite — the plugin's test/*.test.cjs inside
//           surface-export-host-1 and the repo root's tests/**/*.test.mjs on this machine — plus the tests
//           the mutation killed; exit 0 if >=1 died in EITHER suite, exit 1 if both stayed green
// does not: run the integration suite, the lint guards, or any live-transfer check — a SURVIVED verdict is
//           scoped to those two unit suites and claims nothing beyond them; mutate Lua that needs a deploy
//           (module/ is refused — use the live package.loaded rebind pattern); run a green baseline unless
//           --baseline; leave the mutant behind (the original goes to a sidecar BEFORE mutating, is restored
//           in finally, and a leftover sidecar from a killed run makes the next invocation refuse); detect an
//           unrelated CLONE at another path — the lane preflight compares this working tree against the
//           repository's main working tree, so a linked worktree is caught and a second clone is not

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const HOST_CONTAINER = "surface-export-host-1";
const PLUGIN_SUITE = "plugin test/*.test.cjs (in surface-export-host-1)";
const ROOT_SUITE = "repo-root tests/**/*.test.mjs";
const DIRTY_ENTRIES_SHOWN = 12;

function run(command, commandArgs, { cwd, timeout = 600_000 } = {}) {
	return execFileSync(command, commandArgs,
		{ cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}

function normalize(target) {
	const resolved = path.resolve(target);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(target, root) {
	const relative = path.relative(normalize(root), normalize(target));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function checkoutFacts(cwd) {
	const git = args => run("git", args, { cwd, timeout: 60_000 }).trim();
	let invocationRoot;
	let mainRoot;
	try {
		invocationRoot = git(["rev-parse", "--show-toplevel"]);
		mainRoot = path.dirname(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
	} catch (error) {
		throw new Error(`${cwd} is not a git working tree, so the checkout being mutated cannot be `
			+ `identified: ${error.message}`);
	}
	return { invocationRoot: path.resolve(invocationRoot), mainRoot: path.resolve(mainRoot) };
}

export function workingTreeChanges(root) {
	return run("git", ["status", "--porcelain"], { cwd: root, timeout: 60_000 })
		.split("\n").map(line => line.trim()).filter(Boolean);
}

export function laneRefusal({ invocationRoot, mainRoot, targetPath }) {
	if (normalize(invocationRoot) !== normalize(mainRoot)) {
		return "refusing: this is not the repository's main working tree.\n"
			+ `  invoked from:      ${invocationRoot}\n`
			+ `  main working tree: ${mainRoot}\n`
			+ `${HOST_CONTAINER} runs the plugin suite against the MAIN working tree — that tree is what is `
			+ "bind-mounted into the container — so a mutation applied here is not the code the suite loads, and "
			+ "the run reports a false MUTATION SURVIVED. Re-run from the main working tree.";
	}
	if (!isInside(targetPath, mainRoot)) {
		return `refusing: ${targetPath} is outside the main working tree ${mainRoot}, which is the only tree `
			+ "either suite loads code from.";
	}
	if (/[\\/]module[\\/]/.test(targetPath)) {
		return "module/ Lua needs a save-reset deploy per mutation — refuse rather than half-measure. "
			+ "Use the live package.loaded rebind pattern for Lua mutation-kills.";
	}
	return null;
}

export function idleRefusal({ sidecarPath, sidecarExists, dirtyEntries }) {
	if (sidecarExists) {
		return `${sidecarPath} exists — a previous mutation run died before restoring. `
			+ "Restore by hand (copy it over the target, rebuild, delete the sidecar) before running again.";
	}
	if (dirtyEntries.length > 0) {
		const shown = dirtyEntries.slice(0, DIRTY_ENTRIES_SHOWN).map(entry => `  ${entry}`);
		const rest = dirtyEntries.length - shown.length;
		return `refusing: the main working tree is not idle — ${dirtyEntries.length} uncommitted change(s):\n`
			+ shown.join("\n") + (rest > 0 ? `\n  ... and ${rest} more` : "") + "\n"
			+ "This ritual builds and tests whatever the tree holds right now, so an uncommitted edit — possibly "
			+ "another session's work in progress — is measured as part of the mutant and the verdict is "
			+ "confounded. Commit or stash first.";
	}
	return null;
}

export function readOutcome(suite, output) {
	const failed = Number((output.match(/^ℹ fail (\d+)$/m) || [])[1] ?? NaN);
	const names = [...output.matchAll(/^✖ (.+?) \(\d/gm)].map(match => match[1]);
	if (!Number.isFinite(failed)) {
		throw new Error(`could not read a fail count from the ${suite} output:\n${output.slice(-400)}`);
	}
	return { suite, failed, names: [...new Set(names)] };
}

export function combineVerdict(outcomes) {
	const failed = outcomes.reduce((total, outcome) => total + outcome.failed, 0);
	return { killed: failed > 0, failed, outcomes };
}

export function formatVerdict(verdict) {
	const scope = verdict.outcomes.map(outcome => `${outcome.suite} — ${outcome.failed} failing`);
	const lines = [];
	if (verdict.killed) {
		lines.push(`MUTATION KILLED — ${verdict.failed} test(s) died:`);
		for (const outcome of verdict.outcomes) {
			for (const name of outcome.names) lines.push(`  ✖ [${outcome.suite}] ${name}`);
		}
	} else {
		lines.push("MUTATION SURVIVED — both suites stayed green with the defect in place. "
			+ "Whatever this mutation breaks has no teeth in either of them.");
	}
	lines.push("suites exercised:");
	for (const line of scope) lines.push(`  ${line}`);
	lines.push("(integration suite and lint guards NOT run — they are outside this verdict.)");
	return lines.join("\n");
}

export const SUITES = [
	{
		name: PLUGIN_SUITE,
		command: "docker",
		args: ["exec", HOST_CONTAINER, "sh", "-c",
			"cd /clusterio/external_plugins/surface_export && npm test 2>&1"],
	},
	{
		name: ROOT_SUITE,
		command: process.execPath,
		args: ["--test", "--test-reporter=spec", "tests/**/*.test.mjs"],
	},
];

function runSuite(suite, cwd) {
	let output;
	try {
		output = run(suite.command, suite.args, { cwd });
	} catch (error) {
		output = String(error.stdout || "") + String(error.stderr || "");
	}
	return readOutcome(suite.name, output);
}

const REAL_HOOKS = {
	buildNode: cwd => { run("pwsh", ["-NoProfile", "-File", "tools/clusterio/build-plugin.ps1", "node"], { cwd }); },
	runSuites: cwd => SUITES.map(suite => runSuite(suite, cwd)),
};

export function mutationRun({ file, find, replace, baseline, cwd = process.cwd() }, hooks = REAL_HOOKS) {
	const { invocationRoot, mainRoot } = (hooks.checkoutFacts || checkoutFacts)(cwd);
	const absolute = path.resolve(cwd, file);

	const lane = laneRefusal({ invocationRoot, mainRoot, targetPath: absolute });
	if (lane) throw new Error(lane);

	const sidecar = `${absolute}.mutation-backup`;
	const idle = idleRefusal({
		sidecarPath: sidecar,
		sidecarExists: existsSync(sidecar),
		dirtyEntries: (hooks.workingTreeChanges || workingTreeChanges)(mainRoot),
	});
	if (idle) throw new Error(idle);

	const original = readFileSync(absolute, "utf8");
	if (!original.includes(find)) {
		throw new Error(`the target string is not in ${file} — nothing to mutate`);
	}
	const mutated = original.replace(find, replace);
	if (mutated === original) {
		throw new Error("find and replace produce identical content — that is not a mutation");
	}

	if (baseline) {
		console.log("baseline (unmutated) run — both suites ...");
		const before = combineVerdict(hooks.runSuites(mainRoot));
		if (before.failed > 0) {
			throw new Error(`the suites are ALREADY red (${before.failed} failing) — a mutation result would be `
				+ "meaningless. Failing tests: "
				+ before.outcomes.flatMap(outcome => outcome.names).join(", "));
		}
		console.log("  baseline green in both suites");
	}

	writeFileSync(sidecar, original);
	let verdict;
	try {
		writeFileSync(absolute, mutated);
		console.log(`mutated ${file} — building ...`);
		hooks.buildNode(mainRoot);
		console.log("running both suites against the mutant ...");
		verdict = combineVerdict(hooks.runSuites(mainRoot));
	} finally {
		writeFileSync(absolute, readFileSync(sidecar, "utf8"));
		unlinkSync(sidecar);
		console.log("restored the original — rebuilding ...");
		hooks.buildNode(mainRoot);
		const after = combineVerdict(hooks.runSuites(mainRoot));
		if (after.failed > 0) {
			console.error(`RESTORE IS NOT CLEAN: ${after.failed} test(s) still failing after restore: `
				+ after.outcomes.flatMap(outcome => outcome.names).join(", "));
			process.exitCode = 1;
		} else {
			console.log("restore verified green in both suites");
		}
	}

	console.log(formatVerdict(verdict));
	return verdict.killed;
}
