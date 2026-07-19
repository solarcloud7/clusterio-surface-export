#!/usr/bin/env node
// BELT-R14 — Phase A KILL-MEASUREMENT for Phase 5 (production side-scoped belt restore).
//
// Falsifiable claim under test: on the live DUP-233855-replayed source carrying the compressed-
// corner loss CLASS (596 belts, 1,490 lines, oversized consolidated stacks present), ONE
// same-execution production `BeltRestoration.capture_side_groups` partition plus
// `restore_side_groups` onto a freshly-rebuilt copy places every side's (name,quality) multiset
// EXACTLY with zero unplaced/anomalies and whole-copy census equal to the captured basis —
// where the current captured-position path deterministically loses on this class
// (-5 at import, BELT-R3/R9 baseline).
//
// Fixture: replay-import of the banked payload (BELT-R3 procedure, host-2, upload path). FIXTURE
// REFINEMENT (measured, run 1 2026-07-19): payload-per-side fidelity is UNATTAINABLE on the
// replayed world — the upload path ACTIVATES the platform at completion and its machines fed the
// belts (16,082 read vs 15,861 placed within seconds), and items legally cross sides at line
// handoffs even when paused (R13: belts move on paused platforms). The owner-approved surgery is
// therefore moot; the admissible fixture is CLASS-PRESENCE: the compressed-corner loss class
// persists (saturated lanes are jam-stable — R13), physically marked by the oversized consolidated
// stacks the import created (consolidated_lines=47; stack rows with count > 4 on turbo lines).
// The measurement basis is the SAME-INSTANT capture itself — exactly what production consumes:
// restore must reproduce the captured per-side multisets and total, whatever the live world held.
//
// Phase A discipline: the PRODUCTION functions are called as-is (no module edits); a NO-GO is a
// successful measurement. Two consecutive full green runs required for GO.
//
// Usage:
//   node tests/belt-lab/run-r14-dup-kill.mjs               # two full runs + NOTEBOOK/evidence
//   node tests/belt-lab/run-r14-dup-kill.mjs --runs=1
//   node tests/belt-lab/run-r14-dup-kill.mjs --no-notebook
//   node tests/belt-lab/run-r14-dup-kill.mjs --reset       # cleanup only (platform/storage/file)
//
// LAB HAZARDS honored: every /sc sets its globals inline per call (RCON globals persist); no
// on_tick registration; the only cross-execution state is storage.belt_r14 (explicitly created,
// consumed, and cleaned — asserted absent at preflight and after cleanup).

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const HOST = { container: "surface-export-host-2", instance: "clusterio-host-2-instance-1" };
const INSTANCE_DIR = `/clusterio/data/instances/${HOST.instance}`;
const PLATFORM = "beltr14replay";
const PAYLOAD_LOCAL = fileURLToPath(new URL("./evidence/replay_payload_DUP-233855.json", import.meta.url));
const PAYLOAD_REMOTE_NAME = "replay_payload_DUP-233855.json";
const NOTEBOOK = fileURLToPath(new URL("./NOTEBOOK.md", import.meta.url));
const EVIDENCE = fileURLToPath(new URL("./results/belt-r14-dup-kill-2.0.77.json", import.meta.url));
const EXPECTED_TOTAL = 15866;
const BELT_TYPES = ["transport-belt", "underground-belt", "splitter"];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function docker(args, timeout = 120_000) {
	return execFileSync("docker", args, {
		encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
	});
}

// Long-timeout RCON: the kill execution freezes the game for the whole restore (measured cost is
// itself a Phase-A deliverable), so this wrapper allows up to 15 minutes.
function rcon(command, timeout = 900_000) {
	return docker(["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", HOST.instance, command, "--config", CTL_CONFIG], timeout).trim();
}

