#!/usr/bin/env node
// no-tick-sync-lab B8 — the owning batch runner for the gallery fixture `no-tick-sync-frozen-pair`.
//
// The single-use baked-fixture BATCH LIFECYCLE (docs/lab-tests.md, shared plumbing in
// tests/lab-gallery/batch-lifecycle.mjs) proves the fixture's testCard law from the SAVE-LOADED world:
//
//   LAW  The synchronous held-item pass (ActiveStateRestoration.restore_held_items_only) leaves
//        game.tick, crafting_progress, and the machine input UNCHANGED while it seats the inserter
//        hand, and both entities stay inactive — reproduced from a save-loaded golden world (the bake
//        gate exists because a built-at-runtime world and a save-loaded world are not automatically
//        identical).
//   STRONGEST FORM  measure once normally (fresh seating), then again under game.tick_paused=true.
//
// Only the SOURCE fixture matters here (no transfer), but the pair is still loaded per the lifecycle.
//
// Two-run asymmetry (handled explicitly): run 1 SEATS the hand; a second measurement in the same
// golden load finds the hand already full, so restore_held_items_only's `have < want` guard skips it —
// restored==0, seated_full==false BY CONSTRUCTION. Run 2 therefore asserts the hand STAYS full +
// everything unchanged, NOT a fresh seating.
//
// Usage:
//   node tests/no-tick-sync-lab/run-b8-baked-pair.mjs                # full batch, appends NOTEBOOK
//   node tests/no-tick-sync-lab/run-b8-baked-pair.mjs --no-notebook  # debug iteration
//   node tests/no-tick-sync-lab/run-b8-baked-pair.mjs --sections=preflight,load,measure
//   node tests/no-tick-sync-lab/run-b8-baked-pair.mjs --restore-only # finalizer alone
//
// A "passed" claim requires TWO consecutive full green runs (CLAUDE.md probe rule 8).

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createBatchLifecycle, DOUBLE_EPSILON } from "../lab-gallery/batch-lifecycle.mjs";
import { loadGalleryManifest } from "../lab-gallery/manifest.mjs";

const NOTEBOOK = fileURLToPath(new URL("./NOTEBOOK.md", import.meta.url));
const FIXTURE_ID = "no-tick-sync-frozen-pair";
const PLATFORM = "lab-omnibus-state-v1";
const MACHINE_POS = { x: 39.5, y: -108.5 };
const INSERTER_POS = { x: 42.5, y: -108.5 };
const HELD = { name: "iron-plate", count: 1, quality: "normal" };

const L = createBatchLifecycle({
	goldenSourceSave: "lab-b8-golden-source.zip",
	goldenDestSave: "lab-b8-golden-dest.zip",
	markerPrefix: "b8-marker",
});
const {
	lua, instanceIds, loadedSave, preflightState, assertLeaseClean,
	loadGoldenPair, restoreLivePair, RESTORE_SAVES,
} = L;

const ALL_SECTIONS = ["preflight", "load", "measure", "restore"];
let sections = [...ALL_SECTIONS];
let noNotebook = false;
let restoreOnly = false;
for (let i = 2; i < process.argv.length; i += 1) {
	const arg = process.argv[i];
	if (arg === "--no-notebook") noNotebook = true;
	else if (arg === "--restore-only") { restoreOnly = true; sections = ["restore"]; }
	else if (arg.startsWith("--sections=")) sections = arg.slice(11).split(",").map(s => s.trim()).filter(Boolean);
	else throw new Error(`Unknown argument: ${arg}`);
}
for (const s of sections) if (!ALL_SECTIONS.includes(s)) throw new Error(`Unknown section: ${s}`);
// Any section that displaces the live saves (load, measure) MUST be followed by restore — a debug
// invocation like --sections=measure would otherwise leave the shared cluster on golden saves.
if (["load", "measure"].some(s => sections.includes(s)) && !sections.includes("restore")) {
	sections.push("restore");
	console.error("note: restore section auto-appended (displacing sections always restore)");
}
const runs = section => sections.includes(section);

// --- Fixture reads --------------------------------------------------------------------------------

