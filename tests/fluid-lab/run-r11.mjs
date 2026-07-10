#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const controller = "surface-export-controller";
const config = "/clusterio/tokens/config-control.json";
const source = "clusterio-host-1-instance-1";
const destination = "clusterio-host-2-instance-1";
const sourceContainer = "surface-export-host-1";
const destinationContainer = "surface-export-host-2";
const prefix = "fluid-lab-r11";
const notebook = "tests/fluid-lab/NOTEBOOK.md";
const allowedSections = ["r11a", "r11b", "r11c", "r11d"];
const epsilon = 1e-6;

let sections = [...allowedSections];
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
	const parsed = value.split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
	if (!parsed.length) throw new Error("--sections requires at least one section");
	for (const section of parsed) if (!allowedSections.includes(section)) throw new Error(`Unsupported R11 section '${section}'`);
	return parsed;
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function lastLine(value) { return String(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || ""; }
function luaString(value) { return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
function safeName(value) { return String(value).replace(/[^A-Za-z0-9_-]/g, "_"); }

function docker(container, args, options = {}) {
	return execFileSync("docker", ["exec", container, ...args], {
		encoding: "utf8", stdio: ["ignore", "pipe", options.stderr || "pipe"],
	}).trim();
}

function shell(container, command, options = {}) { return docker(container, ["sh", "-c", command], options); }
function rcon(instance, command) {
	return execFileSync("docker", ["exec", controller, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", instance, command, "--config", config],
	{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function lua(instance, body) {
	const command = `local ok,result=pcall(function() ${body} end); if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	const raw = lastLine(rcon(instance, `/sc ${command}`));
	try { return JSON.parse(raw); }
	catch (error) { throw new Error(`Invalid Lua JSON from ${instance}: ${raw}\n${error.message}`); }
}

function step(instance, ticks) { rcon(instance, `/step-tick ${ticks}`); }
function scriptOutput(instance) { return `/clusterio/data/instances/${instance}/script-output`; }
function debugFiles(container, instance, pattern) {
	return shell(container, `ls -1 ${scriptOutput(instance)}/${pattern} 2>/dev/null || true`, { stderr: "ignore" })
		.split(/\r?\n/).map(line => line.trim()).filter(Boolean).sort();
}
function readJson(container, path) { return JSON.parse(shell(container, `cat '${path.replace(/'/g, "'\\''")}'`)); }

function destinationId() {
	const output = docker(controller, ["sh", "-c", `npx clusterioctl --config ${config} instance list 2>/dev/null`]);
	for (const line of output.split(/\r?\n/)) {
		const match = line.match(/^\s*clusterio-host-2-instance-1\s*\|\s*(\d+)/);
		if (match) return Number(match[1]);
	}
	throw new Error(`Could not resolve destination instance id:\n${output}`);
}

const installLua = String.raw`
storage.fluid_lab = storage.fluid_lab or { records = {} }
__fluid_lab_r11 = {}
local force = game.forces.player
local candidates = { "water", "steam", "heavy-oil", "light-oil", "petroleum-gas", "crude-oil" }
local activatable = { ["assembling-machine"] = true, ["boiler"] = true, ["pump"] = true }

function __fluid_lab_r11.is_activatable(entity)
	return entity and entity.valid and activatable[entity.type] == true
end

function __fluid_lab_r11.foundation(surface, ox, oy)
	local tiles = {}
	for x = -14, 14 do for y = -12, 12 do tiles[#tiles + 1] = { name = "space-platform-foundation", position = { ox + x, oy + y } } end end
	surface.set_tiles(tiles, true, false, true, false)
end

function __fluid_lab_r11.make(name, paused)
	local platform = force.create_space_platform({ name = name, planet = "nauvis", starter_pack = "space-platform-starter-pack" })
	platform.apply_starter_pack()
	platform.paused = paused == true
	force.set_surface_hidden(platform.surface, false)
	local ox, oy = 100 + platform.index * 70, 100
	__fluid_lab_r11.foundation(platform.surface, ox, oy)
	storage.fluid_lab.records[name] = { platform_index = platform.index }
	return platform, platform.surface, ox, oy
end

function __fluid_lab_r11.find(name)
	for _, platform in pairs(force.platforms) do if platform.valid and platform.name == name then return platform end end
	return nil
end

function __fluid_lab_r11.frozen_value(entity)
	local ok, value = pcall(function() return entity.frozen end)
	if ok then return { ok = true, value = value } end
	return { ok = false, error = tostring(value) }
end

function __fluid_lab_r11.set_inactive(surface)
	local changed = 0
	for _, entity in pairs(surface.find_entities_filtered({})) do
		if __fluid_lab_r11.is_activatable(entity) then
			entity.active = false
			changed = changed + 1
		end
	end
	return changed
end

function __fluid_lab_r11.set_active(surface)
	local changed = 0
	for _, entity in pairs(surface.find_entities_filtered({})) do
		if __fluid_lab_r11.is_activatable(entity) then
			entity.active = true
			changed = changed + 1
		end
	end
	return changed
end

function __fluid_lab_r11.write_box(entity, index, amount)
	local attempts = {}
	for _, fluid in ipairs(candidates) do
		local ok, err = pcall(function() entity.fluidbox[index] = { name = fluid, amount = amount, temperature = fluid == "steam" and 165 or 25 } end)
		local direct = nil
		pcall(function() direct = entity.fluidbox[index] end)
		local attempt = { fluid = fluid, ok = ok, read = direct and { name = direct.name, amount = direct.amount, temperature = direct.temperature } or nil }
		if not ok then attempt.error = tostring(err) end
		attempts[#attempts + 1] = attempt
		if direct and direct.name == fluid and direct.amount > 0 then return { accepted = true, fluid = fluid, amount = direct.amount, attempts = attempts } end
	end
	return { accepted = false, attempts = attempts }
end

function __fluid_lab_r11.census(name, label)
	local platform = __fluid_lab_r11.find(name)
	if not platform then return { success = false, label = label, tick = game.tick, error = "platform not found" } end
	local totals, seen, boxes, states = {}, {}, {}, {}
	for _, entity in pairs(platform.surface.find_entities_filtered({})) do
		if entity.valid then
			if entity.fluidbox then
				for i = 1, #entity.fluidbox do
					local row = { entity = entity.name, type = entity.type, unit_number = entity.unit_number, index = i }
					local direct = entity.fluidbox[i]
					if direct then row.direct = { name = direct.name, amount = direct.amount, temperature = direct.temperature } end
					local ok_segment, segment_id = pcall(function() return entity.fluidbox.get_fluid_segment_id(i) end)
					if ok_segment then row.segment_id = segment_id else row.segment_error = tostring(segment_id) end
					if row.segment_id and not seen[row.segment_id] then
						seen[row.segment_id] = true
						local contents = entity.fluidbox.get_fluid_segment_contents(i)
						row.segment_contents = contents
						for fluid, amount in pairs(contents or {}) do totals[fluid] = (totals[fluid] or 0) + amount end
					elseif not row.segment_id and direct and direct.name then
						totals[direct.name] = (totals[direct.name] or 0) + direct.amount
					end
					boxes[#boxes + 1] = row
				end
			end
			if __fluid_lab_r11.is_activatable(entity) then
				states[#states + 1] = { entity = entity.name, unit_number = entity.unit_number, active = entity.active, frozen = __fluid_lab_r11.frozen_value(entity) }
			end
		end
	end
	return { success = true, label = label, tick = game.tick, game_paused = game.tick_paused == true,
		platform_paused = platform.paused == true, totals = totals, boxes = boxes, entity_states = states }
end

return { success = true, tick = game.tick, base = script.active_mods.base }
`;

function install() { return { source: lua(source, installLua), destination: lua(destination, installLua) }; }

function compare(expected, actual) {
	const names = [...new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})])].sort();
	const rows = names.map(name => ({ name, expected: Number(expected?.[name] || 0), actual: Number(actual?.[name] || 0), delta: Number(actual?.[name] || 0) - Number(expected?.[name] || 0) }));
	const nonzero = rows.filter(row => Math.abs(row.delta) > epsilon);
	const maxAbsDelta = Math.max(0, ...nonzero.map(row => Math.abs(row.delta)));
	return {
		exact: nonzero.length === 0, epsilon, max_abs_delta: maxAbsDelta,
		classification: nonzero.length === 0 ? "exact"
			: maxAbsDelta <= 0.01 ? "serializer_precision_candidate" : "engine_loss_or_gain_candidate",
		rows,
	};
}

function census(instance, name, label) { return lua(instance, `return __fluid_lab_r11.census('${luaString(name)}','${luaString(label)}')`); }

function makeR11a(name, machines) {
	return lua(source, `
		local F = __fluid_lab_r11
		local p, s, ox, oy = F.make('${luaString(name)}', true)
		local tank = s.create_entity({ name = 'storage-tank', position = { ox - 5, oy }, force = game.forces.player })
		s.create_entity({ name = 'pipe', position = { ox - 3, oy + 1 }, force = game.forces.player })
		s.create_entity({ name = 'pipe', position = { ox - 2, oy + 1 }, force = game.forces.player })
		local member = s.create_entity({ name = 'pipe', position = { ox - 3, oy }, force = game.forces.player })
		${machines ? "s.create_entity({ name = 'pump', position = { ox - 1, oy }, direction = defines.direction.east, force = game.forces.player }); s.create_entity({name='pipe',position={ox,oy},force=game.forces.player}); local plant=s.create_entity({name='chemical-plant',position={ox+5,oy},force=game.forces.player}); plant.set_recipe('heavy-oil-cracking')" : ""}
		F.set_inactive(s)
		local tank_segment = tank.fluidbox.get_fluid_segment_id(1)
		local member_segment = member.fluidbox.get_fluid_segment_id(1)
		local write_ok, write_err = pcall(function() member.fluidbox[1] = { name = 'water', amount = 2000, temperature = 25 } end)
		local contents = member.fluidbox.get_fluid_segment_contents(1)
		local inserted = contents and contents.water or 0
		local read = F.census('${luaString(name)}','same-tick frozen')
		local result = { success = write_ok and inserted >= 1999 and tank_segment ~= nil and tank_segment == member_segment,
			inserted = inserted, tank_segment = tank_segment,
			member_segment = member_segment, shared_segment = tank_segment ~= nil and tank_segment == member_segment,
			platform = p.index, read = read }
		if not write_ok then result.write_error = tostring(write_err) end
		return result
	`);
}

function runR11a() {
	const cases = [];
	for (const machines of [false, true]) {
		const name = `${prefix}-a-${machines ? "machines" : "control"}-${Date.now()}`;
		const setup = makeR11a(name, machines);
		if (!setup.success) throw new Error(`R11a write rejected: ${JSON.stringify(setup)}`);
		const before = setup.read;
		const activation = lua(source, `local p=__fluid_lab_r11.find('${luaString(name)}'); local changed=__fluid_lab_r11.set_active(p.surface); p.paused=false; return {success=true,tick=game.tick,changed=changed,read=__fluid_lab_r11.census('${luaString(name)}','activation same tick')}`);
		step(source, 60);
		const after = census(source, name, "activation +60");
		const activationCompare = compare(before.totals, activation.read.totals);
		const afterCompare = compare(before.totals, after.totals);
		cases.push({ machines, name, setup, activation, after, activation_compare: activationCompare, after_compare: afterCompare });
		if (!activationCompare.exact || !afterCompare.exact) throw new Error(`R11a nonzero delta: ${JSON.stringify(cases.at(-1))}`);
	}
	return { success: true, prediction: "zero loss and zero gain", cases };
}

function runR11b() {
	const name = `${prefix}-b-${Date.now()}`;
	const setup = lua(source, `
		local F=__fluid_lab_r11; local p,s,ox,oy=F.make('${luaString(name)}',true)
		local tank=s.create_entity({name='storage-tank',position={ox-5,oy},force=game.forces.player})
		s.create_entity({name='pipe',position={ox-3,oy+1},force=game.forces.player}); s.create_entity({name='pipe',position={ox-2,oy+1},force=game.forces.player}); s.create_entity({name='pipe',position={ox-3,oy},force=game.forces.player})
		local pump=s.create_entity({name='pump',position={ox-1,oy},direction=defines.direction.east,force=game.forces.player}); s.create_entity({name='pipe',position={ox,oy},force=game.forces.player})
		local plant=s.create_entity({name='chemical-plant',position={ox+5,oy},force=game.forces.player}); plant.set_recipe('heavy-oil-cracking')
		local boiler=s.create_entity({name='boiler',position={ox+10,oy},direction=defines.direction.east,force=game.forces.player})
		F.set_inactive(s)
		local writes={}; local entities={tank,pump,plant,boiler}
		for _,e in ipairs(entities) do for i=1,#e.fluidbox do local w=F.write_box(e,i,100); writes[#writes+1]={entity=e.name,index=i,write=w} end end
		local accepted=true; for _,row in ipairs(writes) do if not row.write.accepted then accepted=false end end
		return {success=accepted,platform=p.index,writes=writes,read=F.census('${luaString(name)}','R11b frozen same tick')}
	`);
	if (!setup.success) throw new Error(`R11b rejected a fluidbox write: ${JSON.stringify(setup)}`);
	const activation = lua(source, `local p=__fluid_lab_r11.find('${luaString(name)}'); local changed=__fluid_lab_r11.set_active(p.surface); p.paused=false; return {success=true,tick=game.tick,changed=changed,read=__fluid_lab_r11.census('${luaString(name)}','R11b activation same tick')}`);
	step(source, 60);
	const after = census(source, name, "R11b activation +60");
	const immediate = compare(setup.read.totals, activation.read.totals);
	const settled = compare(setup.read.totals, after.totals);
	if (!immediate.exact || !settled.exact) throw new Error(`R11b nonzero delta: ${JSON.stringify({ immediate, settled })}`);
	return { success: true, prediction: "zero loss and zero gain", name, setup, activation, after, immediate_compare: immediate, settled_compare: settled };
}

function runR11c() {
	const name = `${prefix}-c-${Date.now()}`;
	const result = lua(source, `
		local F=__fluid_lab_r11; local p,s,ox,oy=F.make('${luaString(name)}',true)
		local specs={{name='pipe',x=-8},{name='storage-tank',x=-5},{name='pump',x=-1,direction=defines.direction.east},{name='chemical-plant',x=4,recipe='heavy-oil-cracking'},{name='boiler',x=10,direction=defines.direction.east}}
		local rows={}
		for _,spec in ipairs(specs) do
			local e=s.create_entity({name=spec.name,position={ox+spec.x,oy},direction=spec.direction,force=game.forces.player})
			if spec.recipe then e.set_recipe(spec.recipe) end
			local activatable=F.is_activatable(e)
			if activatable then e.active=false end
			local before={active=activatable and e.active or nil,frozen=F.frozen_value(e),tick=game.tick}
			local writes={}; local accepted=true; local fallback_used=false
			for i=1,#e.fluidbox do
				local write=F.write_box(e,i,50)
				if not write.accepted and activatable then e.active=true; write=F.write_box(e,i,50); e.active=false; fallback_used=true end
				if not write.accepted then accepted=false end
				writes[#writes+1]={index=i,write=write}
			end
			rows[#rows+1]={name=e.name,type=e.type,activatable=activatable,before=before,writes=writes,accepted=accepted,fallback_used=fallback_used,after={active=activatable and e.active or nil,frozen=F.frozen_value(e),tick=game.tick}}
		end
		return {success=true,platform=p.index,rows=rows,read=F.census('${luaString(name)}','R11c before first activation')}
	`);
	for (const row of result.rows) if (!row.accepted) throw new Error(`R11c class rejected pre-activation write: ${JSON.stringify(row)}`);
	const activation = lua(source, `local p=__fluid_lab_r11.find('${luaString(name)}'); local changed=__fluid_lab_r11.set_active(p.surface); p.paused=false; return {success=true,tick=game.tick,changed=changed,read=__fluid_lab_r11.census('${luaString(name)}','R11c activation same tick')}`);
	step(source, 60);
	const after = census(source, name, "R11c activation +60");
	const immediate = compare(result.read.totals, activation.read.totals);
	const settled = compare(result.read.totals, after.totals);
	if (!immediate.exact || !settled.exact) throw new Error(`R11c nonzero delta: ${JSON.stringify({ immediate, settled, rows: result.rows })}`);
	return { success: true, prediction: "zero loss and zero gain", name,
		import_state_replication: {
			entity_creation: "module/import_phases/entity_creation.lua:69 creates through Deserializer; lines 78-91 immediately set active=false for transfer entities",
			platform_pause: "module/core/import-pipeline.lua:240-245 pauses the transfer platform immediately after creation",
		},
		setup: result, activation, after, immediate_compare: immediate, settled_compare: settled };
}

function waitPlatform(instance, name, timeoutMs = 180000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = lua(instance, `local p=__fluid_lab_r11.find('${luaString(name)}'); return {success=true,index=p and p.index or nil}`);
		if (found.index) return found.index;
		sleep(1000);
	}
	throw new Error(`Platform ${name} did not materialize`);
}

