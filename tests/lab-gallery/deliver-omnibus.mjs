#!/usr/bin/env node
// One-command delivery of the golden omnibus platform (lab-omnibus-state-v1) to the user's
// GALLERY instance — replaces the hand ritual paid for on 2026-07-18/19 (two manual deliveries,
// each needing label redraw, panel repair, walkway fill, proxy hand-restore). The serializer now
// carries proxies and display panels natively, so post-delivery finishing is down to the ONE
// thing the engine cannot transfer: rendering texts (the pad name labels are script state).
//
// Modes:
//   node tests/lab-gallery/deliver-omnibus.mjs                # full delivery (refuses if the
//                                                             # gallery already holds the platform)
//   node tests/lab-gallery/deliver-omnibus.mjs --replace      # delete the gallery copy first
//                                                             # (refuses if a player stands on it)
//   node tests/lab-gallery/deliver-omnibus.mjs --refresh-only # no transfer: redraw missing labels
//                                                             # + fill walkway gaps, idempotent
//
// Full-delivery sequence: displace host-1 onto the committed golden source (stop -> docker cp ->
// start --save), bump the export-ID counter (the settled-retry guard correctly refuses a reused
// deterministic ID — measured 2026-07-19), production /transfer-platform to the gallery, poll for
// arrival, redraw the manifest's pad labels, ASSERT the manifest-pinned census + 1
// item-request-proxy (assert, never repair — a shortfall is a serializer regression), then restore
// host-1 to test1.zip and remove the temp save with filesystem proof.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CONTROLLER, CTL_CONFIG, docker, lastLine, lua, rcon, sleep } from "./batch-lifecycle.mjs";

const GALLERY_INSTANCE = "surface-export-lab-gallery";
const GALLERY_INSTANCE_ID = 907164846;
const PLATFORM = "lab-omnibus-state-v1";
const HOST1_INSTANCE = "clusterio-host-1-instance-1";
const HOST1_CONTAINER = "surface-export-host-1";
const HOST1_SAVES = `/clusterio/data/instances/${HOST1_INSTANCE}/saves`;
const DELIVER_SAVE = "lab-gallery-deliver.zip";
const RESTORE_SAVE = "test1.zip";
const GOLDEN_SOURCE = "docker/seed-data/lab-saves/lab-gallery-source-surface-export-2.0.77.zip";

// The pad grid (hub-adjacent, pitch 28x14); name labels live at origin+(6,-1.5).
// Single-sourced from the manifest (padKind === "pad" carries origin) — never hardcode the roster.
const MANIFEST = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const PADS = MANIFEST.fixtures
	.filter((f) => f.padKind === "pad" && f.origin)
	.map((f) => [f.id, f.origin.x, f.origin.y]);