// Resolve the platform by name (fail loud on ambiguity) and read the pair fingerprint DIRECTLY (the
// selftest does not return recipe/destructible/hand-empty). Runs BEFORE the first measure, because
// run 1 seats the inserter hand and would invalidate the hand-empty read.
function readPair(host) {
	return lua(host, `
		local surf; for _,p in pairs(game.forces.player.platforms) do
			if p.valid and p.name=='${PLATFORM}' then
				if surf then error('ambiguous platform name ${PLATFORM}') end
				surf={s=p.surface,index=p.index}
			end
		end
		if not surf then return {success=false,error='platform ${PLATFORM} not found'} end
		local cfs=surf.s
		local function at(name,x,y)
			for _,e in ipairs(cfs.find_entities_filtered{name=name}) do if e.position.x==x and e.position.y==y then return e end end
			return nil
		end
		local m=at('assembling-machine-1',${MACHINE_POS.x},${MACHINE_POS.y})
		local ins=at('inserter',${INSERTER_POS.x},${INSERTER_POS.y})
		if not m then return {success=false,error='assembling-machine-1 not at ${MACHINE_POS.x},${MACHINE_POS.y}'} end
		if not ins then return {success=false,error='inserter not at ${INSERTER_POS.x},${INSERTER_POS.y}'} end
		local inp=m.get_inventory(defines.inventory.crafter_input)
		local rec=m.get_recipe()
		local hs=ins.held_stack
		return {success=true,platformIndex=surf.index,
			progress=m.crafting_progress,
			recipe=rec and rec.name or nil,
			inputPlates=inp and inp.get_item_count('iron-plate') or 0,
			assemblerActive=m.active,
			inserterActive=ins.active,
			inserterHandEmpty=not(hs~=nil and hs.valid_for_read),
			allIndestructible=(not m.destructible) and (not ins.destructible)}`.replace(/\s*\n\s*/g, " "));
}

// Construct-free measure_baked selftest against the loaded golden pair (mutates ONLY the inserter
// hand). Mirrors the card's remote call exactly.
function measureBaked(host) {
	const result = lua(host, `return remote.call('surface_export','no_tick_sync_selftest',` +
		`{mode='measure_baked',platform='${PLATFORM}',machine_pos={x=${MACHINE_POS.x},y=${MACHINE_POS.y}},` +
		`inserter_pos={x=${INSERTER_POS.x},y=${INSERTER_POS.y}},` +
		`held={name='${HELD.name}',count=${HELD.count},quality='${HELD.quality}'}})`);
	if (result.success === false) throw new Error(`measure_baked errored: ${result.error}`);
	if (result.status !== "measured") throw new Error(`measure_baked status '${result.status}': ${result.reason ?? "no reason"}`);
	return result;
}

function setTickPaused(host, paused) {
	return lua(host, `game.tick_paused=${paused ? "true" : "false"};` +
		`return {success=true,paused=game.tick_paused==true}`);
}

// --- Main ----------------------------------------------------------------------------------------

