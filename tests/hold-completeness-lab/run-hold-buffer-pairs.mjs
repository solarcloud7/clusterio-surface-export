#!/usr/bin/env node
// hold-completeness-lab — hold-buffer-pairs batch (owner-adjudicated card 3, 2026-07-18): the
// destination-hold buffer laws proven from BAKED golden fixtures through the single-use batch
// lifecycle (docs/lab-tests.md; shared plumbing in tests/lab-gallery/batch-lifecycle.mjs).
//
// Three live/held pairs on six generation-free mini-platforms (owner: "All three pairs"),
// baked PAUSED for fixture stability; the runner unpauses BOTH sides of a pair before staging so
// the hold's own semantics — not the bake's pause — govern the held platform. Hold records are
// plugin storage (unbakeable): staging stays a runtime call of the PRODUCTION
// destination_hold_json remote — the accepted standing deviation, and honest, because the remote
// is itself the code under test.
//
//   spoil  — held spoilage drift <= paired live-control drift over a ~5 SECOND window (owner:
//            "even 5 seconds is enough to prove spoilage as working. we're testing that spoilage
//            transfers. nothing more nothing less" — test-contract boundaries).
//   damage — zero hold-attributable platform damage (targets DESTRUCTIBLE by adjudication:
//            damage is the measurand).
//   pod    — staging absorbs the in-flight cargo pod: held platform pod-free with every unit of
//            cargo retained ON the platform (hub or ground); nothing leaves.
//
// Every law is adjudicated by INDEPENDENT physical reads (spoil_percent, health, item counts) —
// never the remote's self-report. Each discard is followed by a physical zero-holds check.
//
// Usage:
//   node tests/hold-completeness-lab/run-hold-buffer-pairs.mjs                 # full batch, appends NOTEBOOK
//   node tests/hold-completeness-lab/run-hold-buffer-pairs.mjs --no-notebook   # debug iteration
//   node tests/hold-completeness-lab/run-hold-buffer-pairs.mjs --sections=preflight,load,spoil
//   node tests/hold-completeness-lab/run-hold-buffer-pairs.mjs --restore-only  # finalizer alone
//
// A "passed" claim requires TWO consecutive full green runs (CLAUDE.md probe rule 8).

import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBatchLifecycle, lua, sleep } from "../lab-gallery/batch-lifecycle.mjs";
import { loadGalleryManifest } from "../lab-gallery/manifest.mjs";

const NOTEBOOK = fileURLToPath(new URL("./NOTEBOOK.md", import.meta.url));
const WINDOW_MS = 5_000; // the owner's contract window — do not stretch it
const PAIRS = {
	spoil: { fixture: "hold-buffer-spoil", live: "lab-hold-spoil-live-v1", held: "lab-hold-spoil-held-v1" },
	damage: { fixture: "hold-buffer-damage", live: "lab-hold-damage-live-v1", held: "lab-hold-damage-held-v1" },
	pod: { fixture: "hold-buffer-pod", live: "lab-hold-pod-live-v1", held: "lab-hold-pod-held-v1" },
};

const L = createBatchLifecycle({
	goldenSourceSave: "lab-holdbuf-golden-source.zip",
	goldenDestSave: "lab-holdbuf-golden-dest.zip",
	markerPrefix: "holdbuf-marker",
});
const {
	instanceIds, loadedSave, preflightState, assertLeaseClean,
	loadGoldenPair, restoreLivePair, RESTORE_SAVES,
} = L;

const ALL_SECTIONS = ["preflight", "load", "spoil", "damage", "pod", "restore"];
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
if (["load", "spoil", "damage", "pod"].some(s => sections.includes(s)) && !sections.includes("restore")) {
	sections.push("restore");
	console.error("note: restore section auto-appended (displacing sections always restore)");
}
const runs = section => sections.includes(section);

// --- Shared Lua helpers ---------------------------------------------------------------------------

function setPairPaused(pair, paused) {
	return lua(1, `local out={}; for _,name in ipairs({'${pair.live}','${pair.held}'}) do ` +
		`local found=false; for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and p.name==name then p.paused=${paused ? "true" : "false"}; found=true end end; ` +
		`out[name]=found end; return {success=true,found=out}`);
}

function stageHold(pair, transferId) {
	return lua(1, `local target; for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and p.name=='${pair.held}' then target=p end end; ` +
		`if not target then return {success=false,error='${pair.held} not found'} end; ` +
		`local raw=remote.call('surface_export','destination_hold_json','stage','${transferId}',target.index,'player'); ` +
		`return {success=true,stage=helpers.json_to_table(raw)}`);
}

