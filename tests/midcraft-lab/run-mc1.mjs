#!/usr/bin/env node
// tests/midcraft-lab/run-mc1.mjs — MC1: what happens to a MID-CRAFT machine across the export/import pipeline?
//
// STATUS: AUTHORED 2026-07-11, NEVER EXECUTED — UNVALIDATED. The authoring agent had no cluster access;
// a closer agent runs this against the live cluster and appends the measured run to NOTEBOOK.md.
//
// The physics question (see NOTEBOOK.md): Factorio consumes ingredients at craft START, so a machine
// mid-craft holds value in NO inventory — only in `crafting_progress`. The serializer exports
// crafting_progress (export_scanners/entity-handlers.lua:82,136) and the deserializer writes it back via
// SIMPLE_RESTORE_RULES (core/deserializer.lua:76). Whether that write TAKES on a freshly created,
// deactivated machine that never consumed ingredients — and whether the engine then completes the craft
// producing outputs exactly once — has never been measured. Three candidate realities (PASS/FAIL table):
//   RESUME-CLEAN : embodied delta == 0   (the in-flight craft completes exactly once; inputs consumed once)
//   RESET-LOSS   : embodied delta == -2  (progress dropped; the 2 already-consumed plates' value vanished)
//   PHANTOM-GAIN : embodied delta  > 0   (outputs appear AND inputs not consumed -> item creation)
// "Embodied" = input plates + 2*output gears + 2*(a craft is in flight). iron-gear-wheel: 2 plates -> 1 gear.
//
// MEASUREMENT ONLY. This rung makes NO code change regardless of outcome — the adjudicated fix
// (refund-not-resume) is the closer's to implement if RESET-LOSS or PHANTOM-GAIN is measured.
//
// Instrument: same-instance remote.call('surface_export','clone_platform',...) — runs the FULL
// export+import pipeline without cross-instance transmission — plus the registered, non-destructive
// test_defer_clone_activation debug flag (interfaces/remote/configure.lua), which leaves the clone
// DEACTIVATED so the frozen destination can be censused with zero crafting confound.
//
// Usage (cluster must be up):
//   node tests/midcraft-lab/run-mc1.mjs                # run MC1
//   node tests/midcraft-lab/run-mc1.mjs --reset        # cleanup only
//   node tests/midcraft-lab/run-mc1.mjs --sections mc1 # explicit section selection (only mc1 exists)

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const controller = "surface-export-controller";
const config = "/clusterio/tokens/config-control.json";
const instance = "clusterio-host-1-instance-1"; // clone_platform is same-instance: one instrument, one instance
const prefix = "midcraft-lab-";
const notebook = "tests/midcraft-lab/NOTEBOOK.md";
let sections = ["mc1"];
let resetOnly = false;
let noNotebook = false;

for (let i = 2; i < process.argv.length; i += 1) {
	const arg = process.argv[i];
	if (arg === "--reset") resetOnly = true;
	else if (arg === "--no-notebook") noNotebook = true;
	else if (arg === "--sections") sections = parseSections(process.argv[++i] || "");
	else if (arg.startsWith("--sections=")) sections = parseSections(arg.slice(11));
	else throw new Error(`Unknown argument: ${arg}`);
}

