#!/usr/bin/env node
// BELT-R15 — the INCREMENTAL-restore rung gating Phase 5's Phase B design (owner: Option D,
// multi-tick batched restore, no single-execution freeze).
//
// Falsifiable claim under test: batched side-scoped restore of the DUP-233855 loss class —
// N sides per execution across REAL elapsed ticks — stays exact by the contract's verdicts:
//   (a) zero unplaced/overflow and zero anomalies across all batches;
//   (b) whole-scratch distinct-uid census == the same-instant captured basis at finish;
//   (c) every side's both-direction multiset EXACT at ITS completion instant (same execution as
//       its final placement) — post-completion drift is legitimate physics, observed separately.
// The measured risk: items crossing SIDE boundaries (splitters cannot be deactivated — belt-class
// active writes engine-rejected, BELT-R13) DURING the batched window, seating immigrants in slots
// a later batch's first-fit needs.
//
// Fixture: identical to BELT-R14 (replay-import of the banked payload, class-presence
// admissibility, same-instant capture basis). Production functions called as-is via the
// belt_side_restore_selftest dup_kill_batched mode (additive lab instrumentation; the slice-per-
// call narrows restore_side_groups' snapshot bracket to the batch — exactly what a batched
// production adoption would do, so the cost profile measured here is the adoption's).
//
// Each full run sweeps TWO batch sizes against the same replayed fixture (fresh capture + fresh
// scratch per sweep): batch=32 (~14 executions) and batch=1 (432 executions — maximal elapsed
// ticks, strongest crossing exposure). GO requires BOTH sweeps green in TWO consecutive runs.
//
// Usage:
//   node tests/belt-lab/run-r15-incremental-restore.mjs               # two full runs + NOTEBOOK
//   node tests/belt-lab/run-r15-incremental-restore.mjs --runs=1
//   node tests/belt-lab/run-r15-incremental-restore.mjs --no-notebook
//   node tests/belt-lab/run-r15-incremental-restore.mjs --reset       # cleanup only
//
// LAB HAZARDS honored: every /sc sets its globals inline; no on_tick registration; cross-execution
// state is MODULE-LOCAL in the selftest (holds LuaEntity refs — never storage), created by
// op=start, consumed by op=finish, killed by op=abort (invoked on every error path and --reset).

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const HOST = { container: "surface-export-host-2", instance: "clusterio-host-2-instance-1" };
const INSTANCE_DIR = `/clusterio/data/instances/${HOST.instance}`;
const PLATFORM = "beltr15replay";
const PAYLOAD_LOCAL = fileURLToPath(new URL("./evidence/replay_payload_DUP-233855.json", import.meta.url));
const PAYLOAD_REMOTE_NAME = "replay_payload_DUP-233855.json";
const NOTEBOOK = fileURLToPath(new URL("./NOTEBOOK.md", import.meta.url));
const EVIDENCE = fileURLToPath(new URL("./results/belt-r15-incremental-2.0.77.json", import.meta.url));
let BATCH_SIZES = [32, 1];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function docker(args, timeout = 120_000) {
	return execFileSync("docker", args, {
		encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
	});
}

function rcon(command, timeout = 300_000) {
	return docker(["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", HOST.instance, command, "--config", CTL_CONFIG], timeout).trim();
}

function luaJson(body, timeout = 300_000) {
	const raw = rcon(`/sc local out={} local ok,err=pcall(function() ${body} end) ` +
		`if not ok then out={success=false,error=tostring(err)} end rcon.print(helpers.table_to_json(out))`, timeout);
	const last = raw.split(/\r?\n/).filter(Boolean).at(-1) || "";
	try { return JSON.parse(last); }
	catch (error) { throw new Error(`unparseable Lua JSON (${error.message}): ${last.slice(0, 500)}`); }
}