async function main() {
	const manifest = loadGalleryManifest(new URL("../../", import.meta.url));
	const fixture = manifest.fixtures.find(f => f.id === FIXTURE_ID);
	if (!fixture) throw new Error(`fixture ${FIXTURE_ID} missing from gallery manifest`);
	const results = {
		script: "tests/no-tick-sync-lab/run-b8-baked-pair.mjs",
		started: new Date().toISOString(), sections, errors: [],
	};
	let savesDisplaced = false;
	try {
		const ids = instanceIds();
		results.instanceIds = ids;

		if (runs("preflight")) {
			results.preBatchSaves = { 1: loadedSave(1), 2: loadedSave(2) };
			for (const host of [1, 2]) {
				if (results.preBatchSaves[host] !== RESTORE_SAVES[host]) {
					throw new Error(`host ${host} is on unexpected save '${results.preBatchSaves[host]}' ` +
						`(expected '${RESTORE_SAVES[host]}') — refusing to displace an unrecognized world`);
				}
				assertLeaseClean(host, preflightState(host), "live-lease");
			}
			results.lease = "clean";
		}

		if (runs("load")) {
			savesDisplaced = true;
			await loadGoldenPair(manifest, "golden-load");
			results.goldenLoaded = true;
		}

		if (runs("measure")) {
			const fp = fixture.fingerprint;

			// Fingerprint-verify the pair on the loaded SOURCE BEFORE the first measure (run 1 seats the
			// hand — the hand-empty read must precede it).
			const pair = readPair(1);
			if (!pair.success) throw new Error(`fixture resolve failed: ${pair.error}`);
			results.fingerprint = pair;
			if (Math.abs(pair.progress - fp.progress) > DOUBLE_EPSILON) {
				throw new Error(`crafting_progress ${pair.progress}, expected ${fp.progress} (eps ${DOUBLE_EPSILON})`);
			}
			if (pair.recipe !== fp.recipe) throw new Error(`recipe '${pair.recipe}', expected '${fp.recipe}'`);
			if (pair.inputPlates !== fp.inputPlates) throw new Error(`input plates ${pair.inputPlates}, expected ${fp.inputPlates}`);
			if (pair.assemblerActive !== fp.assemblerActive) throw new Error(`assembler active=${pair.assemblerActive}, expected ${fp.assemblerActive}`);
			if (pair.inserterActive !== fp.inserterActive) throw new Error(`inserter active=${pair.inserterActive}, expected ${fp.inserterActive}`);
			if (pair.inserterHandEmpty !== fp.inserterHandEmpty) throw new Error(`inserter hand empty=${pair.inserterHandEmpty}, expected ${fp.inserterHandEmpty}`);
			if (pair.allIndestructible !== fp.allIndestructible) throw new Error(`allIndestructible=${pair.allIndestructible}, expected ${fp.allIndestructible}`);

			// RUN 1 — normal (game unpaused): the fresh seating pass.
			const r1 = measureBaked(1);
			results.run1 = r1;
			if (r1.game_paused !== false) throw new Error(`run 1 expected game unpaused, got game_paused=${r1.game_paused}`);
			if (r1.tick_before !== r1.tick_after) throw new Error(`run 1 tick advanced ${r1.tick_before} -> ${r1.tick_after}`);
			if (r1.crafting_progress_after !== r1.crafting_progress_before) {
				throw new Error(`run 1 crafting_progress moved ${r1.crafting_progress_before} -> ${r1.crafting_progress_after}`);
			}
			if (r1.input_count_before !== fp.inputPlates) throw new Error(`run 1 input_count_before ${r1.input_count_before}, expected ${fp.inputPlates}`);
			if (r1.input_count_after !== r1.input_count_before) throw new Error(`run 1 input changed ${r1.input_count_before} -> ${r1.input_count_after}`);
			if (r1.seated_full !== true) throw new Error(`run 1 hand did not seat full: ${JSON.stringify(r1.held_after)} restored=${r1.restored} failed=${r1.failed}`);
			if (r1.machine_active_after !== false) throw new Error(`run 1 machine activated (active=${r1.machine_active_after})`);
			if (r1.inserter_active_after !== false) throw new Error(`run 1 inserter activated (active=${r1.inserter_active_after})`);

			// RUN 2 — the STRONGEST FORM under game.tick_paused=true. The hand is ALREADY full from run
			// 1, so restore_held_items_only skips it (restored==0). Assert the hand STAYS full and
			// nothing moves; NEVER leave the golden world paused (finally unpauses on every path).
			const paused = setTickPaused(1, true);
			if (!paused.success || paused.paused !== true) throw new Error(`could not tick-pause: ${JSON.stringify(paused)}`);
			let r2;
			try {
				r2 = measureBaked(1);
			} finally {
				const unpaused = setTickPaused(1, false);
				results.tickPauseRestored = unpaused.success === true && unpaused.paused === false;
				if (!results.tickPauseRestored) {
					results.errors.push(`FAILED to unpause the golden world after run 2: ${JSON.stringify(unpaused)}`);
				}
			}
			results.run2 = r2;
			if (r2.game_paused !== true) throw new Error(`run 2 expected game tick-paused, got game_paused=${r2.game_paused}`);
			if (r2.tick_before !== r2.tick_after) throw new Error(`run 2 tick advanced ${r2.tick_before} -> ${r2.tick_after}`);
			if (r2.crafting_progress_after !== r2.crafting_progress_before) {
				throw new Error(`run 2 crafting_progress moved ${r2.crafting_progress_before} -> ${r2.crafting_progress_after}`);
			}
			if (r2.input_count_before !== fp.inputPlates) throw new Error(`run 2 input_count_before ${r2.input_count_before}, expected ${fp.inputPlates}`);
			if (r2.input_count_after !== r2.input_count_before) throw new Error(`run 2 input changed ${r2.input_count_before} -> ${r2.input_count_after}`);
			// Hand STAYS full (idempotent skip), NOT a fresh seating.
			if (!(r2.held_after && r2.held_after.name === HELD.name && r2.held_after.count === HELD.count)) {
				throw new Error(`run 2 hand did not stay full: ${JSON.stringify(r2.held_after)}`);
			}
			if (r2.restored !== 0) throw new Error(`run 2 expected idempotent restored=0, got ${r2.restored}`);
			if (r2.failed !== 0) throw new Error(`run 2 expected failed=0, got ${r2.failed}`);
			if (r2.machine_active_after !== false) throw new Error(`run 2 machine activated (active=${r2.machine_active_after})`);
			if (r2.inserter_active_after !== false) throw new Error(`run 2 inserter activated (active=${r2.inserter_active_after})`);

			results.verdict = "GREEN";
		}
	} catch (error) {
		results.errors.push(error.stack || error.message);
	} finally {
		if (runs("restore") && (savesDisplaced || restoreOnly)) {
			await restoreLivePair(results, results.errors);
		}
		results.finished = new Date().toISOString();
		results.green = results.errors.length === 0 && (!runs("measure") || results.verdict === "GREEN");
		if (!noNotebook && !restoreOnly && sections.length === ALL_SECTIONS.length) {
			appendFileSync(NOTEBOOK, renderNotebook(results));
		}
		console.log(JSON.stringify(results, null, 2));
		if (!results.green) process.exitCode = 1;
	}
}

