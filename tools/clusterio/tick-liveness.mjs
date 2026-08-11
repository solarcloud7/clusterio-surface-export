#!/usr/bin/env node
// tick-liveness — is each instance's MAIN THREAD alive? The container healthcheck and the
// surface_export_export_stall_seconds metric structurally cannot answer this: both live on the
// thread being asked about, so a wedge reports healthy and a silent log reads as "nothing happened".
// requires: docker + the surface-export-controller container running
// produces: one line per instance — ADVANCING / PAUSED / FROZEN / STALLED / STOPPED / UNREACHABLE —
//           with tick numbers; exit 0 only if every instance is ADVANCING (or PAUSED with --allow-paused)
// does not: explain WHY a main thread is stalled, restart anything, or measure UPS precisely —
//           two samples bound liveness, not performance

import { execFileSync } from "node:child_process";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const DEFAULT_INSTANCES = ["clusterio-host-1-instance-1", "clusterio-host-2-instance-1"];
const RCON_TIMEOUT_MS = 15_000;
const SAMPLE_GAP_MS = 400;

const args = process.argv.slice(2);
const allowPaused = args.includes("--allow-paused");
const instances = args.filter(a => !a.startsWith("--"));
const targets = instances.length ? instances : DEFAULT_INSTANCES;

const PROBE = '/sc rcon.print(game.tick .. " " .. tostring(game.tick_paused))';

function sample(instance) {
	try {
		const raw = execFileSync("docker", ["exec", CONTROLLER, "npx", "clusterioctl",
			"--config", CTL_CONFIG, "--log-level", "error",
			"instance", "send-rcon", instance, PROBE],
		{ encoding: "utf8", timeout: RCON_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }).trim();
		const line = raw.split(/\r?\n/).filter(Boolean).at(-1) || "";
		const match = line.match(/^(\d+) (true|false)$/);
		if (!match) {
			return { state: "UNREACHABLE", detail: `unexpected RCON reply: ${line.slice(0, 120)}` };
		}
		return { tick: Number(match[1]), paused: match[2] === "true" };
	} catch (error) {
		if (error.code === "ETIMEDOUT" || /ETIMEDOUT/.test(String(error.message))) {
			return { state: "STALLED", detail: `RCON gave no answer in ${RCON_TIMEOUT_MS}ms — RCON is served by `
				+ "the main thread, so a hung main thread looks exactly like this" };
		}
		const message = String(error.stderr || error.message || error);
		if (/not running/i.test(message)) {
			return { state: "STOPPED", detail: "instance reports not running" };
		}
		return { state: "UNREACHABLE", detail: message.split("\n").find(Boolean)?.slice(0, 160) || "unknown error" };
	}
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let failures = 0;
for (const instance of targets) {
	const first = sample(instance);
	if (first.state) {
		console.log(`  ${first.state.padEnd(11)} ${instance} — ${first.detail}`);
		failures += 1;
		continue;
	}
	await sleep(SAMPLE_GAP_MS);
	const second = sample(instance);
	if (second.state) {
		console.log(`  ${second.state.padEnd(11)} ${instance} — first sample answered (tick ${first.tick}), second: ${second.detail}`);
		failures += 1;
		continue;
	}
	if (second.tick > first.tick) {
		console.log(`  ADVANCING   ${instance} — tick ${first.tick} -> ${second.tick} (+${second.tick - first.tick} in ~${SAMPLE_GAP_MS}ms)`);
		continue;
	}
	if (second.paused) {
		console.log(`  PAUSED      ${instance} — tick ${second.tick}, game.tick_paused=true`);
		if (!allowPaused) failures += 1;
		continue;
	}
	console.log(`  FROZEN      ${instance} — tick ${second.tick} did not advance and the game is NOT paused`);
	failures += 1;
}

process.exit(failures ? 1 : 0);
