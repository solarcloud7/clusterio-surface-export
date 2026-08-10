#!/usr/bin/env node
// check-cluster-drift — is the running cluster actually running the code on disk?
//
// requires: docker, a running surface-export cluster
// produces: a per-layer FRESH/STALE verdict with the command that fixes each stale layer; exit 1 if any layer is stale
// does not: deploy, restart, or modify anything; prove the code is CORRECT — only that the cluster loaded it
//
// The plugin dir is bind-mounted, so each layer picks up disk at a different moment and never
// announces it: Lua at instance start (save patching), dist/node at host start, dist/web at
// controller start. Editing a file changes none of them. The cluster's state is therefore a
// function of which branch the checkout sits on and when each container last restarted — not of
// what is merged, and not of what the editor shows.
//
// The load moment per layer, and why it is the right one:
//   Lua   the first line of factorio-current.log is the session banner, written when the instance
//         started — which is exactly when Clusterio save-patched the module into script.dat.
//   node  the host container's start time; the plugin's dist/node is required at plugin load.
//   web   the controller container's start time; it caches each plugin's manifest and bundle.

import { execFileSync } from "node:child_process";

const PLUGIN = "/clusterio/external_plugins/surface_export";
const CONTROLLER = "surface-export-controller";
const HOSTS = ["surface-export-host-1", "surface-export-host-2"];

const sh = (container, script) =>
	execFileSync("docker", ["exec", container, "sh", "-c", script], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });

const containerStartedMs = (container) => Date.parse(
	execFileSync("docker", ["inspect", "-f", "{{.State.StartedAt}}", container], { encoding: "utf8" }).trim());

/** Newest mtime (ms) under `dir` matching `find` predicates, or null when nothing matches. */
function newestMs(container, dir, predicate) {
	const out = sh(container, `find ${dir} ${predicate} -type f -printf '%T@\\n' 2>/dev/null | sort -rn | head -1`).trim();
	return out ? Math.round(parseFloat(out) * 1000) : null;
}

/** Instance session start, from the log banner Factorio writes on boot. */
function instanceStartedMs(container, instance) {
	const line = sh(container, `head -1 /clusterio/data/instances/${instance}/factorio-current.log 2>/dev/null`).trim();
	const stamp = line.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)?.[1];
	return stamp ? Date.parse(`${stamp}Z`) : null;
}

const fmt = ms => (ms == null ? "unknown" : new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z");
const age = ms => {
	const h = ms / 3_600_000;
	return h >= 1 ? `${h.toFixed(1)}h` : `${Math.round(ms / 60_000)}m`;
};

/**
 * A layer is STALE when disk moved after the layer loaded it. An unreadable timestamp is UNKNOWN,
 * never FRESH — a probe that could not measure is not evidence of freshness, and both callers
 * treat UNKNOWN as a failure.
 */
export function driftStatus(loadedMs, diskMs) {
	if (!Number.isFinite(loadedMs) || !Number.isFinite(diskMs)) { return "UNKNOWN"; }
	return diskMs > loadedMs ? "STALE" : "FRESH";
}

// Importing this module (the unit test does) must not shell out to docker.
if (process.argv[1] && process.argv[1].endsWith("check-cluster-drift.mjs")) { main(); }

function main() {
const rows = [];
const add = (layer, loadedMs, diskMs, fix, note) => {
	rows.push({ layer, status: driftStatus(loadedMs, diskMs), loadedMs, diskMs, fix, note });
};

// --- Lua: save-patched into each instance at its start -------------------------------------
for (const host of HOSTS) {
	const instances = sh(host, "ls /clusterio/data/instances 2>/dev/null").trim().split("\n").filter(Boolean);
	for (const instance of instances) {
		add(
			`Lua  ${instance}`,
			instanceStartedMs(host, instance),
			newestMs(host, `${PLUGIN}/module`, "-name '*.lua'"),
			"./tools/clusterio/deploy.ps1 -Scope lua",
			"save-patched at instance start",
		);
	}
}

// --- node: dist/node, required when the host loads the plugin ------------------------------
for (const host of HOSTS) {
	add(
		`node ${host}`,
		containerStartedMs(host),
		newestMs(host, `${PLUGIN}/dist/node`, "-name '*.js'"),
		"./tools/clusterio/deploy.ps1 -Scope artifacts -Target node -RestartHosts",
		"loaded at host start",
	);
}

// --- web: dist/web, served and manifest-cached by the controller ----------------------------
add(
	"web  controller",
	containerStartedMs(CONTROLLER),
	newestMs(CONTROLLER, `${PLUGIN}/dist/web`, "-type f"),
	"./tools/clusterio/deploy.ps1 -Scope artifacts -Target web -RestartController",
	"bundle + manifest cached at controller start",
);

const width = Math.max(...rows.map(r => r.layer.length));
console.log("=== cluster drift: is the running cluster running the code on disk? ===\n");
for (const r of rows) {
	const detail = r.status === "STALE"
		? `disk is ${age(r.diskMs - r.loadedMs)} newer than what is loaded`
		: r.status === "FRESH" ? `loaded after the newest source` : "could not read one of the two timestamps";
	console.log(`  ${r.status.padEnd(7)} ${r.layer.padEnd(width)}  ${detail}`);
	console.log(`          ${" ".repeat(width)}  loaded ${fmt(r.loadedMs)} | newest source ${fmt(r.diskMs)}  (${r.note})`);
	if (r.status !== "FRESH") { console.log(`          ${" ".repeat(width)}  fix: ${r.fix}`); }
}

const bad = rows.filter(r => r.status !== "FRESH");
if (bad.length) {
	console.log(`\n${bad.length} layer(s) not running the code on disk. `
		+ "Measurements taken now are against the LOADED code, not the checkout.");
	process.exit(1);
}
console.log("\nEvery layer is running the code on disk.");
}