function luaJson(body, timeout = 900_000) {
	const raw = rcon(`/sc local out={} local ok,err=pcall(function() ${body} end) ` +
		`if not ok then out={success=false,error=tostring(err)} end rcon.print(helpers.table_to_json(out))`, timeout);
	const last = raw.split(/\r?\n/).filter(Boolean).at(-1) || "";
	try { return JSON.parse(last); }
	catch (error) { throw new Error(`unparseable Lua JSON (${error.message}): ${last.slice(0, 500)}`); }
}

// --- payload-side data ----------------------------------------------------------------------------

const payload = JSON.parse(readFileSync(PAYLOAD_LOCAL, "utf8"));
const beltRecords = payload.entities.filter(e => BELT_TYPES.includes(e.type));
if (beltRecords.length !== 596) throw new Error(`payload belt count ${beltRecords.length}, expected 596`);
let payloadTotal = 0;
for (const rec of beltRecords) {
	const items = rec.specific_data && rec.specific_data.items;
	if (!Array.isArray(items)) continue;
	for (const line of items) for (const s of (line.items || [])) payloadTotal += s.count;
}
if (payloadTotal !== EXPECTED_TOTAL) throw new Error(`payload total ${payloadTotal} != ${EXPECTED_TOTAL}`);
// Compact defs shipped into Lua (id/name/x/y/dir + underground type) for the id-join and rebuild.
const beltDefs = beltRecords.map(r => ({
	i: r.entity_id, n: r.name, x: r.position.x, y: r.position.y, d: r.direction || 0,
	u: (r.specific_data && r.specific_data.belt_to_ground_type) || undefined,
}));
const beltDefsJson = JSON.stringify(beltDefs);

// --- Lua step bodies ------------------------------------------------------------------------------

const FIND_PLATFORM = `local plat for _,p in pairs(game.forces.player.platforms) do ` +
	`if p.valid and p.name=='${PLATFORM}' then plat=p end end `;

function surveyBody() {
	// Pause the platform (freezes machines/inserters; belts still micro-flow — R13), enumerate,
	// count sides, and measure CLASS PRESENCE: oversized stack rows (count > 4 on a turbo line = a
	// consolidated compressed slot) + which sides hold them + the endpoint entities' sides.
	return FIND_PLATFORM + `
		if not plat then out.success=false out.error='replay platform missing' return end
		plat.paused=true
		local s=plat.surface
		local belts=s.find_entities_filtered{type={'transport-belt','underground-belt','splitter'}}
		out.belt_count=#belts
		local lines={}
		for _,e in ipairs(belts) do for li=1,e.get_max_transport_line_index() do
			local key=e.position.x..','..e.position.y..','..li
			lines[#lines+1]={key=key,line=e.get_transport_line(li)}
		end end
		out.line_count=#lines
		local groups={} local calls=0
		for _,r in ipairs(lines) do
			local gi
			for j,g in ipairs(groups) do calls=calls+1 if r.line.line_equals(g.rep) then gi=j break end end
			if not gi then gi=#groups+1 groups[gi]={rep=r.line,keys={}} end
			groups[gi].keys[#groups[gi].keys+1]=r.key
		end
		out.group_calls=calls out.side_count=#groups
		local seen={} local total=0 local oversized=0 local maxstack=0
		for _,r in ipairs(lines) do
			for _,it in ipairs(r.line.get_detailed_contents()) do
				local id=tostring(it.unique_id)
				if not seen[id] then seen[id]=true
					total=total+it.stack.count
					if it.stack.count>4 then oversized=oversized+1 end
					if it.stack.count>maxstack then maxstack=it.stack.count end
				end
			end
		end
		out.total=total out.oversized_stacks=oversized out.max_stack=maxstack
		out.paused=plat.paused==true
		out.success=true`;
}

function cleanupBody() {
	return FIND_PLATFORM + `
		local deleted=false
		if plat then game.delete_surface(plat.surface) deleted=true end
		local sc=game.surfaces['belt-r14-scratch'] if sc then game.delete_surface(sc) end
		storage.belt_r14=nil
		out.deleted=deleted out.success=true`;
}

