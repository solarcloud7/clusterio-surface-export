#!/usr/bin/env node
// inserter-lab B7 — the owning batch runner for the gallery fixture `inserter-held-capacity`.
//
// The single-use baked-fixture BATCH LIFECYCLE (docs/lab-tests.md, shared plumbing in
// tests/lab-gallery/batch-lifecycle.mjs) proves the fixture's testCard law from the SAVE-LOADED world:
//
//   LAW      Held items seat IN FULL on a LESS-RESEARCHED destination. Export captures the source
//            force's inserter-capacity bonuses; import replicates them RAISE-ONLY (Pitfall #29,
//            dest-force research) before hydration; the strict gate counts the complete physical
//            state (Pitfall #28, count a complete state) and reports SUCCESS.
//   ADVERSARIAL STATE  The loaded golden DESTINATION force has bulk_inserter_capacity_bonus == 0 — the
//            natural under-researched state (ASSERTED, never forced). If it is nonzero the batch FAILS
//            (the fixture no longer discriminates the fix from a no-op).
//
// Batch lifecycle: lease preflight -> load golden pair (assert dest bonus 0) -> fingerprint verify the
// source inserter -> production /transfer-platform -> terminal debug_import_result (validation_success)
// -> INDEPENDENT PHYSICAL destination assertions (dest bonus raised, hand physically seats 8,
// forceDataMismatches present, source deleted) -> unconditional finalizer restores the pre-batch live
// saves and removes the temporary golden save files (zero leftovers).
//
// Grounding: the strict gate is UNDER TEST, so the destination evidence is an INDEPENDENT physical
// read (held_stack.count + force bonus), adjudicated AFTER the production verdict — never the
// validator's self-report alone.
//
// Usage:
//   node tests/inserter-lab/run-b7-held-capacity-batch.mjs                # full batch, appends NOTEBOOK
//   node tests/inserter-lab/run-b7-held-capacity-batch.mjs --no-notebook  # debug iteration
//   node tests/inserter-lab/run-b7-held-capacity-batch.mjs --sections=preflight,load,transfer
//   node tests/inserter-lab/run-b7-held-capacity-batch.mjs --restore-only # finalizer alone
//
// A "passed" claim requires TWO consecutive full green runs (CLAUDE.md probe rule 8).

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createBatchLifecycle } from "../lab-gallery/batch-lifecycle.mjs";
import { loadGalleryManifest } from "../lab-gallery/manifest.mjs";

const NOTEBOOK = fileURLToPath(new URL("./NOTEBOOK.md", import.meta.url));
const FIXTURE_ID = "inserter-held-capacity";
const PLATFORM = "lab-omnibus-state-v1";
const INSERTER_NAME = "bulk-inserter";
const INSERTER_POS = { x: 40.5, y: -122.5 };
const MIN_BONUS = 11;   // source (and post-transfer dest) bulk_inserter_capacity_bonus floor

const L = createBatchLifecycle({
	goldenSourceSave: "lab-b7-golden-source.zip",
	goldenDestSave: "lab-b7-golden-dest.zip",
	markerPrefix: "b7-marker",
});
const {
	rcon, lua, instanceIds, loadedSave, preflightState, assertLeaseClean,
	loadGoldenPair, dropMarker, waitForImportResult, restoreLivePair,
	RESTORE_SAVES,
} = L;

const ALL_SECTIONS = ["preflight", "load", "transfer", "restore"];
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
// Any section that displaces the live saves (load, transfer) MUST be followed by restore — a debug
// invocation like --sections=transfer would otherwise leave the shared cluster on golden saves.
if (["load", "transfer"].some(s => sections.includes(s)) && !sections.includes("restore")) {
	sections.push("restore");
	console.error("note: restore section auto-appended (displacing sections always restore)");
}
const runs = section => sections.includes(section);

// --- Fixture reads (independent physical meters, never the validator's self-report) ---------------

// Resolve the platform by name (fail loud on ambiguity — the omnibus platform name could collide) and
// read the baked bulk-inserter at its exact position: hand count/name/quality, active/destructible,
// and the platform's player-force bulk-inserter capacity bonus. Runs on either host.
function readInserter(host) {
	return lua(host, `
		local surf; for _,p in pairs(game.forces.player.platforms) do
			if p.valid and p.name=='${PLATFORM}' then
				if surf then error('ambiguous platform name ${PLATFORM}') end
				surf={s=p.surface,index=p.index}
			end
		end
		if not surf then return {success=false,error='platform ${PLATFORM} not found'} end
		local cfs=surf.s
		local ins
		for _,e in ipairs(cfs.find_entities_filtered{name='${INSERTER_NAME}'}) do
			if e.position.x==${INSERTER_POS.x} and e.position.y==${INSERTER_POS.y} then ins=e end
		end
		if not ins then return {success=false,error='${INSERTER_NAME} not at ${INSERTER_POS.x},${INSERTER_POS.y}'} end
		local hs=ins.held_stack
		local readable=hs~=nil and hs.valid_for_read
		return {success=true,platformIndex=surf.index,surfaceIndex=cfs.index,
			heldCount=readable and hs.count or 0,
			heldName=readable and hs.name or nil,
			heldQuality=(readable and hs.quality) and hs.quality.name or nil,
			active=ins.active,destructible=ins.destructible,
			forceBonus=game.forces.player.bulk_inserter_capacity_bonus}`.replace(/\s*\n\s*/g, " "));
}