function batchedCall(opTable, timeout = 300_000) {
	return luaJson(`local r=remote.call('surface_export','belt_side_restore_selftest',${opTable}) ` +
		`for k,v in pairs(r) do out[k]=v end`, timeout);
}

// --- payload sanity (same basis as R14) -----------------------------------------------------------

const payload = JSON.parse(readFileSync(PAYLOAD_LOCAL, "utf8"));
const beltCount = payload.entities.filter(e => ["transport-belt", "underground-belt", "splitter"].includes(e.type)).length;
if (beltCount !== 596) throw new Error(`payload belt count ${beltCount}, expected 596`);

// --- Lua step bodies (R14 conventions) ------------------------------------------------------------

const FIND_PLATFORM = `local plat for _,p in pairs(game.forces.player.platforms) do ` +
	`if p.valid and p.name=='${PLATFORM}' then plat=p end end `;

function surveyBody() {
	return FIND_PLATFORM + `
		if not plat then out.success=false out.error='replay platform missing' return end
		plat.paused=true
		local s=plat.surface
		local belts=s.find_entities_filtered{type={'transport-belt','underground-belt','splitter'}}
		out.belt_count=#belts
		local oversized,maxstack,total=0,0,0
		local seen={}
		for _,e in ipairs(belts) do for li=1,e.get_max_transport_line_index() do
			for _,it in ipairs(e.get_transport_line(li).get_detailed_contents()) do
				local id=tostring(it.unique_id)
				if not seen[id] then seen[id]=true
					total=total+it.stack.count
					if it.stack.count>4 then oversized=oversized+1 end
					if it.stack.count>maxstack then maxstack=it.stack.count end
				end
			end
		end end
		out.total=total out.oversized_stacks=oversized out.max_stack=maxstack
		out.paused=plat.paused==true out.success=true`;
}

function cleanupBody() {
	return FIND_PLATFORM + `
		local deleted=false
		if plat then game.delete_surface(plat.surface) deleted=true end
		local sc=game.surfaces['belt-r15-scratch'] if sc then game.delete_surface(sc) end
		out.deleted=deleted out.success=true`;
}

function censusZero() {
	return luaJson(`local function n(t) local c=0 for _ in pairs(t or {}) do c=c+1 end return c end
		local reps=0 for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name=='${PLATFORM}' then reps=reps+1 end end
		out.replay=reps out.scratch=game.surfaces['belt-r15-scratch']~=nil
		out.jobs=n(storage.async_jobs) out.locks=n(storage.locked_platforms) out.holds=n(storage.destination_holds)
		out.paused=game.tick_paused==true out.success=true`, 120_000);
}

function abortBatched() {
	try { batchedCall(`{mode='dup_kill_batched',op='abort'}`, 60_000); } catch { /* best-effort on error paths */ }
}

// --- driver ---------------------------------------------------------------------------------------