function renderNotebook(results) {
	const r1 = results.run1, r2 = results.run2;
	const L2 = [];
	L2.push(`\n\n## ${results.finished} — B8 no-tick baked-pair batch (bake gate, ${results.green ? "GREEN" : "RED"})`);
	L2.push(`\nRunner: \`${results.script}\` against the committed golden pair loaded via Clusterio-native ` +
		`save assignment (instances ${JSON.stringify(results.instanceIds)}); pre-batch saves ` +
		`${JSON.stringify(results.preBatchSaves)}, restored ${JSON.stringify(results.restored)}.`);
	if (results.verdict) {
		L2.push(`\n**Fingerprint** reproduced from the save-loaded world: assembling-machine-1 at ` +
			`(${MACHINE_POS.x},${MACHINE_POS.y}) crafting_progress ${results.fingerprint?.progress} ` +
			`(iron-gear-wheel, ${results.fingerprint?.inputPlates} plates, inactive), inserter at ` +
			`(${INSERTER_POS.x},${INSERTER_POS.y}) inactive empty-handed, both indestructible.`);
		L2.push(`\n**Run 1 (normal, fresh seating)** — tick ${r1?.tick_before}==${r1?.tick_after}, ` +
			`crafting_progress ${r1?.crafting_progress_before} unchanged, input ${r1?.input_count_before} ` +
			`unchanged, seated_full=${r1?.seated_full} (restored ${r1?.restored}/failed ${r1?.failed}), both inactive.`);
		L2.push(`\n**Run 2 (game.tick_paused, strongest form)** — game_paused=${r2?.game_paused}, tick ` +
			`${r2?.tick_before}==${r2?.tick_after}, crafting_progress ${r2?.crafting_progress_before} EXACTLY ` +
			`unchanged, input ${r2?.input_count_before} unchanged, hand STAYS full ` +
			`(${JSON.stringify(r2?.held_after)}, restored ${r2?.restored} idempotent), both inactive. ` +
			`Golden world unpaused after: ${results.tickPauseRestored}. ${results.verdict}.`);
	}
	if (results.errors.length) L2.push(`\n**Errors:**\n${results.errors.map(e => `- ${e}`).join("\n")}`);
	L2.push(`\n<details><summary>Raw results JSON</summary>\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n</details>`);
	return L2.join("\n");
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
