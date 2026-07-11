#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const controller = "surface-export-controller";
const config = "/clusterio/tokens/config-control.json";
const instances = { source: "clusterio-host-1-instance-1", destination: "clusterio-host-2-instance-1" };
const prefix = "fluid-lab-r12-";
const notebook = "tests/fluid-lab/NOTEBOOK.md";
const allowed = ["b6a", "b6b"];
let sections = [...allowed];
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
	if (!parsed.length || parsed.some(v => !allowed.includes(v))) throw new Error(`Sections must be ${allowed.join(",")}`);
	return parsed;
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function lastLine(value) { return String(value).split(/\r?\n/).map(v => v.trim()).filter(Boolean).at(-1) || ""; }
function rcon(instance, command) {
	return execFileSync("docker", ["exec", controller, "npx", "clusterioctl", "--log-level", "error", "instance", "send-rcon", instance, command, "--config", config], { encoding: "utf8" }).trim();
}
function lua(instance, body) {
	const wrapped = `local ok,result=pcall(function() ${body} end);if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	return JSON.parse(lastLine(rcon(instance, `/sc ${wrapped}`)));
}

const helper = String.raw`
storage.fluid_lab=storage.fluid_lab or {records={}}
__fluid_lab_r12={}
function __fluid_lab_r12.make(name)
	local s=game.create_surface(name,{width=128,height=128})
	storage.fluid_lab.records[name]={surface=s.index}
	return s
end
function __fluid_lab_r12.read(entity,label)
	local direct=entity.fluidbox[1]
	local ok_id,id=pcall(function() return entity.fluidbox.get_fluid_segment_id(1) end)
	local ok_contents,contents=pcall(function() return entity.fluidbox.get_fluid_segment_contents(1) end)
	return {label=label,tick=game.tick,game_paused=game.tick_paused==true,platform_paused=nil,
		direct=direct and {name=direct.name,amount=direct.amount,temperature=direct.temperature} or nil,
		segment_id=ok_id and id or nil,segment_contents=ok_contents and contents or nil}
end
return {success=true,tick=game.tick}
`;

function install() {
	return { source: lua(instances.source, helper), destination: lua(instances.destination, helper) };
}

function runB6a() {
	const name = `${prefix}merge-${Date.now()}`;
	const setup = lua(instances.source, `
		local s=__fluid_lab_r12.make('${name}')
		local control=s.create_entity{name='storage-tank',position={0,12},force=game.forces.player}
		local controls={}
		for _,temp in ipairs{165,500} do control.clear_fluid_inside();control.fluidbox[1]={name='water',amount=500,temperature=temp};local f=control.fluidbox[1];controls[#controls+1]={asked=temp,read=f and f.temperature or nil,tick=game.tick} end
		control.destroy()
		local a=s.create_entity{name='storage-tank',position={-5,0},force=game.forces.player}
		local b=s.create_entity{name='storage-tank',position={5,0},force=game.forces.player}
		a.fluidbox[1]={name='steam',amount=500,temperature=165}
		b.fluidbox[1]={name='steam',amount=1500,temperature=500}
		local before={a=__fluid_lab_r12.read(a,'isolated A'),b=__fluid_lab_r12.read(b,'isolated B')}
		for x=-3,2 do s.create_entity{name='pipe',position={x,1},force=game.forces.player} end
		s.create_entity{name='pipe',position={2,0},force=game.forces.player};s.create_entity{name='pipe',position={2,-1},force=game.forces.player};s.create_entity{name='pipe',position={3,-1},force=game.forces.player}
		local member=s.find_entities_filtered{name='pipe'}[1];if not member then error('connector pipe placement failed') end;local topology_same_tick=__fluid_lab_r12.read(member,'connector same tick')
		return {success=true,prediction='2000 steam at 416.25C; water control clamps and cannot carry the requested temperatures',water_control=controls,before=before,topology_same_tick=topology_same_tick}
	`);
	if (!setup.success) throw new Error(`B6a instrument failure: ${JSON.stringify(setup)}`);
	sleep(200);
	const merged = lua(instances.source, `local s=game.surfaces['${name}'];local member=s.find_entities_filtered{name='pipe'}[1];return __fluid_lab_r12.read(member,'merged after elapsed tick')`);
	const result = { ...setup, merged };
	const fluid = result.merged?.direct;
	const segmentAmount = result.merged?.segment_contents?.steam;
	result.success = fluid?.name === "steam" && Math.abs(segmentAmount - 2000) <= 1e-6 && Math.abs(fluid.temperature - 416.25) <= 1e-6;
	result.verdict = result.success ? "volume-weighted temperature and volume conservation confirmed" : "prediction refuted";
	if (!result.success) throw new Error(`B6a STOP: ${JSON.stringify(result)}`);
	return result;
}

function runB6b() {
	const name = `${prefix}keys-${Date.now()}`;
	const result = lua(instances.source, `
		local s=__fluid_lab_r12.make('${name}');local temps={9999,10001,100000,1000000,10000000};local rows={}
		for i,temp in ipairs(temps) do local t=s.create_entity{name='storage-tank',position={i*5,0},force=game.forces.player};t.fluidbox[1]={name='steam',amount=100,temperature=temp};local f=t.fluidbox[1];rows[#rows+1]={asked=temp,tick=game.tick,game_paused=game.tick_paused==true,platform_paused=nil,direct={name=f.name,amount=f.amount,temperature=f.temperature},key=string.format('%s@%.1fC',f.name,f.temperature)} end
		return {success=true,prediction='identify the first engine-read key instability or collision without assuming a threshold',rows=rows}
	`);
	sleep(1200);
	const reread = lua(instances.source, `local s=game.surfaces['${name}'];local rows={};for i,t in ipairs(s.find_entities_filtered{name='storage-tank'}) do local f=t.fluidbox[1];rows[#rows+1]={tick=game.tick,asked_index=i,direct=f and {name=f.name,amount=f.amount,temperature=f.temperature} or nil,key=f and string.format('%s@%.1fC',f.name,f.temperature) or nil} end;return {success=true,rows=rows}`);
	result.reread = reread;
	result.stable = result.rows.every((row, i) => row.key === reread.rows[i]?.key && row.direct.temperature === reread.rows[i]?.direct?.temperature);
	result.collisions = result.rows.filter((row, i, all) => all.findIndex(other => other.key === row.key) !== i).map(row => row.key);
	result.success = result.stable;
	result.verdict = result.stable ? `keys stable through ${Math.max(...result.rows.map(r => r.direct.temperature))}C at %.1f formatting` : "key instability observed";
	return result;
}

function cleanup(instance) {
	return lua(instance, `local deleted={};for _,s in pairs(game.surfaces) do if string.find(s.name,'${prefix}',1,true)==1 then deleted[#deleted+1]=s.name;game.delete_surface(s) end end;storage.fluid_lab=nil;__fluid_lab_r12=nil;game.tick_paused=false;return {success=true,deleted=deleted,tick=game.tick}`);
}
function zero(instance) {
	return lua(instance, `local function count(t)local n=0 for _ in pairs(t or{})do n=n+1 end return n end;local surfaces,exports={},{};for _,s in pairs(game.surfaces)do if string.find(s.name,'${prefix}',1,true)==1 then surfaces[#surfaces+1]=s.name end end;for id,r in pairs(storage.platform_exports or{})do if r and r.platform_name and string.find(r.platform_name,'${prefix}',1,true)==1 then exports[#exports+1]=id end end;return {success=true,tick=game.tick,zero_surfaces=#surfaces==0,surfaces=surfaces,zero_storage=storage.fluid_lab==nil,game_paused=game.tick_paused==true,destination_holds=count(storage.destination_holds),locked_platforms=count(storage.locked_platforms),committed_source_transfer_tombstones=count(storage.committed_source_transfer_tombstones),lab_platform_exports=#exports}`);
}
function cleanAll() {
	const cleanupResult = { source: cleanup(instances.source), destination: cleanup(instances.destination) };
	sleep(300);
	const z = { source: zero(instances.source), destination: zero(instances.destination) };
	const good = v => v.zero_surfaces && v.zero_storage && !v.game_paused && v.destination_holds === 0 && v.locked_platforms === 0 && v.committed_source_transfer_tombstones === 0 && v.lab_platform_exports === 0;
	return { cleanup: cleanupResult, zero: z, ok: good(z.source) && good(z.destination) };
}

function main() {
	const result = { script: "tests/fluid-lab/run-r12.mjs", started: new Date().toISOString(), sections, predictions: { b6a: "volume-weighted merge with exact volume conservation", b6b: "measure key stability without presuming 10,000C" }, rungs: {}, errors: [] };
	try {
		result.initial_reset = cleanAll();
		if (!result.initial_reset.ok) throw new Error(`initial cleanup failed ${JSON.stringify(result.initial_reset)}`);
		result.install = install();
		if (sections.includes("b6a")) result.rungs.b6a = runB6a();
		if (sections.includes("b6b")) result.rungs.b6b = runB6b();
	} catch (error) { result.errors.push(error.stack || error.message); }
	finally {
		try { result.final_reset = cleanAll(); } catch (error) { result.errors.push(`cleanup failed: ${error.stack || error.message}`); }
		result.finished = new Date().toISOString();
		if (!noNotebook && !resetOnly) appendFileSync(notebook, `\n\n## ${result.finished} - R12 / LAB-B6 temperature grounding\n\nPredictions stated before execution: unequal-volume temperature merges volume-weighted with exact volume conservation; key stability is measured without presuming the 10,000C threshold.\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
		console.log(JSON.stringify(result, null, 2));
		if (result.errors.length || !result.final_reset?.ok) process.exitCode = 1;
	}
}

if (resetOnly) {
	const result = cleanAll();
	console.log(JSON.stringify(result, null, 2));
	if (!result.ok) process.exitCode = 1;
} else main();
