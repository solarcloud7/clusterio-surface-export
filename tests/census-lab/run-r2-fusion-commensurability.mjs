#!/usr/bin/env node
// census-lab R2 — fusion-commensurability rung: the census-fusion-shared-plasma bake gate.
//
// The FIRST certified single-use baked-fixture batch (docs/lab-tests.md lifecycle). Loads the paired
// golden gallery saves onto the live cluster via Clusterio-native save assignment and proves, from the
// SAVE-LOADED world, the fixture's testCard law:
//
//   LAW      Paired-reads census is commensurate on engine-owned fluids: transferring a platform whose
//            fusion plasma parks in shared/buffer segments yields census ok (zero fluid delta) and the
//            strict gate passes exactly; the plasma is never serialized and never restored.
//   TEETH    (Variant B) a REAL serializer omission (test_force_census_omission, pre-gate fail-safe —
//            Pitfall #30, mutating test hooks must be fail-safe on leak) still ABORTS the transfer,
//            preserves the source, and never contacts the destination.
//
// Batch lifecycle (single-use baked fixtures — NO cleanup between fixtures; golden-pair reload is the
// reset): lease preflight -> load golden pair -> fingerprint verify -> Variant A (production
// /transfer-platform, terminal record, independent physical destination census) -> reload pair ->
// Variant B (armed omission, abort assertions) -> unconditional finalizer restores the instances'
// pre-batch saves (the shared dev cluster's "release": host-1 test1.zip / host-2 test2.zip) and
// removes the temporary golden save files (zero leftovers).
//
// Grounding: the census/gate meters are UNDER TEST, so Variant A's destination evidence is an
// INDEPENDENT physical count (get_item_count / fluidbox reads mirroring reload-meter.cjs), adjudicated
// AFTER the production verdict (validation_success in debug_import_result) — never the meter's
// self-report alone.
//
// Usage:
//   node tests/census-lab/run-r2-fusion-commensurability.mjs                # full batch, appends NOTEBOOK
//   node tests/census-lab/run-r2-fusion-commensurability.mjs --no-notebook  # debug iteration
//   node tests/census-lab/run-r2-fusion-commensurability.mjs --sections=preflight,load,variant-a
//   node tests/census-lab/run-r2-fusion-commensurability.mjs --restore-only # finalizer alone
//
// A "passed" claim requires TWO consecutive full green runs (CLAUDE.md probe rule 8).

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
	createBatchLifecycle, FLUID_EPSILON, DOUBLE_EPSILON, RESTORE_SAVES,
} from "../lab-gallery/batch-lifecycle.mjs";
import { loadGalleryManifest } from "../lab-gallery/manifest.mjs";

const NOTEBOOK = fileURLToPath(new URL("./NOTEBOOK.md", import.meta.url));
const FIXTURE_ID = "census-fusion-shared-plasma";
const PLATFORM = "lab-census-fusion-v1";

// The generic single-use baked-fixture batch lifecycle (docs/lab-tests.md), bound to this runner's
// temporary golden save filenames and /tmp marker prefix.
const L = createBatchLifecycle({
	goldenSourceSave: "lab-r2-golden-source.zip",
	goldenDestSave: "lab-r2-golden-dest.zip",
	markerPrefix: "r2-marker",
});
const {
	rcon, lua, instanceIds, loadedSave, preflightState, assertLeaseClean,
	loadGoldenPair, dropMarker, filesNewerThanMarker, readContainerJson, waitForImportResult,
	restoreLivePair, sleep, lastLine,
} = L;

const ALL_SECTIONS = ["preflight", "load", "variant-a", "variant-b", "restore"];
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
// Any section that displaces the live saves (load, or a variant that reloads the pair) MUST be
// followed by restore — a debug invocation like --sections=variant-b would otherwise leave the
// shared cluster on golden saves with a possibly-armed hook (/code-review finding, 2026-07-18).
if (["load", "variant-a", "variant-b"].some(s => sections.includes(s)) && !sections.includes("restore")) {
	sections.push("restore");
	console.error("note: restore section auto-appended (displacing sections always restore)");
}
const runs = section => sections.includes(section);

// --- Fixture -------------------------------------------------------------------------------------

