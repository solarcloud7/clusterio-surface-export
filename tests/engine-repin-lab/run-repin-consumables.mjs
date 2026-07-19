#!/usr/bin/env node
// engine-repin-lab — repin-consumables batch (owner-adjudicated card 4, 2026-07-18):
// the version-pin re-certification rungs that CONSUME baked fixtures, run through the single-use
// batch lifecycle (docs/lab-tests.md; shared plumbing in tests/lab-gallery/batch-lifecycle.mjs).
//
//   B7 (destroy semantics, needs-ticks) — one baked hub-only consumable platform per variant
//        (owner: "Bake consumables", "Three" — one per measured semantic; reload restores them):
//        lab-consumable-1: destroy()   -> NO-OP; platform stays valid through +120 ticks
//        lab-consumable-2: destroy(0)  -> platform invalid after an elapsed tick
//        lab-consumable-3: destroy(60) -> valid inside the 60-tick window, invalid by +61
//        These guard Pitfall #19's ENGINE semantics at pin bumps (production deletes via
//        game.delete_surface, never destroy) — the drift that motivated lint:version-certification.
//   B9 (unknown-item import, Pitfall #7) — runtime synthetic payload (test_import_entity with a
//        valid item + a bogus item on a disposable surface): warning fires, valid item restores
//        physically, no crash. Runtime-by-design (its fixture is a payload, not world state).
//
//   B8 (beacon crafting_speed same-execution propagation, pause-free) — PENDING its omnibus-zone
//        fixture (owner: "Omnibus zone"); lands with the seed-prep bake in the follow-up commit.
//
// NAMING NOTE: this lab's B8 (beacon) is a DIFFERENT rung from no-tick-sync-lab's B8 (baked pair)
// — always cite lab-prefixed ("engine-repin B8"), per the rung-ID citation rule.
//
// Usage:
//   node tests/engine-repin-lab/run-repin-consumables.mjs                 # full batch, appends NOTEBOOK
//   node tests/engine-repin-lab/run-repin-consumables.mjs --no-notebook   # debug iteration
//   node tests/engine-repin-lab/run-repin-consumables.mjs --sections=preflight,load,b7
//   node tests/engine-repin-lab/run-repin-consumables.mjs --restore-only  # finalizer alone
//
// A "passed" claim requires TWO consecutive full green runs (CLAUDE.md probe rule 8).

import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBatchLifecycle, docker, HOSTS, instancePath, lua, sleep } from "../lab-gallery/batch-lifecycle.mjs";
import { loadGalleryManifest } from "../lab-gallery/manifest.mjs";

const NOTEBOOK = fileURLToPath(new URL("./NOTEBOOK.md", import.meta.url));

// The pinned 2.0.77 destroy-semantics table (engine-repin B7, evidence commit 00e44c7). A verdict
// differing from this WITHOUT a pin bump is the tripwire firing.
const B7_VARIANTS = [
	{ platform: "lab-consumable-1", call: "destroy()", args: "", expectAlive: { early: true, late: true } },
	{ platform: "lab-consumable-2", call: "destroy(0)", args: "0", expectAlive: { early: false, late: false } },
	{ platform: "lab-consumable-3", call: "destroy(60)", args: "60", expectAlive: { early: true, late: false } },
];
// "early" = a sample landed strictly inside (t0, t0+55); "late" = at/after t0+120. The early window
// tolerates RCON round-trip latency (~10-30 ticks); a sample that misses the window fails LOUD as
// window-missed (rerun), never as a fabricated verdict.
const EARLY_WINDOW_MAX = 55;
const LATE_AT = 120;

const L = createBatchLifecycle({
	goldenSourceSave: "lab-repinc-golden-source.zip",
	goldenDestSave: "lab-repinc-golden-dest.zip",
	markerPrefix: "repinc-marker",
});
const {
	instanceIds, loadedSave, preflightState, assertLeaseClean,
	loadGoldenPair, restoreLivePair, RESTORE_SAVES,
} = L;

const ALL_SECTIONS = ["preflight", "load", "b7", "b8", "b9", "restore"];
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
if (["load", "b7", "b8", "b9"].some(s => sections.includes(s)) && !sections.includes("restore")) {
	sections.push("restore");
	console.error("note: restore section auto-appended (displacing sections always restore)");
}
const runs = section => sections.includes(section);