function ctl(...args) {
	return docker(["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"--config", CTL_CONFIG, ...args], { timeout: 180_000 });
}

function galleryRcon(command) {
	return docker(["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", GALLERY_INSTANCE, command, "--config", CTL_CONFIG],
	{ timeout: 180_000 }).trim();
}

// JSON-wrapped Lua op against the GALLERY instance (same convention as batch-lifecycle.lua —
// never used where an error must be silent).
function galleryLua(body) {
	const command = `/sc local ok,result=pcall(function() ${body} end); ` +
		`if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	const raw = lastLine(galleryRcon(command));
	try { return JSON.parse(raw); }
	catch (error) { throw new Error(`Invalid gallery Lua JSON: ${raw}\n${error.message}`); }
}

// Lua snippet resolving the omnibus SURFACE on the gallery (fails loud when absent/ambiguous).
const FIND_SURFACE = `local surf,count; for _,p in pairs(game.forces.player.platforms) do ` +
	`if p.valid and p.name=='${PLATFORM}' then count=(count or 0)+1; surf=p.surface end end; ` +
	`if not surf then error('${PLATFORM} not on the gallery') end; ` +
	`if count>1 then error('ambiguous: '..count..' platforms named ${PLATFORM}') end;`;

function galleryPlatformCount() {
	const reading = galleryLua(`local n=0; for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and p.name=='${PLATFORM}' then n=n+1 end end; return {success=true,count=n}`);
	if (reading.success === false) throw new Error(`gallery platform count failed: ${reading.error}`);
	return reading.count;
}

// Redraw the pad name labels; a text object already targeting the exact position is kept
// (idempotent — a rerun draws nothing).
function redrawLabels() {
	const padsLua = PADS.map(([id, ox, oy]) => `{'${id}',${ox},${oy}}`).join(",");
	const reading = galleryLua(`${FIND_SURFACE} local pads={${padsLua}}; local drew=0; ` +
		`for _,pad in ipairs(pads) do local tx,ty=pad[2]+6,pad[3]-1.5; local has=false; ` +
		`for _,o in pairs(rendering.get_all_objects()) do ` +
		`if o.valid and o.type=='text' and o.surface==surf then local t=o.target and o.target.position; ` +
		`if t and t.x==tx and t.y==ty then has=true break end end end; ` +
		`if not has then rendering.draw_text({text=pad[1],surface=surf,target={tx,ty},scale=2.5,` +
		`color={r=0.3,g=0.85,b=1,a=1}}); drew=drew+1 end end; ` +
		`return {success=true,labels_drawn=drew}`);
	if (reading.success === false) throw new Error(`label redraw failed: ${reading.error}`);
	return reading.labels_drawn;
}

// Fill walkway gaps (empty-space -> plain foundation over the pad grid's bounding region) so the
// grid stays one walkable island. Idempotent.
function fillWalkways() {
	const reading = galleryLua(`${FIND_SURFACE} local tiles={}; for x=4,124 do for y=-24,36 do ` +
		`if surf.get_tile(x,y).name=='empty-space' then ` +
		`tiles[#tiles+1]={name='space-platform-foundation',position={x,y}} end end end; ` +
		`if #tiles>0 then surf.set_tiles(tiles) end; return {success=true,tiles_filled=#tiles}`);
	if (reading.success === false) throw new Error(`walkway fill failed: ${reading.error}`);
	return reading.tiles_filled;
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

async function fullDelivery(replace) {
	const summary = { mode: replace ? "replace" : "deliver", started: new Date().toISOString() };

	const existing = galleryPlatformCount();
	if (existing > 0 && !replace) {
		throw new Error(`gallery already holds ${PLATFORM} — rerun with --replace to swap it out`);
	}
	if (existing > 0) {
		const deleted = galleryLua(`${FIND_SURFACE} ` +
			`for _,pl in pairs(game.connected_players) do if pl.surface==surf then ` +
			`error('a connected player is standing on ${PLATFORM} — refusing to delete') end end; ` +
			`game.delete_surface(surf); return {success=true,deleted=true}`);
		if (deleted.success === false) throw new Error(`replace refused: ${deleted.error}`);
		summary.replacedExisting = true;
	}

	// Displace host-1 onto the committed golden source (stop FIRST — stopping exit-saves the
	// running world into its started-from file, never into our fresh copy).
	let displaced = false;
	try {
		ctl("instance", "stop", HOST1_INSTANCE);
		displaced = true;
		const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
		docker(["cp", `${repoRoot}${GOLDEN_SOURCE}`, `${HOST1_CONTAINER}:${HOST1_SAVES}/${DELIVER_SAVE}`],
			{ timeout: 180_000 });
		ctl("instance", "start", HOST1_INSTANCE, "--save", DELIVER_SAVE);
		await waitHost1Ready();

		// Export-ID uniquifier: the golden world's deterministic job counter regenerates IDENTICAL
		// export IDs every load, and the controller refuses a settled-ID retry (by design).
		const offset = 500 + (Date.now() % 100_000);
		const bumped = lua(1, `storage.async_job_id_counter=(storage.async_job_id_counter or 0)+${offset};` +
			`return {success=true,counter=storage.async_job_id_counter}`);
		if (bumped.success === false) throw new Error(`export-ID uniquifier failed: ${bumped.error}`);

		const found = lua(1, `local idx,count; for _,p in pairs(game.forces.player.platforms) do ` +
			`if p.valid and p.name=='${PLATFORM}' then count=(count or 0)+1; idx=p.index end end; ` +
			`if not idx then error('${PLATFORM} not in the golden source') end; ` +
			`if count>1 then error('ambiguous: '..count..' platforms named ${PLATFORM}') end; ` +
			`return {success=true,index=idx}`);
		if (found.success === false) throw new Error(`platform lookup failed: ${found.error}`);
		summary.sourcePlatformIndex = found.index;

		summary.transferCommand = lastLine(rcon(1, `/transfer-platform ${found.index} ${GALLERY_INSTANCE_ID}`));

		const deadline = Date.now() + 400_000;
		let arrived = false;
		while (Date.now() < deadline) {
			if (galleryPlatformCount() === 1) { arrived = true; break; }
			await sleep(10_000);
		}
		if (!arrived) throw new Error("platform did not arrive on the gallery within 400 s");

		// Finishing: labels are the one thing the engine cannot transfer (rendering = script state).
		summary.labelsDrawn = redrawLabels();
		summary.walkwayTilesFilled = fillWalkways();

		// ASSERT fidelity — never repair. The serializer carries proxies + display panels natively
		// now; a shortfall here is a regression, and repairing it would hide the evidence.
		const census = galleryLua(`${FIND_SURFACE} ` +
			`return {success=true,entities=#surf.find_entities_filtered{},` +
			`proxies=#surf.find_entities_filtered({type='item-request-proxy'})}`);
		if (census.success === false) throw new Error(`arrival census failed: ${census.error}`);
		summary.arrivalCensus = census;
		if (census.entities !== 123) throw new Error(`delivered platform has ${census.entities} entities, expected 123`);
		if (census.proxies !== 1) throw new Error(`delivered platform has ${census.proxies} proxies, expected 1 — serializer regression`);
	} finally {
		// Restore host-1 unconditionally once displaced; the temp save must be provably gone.
		if (displaced) {
			ctl("instance", "stop", HOST1_INSTANCE);
			ctl("instance", "start", HOST1_INSTANCE, "--save", RESTORE_SAVE);
			docker(["exec", HOST1_CONTAINER, "sh", "-c", `rm -f -- ${HOST1_SAVES}/${DELIVER_SAVE}`]);
			docker(["exec", HOST1_CONTAINER, "test", "!", "-e", `${HOST1_SAVES}/${DELIVER_SAVE}`]);
			summary.host1Restored = RESTORE_SAVE;
		}
	}
	summary.finished = new Date().toISOString();
	return summary;
}

function refreshOnly() {
	return {
		mode: "refresh-only",
		labelsDrawn: redrawLabels(),
		walkwayTilesFilled: fillWalkways(),
	};
}

async function main() {
	const args = process.argv.slice(2);
	for (const arg of args) {
		if (arg !== "--replace" && arg !== "--refresh-only") throw new Error(`unknown argument ${arg}`);
	}
	if (args.includes("--refresh-only") && args.includes("--replace")) {
		throw new Error("--refresh-only and --replace are mutually exclusive");
	}
	const summary = args.includes("--refresh-only")
		? refreshOnly()
		: await fullDelivery(args.includes("--replace"));
	console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
