#!/usr/bin/env node
// Full-corpus delivery wave: ship EVERY fixture platform from the committed golden source save to
// the LIVE gallery instance via the plugin's own /transfer-platform, so the whole lab family lands
// on the game map the owner is playing on. Sibling of deliver-omnibus.mjs (which delivers only the
// one omnibus platform); this one enumerates the golden source, subtracts what the gallery already
// holds, and delivers the difference sequentially — one platform at a time, polling each for a
// COMMITTED arrival (gallery-present + source-deleted) before starting the next.
//
//   node tests/lab-gallery/deliver-all-fixtures.mjs
//
// Sequence: displace host-1 onto the committed golden source (stop -> docker cp -> start --save),
// bump the export-ID counter ONCE (the deterministic golden counter regenerates identical IDs every
// load; the settled-retry guard correctly refuses a reused ID — measured 2026-07-19; each export job
// self-increments from the bumped base, so one bump covers the whole wave), then per missing platform:
// resolve its per-force index by NAME (tooling boundary), /transfer-platform to the gallery, poll for
// a two-phase-committed arrival, light census. Per-platform failures are captured (cluster-*.log
// evidence + best-effort unlock) and DO NOT abort the wave. Finally: restore host-1 to test1.zip and
// remove the temp golden save with filesystem proof (unconditional finalizer). The gallery (host-2)
// is NEVER stopped/started/loaded — arrivals via transfer are the whole point.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CONTROLLER, CTL_CONFIG, docker, lastLine, lua, rcon, sleep } from "./batch-lifecycle.mjs";

const GALLERY_INSTANCE = "surface-export-lab-gallery";
const GALLERY_INSTANCE_ID = 907164846;
const GALLERY_CONTAINER = "surface-export-host-2";
const HOST1_INSTANCE = "clusterio-host-1-instance-1";
const HOST1_CONTAINER = "surface-export-host-1";
const HOST1_SAVES = `/clusterio/data/instances/${HOST1_INSTANCE}/saves`;
const DELIVER_SAVE = "lab-gallery-deliver-all.zip";
const RESTORE_SAVE = "test1.zip";
const GOLDEN_SOURCE = "docker/seed-data/lab-saves/lab-gallery-source-surface-export-2.0.77.zip";
const MANIFEST = "tests/lab-gallery/manifest.json";

const PER_PLATFORM_TIMEOUT_MS = 300_000; // small platforms clear in ~60-90 s; census-fusion is novel
const ARRIVAL_POLL_MS = 8000;

