#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";

const controller = "surface-export-controller";
const controlConfig = "/clusterio/tokens/config-control.json";
const sourceInstance = "clusterio-host-1-instance-1";
const destInstance = "clusterio-host-2-instance-1";
const sourceContainer = "surface-export-host-1";
const destContainer = "surface-export-host-2";
const fixturePrefix = "gate-drift-a";
const notebook = "tests/gate-drift-lab/NOTEBOOK.md";
const allowedSections = ["control", "freeze0", "fluidflow", "beltflow"];
const defaultSections = ["control", "freeze0", "fluidflow", "beltflow"];

const args = process.argv.slice(2);
let sections = [...defaultSections];
let resetOnly = false;
let noNotebook = false;
for (let i = 0; i < args.length; i += 1) {
	const arg = args[i];
	if (arg === "--reset") resetOnly = true;
	else if (arg === "--no-notebook") noNotebook = true;
	else if (arg === "--sections") sections = parseSections(args[++i] || "");
	else if (arg.startsWith("--sections=")) sections = parseSections(arg.slice("--sections=".length));
	else throw new Error(`Unknown argument: ${arg}`);
}

function parseSections(value) {
	const parsed = value.split(",").map(part => part.trim().toLowerCase()).filter(Boolean);
	if (!parsed.length) throw new Error("--sections requires at least one section");
	for (const section of parsed) {
		if (!allowedSections.includes(section)) throw new Error(`Unsupported LAB-A section '${section}'`);
	}
	return [...new Set(parsed)].sort((a, b) => defaultSections.indexOf(a) - defaultSections.indexOf(b));
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function dockerExec(container, argv, options = {}) {
	return execFileSync("docker", ["exec", container, ...argv], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", options.stderr ?? "pipe"],
	}).trim();
}

function sh(container, command, options = {}) {
	return dockerExec(container, ["sh", "-c", command], options);
}

