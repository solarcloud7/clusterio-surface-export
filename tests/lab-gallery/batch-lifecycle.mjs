import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CONTROLLER = "surface-export-controller";
export const CTL_CONFIG = "/clusterio/tokens/config-control.json";
export const HOSTS = {
	1: { container: "surface-export-host-1", instance: "clusterio-host-1-instance-1" },
	2: { container: "surface-export-host-2", instance: "clusterio-host-2-instance-1" },
};
export const RESTORE_SAVES = { 1: "lab-gallery-source.zip", 2: "lab-gallery-destination.zip" };
export const RESTORE_SOURCE_PLATFORM = "lab-omnibus-state-v1";
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const FLUID_EPSILON = 1e-6;
export const DOUBLE_EPSILON = 1e-9;

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

export function lua(host, body) {
	const command = `/sc local ok,result=pcall(function() ${body} end); ` +
		`if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	const raw = lastLine(rcon(host, command));
	try { return JSON.parse(raw); }
	catch (error) { throw new Error(`Invalid Lua JSON from host ${host}: ${raw}\n${error.message}`); }
}

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


export function exportIdFloor(nowMs = Date.now()) {
	return Math.floor(nowMs);
}

export function bumpExportIdCounter(host, floor = exportIdFloor()) {
	const bumped = lua(host, `local floor=${floor}; local before=storage.async_job_id_counter or 0;`
		+ " if before < floor then storage.async_job_id_counter = floor end;"
		+ " return {success=true,before=before,counter=storage.async_job_id_counter,floorApplied=(before<floor)}");
	if (!bumped.success) throw new Error(`export-id uniquifier failed on host ${host}: ${bumped.error}`);
	if (!bumped.floorApplied) {
		throw new Error(`export-id uniquifier did not apply on host ${host}: the save's counter is already `
			+ `${bumped.before}, at or above the wall-clock floor ${floor}. A golden save banked with a `
			+ "wall-clock counter makes this bump a permanent no-op and silently restores the ID aliasing "
			+ "it exists to prevent. Re-bank the golden pair from a save with a small counter.");
	}
	return bumped.counter;
}


export function sanitizePlatformName(name) {
	const bytes = Buffer.from(String(name), "utf8");
	let out = "";
	for (const b of bytes) {
		const keep = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d;
		out += keep ? String.fromCharCode(b) : "-";
	}
	return out;
}

export function makeExportJobId(counter, platformName) {
	return `${String(counter).padStart(3, "0")}_${sanitizePlatformName(platformName)}`;
}

export function canonicalTransferId(instanceId, jobId) {
	return `${instanceId}:${jobId}`;
}

export function predictCanonicalIds({ instanceId, counter, platformName, count = 10 }) {
	const ids = [];
	for (let i = 1; i <= count; i++) {
		ids.push(canonicalTransferId(instanceId, makeExportJobId(counter + i, platformName)));
	}
	return ids;
}

export function fetchTransferSummaries({ limit = 200 } = {}) {
	let out;
	try {
		out = ctl("surface-export", "list-transfers", String(limit));
	} catch (error) {
		console.error(`preflight: transfer-registry query unavailable — ${error.message}`);
		return null;
	}
	const parseFailures = [];
	const lines = String(out).split(/\r?\n/).map(line => line.trim()).filter(Boolean).reverse();
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (Array.isArray(parsed)) return parsed;
			parseFailures.push(`parsed but not an array: ${line.slice(0, 80)}`);
		} catch (parseError) {
			parseFailures.push(`${line.slice(0, 80)} -> ${parseError.message}`);
		}
	}
	console.error("preflight: transfer-registry query returned no JSON array; tried "
		+ `${lines.length} line(s): ${parseFailures.join(" | ") || "(no output)"}`);
	return null;
}


const LIVE_TRANSFER_STATUSES = new Set([
	"transporting", "awaiting_validation", "awaiting_completion", "in_progress",
]);

function wouldRefuse(hit) {
	if (hit.registrySource !== "active") return false;
	if (LIVE_TRANSFER_STATUSES.has(hit.status)) return false;
	return hit.status !== "failed";
}

