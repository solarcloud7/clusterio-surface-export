// Shared single-use baked-fixture BATCH LIFECYCLE (docs/testing.md).
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
export const RESTORE_SAVES = { 1: "lab-gallery-source.zip", 2: "lab-gallery-destination.zip" };
// Restoring by NAME alone is not a restore: an instance exit-saves its (possibly consumed) world into
// the file it started from, so a live save is a MUTABLE file that a transfer test can empty. Measured
// 2026-07-28 — the suite transferred the gallery platform away, the stop wrote the gallery-less world
// into lab-gallery-source.zip, and every later start from that name faithfully reloaded the empty
// world; the cluster stayed displaced until the bytes were copied back. So restoreLivePair copies
// PRISTINE BYTES first, then starts, then reads the content back. The bytes come from the manifest
// artifacts captured at load time (see loadGoldenPair) — the same SHA-pinned files the suite preflight
// verified. A second hardcoded copy of those paths would drift silently on the next manifest re-pin.
//
// The platform the restored source world MUST contain — the restore's content teeth.
export const RESTORE_SOURCE_PLATFORM = "lab-omnibus-state-v1";
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
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

// --- Export-ID uniquifier ------------------------------------------------------------------------

/**
 * The floor the export-ID counter is raised to: raw epoch milliseconds, NO modulus.
 *
 * This used to be `100 + (Date.now() % 1_000_000)` — an ADDITIVE offset, and `% 1_000_000` wraps
 * every 1,000,000 ms = 16 minutes 40 seconds. The golden save reloads to a PINNED counter on every
 * run, so the post-bump value was fully determined by the offset: two runs any multiple of ~16m40s
 * apart drew the same offset and regenerated the SAME transfer IDs. (deliver-all-fixtures used
 * `% 100_000` — 100 seconds.) That aliasing is why collisions kept RECURRING rather than being
 * one-off contamination from a stray manual transfer.
 *
 * A monotone floor cannot alias: strictly increasing in wall clock at 1 ms granularity, and
 * docker-exec latency alone puts consecutive runs orders of magnitude further apart than the job
 * count of any single run.
 *
 * MEASURED on 2.1.11 before adopting, because a 13-digit counter is a real change to a
 * save-resident value and the formatting is the least likely link to break:
 *   - `string.format("%03d", 1785604898997)` formats clean (no padding artifact)
 *   - the resulting job id `1785604898997_lab-omnibus-state-v1` round-trips through
 *     job-results.lua:12's `^(%d+)_` parse EXACTLY (< 2^53, so the double is lossless)
 *   - a real `export_platform_to_file` produced its entry and wrote its file
 *   - the counter AND its async_job_results key both survived a full instance stop/start
 *     save-load cycle — the link the rest of the chain rests on
 *
 * Does NOT protect against a clock rewind (NTP correction, VM snapshot restore): nothing remembers
 * the previous run's high-water mark, and the golden load resets the save's counter to its small
 * pinned value. That residual is what the collision preflight covers.
 */
export function exportIdFloor(nowMs = Date.now()) {
	return Math.floor(nowMs);
}

/**
 * Raise one host's export-ID counter to `floor` — SET-if-lower, not ADD, so both hosts land on the
 * SAME base no matter how far each has drifted. (They do drift: the counter is shared with import
 * jobs, import-pipeline.lua:44-45, so the destination side advances during a run too.) A shared base
 * is what lets a collision preflight predict both legs' IDs from one number.
 *
 * THROWS when the floor did not apply. That means the golden save was banked carrying a wall-clock
 * counter, which makes this a permanent no-op and silently restores the aliasing it exists to
 * prevent — invisible unless checked right here.
 */
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

// --- Canonical transfer-ID collision preflight ---------------------------------------------------
//
// A colliding ID is refused correctly and reported clearly (waitForImportResult names the refusal),
// but it is reported ~90 s into the run, after the boards have already been built. These helpers move
// the report to the front — before any physical work — with the remedy attached.
//
// The ID format is DUPLICATED here rather than imported. Importing it would mean reaching into
// dist/node, which is gitignored and not present in the plugin container where test/*.test.cjs runs;
// id-format-pin.test.mjs asserts the two producers still emit these exact templates instead.

