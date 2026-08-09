#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

console.log(`Running ${tests.length} integration test(s) sequentially (shared cluster — not parallelizable)...`);
const results = [];
for (const t of tests) {
	if (isCI) console.log(`::group::${t.name}`);
	else console.log(`\n${"=".repeat(60)}\n  ${t.name}\n${"=".repeat(60)}`);

	const extra = ARGS[t.name] || [];
	const cmd = t.kind === "ps1"
		? ["pwsh", ["-NoProfile", "-File", t.script, ...extra]]
		: [process.execPath, [t.script, ...extra]];
	const startedAt = Date.now();
	const r = spawnSync(cmd[0], cmd[1], { stdio: "inherit", cwd: repoRoot });
	const durationS = ((Date.now() - startedAt) / 1000).toFixed(1);
	if (r.error) console.error(`  spawn error: ${r.error.message}`);
	const ok = r.status === 0;

	if (isCI) console.log("::endgroup::");
	results.push({ name: t.name, ok, durationS });
	if (!ok && failFast) { console.log("  (--fail-fast: stopping)"); break; }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(60)}\n  Integration suite summary\n${"=".repeat(60)}`);
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${r.durationS}s)`);
console.log("=".repeat(60));
console.log(`  ${results.length - failed.length}/${results.length} passed` + (failed.length ? `  —  FAILED: ${failed.map((f) => f.name).join(", ")}` : ""));
console.log("=".repeat(60));
process.exit(failed.length ? 1 : 0);