async function waitForImport(timeoutMs = 600_000) {
	// Atomic completion-pause (R14): the same execution that sees jobs==0 pauses the platform.
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

async function sweep(batchSize, run) {
	const sw = { batchSize, steps: [], started: new Date().toISOString() };
	let t0 = Date.now();
	const start = batchedCall(`{mode='dup_kill_batched',op='start',platform='${PLATFORM}'}`);
	sw.startMs = Date.now() - t0;
	if (!start.success) throw new Error(`batched start failed: ${start.error}`);
	if (start.capture_same_tick !== true) throw new Error("capture spanned ticks");
	sw.groups = start.groups; sw.slots = start.slots; sw.capturedTotal = start.captured_total;
	sw.startTick = start.tick;

	let done = false;
	const stepTimes = [];
	while (!done) {
		t0 = Date.now();
		const step = batchedCall(`{mode='dup_kill_batched',op='step',batch=${batchSize}}`);
		const ms = Date.now() - t0;
		stepTimes.push(ms);
		if (!step.success) throw new Error(`batched step failed at cursor: ${step.error}`);
		sw.steps.push({ from: step.from, to: step.to, tick: step.tick, ms,
			placed: step.placed, unplaced: step.unplaced, leaks: step.leaks_undone,
			anomalies: step.anomalies, exact: step.batch_exact, inexact: step.batch_inexact });
		done = step.done === true;
	}
	t0 = Date.now();
	const fin = batchedCall(`{mode='dup_kill_batched',op='finish'}`);
	sw.finishMs = Date.now() - t0;
	if (!fin.success) throw new Error(`batched finish failed: ${fin.error}`);
	sw.finish = fin;

	stepTimes.sort((a, b) => a - b);
	sw.stepMsMedian = stepTimes[Math.floor(stepTimes.length / 2)];
	sw.stepMsMax = stepTimes[stepTimes.length - 1];
	sw.executions = sw.steps.length;
	sw.elapsedTicks = fin.elapsed_ticks;

	// Verdicts.
	sw.verdicts = {
		a_zero_unplaced_anomalies: fin.unplaced === 0 && fin.anomalies === 0,
		b_census_equals_basis: fin.scratch_census === sw.capturedTotal && fin.placed === sw.capturedTotal,
		c_all_sides_exact_at_completion: fin.sides_exact_at_completion === fin.sides,
		multi_tick_proven: fin.elapsed_ticks > 0,
	};
	sw.green = Object.values(sw.verdicts).every(Boolean);
	sw.crossings = { drifted_after_completion: fin.drifted_after_completion, drift_abs: fin.drift_abs,
		leaks_undone: fin.leaks_undone };
	if (!sw.green) {
		sw.noGoBranch = !sw.verdicts.a_zero_unplaced_anomalies ? "unplaced/anomalies (crossing occupancy)"
			: !sw.verdicts.c_all_sides_exact_at_completion ? "side inexact at completion"
				: !sw.verdicts.b_census_equals_basis ? "census mismatch" : "no ticks elapsed (harness fault)";
	}
	run.sweeps.push(sw);
	return sw.green;
}

async function fullRun(runNo, results) {
	const run = { run: runNo, started: new Date().toISOString(), sweeps: [] };
	results.runs.push(run);

	docker(["cp", PAYLOAD_LOCAL, `${HOST.container}:${INSTANCE_DIR}/script-output/${PAYLOAD_REMOTE_NAME}`]);
	const importOut = rcon(`/plugin-import-file ${PAYLOAD_REMOTE_NAME} ${PLATFORM}`, 120_000);
	run.importCommand = importOut.split(/\r?\n/).at(-1);
	await waitForImport();

	const survey = luaJson(surveyBody());
	if (!survey.success) throw new Error(`survey failed: ${survey.error}`);
	run.beltCount = survey.belt_count; run.liveTotal = survey.total;
	run.oversizedStacks = survey.oversized_stacks; run.maxStack = survey.max_stack;
	if (survey.belt_count !== 596) throw new Error(`enumeration mismatch: belts ${survey.belt_count}`);
	if (survey.oversized_stacks < 10) {
		throw new Error(`INADMISSIBLE: only ${survey.oversized_stacks} oversized stacks`);
	}
	run.admissible = true;

	let allGreen = true;
	for (const batchSize of BATCH_SIZES) {
		const green = await sweep(batchSize, run);
		if (!green) { allGreen = false; break; }
	}
	run.verdict = allGreen ? "GREEN" : "RED";

	const clean = luaJson(cleanupBody(), 120_000);
	if (!clean.success) throw new Error(`cleanup failed: ${clean.error}`);
	docker(["exec", HOST.container, "sh", "-c", `rm -f '${INSTANCE_DIR}/script-output/${PAYLOAD_REMOTE_NAME}'`]);
	const zero = censusZero();
	run.cleanState = zero;
	if (zero.replay !== 0 || zero.scratch || zero.jobs !== 0 || zero.paused) {
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
		// Diagnostic override, e.g. --batches=432 = ONE full-bracket step on AGED targets (entities
		// created in the start execution, restored later) — discriminates the aged-target leak class
		// from the narrowed-bracket artifact.
		else if (arg.startsWith("--batches=")) BATCH_SIZES = arg.slice(10).split(",").map(Number);
		else throw new Error(`unknown arg ${arg}`);
	}
	if (resetOnly) {
		abortBatched();
		const clean = luaJson(cleanupBody(), 120_000);
		docker(["exec", HOST.container, "sh", "-c", `rm -f '${INSTANCE_DIR}/script-output/${PAYLOAD_REMOTE_NAME}'`]);
		console.log(JSON.stringify({ reset: clean, census: censusZero() }, null, 2));
		return;
	}
	const results = { script: "tests/belt-lab/run-r15-incremental-restore.mjs", started: new Date().toISOString(), runs: [], errors: [] };
	try {
		const pre = censusZero();
		if (pre.replay !== 0 || pre.scratch || pre.jobs !== 0 || pre.paused) {
			throw new Error(`preflight refused: ${JSON.stringify(pre)}`);
		}
		for (let i = 1; i <= runsWanted; i += 1) {
			const green = await fullRun(i, results);
			if (!green) break;
		}
	} catch (error) {
		results.errors.push(error.stack || error.message);
		try {
			abortBatched();
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
	rows.push(`\n## BELT-R15 [empirical, 2.0.77] - INCREMENTAL (multi-tick batched) side-scoped restore on the DUP-233855 class (${results.verdict})`);
	rows.push(`\nRunner \`${results.script}\` (evidence \`results/belt-r15-incremental-2.0.77.json\`). Same fixture and production functions as BELT-R14; the restore is split into N-side batches across REAL elapsed ticks via the dup_kill_batched selftest mode (module-local cross-execution state; slice-per-call narrows the snapshot bracket to the batch — the batched-adoption semantics). Verdicts: (a) zero unplaced/anomalies; (b) whole-scratch census == same-instant captured basis; (c) per-side both-direction multisets exact AT COMPLETION INSTANT (post-completion drift is physics, observed separately as the direct crossing observation). Sweep per run: batch=32 then batch=1 (fresh capture + scratch each; 432 executions in the batch=1 sweep = maximal crossing exposure).`);
	for (const run of results.runs) {
		rows.push(`\n**Run ${run.run} (${run.verdict})** - belts ${run.beltCount}, live total ${run.liveTotal}, class presence ${run.oversizedStacks} oversized (max ${run.maxStack}).`);
		for (const sw of run.sweeps) {
			rows.push(`- batch=${sw.batchSize}: ${sw.executions} executions over ${sw.elapsedTicks} ticks; basis ${sw.capturedTotal} ` +
				`(${sw.groups} sides / ${sw.slots} slots, start ${sw.startMs} ms); placed ${sw.finish?.placed}, unplaced ${sw.finish?.unplaced}, ` +
				`leaks_undone ${sw.finish?.leaks_undone}, anomalies ${sw.finish?.anomalies}; sides exact at completion ` +
				`${sw.finish?.sides_exact_at_completion}/${sw.finish?.sides}; final census ${sw.finish?.scratch_census}; ` +
				`step ms median ${sw.stepMsMedian} / max ${sw.stepMsMax}, finish ${sw.finishMs} ms; ` +
				`post-completion drift: ${sw.crossings?.drifted_after_completion} side(s), |delta| ${sw.crossings?.drift_abs}` +
				`${sw.noGoBranch ? `; NO-GO branch: ${sw.noGoBranch}` : ""}.`);
		}
		rows.push(`- Cleanup: ${JSON.stringify(run.cleanState)}.`);
	}
	if (results.errors.length) rows.push(`\n**Errors:**\n${results.errors.map(e => `- ${e}`).join("\n")}`);
	rows.push("");
	return rows.join("\n");
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