function discardHold(transferId) {
	return lua(1, `local raw=remote.call('surface_export','destination_hold_json','discard','${transferId}',nil,'player'); ` +
		`return {success=true,discard=helpers.json_to_table(raw),holds=table_size(storage.destination_holds or {})}`);
}

// --- Pair reads (independent physical meters) -----------------------------------------------------

function readSpoil(pair) {
	return lua(1, `local out={success=true}; ` +
		`for key,name in pairs({live='${pair.live}',held='${pair.held}'}) do ` +
		`local surf; for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name==name then surf=p.surface end end; ` +
		`if not surf then return {success=false,error=name..' missing'} end; ` +
		`local chest=surf.find_entities_filtered({name='steel-chest'})[1]; ` +
		`local stack=chest and chest.get_inventory(defines.inventory.chest)[1]; ` +
		`local readable=stack~=nil and stack.valid_for_read; ` +
		`local ok,sp=pcall(function() return stack.spoil_percent end); ` +
		`out[key]={chest=chest~=nil,item=readable and stack.name or nil,count=readable and stack.count or 0,` +
		`spoil=(readable and ok) and sp or nil} end; return out`);
}

function readDamage(pair) {
	return lua(1, `local out={success=true}; ` +
		`for key,name in pairs({live='${pair.live}',held='${pair.held}'}) do ` +
		`local surf; for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name==name then surf=p.surface end end; ` +
		`if not surf then return {success=false,error=name..' missing'} end; ` +
		`local chest=surf.find_entities_filtered({name='steel-chest'})[1]; ` +
		`local asteroid=surf.find_entities_filtered({force='neutral'})[1]; ` +
		`out[key]={chest=chest~=nil,health=chest and chest.health or nil,` +
		`healthFull=chest~=nil and chest.health==chest.max_health,` +
		`destructible=chest and chest.destructible or false,` +
		`asteroidValid=asteroid~=nil,asteroidName=asteroid and asteroid.name or nil,` +
		`asteroidSurface=asteroid and asteroid.surface.index or nil} end; return out`);
}

function readPod(pair) {
	return lua(1, `local out={success=true}; ` +
		`for key,name in pairs({live='${pair.live}',held='${pair.held}'}) do ` +
		`local surf; for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name==name then surf=p.surface end end; ` +
		`if not surf then return {success=false,error=name..' missing'} end; ` +
		`local pods=surf.count_entities_filtered({name='cargo-pod'}); ` +
		`local podCopper=0; local podState=nil; local pod=surf.find_entities_filtered({name='cargo-pod'})[1]; ` +
		`if pod then local inv=pod.get_inventory(defines.inventory.cargo_unit); podCopper=inv and inv.get_item_count('copper-plate') or 0; podState=pod.cargo_pod_state end; ` +
		`local hub=surf.find_entities_filtered({name='space-platform-hub'})[1]; ` +
		`local hubCopper=0; if hub then local inv=hub.get_inventory(defines.inventory.hub_main); hubCopper=inv and inv.get_item_count('copper-plate') or 0 end; ` +
		`local hubIron=0; if hub then local inv=hub.get_inventory(defines.inventory.hub_main); hubIron=inv and inv.get_item_count('iron-plate') or 0 end; ` +
		`local groundCopper=0; for _,e in ipairs(surf.find_entities_filtered({name='item-on-ground'})) do ` +
		`local ok,st=pcall(function() return e.stack end); ` +
		`if ok and st and st.valid_for_read and st.name=='copper-plate' then groundCopper=groundCopper+st.count end end; ` +
		`out[key]={pods=pods,podCopper=podCopper,podState=podState,hubCopper=hubCopper,hubIron=hubIron,groundCopper=groundCopper,` +
		`totalCopper=podCopper+hubCopper+groundCopper} end; return out`);
}

// --- Law adjudication -----------------------------------------------------------------------------

function spoilDrift(before, after) {
	let drift = Math.abs(Number(after.spoil ?? 0) - Number(before.spoil ?? 0));
	if (after.item !== before.item) drift += 1;
	if (after.count !== before.count) drift += 1;
	return drift;
}