function censusZero() {
	return luaJson(`local function n(t) local c=0 for _ in pairs(t or {}) do c=c+1 end return c end
		local reps=0 for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name=='${PLATFORM}' then reps=reps+1 end end
		out.replay=reps out.scratch=game.surfaces['belt-r14-scratch']~=nil
		out.jobs=n(storage.async_jobs) out.locks=n(storage.locked_platforms) out.holds=n(storage.destination_holds)
		out.r14=storage.belt_r14~=nil out.paused=game.tick_paused==true out.success=true`, 120_000);
}

// --- driver ---------------------------------------------------------------------------------------

async function waitForImport(timeoutMs = 600_000) {
	// ATOMIC completion-pause: the upload path ACTIVATES the platform at completion (measured run
	// 1: +216 machine-fed items within seconds) — the same execution that detects jobs==0 pauses
	// the platform, bounding the live window to one poll interval.
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = luaJson(`local function n(t) local c=0 for _ in pairs(t or {}) do c=c+1 end return c end
			local plat for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name=='${PLATFORM}' then plat=p end end
			local jobs=n(storage.async_jobs)
			if plat and jobs==0 then plat.paused=true out.done=true else out.done=false end
			out.jobs=jobs out.plat=plat~=nil out.success=true`, 120_000);
		if (state.done) return;
		await sleep(1000);
	}
	throw new Error("replay import did not complete in time");
}