export function checkTransferIdCollisions({ candidates, summaries, limit = 200 }) {
	const scope = `${candidates.length} predicted ID(s), ${candidates[0]} .. ${candidates.at(-1)}`;
	const caveat = `BEST-EFFORT: the query is windowed at ${limit} records and activeTransfers is `
		+ "pruned above 100, so a clear result does not prove the IDs are free.";

	if (summaries === null) {
		return {
			status: "skipped", fatal: false, hits: [],
			message: "preflight SKIPPED (not passed): could not query the controller transfer registry. "
				+ "Proceeding — a settled-ID collision would surface later as a refused transfer.",
		};
	}

	const byId = new Map(summaries.map(summary => [summary.transferId, summary]));
	const hits = candidates.filter(id => byId.has(id)).map(id => byId.get(id));
	if (!hits.length) {
		return { status: "clear", fatal: false, hits: [], message: `preflight: ${scope} — none present. ${caveat}` };
	}

	const describe = hit => `${hit.transferId} (status=${hit.status}, registry=${hit.registrySource ?? "unknown"})`;
	const refusing = hits.filter(wouldRefuse);
	if (refusing.length) {
		return {
			status: "collision", fatal: true, hits,
			message: `preflight COLLISION: ${refusing.map(describe).join(", ")} is settled in the `
				+ "controller's IN-MEMORY activeTransfers in a status the retry guard REFUSES. This run "
				+ "will be refused. Remedy: docker restart surface-export-controller (that clears "
				+ "activeTransfers), then re-run. The persisted transaction log is reloaded on restart but "
				+ "is NOT consulted by the guard, so it does not need clearing.",
		};
	}

	const replaceable = hits.filter(hit => hit.registrySource === "active");
	if (replaceable.length) {
		return {
			status: "replaceable", fatal: false, hits,
			message: `preflight NOTE (no action needed): ${replaceable.map(describe).join(", ")} is in the `
				+ "in-memory registry, but in a status transferPlatform does NOT refuse — a live status "
				+ "dedupes, and 'failed' is explicitly replaced because its rollback discarded the "
				+ "destination. The suite's own refusal leg manufactures exactly this every run.",
		};
	}

	const unknown = hits.filter(hit => hit.registrySource !== "persisted");
	if (unknown.length) {
		return {
			status: "unknown", fatal: false, hits,
			message: "preflight POSSIBLE COLLISION (provenance unknown — an older controller build, or a "
				+ `registrySource value this checker does not know): ${unknown.map(describe).join(", ")}. `
				+ "It may or may not be refused. Remedy if it is: docker restart "
				+ "surface-export-controller, then re-run; if it persists after a restart the record is "
				+ "historical only. Not failing on an unprovable signal.",
		};
	}

	return {
		status: "historical", fatal: false, hits,
		message: `preflight NOTE (no action needed): ${hits.map(describe).join(", ")} exist only in the `
			+ "PERSISTED transaction log, which the retry guard never reads. They will not refuse this run.",
	};
}


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

