// Shared single-use baked-fixture BATCH LIFECYCLE (docs/lab-tests.md).
//
// Extracted verbatim from the first certified batch runner (tests/census-lab/
// run-r2-fusion-commensurability.mjs) so every owning batch runner drives the SAME lease preflight,
// golden-pair load, terminal-record wait, and unconditional restore finalizer. Only the three
// runner-specific bits are parameterized (the two temporary golden save filenames and the /tmp marker
// prefix); the cluster identity, restore targets, and the lease/preflight contract are cluster-wide
// constants shared by all runners.
//
// The FIXTURE-SPECIFIC measurement, fingerprint, assertion, and NOTEBOOK rendering stay in each runner
// — this module owns only the generic lifecycle plumbing.
//
// Usage:
//   import { createBatchLifecycle } from "../lab-gallery/batch-lifecycle.mjs";
//   const L = createBatchLifecycle({
//     goldenSourceSave: "lab-XX-golden-source.zip",
//     goldenDestSave: "lab-XX-golden-dest.zip",
//     markerPrefix: "xx-marker",
//   });
//   const { docker, ctl, rcon, lua, instanceIds, loadGoldenPair, ... } = L;

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CONTROLLER = "surface-export-controller";
export const CTL_CONFIG = "/clusterio/tokens/config-control.json";
export const HOSTS = {
	1: { container: "surface-export-host-1", instance: "clusterio-host-1-instance-1" },
	2: { container: "surface-export-host-2", instance: "clusterio-host-2-instance-1" },
};
// The shared dev cluster's "release" saves — the pre-batch live worlds every batch restores to.
export const RESTORE_SAVES = { 1: "test1.zip", 2: "test2.zip" };
export const FLUID_EPSILON = 1e-6;   // the gate's aggregate-by-name epsilon
export const DOUBLE_EPSILON = 1e-9;  // save/load ULP allowance on fingerprint doubles (verify-save convention)

export function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
export function lastLine(v) { return String(v).split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) || ""; }

export function docker(args, options = {}) {
	return execFileSync("docker", args, {
		encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 32 * 1024 * 1024, ...options,
	});
}

export function ctl(...args) {
	return docker(["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"--config", CTL_CONFIG, ...args], { timeout: 180_000 });
}

export function rcon(host, command) {
	return docker(["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", HOSTS[host].instance, command, "--config", CTL_CONFIG],
	{ timeout: 180_000 }).trim();
}

// JSON-wrapped Lua control op (the R1 convention). Never used where an error must be silent.
export function lua(host, body) {
	const command = `/sc local ok,result=pcall(function() ${body} end); ` +
		`if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	const raw = lastLine(rcon(host, command));
	try { return JSON.parse(raw); }
	catch (error) { throw new Error(`Invalid Lua JSON from host ${host}: ${raw}\n${error.message}`); }
}

// Resolved from `instance save list` (first column is instanceId — a verified output shape).
export function instanceIds() {
	const ids = {};
	for (const host of [1, 2]) {
		const out = ctl("instance", "save", "list", HOSTS[host].instance);
		for (const line of out.split(/\r?\n/)) {
			const id = Number((line.match(/^\s*(\d+)\s*\|/) || [])[1]);
			if (Number.isInteger(id)) { ids[host] = id; break; }
		}
		if (!ids[host]) throw new Error(`Could not resolve instance ID for host ${host} from:\n${out}`);
	}
	return ids;
}

export function instancePath(host, suffix) {
	return `/clusterio/data/instances/${HOSTS[host].instance}/${suffix}`;
}

// --- Lease / preflight ---------------------------------------------------------------------------

// The exclusive-lease reading. Refuses (never repairs) hostile state: connected players, a paused
// game, or any transient plugin state (jobs, locks, holds, tombstones).
export function preflightState(host) {
	return lua(host, `local function n(t) return table_size(t or {}) end;` +
		`return {success=true,tick=game.tick,players=#game.connected_players,paused=game.tick_paused==true,` +
		`plugin=remote.interfaces['surface_export']~=nil,` +
		`jobs=n(storage.async_jobs),locks=n(storage.locked_platforms),holds=n(storage.destination_holds),` +
		`tombstones=n(storage.committed_source_transfer_tombstones)}`);
}

export function assertLeaseClean(host, state, phase) {
	const problems = [];
	if (!state.success) problems.push(`lua error: ${state.error}`);
	if (state.players > 0) problems.push(`${state.players} connected player(s)`);
	if (state.paused) problems.push("game is tick-paused");
	if (!state.plugin) problems.push("surface_export remote missing");
	for (const key of ["jobs", "locks", "holds", "tombstones"]) {
		if (state[key] !== 0) problems.push(`${key}=${state[key]}`);
	}
	if (problems.length) {
		throw new Error(`${phase}: host ${host} lease/preflight REFUSED (never repaired): ${problems.join("; ")}`);
	}
}

export function loadedSave(host) {
	const out = ctl("instance", "save", "list", HOSTS[host].instance);
	for (const line of out.split(/\r?\n/)) {
		const cells = line.split("|").map(c => c.trim());
		if (cells.length >= 5 && cells[4] === "true") return cells[2];
	}
	throw new Error(`No loaded save found for host ${host}:\n${out}`);
}

// --- Save assignment -----------------------------------------------------------------------------

export async function waitReady(host, timeoutMs = 180_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const state = lua(host, `return {success=true,tick=game.tick,plugin=remote.interfaces['surface_export']~=nil}`);
			if (state.success && state.plugin) return state;
			lastError = new Error(`plugin not ready: ${JSON.stringify(state)}`);
		} catch (error) { lastError = error; }
		await sleep(2000);
	}
	throw new Error(`host ${host} did not become RCON-ready: ${lastError?.message}`);
}

