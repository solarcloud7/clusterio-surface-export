#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const controller = "surface-export-controller";
const config = "/clusterio/tokens/config-control.json";
const source = "clusterio-host-1-instance-1";
const destination = "clusterio-host-2-instance-1";
const prefix = "no-tick-sync-lab-b5-";
const notebook = "tests/no-tick-sync-lab/NOTEBOOK.md";
let sections = ["b5"];
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
	if (!parsed.length || parsed.some(v => v !== "b5")) throw new Error("B5 runner supports only --sections b5");
	return parsed;
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function lastLine(value) { return String(value).split(/\r?\n/).map(v => v.trim()).filter(Boolean).at(-1) || ""; }
function rcon(instance, command) {
	return execFileSync("docker", ["exec", controller, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", instance, command, "--config", config],
	{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function lua(instance, body) {
	const wrapped = `local ok,result=pcall(function() ${body} end); if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	const raw = lastLine(rcon(instance, `/sc ${wrapped}`));
	return JSON.parse(raw);
}
function step(instance, ticks) { rcon(instance, `/step-tick ${ticks}`); }

const readLua = String.raw`
local record = storage.no_tick_sync_lab and storage.no_tick_sync_lab.b5
local surface = record and game.surfaces[record.surface] or nil
local furnace = surface and surface.find_entity("stone-furnace", {0, 0}) or nil
if not (furnace and furnace.valid) then return { success=false, error="furnace missing", tick=game.tick } end
local input = furnace.get_inventory(defines.inventory.furnace_source)
local output = furnace.get_inventory(defines.inventory.furnace_result)
local fuel = furnace.get_inventory(defines.inventory.fuel)
return {
	success=true, tick=game.tick, game_paused=game.tick_paused == true, platform_paused=nil,
	active=furnace.active, status=furnace.status, crafting_progress=furnace.crafting_progress,
	input_count=input and input.get_item_count("iron-ore") or 0,
	output_count=output and output.get_item_count("iron-plate") or 0,
	fuel_count=fuel and fuel.get_item_count("coal") or 0,
	entity_ore_count=furnace.get_item_count("iron-ore"),
	entity_plate_count=furnace.get_item_count("iron-plate"),
}
`;

function read(instance) { return lua(instance, readLua); }
function setupB5() {
	const name = `${prefix}${Date.now()}`;
	const setup = lua(source, `
		local surface=game.create_surface('${name}',{width=64,height=64})
		local furnace=surface.create_entity({name='stone-furnace',position={0,0},force=game.forces.player})
		furnace.insert({name='coal',count=10}); furnace.insert({name='iron-ore',count=10})
		storage.no_tick_sync_lab={b5={surface=surface.index,unit_number=furnace.unit_number,name='${name}'}}
		game.tick_paused=false
		return {success=true,name='${name}',tick=game.tick,unit_number=furnace.unit_number}
	`);
	let mid = null;
	for (let i = 0; i < 30; i += 1) {
		step(source, 5);
		mid = read(source);
		if (mid.crafting_progress > 0 && mid.crafting_progress < 1) break;
	}
	if (!(mid?.crafting_progress > 0 && mid.crafting_progress < 1)) throw new Error(`Could not establish mid-craft control: ${JSON.stringify(mid)}`);
	const frozen = lua(source, `local r=storage.no_tick_sync_lab.b5; local f=game.surfaces[r.surface].find_entity('stone-furnace',{0,0}); f.active=false; ${readLua}`);
	return { setup, mid_craft: mid, frozen };
}

function runB5() {
	const setup = setupB5();
	const synchronous = lua(source, `
		local r=storage.no_tick_sync_lab.b5; local f=game.surfaces[r.surface].find_entity('stone-furnace',{0,0})
		local before_tick=game.tick; local before_progress=f.crafting_progress
		local input=f.get_inventory(defines.inventory.furnace_source); local output=f.get_inventory(defines.inventory.furnace_result)
		local before_input=input.get_item_count('iron-ore'); local before_output=output.get_item_count('iron-plate')
		f.active=true
		local after={tick=game.tick,game_paused=game.tick_paused==true,platform_paused=nil,active=f.active,
			crafting_progress=f.crafting_progress,input_count=input.get_item_count('iron-ore'),output_count=output.get_item_count('iron-plate'),
			entity_ore_count=f.get_item_count('iron-ore'),entity_plate_count=f.get_item_count('iron-plate')}
		return {success=true,before={tick=before_tick,crafting_progress=before_progress,input_count=before_input,output_count=before_output},after=after}
	`);
	const sameExecution = synchronous.before.tick === synchronous.after.tick
		&& synchronous.before.crafting_progress === synchronous.after.crafting_progress
		&& synchronous.before.input_count === synchronous.after.input_count
		&& synchronous.before.output_count === synchronous.after.output_count;
	if (!sameExecution) throw new Error(`B5 STOP: crafting advanced without an elapsed tick: ${JSON.stringify(synchronous)}`);
	step(source, 1);
	const plus1 = read(source);
	step(source, 59);
	const plus60 = read(source);
	const resumed = plus1.crafting_progress !== synchronous.after.crafting_progress
		|| plus1.input_count !== synchronous.after.input_count || plus1.output_count !== synchronous.after.output_count
		|| plus60.crafting_progress !== synchronous.after.crafting_progress
		|| plus60.input_count !== synchronous.after.input_count || plus60.output_count !== synchronous.after.output_count;
	if (!resumed) throw new Error(`B5 instrument failed: furnace never resumed after elapsed ticks: ${JSON.stringify({ synchronous, plus1, plus60 })}`);
	return { success: true, prediction: "no change inside one execution; progress resumes only after elapsed ticks", setup, synchronous,
		plus1: { requested_ticks: 1, observed_elapsed_ticks: plus1.tick - synchronous.after.tick, read: plus1 },
		plus60: { requested_additional_ticks: 59, observed_elapsed_ticks: plus60.tick - synchronous.after.tick, read: plus60 },
		step_tick_limitation: "/step-tick ignores its count and only unpauses; observed elapsed ticks are reported",
		same_execution_unchanged: sameExecution, resumed_after_ticks: resumed };
}

function cleanupInstance(instance) {
	return lua(instance, `
		local deleted={}
		for _,surface in pairs(game.surfaces) do if string.find(surface.name,'${prefix}',1,true)==1 then deleted[#deleted+1]=surface.name; game.delete_surface(surface) end end
		storage.no_tick_sync_lab=nil; game.tick_paused=false
		return {success=true,deleted=deleted,tick=game.tick}
	`);
}
function zeroCheck(instance) {
	return lua(instance, `
		local function count(t) local n=0 for _,_ in pairs(t or {}) do n=n+1 end return n end
		local surfaces,exports={},{}
		for _,s in pairs(game.surfaces) do if string.find(s.name,'${prefix}',1,true)==1 then surfaces[#surfaces+1]=s.name end end
		for id,r in pairs(storage.platform_exports or {}) do local n=r and r.platform_name; if type(n)=='string' and string.find(n,'${prefix}',1,true)==1 then exports[#exports+1]=id end end
		return {success=true,tick=game.tick,zero_surfaces=#surfaces==0,surfaces=surfaces,zero_storage=storage.no_tick_sync_lab==nil,
			game_paused=game.tick_paused==true,destination_holds=count(storage.destination_holds),locked_platforms=count(storage.locked_platforms),
			committed_source_transfer_tombstones=count(storage.committed_source_transfer_tombstones),lab_platform_exports=#exports,force_count=#game.forces}
	`);
}
function zeroOk(v) { return v.zero_surfaces && v.zero_storage && !v.game_paused && v.destination_holds === 0 && v.locked_platforms === 0 && v.committed_source_transfer_tombstones === 0 && v.lab_platform_exports === 0; }
function cleanupAll() {
	const cleanup = { source: cleanupInstance(source), destination: cleanupInstance(destination) };
	step(source, 3); step(destination, 3);
	const zero = { source: zeroCheck(source), destination: zeroCheck(destination) };
	return { cleanup, zero, ok: zeroOk(zero.source) && zeroOk(zero.destination) };
}

function main() {
	const results = { script: "tests/no-tick-sync-lab/run-b5.mjs", started: new Date().toISOString(), sections,
		prediction: "B5: no crafting progress or inventory change without an elapsed tick", rungs: {}, errors: [] };
	try {
		results.initial_reset = cleanupAll();
		if (!results.initial_reset.ok) throw new Error(`Initial cleanup failed: ${JSON.stringify(results.initial_reset)}`);
		if (sections.includes("b5")) results.rungs.b5 = runB5();
	} catch (error) { results.errors.push(error.stack || error.message); }
	finally {
		try { results.final_reset = cleanupAll(); } catch (error) { results.errors.push(`Cleanup failed: ${error.stack || error.message}`); }
		results.finished = new Date().toISOString();
		if (!noNotebook && !resetOnly) appendFileSync(notebook, `\n\n## ${results.finished} - B5 craft-without-a-tick run\n\nPrediction: no crafting progress or inventory change without an elapsed tick.\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n`);
		console.log(JSON.stringify(results, null, 2));
		if (results.errors.length || !results.final_reset?.ok) process.exitCode = 1;
	}
}

if (resetOnly) { const result = cleanupAll(); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; }
else main();
