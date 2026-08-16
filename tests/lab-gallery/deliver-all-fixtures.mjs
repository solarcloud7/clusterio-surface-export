#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
	CONTROLLER, CTL_CONFIG, bumpExportIdCounter, docker, lastLine, lua, rcon, sleep,
} from "./batch-lifecycle.mjs";

const GALLERY_INSTANCE = "surface-export-lab-gallery";
const GALLERY_INSTANCE_ID = 907164846;
const GALLERY_CONTAINER = "surface-export-host-2";
const HOST1_INSTANCE = "clusterio-host-1-instance-1";
const HOST1_CONTAINER = "surface-export-host-1";
const HOST1_SAVES = `/clusterio/data/instances/${HOST1_INSTANCE}/saves`;
const DELIVER_SAVE = "lab-gallery-deliver-all.zip";
const RESTORE_SAVE = "lab-gallery-source.zip";
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MANIFEST = "tests/lab-gallery/manifest.json";

const PER_PLATFORM_TIMEOUT_MS = 300_000;
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

function galleryLua(body) {
	const command = `/sc local ok,result=pcall(function() ${body} end); ` +
		`if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	const raw = lastLine(galleryRcon(command));
	try { return JSON.parse(raw); }
	catch (error) { throw new Error(`Invalid gallery Lua JSON: ${raw}\n${error.message}`); }
}

function platformsOnHost1() {
	const reading = lua(1, `local o={}; for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid then o[p.name]=p.index end end; return {success=true,platforms=o}`);
	if (reading.success === false) throw new Error(`host-1 platform list failed: ${reading.error}`);
	return reading.platforms || {};
}

function resolveHost1Index(name) {
	const reading = lua(1, `local idx,count; for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and p.name=='${name}' then count=(count or 0)+1; idx=p.index end end; ` +
		`if not idx then return {success=true,present=false} end; ` +
		`return {success=true,present=true,index=idx,ambiguous=(count>1)}`);
	if (reading.success === false) throw new Error(`index lookup for ${name} failed: ${reading.error}`);
	return reading;
}

function sourceStillPresent(name) {
	const reading = lua(1, `local present=false; for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and p.name=='${name}' then present=true end end; return {success=true,present=present}`);
	if (reading.success === false) throw new Error(`source presence check for ${name} failed: ${reading.error}`);
	return reading.present;
}

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

function loadManifest() {
	return JSON.parse(readFileSync(`${REPO_ROOT}${MANIFEST}`, "utf8"));
}

function manifestCensusMap(manifest) {
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

async function deliverOne(name, expectedEntities) {
	const outcome = { name, expectedEntities, startedMs: Date.now() };
	try {
		const resolved = resolveHost1Index(name);
		if (!resolved.present) throw new Error(`not present on host-1 (already delivered or absent)`);
		if (resolved.ambiguous) throw new Error(`ambiguous: multiple platforms named ${name} on host-1`);
		outcome.index = resolved.index;

		outcome.transferCommand = lastLine(rcon(1, `/transfer-platform ${resolved.index} ${GALLERY_INSTANCE_ID}`));

		const deadline = Date.now() + PER_PLATFORM_TIMEOUT_MS;
		let committed = false;
		let lastCensus = { present: false };
		while (Date.now() < deadline) {
			await sleep(ARRIVAL_POLL_MS);
			lastCensus = galleryCensus(name);
			const srcGone = !sourceStillPresent(name);
			if (lastCensus.present && lastCensus.entities > 0 && srcGone) { committed = true; break; }
			if (srcGone && !lastCensus.present) {
				throw new Error(`source deleted but platform absent on gallery — dest discarded (gate failure)`);
			}
		}
		if (!committed) throw new Error(`no committed arrival within ${PER_PLATFORM_TIMEOUT_MS / 1000} s ` +
			`(gallery present=${lastCensus.present}, source still present=${sourceStillPresent(name)})`);

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
	const manifest = loadManifest();
	const manifestMap = manifestCensusMap(manifest);
	const goldenSource = manifest.saves.source.artifact;
	summary.goldenSource = goldenSource;

	const alreadyOnGallery = new Set(galleryPlatformNames());
	summary.galleryBefore = [...alreadyOnGallery];

	let displaced = false;
	try {
		ctl("instance", "stop", HOST1_INSTANCE);
		displaced = true;
		docker(["cp", `${REPO_ROOT}${goldenSource}`, `${HOST1_CONTAINER}:${HOST1_SAVES}/${DELIVER_SAVE}`],
			{ timeout: 180_000 });
		ctl("instance", "start", HOST1_INSTANCE, "--save", DELIVER_SAVE);
		await waitHost1Ready();

		summary.counterBumpedTo = bumpExportIdCounter(1);

		const sourcePlatforms = platformsOnHost1();
		summary.goldenSourcePlatforms = Object.keys(sourcePlatforms).sort();
		const toDeliver = Object.keys(sourcePlatforms).filter(name => !alreadyOnGallery.has(name)).sort();
		summary.toDeliver = toDeliver;

		for (const name of toDeliver) {
			const outcome = await deliverOne(name, manifestMap[name]);
			summary.deliveries.push(outcome);
		}
	} finally {
		if (displaced) {
			ctl("instance", "stop", HOST1_INSTANCE);
			ctl("instance", "start", HOST1_INSTANCE, "--save", RESTORE_SAVE);
			docker(["exec", HOST1_CONTAINER, "sh", "-c", `rm -f -- ${HOST1_SAVES}/${DELIVER_SAVE}`]);
			docker(["exec", HOST1_CONTAINER, "test", "!", "-e", `${HOST1_SAVES}/${DELIVER_SAVE}`]);
			summary.host1Restored = RESTORE_SAVE;
			try { await waitHost1Ready(); } catch (error) { summary.host1RestoreWaitError = error.message; }
		}
	}

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