function waitImportResult(name, timeoutMs = 240000) {
	const safe = safeName(name);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const files = debugFiles(destinationContainer, destination, `debug_import_result_${safe}_*.json`);
		if (files.length) {
			sleep(2500);
			const latest = debugFiles(destinationContainer, destination, `debug_import_result_${safe}_*.json`).at(-1);
			const raw = readJson(destinationContainer, latest);
			if (raw?.validation_result?.r11FrozenFluidMeasurement) return { file: latest, raw };
		}
		sleep(1500);
	}
	throw new Error(`No R11 measurement debug result for ${name}`);
}

function hookLogEvidence(name) {
	const path = `/clusterio/data/instances/${destination}/factorio-current.log`;
	const needle = `[Import][TEST][R11] Frozen fluid injection measured for ${name}`;
	const escaped = needle.replace(/'/g, "'\\''");
	const output = shell(destinationContainer, `grep -F '${escaped}' '${path}' 2>/dev/null | tail -1 || true`, { stderr: "ignore" });
	return { needle, found: output.includes(needle), line: output };
}

function runR11d() {
	const name = `${prefix}-d-${Date.now()}`;
	const seed = lua(source, `local found=nil; local count=0; for i,p in pairs(game.forces.player.platforms) do if p.valid and p.name=='test' then found=i; count=count+1 end end; return {success=count==1,index=found,count=count}`);
	if (!seed.success) throw new Error(`Expected one seed platform named test: ${JSON.stringify(seed)}`);
	const clone = lua(source, `local raw=remote.call('surface_export','clone_platform',${seed.index},'${luaString(name)}'); return {success=true,tick=game.tick,remote=raw}`);
	const cloneIndex = waitPlatform(source, name);
	for (const [container, instance] of [[sourceContainer, source], [destinationContainer, destination]]) {
		shell(container, `rm -f ${scriptOutput(instance)}/debug_*${safeName(name)}_*.json 2>/dev/null || true`, { stderr: "ignore" });
	}
	const armed = lua(destination, `remote.call('surface_export','configure',{debug_mode=true,test_measure_frozen_fluid_injection={platform_name='${luaString(name)}'}}); return {success=true,tick=game.tick}`);
	const transferStarted = Date.now();
	const transferOutput = rcon(source, `/transfer-platform ${cloneIndex} ${destinationId()}`);
	const debug = waitImportResult(name);
	const measurement = debug.raw.validation_result.r11FrozenFluidMeasurement;
	const logEvidence = hookLogEvidence(name);
	if (measurement.hook_consumed !== true || !logEvidence.found) {
		throw new Error(`R11d hook-fire proof missing: ${JSON.stringify({ measurement, logEvidence })}`);
	}
	const frozen = compare(measurement.expected_by_name, measurement.frozen_actual_by_name);
	const activated = compare(measurement.expected_by_name, measurement.post_activation_actual_by_name);
	if (!frozen.exact || !activated.exact) throw new Error(`R11d nonzero delta: ${JSON.stringify({ measurement, frozen, activated })}`);
	return { success: true, prediction: "zero loss and zero gain", name, seed, clone, clone_index: cloneIndex, armed,
		transfer_output: transferOutput, wall_ms: Date.now() - transferStarted, debug_file: debug.file,
		validation_success: debug.raw.validation_success, failed_stage: debug.raw.validation_result.failedStage || null,
		hook_log: logEvidence, measurement, frozen_compare: frozen, post_activation_compare: activated };
}

function matchingJobs(instance) {
	return lua(instance, `local rows={}; for id,job in pairs(storage.async_jobs or {}) do local name=job and job.platform_name; if type(name)=='string' and string.find(name,'${prefix}',1,true)==1 then rows[#rows+1]={id=id,name=name} end end; return {success=true,jobs=rows}`);
}

function cleanupInstance(instance) {
	return lua(instance, `
		if storage.surface_export_config then storage.surface_export_config.test_measure_frozen_fluid_injection=nil end
		local deleted={}
		for _,surface in pairs(game.surfaces) do local p=surface.platform; if p and p.valid and string.find(p.name,'${prefix}',1,true)==1 then deleted[#deleted+1]=p.name; game.delete_surface(surface) end end
		for id,record in pairs(storage.platform_exports or {}) do local name=record and record.platform_name; if type(name)=='string' and string.find(name,'${prefix}',1,true)==1 then storage.platform_exports[id]=nil end end
		storage.fluid_lab=nil; __fluid_lab_r11=nil; game.tick_paused=false
		return {success=true,deleted=deleted,tick=game.tick}
	`);
}

function zeroCheck(instance) {
	return lua(instance, `
		local function count(t) local n=0 for _,_ in pairs(t or {}) do n=n+1 end return n end
		local surfaces,exports={},{}
		for _,surface in pairs(game.surfaces) do local p=surface.platform; if p and p.valid and string.find(p.name,'${prefix}',1,true)==1 then surfaces[#surfaces+1]=p.name end end
		for id,record in pairs(storage.platform_exports or {}) do local name=record and record.platform_name; if type(name)=='string' and string.find(name,'${prefix}',1,true)==1 then exports[#exports+1]=id end end
		return {success=true,tick=game.tick,zero_surfaces=#surfaces==0,surfaces=surfaces,zero_storage=storage.fluid_lab==nil,game_paused=game.tick_paused==true,
			destination_holds=count(storage.destination_holds),locked_platforms=count(storage.locked_platforms),committed_source_transfer_tombstones=count(storage.committed_source_transfer_tombstones),lab_platform_exports=#exports}
	`);
}

function zeroOk(value) {
	return value.zero_surfaces && value.zero_storage && !value.game_paused && value.destination_holds === 0
		&& value.locked_platforms === 0 && value.committed_source_transfer_tombstones === 0 && value.lab_platform_exports === 0;
}

function cleanupAll() {
	const deadline = Date.now() + 240000;
	while (Date.now() < deadline) {
		const jobs = { source: matchingJobs(source), destination: matchingJobs(destination) };
		if (!jobs.source.jobs.length && !jobs.destination.jobs.length) break;
		sleep(1000);
	}
	const cleanup = { source: cleanupInstance(source), destination: cleanupInstance(destination) };
	step(source, 5); step(destination, 5);
	const zero = { source: zeroCheck(source), destination: zeroCheck(destination) };
	return { cleanup, zero, ok: zeroOk(zero.source) && zeroOk(zero.destination) };
}

async function main() {
	const results = { script: "tests/fluid-lab/run-r11.mjs", started: new Date().toISOString(), sections,
		prediction: "ZERO fluid loss and ZERO fluid gain at every R11 rung", epsilon, rungs: {}, errors: [] };
	try {
		results.initial_reset = cleanupAll();
		if (!results.initial_reset.ok) throw new Error(`Initial cleanup failed: ${JSON.stringify(results.initial_reset)}`);
		results.install = install();
		if (sections.includes("r11a")) results.rungs.r11a = runR11a();
		if (sections.includes("r11b")) results.rungs.r11b = runR11b();
		if (sections.includes("r11c")) results.rungs.r11c = runR11c();
		if (sections.includes("r11d")) results.rungs.r11d = runR11d();
	} catch (error) {
		results.errors.push(error.stack || error.message);
	} finally {
		try { results.final_reset = cleanupAll(); }
		catch (error) { results.errors.push(`Cleanup failed: ${error.stack || error.message}`); }
		results.finished = new Date().toISOString();
		if (!noNotebook && !resetOnly) appendFileSync(notebook, `\n\n## ${results.finished} - R11 frozen-injection lab (sections=${sections.join(",")})\n\nPrediction: **zero fluid loss and zero fluid gain at every rung**.\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n`);
		console.log(JSON.stringify(results, null, 2));
		if (results.errors.length || !results.final_reset?.ok) process.exitCode = 1;
	}
}

if (resetOnly) {
	const result = cleanupAll(); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
} else await main();
