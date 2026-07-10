#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";

const controller = "surface-export-controller";
const config = "/clusterio/tokens/config-control.json";
const source = "clusterio-host-1-instance-1";
const destination = "clusterio-host-2-instance-1";
const prefix = "engine-repin-lab-";
const notebook = "tests/engine-repin-lab/NOTEBOOK.md";
const allowed = ["b7", "b8", "b9"];
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
function warningCount() {
	const command = "grep -R -h -F \"Skipped unknown item 'totally-not-a-real-item-xyz'\" /clusterio/logs 2>/dev/null | wc -l";
	return Number(execFileSync("docker", ["exec", "surface-export-host-1", "sh", "-c", command], { encoding: "utf8" }).trim() || 0);
}

const helper = String.raw`
storage.engine_repin_lab=storage.engine_repin_lab or {records={}}
__engine_repin_lab={}
function __engine_repin_lab.platform(name)
	local p=game.forces.player.create_space_platform{name=name,planet='nauvis',starter_pack='space-platform-starter-pack'}
	p.apply_starter_pack();p.paused=false;game.forces.player.set_surface_hidden(p.surface,false)
	storage.engine_repin_lab.records[name]={platform=p.index}
	return p
end
function __engine_repin_lab.platform_read(name,label)
	local p=nil;local count=0;for _,v in pairs(game.forces.player.platforms)do if v.valid then count=count+1 end;if v.valid and v.name==name then p=v end end
	return {label=label,tick=game.tick,game_paused=game.tick_paused==true,platform_paused=p and p.paused or nil,valid=p and p.valid or false,platform_count=count,index=p and p.index or nil}
end
function __engine_repin_lab.machine_read(surface,label)
	local machine=surface.find_entities_filtered{name='assembling-machine-3'}[1]
	local beacon=surface.find_entities_filtered{name='beacon'}[1]
	local inv=beacon and beacon.get_module_inventory()
	return {label=label,tick=game.tick,game_paused=game.tick_paused==true,platform_paused=nil,
		machine_valid=machine and machine.valid or false,crafting_speed=machine and machine.crafting_speed or nil,
		beacon_status=beacon and tostring(beacon.status) or nil,beacon_active=beacon and beacon.active or nil,
		module_count=inv and inv.get_item_count('speed-module-3') or 0}
end
return {success=true,tick=game.tick,base=script.active_mods.base}
`;

function install() { return { source: lua(source, helper), destination: lua(destination, helper) }; }

function runB7() {
	const variants = [];
	for (const variant of ["destroy()", "destroy(0)", "destroy(60)"]) {
		const name = `${prefix}b7-${variant.replace(/\W/g, "")}-${Date.now()}`;
		const setup = lua(source, `local p=__engine_repin_lab.platform('${name}');return {success=true,read=__engine_repin_lab.platform_read('${name}','before'),index=p.index}`);
		const action = variant === "destroy()" ? "p.destroy()" : variant === "destroy(0)" ? "p.destroy(0)" : "p.destroy(60)";
		const immediate = lua(source, `local p=nil;for _,v in pairs(game.forces.player.platforms)do if v.valid and v.name=='${name}'then p=v end end;local start=game.tick;storage.engine_repin_lab.b7=storage.engine_repin_lab.b7 or {};storage.engine_repin_lab.b7['${name}']={start=start,snapshots={}};local previous=script.get_event_handler(defines.events.on_tick);script.on_event(defines.events.on_tick,function(event)if previous then previous(event)end;local rec=storage.engine_repin_lab and storage.engine_repin_lab.b7 and storage.engine_repin_lab.b7['${name}'];if rec then local elapsed=event.tick-rec.start;if elapsed==1 or elapsed==61 or elapsed==120 then rec.snapshots[tostring(elapsed)]=__engine_repin_lab.platform_read('${name}','+'..tostring(elapsed))end;if elapsed>=120 then script.on_event(defines.events.on_tick,previous)end else script.on_event(defines.events.on_tick,previous)end end);local ok,err=pcall(function() ${action} end);return {success=true,call_ok=ok,call_error=ok and nil or tostring(err),start_tick=start,read=__engine_repin_lab.platform_read('${name}','same execution')}`);
		let snapshots = null;
		for (let attempt = 0; attempt < 40; attempt += 1) {
			sleep(100);
			const read = lua(source, `local rec=storage.engine_repin_lab and storage.engine_repin_lab.b7 and storage.engine_repin_lab.b7['${name}'];return {success=true,snapshots=rec and rec.snapshots or {},complete=rec and rec.snapshots['1']~=nil and rec.snapshots['61']~=nil and rec.snapshots['120']~=nil}`);
			if (read.complete) { snapshots = read.snapshots; break; }
		}
		if (!snapshots) throw new Error(`B7 exact snapshots timed out for ${variant}`);
		variants.push({ variant, prediction: "measure current-pin behavior; no behavior assumed", setup, immediate, after1: snapshots["1"], after61: snapshots["61"], after120: snapshots["120"] });
	}
	return { success: variants.every(v => v.immediate.call_ok), prediction: "open re-pin measurement", variants };
}