async function fullRun(runNo, results) {
	const run = { run: runNo, started: new Date().toISOString() };
	results.runs.push(run);

	// import
	docker(["cp", PAYLOAD_LOCAL, `${HOST.container}:${INSTANCE_DIR}/script-output/${PAYLOAD_REMOTE_NAME}`]);
	const importOut = rcon(`/plugin-import-file ${PAYLOAD_REMOTE_NAME} ${PLATFORM}`, 120_000);
	run.importCommand = importOut.split(/\r?\n/).at(-1);
	await waitForImport();
	run.beltSummary = docker(["exec", HOST.container, "sh", "-c",
		`grep -a '596 belts' ${INSTANCE_DIR}/factorio-current.log | tail -1`]).trim();

	// survey + class-presence admissibility (fixture refinement: see header — payload-per-side
	// fidelity is unattainable post-activation; the class marker is the oversized consolidated
	// stacks; the measurement basis is the same-instant capture below).
	let t0 = Date.now();
	const survey = luaJson(surveyBody());
	run.surveyMs = Date.now() - t0;
	if (!survey.success) throw new Error(`survey failed: ${survey.error}`);
	run.beltCount = survey.belt_count; run.lineCount = survey.line_count;
	run.sideCount = survey.side_count; run.groupCalls = survey.group_calls;
	run.liveTotal = survey.total; run.oversizedStacks = survey.oversized_stacks;
	run.maxStack = survey.max_stack;
	if (survey.belt_count !== 596 || survey.line_count !== 1490) {
		throw new Error(`enumeration mismatch: belts ${survey.belt_count} lines ${survey.line_count}`);
	}
	if (survey.oversized_stacks < 10) {
		throw new Error(`INADMISSIBLE: only ${survey.oversized_stacks} oversized stacks — the compressed class is not present`);
	}
	run.admissible = true;

	// capture + rebuild + restore + verdict in ONE execution via the belt_side_restore_selftest
	// dup_kill mode (RCON cannot require() the production module at runtime; the selftest remote
	// is the lab path to the REAL BeltRestoration functions — the no-tick measure_baked pattern).
	t0 = Date.now();
	const kill = luaJson("local r=remote.call('surface_export','belt_side_restore_selftest',{mode='dup_kill',platform='" + PLATFORM + "'}) for k,v in pairs(r) do out[k]=v end");
	run.killMs = Date.now() - t0;
	if (!kill.success) throw new Error(`dup_kill failed: ${kill.error}`);
	if (kill.capture_same_tick !== true) throw new Error("capture spanned ticks");
	if (kill.captured_total !== survey.total) {
		// Distinguish live drift (pause failed / belts flowed) from a capture accounting artifact:
		// bracket with a second survey. If the world agrees with itself but the capture differs,
		// the production capture double-counted stacks aliased across group boundaries — a REAL
		// production finding (would duplicate on restore), reported as its own NO-GO branch.
		const survey2 = luaJson(surveyBody());
		run.postCaptureTotal = survey2.total;
		run.postCapturePaused = survey2.paused;
		if (survey2.total === kill.scratch_census && kill.all_sides_exact) {
			// world moved between survey and capture; capture agreed with the world it saw
			run.captureDriftNote = `world drifted ${survey.total} -> ${kill.captured_total} before capture; ` +
				`post-capture survey ${survey2.total}`;
		}
		if (survey2.total === survey.total) {
			run.verdict = "RED";
			run.noGoBranch = "capture cross-group double-count (aliased windows)";
			run.capture = { pairs: kill.belt_count, groups: kill.groups, slots: kill.slots, total: kill.captured_total };
			run.kill = { placed: kill.placed, unplaced: kill.unplaced, leaks_undone: kill.leaks_undone,
				anomalies: kill.anomalies, all_sides_exact: kill.all_sides_exact, scratch_census: kill.scratch_census };
			throw new Error(`NO-GO: capture ${kill.captured_total} vs stable world ${survey.total} — ` +
				`production capture double-counts aliased stacks on this topology`);
		}
	}
	run.capture = { pairs: kill.belt_count, groups: kill.groups, slots: kill.slots, total: kill.captured_total };
	run.kill = {
		created: 596 - (kill.create_fails || 0), placed: kill.placed, unplaced: kill.unplaced,
		leaks_undone: kill.leaks_undone, anomalies: kill.anomalies,
		all_sides_exact: kill.all_sides_exact, scratch_census: kill.scratch_census,
		source_census: null,
		inexact_sides: kill.inexact_sides || [],
	};
	const basis = kill.captured_total;
	const go = kill.unplaced === 0 && kill.anomalies === 0 && kill.all_sides_exact === true
		&& kill.scratch_census === basis && kill.placed === basis;
	run.verdict = go ? "GREEN" : "RED";
	if (!go) {
		run.noGoBranch = kill.unplaced > 0 ? "over-capacity/unplaced"
			: kill.anomalies > 0 ? "anomalies"
				: !kill.all_sides_exact ? "side inexact" : "census mismatch";
	}

	// per-run cleanup
	const clean = luaJson(cleanupBody(), 120_000);
	if (!clean.success) throw new Error(`cleanup failed: ${clean.error}`);
	docker(["exec", HOST.container, "sh", "-c", `rm -f '${INSTANCE_DIR}/script-output/${PAYLOAD_REMOTE_NAME}'`]);
	const zero = censusZero();
	run.cleanState = zero;
	if (zero.replay !== 0 || zero.scratch || zero.r14 || zero.jobs !== 0 || zero.paused) {
		throw new Error(`cleanup not clean: ${JSON.stringify(zero)}`);
	}
	run.finished = new Date().toISOString();
	return run.verdict === "GREEN";
}

