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

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadGalleryManifest } from "../lab-gallery/manifest.mjs";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const NOTEBOOK = fileURLToPath(new URL("./NOTEBOOK.md", import.meta.url));
const FIXTURE_ID = "census-fusion-shared-plasma";
const PLATFORM = "lab-census-fusion-v1";
const GOLDEN_SOURCE_SAVE = "lab-r2-golden-source.zip";
const GOLDEN_DEST_SAVE = "lab-r2-golden-dest.zip";
const RESTORE_SAVES = { 1: "test1.zip", 2: "test2.zip" };
const HOSTS = {
	1: { container: "surface-export-host-1", instance: "clusterio-host-1-instance-1" },
	2: { container: "surface-export-host-2", instance: "clusterio-host-2-instance-1" },
};
const FLUID_EPSILON = 1e-6;   // the gate's aggregate-by-name epsilon
const DOUBLE_EPSILON = 1e-9;  // save/load ULP allowance on fingerprint doubles (verify-save convention)

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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function lastLine(v) { return String(v).split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) || ""; }

function docker(args, options = {}) {
	return execFileSync("docker", args, {
		encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 32 * 1024 * 1024, ...options,
	});
}

function ctl(...args) {
	return docker(["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"--config", CTL_CONFIG, ...args], { timeout: 180_000 });
}

function rcon(host, command) {
	return docker(["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", HOSTS[host].instance, command, "--config", CTL_CONFIG],
	{ timeout: 180_000 }).trim();
}

// JSON-wrapped Lua control op (the R1 convention). Never used where an error must be silent.
function lua(host, body) {
	const command = `/sc local ok,result=pcall(function() ${body} end); ` +
		`if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	const raw = lastLine(rcon(host, command));
	try { return JSON.parse(raw); }
	catch (error) { throw new Error(`Invalid Lua JSON from host ${host}: ${raw}\n${error.message}`); }
}

// Resolved from `instance save list` (first column is instanceId — a verified output shape).
function instanceIds() {
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

function instancePath(host, suffix) {
	return `/clusterio/data/instances/${HOSTS[host].instance}/${suffix}`;
}

// --- Lease / preflight ---------------------------------------------------------------------------

// The exclusive-lease reading. Refuses (never repairs) hostile state: connected players, a paused
// game, or any transient plugin state (jobs, locks, holds, tombstones).
function preflightState(host) {
	return lua(host, `local function n(t) return table_size(t or {}) end;` +
		`return {success=true,tick=game.tick,players=#game.connected_players,paused=game.tick_paused==true,` +
		`plugin=remote.interfaces['surface_export']~=nil,` +
		`jobs=n(storage.async_jobs),locks=n(storage.locked_platforms),holds=n(storage.destination_holds),` +
		`tombstones=n(storage.committed_source_transfer_tombstones)}`);
}

function assertLeaseClean(host, state, phase) {
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

function loadedSave(host) {
	const out = ctl("instance", "save", "list", HOSTS[host].instance);
	for (const line of out.split(/\r?\n/)) {
		const cells = line.split("|").map(c => c.trim());
		if (cells.length >= 5 && cells[4] === "true") return cells[2];
	}
	throw new Error(`No loaded save found for host ${host}:\n${out}`);
}

// --- Save assignment -----------------------------------------------------------------------------

async function waitReady(host, timeoutMs = 180_000) {
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

async function assignSave(host, saveName) {
	ctl("instance", "stop", HOSTS[host].instance);
	ctl("instance", "start", HOSTS[host].instance, "--save", saveName);
	return waitReady(host);
}

async function loadGoldenPair(manifest, phase) {
	const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
	// STOP FIRST, copy SECOND: stopping a running instance EXIT-SAVES its (possibly mutated) world
	// back into the save file it was started from — copying the pristine golden zip before the stop
	// gets clobbered by that exit-save (measured: variant B reloaded a world whose fixture the
	// variant-A transfer had already consumed).
	ctl("instance", "stop", HOSTS[1].instance);
	ctl("instance", "stop", HOSTS[2].instance);
	docker(["cp", `${repoRoot}${manifest.saves.source.artifact}`,
		`${HOSTS[1].container}:${instancePath(1, `saves/${GOLDEN_SOURCE_SAVE}`)}`], { timeout: 180_000 });
	docker(["cp", `${repoRoot}${manifest.saves.destination.artifact}`,
		`${HOSTS[2].container}:${instancePath(2, `saves/${GOLDEN_DEST_SAVE}`)}`], { timeout: 180_000 });
	// Lockstep: both instances land on the golden pair before any fixture is touched.
	ctl("instance", "start", HOSTS[1].instance, "--save", GOLDEN_SOURCE_SAVE);
	await waitReady(1);
	ctl("instance", "start", HOSTS[2].instance, "--save", GOLDEN_DEST_SAVE);
	await waitReady(2);
	assertLeaseClean(1, preflightState(1), phase);
	assertLeaseClean(2, preflightState(2), phase);
	// EXPORT-ID UNIQUIFIER (instrumentation-level, no physical state touched): the golden world's
	// deterministic job counter regenerates IDENTICAL export/transfer IDs every load, and the
	// controller correctly REFUSES a same-ID retry once a prior record settled with a committed
	// destination (transfer-orchestrator retry semantics, 2026-07-18). Offsetting the counter after
	// each load gives every batch run collision-free IDs without weakening that production guard.
	const offset = 100 + (Date.now() % 1_000_000);
	const bumped = lua(1, `storage.async_job_id_counter=(storage.async_job_id_counter or 0)+${offset};` +
		`return {success=true,counter=storage.async_job_id_counter}`);
	if (!bumped.success) throw new Error(`export-id uniquifier failed: ${bumped.error}`);
}

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

// Deterministic golden worlds regenerate IDENTICAL debug filenames (same platform, same tick), so a
// rerun OVERWRITES the prior file instead of creating a new path — a "new paths only" detector goes
// blind on every run after the first (measured). Detection is mtime-vs-marker instead.
function dropMarker(host, name) {
	const marker = `/tmp/r2-marker-${name}`;
	docker(["exec", HOSTS[host].container, "sh", "-c", `touch ${marker}`]);
	return marker;
}

function filesNewerThanMarker(host, marker, glob) {
	try {
		return docker(["exec", HOSTS[host].container, "sh", "-c",
			`find ${instancePath(host, "script-output")} -maxdepth 1 -name '${glob}' -newer ${marker} 2>/dev/null || true`])
			.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	} catch { return []; }
}

function readContainerJson(host, path) {
	return JSON.parse(docker(["exec", HOSTS[host].container, "cat", path]));
}

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

async function waitForImportResult(host, marker, timeoutMs = 240_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const fresh = filesNewerThanMarker(host, marker, "debug_import_result_*.json");
		if (fresh.length) {
			// The file may be mid-write when first seen — retry the read on a parse failure.
			try { return { path: fresh.at(-1), result: readContainerJson(host, fresh.at(-1)) }; }
			catch { /* mid-write; poll again */ }
		}
		await sleep(3000);
	}
	throw new Error(`no fresh debug_import_result on host ${host} within ${timeoutMs} ms`);
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
			try {
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
				// Release the pair: restore the pre-batch live saves, then prove zero leftovers.
				await assignSave(1, RESTORE_SAVES[1]);
				await assignSave(2, RESTORE_SAVES[2]);
				// NOTE: stopping a golden session re-saves its file (Factorio saves on exit), so the
				// rm must come AFTER the restore-assign; the proof reads the FILESYSTEM (the
				// controller's `save list` is a cache that can list a deleted file).
				const leftovers = [];
				for (const [host, name] of [[1, GOLDEN_SOURCE_SAVE], [2, GOLDEN_DEST_SAVE]]) {
					const path = instancePath(host, `saves/${name}`);
					docker(["exec", HOSTS[host].container, "sh", "-c", `rm -f -- ${path}`]);
					try { docker(["exec", HOSTS[host].container, "test", "!", "-e", path]); }
					catch { leftovers.push(`${name} still on host ${host} filesystem`); }
				}
				for (const host of [1, 2]) {
					docker(["exec", HOSTS[host].container, "sh", "-c", "rm -f /tmp/r2-marker-*"]);
					assertLeaseClean(host, preflightState(host), "release");
				}
				if (leftovers.length) throw new Error(`temporary golden saves leaked: ${leftovers.join("; ")}`);
				results.restored = { 1: RESTORE_SAVES[1], 2: RESTORE_SAVES[2], zeroLeftovers: true };
			} catch (error) {
				results.errors.push(`RESTORE FAILED (cluster may be displaced!): ${error.stack || error.message}`);
			}
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