// Mirrors the committed reload-meter.cjs census-fusion block exactly (same reads, same fields).
function measureFixture(host) {
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
			local found=cfs.find_entities_filtered{name=name}
			for _,e in ipairs(found) do if e.position.x==x and e.position.y==y then return e end end
			error('missing '..name..' at '..x..','..y)
		end
		local cfr=at('fusion-reactor',0,0)
		local cfg=at('fusion-generator',0.5,-5.5)
		local cf={success=true,platformIndex=surf.index,surfaceIndex=cfs.index,
			entities=#cfs.find_entities_filtered{},generatorCount=#cfs.find_entities_filtered{name='fusion-generator'},
			fuelCells=cfr.get_item_count('fusion-power-cell'),coolant=0,plasmaSegment=0,
			reactorCoolantSegVisible=false,reactorPlasmaSegVisible=false,
			generatorPlasmaSegNil=cfg.fluidbox.get_fluid_segment_id(1)==nil,
			allFrozen=(not cfr.active)and(not cfg.active),
			allIndestructible=(not cfr.destructible)and(not cfg.destructible)}
		for i=1,#cfr.fluidbox do
			local f=cfr.fluidbox[i] local sid=cfr.fluidbox.get_fluid_segment_id(i)
			if f and f.name=='fluoroketone-cold' then cf.coolant=cf.coolant+f.amount cf.reactorCoolantSegVisible=sid~=nil
			elseif f and f.name=='fusion-plasma' then cf.reactorPlasmaSegVisible=sid~=nil if f.amount>cf.plasmaSegment then cf.plasmaSegment=f.amount end end
		end
		local cgf=cfg.fluidbox[1]
		if cgf and cgf.name=='fusion-plasma' and cgf.amount>cf.plasmaSegment then cf.plasmaSegment=cgf.amount end
		return cf`.replace(/\s*\n\s*/g, " "));
}

function assertFingerprint(measured, expected) {
	const tolerant = new Set(["coolant", "plasmaSegment"]);
	for (const [key, value] of Object.entries(expected)) {
		const actual = measured[key];
		const ok = tolerant.has(key) && typeof actual === "number" && typeof value === "number"
			? Math.abs(actual - value) <= DOUBLE_EPSILON
			: actual === value;
		if (!ok) throw new Error(`fingerprint ${key} is ${JSON.stringify(actual)}, expected ${JSON.stringify(value)}`);
	}
}

// --- Production transfer + terminal record --------------------------------------------------------

function platformSnapshot(host) {
	return lua(host, `local found=nil; local count=0;` +
		`for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name=='${PLATFORM}' then ` +
		`count=count+1; found={index=p.index,entities=#p.surface.find_entities_filtered{}} end end;` +
		`return {success=true,count=count,platform=found}`);
}

// Independent physical destination census (the grounding read — mirrors the meter classes, but runs
// on the DESTINATION world through plain engine APIs, independent of the validator's self-report).
// BUFFER-CLASS LAW [empirical 2.0.77, api-notes buffer-class entry]: a box can expose a segment ID
// whose get_fluid_segment_contents reads EMPTY while the physical fluid is only visible in the LOCAL
// proxy (fusion-reactor coolant). The segment branch below mirrors
// FluidOwnership.effective_segment_contents — segment contents first, local read when the segment
// reads empty. (This meter's first draft used the blind segment read and measured coolant 0 — the
// fixture caught its own meter.) NOTE: the template is flattened to ONE line; no Lua "--" comments.
function destinationPhysicalCensus(host) {
	return lua(host, `
		local surf; for _,p in pairs(game.forces.player.platforms) do
			if p.valid and p.name=='${PLATFORM}' then surf=p.surface end
		end
		if not surf then return {success=false,error='destination platform missing'} end
		local fluids={}
		local counted={}
		for _,e in ipairs(surf.find_entities_filtered{}) do
			if e.fluidbox then
				for i=1,#e.fluidbox do
					local sid=e.fluidbox.get_fluid_segment_id(i)
					if sid then
						if not counted[sid] then counted[sid]=true
							local c=e.fluidbox.get_fluid_segment_contents(i)
							local has=false
							if c then for name,amt in pairs(c) do fluids[name]=(fluids[name] or 0)+amt has=true end end
							if not has then
								local f=e.fluidbox[i]
								if f and f.name then fluids[f.name]=(fluids[f.name] or 0)+f.amount end
							end
						end
					else
						local f=e.fluidbox[i]
						if f and f.name then fluids[f.name]=(fluids[f.name] or 0)+f.amount end
					end
				end
			end
		end
		local fuel=0
		for _,e in ipairs(surf.find_entities_filtered{name='fusion-reactor'}) do fuel=fuel+e.get_item_count('fusion-power-cell') end
		return {success=true,entities=#surf.find_entities_filtered{},fuelCells=fuel,fluids=fluids}`
		.replace(/\s*\n\s*/g, " "));
}

async function waitForCensusAbort(host, marker, timeoutMs = 180_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const fresh = filesNewerThanMarker(host, marker, "failure_black_box_census_*.json");
		if (fresh.length) {
			try { return { path: fresh.at(-1), bundle: readContainerJson(host, fresh.at(-1)) }; }
			catch { /* mid-write; poll again */ }
		}
		await sleep(2000);
	}
	throw new Error(`no fresh census abort bundle on host ${host} within ${timeoutMs} ms`);
}