async function main() {
	let runsWanted = 2, noNotebook = false, resetOnly = false;
	for (const arg of process.argv.slice(2)) {
		if (arg === "--no-notebook") noNotebook = true;
		else if (arg === "--reset") resetOnly = true;
		else if (arg.startsWith("--runs=")) runsWanted = Number(arg.slice(7));
		else throw new Error(`unknown arg ${arg}`);
	}
	if (resetOnly) {
		const clean = luaJson(cleanupBody(), 120_000);
		docker(["exec", HOST.container, "sh", "-c", `rm -f '${INSTANCE_DIR}/script-output/${PAYLOAD_REMOTE_NAME}'`]);
		console.log(JSON.stringify({ reset: clean, census: censusZero() }, null, 2));
		return;
	}
	const results = { script: "tests/belt-lab/run-r14-dup-kill.mjs", started: new Date().toISOString(), runs: [], errors: [] };
	try {
		const pre = censusZero();
		if (pre.replay !== 0 || pre.scratch || pre.r14 || pre.jobs !== 0 || pre.paused) {
			throw new Error(`preflight refused: ${JSON.stringify(pre)}`);
		}
		for (let i = 1; i <= runsWanted; i += 1) {
			const green = await fullRun(i, results);
			if (!green) break;
		}
	} catch (error) {
		results.errors.push(error.stack || error.message);
		try {
			luaJson(cleanupBody(), 120_000);
			docker(["exec", HOST.container, "sh", "-c", `rm -f '${INSTANCE_DIR}/script-output/${PAYLOAD_REMOTE_NAME}'`]);
			results.errorCleanup = censusZero();
		} catch (cleanupError) {
			results.errors.push(`CLEANUP FAILED: ${cleanupError.message}`);
		}
	}
	results.finished = new Date().toISOString();
	const greens = results.runs.filter(r => r.verdict === "GREEN").length;
	results.verdict = results.errors.length === 0 && greens === runsWanted && runsWanted >= 2 ? "GO"
		: results.errors.length === 0 && results.runs.some(r => r.verdict === "RED") ? "NO-GO" : "INCOMPLETE";
	writeFileSync(EVIDENCE, JSON.stringify(results, null, 2));
	if (!noNotebook) appendFileSync(NOTEBOOK, renderNotebook(results));
	console.log(JSON.stringify(results, null, 2));
	if (results.verdict !== "GO") process.exitCode = 1;
}

function renderNotebook(results) {
	const rows = [];
	rows.push(`\n## BELT-R14 [empirical, 2.0.77] - DUP-233855 kill-measurement for the production side-scoped restore (${results.verdict})`);
	rows.push(`\nRunner \`${results.script}\` (evidence \`results/belt-r14-dup-kill-2.0.77.json\`). Fixture: replay-import of the banked payload on host-2 (upload path). FIXTURE REFINEMENT (measured run 1, 2026-07-19): the upload path ACTIVATES the platform at completion and machines fed the belts (16,082 read vs 15,861 placed within seconds), and items legally cross sides at line handoffs — payload-per-side fidelity is unattainable on a replayed live world, so the owner-approved surgery is moot. Admissibility is CLASS-PRESENCE (the compressed class persists jam-stable, marked by the import's oversized consolidated stacks), completion-pause is atomic with detection, and the measurement basis is the SAME-INSTANT production capture — exactly what production would consume. PRODUCTION capture_side_groups/restore_side_groups called as-is; no module code touched.`);
	for (const run of results.runs) {
		rows.push(`\n**Run ${run.run} (${run.verdict})** - belts ${run.beltCount}, lines ${run.lineCount}, sides ${run.sideCount} ` +
			`(${run.groupCalls} line_equals calls, survey ${run.surveyMs} ms); live total ${run.liveTotal}, ` +
			`class presence ${run.oversizedStacks} oversized stacks (max ${run.maxStack}); ` +
			`capture ${run.capture?.groups} groups / ${run.capture?.slots} slots / ${run.capture?.total} items in ${run.captureMs} ms (same-tick); ` +
			`restore placed ${run.kill?.placed}, unplaced ${run.kill?.unplaced}, leaks_undone ${run.kill?.leaks_undone}, ` +
			`anomalies ${run.kill?.anomalies}, all sides exact=${run.kill?.all_sides_exact}, scratch census ${run.kill?.scratch_census} vs basis ${run.capture?.total}, ` +
			`source census ${run.kill?.source_census} (informational), kill step ${run.killMs} ms${run.noGoBranch ? `, NO-GO branch: ${run.noGoBranch}` : ""}. ` +
			`Cleanup: ${JSON.stringify(run.cleanState)}.`);
	}
	if (results.errors.length) rows.push(`\n**Errors:**\n${results.errors.map(e => `- ${e}`).join("\n")}`);
	rows.push("");
	return rows.join("\n");
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