// Re-activate the frozen asteroid specimens on BOTH sides for the window (they are baked
// active=false — an active asteroid despawned from the paused golden platform between bake calls,
// measured v15 run 1 — so the bake freezes them and the window wakes them).
function wakeAsteroids(pair) {
	return lua(1, `local woke=0; for _,name in ipairs({'${pair.live}','${pair.held}'}) do ` +
		`for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name==name then ` +
		`for _,e in ipairs(p.surface.find_entities_filtered({force='neutral'})) do e.active=true; woke=woke+1 end end end end; ` +
		`return {success=true,woke=woke}`);
}

async function runPair(name, results, fingerprintCheck, readFn, adjudicate, preWindow, options = {}) {
	const pair = PAIRS[name];
	const section = { pair: name };
	results[name] = section;

	fingerprintCheck(section);

	section.before = readFn(pair);
	if (!section.before.success) throw new Error(`${name} before-read failed: ${section.before.error}`);

	// Unpause BOTH sides so the hold's own semantics — not the bake's pause — govern the held
	// platform for the window. The POD pair stays PAUSED: production stages holds on parked
	// paused platforms, and an unpaused baked pod LAUNCHES off the platform with its cargo
	// before stage can absorb it (measured run 1: pods=0, copper=0 after ~20 live ticks).
	if (options.unpause !== false) {
		const unpaused = setPairPaused(pair, false);
		if (!unpaused.success) throw new Error(`${name} unpause failed`);
	}
	if (preWindow) {
		section.preWindow = preWindow(pair);
	}

	const transferId = `hold-buffer-${name}-${Date.now()}`;
	section.transferId = transferId;
	try {
		const staged = stageHold(pair, transferId);
		if (!staged.success) throw new Error(`${name} stage failed: ${staged.error}`);
		section.stage = staged.stage;
		section.afterStage = readFn(pair);

		await sleep(WINDOW_MS);

		section.after = readFn(pair);
		if (!section.after.success) throw new Error(`${name} after-read failed: ${section.after.error}`);
		adjudicate(section);
	} finally {
		const discarded = discardHold(transferId);
		section.discard = discarded;
		if (!discarded.success) {
			results.errors.push(`${name}: discard failed — hold record may be leaked`);
		} else if (discarded.holds !== 0) {
			results.errors.push(`${name}: ${discarded.holds} destination_holds remain after discard — LEAK`);
		}
		// Re-pause for hygiene so later sections' fixtures don't drift while this pair idles.
		setPairPaused(pair, true);
	}
	section.verdict = "GREEN";
}

// --- Main ----------------------------------------------------------------------------------------