// The platform-force bulk-inserter capacity bonus on the loaded world (host-scoped).
function forceBonus(host) {
	return lua(host, `return {success=true,bonus=game.forces.player.bulk_inserter_capacity_bonus,` +
		`stack=game.forces.player.inserter_stack_size_bonus}`);
}

function platformSnapshot(host) {
	return lua(host, `local found=nil; local count=0;` +
		`for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name=='${PLATFORM}' then ` +
		`count=count+1; found={index=p.index,entities=#p.surface.find_entities_filtered{}} end end;` +
		`return {success=true,count=count,platform=found}`);
}

// --- Main ----------------------------------------------------------------------------------------

async function main() {
	const manifest = loadGalleryManifest(new URL("../../", import.meta.url));
	const fixture = manifest.fixtures.find(f => f.id === FIXTURE_ID);
	if (!fixture) throw new Error(`fixture ${FIXTURE_ID} missing from gallery manifest`);
	const results = {
		script: "tests/inserter-lab/run-b7-held-capacity-batch.mjs",
		started: new Date().toISOString(), sections, errors: [],
	};
	let savesDisplaced = false;
	try {
		const ids = instanceIds();
		results.instanceIds = ids;

		if (runs("preflight")) {
			// Record the restore targets BEFORE displacing anything; refuse hostile live state.
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
			// The ADVERSARIAL STATE is the loaded GOLDEN DESTINATION (host-2), not the pre-batch live
			// save: the bonus-0 dest is baked into the golden dest and is what makes the fix
			// discriminable. ASSERT it (never force it) — a nonzero bonus fails the batch loudly.
			const dest = forceBonus(2);
			if (!dest.success) throw new Error(`could not read destination force bonus: ${dest.error}`);
			results.destBonusBefore = dest.bonus;
			if (dest.bonus !== 0) {
				throw new Error(`loaded golden destination bulk_inserter_capacity_bonus is ${dest.bonus}, ` +
					`expected 0 (the under-researched adversarial state) — batch cannot discriminate the fix`);
			}
			results.goldenLoaded = true;
		}

		if (runs("transfer")) {
			// Fingerprint-verify the fixture on the loaded SOURCE (host-1) before the transfer.
			const src = readInserter(1);
			if (!src.success) throw new Error(`fixture resolve failed: ${src.error}`);
			results.sourceFingerprint = src;
			const fp = fixture.fingerprint;
			if (src.heldCount !== fp.heldCount) throw new Error(`source held ${src.heldCount}, expected ${fp.heldCount}`);
			if (src.heldName !== fp.heldName) throw new Error(`source held item '${src.heldName}', expected '${fp.heldName}'`);
			if (src.heldQuality !== fp.quality) throw new Error(`source held quality '${src.heldQuality}', expected '${fp.quality}'`);
			if (src.active !== fp.active) throw new Error(`source inserter active=${src.active}, expected ${fp.active}`);
			if (src.destructible !== fp.destructible) throw new Error(`source inserter destructible=${src.destructible}, expected ${fp.destructible}`);
			// Source bonus is a FLOOR (the invariant is >= 11), not the exact fingerprint value.
			if (!(src.forceBonus >= MIN_BONUS)) throw new Error(`source force bonus ${src.forceBonus}, expected >= ${MIN_BONUS}`);

			// The terminal-record instrument (debug_import_result) is debug-gated; assert debug on the
			// golden destination up front so an OFF save reads as a clean failure, not a timeout.
			const debugState = lua(2, `return {success=true,debug=storage.surface_export_config` +
				` and storage.surface_export_config.debug_mode==true}`);
			if (!debugState.debug) throw new Error("debug_mode is OFF on the golden destination — terminal record unreadable");

			const importMarker = dropMarker(2, "transfer-import");
			const transferOut = rcon(1, `/transfer-platform ${src.platformIndex} ${ids[2]}`);
			results.transferCommand = { platformIndex: src.platformIndex, out: String(transferOut).split(/\r?\n/).at(-1) };

			// Terminal production record FIRST (adjudicate the verdict), physical evidence AFTER.
			const terminal = await waitForImportResult(2, importMarker);
			results.importResultPath = terminal.path;
			const valResult = terminal.result?.validation_result;
			if (terminal.result.validation_success !== true) {
				throw new Error(`transfer did not succeed: ` +
					`failedStage=${valResult?.failedStage ?? "unreported"} ` +
					`error=${terminal.result?.error ?? valResult?.error ?? "unreported"}`);
			}

			// (1) Destination force bonus RAISED to >= 11 (the raise-only Phase-0 sync ran).
			const destAfter = forceBonus(2);
			if (!destAfter.success) throw new Error(`could not read post-transfer dest bonus: ${destAfter.error}`);
			results.destBonusAfter = destAfter.bonus;
			if (!(destAfter.bonus >= MIN_BONUS)) {
				throw new Error(`destination bonus after import ${destAfter.bonus}, expected >= ${MIN_BONUS} ` +
					`(raised from ${results.destBonusBefore}) — Phase-0 force-sync did not run`);
			}

			// (2) The transferred inserter PHYSICALLY holds 8 railgun-ammo at legendary (independent read).
			const dst = readInserter(2);
			if (!dst.success) throw new Error(`destination inserter read failed: ${dst.error}`);
			results.destInserter = dst;
			if (dst.heldCount !== fp.heldCount) throw new Error(`destination held ${dst.heldCount}, expected ${fp.heldCount} (hand under-seated)`);
			if (dst.heldName !== fp.heldName) throw new Error(`destination held item '${dst.heldName}', expected '${fp.heldName}'`);
			if (dst.heldQuality !== fp.quality) throw new Error(`destination held quality '${dst.heldQuality}', expected '${fp.quality}'`);

			// (3) forceDataMismatches present in the terminal record — under validation_result, per
			//     import-completion.lua (result.forceDataMismatches). Find the bulk-bonus entry.
			const fdm = valResult?.forceDataMismatches;
			if (!Array.isArray(fdm) || fdm.length === 0) {
				throw new Error(`forceDataMismatches absent in validation_result — the raise-only warning did not fire`);
			}
			const bulkEntry = fdm.find(e => e && e.property === "bulk_inserter_capacity_bonus");
			if (!bulkEntry) {
				throw new Error(`no bulk_inserter_capacity_bonus entry in forceDataMismatches: ${JSON.stringify(fdm)}`);
			}
			results.forceDataMismatch = bulkEntry;

			// (4) Source platform deleted on host-1 (committed transfer's sole delete chokepoint).
			const sourceAfter = platformSnapshot(1);
			if (sourceAfter.count !== 0) throw new Error(`source platform survived a committed transfer (count=${sourceAfter.count})`);

			results.verdict = "GREEN";
		}
	} catch (error) {
		results.errors.push(error.stack || error.message);
	} finally {
		if (runs("restore") && (savesDisplaced || restoreOnly)) {
			await restoreLivePair(results, results.errors);
		}
		results.finished = new Date().toISOString();
		results.green = results.errors.length === 0 && (!runs("transfer") || results.verdict === "GREEN");
		if (!noNotebook && !restoreOnly && sections.length === ALL_SECTIONS.length) {
			appendFileSync(NOTEBOOK, renderNotebook(results));
		}
		console.log(JSON.stringify(results, null, 2));
		if (!results.green) process.exitCode = 1;
	}
}