// --- B7 helpers -----------------------------------------------------------------------------------

function platformAlive(name) {
	return lua(1, `local alive=false; for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and p.name=='${name}' then alive=true end end; ` +
		`return {success=true,alive=alive,tick=game.tick}`);
}

// Fires the destroy variant and returns the call tick in the SAME execution (no race on t0).
function fireDestroy(name, args) {
	return lua(1, `local target; for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and p.name=='${name}' then target=p end end; ` +
		`if not target then return {success=false,error='platform ${name} not found'} end; ` +
		`local hub=#target.surface.find_entities_filtered{}; ` +
		// lint-lua:allow platform destroy — this IS the engine-repin destroy-semantics rung; the
		// guarded call is the measurand, never a production deletion path.
		`target.destroy(${args}); ` +
		`return {success=true,t0=game.tick,entities=hub}`);
}

async function sampleUntil(tickTarget, name, deadlineMs = 60_000) {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const reading = platformAlive(name);
		if (reading.tick >= tickTarget) return reading;
		await sleep(300);
	}
	throw new Error(`tick ${tickTarget} not reached within ${deadlineMs} ms (game paused?)`);
}

async function b7Variant(variant, results) {
	const before = platformAlive(variant.platform);
	if (!before.alive) throw new Error(`${variant.platform} missing before ${variant.call} — fixture not baked?`);
	const fired = fireDestroy(variant.platform, variant.args);
	if (!fired.success) throw new Error(fired.error);
	if (fired.entities !== 1) throw new Error(`${variant.platform} carries ${fired.entities} entities, expected the bare hub (1)`);

	// EARLY sample: must land strictly inside (t0, t0+EARLY_WINDOW_MAX) to be admissible.
	const early = await sampleUntil(fired.t0 + 1, variant.platform);
	const earlyAdmissible = early.tick > fired.t0 && early.tick < fired.t0 + EARLY_WINDOW_MAX;
	if (!earlyAdmissible) {
		throw new Error(`${variant.platform} early sample landed at +${early.tick - fired.t0} ticks ` +
			`(admissible window is +1..+${EARLY_WINDOW_MAX - 1}) — window missed, rerun`);
	}
	if (early.alive !== variant.expectAlive.early) {
		throw new Error(`${variant.call}: alive=${early.alive} at +${early.tick - fired.t0}, ` +
			`pinned table expects ${variant.expectAlive.early} — DESTROY SEMANTICS DRIFT (or fixture fault)`);
	}
	// LATE sample: at/after +120.
	const late = await sampleUntil(fired.t0 + LATE_AT, variant.platform);
	if (late.alive !== variant.expectAlive.late) {
		throw new Error(`${variant.call}: alive=${late.alive} at +${late.tick - fired.t0}, ` +
			`pinned table expects ${variant.expectAlive.late} — DESTROY SEMANTICS DRIFT`);
	}
	results.b7[variant.platform] = {
		call: variant.call, t0: fired.t0,
		earlyTick: early.tick - fired.t0, earlyAlive: early.alive,
		lateTick: late.tick - fired.t0, lateAlive: late.alive,
	};
}

// --- B9 helper ------------------------------------------------------------------------------------

function b9UnknownItemImport() {
	// Disposable surface + chest payload carrying one valid stack and one bogus stack. The remote's
	// return table holds a live LuaEntity — reduce it in-Lua before the JSON hop. Physical grounding:
	// the chest's iron-plate count is read independently, never the remote's self-report alone.
	return lua(1, `
		local surf=game.surfaces['repin-b9'] or game.create_surface('repin-b9',{width=32,height=32})
		surf.request_to_generate_chunks({0,0},1) surf.force_generate_chunk_requests()
		surf.set_tiles({{name='grass-1',position={0,0}},{name='grass-1',position={1,0}},{name='grass-1',position={0,1}},{name='grass-1',position={1,1}}},true,false,true,false)
		local payload={name='steel-chest',type='container',position={x=0.5,y=0.5},specific_data={inventories={{type='chest',items={{name='iron-plate',count=25,quality='normal',slot=1},{name='repin-bogus-item-xyz',count=7,quality='normal',slot=2}}}}}}
		local result=remote.call('surface_export','test_import_entity',payload,surf.index,nil)
		local chest=surf.find_entities_filtered{name='steel-chest'}[1]
		local plates=chest and chest.get_item_count('iron-plate') or -1
		local warning_text=table.concat(result.warnings or {},' | ')
		local report={success=true,importSuccess=result.success==true,errors=result.errors or {},
			warnings=#(result.warnings or {}),warningText=warning_text:sub(1,300),
			platesPhysical=plates,chestExists=chest~=nil}
		if chest and chest.valid then chest.destroy() end
		game.delete_surface(surf)
		return report`.replace(/\s*\n\s*/g, " "));
}

