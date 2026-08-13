#!/usr/bin/env node
import { testkit } from "./index.mjs";
import { probeProperty } from "./live-probe.mjs";
import { explainBlackBoxFile, formatExplanation } from "./blackbox-explain.mjs";
import * as logq from "./log-query.mjs";
import { formatMiss } from "./path-oracle.mjs";
import { lookup, formatLookup } from "./api-oracle.mjs";
import { mutationRun } from "./mutation-run.mjs";

const [, , command, ...rest] = process.argv;
const flag = name => rest.includes(name);
const valueOf = name => { const i = rest.indexOf(name); return i === -1 ? null : rest[i + 1]; };

function fail(message, code = 2) { console.error(message); process.exit(code); }

async function cmdCheck() {
	const staticResult = testkit.referentialIntegrity({ mode: "static" });
	console.log(testkit.formatFindings(staticResult));
	console.log(`  (static checks run: ${staticResult.checked.join(", ")})`);

	let anchorResult = null;
	if (flag("--live")) {
		const platform = valueOf("--platform") || "lab-omnibus-state-v1";
		console.log(`\nlive anchor check against ${platform} ...`);
		const inspector = await testkit.exportInspect({ platform });
		anchorResult = testkit.referentialIntegrity({ mode: "anchors", inspector, platformName: platform });
		console.log(testkit.formatFindings(anchorResult));
		console.log(`  (${anchorResult.checkedAnchors} anchors checked)`);
	} else {
		console.log("\n(anchor checks SKIPPED — pass --live with a running cluster. Skipped is not passed.)");
	}

	const ok = staticResult.ok && (anchorResult === null || anchorResult.ok);
	process.exit(ok ? 0 : 1);
}

async function cmdInspect() {
	const platform = rest[0];
	if (!platform || platform.startsWith("--")) fail("usage: inspect <platform> [--field name@x,y:dotted.path]");
	const inspector = await testkit.exportInspect({ platform });
	console.log(JSON.stringify(inspector.summary(), null, 2));

	const field = valueOf("--field");
	if (field) {
		const m = field.match(/^([^@]+)@(-?[\d.]+),(-?[\d.]+):(.+)$/);
		if (!m) fail('--field must look like  storage-tank@10.5,14.5:specific_data.fluidboxes');
		const [, entity, x, y, path] = m;
		const result = inspector.field({ entity, x: Number(x), y: Number(y) }, path);
		console.log("\n" + JSON.stringify(result, null, 2));
		if (result.inPayload === false) {
			if (result.pathHints && result.pathHints.length > 0) {
				console.log(`\nNot at "${result.fieldPath}" — but this field EXISTS at: ${result.pathHints.join(", ")}`);
				console.log("Your query path is wrong; the payload is fine. Re-run against the path above.");
				process.exit(2);
			}
			console.log(`\nABSENT from the payload => this CANNOT survive a transfer.`);
			console.log(`  (path stopped at "${result.stoppedAt}"; keys available there: ` +
				`${result.availableKeys.length ? result.availableKeys.join(", ") : "(none)"})`);
			process.exit(1);
		}
		if (result.inPayload === true) {
			console.log("\nPresent in the payload. NOT proven to survive — restoration is untested here " +
				"(item-request proxies rode the payload and were still dropped at create until 2026-07-19).");
		}
	} else {
		const counts = inspector.countsByType();
		console.log("\nrecord types:");
		for (const [type, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
			console.log(`  ${String(n).padStart(5)}  ${type}`);
		}
	}
	process.exit(0);
}

async function cmdProbe() {
	const [platform, target] = rest.filter(a => !a.startsWith("--"));
	if (!platform || !target) fail("usage: probe <platform> <entity>@<x>,<y>:<dotted.path> [--host N]");
	const host = Number(valueOf("--host") || 1);
	const result = probeProperty({ platform, target, host });
	console.log(JSON.stringify(result, null, 2));
	process.exit(0);
}

async function cmdBlackbox() {
	const [sub, path] = rest.filter(a => !a.startsWith("--"));
	if (sub !== "explain" || !path) fail("usage: blackbox explain <bundle.json> [--json]");
	const report = explainBlackBoxFile(path);
	if (flag("--json")) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(formatExplanation(report));
	}
	process.exit(0);
}