function renderNotebook(results) {
	const L2 = [];
	L2.push(`\n\n## ${results.finished} — B7 held-item capacity batch (bake gate, ${results.green ? "GREEN" : "RED"})`);
	L2.push(`\nRunner: \`${results.script}\` against the committed golden pair loaded via Clusterio-native ` +
		`save assignment (instances ${JSON.stringify(results.instanceIds)}); pre-batch saves ` +
		`${JSON.stringify(results.preBatchSaves)}, restored ${JSON.stringify(results.restored)}.`);
	if (results.verdict) {
		L2.push(`\n**Adversarial dest** — loaded golden destination bulk_inserter_capacity_bonus = ` +
			`${results.destBonusBefore} (asserted 0, never forced). **Source fingerprint** reproduced from the ` +
			`save-loaded world: ${INSERTER_NAME} at (${INSERTER_POS.x},${INSERTER_POS.y}) held ` +
			`${results.sourceFingerprint?.heldCount} ${results.sourceFingerprint?.heldName} (` +
			`${results.sourceFingerprint?.heldQuality}), inactive+indestructible, source force bonus ` +
			`${results.sourceFingerprint?.forceBonus}.`);
		L2.push(`\n**Transfer** — production \`/transfer-platform ${results.transferCommand?.platformIndex}\` ` +
			`reached terminal validation_success=true (${results.importResultPath}). INDEPENDENT physical ` +
			`destination reads: force bonus RAISED ${results.destBonusBefore} -> ${results.destBonusAfter} ` +
			`(raise-only), hand physically seats ${results.destInserter?.heldCount} ` +
			`${results.destInserter?.heldName} at ${results.destInserter?.heldQuality}, forceDataMismatches ` +
			`recorded (${JSON.stringify(results.forceDataMismatch)}), source deleted. ${results.verdict}.`);
	}
	if (results.errors.length) L2.push(`\n**Errors:**\n${results.errors.map(e => `- ${e}`).join("\n")}`);
	L2.push(`\n<details><summary>Raw results JSON</summary>\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n</details>`);
	return L2.join("\n");
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