// --- Main ----------------------------------------------------------------------------------------

async function main() {
	const manifest = loadGalleryManifest(new URL("../../", import.meta.url));
	const fixture = manifest.fixtures.find(f => f.id === FIXTURE_ID);
	if (!fixture) throw new Error(`fixture ${FIXTURE_ID} missing from gallery manifest`);
	const results = {
		script: "tests/census-lab/run-r2-fusion-commensurability.mjs",
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
			results.goldenLoaded = true;
		}

		if (runs("variant-a")) {
			const measured = measureFixture(1);
			if (!measured.success) throw new Error(`fixture resolve failed: ${measured.error}`);
			assertFingerprint(measured, fixture.fingerprint);
			results.variantA = { fingerprint: measured };

			// The terminal-record instrument (debug_import_result) is debug-gated; a golden save with
			// debug off would read as a timeout, not a clean failure — assert it up front instead.
			const debugState = lua(2, `return {success=true,debug=storage.surface_export_config` +
				` and storage.surface_export_config.debug_mode==true}`);
			if (!debugState.debug) throw new Error("debug_mode is OFF on the golden destination — terminal record unreadable");

			const importMarker = dropMarker(2, "variant-a-import");
			const abortMarker = dropMarker(1, "variant-a-abort");
			const transferOut = rcon(1, `/transfer-platform ${measured.platformIndex} ${ids[2]}`);
			results.variantA.transferCommand = { platformIndex: measured.platformIndex, out: lastLine(transferOut) };

			// Terminal production record FIRST (adjudicate the verdict), physical census AFTER.
			const terminal = await waitForImportResult(2, importMarker);
			results.variantA.importResultPath = terminal.path;
			if (terminal.result.validation_success !== true) {
				throw new Error(`Variant A transfer did not succeed: ` +
					`failedStage=${terminal.result?.validation_result?.failedStage ?? "unreported"} ` +
					`error=${terminal.result?.error ?? terminal.result?.validation_result?.error ?? "unreported"}`);
			}

			const physical = destinationPhysicalCensus(2);
			if (!physical.success) throw new Error(`destination physical census failed: ${physical.error}`);
			results.variantA.physical = physical;
			const coolant = physical.fluids["fluoroketone-cold"] || 0;
			const plasma = physical.fluids["fusion-plasma"] || 0;
			if (physical.entities !== fixture.fingerprint.entities) {
				throw new Error(`destination entities ${physical.entities}, expected ${fixture.fingerprint.entities}`);
			}
			if (physical.fuelCells !== fixture.fingerprint.fuelCells) {
				throw new Error(`destination fuel cells ${physical.fuelCells}, expected ${fixture.fingerprint.fuelCells}`);
			}
			if (Math.abs(coolant - fixture.fingerprint.coolant) > FLUID_EPSILON) {
				throw new Error(`destination coolant ${coolant}, expected ${fixture.fingerprint.coolant} (eps ${FLUID_EPSILON})`);
			}
			// The LAW's sharp edge: physically-present plasma is engine-owned — never serialized,
			// never restored — and its absence must NOT have failed the census or the gate above.
			if (plasma !== 0) throw new Error(`destination plasma ${plasma}, expected 0 (never restored)`);

			const sourceAfter = platformSnapshot(1);
			if (sourceAfter.count !== 0) throw new Error(`source platform survived a committed transfer (count=${sourceAfter.count})`);
			const abortLeak = filesNewerThanMarker(1, abortMarker, "failure_black_box_census_*.json");
			if (abortLeak.length) throw new Error(`unexpected census abort bundle(s) on a green transfer: ${abortLeak.join(", ")}`);
			results.variantA.verdict = "GREEN";
		}

		if (runs("variant-b")) {
			// Golden-pair reload IS the reset between fixture uses (no cleanup of the consumed one).
			savesDisplaced = true;
			await loadGoldenPair(manifest, "variant-b-reload");
			const measured = measureFixture(1);
			if (!measured.success) throw new Error(`variant-b fixture resolve failed: ${measured.error}`);
			assertFingerprint(measured, fixture.fingerprint);
			results.variantB = { fingerprint: "reproduced" };

			const armed = lua(1, `remote.call('surface_export','configure',{test_force_census_omission=true});` +
				`return {success=true,armed=storage.surface_export_config.test_force_census_omission==true}`);
			if (!armed.armed) throw new Error("test_force_census_omission did not arm");

			const bundleMarker = dropMarker(1, "variant-b-bundle");
			const destMarker = dropMarker(2, "variant-b-import");
			rcon(1, `/transfer-platform ${measured.platformIndex} ${ids[2]}`);

			const abort = await waitForCensusAbort(1, bundleMarker);
			results.variantB.bundlePath = abort.path;
			if (abort.bundle.reason !== "source_census_mismatch") {
				throw new Error(`abort bundle reason '${abort.bundle.reason}', expected source_census_mismatch`);
			}
			const mismatches = abort.bundle.mismatches || abort.bundle.verdict?.mismatches || [];
			if (mismatches.length !== 1) {
				throw new Error(`expected exactly 1 attributed mismatch row, got ${mismatches.length}`);
			}
			results.variantB.mismatch = mismatches[0];

			// Source preserved, destination never contacted, hook consumed (one entity, one export).
			const sourceAfter = platformSnapshot(1);
			if (sourceAfter.count !== 1 || sourceAfter.platform.entities !== fixture.fingerprint.entities) {
				throw new Error(`aborted transfer did not preserve the source: ${JSON.stringify(sourceAfter)}`);
			}
			const destAfter = platformSnapshot(2);
			if (destAfter.count !== 0) throw new Error(`destination was contacted on an aborted transfer: ${JSON.stringify(destAfter)}`);
			const destImports = filesNewerThanMarker(2, destMarker, "debug_import_result_*.json");
			if (destImports.length) throw new Error(`destination received import work on an aborted transfer: ${destImports.join(", ")}`);
			const consumed = lua(1, `return {success=true,flag=storage.surface_export_config.test_force_census_omission}`);
			if (consumed.flag !== undefined && consumed.flag !== null) {
				throw new Error(`omission hook not consumed: flag=${JSON.stringify(consumed.flag)}`);
			}
			results.variantB.verdict = "GREEN";
		}
	} catch (error) {
		results.errors.push(error.stack || error.message);
	} finally {
		if (runs("restore") && (savesDisplaced || restoreOnly)) {
			await restoreLivePair(results, results.errors);
		}
		results.finished = new Date().toISOString();
		results.green = results.errors.length === 0 &&
			(!runs("variant-a") || results.variantA?.verdict === "GREEN") &&
			(!runs("variant-b") || results.variantB?.verdict === "GREEN");
		if (!noNotebook && !restoreOnly && sections.length === ALL_SECTIONS.length) {
			appendFileSync(NOTEBOOK, renderNotebook(results));
		}
		console.log(JSON.stringify(results, null, 2));
		if (!results.green) process.exitCode = 1;
	}
}