// --- Main ----------------------------------------------------------------------------------------

async function main() {
	const manifest = loadGalleryManifest(new URL("../../", import.meta.url));
	for (const n of [1, 2, 3]) {
		if (!manifest.fixtures.find(f => f.id === `consumable-hub-${n}`)) {
			throw new Error(`consumable-hub-${n} missing from gallery manifest`);
		}
	}
	const results = {
		script: "tests/engine-repin-lab/run-repin-consumables.mjs",
		started: new Date().toISOString(), sections, errors: [], b7: {},
	};
	let savesDisplaced = false;
	try {
		results.instanceIds = instanceIds();

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

		if (runs("b7")) {
			// Sequential by design: each variant consumes its own platform; interleaving samples
			// across variants would blur which destroy produced which reading.
			for (const variant of B7_VARIANTS) {
				await b7Variant(variant, results);
			}
			results.b7Verdict = "GREEN";
		}

		if (runs("b8")) {
			// engine-repin B8 (pause-free): module population raises nearby crafting_speed in the
			// SAME Lua execution — no tick, no power (the mechanism behind the two-pass beacon-first
			// inventory restore). Positions come from the manifest anchors (single source).
			const fixture = manifest.fixtures.find(f => f.id === "repin-beacon-speed");
			if (!fixture || !fixture.anchors) throw new Error("repin-beacon-speed anchors missing from manifest");
			const anchor = Object.fromEntries(fixture.anchors.map(a => [a.entity, a]));
			const b8 = lua(1, `local surf; for _,p in pairs(game.forces.player.platforms) do ` +
				`if p.valid and p.name=='lab-omnibus-state-v1' then surf=p.surface end end; ` +
				`local b=surf.find_entities_filtered({name='beacon',area={{${anchor.beacon.x - 0.4},${anchor.beacon.y - 0.4}},{${anchor.beacon.x + 0.4},${anchor.beacon.y + 0.4}}}})[1]; ` +
				`local m=surf.find_entities_filtered({name='assembling-machine-2',area={{${anchor["assembling-machine-2"].x - 0.4},${anchor["assembling-machine-2"].y - 0.4}},{${anchor["assembling-machine-2"].x + 0.4},${anchor["assembling-machine-2"].y + 0.4}}}})[1]; ` +
				`if not (b and m) then return {success=false,error='beacon pair not found at anchors'} end; ` +
				`local inv=b.get_inventory(defines.inventory.beacon_modules); ` +
				`local before=m.crafting_speed; local tick0=game.tick; ` +
				`inv.insert({name='speed-module',count=2}); ` +
				`local after=m.crafting_speed; ` +
				`inv.clear(); ` +
				`local restored=m.crafting_speed; ` +
				`return {success=true,before=before,after=after,restored=restored,tick0=tick0,tick1=game.tick,` +
				`machineActive=m.active,beaconActive=b.active,modulesEmpty=inv.is_empty()}`);
			results.b8 = b8;
			if (!b8.success) throw new Error(`B8 harness errored: ${b8.error}`);
			if (b8.tick0 !== b8.tick1) throw new Error(`B8 execution spanned ticks ${b8.tick0}->${b8.tick1} — not same-execution`);
			if (b8.machineActive !== false) throw new Error("B8 machine was active — the fixture must stay frozen");
			if (!(b8.after > b8.before + 0.2)) {
				throw new Error(`B8 crafting_speed did not rise same-execution: ${b8.before} -> ${b8.after} — PROPAGATION DRIFT`);
			}
			if (b8.restored !== b8.before) {
				throw new Error(`B8 baseline did not return after module clear: ${b8.restored} vs ${b8.before}`);
			}
			if (b8.modulesEmpty !== true) throw new Error("B8 left modules behind — fixture not restored");
			results.b8Verdict = "GREEN";
		}

		if (runs("b9")) {
			const b9 = b9UnknownItemImport();
			results.b9 = b9;
			if (!b9.success) throw new Error(`B9 harness errored: ${b9.error}`);
			if (b9.importSuccess !== true) throw new Error(`B9 import failed outright: ${JSON.stringify(b9.errors)}`);
			if (b9.platesPhysical !== 25) {
				throw new Error(`B9 valid item did not restore: physical iron-plate ${b9.platesPhysical}, expected 25`);
			}
			// The Pitfall #7 skip warns via log() (deserializer.lua "Skipped unknown item"), NOT the
			// remote's warnings array (measured run 1: warnings=0 while the skip logged correctly).
			// The bogus name is unique to this run's golden session (fresh factorio-current.log per
			// load), so a plain count is unambiguous.
			const skipCount = Number(docker(["exec", HOSTS[1].container, "sh", "-c",
				`grep -c "Skipped unknown item 'repin-bogus-item-xyz'" ` +
				`${instancePath(1, "factorio-current.log")} || true`]).trim());
			results.b9.skipWarningLogged = skipCount;
			if (!(skipCount > 0)) {
				throw new Error("B9 expected the 'Skipped unknown item' log warning; none found (silent drop?)");
			}
			results.b9Verdict = "GREEN";
		}
	} catch (error) {
		results.errors.push(error.stack || error.message);
	} finally {
		if (runs("restore") && (savesDisplaced || restoreOnly)) {
			await restoreLivePair(results, results.errors);
		}
		results.finished = new Date().toISOString();
		results.green = results.errors.length === 0
			&& (!runs("b7") || results.b7Verdict === "GREEN")
			&& (!runs("b8") || results.b8Verdict === "GREEN")
			&& (!runs("b9") || results.b9Verdict === "GREEN");
		if (!noNotebook && !restoreOnly && sections.length === ALL_SECTIONS.length) {
			appendFileSync(NOTEBOOK, renderNotebook(results));
		}
		console.log(JSON.stringify(results, null, 2));
		if (!results.green) process.exitCode = 1;
	}
}

