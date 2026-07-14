#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { parseSections, validateEvidence } from "./reachability-contract.mjs";

const controller = "surface-export-controller";
const instances = ["clusterio-host-1-instance-1", "clusterio-host-2-instance-1"];
const source = instances[0];
const prefix = "specialized-reachability-lab-";
const notebook = "tests/specialized-inventory-lab/NOTEBOOK.md";
let sections = ["prototype", "placement"];
let resetOnly = false;
let noNotebook = false;

for (let index = 2; index < process.argv.length; index += 1) {
	const arg = process.argv[index];
	if (arg === "--reset") resetOnly = true;
	else if (arg === "--no-notebook") noNotebook = true;
	else if (arg === "--sections") sections = parseSections(process.argv[++index] || "");
	else if (arg.startsWith("--sections=")) sections = parseSections(arg.slice(11));
	else throw new Error(`Unknown argument: ${arg}`);
}

function lastLine(value) {
	return String(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || "";
}

function rcon(instance, command) {
	return execFileSync("docker", [
		"exec", controller, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", instance, command,
		"--config", "/clusterio/tokens/config-control.json",
	], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function lua(instance, body) {
	const wrapped = `local ok,result=pcall(function() ${body} end);if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	return JSON.parse(lastLine(rcon(instance, `/sc ${wrapped}`)));
}

const ensurePlatformLua = `
local force=game.forces.player
local platform=nil
for _,candidate in pairs(force.platforms) do
	if candidate.valid and string.find(candidate.name,"${prefix}",1,true)==1 then platform=candidate;break end
end
if not platform then
	platform=force.create_space_platform{name="${prefix}"..tostring(game.tick),planet="nauvis",starter_pack="space-platform-starter-pack"}
	platform.apply_starter_pack()
end
platform.paused=true
storage.specialized_reachability_lab={platform_name=platform.name,platform_index=platform.index}
return platform
`;

const prototypeLua = `
local platform=(function() ${ensurePlatformLua} end)()
local surface=platform.surface
local force=game.forces.player
local names={"chemical-plant","storage-tank","pump","flamethrower-turret","fluid-wagon","electric-mining-drill"}
local entities={}
for _,name in ipairs(names) do
	local proto=prototypes.entity[name]
	if not proto then error("missing prototype "..name) end
	local conditions={}
	for _,condition in ipairs(proto.surface_conditions or {}) do
		local actual=surface.get_property(condition.property)
		conditions[#conditions+1]={property=condition.property,min=condition.min,max=condition.max,actual=actual,passes=actual>=condition.min and actual<=condition.max}
	end
	local position=surface.find_non_colliding_position(name,{x=0,y=0},64,0.5)
	local can_place=position~=nil and surface.can_place_entity{name=name,position=position,force=force} or false
	entities[name]={fluidbox_count=#(proto.fluidbox_prototypes or {}),can_place=can_place,position=position,surface_conditions=conditions}
end
return {success=true,pin=script.active_mods.base,tick=game.tick,game_paused=game.tick_paused==true,platform_paused=platform.paused,platform={name=platform.name,index=platform.index,pressure=surface.get_property("pressure"),gravity=surface.get_property("gravity")},entities=entities}
`;

const placementLua = `
local platform=(function() ${ensurePlatformLua} end)()
local surface=platform.surface
local force=game.forces.player
local position=surface.find_non_colliding_position("electric-mining-drill",{x=0,y=0},64,0.5)
if not position then error("no platform position for electric-mining-drill") end
local can_place=surface.can_place_entity{name="electric-mining-drill",position=position,force=force}
local drill=surface.create_entity{name="electric-mining-drill",position=position,force=force,create_build_effect_smoke=false}
if not (drill and drill.valid) then error("electric-mining-drill creation failed") end
local read_ok,read_value=pcall(function() return drill.fluidbox[1] end)
local write_ok,write_error=pcall(function() drill.fluidbox[1]={name="water",amount=1} end)
local result={success=true,pin=script.active_mods.base,tick=game.tick,game_paused=game.tick_paused==true,platform_paused=platform.paused,drill={created=true,can_place=can_place,position=position,mining_target=drill.mining_target and drill.mining_target.name or nil,live_fluidbox_count=#drill.fluidbox,read_ok=read_ok,read_value=read_ok and read_value or nil,read_error=read_ok and nil or tostring(read_value),write_ok=write_ok,write_error=write_ok and nil or tostring(write_error)}}
drill.destroy()
return result
`;

const cleanupLua = `
local deleted={}
for _,surface in pairs(game.surfaces) do
	local platform=surface.platform
	if platform and platform.valid and string.find(platform.name,"${prefix}",1,true)==1 then
		deleted[#deleted+1]=platform.name
		game.delete_surface(surface)
	end
end
storage.specialized_reachability_lab=nil
game.tick_paused = false
return {success=true,tick=game.tick,deleted=deleted}
`;

const zeroLua = `
local function count(value)local n=0 for _ in pairs(value or {}) do n=n+1 end return n end
local surfaces={}
for _,surface in pairs(game.surfaces) do
	local platform=surface.platform
	if platform and platform.valid and string.find(platform.name,"${prefix}",1,true)==1 then surfaces[#surfaces+1]=platform.name end
end
return {success=true,tick=game.tick,lab_surfaces=surfaces,lab_storage=storage.specialized_reachability_lab~=nil,game_paused=game.tick_paused==true,destination_holds=count(storage.destination_holds),locked_platforms=count(storage.locked_platforms),async_jobs=count(storage.async_jobs),committed_source_tombstones=count(storage.committed_source_tombstones)}
`;

function cleanupBoth() {
	const cleanup = {};
	for (const instance of instances) cleanup[instance] = { action: lua(instance, cleanupLua), zero: lua(instance, zeroLua) };
	return cleanup;
}

function assertZero(cleanup) {
	for (const [instance, result] of Object.entries(cleanup)) {
		const zero = result.zero;
		if (zero.lab_surfaces.length || zero.lab_storage || zero.game_paused
			|| zero.destination_holds || zero.locked_platforms || zero.async_jobs || zero.committed_source_tombstones) {
			throw new Error(`${instance} cleanup incomplete: ${JSON.stringify(zero)}`);
		}
	}
}

if (resetOnly) {
	const cleanup = cleanupBoth();
	console.log(JSON.stringify(cleanup, null, 2));
	assertZero(cleanup);
	process.exit();
}

const result = {
	script: "tests/specialized-inventory-lab/run-reachability.mjs",
	prediction: "Factorio 2.0.77 reproduces the final PR #98 reachability classification without transfer activity",
	sections, started: new Date().toISOString(), prototype: null, placement: null,
	contract_failures: [], cleanup: null, errors: [],
};

try {
	cleanupBoth();
	if (sections.includes("prototype")) result.prototype = lua(source, prototypeLua);
	if (sections.includes("placement")) result.placement = lua(source, placementLua);
	if (sections.length === 2) result.contract_failures = validateEvidence(result);
} catch (error) {
	result.errors.push(error.stack || error.message);
} finally {
	try {
		result.cleanup = cleanupBoth();
		assertZero(result.cleanup);
	} catch (error) {
		result.errors.push(error.stack || error.message);
	}
	result.finished = new Date().toISOString();
	if (!noNotebook) appendFileSync(notebook, `\n\n## ${result.finished} - Reachability recertification\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
	console.log(JSON.stringify(result, null, 2));
	if (result.errors.length || result.contract_failures.length) process.exitCode = 1;
}