async function main() {
	const manifest = loadGalleryManifest(new URL("../../", import.meta.url));
	const fixtureOf = id => {
		const fixture = manifest.fixtures.find(f => f.id === id);
		if (!fixture) throw new Error(`fixture ${id} missing from gallery manifest`);
		return fixture;
	};
	const results = {
		script: "tests/hold-completeness-lab/run-hold-buffer-pairs.mjs",
		started: new Date().toISOString(), sections, errors: [],
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

		if (runs("spoil")) {
			const fp = fixtureOf("hold-buffer-spoil").fingerprint;
			await runPair("spoil", results, section => {
				const reading = readSpoil(PAIRS.spoil);
				if (!reading.success) throw new Error(`spoil fingerprint read failed: ${reading.error}`);
				for (const side of ["live", "held"]) {
					const row = reading[side];
					if (row.item !== fp[`${side}Item`]) throw new Error(`spoil ${side} item '${row.item}', expected '${fp[`${side}Item`]}'`);
					if (row.count !== fp[`${side}Count`]) throw new Error(`spoil ${side} count ${row.count}, expected ${fp[`${side}Count`]}`);
					const seeded = row.spoil != null && row.spoil > 0.5 && row.spoil < 1;
					if (seeded !== fp[`${side}SpoilSeeded`]) throw new Error(`spoil ${side} seeded=${seeded} (spoil=${row.spoil}), expected ${fp[`${side}SpoilSeeded`]}`);
				}
				section.fingerprint = reading;
			}, readSpoil, section => {
				const liveDrift = spoilDrift(section.before.live, section.after.live);
				const heldDrift = spoilDrift(section.before.held, section.after.held);
				section.liveDrift = liveDrift;
				section.heldDrift = heldDrift;
				if (!(heldDrift <= liveDrift + 1e-9)) {
					throw new Error(`spoil LAW violated: held drift ${heldDrift} > live drift ${liveDrift}`);
				}
				if (!section.after.held.chest || section.after.held.count !== section.before.held.count) {
					throw new Error("spoil: held-side stack did not survive on the platform (nothing-leaves violated)");
				}
			});
		}

		if (runs("damage")) {
			const fp = fixtureOf("hold-buffer-damage").fingerprint;
			await runPair("damage", results, section => {
				const reading = readDamage(PAIRS.damage);
				if (!reading.success) throw new Error(`damage fingerprint read failed: ${reading.error}`);
				for (const side of ["live", "held"]) {
					const row = reading[side];
					if (!row.chest) throw new Error(`damage ${side} chest missing`);
					if (row.destructible !== fp[`${side}ChestDestructible`]) {
						throw new Error(`damage ${side} chest destructible=${row.destructible}, expected ${fp[`${side}ChestDestructible`]} (an indestructible target blinds the measurand)`);
					}
					if (row.healthFull !== fp[`${side}ChestHealthFull`]) {
						throw new Error(`damage ${side} chest healthFull=${row.healthFull}, expected ${fp[`${side}ChestHealthFull`]}`);
					}
					if (row.asteroidName !== fp[`${side}Asteroid`]) throw new Error(`damage ${side} asteroid '${row.asteroidName}', expected '${fp[`${side}Asteroid`]}'`);
				}
				section.fingerprint = reading;
			}, readDamage, section => {
				const heldBefore = Number(section.before.held.health ?? 0);
				const heldAfter = Number(section.after.held.health ?? 0);
				const platformDamage = Math.max(0, heldBefore - heldAfter);
				section.platformDamage = platformDamage;
				if (platformDamage > 0) {
					throw new Error(`damage LAW violated: held target lost ${platformDamage} health under the hold`);
				}
				const heldContained = section.after.held.asteroidValid === true
					&& section.after.held.asteroidSurface === section.before.held.asteroidSurface;
				const terminalMatchesLive = section.after.held.asteroidValid === false
					&& section.after.live.asteroidValid === false;
				section.heldAsteroidContained = heldContained;
				if (!section.after.held.chest || !(heldContained || terminalMatchesLive)) {
					throw new Error("damage: held-side containment violated (chest or asteroid state left the platform contract)");
				}
			}, wakeAsteroids);
		}

		if (runs("pod")) {
			// Custom flow (not runPair): the in-flight pod is UNBAKEABLE transient state
			// (cargo_pod_state is read-only and a baked pod decays to 'ascending' — measured v15),
			// so both pods are created IN THE SAME Lua execution as the stage call (the
			// PR0A-proven recipe; the one sanctioned runtime-staging exception per the card note).
			// Platforms stay PAUSED throughout (production stages holds on parked platforms; an
			// unpaused pod launches off with its cargo — measured run 1).
			const fp = fixtureOf("hold-buffer-pod").fingerprint;
			const pair = PAIRS.pod;
			const section = { pair: "pod" };
			results.pod = section;

			const baked = readPod(pair);
			if (!baked.success) throw new Error(`pod fingerprint read failed: ${baked.error}`);
			for (const side of ["live", "held"]) {
				const row = baked[side];
				if (row.pods !== fp[`${side}PodCount`]) throw new Error(`pod ${side} baked count ${row.pods}, expected ${fp[`${side}PodCount`]}`);
				if ((row.hubIron > 0) !== fp[`${side}HubIronSeeded`]) throw new Error(`pod ${side} hub iron seeded=${row.hubIron > 0}, expected ${fp[`${side}HubIronSeeded`]}`);
			}
			section.fingerprint = baked;

			const transferId = `hold-buffer-pod-${Date.now()}`;
			section.transferId = transferId;
			try {
				// ONE execution: create a copper-loaded pod on each side, then stage the held.
				const staged = lua(1, `local out={success=true,created={}}; ` +
					`for key,name in pairs({live='${pair.live}',held='${pair.held}'}) do ` +
					`local target; for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name==name then target=p end end; ` +
					`if not target then return {success=false,error=name..' missing'} end; ` +
					`local pod=target.surface.create_entity({name='cargo-pod',position={2.5,-7.5},force='player'}); ` +
					`if not pod then return {success=false,error='pod create failed on '..name} end; ` +
					`local inv=pod.get_inventory(defines.inventory.cargo_unit); ` +
					`if inv then inv.insert({name='copper-plate',count=100}) end; ` +
					`out.created[key]={state=pod.cargo_pod_state,copper=inv and inv.get_item_count('copper-plate') or 0}; ` +
					`if key=='held' then local raw=remote.call('surface_export','destination_hold_json','stage','${transferId}',target.index,'player'); ` +
					`out.stage=helpers.json_to_table(raw) end end; return out`);
				if (!staged.success) throw new Error(`pod create+stage failed: ${staged.error}`);
				section.created = staged.created;
				section.stage = staged.stage;
				if (staged.created.held.copper !== 100 || staged.created.live.copper !== 100) {
					throw new Error(`pod seeding incomplete: live=${staged.created.live.copper} held=${staged.created.held.copper}`);
				}

				section.afterStage = readPod(pair);
				await sleep(WINDOW_MS);
				section.after = readPod(pair);
				if (!section.after.success) throw new Error(`pod after-read failed: ${section.after.error}`);

				const stageHeld = section.afterStage?.held;
				section.stagedPodFree = stageHeld.pods === 0;
				if (stageHeld.pods !== 0) {
					throw new Error(`pod LAW violated: held platform still has ${stageHeld.pods} pod(s) after stage`);
				}
				if (stageHeld.totalCopper < 100 || section.after.held.totalCopper < 100) {
					throw new Error(`pod LAW violated: held copper dropped below 100 (stage=${stageHeld.totalCopper}, after=${section.after.held.totalCopper}) — cargo left the platform`);
				}
				if (section.after.live.pods !== 1) {
					throw new Error(`pod: live control lost its pod (${section.after.live.pods}) — control invalid`);
				}
			} finally {
				const discarded = discardHold(transferId);
				section.discard = discarded;
				if (!discarded.success) {
					results.errors.push("pod: discard failed — hold record may be leaked");
				} else if (discarded.holds !== 0) {
					results.errors.push(`pod: ${discarded.holds} destination_holds remain after discard — LEAK`);
				}
			}
			section.verdict = "GREEN";
		}
	} catch (error) {
		results.errors.push(error.stack || error.message);
	} finally {
		if (runs("restore") && (savesDisplaced || restoreOnly)) {
			await restoreLivePair(results, results.errors);
		}
		results.finished = new Date().toISOString();
		const pairGreen = name => !runs(name) || results[name]?.verdict === "GREEN";
		results.green = results.errors.length === 0 && pairGreen("spoil") && pairGreen("damage") && pairGreen("pod");
		if (!noNotebook && !restoreOnly && sections.length === ALL_SECTIONS.length) {
			appendFileSync(NOTEBOOK, renderNotebook(results));
		}
		console.log(JSON.stringify(results, null, 2));
		if (!results.green) process.exitCode = 1;
	}
}