/** Mirrors export-pipeline.lua:184 — `platform.name:gsub("[^%w%-]", "-")`. */
export function sanitizePlatformName(name) {
	return String(name).replace(/[^0-9A-Za-z-]/g, "-");
}

/** Mirrors export-pipeline.lua:189 — `string.format("%03d_%s", job_counter, safe_name)`. */
export function makeExportJobId(counter, platformName) {
	return `${String(counter).padStart(3, "0")}_${sanitizePlatformName(platformName)}`;
}

/** Mirrors shared/utils.ts makeCanonicalTransferId — `${sourceInstanceId}:${jobId}`. */
export function canonicalTransferId(instanceId, jobId) {
	return `${instanceId}:${jobId}`;
}

/**
 * The IDs a run is about to generate from `counter`, as a WINDOW rather than a point.
 *
 * The exact draw is not predictable: the counter is shared with import jobs
 * (import-pipeline.lua:44-45), so anything queued between the bump and the export shifts it. A window
 * that is too wide only risks a false positive, which the message below already handles honestly; a
 * point that is off by one misses the collision entirely.
 */
export function predictCanonicalIds({ instanceId, counter, platformName, count = 10 }) {
	const ids = [];
	for (let i = 1; i <= count; i++) {
		ids.push(canonicalTransferId(instanceId, makeExportJobId(counter + i, platformName)));
	}
	return ids;
}

/**
 * Ask the controller which transfer records it holds. Returns null — never throws — when the query
 * is unavailable, because a DIAGNOSTIC must not be able to fail the run it is diagnosing.
 */
