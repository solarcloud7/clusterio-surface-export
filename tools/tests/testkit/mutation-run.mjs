// mutation-run — the mutate -> build -> test -> restore ritual with a restore that cannot be skipped.
// requires: docker (container build + host-1 test run), a clean-committed target file (git-tracked)
// produces: the list of tests the mutation killed; exit 0 if >=1 died (teeth proven), exit 1 if the
//           suite stayed green (the mutation SURVIVED — the code under test has no teeth for it)
// does not: mutate Lua that needs a deploy (module/ is refused — use the live package.loaded pattern),
//           run a green baseline first unless --baseline, or leave the mutant behind: the original is
//           written to a sidecar BEFORE mutating, restored in finally, and a leftover sidecar from a
//           killed run makes the next invocation refuse until it is restored

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const HOST_CONTAINER = "surface-export-host-1";

function run(command, commandArgs, timeout = 600_000) {
	return execFileSync(command, commandArgs,
		{ encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}

function testFailures() {
	let output;
	try {
		output = run("docker", ["exec", HOST_CONTAINER, "sh", "-c",
			"cd /clusterio/external_plugins/surface_export && npm test 2>&1"]);
	} catch (error) {
		output = String(error.stdout || "") + String(error.stderr || "");
	}
	const failed = Number((output.match(/^ℹ fail (\d+)$/m) || [])[1] ?? NaN);
	const names = [...output.matchAll(/^✖ (.+?) \(\d/gm)].map(match => match[1]);
	if (!Number.isFinite(failed)) {
		throw new Error(`could not read a fail count from npm test output:\n${output.slice(-400)}`);
	}
	return { failed, names: [...new Set(names)] };
}

function buildNode() {
	run("pwsh", ["-NoProfile", "-File", "tools/clusterio/build-plugin.ps1", "node"]);
}

export function mutationRun({ file, find, replace, baseline }) {
	const absolute = path.resolve(file);
	const sidecar = `${absolute}.mutation-backup`;

	if (existsSync(sidecar)) {
		throw new Error(`${sidecar} exists — a previous mutation run died before restoring. `
			+ `Restore by hand (copy it over ${file}, rebuild, delete the sidecar) before running again.`);
	}
	if (/[\\/]module[\\/]/.test(absolute)) {
		throw new Error("module/ Lua needs a save-reset deploy per mutation — refuse rather than half-measure. "
			+ "Use the live package.loaded rebind pattern for Lua mutation-kills.");
	}

	const original = readFileSync(absolute, "utf8");
	if (!original.includes(find)) {
		throw new Error(`the target string is not in ${file} — nothing to mutate`);
	}
	const mutated = original.replace(find, replace);
	if (mutated === original) {
		throw new Error("find and replace produce identical content — that is not a mutation");
	}

	if (baseline) {
		console.log("baseline (unmutated) run ...");
		const before = testFailures();
		if (before.failed > 0) {
			throw new Error(`the suite is ALREADY red (${before.failed} failing) — a mutation result would be `
				+ `meaningless. Failing tests: ${before.names.join(", ")}`);
		}
		console.log("  baseline green");
	}

	writeFileSync(sidecar, original);
	let result;
	try {
		writeFileSync(absolute, mutated);
		console.log(`mutated ${file} — building ...`);
		buildNode();
		console.log("running the suite against the mutant ...");
		result = testFailures();
	} finally {
		writeFileSync(absolute, readFileSync(sidecar, "utf8"));
		unlinkSync(sidecar);
		console.log("restored the original — rebuilding ...");
		buildNode();
		const after = testFailures();
		if (after.failed > 0) {
			console.error(`RESTORE IS NOT CLEAN: ${after.failed} test(s) still failing after restore: `
				+ after.names.join(", "));
			process.exitCode = 1;
		} else {
			console.log("restore verified green");
		}
	}

	if (result.failed > 0) {
		console.log(`MUTATION KILLED — ${result.failed} test(s) died:`);
		for (const name of result.names) console.log(`  ✖ ${name}`);
		return true;
	}
	console.log("MUTATION SURVIVED — the suite stayed green with the defect in place. "
		+ "Whatever this mutation breaks has no teeth.");
	return false;
}