function renderNotebook(results) {
	const rows = [];
	rows.push(`\n\n## ${results.finished} — hold-buffer-pairs batch (card 3 bake gate, ${results.green ? "GREEN" : "RED"})`);
	rows.push(`\nRunner: \`${results.script}\` against the committed golden pair (instances ` +
		`${JSON.stringify(results.instanceIds)}); pre-batch saves ${JSON.stringify(results.preBatchSaves)}, ` +
		`restored ${JSON.stringify(results.restored)}. Window ${WINDOW_MS} ms (owner contract).`);
	if (results.spoil?.verdict) {
		rows.push(`\n**spoil** — live drift ${results.spoil.liveDrift}, held drift ${results.spoil.heldDrift} ` +
			`(law: held <= live); held stack survived; hold discarded clean (holds=${results.spoil.discard?.holds}).`);
	}
	if (results.damage?.verdict) {
		rows.push(`\n**damage** — hold-attributable damage ${results.damage.platformDamage}; held asteroid ` +
			`contained=${results.damage.heldAsteroidContained}; hold discarded clean (holds=${results.damage.discard?.holds}).`);
	}
	if (results.pod?.verdict) {
		rows.push(`\n**pod** — staged pod-free=${results.pod.stagedPodFree}; held copper retained ` +
			`stage=${results.pod.afterStage?.held?.totalCopper} after=${results.pod.after?.held?.totalCopper} ` +
			`(>=100 law); live control kept its pod; hold discarded clean (holds=${results.pod.discard?.holds}).`);
	}
	if (results.errors.length) rows.push(`\n**Errors:**\n${results.errors.map(e => `- ${e}`).join("\n")}`);
	rows.push(`\n<details><summary>Raw results JSON</summary>\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n</details>`);
	return rows.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