export function createBatchLifecycle({ goldenSourceSave, goldenDestSave, markerPrefix }) {
	if (!goldenSourceSave || !goldenDestSave || !markerPrefix) {
		throw new Error("createBatchLifecycle needs goldenSourceSave, goldenDestSave, markerPrefix");
	}

	let restoreArtifacts = null;

	let livePairRestored = false;

	async function loadGoldenPair(manifest, phase) {
		const repoRoot = REPO_ROOT;
		restoreArtifacts = { 1: manifest.saves.source.artifact, 2: manifest.saves.destination.artifact };
		ctl("instance", "stop", HOSTS[1].instance);
		ctl("instance", "stop", HOSTS[2].instance);
		docker(["cp", `${repoRoot}${manifest.saves.source.artifact}`,
			`${HOSTS[1].container}:${instancePath(1, `saves/${goldenSourceSave}`)}`], { timeout: 180_000 });
		docker(["cp", `${repoRoot}${manifest.saves.destination.artifact}`,
			`${HOSTS[2].container}:${instancePath(2, `saves/${goldenDestSave}`)}`], { timeout: 180_000 });
		ctl("instance", "start", HOSTS[1].instance, "--save", goldenSourceSave);
		await waitReady(1);
		ctl("instance", "start", HOSTS[2].instance, "--save", goldenDestSave);
		await waitReady(2);
		assertLeaseClean(1, preflightState(1), phase);
		assertLeaseClean(2, preflightState(2), phase);
		const floor = exportIdFloor();
		const counters = {};
		for (const host of [1, 2]) counters[host] = bumpExportIdCounter(host, floor);
		return counters;
	}

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
		} catch (error) {
			console.error(`filesNewerThanMarker(host ${host}): ${error.message}`);
			return [];
		}
	}

	function transferFailureLines() {
		try {
			const out = docker(["exec", CONTROLLER, "sh", "-c",
				"grep -h 'Transfer failed:' /clusterio/logs/cluster/cluster-*.log 2>/dev/null || true"]);
			return out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
		} catch (error) {
			console.error(`transferFailureLines: ${error.message}`);
			return null;
		}
	}

	async function waitForImportResult(host, marker, timeoutMs = 240_000) {
		const deadline = Date.now() + timeoutMs;
		let lastReadError;
		const failuresBefore = transferFailureLines();
		const baseline = failuresBefore ? failuresBefore.length : null;
		while (Date.now() < deadline) {
			const fresh = filesNewerThanMarker(host, marker, "debug_import_result_*.json");
			if (fresh.length) {
				try { return { path: fresh.at(-1), result: readContainerJson(host, fresh.at(-1)) }; }
				catch (error) { lastReadError = error; }
			}
			if (baseline !== null) {
				const now = transferFailureLines();
				if (now && now.length > baseline) {
					const added = now.slice(baseline);
					throw new Error(`transfer FAILED before any import reached host ${host} — waiting for a `
						+ `debug_import_result it can never produce. The source instance reported:\n  `
						+ added.map(l => (l.match(/"message":"([^"]+)"/) || [null, l])[1]).join("\n  "));
				}
			}
			await sleep(3000);
		}
		throw new Error(`no fresh debug_import_result on host ${host} within ${timeoutMs} ms` +
			(lastReadError ? ` (last read attempt failed: ${lastReadError.message})` : "")
			+ (baseline === null ? " (could not read the controller log to check for a refused transfer)" : ""));
	}

	async function restoreLivePair(results, boundaryErrors) {
		try {
			if (!restoreArtifacts) {
				results.restored = { skipped: "golden pair never loaded; live pair untouched" };
				return;
			}
			if (livePairRestored) {
				results.restored = { skipped: "live pair already restored this run; refusing to re-run "
					+ "the rescue-and-overwrite (it would destroy the pre-suite rescue save)" };
				return;
			}
			livePairRestored = true;
			results.goldenSessionLogTails = {};
			for (const host of [1, 2]) {
				try {
					results.goldenSessionLogTails[host] = docker(["exec", HOSTS[host].container, "sh", "-c",
						`tail -n 80 ${instancePath(host, "factorio-current.log")}`]);
				} catch (error) { results.goldenSessionLogTails[host] = `unreadable: ${error.message}`; }
			}
			ctl("instance", "stop", HOSTS[1].instance);
			ctl("instance", "stop", HOSTS[2].instance);
			const rescueStamp = Date.now();
			for (const host of [1, 2]) {
				const live = instancePath(host, `saves/${RESTORE_SAVES[host]}`);
				docker(["exec", HOSTS[host].container, "sh", "-c",
					`rm -f ${instancePath(host, "saves/predeploy-suiterescue-")}*.zip; ` +
					`if [ -f ${live} ]; then cp ${live} ${instancePath(host, `saves/predeploy-suiterescue-${rescueStamp}.zip`)}; fi`]);
			}
			for (const host of [1, 2]) {
				docker(["cp", `${REPO_ROOT}${restoreArtifacts[host]}`,
					`${HOSTS[host].container}:${instancePath(host, `saves/${RESTORE_SAVES[host]}`)}`],
				{ timeout: 180_000 });
			}
			for (const host of [1, 2]) {
				ctl("instance", "start", HOSTS[host].instance, "--save", RESTORE_SAVES[host]);
				await waitReady(host);
			}
			const leftovers = [];
			for (const [host, name] of [[1, goldenSourceSave], [2, goldenDestSave]]) {
				const path = instancePath(host, `saves/${name}`);
				docker(["exec", HOSTS[host].container, "sh", "-c", `rm -f -- ${path}`]);
				try { docker(["exec", HOSTS[host].container, "test", "!", "-e", path]); }
				catch (error) { leftovers.push(`${name} still on host ${host} filesystem (${error.message.split(/\r?\n/)[0]})`); }
			}
			for (const host of [1, 2]) {
				docker(["exec", HOSTS[host].container, "sh", "-c", `rm -f /tmp/${markerPrefix}-*`]);
				assertLeaseClean(host, preflightState(host), "release");
			}
			if (leftovers.length) throw new Error(`temporary golden saves leaked: ${leftovers.join("; ")}`);
			const restoredSource = lua(1, `for _,p in pairs(game.forces.player.platforms) do ` +
				`if p.valid and p.name=='${RESTORE_SOURCE_PLATFORM}' then return {success=true,present=true} end end ` +
				`return {success=true,present=false}`);
			if (restoredSource.present !== true) {
				throw new Error(`restore verification FAILED — ${RESTORE_SOURCE_PLATFORM} is absent from the ` +
					`restored host-1 world; the cluster IS displaced. Artifact ${restoreArtifacts[1]} is stale ` +
					`or empty; recover with docker cp (clusterioctl save upload does not overwrite).`);
			}
			results.restored = { 1: RESTORE_SAVES[1], 2: RESTORE_SAVES[2], zeroLeftovers: true, sourceVerified: true };
		} catch (error) {
			boundaryErrors.push(`RESTORE FAILED (cluster may be displaced!): ${error.stack || error.message}`);
		}
	}

	return {
		goldenSourceSave, goldenDestSave, markerPrefix,
		CONTROLLER, CTL_CONFIG, HOSTS, RESTORE_SAVES, FLUID_EPSILON, DOUBLE_EPSILON,
		sleep, lastLine, docker, ctl, rcon, lua, instanceIds, instancePath,
		preflightState, assertLeaseClean, loadedSave, waitReady, assignSave, readContainerJson,
		exportIdFloor, bumpExportIdCounter,
		sanitizePlatformName, makeExportJobId, canonicalTransferId,
		predictCanonicalIds, fetchTransferSummaries, checkTransferIdCollisions,
		loadGoldenPair, dropMarker, filesNewerThanMarker, waitForImportResult, restoreLivePair,
	};
}