function makeBeaconCase(powered) {
	const name = `${prefix}b8-${powered ? "powered" : "unpowered"}-${Date.now()}`;
	const setup = lua(source, `
		local s=game.create_surface('${name}',{width=128,height=128});storage.engine_repin_lab.records['${name}']={surface=s.index}
		local machine=s.create_entity{name='assembling-machine-3',position={8,0},force=game.forces.player};machine.set_recipe('iron-gear-wheel')
		local beacon=s.create_entity{name='beacon',position={4,0},force=game.forces.player}
		${powered ? "s.create_entity{name='electric-energy-interface',position={0,4},force=game.forces.player};s.create_entity{name='substation',position={1,0},force=game.forces.player}" : ""}
		return {success=true,name='${name}',read=__engine_repin_lab.machine_read(s,'before module')}
	`);
	sleep(powered ? 500 : 50);
	const sameExecution = lua(source, `local s=game.surfaces['${name}'];local beacon=s.find_entities_filtered{name='beacon'}[1];local inv=beacon.get_module_inventory();local inserted=inv.insert{name='speed-module-3',count=2};return {success=true,inserted=inserted,read=__engine_repin_lab.machine_read(s,'same execution after populate')}`);
	sleep(100);
	const nextRead = lua(source, `return {success=true,read=__engine_repin_lab.machine_read(game.surfaces['${name}'],'first elapsed read')}`);
	const changedSameTick = sameExecution.read.crafting_speed > setup.read.crafting_speed;
	return { success: sameExecution.inserted === 2 && changedSameTick, powered, prediction: "crafting_speed updates in the module-population execution, without requiring power", setup, same_execution: sameExecution, next_read: nextRead, changed_same_execution: changedSameTick };
}

function runB8() {
	const powered = makeBeaconCase(true);
	const unpowered = makeBeaconCase(false);
	return { success: powered.success && unpowered.success, prediction: "immediate update with and without power", powered, unpowered };
}

function runB9() {
	const name = `${prefix}b9-${Date.now()}`;
	const setup = lua(source, `local s=game.create_surface('${name}',{width=64,height=64});storage.engine_repin_lab.records['${name}']={surface=s.index};return {success=true,tick=game.tick,surface=s.index}`);
	const warningsBefore = warningCount();
	const result = lua(source, `local payload={name='iron-chest',position={0,0},specific_data={inventories={{type='chest',items={{name='iron-plate',count=10,quality='normal'},{name='totally-not-a-real-item-xyz',count=5,quality='normal'}}}}}};local result=remote.call('surface_export','test_import_entity',payload,${setup.surface},{x=0,y=0});local s=game.surfaces[${setup.surface}];local chest=s.find_entities_filtered{name='iron-chest'}[1];return {success=true,tick=game.tick,game_paused=game.tick_paused==true,platform_paused=nil,remote_success=result.success,errors=result.errors,warnings=result.warnings,physical_iron_plate=chest and chest.get_item_count('iron-plate') or 0,unknown_prototype_exists=prototypes.item['totally-not-a-real-item-xyz']~=nil}`);
	sleep(100);
	const warningsAfter = warningCount();
	result.warning_log_before = warningsBefore;
	result.warning_log_after = warningsAfter;
	result.warning_logged = warningsAfter > warningsBefore;
	result.success = result.remote_success === true && result.physical_iron_plate === 10 && result.unknown_prototype_exists === false && result.warning_logged;
	result.prediction = "unknown item is skipped with warning while valid contents restore physically";
	return result;
}

