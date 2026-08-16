#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runReadinessGate } from "./cluster-readiness.mjs";
import { SKIP_EXIT_CODE, SKIP_REASON_ENV } from "./integration-skip.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const integrationDir = join(repoRoot, "tests", "integration");

const SKIP = {};
const ARGS = {
};

const argv = process.argv.slice(2);
const flagValue = (name) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
const onlyRe = flagValue("--only") ? new RegExp(flagValue("--only")) : null;
const skipRe = flagValue("--skip") ? new RegExp(flagValue("--skip")) : null;
const failFast = argv.includes("--fail-fast");
const listOnly = argv.includes("--list");
const isCI = !!process.env.GITHUB_ACTIONS;

function discover() {
	const tests = [];
	for (const name of readdirSync(integrationDir).sort()) {
		if (name === "lib") continue;
		const dir = join(integrationDir, name);
		if (!statSync(dir).isDirectory()) continue;
		const mjs = join(dir, "run-tests.mjs");
		const ps1 = join(dir, "run-tests.ps1");
		if (existsSync(mjs)) tests.push({ name, script: mjs, kind: "mjs" });
		else if (existsSync(ps1)) tests.push({ name, script: ps1, kind: "ps1" });
	}
	return tests;
}

function pwshAvailable() {
	const r = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" });
	return r.status === 0;
}

const skipped = [];
const tests = discover().filter((t) => {
	if (SKIP[t.name]) { skipped.push({ ...t, reason: SKIP[t.name] }); return false; }
	if (onlyRe && !onlyRe.test(t.name)) return false;
	if (skipRe && skipRe.test(t.name)) return false;
	return true;
});

if (listOnly) {
	console.log(`Integration tests under tests/integration/ — ${tests.length} would run:`);
	for (const t of tests) console.log(`  • ${t.name} (${t.kind})${ARGS[t.name] ? `  args: ${ARGS[t.name].join(" ")}` : ""}`);
	if (skipped.length) {
		console.log(`\nSkip-listed (${skipped.length}):`);
		for (const s of skipped) console.log(`  • ${s.name} — ${s.reason}`);
	}
	process.exit(0);
}

if (tests.length === 0) { console.error("No integration tests matched."); process.exit(1); }

if (tests.some((t) => t.kind === "ps1") && !pwshAvailable()) {
	console.error("ERROR: PowerShell 7+ (`pwsh`) is required to run the .ps1 integration tests, but it was not found on PATH.");
	console.error("  macOS:   brew install powershell");
	console.error("  Linux:   https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux");
	console.error("  Windows: winget install Microsoft.PowerShell");
	process.exit(2);
}

const readiness = runReadinessGate();
if (!readiness.ok) {
	console.error("ERROR: cluster readiness preflight FAILED — refusing to run any suite against a mis-seeded, "
		+ "blank-booted or unreachable cluster. Every check above is measured live; re-seed with "
		+ "`./tools/clusterio/deploy.ps1 -Scope cluster` (or reload the golden saves) before re-running.");
	process.exit(3);
}

console.log(`Running ${tests.length} integration test(s) sequentially (shared cluster — not parallelizable)...`);
const results = [];
for (const t of tests) {
	if (isCI) console.log(`::group::${t.name}`);
	else console.log(`\n${"=".repeat(60)}\n  ${t.name}\n${"=".repeat(60)}`);

	const extra = ARGS[t.name] || [];
	const cmd = t.kind === "ps1"
		? ["pwsh", ["-NoProfile", "-File", t.script, ...extra]]
		: [process.execPath, [t.script, ...extra]];
	const reasonFile = join(tmpdir(), `se-integration-skip-${process.pid}-${t.name}.txt`);
	rmSync(reasonFile, { force: true });
	const startedAt = Date.now();
	const r = spawnSync(cmd[0], cmd[1], {
		stdio: "inherit",
		cwd: repoRoot,
		env: { ...process.env, [SKIP_REASON_ENV]: reasonFile },
	});
	const durationS = ((Date.now() - startedAt) / 1000).toFixed(1);
	if (r.error) console.error(`  spawn error: ${r.error.message}`);

	let status = r.status === 0 ? "pass" : "fail";
	let reason = "";
	if (r.status === SKIP_EXIT_CODE) {
		reason = existsSync(reasonFile) ? readFileSync(reasonFile, "utf8").trim() : "";
		if (reason) {
			status = "skip";
		} else {
			reason = `exited ${SKIP_EXIT_CODE} without writing a reason to $${SKIP_REASON_ENV} — `
				+ "an unexplained skip is a failure";
		}
	}
	rmSync(reasonFile, { force: true });

	if (isCI) console.log("::endgroup::");
	results.push({ name: t.name, status, reason, durationS });
	if (status === "fail" && failFast) { console.log("  (--fail-fast: stopping)"); break; }
}

const failed = results.filter((r) => r.status === "fail");
const skippedRuns = results.filter((r) => r.status === "skip");
const passed = results.filter((r) => r.status === "pass");
const LABEL = { pass: "PASS", fail: "FAIL", skip: "SKIP" };
console.log(`\n${"=".repeat(60)}\n  Integration suite summary\n${"=".repeat(60)}`);
for (const r of results) console.log(`  ${LABEL[r.status]}  ${r.name}  (${r.durationS}s)${r.reason ? `  —  ${r.reason}` : ""}`);
console.log("=".repeat(60));
console.log(`  ${passed.length}/${results.length} passed`
	+ (skippedRuns.length ? `  —  SKIPPED (did not run, did not pass): ${skippedRuns.map((s) => s.name).join(", ")}` : "")
	+ (failed.length ? `  —  FAILED: ${failed.map((f) => f.name).join(", ")}` : ""));
console.log("=".repeat(60));
if (isCI) {
	for (const s of skippedRuns) console.log(`::warning::integration suite SKIPPED — ${s.name}: ${s.reason}`);
}
process.exit(failed.length ? 1 : 0);