async function cmdLog() {
	const VALUE_FLAGS = new Set(["--field", "--from-file"]);
	const positionals = [];
	for (let i = 0; i < rest.length; i++) {
		if (VALUE_FLAGS.has(rest[i])) { i++; continue; }
		if (rest[i].startsWith("--")) continue;
		positionals.push(rest[i]);
	}
	const field = valueOf("--field");
	const asJson = flag("--json");
	const usage = "usage:\n"
		+ "  log <transferId|latest> --field <dotted.path> [--json]\n"
		+ "  log <transferId|latest> --list\n"
		+ "  log dump <host> <name-or-glob> [--field <path>] [--newest]\n"
		+ "  log --from-file <store.json> <transferId|latest> --field <path>";

	if (positionals[0] === "dump") {
		const [, hostArg, glob] = positionals;
		if (!hostArg || !glob) fail(usage);
		const host = Number(hostArg);
		if (!Number.isInteger(host)) fail(`log dump: host must be 1 or 2, got "${hostArg}"`);
		const matches = logq.listDumps(host, glob);
		if (!matches.length) {
			fail(`log dump: no file matching "${glob}" in host ${host}'s script-output.\n`
				+ "  A MISSING DUMP IS NOT AN ABSENT VALUE: every debug_* write is gated on the plugin's\n"
				+ "  debug_mode (module/utils/debug-export.lua). Enable it and re-run the operation.");
		}
		if (flag("--list") || !field) {
			for (const m of matches) console.log(`${m.size.toString().padStart(10)}  ${m.path}`);
			process.exit(0);
		}
		if (matches.length > 1 && !flag("--newest")) {
			fail(`log dump: "${glob}" matches ${matches.length} files — refusing to guess. Name one, or\n`
				+ `pass --newest.\n  ${matches.map(m => m.path).join("\n  ")}`);
		}
		const chosen = matches[0];
		const doc = logq.readDump(host, chosen.path);
		const result = logq.resolvePath(doc, field);
		if (!result.ok) fail(formatMiss(result, { query: field, subject: chosen.path }), 2);
		console.log(chosen.path);
		console.log(logq.formatValue(field, result.value));
		process.exit(0);
	}

	const fromFile = valueOf("--from-file");
	const store = fromFile ? logq.readStoreFile(fromFile) : logq.readTransactionLogStore();
	const selector = positionals[0];

	if (flag("--list")) {
		const source = fromFile || `${logq.STORE.container}:${logq.STORE.path}`;
		console.log(`${store.length} transaction log entr${store.length === 1 ? "y" : "ies"} in ${source}`);
		for (const [index, entry] of store.entries()) {
			console.log(`  ${String(index).padStart(3)}  ${logq.describeEntry(entry, index, store.length)}`);
		}
		if (store.length) console.log(`(\`latest\` resolves to #${store.length - 1}, ${store.at(-1).transferId})`);
		process.exit(0);
	}

	if (!selector || !field) fail(usage);
	const { entry, index } = logq.selectEntry(store, selector);
	const result = logq.resolvePath(entry, field);
	if (!result.ok) {
		if (asJson) console.log(JSON.stringify({ ok: false, query: field, transferId: entry.transferId, miss: result }, null, 2));
		fail(formatMiss(result, { query: field, subject: entry.transferId }), 2);
	}
	if (asJson) {
		console.log(JSON.stringify({ ok: true, query: field, transferId: entry.transferId, value: result.value }, null, 2));
		process.exit(0);
	}
	console.log(logq.describeEntry(entry, index, store.length));
	console.log(logq.formatValue(field, result.value));
	process.exit(0);
}


async function cmdApi() {
	const query = rest[0];
	if (!query) fail("usage: api <Class[.member]>   e.g. api LuaEntity.driver_is_gunner");
	const result = lookup(query);
	if (flag("--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(formatLookup(result));
	}
	process.exit(result.ok ? 0 : 2);
}

async function cmdMutation() {
	const file = valueOf("--file");
	const find = valueOf("--find");
	const replace = valueOf("--replace");
	if (!file || find === null || replace === null) {
		fail("usage: mutation --file <path> --find <exact string> --replace <mutant string> [--baseline]");
	}
	const killed = mutationRun({ file, find, replace, baseline: flag("--baseline") });
	process.exit(killed && process.exitCode !== 1 ? 0 : 1);
}

async function cmdCoverage() {
	const platforms = [];
	for (const arg of rest) {
		if (arg.startsWith("--")) break;
		platforms.push(arg);
	}
	if (platforms.length === 0) {
		fail("usage: coverage <platform> [<platform>...] [--host 1] [--per-type 2] [--md <path>] [--json <path>]");
	}
	const { coverage, renderChecklist, summarize } = await import("./coverage.mjs");
	const report = await coverage({
		platforms,
		host: Number(valueOf("--host") ?? 1),
		perType: Number(valueOf("--per-type") ?? 2),
	});
	const { writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const mdPath = valueOf("--md") ?? join(tmpdir(), "testkit-coverage-checklist.md");
	writeFileSync(mdPath, renderChecklist(report));
	const jsonPath = valueOf("--json");
	if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2));
	console.log(summarize(report));
	console.log(`checklist: ${mdPath}${jsonPath ? `\njson: ${jsonPath}` : ""}`);
}

const COMMANDS = { check: cmdCheck, inspect: cmdInspect, probe: cmdProbe, blackbox: cmdBlackbox, log: cmdLog, api: cmdApi, mutation: cmdMutation, coverage: cmdCoverage };
if (!COMMANDS[command]) {
	fail(`usage: node tools/tests/testkit/cli.mjs <${Object.keys(COMMANDS).join("|")}> [...]`);
}
COMMANDS[command]().catch(error => fail(`testkit ${command} failed: ${error.message}`, 2));