function ctl(...args) {
	return docker(["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"--config", CTL_CONFIG, ...args], { timeout: 180_000 });
}

function galleryRcon(command) {
	return docker(["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", GALLERY_INSTANCE, command, "--config", CTL_CONFIG],
	{ timeout: 180_000 }).trim();
}

// JSON-wrapped Lua op against the GALLERY instance (same convention as batch-lifecycle.lua).
function galleryLua(body) {
	const command = `/sc local ok,result=pcall(function() ${body} end); ` +
		`if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	const raw = lastLine(galleryRcon(command));
	try { return JSON.parse(raw); }
	catch (error) { throw new Error(`Invalid gallery Lua JSON: ${raw}\n${error.message}`); }
}

// name -> per-force index for every valid platform on `game.forces.player.platforms` of a host.
function platformsOnHost1() {
	const reading = lua(1, `local o={}; for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid then o[p.name]=p.index end end; return {success=true,platforms=o}`);
	if (reading.success === false) throw new Error(`host-1 platform list failed: ${reading.error}`);
	return reading.platforms || {};
}

// Resolve ONE platform's index by name on host-1, fail loud on absent/ambiguous (tooling boundary).
function resolveHost1Index(name) {
	const reading = lua(1, `local idx,count; for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and p.name=='${name}' then count=(count or 0)+1; idx=p.index end end; ` +
		`if not idx then return {success=true,present=false} end; ` +
		`return {success=true,present=true,index=idx,ambiguous=(count>1)}`);
	if (reading.success === false) throw new Error(`index lookup for ${name} failed: ${reading.error}`);
	return reading;
}

// Whether a named platform is still present on host-1 (source-deleted => two-phase commit finished).
function sourceStillPresent(name) {
	const reading = lua(1, `local present=false; for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and p.name=='${name}' then present=true end end; return {success=true,present=present}`);
	if (reading.success === false) throw new Error(`source presence check for ${name} failed: ${reading.error}`);
	return reading.present;
}

// name+entity census of a named platform on the GALLERY.
function galleryCensus(name) {
	const reading = galleryLua(`local surf,count; for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and p.name=='${name}' then count=(count or 0)+1; surf=p.surface end end; ` +
		`if not surf then return {success=true,present=false} end; ` +
		`return {success=true,present=true,ambiguous=(count>1),entities=#surf.find_entities_filtered{}}`);
	if (reading.success === false) throw new Error(`gallery census for ${name} failed: ${reading.error}`);
	return reading;
}

function galleryPlatformNames() {
	const reading = galleryLua(`local o={}; for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid then o[#o+1]=p.name end end; return {success=true,names=o}`);
	if (reading.success === false) throw new Error(`gallery platform list failed: ${reading.error}`);
	return reading.names || [];
}

// Transient plugin-state leftovers on a host (jobs/locks/holds/tombstones must all be zero post-wave).
function leftovers(runLua) {
	const reading = runLua(`local function n(t) return table_size(t or {}) end; ` +
		`return {success=true,jobs=n(storage.async_jobs),locks=n(storage.locked_platforms),` +
		`holds=n(storage.destination_holds),tombstones=n(storage.committed_source_transfer_tombstones)}`);
	if (reading.success === false) return { error: reading.error };
	return { jobs: reading.jobs, locks: reading.locks, holds: reading.holds, tombstones: reading.tombstones };
}

async function waitHost1Ready(timeoutMs = 180_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const state = lua(1, `return {success=true,plugin=remote.interfaces['surface_export']~=nil}`);
			if (state.success && state.plugin) return;
			lastError = new Error(`plugin not ready: ${JSON.stringify(state)}`);
		} catch (error) { lastError = error; }
		await sleep(3000);
	}
	throw new Error(`host-1 did not become RCON-ready: ${lastError?.message}`);
}

// Manifest source census: platformName -> entityCount (INFORMATIONAL — never a hard gate; the manifest
// counts differently from find_entities_filtered{}, so equality would false-fail small platforms).
function manifestCensusMap() {
	const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
	const manifest = JSON.parse(readFileSync(`${repoRoot}${MANIFEST}`, "utf8"));
	const map = {};
	for (const s of manifest.saves.source.expectedCensus.surfaces) {
		if (s.platform) map[s.platform] = s.entityCount;
	}
	return map;
}

function captureFailureEvidence(name) {
	try {
		return docker(["exec", CONTROLLER, "sh", "-c",
			`cat /clusterio/logs/cluster/cluster-*.log 2>/dev/null | grep -a '${name}' | tail -25`],
		{ maxBuffer: 32 * 1024 * 1024 }).trim() || "(no cluster-log lines mentioning the platform)";
	} catch (error) { return `evidence capture failed: ${error.message}`; }
}

// Deliver ONE platform: resolve index, transfer, poll for a committed arrival, census. Returns an
// outcome record; NEVER throws (a novel-payload red must not skip the rest of the wave).
async function deliverOne(name, expectedEntities) {
	const outcome = { name, expectedEntities, startedMs: Date.now() };
	try {
		const resolved = resolveHost1Index(name);
		if (!resolved.present) throw new Error(`not present on host-1 (already delivered or absent)`);
		if (resolved.ambiguous) throw new Error(`ambiguous: multiple platforms named ${name} on host-1`);
		outcome.index = resolved.index;

		outcome.transferCommand = lastLine(rcon(1, `/transfer-platform ${resolved.index} ${GALLERY_INSTANCE_ID}`));

		// Poll for a TWO-PHASE-COMMITTED arrival: the gallery holds the platform (entities>0) AND the
		// source is deleted on host-1. Source deletion happens ONLY after the dest gate validates and
		// commits, so it is the unambiguous success signal that survives the black-box-discard timing
		// (an arrival seen mid-import can still be discarded on gate-fail; a deleted source cannot).
		const deadline = Date.now() + PER_PLATFORM_TIMEOUT_MS;
		let committed = false;
		let lastCensus = { present: false };
		while (Date.now() < deadline) {
			await sleep(ARRIVAL_POLL_MS);
			lastCensus = galleryCensus(name);
			const srcGone = !sourceStillPresent(name);
			if (lastCensus.present && lastCensus.entities > 0 && srcGone) { committed = true; break; }
			if (srcGone && !lastCensus.present) {
				// Source committed-away but the dest is absent = discarded on gate-fail. Stop early.
				throw new Error(`source deleted but platform absent on gallery — dest discarded (gate failure)`);
			}
		}
		if (!committed) throw new Error(`no committed arrival within ${PER_PLATFORM_TIMEOUT_MS / 1000} s ` +
			`(gallery present=${lastCensus.present}, source still present=${sourceStillPresent(name)})`);

		// Settle + re-confirm the platform PERSISTS (guards against a late discard just after commit).
		await sleep(5000);
		const settled = galleryCensus(name);
		if (!settled.present || !(settled.entities > 0)) {
			throw new Error(`platform vanished after commit (present=${settled.present}, entities=${settled.entities})`);
		}

		outcome.status = "delivered";
		outcome.arrivalEntities = settled.entities;
		outcome.transferSeconds = Math.round((Date.now() - outcome.startedMs) / 1000);
	} catch (error) {
		outcome.status = "failed";
		outcome.error = error.message;
		outcome.transferSeconds = Math.round((Date.now() - outcome.startedMs) / 1000);
		outcome.evidence = captureFailureEvidence(name);
		// Best-effort unlock so a preserved-and-locked source does not strand a leftover.
		if (outcome.index !== undefined) {
			try {
				const unlocked = lua(1, `remote.call('surface_export','unlock_platform', ${outcome.index}); ` +
					`return {success=true}`);
				outcome.unlockAttempted = unlocked.success !== false;
			} catch (unlockError) { outcome.unlockError = unlockError.message; }
		}
	}
	return outcome;
}

async function main() {
	const summary = { started: new Date().toISOString(), deliveries: [] };
	const manifestMap = manifestCensusMap();

	// What the gallery already holds (skip set) — computed BEFORE displacing host-1.
	const alreadyOnGallery = new Set(galleryPlatformNames());
	summary.galleryBefore = [...alreadyOnGallery];

	let displaced = false;
	try {
		// Displace host-1 onto the committed golden source (stop FIRST — stopping exit-saves the running
		// world into its started-from file, never into our fresh copy).
		ctl("instance", "stop", HOST1_INSTANCE);
		displaced = true;
		const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
		docker(["cp", `${repoRoot}${GOLDEN_SOURCE}`, `${HOST1_CONTAINER}:${HOST1_SAVES}/${DELIVER_SAVE}`],
			{ timeout: 180_000 });
		ctl("instance", "start", HOST1_INSTANCE, "--save", DELIVER_SAVE);
		await waitHost1Ready();

		// Export-ID uniquifier (ONCE — jobs self-increment from the bumped base over the whole wave).
		const offset = 500 + (Date.now() % 100_000);
		const bumped = lua(1, `storage.async_job_id_counter=(storage.async_job_id_counter or 0)+${offset};` +
			`return {success=true,counter=storage.async_job_id_counter}`);
		if (bumped.success === false) throw new Error(`export-ID uniquifier failed: ${bumped.error}`);
		summary.counterBumpedTo = bumped.counter;

		// The delivery set = golden-source platforms MINUS what the gallery already holds.
		const sourcePlatforms = platformsOnHost1();
		summary.goldenSourcePlatforms = Object.keys(sourcePlatforms).sort();
		const toDeliver = Object.keys(sourcePlatforms).filter(name => !alreadyOnGallery.has(name)).sort();
		summary.toDeliver = toDeliver;

		// Sequential delivery — one at a time, committed-arrival gated, per-platform failures contained.
		for (const name of toDeliver) {
			const outcome = await deliverOne(name, manifestMap[name]);
			summary.deliveries.push(outcome);
		}
	} finally {
		// Unconditional restore: land host-1 back on test1.zip and PROVE the temp save is gone.
		if (displaced) {
			ctl("instance", "stop", HOST1_INSTANCE);
			ctl("instance", "start", HOST1_INSTANCE, "--save", RESTORE_SAVE);
			docker(["exec", HOST1_CONTAINER, "sh", "-c", `rm -f -- ${HOST1_SAVES}/${DELIVER_SAVE}`]);
			docker(["exec", HOST1_CONTAINER, "test", "!", "-e", `${HOST1_SAVES}/${DELIVER_SAVE}`]);
			summary.host1Restored = RESTORE_SAVE;
			try { await waitHost1Ready(); } catch (error) { summary.host1RestoreWaitError = error.message; }
		}
	}

	// Post-wave state: the final gallery platform list + zero-leftover check on BOTH ends (the gallery
	// is the load-bearing side — host-2 is never restored, so its leftovers are the ones that matter;
	// host-1 was just restored to test1.zip which wipes any mid-wave locks/jobs/holds there).
	summary.galleryAfter = galleryPlatformNames().sort();
	summary.galleryPlatformCount = summary.galleryAfter.length;
	summary.leftovers = { gallery: leftovers(galleryLua), host1: leftovers(body => lua(1, body)) };
	summary.finished = new Date().toISOString();

	const delivered = summary.deliveries.filter(d => d.status === "delivered").length;
	const failed = summary.deliveries.filter(d => d.status === "failed").length;
	summary.tally = { attempted: summary.deliveries.length, delivered, failed };
	console.log(JSON.stringify(summary, null, 2));
	if (failed > 0) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
