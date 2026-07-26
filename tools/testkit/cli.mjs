#!/usr/bin/env node
// testkit CLI — the one-shot front door.
//
//   node tools/testkit/cli.mjs check                      # static referential integrity (no cluster)
//   node tools/testkit/cli.mjs check --live               # + anchors resolve against a real payload
//   node tools/testkit/cli.mjs inspect <platform>         # payload summary + record types
//   node tools/testkit/cli.mjs inspect <platform> --field <name>@<x>,<y>:<dotted.path>
//
// Exit codes: 0 clean, 1 findings, 2 usage/operational error.
import { testkit } from "./index.mjs";

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
			// A wrong query path and a real omission look identical unless we say so. Only claim loss
			// when the field is not reachable by ANY route on this record.
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

const COMMANDS = { check: cmdCheck, inspect: cmdInspect };
if (!COMMANDS[command]) {
	fail(`usage: node tools/testkit/cli.mjs <${Object.keys(COMMANDS).join("|")}> [...]`);
}
COMMANDS[command]().catch(error => fail(`testkit ${command} failed: ${error.message}`, 2));