function parseSections(value) {
	const parsed = value.split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
	if (!parsed.length || parsed.some(v => v !== "mc1")) throw new Error("MC1 runner supports only --sections mc1");
	return parsed;
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function lastLine(value) { return String(value).split(/\r?\n/).map(v => v.trim()).filter(Boolean).at(-1) || ""; }
function rcon(command) {
	return execFileSync("docker", ["exec", controller, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", instance, command, "--config", config],
	{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function lua(body) {
	const wrapped = `local ok,result=pcall(function() ${body} end); if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	return JSON.parse(lastLine(rcon(`/sc ${wrapped}`)));
}

// Tick-stamped machine reading on a platform found BY NAME (names here are unique per-run timestamps).
// Every reading carries all meters + paused flags (lab discipline).
function readMachine(name) {
	return lua(`
		local p; for _,x in pairs(game.forces.player.platforms) do if x.valid and x.name=='${name}' then p=x; break end end
		if not p then return {success=false,error='platform missing: ${name}',tick=game.tick} end
		local m=p.surface.find_entities_filtered({name='assembling-machine-1'})[1]
		if not (m and m.valid) then return {success=false,error='machine missing on ${name}',tick=game.tick} end
		return {success=true,tick=game.tick,game_paused=game.tick_paused==true,platform_paused=p.paused,
			active=m.active,status=m.status,
			no_power=(m.status==defines.entity_status.no_power),low_power=(m.status==defines.entity_status.low_power),
			crafting_progress=m.crafting_progress,
			input_plates=m.get_item_count('iron-plate'),output_gears=m.get_item_count('iron-gear-wheel')}
	`);
}

// Embodied value in iron-plate equivalents: physical plates + 2 per gear + 2 for a craft in flight
// (ingredients are consumed at craft START, so an in-flight craft embodies exactly one recipe's inputs).
function embodied(r) {
	const inFlight = r.crafting_progress > 0.001 && r.crafting_progress < 0.999 ? 2 : 0;
	return r.input_plates + 2 * r.output_gears + inFlight;
}

// ---------------------------------------------------------------------------------------------------------
// Fixture: one assembling-machine-1 (recipe iron-gear-wheel), script-fed EXACTLY 4 iron plates, powered by
// an electric-energy-interface. Created INACTIVE so no craft starts before we open the shutter.
// Controls first: the setup read-asserts the recipe write took and exactly 4 plates were inserted
// (inherited LAB HAZARD: recipe-enable + write-assert — never assume a write took).
// ---------------------------------------------------------------------------------------------------------
function setupFixture(name) {
	return lua(`
		local force=game.forces.player
		local p=force.create_space_platform({name='${name}',planet='nauvis',starter_pack='space-platform-starter-pack'})
		p.apply_starter_pack(); p.paused=false; force.set_surface_hidden(p.surface,false)
		p.schedule={current=1,records={{station='nauvis'}}}
		local ox,oy=100+p.index*50,100
		local tiles={}; for x=-8,8 do for y=-8,8 do tiles[#tiles+1]={name='space-platform-foundation',position={ox+x,oy+y}} end end
		p.surface.set_tiles(tiles,true,false,true,false)
		local m=p.surface.create_entity({name='assembling-machine-1',position={ox,oy},force=force})
		m.active=false
		pcall(function() m.set_recipe('iron-gear-wheel') end)
		local got=(m.get_recipe and m.get_recipe()) and m.get_recipe().name or 'nil'
		local eei=p.surface.create_entity({name='electric-energy-interface',position={ox+5,oy},force=force})
		pcall(function() eei.energy=eei.electric_buffer_size end)
		p.surface.create_entity({name='medium-electric-pole',position={ox+3,oy},force=force})
		-- INSTRUMENT GUARD (audit fix): the embodied-plate classifier assumes EXACTLY 1 gear per craft.
		-- Any effective productivity (machine bonus or 2.0 force recipe productivity) breaks that math and
		-- could misclassify an ordinary productivity payout as PHANTOM-GAIN. Measure both; require zero.
		local mach_prod = m.productivity_bonus or 0
		local recipe_prod = 0
		pcall(function() recipe_prod = force.recipes['iron-gear-wheel'].productivity_bonus or 0 end)
		local ins=m.insert({name='iron-plate',count=4})
		storage.midcraft_lab={mc1={surface=p.surface.index,platform=p.index,name='${name}',unit=m.unit_number}}
		game.tick_paused=false
		return {success=(got=='iron-gear-wheel' and ins==4 and mach_prod==0 and recipe_prod==0),recipe=got,inserted=ins,index=p.index,machine_productivity=mach_prod,recipe_productivity=recipe_prod,
			surface=p.surface.index,tick=game.tick,machine_active=m.active}
	`);
}

// Shutter drive: activate -> let real ticks elapse -> deactivate+read in one execution. AM1 crafts
// iron-gear-wheel in ~60 ticks (speed 0.5, energy 0.5s). On this cluster a 220ms RCON sleep advanced
// 117 ticks, skipping the full craft. A 30ms slice keeps the shutter comfortably below one craft. Read the ACHIEVED progress — never assume 0.5.
function driveToMidCraft(name) {
	const findM = `local p; for _,x in pairs(game.forces.player.platforms) do if x.valid and x.name=='${name}' then p=x; break end end local m=p.surface.find_entities_filtered({name='assembling-machine-1'})[1]`;
	const slices = [];
	let frozen = null;
	for (let i = 0; i < 24 && !frozen; i += 1) {
		lua(`${findM}; m.active=true; return {success=true,tick=game.tick}`);
		sleep(30);
		const r = lua(`${findM}; m.active=false
			return {success=true,tick=game.tick,game_paused=game.tick_paused==true,platform_paused=p.paused,
				active=m.active,status=m.status,
				no_power=(m.status==defines.entity_status.no_power),low_power=(m.status==defines.entity_status.low_power),
				crafting_progress=m.crafting_progress,
				input_plates=m.get_item_count('iron-plate'),output_gears=m.get_item_count('iron-gear-wheel')}`);
		slices.push(r);
		if (!r.success) throw new Error(`MC1 shutter read failed: ${JSON.stringify(r)}`);
		if (r.no_power || r.low_power) throw new Error(`MC1 instrument failure: machine unpowered during drive: ${JSON.stringify(r)}`);
		if (r.crafting_progress > 0.05 && r.crafting_progress < 0.95) frozen = r;
		else if (r.input_plates === 0 && r.output_gears >= 2 && !(r.crafting_progress > 0)) {
			throw new Error(`MC1 instrument failure: fixture exhausted (both crafts completed) before a mid-craft freeze landed — shorten the slice: ${JSON.stringify(slices)}`);
		}
	}
	if (!frozen) throw new Error(`MC1 instrument failure: no mid-craft freeze in ${slices.length} slices: ${JSON.stringify(slices)}`);
	return { slices: slices.length, frozen };
}

function captureConfig() {
	return lua(`
		local c=storage.surface_export_config or {}
		return {success=true,debug_mode=c.debug_mode==true,had_debug=c.debug_mode~=nil,defer=c.test_defer_clone_activation==true}
	`);
}
function armDefer() {
	// Registered non-destructive flag: leaves the CLONE deactivated for a pristine frozen census.
	// Disarmed in cleanupAll on EVERY exit path.
	return lua(`remote.call('surface_export','configure',{debug_mode=true,test_defer_clone_activation=true}); return {success=true,tick=game.tick}`);
}

function waitJobGone(jobId, timeoutMs = 180000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		// JSON numeric-key coercion: async_jobs may be keyed numeric or string — check both forms.
		const r = lua(`
			local j=storage.async_jobs or {}
			local id='${jobId}'
			return {success=true,tick=game.tick,done=(j[id]==nil and j[tonumber(id) or -1]==nil)}
		`);
		if (r.done) return r;
		sleep(1500);
	}
	throw new Error(`MC1: clone import job ${jobId} did not complete within ${timeoutMs}ms`);
}

function activateClone(name) {
	return lua(`
		local p; for _,x in pairs(game.forces.player.platforms) do if x.valid and x.name=='${name}' then p=x; break end end
		if not p then return {success=false,error='clone missing: ${name}',tick=game.tick} end
		for _,e in pairs(p.surface.find_entities_filtered({})) do pcall(function() e.active=true end) end
		local eei=p.surface.find_entities_filtered({name='electric-energy-interface'})[1]
		if eei then pcall(function() eei.energy=eei.electric_buffer_size end) end
		p.paused=false
		return {success=true,tick=game.tick}
	`);
}

// Post-activation settle: poll (deadline loop, never a fixed sleep) until >=120 ticks elapsed since
// activation AND two consecutive identical readings — the craft chain has run to completion.
function settleRead(name, activationTick, minTicks = 120, timeoutMs = 60000) {
	const deadline = Date.now() + timeoutMs;
	let prev = null;
	let polls = 0;
	while (Date.now() < deadline) {
		sleep(1000);
		const r = readMachine(name);
		polls += 1;
		if (!r.success) throw new Error(`MC1 settle read failed: ${JSON.stringify(r)}`);
		const elapsed = r.tick - activationTick;
		if (elapsed >= minTicks && prev
			&& prev.input_plates === r.input_plates && prev.output_gears === r.output_gears
			&& Math.abs(prev.crafting_progress - r.crafting_progress) < 0.001) {
			return { polls, elapsed_ticks: elapsed, read: r };
		}
		prev = r;
	}
	throw new Error(`MC1: destination never settled within ${timeoutMs}ms after activation (last: ${JSON.stringify(prev)})`);
}

function runMC1() {
	const stamp = Date.now();
	const srcName = `${prefix}src-${stamp}`;
	const dstName = `${prefix}dst-${stamp}`;

	const setup = setupFixture(srcName);
	if (!setup.success) throw new Error(`MC1 fixture failed (recipe/insert write-assert): ${JSON.stringify(setup)}`);

	const drive = driveToMidCraft(srcName);
	// Full tick-stamped source frozen reading (machine deactivated; same trio + paused flags).
	const sourceFrozen = readMachine(srcName);
	if (!sourceFrozen.success || sourceFrozen.active !== false) {
		throw new Error(`MC1 source frozen read invalid (machine must be deactivated): ${JSON.stringify(sourceFrozen)}`);
	}

	const armed = armDefer();
	const clone = lua(`local r=remote.call('surface_export','clone_platform',${setup.index},'${dstName}'); return r`);
	if (!clone.success) throw new Error(`MC1 clone failed: ${JSON.stringify(clone)}`);
	const jobWait = waitJobGone(clone.job_id);
	sleep(1000);

	// Destination FROZEN reading: did the crafting_progress write TAKE on a freshly created,
	// deactivated machine that never consumed ingredients?
	const destFrozen = readMachine(dstName);
	if (!destFrozen.success) throw new Error(`MC1 dest frozen read failed: ${JSON.stringify(destFrozen)}`);
	if (destFrozen.active !== false) {
		throw new Error(`MC1 instrument failure: test_defer_clone_activation did NOT hold — dest machine is active, frozen census is contaminated: ${JSON.stringify(destFrozen)}`);
	}
	const progressWriteTook = Math.abs(destFrozen.crafting_progress - sourceFrozen.crafting_progress) < 0.01;

	// Activate and let the engine run past the craft horizon (+>=120 ticks).
	const activation = activateClone(dstName);
	if (!activation.success) throw new Error(`MC1 activation failed: ${JSON.stringify(activation)}`);
	const settled = settleRead(dstName, activation.tick);
	const destFinal = settled.read;
	if (destFinal.no_power || destFinal.low_power) {
		throw new Error(`MC1 instrument failure: destination machine unpowered post-activation — outputs absent for the WRONG reason: ${JSON.stringify(destFinal)}`);
	}
	// The machine must have RUN at all — an inert machine is instrument failure, not RESET-LOSS.
	const machineRan = destFinal.output_gears > destFrozen.output_gears || destFinal.input_plates < destFrozen.input_plates;
	if (!machineRan) {
		throw new Error(`MC1 instrument failure: destination machine never crafted anything after activation: frozen=${JSON.stringify(destFrozen)} final=${JSON.stringify(destFinal)}`);
	}

	// Classification — derived from measured readings, never hardcoded totals.
	const srcEmbodied = embodied(sourceFrozen);
	const finEmbodied = embodied(destFinal);
	const delta = finEmbodied - srcEmbodied;
	// Gears beyond what the dest's PHYSICAL inputs could make = the in-flight craft completing (or a phantom).
	const inFlightGear = destFinal.output_gears - destFrozen.output_gears - Math.floor(destFrozen.input_plates / 2);
	let reality = "UNCLASSIFIED";
	if (delta === 0) reality = "RESUME-CLEAN";
	else if (delta === -2) reality = "RESET-LOSS";
	else if (delta > 0) reality = "PHANTOM-GAIN";

	const table = {
		"RESUME-CLEAN": { criteria: "embodied delta == 0: outputs +1 exactly from the in-flight craft, physical inputs consumed once", measured: reality === "RESUME-CLEAN" },
		"RESET-LOSS": { criteria: "embodied delta == -2: progress dropped, the 2 already-consumed plates' value vanished, the in-flight output never appears", measured: reality === "RESET-LOSS" },
		"PHANTOM-GAIN": { criteria: "embodied delta > 0: outputs appear AND inputs not consumed -> item creation", measured: reality === "PHANTOM-GAIN" },
	};

	return {
		success: reality !== "UNCLASSIFIED",
		measured_reality: reality,
		pass_fail_table: table,
		embodied: { source_frozen: srcEmbodied, dest_final: finEmbodied, delta },
		progress_write_took_on_frozen_dest: progressWriteTook,
		in_flight_gear_completed: inFlightGear,
		setup, drive_slices: drive.slices, source_frozen: sourceFrozen,
		defer_armed: armed, clone, job_wait: jobWait,
		dest_frozen: destFrozen, activation, settled,
		note: "MEASUREMENT ONLY — no code change either way; refund-not-resume is the closer's adjudicated fix if RESET-LOSS or PHANTOM-GAIN",
	};
}

// ---------------------------------------------------------------------------------------------------------
// Cleanup: EVERY state layer this lab touches — surfaces (via game.delete_surface; platform.destroy() is a
// no-op, Pitfall #19), storage.midcraft_lab, prefix-scoped export/job-result records, the defer flag —
// then a zero-leftover check. Global registry counts are REPORTED (shared cluster) but only OUR prefix
// leftovers hard-fail.
// ---------------------------------------------------------------------------------------------------------
function cleanupInstance(prior) {
	const restoreDebug = prior && prior.had_debug && !prior.debug_mode ? "remote.call('surface_export','configure',{debug_mode=false})" : "";
	return lua(`
		local deleted={}
		for _,s in pairs(game.surfaces) do
			local p=s.platform
			if string.find(s.name,'${prefix}',1,true)==1 or (p and p.valid and string.find(p.name,'${prefix}',1,true)==1) then
				deleted[#deleted+1]=s.name; game.delete_surface(s)
			end
		end
		local records={}
		for id,r in pairs(storage.platform_exports or {}) do
			if r and type(r.platform_name)=='string' and string.find(r.platform_name,'${prefix}',1,true)==1 then
				storage.platform_exports[id]=nil; records[#records+1]='export:'..tostring(id)
			end
		end
		for id,r in pairs(storage.async_job_results or {}) do
			if r and type(r.platform_name)=='string' and string.find(r.platform_name,'${prefix}',1,true)==1 then
				storage.async_job_results[id]=nil; records[#records+1]='job_result:'..tostring(id)
			end
		end
		remote.call('surface_export','configure',{test_defer_clone_activation=false})
		${restoreDebug}
		storage.midcraft_lab=nil
		game.tick_paused=false
		return {success=true,deleted=deleted,records=records,tick=game.tick}
	`);
}
function zeroCheck() {
	return lua(`
		local function count(t) local n=0 for _,_ in pairs(t or {}) do n=n+1 end return n end
		local surfaces,exports={},{}
		for _,s in pairs(game.surfaces) do
			local p=s.platform
			if string.find(s.name,'${prefix}',1,true)==1 or (p and p.valid and string.find(p.name,'${prefix}',1,true)==1) then surfaces[#surfaces+1]=s.name end
		end
		for id,r in pairs(storage.platform_exports or {}) do
			local n=r and r.platform_name
			if type(n)=='string' and string.find(n,'${prefix}',1,true)==1 then exports[#exports+1]=id end
		end
		local cfg=storage.surface_export_config or {}
		return {success=true,tick=game.tick,zero_surfaces=#surfaces==0,surfaces=surfaces,
			zero_storage=storage.midcraft_lab==nil,defer_flag_clear=cfg.test_defer_clone_activation~=true,
			game_paused=game.tick_paused==true,
			destination_holds=count(storage.destination_holds),locked_platforms=count(storage.locked_platforms),
			committed_source_transfer_tombstones=count(storage.committed_source_transfer_tombstones),
			lab_platform_exports=#exports}
	`);
}
function zeroOk(v) {
	return v.zero_surfaces && v.zero_storage && v.defer_flag_clear && !v.game_paused && v.lab_platform_exports === 0;
}
function cleanupAll(prior) {
	const cleanup = cleanupInstance(prior);
	sleep(1000); // game.delete_surface is deferred to end of tick
	const zero = zeroCheck();
	return { cleanup, zero, ok: zeroOk(zero) };
}

function main() {
	const results = {
		script: "tests/midcraft-lab/run-mc1.mjs", instance, started: new Date().toISOString(), sections,
		status: "UNVALIDATED-UNTIL-EXECUTED",
		question: "does the crafting_progress restore write TAKE on a fresh deactivated machine, and does the engine then complete the craft producing outputs exactly once?",
		rungs: {}, errors: [],
	};
	let prior = null;
	try {
		results.initial_reset = cleanupAll(null);
		if (!results.initial_reset.ok) throw new Error(`Initial cleanup failed: ${JSON.stringify(results.initial_reset)}`);
		prior = captureConfig();
		results.prior_config = prior;
		if (sections.includes("mc1")) results.rungs.mc1 = runMC1();
	} catch (error) { results.errors.push(error.stack || error.message); }
	finally {
		try { results.final_reset = cleanupAll(prior); } catch (error) { results.errors.push(`Cleanup failed: ${error.stack || error.message}`); }
		results.finished = new Date().toISOString();
		if (!noNotebook && !resetOnly) {
			appendFileSync(notebook, `\n\n## ${results.finished} - MC1 mid-craft pipeline run\n\nQuestion: ${results.question}\nMeasured reality: ${results.rungs.mc1 ? results.rungs.mc1.measured_reality : "NONE (instrument failure)"}\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n`);
		}
		console.log(JSON.stringify(results, null, 2));
		// Exit 0 for ANY clean measurement (RESET-LOSS / PHANTOM-GAIN are valid FINDINGS, not runner failures);
		// non-zero only for instrument failure, UNCLASSIFIED, or cleanup failure.
		if (results.errors.length || !results.final_reset?.ok || (results.rungs.mc1 && !results.rungs.mc1.success)) process.exitCode = 1;
	}
}

if (resetOnly) { const result = cleanupAll(null); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; }
else main();