function cleanup(instance) {
	return lua(instance, `local deleted={};for _,s in pairs(game.surfaces)do local p=s.platform;if string.find(s.name,'${prefix}',1,true)==1 or(p and p.valid and string.find(p.name,'${prefix}',1,true)==1)then deleted[#deleted+1]=s.name;game.delete_surface(s)end end;storage.engine_repin_lab=nil;__engine_repin_lab=nil;game.tick_paused=false;return {success=true,deleted=deleted,tick=game.tick,force_count=#game.forces}`);
}
function zero(instance) {
	return lua(instance, `local function count(t)local n=0 for _ in pairs(t or{})do n=n+1 end return n end;local surfaces,exports={},{};for _,s in pairs(game.surfaces)do local p=s.platform;if string.find(s.name,'${prefix}',1,true)==1 or(p and p.valid and string.find(p.name,'${prefix}',1,true)==1)then surfaces[#surfaces+1]=s.name end end;for id,r in pairs(storage.platform_exports or{})do if r and r.platform_name and string.find(r.platform_name,'${prefix}',1,true)==1 then exports[#exports+1]=id end end;return {success=true,tick=game.tick,zero_surfaces=#surfaces==0,surfaces=surfaces,zero_storage=storage.engine_repin_lab==nil,game_paused=game.tick_paused==true,destination_holds=count(storage.destination_holds),locked_platforms=count(storage.locked_platforms),committed_source_transfer_tombstones=count(storage.committed_source_transfer_tombstones),lab_platform_exports=#exports,force_count=#game.forces}`);
}
function cleanAll() {
	const cleanupResult = { source: cleanup(source), destination: cleanup(destination) };
	sleep(300);
	const z = { source: zero(source), destination: zero(destination) };
	const good = v => v.zero_surfaces && v.zero_storage && !v.game_paused && v.destination_holds === 0 && v.locked_platforms === 0 && v.committed_source_transfer_tombstones === 0 && v.lab_platform_exports === 0;
	return { cleanup: cleanupResult, zero: z, ok: good(z.source) && good(z.destination) };
}

function main() {
	const result = { script: "tests/engine-repin-lab/run-b7-b9.mjs", started: new Date().toISOString(), sections, predictions: { b7: "open re-pin", b8: "same-execution crafting_speed update without power dependency", b9: "unknown item skips with warning" }, rungs: {}, errors: [] };
	try {
		result.initial_reset = cleanAll();
		if (!result.initial_reset.ok) throw new Error(`initial cleanup failed ${JSON.stringify(result.initial_reset)}`);
		result.install = install();
		if (sections.includes("b7")) result.rungs.b7 = runB7();
		if (sections.includes("b8")) result.rungs.b8 = runB8();
		if (sections.includes("b9")) result.rungs.b9 = runB9();
		for (const [name, rung] of Object.entries(result.rungs)) if (!rung.success) throw new Error(`${name} failed ${JSON.stringify(rung)}`);
	} catch (error) { result.errors.push(error.stack || error.message); }
	finally {
		try { result.final_reset = cleanAll(); } catch (error) { result.errors.push(`cleanup failed: ${error.stack || error.message}`); }
		result.finished = new Date().toISOString();
		if (!noNotebook && !resetOnly) { mkdirSync("tests/engine-repin-lab", { recursive: true }); appendFileSync(notebook, `\n\n## ${result.finished} - LAB-I B7-B9 engine re-pin\n\nPredictions were recorded before execution: B7 open; B8 immediate/no-power; B9 graceful skip plus warning.\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`); }
		console.log(JSON.stringify(result, null, 2));
		if (result.errors.length || !result.final_reset?.ok) process.exitCode = 1;
	}
}

if (resetOnly) {
	const result = cleanAll();
	console.log(JSON.stringify(result, null, 2));
	if (!result.ok) process.exitCode = 1;
} else main();