export async function assignSave(host, saveName) {
	ctl("instance", "stop", HOSTS[host].instance);
	ctl("instance", "start", HOSTS[host].instance, "--save", saveName);
	return waitReady(host);
}

export function readContainerJson(host, path) {
	return JSON.parse(docker(["exec", HOSTS[host].container, "cat", path]));
}

// The runner-specific bindings live in the object returned by this factory.
export function createBatchLifecycle({ goldenSourceSave, goldenDestSave, markerPrefix }) {
	if (!goldenSourceSave || !goldenDestSave || !markerPrefix) {
		throw new Error("createBatchLifecycle needs goldenSourceSave, goldenDestSave, markerPrefix");
	}

	async function loadGoldenPair(manifest, phase) {
		const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
		// STOP FIRST, copy SECOND: stopping a running instance EXIT-SAVES its (possibly mutated) world
		// back into the save file it was started from — copying the pristine golden zip before the stop
		// gets clobbered by that exit-save (measured: variant B reloaded a world whose fixture the
		// variant-A transfer had already consumed).
		ctl("instance", "stop", HOSTS[1].instance);
		ctl("instance", "stop", HOSTS[2].instance);
		docker(["cp", `${repoRoot}${manifest.saves.source.artifact}`,
			`${HOSTS[1].container}:${instancePath(1, `saves/${goldenSourceSave}`)}`], { timeout: 180_000 });
		docker(["cp", `${repoRoot}${manifest.saves.destination.artifact}`,
			`${HOSTS[2].container}:${instancePath(2, `saves/${goldenDestSave}`)}`], { timeout: 180_000 });
		// Lockstep: both instances land on the golden pair before any fixture is touched.
		ctl("instance", "start", HOSTS[1].instance, "--save", goldenSourceSave);
		await waitReady(1);
		ctl("instance", "start", HOSTS[2].instance, "--save", goldenDestSave);
		await waitReady(2);
		assertLeaseClean(1, preflightState(1), phase);
		assertLeaseClean(2, preflightState(2), phase);
		// EXPORT-ID UNIQUIFIER (instrumentation-level, no physical state touched): the golden world's
		// deterministic job counter regenerates IDENTICAL export/transfer IDs every load, and the
		// controller correctly REFUSES a same-ID retry once a prior record settled with a committed
		// destination (transfer-orchestrator retry semantics, 2026-07-18). Offsetting the counter after
		// each load gives every batch run collision-free IDs without weakening that production guard.
		const offset = 100 + (Date.now() % 1_000_000);
		const bumped = lua(1, `storage.async_job_id_counter=(storage.async_job_id_counter or 0)+${offset};` +
			`return {success=true,counter=storage.async_job_id_counter}`);
		if (!bumped.success) throw new Error(`export-id uniquifier failed: ${bumped.error}`);
	}

	// Deterministic golden worlds regenerate IDENTICAL debug filenames (same platform, same tick), so a
	// rerun OVERWRITES the prior file instead of creating a new path — a "new paths only" detector goes
	// blind on every run after the first (measured). Detection is mtime-vs-marker instead.
	function dropMarker(host, name) {
		const marker = `/tmp/${markerPrefix}-${name}`;
		docker(["exec", HOSTS[host].container, "sh", "-c", `touch ${marker}`]);
		return marker;
	}

	function filesNewerThanMarker(host, marker, glob) {
		try {
			return docker(["exec", HOSTS[host].container, "sh", "-c",
				`find ${instancePath(host, "script-output")} -maxdepth 1 -name '${glob}' -newer ${marker} 2>/dev/null || true`])
				.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
		} catch { return []; }
	}

	async function waitForImportResult(host, marker, timeoutMs = 240_000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const fresh = filesNewerThanMarker(host, marker, "debug_import_result_*.json");
			if (fresh.length) {
				// The file may be mid-write when first seen — retry the read on a parse failure.
				try { return { path: fresh.at(-1), result: readContainerJson(host, fresh.at(-1)) }; }
				catch { /* mid-write; poll again */ }
			}
			await sleep(3000);
		}
		throw new Error(`no fresh debug_import_result on host ${host} within ${timeoutMs} ms`);
	}

	// The unconditional restore finalizer body: capture evidence FIRST, restore the pre-batch live
	// saves, remove the temporary golden save files with filesystem proof, clean up markers, and prove
	// the release lease is clean. Writes results.goldenSessionLogTails + results.restored onto the
	// passed results (renderNotebook reads them); pushes a RESTORE-FAILED line onto boundaryErrors.
	async function restoreLivePair(results, boundaryErrors) {
		try {
			// EVIDENCE FIRST: restarting an instance rotates factorio-current.log — capture the
			// golden sessions' logs into the results before the restore destroys them (paid for:
			// run 1's stall evidence was lost to exactly this rotation).
			results.goldenSessionLogTails = {};
			for (const host of [1, 2]) {
				try {
					results.goldenSessionLogTails[host] = docker(["exec", HOSTS[host].container, "sh", "-c",
						`tail -n 80 ${instancePath(host, "factorio-current.log")}`]);
				} catch (error) { results.goldenSessionLogTails[host] = `unreadable: ${error.message}`; }
			}
			// Release the pair: restore the pre-batch live saves, then prove zero leftovers.
			await assignSave(1, RESTORE_SAVES[1]);
			await assignSave(2, RESTORE_SAVES[2]);
			// NOTE: stopping a golden session re-saves its file (Factorio saves on exit), so the
			// rm must come AFTER the restore-assign; the proof reads the FILESYSTEM (the
			// controller's `save list` is a cache that can list a deleted file).
			const leftovers = [];
			for (const [host, name] of [[1, goldenSourceSave], [2, goldenDestSave]]) {
				const path = instancePath(host, `saves/${name}`);
				docker(["exec", HOSTS[host].container, "sh", "-c", `rm -f -- ${path}`]);
				try { docker(["exec", HOSTS[host].container, "test", "!", "-e", path]); }
				catch { leftovers.push(`${name} still on host ${host} filesystem`); }
			}
			for (const host of [1, 2]) {
				docker(["exec", HOSTS[host].container, "sh", "-c", `rm -f /tmp/${markerPrefix}-*`]);
				assertLeaseClean(host, preflightState(host), "release");
			}
			if (leftovers.length) throw new Error(`temporary golden saves leaked: ${leftovers.join("; ")}`);
			results.restored = { 1: RESTORE_SAVES[1], 2: RESTORE_SAVES[2], zeroLeftovers: true };
		} catch (error) {
			boundaryErrors.push(`RESTORE FAILED (cluster may be displaced!): ${error.stack || error.message}`);
		}
	}

	return {
		// runner-specific config echoed for reference
		goldenSourceSave, goldenDestSave, markerPrefix,
		// generic constants
		CONTROLLER, CTL_CONFIG, HOSTS, RESTORE_SAVES, FLUID_EPSILON, DOUBLE_EPSILON,
		// generic primitives
		sleep, lastLine, docker, ctl, rcon, lua, instanceIds, instancePath,
		preflightState, assertLeaseClean, loadedSave, waitReady, assignSave, readContainerJson,
		// config-bound lifecycle
		loadGoldenPair, dropMarker, filesNewerThanMarker, waitForImportResult, restoreLivePair,
	};
}
