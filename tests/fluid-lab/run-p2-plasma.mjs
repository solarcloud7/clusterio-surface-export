#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const controller = "surface-export-controller";
const config = "/clusterio/tokens/config-control.json";
const source = "clusterio-host-1-instance-1";
const destination = "clusterio-host-2-instance-1";
const destinationId = 1351385547;
const prefix = "fluid-lab-p2-";
const notebook = "tests/fluid-lab/NOTEBOOK.md";
const allowed = ["single", "two", "tank", "isolated"];
let sections = [...allowed];
let runs = 5;
let resetOnly = false;
let noNotebook = false;

for (let i = 2; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (arg === "--reset") resetOnly = true;
	else if (arg === "--no-notebook") noNotebook = true;
	else if (arg === "--sections") sections = (process.argv[++i] || "").split(",");
	else if (arg.startsWith("--sections=")) sections = arg.slice(11).split(",");
	else if (arg === "--runs") runs = Number(process.argv[++i]);
	else if (arg.startsWith("--runs=")) runs = Number(arg.slice(7));
	else throw new Error(`unknown argument ${arg}`);
}
if (sections.some(section => !allowed.includes(section))) throw new Error(`sections must be ${allowed.join(",")}`);
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lastLine(value) {
	return String(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || "";
}

function rcon(instance, command) {
	return execFileSync("docker", [
		"exec", controller, "npx", "clusterioctl", "--config", config, "--log-level", "error",
		"instance", "send-rcon", instance, command,
	], { encoding: "utf8", timeout: 180000 }).trim();
}

function lua(instance, body) {
	const wrapped = `local ok,result=pcall(function() ${body} end);` +
		`if ok then rcon.print(helpers.table_to_json(result)) ` +
		`else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	const result = JSON.parse(lastLine(rcon(instance, `/sc ${wrapped}`)));
	if (result.success === false) throw new Error(`${instance}: ${result.error}`);
	return result;
}

function waitFor(fn, timeout, label) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = fn();
		if (value) return value;
		sleep(250);
	}
	throw new Error(`timeout waiting for ${label}`);
}

function findPlatform(instance, name) {
	return lua(instance, `for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and p.name=='${name}' then return {success=true,index=p.index,tick=game.tick} end end ` +
		`return {success=true,index=nil,tick=game.tick}`);
}

function cleanup(instance) {
	return lua(instance, `for _,s in pairs(game.surfaces) do local p=s.platform ` +
		`if string.find(s.name,'${prefix}',1,true)==1 or (p and p.valid and string.find(p.name,'${prefix}',1,true)==1) ` +
		`then game.delete_surface(s) end end ` +
		`local c=storage.surface_export_config or {};c.test_capture_p2_plasma=nil;` +
		`c.test_force_validation_failure=nil;c.preserve_failed_destination=nil;storage.fluid_lab=nil;` +
		`local remove={};for id,v in pairs(storage.platform_exports or {})do ` +
		`if type(v)=='table' and string.find(v.platform_name or '','${prefix}',1,true)==1 then remove[#remove+1]=id end end;` +
		`for _,id in ipairs(remove)do storage.platform_exports[id]=nil end;` +
		`game.tick_paused=false;return {success=true}`);
}

function zero(instance) {
	return lua(instance, `local function n(t)local c=0 for _ in pairs(t or {})do c=c+1 end return c end ` +
		`local surfaces=0;for _,s in pairs(game.surfaces)do local p=s.platform ` +
		`if string.find(s.name,'${prefix}',1,true)==1 or (p and p.valid and string.find(p.name,'${prefix}',1,true)==1) ` +
		`then surfaces=surfaces+1 end end ` +
		`local exports=0;for _,v in pairs(storage.platform_exports or {})do ` +
		`if type(v)=='table' and string.find(v.platform_name or '','${prefix}',1,true)==1 then exports=exports+1 end end ` +
		`return {success=true,surfaces=surfaces,storage=storage.fluid_lab~=nil,game_paused=game.tick_paused==true,` +
		`holds=n(storage.destination_holds),locks=n(storage.locked_platforms),jobs=n(storage.async_jobs),` +
		`tombstones=n(storage.committed_source_transfer_tombstones),exports=exports}`);
}

function cleanAll() {
	cleanup(source);
	cleanup(destination);
	sleep(300);
	const result = { source: zero(source), destination: zero(destination) };
	result.ok = [result.source, result.destination].every(value => value.surfaces === 0 && !value.storage &&
		!value.game_paused && value.holds === 0 && value.locks === 0 && value.jobs === 0 &&
		value.tombstones === 0 && value.exports === 0);
	return result;
}

const captureLua = `local function capture(p,label)local holders={} ` +
	`for _,e in ipairs(p.surface.find_entities_filtered({}))do if e.valid and e.fluidbox and ` +
	`(e.name=='fusion-reactor' or e.name=='pipe' or e.name=='storage-tank')then ` +
	`for i=1,#e.fluidbox do local f=e.fluidbox[i];local sid=e.fluidbox.get_fluid_segment_id(i);` +
	`local sc=sid and e.fluidbox.get_fluid_segment_contents(i) or nil;` +
	`local proto=e.prototype.fluidbox_prototypes and e.prototype.fluidbox_prototypes[i] or nil;` +
	`holders[#holders+1]={entity=e.name,unit_number=e.unit_number,position={x=e.position.x,y=e.position.y},box=i,` +
	`production_type=proto and proto.production_type or nil,active=e.active,segment_id=sid,` +
	`direct=f and{name=f.name,amount=f.amount,temperature=f.temperature}or nil,segment_contents=sc} end end end ` +
	`return {success=true,label=label,tick=game.tick,game_paused=game.tick_paused==true,` +
	`platform_paused=p.paused,holders=holders} end `;

function census(instance, name, label) {
	return lua(instance, `${captureLua} local p=nil;for _,v in pairs(game.forces.player.platforms)do ` +
		`if v.valid and v.name=='${name}'then p=v end end;if not p then error('platform missing')end;` +
		`return capture(p,'${label}')`);
}

function buildFixture(name, kind) {
	const setup = {
		single: `local r=make('fusion-reactor',{0,0},defines.direction.north);` +
			`local a=make('pipe',{1.5,3.5});make('pipe',{1.5,4.5});local w=make('pipe',{1.5,5.5});` +
			`w.fluidbox[1]={name='fusion-plasma',amount=100,temperature=1234567}`,
		two: `local r1=make('fusion-reactor',{-4,0},defines.direction.east);` +
			`local r2=make('fusion-reactor',{4,0},defines.direction.west);` +
			`local a=make('pipe',{-0.5,-1.5});local w=make('pipe',{0.5,-1.5});` +
			`w.fluidbox[1]={name='fusion-plasma',amount=200,temperature=1234567}`,
		tank: `local r=make('fusion-reactor',{0,0},defines.direction.north);` +
			`make('pipe',{1.5,3.5});make('pipe',{1.5,4.5});make('pipe',{1.5,5.5});` +
			`local t=make('storage-tank',{1.5,7.5});make('pipe',{0.5,5.5});make('pipe',{0.5,6.5});` +
			`t.fluidbox[1]={name='fusion-plasma',amount=500,temperature=1234567}`,
		isolated: `local w=make('pipe',{10.5,10.5});w.fluidbox[1]={name='fusion-plasma',amount=100,temperature=1234567}`,
	}[kind];
	return lua(source, `local force=game.forces.player;local p=force.create_space_platform{` +
		`name='${name}',planet='nauvis',starter_pack='space-platform-starter-pack'};p.apply_starter_pack();` +
		`local schedule=p.get_schedule();schedule.add_record({station='Nauvis',` +
		`wait_conditions={{type='time',ticks=7200,compare_type='or'}}});` +
		`local tiles={};for x=-10,10 do for y=-10,10 do tiles[#tiles+1]={name='space-platform-foundation',position={x,y}} end end;` +
		`p.surface.set_tiles(tiles);for _,e in pairs(p.surface.find_entities_filtered({}))do ` +
		`if e.name~='space-platform-hub'then e.destroy()end end;` +
		`local function make(n,pos,dir)local e=p.surface.create_entity{name=n,position=pos,direction=dir or defines.direction.north,force=force};` +
		`if not e then error('failed to place '..n..' at '..serpent.line(pos))end;return e end;${setup};` +
		`p.paused=true;${captureLua} local read=capture(p,'fixture-created');` +
		`local total=0;local seen={};for _,h in ipairs(read.holders)do if h.segment_id and not seen[h.segment_id]then ` +
		`seen[h.segment_id]=true;total=total+((h.segment_contents or {})['fusion-plasma']or 0)end end;` +
		`if total<=0 then error('fixture plasma write not accepted')end;` +
		(kind === "isolated" ? "" : `local managed={};local passive={};for _,h in ipairs(read.holders)do ` +
			`if h.entity=='fusion-reactor'and h.box==2 and h.segment_id then managed[h.segment_id]=true end;` +
			`if (h.entity=='pipe'or h.entity=='storage-tank')and h.segment_id then passive[h.segment_id]=true end end;` +
			`local joined=false;for sid in pairs(passive)do if managed[sid]then joined=true end end;` +
			`if not joined then error('fixture contract failed: no passive holder shares the reactor output segment')end;`) +
		`return {success=true,index=p.index,total=total,read=read}`);
}

function activateAndStep(name, ticks) {
	const start = lua(destination, `local p=nil;for _,v in pairs(game.forces.player.platforms)do ` +
		`if v.valid and v.name=='${name}'then p=v end end;if not p then error('platform missing')end;` +
		`p.paused=false;for _,e in pairs(p.surface.find_entities_filtered({}))do ` +
		`if e.active~=nil then e.active=true end end;local start=game.tick;game.tick_paused=false;` +
		`return {success=true,start=start,target=start+${ticks}}`);
	waitFor(() => {
		const now = lua(destination, `return {success=true,tick=game.tick}`);
		return now.tick >= start.target ? now : null;
	}, 30000, `${ticks} elapsed ticks`);
	return lua(destination, `game.tick_paused=true;return {success=true,tick=game.tick}`);
}

function segmentPlasma(reading) {
	const seen = new Set();
	let total = 0;
	for (const holder of reading?.holders || []) {
		if (holder.segment_id == null || seen.has(holder.segment_id)) continue;
		seen.add(holder.segment_id);
		total += Number(holder.segment_contents?.["fusion-plasma"] || 0);
	}
	return total;
}

function holderRows(reading) {
	return (reading?.holders || []).map(holder => ({
		holder: `${holder.entity}@${holder.position.x},${holder.position.y}#${holder.box}`,
		production_type: holder.production_type,
		active: holder.active,
		segment_id: holder.segment_id,
		direct_amount: Number(holder.direct?.amount || 0),
		segment_plasma: Number(holder.segment_contents?.["fusion-plasma"] || 0),
	}));
}

function runOne(kind, run) {
	const name = `${prefix}${kind}-${Date.now()}-${run}`;
	const fixture = buildFixture(name, kind);
	const sourceRead = census(source, name, "source-frozen");
	lua(destination, `remote.call('surface_export','configure',{debug_mode=true,` +
		`test_capture_p2_plasma={platform_name='${name}'},test_force_validation_failure=true,` +
		`preserve_failed_destination=true});return {success=true,tick=game.tick}`);
	rcon(source, `/transfer-platform ${fixture.index} ${destinationId}`);
	rcon(destination, "/step-tick 2");
	const ready = waitFor(() => {
		const platform = findPlatform(destination, name);
		if (!platform.index) return null;
		const state = lua(destination, `game.tick_paused=false;local c=storage.surface_export_config or {};` +
			`local cap=storage.fluid_lab and storage.fluid_lab.p2_capture;` +
			`return {success=true,jobs=(function()local n=0 for _ in pairs(storage.async_jobs or {})do n=n+1 end return n end)(),` +
			`tick=game.tick,armed=c.test_capture_p2_plasma~=nil,preserve=c.preserve_failed_destination,` +
		`capture=cap and cap.platform_name or nil}`);
		return state.jobs === 0 && !state.armed && state.preserve !== true && state.capture === name ? state : null;
	}, 180000, `P2 frozen destination ${name}`);
	const writeTime = lua(destination, `return {success=true,capture=storage.fluid_lab and storage.fluid_lab.p2_capture}`);
	if (!writeTime.capture || writeTime.capture.platform_name !== name) throw new Error(`P2 hook did not fire for ${name}`);
	const frozen = census(destination, name, "destination-frozen");
	const activation = activateAndStep(name, 120);
	const post = census(destination, name, "destination-post-activation-120");
	gamePauseOff();
	const totals = {
		source: segmentPlasma(sourceRead),
		write_time: segmentPlasma(writeTime.capture),
		frozen: segmentPlasma(frozen),
		post_activation_120: segmentPlasma(post),
	};
	return {
		kind, run, name, fixture_total: fixture.total, ready, activation, totals,
		write_to_frozen_delta: totals.frozen - totals.write_time,
		frozen_to_post_delta: totals.post_activation_120 - totals.frozen,
		holders: {
			source: holderRows(sourceRead), write_time: holderRows(writeTime.capture),
			frozen: holderRows(frozen), post_activation_120: holderRows(post),
		},
	};
}

function gamePauseOff() {
	lua(destination, `game.tick_paused=false;return {success=true}`);
}

function summarize(results) {
	const table = [];
	for (const section of sections) {
		const rows = results.filter(row => row.kind === section);
		const frozenValues = rows.map(row => row.totals.frozen);
		table.push({
			fixture: section,
			runs: rows.length,
			source: rows.map(row => row.totals.source),
			write_time: rows.map(row => row.totals.write_time),
			frozen: frozenValues,
			post_activation_120: rows.map(row => row.totals.post_activation_120),
			write_vs_frozen: rows.map(row => row.write_to_frozen_delta),
			frozen_deterministic: new Set(frozenValues.map(String)).size === 1,
		});
	}
	return table;
}

function main() {
	const output = {
		script: "tests/fluid-lab/run-p2-plasma.mjs",
		started: new Date().toISOString(), sections, runs,
		predictions: {
			single: "characterize box-only versus whole-segment reassertion without assuming either",
			two: "multi-reactor segment may reproduce T2 write-time versus frozen disagreement",
			tank: "connected passive tank plasma remains player-recoverable and must stay visible",
			isolated: "isolated plasma conserves exactly in every run",
		},
		results: [], errors: [],
	};
	try {
		output.initial_reset = cleanAll();
		if (!output.initial_reset.ok) throw new Error("initial cleanup failed");
		for (const section of sections) {
			for (let run = 1; run <= runs; run++) {
				try {
					output.results.push(runOne(section, run));
				} finally {
					cleanup(source);
					cleanup(destination);
				}
			}
		}
		output.table = summarize(output.results);
		const control = output.table.find(row => row.fixture === "isolated");
		if (control && control.frozen.some((value, i) => value !== control.source[i])) {
			throw new Error(`P2 isolated control lost plasma: ${JSON.stringify(control)}`);
		}
	} catch (error) {
		output.errors.push(error.stack || error.message);
	} finally {
		output.final_reset = cleanAll();
		output.finished = new Date().toISOString();
		if (!noNotebook && !resetOnly) appendFileSync(notebook,
			`\n\n## ${output.finished} - P2 plasma segment-persistence characterization\n\n` +
			`Predictions were stated before execution. This rung characterizes four fixtures and does not ` +
			`authorize a redesign.\n\n\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\`\n`);
		console.log(JSON.stringify(output, null, 2));
		if (output.errors.length || !output.final_reset.ok) process.exitCode = 1;
	}
}

if (resetOnly) {
	const result = cleanAll();
	console.log(JSON.stringify(result, null, 2));
	if (!result.ok) process.exitCode = 1;
} else {
	main();
}
