#!/usr/bin/env node
// UNIFIED golden-batch runner — every baked-fixture check in ONE golden-pair load (owner directive
// 2026-07-18: "we should have everything on 1 save ready to go... we need to merge all our tests
// into 1 saved game already").
//
// One load of the committed golden pair, then in sequence:
//   1. b8   — no-tick-sync-lab B8 measure (fingerprint + run 1 fresh seating + run 2 tick-paused).
//             MUTATES the source: seats iron-plate x1 on the pair inserter — deliberate; the plate
//             then RIDES the whole-omnibus transfer and the exact gate must conserve it.
//   2. b7   — inserter-lab B7: production /transfer-platform of the WHOLE omnibus platform
//             (adversarial bonus-0 destination asserted at load), terminal verdict, independent
//             physical destination reads.
//   3. rider — the B8 pair's twin on the DESTINATION physically holds the seated plate (proof the
//             B8 mutation rode the transfer through the exact gate).
// then ONE unconditional restore. Total: one load + one restore instead of two full batches.
//
// The fixture checks are the owning runners' EXPORTED sections (tests/inserter-lab/
// run-b7-held-capacity-batch.mjs, tests/no-tick-sync-lab/run-b8-baked-pair.mjs) — this runner owns
// only the composition, so a green here is a green of the SAME assertions the owning runners define,
// and NOTEBOOK entries land in EACH owning lab via the owners' renderers.
//
// The census fixtures keep their own certified owning runner (tests/census-lab/
// run-r2-fusion-commensurability.mjs) — its variant-B abort teeth need a mid-batch reload that
// doesn't compose into the single-load sequence.
//
// Usage:
//   node tests/lab-gallery/run-golden-batch.mjs                 # full batch, appends both NOTEBOOKs
//   node tests/lab-gallery/run-golden-batch.mjs --no-notebook   # debug iteration
//   node tests/lab-gallery/run-golden-batch.mjs --sections=preflight,load,b8
//   node tests/lab-gallery/run-golden-batch.mjs --restore-only  # finalizer alone
//
// A "passed" claim requires TWO consecutive full green runs (CLAUDE.md probe rule 8).

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createBatchLifecycle } from "./batch-lifecycle.mjs";
import { loadGalleryManifest } from "./manifest.mjs";
import {
	B7_FIXTURE_ID, b7AssertAdversarialDest, b7TransferSection, renderB7Notebook,
} from "../inserter-lab/run-b7-held-capacity-batch.mjs";
import {
	B8_FIXTURE_ID, B8_HELD, b8MeasureSection, readPair, renderB8Notebook,
} from "../no-tick-sync-lab/run-b8-baked-pair.mjs";

const B7_NOTEBOOK = fileURLToPath(new URL("../inserter-lab/NOTEBOOK.md", import.meta.url));
const B8_NOTEBOOK = fileURLToPath(new URL("../no-tick-sync-lab/NOTEBOOK.md", import.meta.url));

const L = createBatchLifecycle({
	goldenSourceSave: "lab-goldenbatch-source.zip",
	goldenDestSave: "lab-goldenbatch-dest.zip",
	markerPrefix: "goldenbatch-marker",
});
const {
	instanceIds, loadedSave, preflightState, assertLeaseClean,
	loadGoldenPair, restoreLivePair, RESTORE_SAVES,
} = L;

const ALL_SECTIONS = ["preflight", "load", "b8", "b7", "rider", "restore"];
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
// Any section that displaces the live saves MUST be followed by restore.
if (["load", "b8", "b7", "rider"].some(s => sections.includes(s)) && !sections.includes("restore")) {
	sections.push("restore");
	console.error("note: restore section auto-appended (displacing sections always restore)");
}
const runs = section => sections.includes(section);

async function main() {
	const manifest = loadGalleryManifest(new URL("../../", import.meta.url));
	const fixtureB7 = manifest.fixtures.find(f => f.id === B7_FIXTURE_ID);
	const fixtureB8 = manifest.fixtures.find(f => f.id === B8_FIXTURE_ID);
	if (!fixtureB7) throw new Error(`fixture ${B7_FIXTURE_ID} missing from gallery manifest`);
	if (!fixtureB8) throw new Error(`fixture ${B8_FIXTURE_ID} missing from gallery manifest`);

	const results = {
		script: "tests/lab-gallery/run-golden-batch.mjs",
		started: new Date().toISOString(), sections, errors: [],
		// Per-section results keep the owning runners' field names collision-free (both set `verdict`).
		b7: {}, b8: {},
	};
	// Sections push mid-flight failures (e.g. B8's unpause guard) onto their own errors reference;
	// share the batch-level array so nothing is lost.
	results.b7.errors = results.errors;
	results.b8.errors = results.errors;
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
			// The B7 adversarial-destination gate belongs to the load: assert it before ANY
			// measurement touches the pair (never forced).
			b7AssertAdversarialDest(results.b7);
			results.goldenLoaded = true;
		}

		if (runs("b8")) {
			await b8MeasureSection(fixtureB8, results.b8);
		}

		if (runs("b7")) {
			await b7TransferSection(L, fixtureB7, results.b7, ids);
		}

		if (runs("rider")) {
			// The B8 mutation rode the transfer: the pair's twin on the DESTINATION physically holds
			// the seated plate. Contract-scoped (test-contract boundaries): held name+count and
			// inactivity only — nothing beyond what the B8 mutation put in flight.
			const destPair = readPair(2);
			if (!destPair.success) throw new Error(`destination pair read failed: ${destPair.error}`);
			results.rider = destPair;
			if (destPair.heldName !== B8_HELD.name || destPair.heldCount !== B8_HELD.count) {
				throw new Error(`destination pair inserter holds ${destPair.heldCount} '${destPair.heldName}', ` +
					`expected the seated ${B8_HELD.count} '${B8_HELD.name}' to ride the transfer`);
			}
			if (destPair.assemblerActive !== false || destPair.inserterActive !== false) {
				throw new Error(`destination pair activated (assembler=${destPair.assemblerActive}, ` +
					`inserter=${destPair.inserterActive}) — frozen fixture must arrive inactive`);
			}
			results.riderVerdict = "GREEN";
		}
	} catch (error) {
		results.errors.push(error.stack || error.message);
	} finally {
		if (runs("restore") && (savesDisplaced || restoreOnly)) {
			await restoreLivePair(results, results.errors);
		}
		results.finished = new Date().toISOString();
		results.green = results.errors.length === 0
			&& (!runs("b8") || results.b8.verdict === "GREEN")
			&& (!runs("b7") || results.b7.verdict === "GREEN")
			&& (!runs("rider") || results.riderVerdict === "GREEN");
		if (!noNotebook && !restoreOnly && sections.length === ALL_SECTIONS.length) {
			// One entry per OWNING lab, via the owners' renderers, over shared batch meta + the
			// section's own fields (the composed run is evidence in BOTH labs).
			const meta = {
				script: results.script, instanceIds: results.instanceIds,
				preBatchSaves: results.preBatchSaves, restored: results.restored,
				finished: results.finished, green: results.green, errors: results.errors,
			};
			appendFileSync(B8_NOTEBOOK, renderB8Notebook({ ...meta, ...results.b8 }));
			appendFileSync(B7_NOTEBOOK, renderB7Notebook({ ...meta, ...results.b7 }));
		}
		console.log(JSON.stringify(results, null, 2));
		if (!results.green) process.exitCode = 1;
	}
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