function renderNotebook(results) {
	const a = results.variantA, b = results.variantB;
	const L = [];
	L.push(`\n\n## ${results.finished} — R2 fusion-commensurability (bake gate, ${results.green ? "GREEN" : "RED"})`);
	L.push(`\nBatch lifecycle run of \`${results.script}\` against the committed golden pair loaded via ` +
		`Clusterio-native save assignment (instances ${JSON.stringify(results.instanceIds)}); ` +
		`pre-batch saves ${JSON.stringify(results.preBatchSaves)}, restored ${JSON.stringify(results.restored)}.`);
	if (a) {
		L.push(`\n**Variant A (law)** — fingerprint reproduced from the SAVE-LOADED world (coolant ${a.fingerprint?.coolant}, ` +
			`plasma segment ${a.fingerprint?.plasmaSegment}, all frozen+indestructible). Production ` +
			`\`/transfer-platform ${a.transferCommand?.platformIndex}\` reached terminal validation_success=true ` +
			`(${a.importResultPath}). INDEPENDENT physical destination census: entities ${a.physical?.entities}, ` +
			`fuel cells ${a.physical?.fuelCells}, fluids ${JSON.stringify(a.physical?.fluids)} — coolant exact at 1e-6, ` +
			`plasma ABSENT (never serialized, never restored), source deleted, zero census-abort artifacts. ${a.verdict}.`);
	}
	if (b) {
		L.push(`\n**Variant B (teeth)** — golden pair reloaded (the reset), fingerprint reproduced, ` +
			`\`test_force_census_omission\` armed (pre-gate fail-safe hook). Transfer ABORTED with ` +
			`reason=source_census_mismatch, exactly one attributed row (${JSON.stringify(b.mismatch)}), ` +
			`bundle ${b.bundlePath}; source preserved (3 entities), destination never contacted, hook consumed. ${b.verdict}.`);
	}
	if (results.errors.length) L.push(`\n**Errors:**\n${results.errors.map(e => `- ${e}`).join("\n")}`);
	L.push(`\n<details><summary>Raw results JSON</summary>\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n</details>`);
	return L.join("\n");
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