function rcon(instance, command) {
	return execFileSync("docker", [
		"exec", controller,
		"npx", "clusterioctl",
		"--config", controlConfig,
		"--log-level", "error",
		"instance", "send-rcon", instance, command,
	], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function lastLine(text) {
	return String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || "";
}

function lua(instance, body) {
	const wrapped = [
		"local ok,result=pcall(function()", body, "end);",
		"if ok then rcon.print(helpers.table_to_json(result))",
		"else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end",
	].join(" ");
	const raw = lastLine(rcon(instance, `/sc ${wrapped}`));
	try {
		const result = JSON.parse(raw);
		if (result?.success === false) throw new Error(`Lua failed on ${instance}: ${result.error}`);
		return result;
	} catch (error) {
		if (error.message.startsWith("Lua failed")) throw error;
		throw new Error(`Failed to parse Lua JSON from ${instance}: ${raw}\n${error.stack || error.message}`);
	}
}

function luaString(value) {
	return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function configureSource(batchSize = 1) {
	rcon(sourceInstance, "/export-sync-mode off");
	return lua(sourceInstance, `
		remote.call("surface_export", "configure", { debug_mode = true, batch_size = ${batchSize}, show_progress = false })
		return { success = true, tick = game.tick, batch_size = ${batchSize} }
	`);
}

const installLua = String.raw`
storage.gate_drift_lab = storage.gate_drift_lab or { records = {} }
__gate_drift_a = {}
local force = game.forces.player

function __gate_drift_a.require_entity(entity, label)
	if not (entity and entity.valid) then error("failed to create " .. label) end
	return entity
end

function __gate_drift_a.add_foundation(surface, ox, oy)
	local tiles = {}
	for x = -24, 24 do
		for y = -18, 18 do
			tiles[#tiles + 1] = { name = "space-platform-foundation", position = { ox + x, oy + y } }
		end
	end
	surface.set_tiles(tiles, true, false, true, false)
end

function __gate_drift_a.clear_hub(platform)
	local inventory = platform.hub and platform.hub.get_inventory(defines.inventory.hub_main)
	if inventory then inventory.clear() end
end

function __gate_drift_a.add_fillers(surface, ox, oy)
	local created = 0
	for row = 0, 6 do
		for col = 0, 19 do
			__gate_drift_a.require_entity(surface.create_entity({
				name = "iron-chest",
				position = { ox - 20 + col, oy - 16 + row },
				force = force,
			}), "filler chest")
			created = created + 1
		end
	end
	return created
end

function __gate_drift_a.add_static_belt(surface, ox, oy)
	local belt = __gate_drift_a.require_entity(surface.create_entity({
		name = "transport-belt", position = { ox + 14, oy + 10 },
		direction = defines.direction.east, force = force,
	}), "static belt")
	local inserted = 0
	for line_index = 1, belt.get_max_transport_line_index() do
		local line = belt.get_transport_line(line_index)
		if line and line.insert_at(0.1, { name = "iron-plate", count = 1 }) then inserted = inserted + 1 end
	end
	if inserted == 0 then error("static belt accepted no iron plates") end
	return inserted
end

function __gate_drift_a.add_belt_loop(surface, ox, oy)
	local belts = {}
	local function belt(x, y, direction)
		belts[#belts + 1] = __gate_drift_a.require_entity(surface.create_entity({
			name = "transport-belt", position = { ox + x, oy + y }, direction = direction, force = force,
		}), "belt loop entity")
	end
	for x = -10, 9 do belt(x, -9, defines.direction.east) end
	for y = -9, 8 do belt(10, y, defines.direction.south) end
	for x = 10, -9, -1 do belt(x, 9, defines.direction.west) end
	for y = 9, -8, -1 do belt(-10, y, defines.direction.north) end
	local inserted = 0
	for i = 1, #belts, 4 do
		local line = belts[i].get_transport_line(1)
		if line and line.insert_at(0.35, { name = "iron-plate", count = 1 }) then inserted = inserted + 1 end
	end
	if inserted < 4 then error("belt loop accepted too few iron plates: " .. tostring(inserted)) end
	return #belts, inserted
end

function __gate_drift_a.add_fluid_flow(surface, ox, oy)
	local source_tank = __gate_drift_a.require_entity(surface.create_entity({ name = "storage-tank", position = { ox - 4, oy }, force = force }), "source tank")
	__gate_drift_a.require_entity(surface.create_entity({ name = "pipe", position = { ox - 2, oy + 1 }, force = force }), "source corner pipe")
	__gate_drift_a.require_entity(surface.create_entity({ name = "pipe", position = { ox - 1, oy + 1 }, force = force }), "source elbow pipe")
	local input_pipe = __gate_drift_a.require_entity(surface.create_entity({ name = "pipe", position = { ox - 2, oy }, force = force }), "pump input pipe")
	local pump = __gate_drift_a.require_entity(surface.create_entity({ name = "pump", position = { ox, oy }, direction = defines.direction.east, force = force }), "pump")
	local output_pipe = __gate_drift_a.require_entity(surface.create_entity({ name = "pipe", position = { ox + 1, oy }, force = force }), "pump output pipe")
	__gate_drift_a.require_entity(surface.create_entity({ name = "pipe", position = { ox + 1, oy - 1 }, force = force }), "destination elbow pipe")
	__gate_drift_a.require_entity(surface.create_entity({ name = "pipe", position = { ox + 2, oy - 1 }, force = force }), "destination corner pipe")
	local dest_tank = __gate_drift_a.require_entity(surface.create_entity({ name = "storage-tank", position = { ox + 4, oy }, force = force }), "destination tank")
	local substation = __gate_drift_a.require_entity(surface.create_entity({ name = "substation", position = { ox, oy + 5 }, force = force }), "substation")
	local panels = {
		__gate_drift_a.require_entity(surface.create_entity({ name = "solar-panel", position = { ox - 6, oy + 7 }, force = force }), "solar panel 1"),
		__gate_drift_a.require_entity(surface.create_entity({ name = "solar-panel", position = { ox - 2, oy + 9 }, force = force }), "solar panel 2"),
		__gate_drift_a.require_entity(surface.create_entity({ name = "solar-panel", position = { ox + 2, oy + 9 }, force = force }), "solar panel 3"),
		__gate_drift_a.require_entity(surface.create_entity({ name = "solar-panel", position = { ox + 6, oy + 7 }, force = force }), "solar panel 4"),
	}
	local inserted = source_tank.insert_fluid({ name = "water", amount = 20000, temperature = 25 })
	if inserted < 19999 then error("source tank fluid write rejected: " .. tostring(inserted)) end
	return {
		source_tank = source_tank.unit_number,
		input_pipe = input_pipe.unit_number,
		pump = pump.unit_number,
		output_pipe = output_pipe.unit_number,
		dest_tank = dest_tank.unit_number,
		substation = substation.unit_number,
		panel_count = #panels,
		inserted = inserted,
	}
end

return { success = true, stage = "fixture-builders", tick = game.tick, version = script.active_mods.base }
`;
const installReadLua = String.raw`
local force = game.forces.player
function __gate_drift_a.find_platform(name)
	for _, platform in pairs(force.platforms) do
		if platform.valid and platform.name == name then return platform end
	end
	return nil
end

function __gate_drift_a.census(name, label)
	local platform = __gate_drift_a.find_platform(name)
	if not platform then return { success = false, error = "platform not found", name = name, tick = game.tick } end
	local surface = platform.surface
	local fluid_by_name, item_by_name = {}, { ["iron-plate"] = 0 }
	local seen_segments, fluidboxes = {}, {}
	local belt_unique, belt_rows, belt_signature_parts, seen_belt_stacks = 0, {}, {}, {}
	local segment_ids = {}
	local pump_rows = {}
	for _, entity in ipairs(surface.find_entities_filtered({})) do
		if entity.valid then
			local item_count = entity.get_item_count("iron-plate")
			if item_count > 0 then item_by_name["iron-plate"] = item_by_name["iron-plate"] + item_count end
			if entity.fluidbox then
				for box_index = 1, #entity.fluidbox do
					local row = { entity = entity.name, unit_number = entity.unit_number, box = box_index, position = { x = entity.position.x, y = entity.position.y }, direction = entity.direction }
					local direct = entity.fluidbox[box_index]
					if direct then row.direct = { name = direct.name, amount = direct.amount, temperature = direct.temperature } end
					local segment_id = entity.fluidbox.get_fluid_segment_id(box_index)
					row.segment_id = segment_id
					if segment_id then
						segment_ids[tostring(segment_id)] = true
						if not seen_segments[segment_id] then
							seen_segments[segment_id] = true
							local contents = entity.fluidbox.get_fluid_segment_contents(box_index) or {}
							row.segment_contents = contents
							for fluid_name, amount in pairs(contents) do fluid_by_name[fluid_name] = (fluid_by_name[fluid_name] or 0) + amount end
						end
					elseif direct and direct.name and direct.amount > 0 then
						fluid_by_name[direct.name] = (fluid_by_name[direct.name] or 0) + direct.amount
					end
					fluidboxes[#fluidboxes + 1] = row
				end
			end
			if entity.type == "pump" then
				local status_name = nil
				for name, value in pairs(defines.entity_status) do
					if value == entity.status then status_name = name; break end
				end
				local connections = {}
				for _, connection in ipairs(entity.fluidbox.get_pipe_connections(1)) do
					connections[#connections + 1] = {
						flow_direction = connection.flow_direction,
						connection_type = connection.connection_type,
						position = connection.position,
						target_position = connection.target_position,
						target_connected = connection.target ~= nil,
						target_fluidbox_index = connection.target_fluidbox_index,
						target_pipe_connection_index = connection.target_pipe_connection_index,
					}
				end
				local conditions = {}
				for _, condition in ipairs(prototypes.entity["pump"].surface_conditions or {}) do
					local actual = surface.get_property(condition.property)
					conditions[#conditions + 1] = {
						property = condition.property, min = condition.min, max = condition.max,
						actual = actual, passes = actual >= condition.min and actual <= condition.max,
					}
				end
				pump_rows[#pump_rows + 1] = {
					unit_number = entity.unit_number, active = entity.active, energy = entity.energy,
					status = entity.status, status_name = status_name, pumped_last_tick = entity.pumped_last_tick,
					position = { x = entity.position.x, y = entity.position.y },
					direction = entity.direction, expected_direction = defines.direction.east,
					direction_is_east = entity.direction == defines.direction.east,
					connections = connections, surface_conditions = conditions,
					surface_ignores_conditions = surface.ignore_surface_conditions,
				}
			end
			if entity.type == "transport-belt" then
				for line_index = 1, entity.get_max_transport_line_index() do
					local line = entity.get_transport_line(line_index)
					if line then
						for _, detail in ipairs(line.get_detailed_contents()) do
							local stack = detail.stack
							if stack and stack.valid_for_read and detail.unique_id and not seen_belt_stacks[detail.unique_id] then
								seen_belt_stacks[detail.unique_id] = true
								belt_unique = belt_unique + stack.count
								belt_signature_parts[#belt_signature_parts + 1] = table.concat({
									tostring(detail.unique_id), tostring(entity.position.x), tostring(entity.position.y),
									tostring(line_index), tostring(detail.position),
								}, ":")
								if #belt_rows < 4 then belt_rows[#belt_rows + 1] = {
									unique_id = detail.unique_id, name = stack.name, count = stack.count,
									entity_x = entity.position.x, entity_y = entity.position.y,
									line = line_index, position = detail.position,
								} end
							end
						end
					end
				end
			end
		end
	end
	table.sort(belt_rows, function(a, b) return tostring(a.unique_id) < tostring(b.unique_id) end)
	table.sort(belt_signature_parts)
	local segment_id_list = {}
	for id, _ in pairs(segment_ids) do segment_id_list[#segment_id_list + 1] = id end
	table.sort(segment_id_list)
	return {
		success = true, label = label, tick = game.tick, game_paused = game.tick_paused == true,
		platform = { name = platform.name, index = platform.index, paused = platform.paused == true, hidden = force.get_surface_hidden(surface) },
		fluid_by_name = fluid_by_name, item_by_name = item_by_name,
		fluidboxes = fluidboxes, segment_ids = segment_id_list,
		belt_unique_total = belt_unique, belt_signature = table.concat(belt_signature_parts, "|"),
		belt_sample_rows = belt_rows, pumps = pump_rows,
	}
end

return { success = true, stage = "measurement", tick = game.tick }
`;
const installExportLua = String.raw`
local force = game.forces.player
function __gate_drift_a.make(name, kind)
	local platform = force.create_space_platform({ name = name, planet = "nauvis", starter_pack = "space-platform-starter-pack" })
	platform.apply_starter_pack()
	platform.paused = false
	force.set_surface_hidden(platform.surface, false)
	local ox, oy = 100 + platform.index * 70, 100
	__gate_drift_a.add_foundation(platform.surface, ox, oy)
	__gate_drift_a.clear_hub(platform)
	local fillers = __gate_drift_a.add_fillers(platform.surface, ox, oy)
	local fixture = { fillers = fillers }
	if kind == "control" then
		local tank = __gate_drift_a.require_entity(platform.surface.create_entity({ name = "storage-tank", position = { ox, oy }, force = force }), "control tank")
		local inserted = tank.insert_fluid({ name = "water", amount = 2000, temperature = 25 })
		if inserted < 1999 then error("control tank fluid write rejected: " .. tostring(inserted)) end
		fixture.tank = tank.unit_number
		fixture.fluid_inserted = inserted
		fixture.belt_items_inserted = __gate_drift_a.add_static_belt(platform.surface, ox, oy)
	else
		fixture.fluid = __gate_drift_a.add_fluid_flow(platform.surface, ox, oy)
		fixture.belt_count, fixture.belt_items_inserted = __gate_drift_a.add_belt_loop(platform.surface, ox, oy)
	end
	storage.gate_drift_lab.records[name] = { platform_index = platform.index, kind = kind }
	return { success = true, name = name, kind = kind, platform_index = platform.index, entity_count = #platform.surface.find_entities_filtered({}), fixture = fixture, census = __gate_drift_a.census(name, "setup") }
end

function __gate_drift_a.export_status(export_id, name, label)
	local record = storage.platform_exports and storage.platform_exports[export_id] or nil
	local job = storage.async_jobs and storage.async_jobs[export_id] or nil
	local result = storage.async_job_results and storage.async_job_results[export_id] or nil
	local platform = __gate_drift_a.find_platform(name)
	local lock = platform and storage.locked_platforms and storage.locked_platforms[platform.index] or nil
	local compact_record = nil
	if record then
		compact_record = {
			export_id = export_id,
			tick = record.tick,
			stats = record.stats and { started_tick = record.stats.started_tick, entity_count = record.stats.entity_count, tile_count = record.stats.tile_count } or nil,
			verification = record.verification,
		}
	end
	return {
		success = true, tick = game.tick, export_id = export_id,
		job_active = job ~= nil, result_complete = result and result.complete == true or false,
		lock = lock and {
			present = true, kind = lock.kind, locked_tick = lock.locked_tick,
			platform_index = lock.platform_index, surface_index = lock.surface_index,
			frozen_count = lock.frozen_count,
		} or { present = false },
		record = compact_record,
		census = __gate_drift_a.census(name, label),
	}
end

return { success = true, tick = game.tick, version = script.active_mods.base }
`;

function installHelpers() {
	return {
		fixture_builders: lua(sourceInstance, installLua),
		measurement: lua(sourceInstance, installReadLua),
		export_probe: lua(sourceInstance, installExportLua),
	};
}

function cleanupInstance(instance) {
	return lua(instance, `
		local deleted_surfaces, deleted_exports = {}, {}
		for _, surface in pairs(game.surfaces) do
			local platform = surface.platform
			if platform and platform.valid and string.find(platform.name, '${fixturePrefix}', 1, true) == 1 then
				deleted_surfaces[#deleted_surfaces + 1] = platform.name
				game.delete_surface(surface)
			end
		end
		for export_id, record in pairs(storage.platform_exports or {}) do
			local platform_name = type(record) == "table" and record.platform_name or nil
			if type(platform_name) == "string" and string.find(platform_name, '${fixturePrefix}', 1, true) == 1 then
				storage.platform_exports[export_id] = nil
				deleted_exports[#deleted_exports + 1] = export_id
			end
		end
		storage.gate_drift_lab = nil
		__gate_drift_a = nil
		game.tick_paused = false
		if remote.interfaces.surface_export and remote.interfaces.surface_export.configure then
			remote.call("surface_export", "configure", { batch_size = 50, show_progress = true })
		end
		return { success = true, tick = game.tick, deleted_surfaces = deleted_surfaces, deleted_exports = deleted_exports }
	`);
}

function activeLabJobs(instance) {
	return lua(instance, `
		local jobs = {}
		for job_id, job in pairs(storage.async_jobs or {}) do
			local platform_name = type(job) == "table" and job.platform_name or nil
			if type(platform_name) == "string" and string.find(platform_name, '${fixturePrefix}', 1, true) == 1 then
				jobs[#jobs + 1] = { job_id = job_id, platform_name = platform_name, type = job.type }
			end
		end
		return { success = true, tick = game.tick, count = #jobs, jobs = jobs }
	`);
}

function zeroCheck(instance) {
	return lua(instance, `
		local function count_table(value)
			local count = 0
			for _, _ in pairs(value or {}) do count = count + 1 end
			return count
		end
		local surfaces, exports = {}, {}
		for _, surface in pairs(game.surfaces) do
			local platform = surface.platform
			if platform and platform.valid and string.find(platform.name, '${fixturePrefix}', 1, true) == 1 then surfaces[#surfaces + 1] = platform.name end
		end
		for export_id, record in pairs(storage.platform_exports or {}) do
			local platform_name = type(record) == "table" and record.platform_name or nil
			if type(platform_name) == "string" and string.find(platform_name, '${fixturePrefix}', 1, true) == 1 then exports[#exports + 1] = export_id end
		end
		return {
			success = true, tick = game.tick,
			zero_surfaces = #surfaces == 0, surfaces = surfaces,
			zero_storage = storage.gate_drift_lab == nil,
			game_paused = game.tick_paused == true,
			destination_holds = count_table(storage.destination_holds),
			locked_platforms = count_table(storage.locked_platforms),
			committed_source_transfer_tombstones = count_table(storage.committed_source_transfer_tombstones),
			lab_platform_exports = #exports, export_ids = exports,
		}
	`);
}

function zeroOk(check) {
	return check.zero_surfaces && check.zero_storage && !check.game_paused
		&& check.destination_holds === 0 && check.locked_platforms === 0
		&& check.committed_source_transfer_tombstones === 0 && check.lab_platform_exports === 0;
}

function cleanupAll(timeoutMs = 15000) {
	const jobsDeadline = Date.now() + timeoutMs;
	let active;
	do {
		active = { source: activeLabJobs(sourceInstance), destination: activeLabJobs(destInstance) };
		if (active.source.count === 0 && active.destination.count === 0) break;
		sleep(250);
	} while (Date.now() < jobsDeadline);
	if (active.source.count !== 0 || active.destination.count !== 0) {
		throw new Error(`Refusing cleanup while LAB-A async jobs are active: ${JSON.stringify(active)}`);
	}
	const cleanup = {
		source: cleanupInstance(sourceInstance),
		destination: cleanupInstance(destInstance),
	};
	const deadline = Date.now() + timeoutMs;
	let zero;
	do {
		zero = { source: zeroCheck(sourceInstance), destination: zeroCheck(destInstance) };
		if (zeroOk(zero.source) && zeroOk(zero.destination)) break;
		sleep(250);
	} while (Date.now() < deadline);
	return { cleanup, zero, ok: zeroOk(zero.source) && zeroOk(zero.destination) };
}

function createFixture(kind, section) {
	const name = `${fixturePrefix}-${section}-${Date.now()}`;
	const setup = lua(sourceInstance, `return __gate_drift_a.make('${luaString(name)}', '${luaString(kind)}')`);
	return { name, setup };
}

function census(name, label) {
	return lua(sourceInstance, `return __gate_drift_a.census('${luaString(name)}', '${luaString(label)}')`);
}

function waitForCondition(read, predicate, description, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	const samples = [];
	while (Date.now() < deadline) {
		const sample = read();
		samples.push(sample);
		if (predicate(sample, samples)) return { sample, samples };
		sleep(150);
	}
	throw new Error(`${description} not observed within ${timeoutMs}ms; samples=${JSON.stringify(samples.slice(-3))}`);
}

function beltSignature(reading) {
	return String(reading?.belt_signature || "");
}

function fluidSignature(reading) {
	return JSON.stringify((reading?.fluidboxes || []).filter(row => row.segment_id).map(row => [row.segment_id, row.segment_contents]));
}

function waitForSettledControl(name) {
	return waitForCondition(
		() => census(name, "control settle probe"),
		(_sample, samples) => {
			if (samples.length < 4) return false;
			const tail = samples.slice(-3);
			return new Set(tail.map(sample => beltSignature(sample))).size === 1
				&& new Set(tail.map(sample => sample.tick)).size === tail.length;
		},
		"settled control belt",
	);
}

function waitForFlow(name) {
	return waitForCondition(
		() => census(name, "pre-lock flow probe"),
		(_sample, samples) => {
			if (samples.length < 2) return false;
			const previous = samples.at(-2);
			const current = samples.at(-1);
			return current.tick > previous.tick && fluidSignature(current) !== fluidSignature(previous)
				&& Number(current.fluid_by_name?.water || 0) >= 19999;
		},
		"moving fluid between segments",
		20000,
	);
}

function startExport(index) {
	const raw = rcon(sourceInstance, `/export-platform ${index}`);
	const match = raw.match(/QUEUED:([^\s]+)/);
	if (!match) throw new Error(`Export did not return an exact id: ${raw}`);
	return { export_id: match[1], output: raw };
}

function exportStatus(exportId, name, label) {
	return lua(sourceInstance, `return __gate_drift_a.export_status('${luaString(exportId)}', '${luaString(name)}', '${luaString(label)}')`);
}

function runExport(name, platformIndex) {
	const preLock = census(name, "pre-lock physical");
	const started = startExport(platformIndex);
	const samples = [];
	const deadline = Date.now() + 30000;
	let completed;
	while (Date.now() < deadline) {
		const status = exportStatus(started.export_id, name, `export poll ${samples.length + 1}`);
		samples.push(status);
		if (status.record && status.result_complete) {
			completed = status;
			break;
		}
		sleep(100);
	}
	if (!completed) throw new Error(`Export ${started.export_id} did not complete in 30s`);
	const record = completed.record;
	if (!record?.verification || !record.stats) throw new Error(`Export ${started.export_id} missing compact provenance/verification`);
	const completionTick = completed.tick;
	const span = completionTick - Number(record.stats.started_tick);
	if (span < 5) throw new Error(`Export ${started.export_id} did not meet the >=5 tick power bar: span=${span}`);
	const inWindow = samples.filter(sample => sample.job_active);
	if (!inWindow.length || !inWindow.every(sample => sample.lock?.present && sample.lock.kind === "export")) {
		throw new Error(`Export ${started.export_id} lacked production export-lock evidence during its scan window`);
	}
	return {
		...started,
		pre_lock: preLock,
		locked_samples: samples,
		completion: completed,
		provenance: {
			export_id: started.export_id,
			record_tick: record.tick,
			record_started_tick: record.stats.started_tick,
			observed_completion_tick: completionTick,
			entity_count: record.stats.entity_count,
			tick_span: span,
			span_floor_ticks: 5,
			census_mechanism: "single /sc invocation per reading",
			lock_mechanism: "production /export-platform lock sampled while storage.async_jobs[export_id] was active",
		},
	};
}

function aggregateFluids(counts) {
	const totals = {};
	for (const [key, amount] of Object.entries(counts || {})) {
		const match = key.match(/^(.+)@[-+]?\d+(?:\.\d+)?C$/);
		const name = match ? match[1] : key;
		totals[name] = (totals[name] || 0) + Number(amount || 0);
	}
	return totals;
}

function residual(serialized, physical) {
	const names = new Set([...Object.keys(serialized || {}), ...Object.keys(physical || {})]);
	const rows = [...names].sort().map(name => {
		const serializedAmount = Number(serialized?.[name] || 0);
		const physicalAmount = Number(physical?.[name] || 0);
		return { name, serialized: serializedAmount, physical: physicalAmount, delta: serializedAmount - physicalAmount, absolute: Math.abs(serializedAmount - physicalAmount) };
	});
	return { max_absolute: Math.max(0, ...rows.map(row => row.absolute)), rows };
}

function summarizeExport(run) {
	const verification = run.completion.record.verification;
	const startPhysical = run.locked_samples[0]?.census || run.pre_lock;
	const endPhysical = run.completion.census;
	const serializedFluids = aggregateFluids(verification.fluid_counts);
	const serializedItems = verification.item_counts || {};
	return {
		provenance: run.provenance,
		verification,
		start: {
			tick: startPhysical.tick,
			fluids: residual(serializedFluids, startPhysical.fluid_by_name),
			items: residual(serializedItems, startPhysical.item_by_name),
		},
		end: {
			tick: endPhysical.tick,
			fluids: residual(serializedFluids, endPhysical.fluid_by_name),
			items: residual(serializedItems, endPhysical.item_by_name),
		},
	};
}

function observedMovement(samples, signature) {
	const valid = samples.map(sample => sample.census).filter(Boolean);
	return {
		ticks: valid.map(sample => sample.tick),
		changed: new Set(valid.map(signature)).size > 1,
		signatures: valid.map(signature),
	};
}

function runControl() {
	const fixture = createFixture("control", "control");
	const settle = waitForSettledControl(fixture.name);
	const run = runExport(fixture.name, fixture.setup.platform_index);
	const summary = summarizeExport(run);
	const exact = summary.start.fluids.max_absolute === 0 && summary.start.items.max_absolute === 0
		&& summary.end.fluids.max_absolute === 0 && summary.end.items.max_absolute === 0;
	if (!exact) throw new Error(`STATIC CONTROL NOT EXACT: ${JSON.stringify(summary)}`);
	return { success: true, section: "control", fixture, settle, run, summary, exact };
}

function runFlowSection(section) {
	const fixture = createFixture("flow", section);
	const preFlow = waitForFlow(fixture.name);
	const run = runExport(fixture.name, fixture.setup.platform_index);
	const summary = summarizeExport(run);
	const productionLockSamples = run.locked_samples.filter(sample => sample.job_active && sample.lock?.present && sample.lock.kind === "export");
	if (productionLockSamples.length < 2) throw new Error(`Section ${section} captured fewer than two production-lock samples`);
	const fluidMovement = observedMovement(productionLockSamples, sample => fluidSignature(sample));
	const beltMovement = observedMovement(productionLockSamples, sample => beltSignature(sample));
	const segmentIds = productionLockSamples.map(sample => sample.census?.segment_ids || []);
	return {
		success: true,
		section,
		fixture,
		pre_flow: preFlow,
		run,
		summary,
		locked_movement: {
			mechanism: "samples with job_active=true and production export lock present",
			sample_count: productionLockSamples.length,
			fluids_changed: fluidMovement.changed,
			belts_changed: beltMovement.changed,
			fluid_ticks: fluidMovement.ticks,
			belt_ticks: beltMovement.ticks,
			segment_ids_stable: new Set(segmentIds.map(ids => JSON.stringify(ids))).size === 1,
			segment_ids: segmentIds,
		},
	};
}

function compactForNotebook(results) {
	const compactSection = section => ({
		section: section.section,
		success: section.success,
		fixture: { name: section.fixture.name, setup: section.fixture.setup, pre_flow: section.pre_flow },
		provenance: section.summary?.provenance,
		summary: section.summary,
		locked_movement: section.locked_movement,
		locked_samples: (section.run?.locked_samples || []).map(sample => ({
			tick: sample.tick,
			job_active: sample.job_active,
			result_complete: sample.result_complete,
			lock: sample.lock,
			census: sample.census,
		})),
	});
	return {
		script: results.script,
		started_at: results.started_at,
		finished_at: results.finished_at,
		sections: results.sections.map(compactSection),
		cleanup: results.cleanup,
		classification: results.classification,
	};
}

function classify(sectionResults) {
	const measured = sectionResults.filter(section => section.summary);
	const maxFluid = Math.max(0, ...measured.flatMap(section => [section.summary.start.fluids.max_absolute, section.summary.end.fluids.max_absolute]));
	const maxItems = Math.max(0, ...measured.flatMap(section => [section.summary.start.items.max_absolute, section.summary.end.items.max_absolute]));
	return {
		max_fluid_residual: maxFluid,
		max_item_residual: maxItems,
		class: maxFluid === 0 && maxItems === 0 ? "residual approximately zero" : "nonzero residual requires root-cause adjudication",
		note: "Measurement only. This runner does not recommend or change a validation-gate tolerance.",
	};
}

function main() {
	const results = { script: "tests/gate-drift-lab/run-lab-a.mjs", started_at: new Date().toISOString(), requested_sections: sections, sections: [], errors: [] };
	let finalCleanup;
	try {
		const initialCleanup = cleanupAll();
		if (!initialCleanup.ok) throw new Error(`Initial cleanup failed: ${JSON.stringify(initialCleanup)}`);
		if (resetOnly) {
			console.log(JSON.stringify(initialCleanup, null, 2));
			return;
		}
		configureSource(1);
		results.install = installHelpers();
		for (const section of sections) {
			const result = section === "control" ? runControl() : runFlowSection(section);
			results.sections.push(result);
		}
		results.classification = classify(results.sections);
	} catch (error) {
		results.errors.push(error.stack || error.message);
		process.exitCode = 1;
	} finally {
		try {
			finalCleanup = cleanupAll();
			results.cleanup = finalCleanup;
			if (!finalCleanup.ok) {
				results.errors.push(`Final cleanup failed: ${JSON.stringify(finalCleanup)}`);
				process.exitCode = 1;
			}
		} catch (cleanupError) {
			results.errors.push(`Cleanup threw: ${cleanupError.stack || cleanupError.message}`);
			process.exitCode = 1;
		}
		results.finished_at = new Date().toISOString();
		if (!noNotebook && !resetOnly) {
			mkdirSync("tests/gate-drift-lab", { recursive: true });
			const compact = compactForNotebook(results);
			appendFileSync(notebook, `\n\n## ${results.finished_at} - LAB-A export-drift run (sections=${sections.join(",")})\n\n`);
			appendFileSync(notebook, "Stored-verification provenance: `ExportPipeline.complete()` attaches `job.export_data.verification` after the atomic belt scan, then stores that same table as the plaintext `storage.platform_exports[export_id].verification` sibling of the compressed payload; the uncompressed fallback exposes `.verification` at the same path.\n\n");
			appendFileSync(notebook, `\`\`\`json\n${JSON.stringify(compact, null, 2)}\n\`\`\`\n`);
		}
		console.log(JSON.stringify({
			success: results.errors.length === 0 && finalCleanup?.ok === true,
			classification: results.classification,
			sections: results.sections.map(section => ({ section: section.section, provenance: section.summary?.provenance, summary: section.summary, locked_movement: section.locked_movement })),
			cleanup: results.cleanup,
			errors: results.errors,
		}, null, 2));
	}
}

main();
