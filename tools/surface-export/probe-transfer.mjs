#!/usr/bin/env node
// probe-transfer — the clone -> transfer -> verify -> sweep loop as ONE command.
// requires: the cluster up; a source fixture platform (default: lab-omnibus-state-v1, index 21)
// produces: a verdict block — gate result, phase timings, PropertyCensus/BlueprintDiff lines, dest
//           arrival — and exit 0 only if the transfer SUCCEEDED and the sweep left zero leftovers
// does not: touch the protected fixtures (it transfers a CLONE), keep anything unless --keep, or
//           replace the integration suite — this is the ad-hoc probe loop, made repeatable

import { execFileSync } from "node:child_process";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
import { seededHosts } from "../shared/seeded-instances.mjs";
const HOSTS = seededHosts();

const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
	const i = args.indexOf(name);
	return i === -1 ? fallback : args[i + 1];
};
const fixtureIndex = Number(valueOf("--fixture", "21"));
const direction = valueOf("--direction", "1to2");
const luaPrep = valueOf("--lua", null);
const keep = args.includes("--keep");
const probeName = valueOf("--name", `probe-${Date.now().toString(36)}`);

const [sourceHost, destHost] = direction === "2to1" ? [2, 1] : [1, 2];

function rcon(host, command) {
	return execFileSync("docker", ["exec", CONTROLLER, "npx", "clusterioctl",
		"--config", CTL_CONFIG, "--log-level", "error",
		"instance", "send-rcon", HOSTS[host].instance, command],
	{ encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }).trim();
}

function findPlatform(host, name) {
	const raw = rcon(host, `/sc for _,p in pairs(game.forces['player'].platforms) do `
		+ `if p.name=='${name}' then rcon.print(p.index) end end`);
	const index = Number(raw.split(/\r?\n/).filter(Boolean).at(-1));
	return Number.isFinite(index) ? index : null;
}

function deletePlatform(host, name) {
	const index = findPlatform(host, name);
	if (index === null) return false;
	rcon(host, `/sc local p=game.forces['player'].platforms[${index}]; `
		+ `if p and p.name=='${name}' then game.delete_surface(p.surface); rcon.print('deleted') end`);
	return true;
}

function grepInstanceLog(host, pattern, lines = 8) {
	try {
		return execFileSync("docker", ["exec", HOSTS[host].container, "sh", "-c",
			`grep -a '${pattern}' /clusterio/data/instances/${HOSTS[host].instance}/factorio-current.log | tail -${lines}`],
		{ encoding: "utf8", timeout: 30_000 }).trim();
	} catch (error) {
		const firstLine = String(error.message).split("\n")[0];
		console.error(`  (log grep failed on host ${host}: ${firstLine})`);
		return "";
	}
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let failed = false;
const report = line => console.log(line);
const fail = line => { console.log(line); failed = true; };

try {
	report(`=== probe-transfer: fixture ${fixtureIndex} as '${probeName}', host ${sourceHost} -> ${destHost} ===`);

	const cloneRaw = rcon(sourceHost, `/sc local ok, res = pcall(function() return `
		+ `remote.call('surface_export','clone_platform', ${fixtureIndex}, '${probeName}') end); `
		+ `rcon.print(ok and (res and res.success and 'ok' or ('refused: ' .. tostring(res and res.message))) or ('threw: ' .. tostring(res)))`);
	if (!/\bok\b/.test(cloneRaw.split(/\r?\n/).at(-1))) {
		throw new Error(`clone failed: ${cloneRaw.slice(-200)}`);
	}
	await sleep(4000);
	const cloneIndex = findPlatform(sourceHost, probeName);
	if (cloneIndex === null) {
		throw new Error("clone did not appear on the source");
	}
	report(`  clone ready at index ${cloneIndex}`);

	if (luaPrep) {
		const prep = rcon(sourceHost, `/sc local p; for _,pl in pairs(game.forces['player'].platforms) do `
			+ `if pl.index==${cloneIndex} then p=pl end end; local surface=p.surface; ${luaPrep}`);
		report(`  --lua prep ran${prep ? `: ${prep.split(/\r?\n/).at(-1)}` : ""}`);
	}

	const transferOut = execFileSync("pwsh", ["-NoProfile", "-File", "tools/surface-export/transfer-platform.ps1",
		"-PlatformIndex", String(cloneIndex), "-Direction", direction],
	{ encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] });
	if (!/Export queued/.test(transferOut)) {
		throw new Error(`transfer-platform.ps1 did not queue: ${transferOut.slice(-300)}`);
	}

	let arrivedIndex = null;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		await sleep(2000);
		arrivedIndex = findPlatform(destHost, probeName);
		if (arrivedIndex !== null && findPlatform(sourceHost, probeName) === null) break;
	}
	if (arrivedIndex === null) {
		fail("  FAIL platform never arrived on the destination");
	} else {
		report(`  arrived on host ${destHost} at index ${arrivedIndex}, source copy gone`);
	}

	const logLine = execFileSync("node", ["tools/tests/testkit/cli.mjs", "log", "latest", "--field", "summary"],
		{ encoding: "utf8", timeout: 60_000 }).trim();
	const resultMatch = logLine.match(/"result": "(\w+)"/);
	const durationMatch = logLine.match(/"totalDurationMs": (\d+)/);
	report(`  gate: ${resultMatch ? resultMatch[1] : "UNKNOWN — read testkit log latest yourself"}`
		+ (durationMatch ? ` in ${durationMatch[1]}ms` : ""));
	if (!resultMatch || resultMatch[1] !== "SUCCESS") {
		fail("  FAIL the transfer did not succeed through the gate");
	}

	const findings = grepInstanceLog(sourceHost, `PropertyCensus.*${probeName}\\|BlueprintDiff.*${probeName}`);
	report(findings
		? `  detector:\n${findings.split(/\r?\n/).map(l => `    ${l.replace(/^.*Script /, "")}`).join("\n")}`
		: "  detector: no PropertyCensus/BlueprintDiff lines for this platform");
} catch (error) {
	console.log(`  FAIL ${error.message}`);
	failed = true;
} finally {
	if (keep) {
		console.log(`  --keep: '${probeName}' left in place; sweep it yourself`);
	} else {
		let swept = 0;
		for (const host of [1, 2]) {
			try {
				if (deletePlatform(host, probeName)) swept += 1;
			} catch (error) {
				console.log(`  FAIL sweep on host ${host}: ${error.message}`);
				failed = true;
			}
		}
		const leftover = [1, 2].some(host => {
			try {
				return findPlatform(host, probeName) !== null;
			} catch (error) {
				console.log(`  FAIL leftover check on host ${host}: ${error.message} — treating as leftover`);
				return true;
			}
		});
		if (leftover) {
			fail(`  FAIL sweep left '${probeName}' behind — clean it by hand`);
		} else {
			console.log(`  swept (${swept} platform(s) removed, zero leftovers)`);
		}
	}
}

process.exit(failed ? 1 : 0);