function renderNotebook(results) {
	const rows = [];
	rows.push(`\n\n## ${results.finished} — repin-consumables batch (engine-repin B7+B9, ${results.green ? "GREEN" : "RED"})`);
	rows.push(`\nRunner: \`${results.script}\` against the committed golden pair (instances ` +
		`${JSON.stringify(results.instanceIds)}); pre-batch saves ${JSON.stringify(results.preBatchSaves)}, ` +
		`restored ${JSON.stringify(results.restored)}.`);
	if (results.b7Verdict) {
		for (const [platform, r] of Object.entries(results.b7)) {
			rows.push(`\n**engine-repin B7 / ${platform}** — \`${r.call}\` at t0=${r.t0}: alive=${r.earlyAlive} at ` +
				`+${r.earlyTick}, alive=${r.lateAlive} at +${r.lateTick} — matches the pinned 2.0.77 table.`);
		}
	}
	if (results.b8Verdict) {
		rows.push(`\n**engine-repin B8 (beacon crafting_speed, pause-free; distinct from no-tick-sync B8)** — ` +
			`same-execution rise ${results.b8?.before} -> ${results.b8?.after} on module insert (tick ` +
			`${results.b8?.tick0}==${results.b8?.tick1}, machine inactive), baseline ${results.b8?.restored} ` +
			`restored on clear, modules left empty.`);
	}
	if (results.b9Verdict) {
		rows.push(`\n**engine-repin B9 (unknown-item import)** — valid iron-plate restored physically ` +
			`(${results.b9?.platesPhysical}/25), the 'Skipped unknown item' log warning fired ` +
			`(${results.b9?.skipWarningLogged}x), no crash. Disposable surface removed.`);
	}
	if (results.errors.length) rows.push(`\n**Errors:**\n${results.errors.map(e => `- ${e}`).join("\n")}`);
	rows.push(`\n<details><summary>Raw results JSON</summary>\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n</details>`);
	return rows.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