export function fetchTransferSummaries({ limit = 200 } = {}) {
	let out;
	try {
		out = ctl("surface-export", "list-transfers", String(limit));
	} catch (error) {
		// Surfaced, not swallowed: an unavailable query is a legitimate degradation (an older
		// controller build, or a control token without surface_export.logs.view), but it must be
		// visible so "no collision reported" is never mistaken for "checked and clear".
		console.error(`preflight: transfer-registry query unavailable — ${error.message}`);
		return null;
	}
	// Take the last JSON-parsable line, not blindly the last line: --log-level error should keep
	// stdout clean, but this removes the dependency on that (the runBoard convention).
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

/**
 * Adjudicate predicted IDs against the controller's records. PURE — no I/O, so the decision table
 * below is unit-testable without a cluster.
 *
 * The certainty here is genuinely limited, and the messages must not overstate it:
 *   - `limit` windows the query, so an older settled record is invisible
 *   - activeTransfers is pruned above 100, so an evicted ID neither shows up NOR refuses
 * A CLEAR result therefore asserts nothing. Only a HIT asserts anything.
 *
 * And a hit is not enough on its own. `registrySource: "active"` means "the retry guard can SEE this
 * record" — NOT "the guard will refuse it". transferPlatform (transfer-orchestrator.ts:104-118) makes
 * a THREE-way decision on status, and only the third refuses:
 *
 *   LIVE_STATUSES     transporting / awaiting_validation / awaiting_completion / in_progress
 *                     -> idempotent success, the transfer is in flight. NOT refused.
 *   "failed"          -> the ONLY replaceable settled state: its rollback DISCARDED the destination,
 *                     so a re-run cannot duplicate. Explicitly replaced, and the orchestrator's own
 *                     comment names our exact case: "golden-save batches reset the Lua export
 *                     counter and legitimately regenerate identical IDs after a failure".
 *   anything else     completed / cleanup_failed / unknown -> REFUSED.
 *
 * This mattered immediately: the suite's refusal leg (step D) manufactures an active+failed record
 * on host 2's export ID on EVERY run. Treating any active hit as fatal would abort the next run of a
 * suite that was working perfectly — a false alarm stated in capitals, demanding a controller restart
 * nobody needed. Caught in review; the first version of this function did exactly that.
 */

/** Statuses transferPlatform treats as in-flight (transfer-orchestrator.ts:104-107). */
const LIVE_TRANSFER_STATUSES = new Set([
	"transporting", "awaiting_validation", "awaiting_completion", "in_progress",
]);

/** Would a record with this status actually make transferPlatform refuse a same-ID retry? */
function wouldRefuse(hit) {
	if (hit.registrySource !== "active") return false;   // the guard never reads the persisted log
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

	// Present and live-in-memory, but NOT refused. Worth saying out loud rather than reporting
	// "clear", because the ID really is taken — it just does not block.
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

	// Anything that is neither of the two known provenance values — undefined (an older controller
	// build) or a value added later — is UNKNOWN, not history. Defaulting an unrecognised value into
	// the reassuring branch is how a check starts lying by omission.
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

// LOADS a named save. It is NOT a restore: the named file is mutable (exit-save), so putting a world
// BACK means copying pristine bytes over it first — see RESTORE_ARTIFACTS / restoreLivePair.
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

	// Set the instant a load begins, so ANY later failure restores from the pinned artifacts. While it
	// is null the live pair has not been touched and there is nothing to restore.
	let restoreArtifacts = null;

	// The restore is IDEMPOTENT-BY-LATCH, and this is a data-loss guard, not tidiness.
	//
	// run-tests.mjs calls restoreLivePair from its `finally` AND again from `main().catch` — the
	// first swallows its own errors and never rethrows, so the original error keeps propagating and
	// both fire. Restore #1's rescue copy holds the PRE-SUITE live world (loadGoldenPair's exit-save),
	// which is the only copy of any hand-built pad not yet banked. Restore #2 then `rm -f`s that
	// rescue and re-copies the pristine artifact restore #1 had just written — i.e. it replaces the
	// irreplaceable with the reproducible. The loss this rescue exists to prevent (the 92,50 pairing
	// rig) happens anyway, one call later.
	//
	// The latch is separate from `restoreArtifacts` deliberately: nulling that would make the second
	// call print "golden pair never loaded; live pair untouched", which is a different and false
	// statement. Found in review; the trigger this change newly adds is the fatal collision preflight,
	// whose whole job is to throw early.
	let livePairRestored = false;

	async function loadGoldenPair(manifest, phase) {
		const repoRoot = REPO_ROOT;
		restoreArtifacts = { 1: manifest.saves.source.artifact, 2: manifest.saves.destination.artifact };
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
		// destination (transfer-orchestrator retry semantics, 2026-07-18). Raising the counter after
		// each load gives every batch run collision-free IDs without weakening that production guard.
		//
		// BOTH hosts, not just the forward-transfer source. This used to bump host 1 only, which left
		// the refusal leg — which transfers back FROM host 2 — generating deterministic IDs. Any
		// earlier host-2 transfer of the same platform (a manual one while debugging, or a previous
		// run) settles that ID as `completed` in the controller's activeTransfers, which survives a
		// save reset because it is in-memory on the controller while the export counter lives in the
		// save. The refusal leg is then refused for the WRONG reason, produces no import at all, and
		// the wait below times out 240 s later blaming a missing file. Measured 2026-07-31, and the
		// cluster log shows the same collision on 2026-07-29 and 07-30.
		//
		// The bump is a monotone FLOOR, not the modular offset it used to be — see exportIdFloor for
		// why `% 1_000_000` made these collisions recur on a 16m40s cycle rather than be one-offs.
		// One floor for both hosts, so they land on a shared base a preflight can predict from.
		const floor = exportIdFloor();
		const counters = {};
		for (const host of [1, 2]) counters[host] = bumpExportIdCounter(host, floor);
		return counters;
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
		} catch (error) {
			// A failed docker exec (container down, instance mid-restart) must not read as a quiet
			// "no new files yet" — the caller's poll would then time out blaming the wrong thing.
			console.error(`filesNewerThanMarker(host ${host}): ${error.message}`);
			return [];
		}
	}

	// Count transfer-failure lines in the cluster-aggregated log. A REFUSED transfer never reaches the
	// destination, so it produces no debug_import_result at all — and the wait below would otherwise
	// sit out its full timeout and then blame a missing file, which is the symptom, not the cause.
	//
	// Counting lines rather than comparing timestamps is deliberate: these JSON logs are
	// batch-flushed, so a "timestamp" is flush time and cannot order events within a run.
	//
	// Provenance: the message is emitted by the SOURCE INSTANCE plugin and merely lands in the
	// controller's aggregated log — do not report it as something the controller said.
	//
	// Scope, honestly: this is cluster-global. It filters by neither instance nor platform nor
	// transfer id, so an unrelated transfer failing during the wait would abort with a confident but
	// wrong diagnosis. Acceptable here because the suite owns the cluster for the run and is
	// strictly sequential. If date-rotated files are pruned mid-wait the count can DROP, which loses
	// detection rather than inventing one — the timeout stays the backstop.
	function transferFailureLines() {
		try {
			const out = docker(["exec", CONTROLLER, "sh", "-c",
				"grep -h 'Transfer failed:' /clusterio/logs/cluster/cluster-*.log 2>/dev/null || true"]);
			return out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
		} catch (error) {
			// Never let a log-read problem masquerade as "no refusal happened" — say so and let the
			// caller's own timeout be the gate.
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
				// The file may be mid-write when first seen — retry the read on a parse failure. A
				// PERSISTENT failure (truncated or corrupt JSON) surfaces in the timeout error below.
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

	// The unconditional restore finalizer body: capture evidence FIRST, restore the pre-batch live
	// saves, remove the temporary golden save files with filesystem proof, clean up markers, and prove
	// the release lease is clean. Writes results.goldenSessionLogTails + results.restored onto the
	// passed results (renderNotebook reads them); pushes a RESTORE-FAILED line onto boundaryErrors.
	async function restoreLivePair(results, boundaryErrors) {
		try {
			if (!restoreArtifacts) {
				// The golden pair never loaded, so the live pair was never displaced. Restoring
				// anyway would restart both instances for nothing.
				results.restored = { skipped: "golden pair never loaded; live pair untouched" };
				return;
			}
			if (livePairRestored) {
				// Second call in the same run — see the latch's declaration. Running the rescue block
				// again would DELETE the pre-suite rescue and replace it with a copy of the pristine
				// artifact the first call just wrote.
				results.restored = { skipped: "live pair already restored this run; refusing to re-run "
					+ "the rescue-and-overwrite (it would destroy the pre-suite rescue save)" };
				return;
			}
			livePairRestored = true;
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
			// Release the pair by rewriting the live saves from their PRISTINE artifacts. Re-assigning
			// by name (assignSave) restores NOTHING once the batch consumed the world. Bytes first,
			// then start; the content is read back AFTER cleanup so a bad restore cannot also leak
			// the golden saves.
			ctl("instance", "stop", HOSTS[1].instance);
			ctl("instance", "stop", HOSTS[2].instance);
			// RESCUE BEFORE OVERWRITE (review must-fix 5, mirroring bc68a5e in patch-and-reset): the
			// live save at this point holds the exit-save from loadGoldenPair's stop — i.e. the live
			// world as of suite start, which is the ONLY copy of any owner hand-built pad not yet
			// banked into the seed. Overwriting it with the pinned artifact without a copy-aside
			// destroyed exactly that once (the 92,50 pairing rig). The predeploy- prefix is what
			// patch-and-reset's save-clearing preserves; only the latest rescue is kept per host.
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
			// NOTE: stopping a golden session re-saves its file (Factorio saves on exit), so the
			// rm must come AFTER the restore-assign; the proof reads the FILESYSTEM (the
			// controller's `save list` is a cache that can list a deleted file).
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
			// TEETH, last: the displacement was SILENT because nothing read the restored world's
			// CONTENT. Checked after cleanup so a stale artifact cannot also leak the golden saves.
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
		// runner-specific config echoed for reference
		goldenSourceSave, goldenDestSave, markerPrefix,
		// generic constants
		CONTROLLER, CTL_CONFIG, HOSTS, RESTORE_SAVES, FLUID_EPSILON, DOUBLE_EPSILON,
		// generic primitives
		sleep, lastLine, docker, ctl, rcon, lua, instanceIds, instancePath,
		preflightState, assertLeaseClean, loadedSave, waitReady, assignSave, readContainerJson,
		// export-ID uniquifier + canonical-ID collision preflight (run-shape-agnostic; the CALLER
		// decides how many transfers it makes and from which host, so it composes these itself)
		exportIdFloor, bumpExportIdCounter,
		sanitizePlatformName, makeExportJobId, canonicalTransferId,
		predictCanonicalIds, fetchTransferSummaries, checkTransferIdCollisions,
		// config-bound lifecycle
		loadGoldenPair, dropMarker, filesNewerThanMarker, waitForImportResult, restoreLivePair,
	};
}
