#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const controller = "surface-export-controller";
const controlConfig = "/clusterio/tokens/config-control.json";
const sourceHost = 1;
const destHost = 2;
const sourceInstance = "clusterio-host-1-instance-1";
const destInstance = "clusterio-host-2-instance-1";
const sourceContainer = "surface-export-host-1";
const destContainer = "surface-export-host-2";
const notebook = "tests/fluid-lab/NOTEBOOK.md";
const fixturePrefix = "fluid-lab-r10";
const defaultSections = ["r10a", "r10b"];

const args = process.argv.slice(2);
let sections = [...defaultSections];
let resetOnly = false;
let noNotebook = false;
for (let i = 0; i < args.length; i += 1) {
	const arg = args[i];
	if (arg === "--reset") {
		resetOnly = true;
	} else if (arg === "--no-notebook") {
		noNotebook = true;
	} else if (arg === "--sections") {
		sections = parseSections(args[++i] || "");
	} else if (arg.startsWith("--sections=")) {
		sections = parseSections(arg.slice("--sections=".length));
	} else {
		throw new Error(`Unknown argument: ${arg}`);
	}
}

function parseSections(value) {
	const parsed = value.split(",").map(part => part.trim().toLowerCase()).filter(Boolean);
	if (!parsed.length) throw new Error("--sections requires at least one section");
	for (const section of parsed) {
		if (!["r10a", "r10b"].includes(section)) {
			throw new Error(`Unsupported R10 section '${section}'. This runner implements r10a,r10b only.`);
		}
	}
	return parsed;
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

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rcon(instance, command) {
	return execFileSync("docker", [
		"exec", controller,
		"npx", "clusterioctl",
		"--log-level", "error",
		"instance", "send-rcon", instance, command,
		"--config", controlConfig,
	], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function lastLine(text) {
	return String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || "";
}

function lua(instance, body) {
	const wrapped = [
		"local ok,result=pcall(function()",
		body,
		"end);",
		"if ok then rcon.print(helpers.table_to_json(result))",
		"else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end",
	].join(" ");
	const raw = lastLine(rcon(instance, `/sc ${wrapped}`));
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`Failed to parse Lua JSON from ${instance}: ${raw}\n${error.stack || error.message}`);
	}
}

function stepTick(instance, ticks) {
	rcon(instance, `/step-tick ${ticks}`);
}

function luaString(value) {
	return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function safeName(value) {
	return String(value || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
}

function scriptOutput(instance) {
	return `/clusterio/data/instances/${instance}/script-output`;
}

function listDebugFiles(host, instance, pattern) {
	const container = host === 1 ? sourceContainer : destContainer;
	const output = sh(container, `ls -1 ${scriptOutput(instance)}/${pattern} 2>/dev/null || true`, { stderr: "ignore" });
	return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean).sort();
}

function readJsonFile(host, path) {
	const container = host === 1 ? sourceContainer : destContainer;
	const raw = sh(container, `cat '${path.replace(/'/g, "'\\''")}'`, { stderr: "pipe" });
	return JSON.parse(raw);
}

function removeDebugFilesForName(name) {
	const safe = safeName(name);
	for (const [host, instance, container] of [
		[1, sourceInstance, sourceContainer],
		[2, destInstance, destContainer],
	]) {
		const out = scriptOutput(instance);
		sh(container, `rm -f ${out}/debug_source_platform_${safe}_*.json ${out}/debug_destination_platform_${safe}_*.json ${out}/debug_import_result_${safe}_*.json 2>/dev/null || true`, { stderr: "ignore" });
	}
}

function getInstanceId(instanceName) {
	const output = dockerExec(controller, ["bash", "-c", `npx clusterioctl --config ${controlConfig} instance list 2>/dev/null`]);
	for (const line of output.split(/\r?\n/)) {
		const match = line.match(new RegExp(`^\\s*${instanceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|\\s*(\\d+)`));
		if (match) return Number(match[1]);
	}
	throw new Error(`Could not resolve Clusterio instance id for ${instanceName}. Output:\n${output}`);
}

const helperLua = `
storage.fluid_lab = storage.fluid_lab or { records = {} }
__fluid_lab_r10 = {}
local force = game.forces.player
function __fluid_lab_r10.mk(platform_name)
	local p = force.create_space_platform({ name = platform_name, planet = "nauvis", starter_pack = "space-platform-starter-pack" })
	p.apply_starter_pack()
	p.paused = false
	force.set_surface_hidden(p.surface, false)
	local ox = 100 + p.index * 50
	local oy = 100
	local tiles = {}
	for x = -12, 12 do for y = -12, 12 do tiles[#tiles + 1] = { name = "space-platform-foundation", position = { ox + x, oy + y } } end end
	p.surface.set_tiles(tiles, true, false, true, false)
	p.schedule = { current = 1, records = { { station = "nauvis" } } }
	local tank = p.surface.create_entity({ name = "storage-tank", position = { ox, oy }, force = force })
	storage.fluid_lab.records[platform_name] = { platform = p.index, unit_number = tank.unit_number }
	return p, tank
end
function __fluid_lab_r10.find_tank(platform_name)
	for _, p in pairs(force.platforms) do
		if p.name == platform_name and p.valid then
			for _, e in pairs(p.surface.find_entities_filtered({ name = "storage-tank" })) do
				if e.valid then return p, e end
			end
		end
	end
	return nil, nil
end
function __fluid_lab_r10.read_entity(label, e)
	local platform_paused = nil
	if e and e.valid and e.surface and e.surface.valid and e.surface.platform and e.surface.platform.valid then platform_paused = e.surface.platform.paused == true end
	local boxes, direct_total, segment_total, seen = {}, 0, 0, {}
	if e and e.valid and e.fluidbox then
		for i = 1, #e.fluidbox do
			local row = { index = i }
			local ok_direct, direct = pcall(function() return e.fluidbox[i] end)
			if ok_direct and direct then
				row.direct = { name = direct.name, amount = direct.amount, temperature = direct.temperature }
				direct_total = direct_total + (direct.amount or 0)
			elseif not ok_direct then row.direct_error = tostring(direct) end
			local ok_seg, seg_id = pcall(function() return e.fluidbox.get_fluid_segment_id(i) end)
			row.segment_id = ok_seg and seg_id or nil
			if not ok_seg then row.segment_error = tostring(seg_id) end
			if row.segment_id and not seen[row.segment_id] then
				seen[row.segment_id] = true
				local ok_contents, contents = pcall(function() return e.fluidbox.get_fluid_segment_contents(i) end)
				if ok_contents and contents then
					row.segment_contents = contents
					for _, amount in pairs(contents) do segment_total = segment_total + amount end
				elseif not ok_contents then row.segment_contents_error = tostring(contents) end
			end
			boxes[#boxes + 1] = row
		end
	end
	return { label = label, tick = game.tick, game_paused = game.tick_paused == true, platform_paused = platform_paused, valid = e and e.valid or false, name = e and e.name or nil, type = e and e.type or nil, active = e and e.valid and e.active or nil, direct_total = direct_total, segment_total = segment_total, boxes = boxes }
end
function __fluid_lab_r10.read_platform_tank(label, platform_name)
	local p, tank = __fluid_lab_r10.find_tank(platform_name)
	return { success = tank ~= nil, platform = p and { name = p.name, index = p.index, paused = p.paused } or nil, read = __fluid_lab_r10.read_entity(label, tank) }
end
return { success = true, tick = game.tick, base = script.active_mods.base }
`;

function installHelpers() {
	return {
		source: lua(sourceInstance, helperLua),
		dest: lua(destInstance, helperLua),
	};
}

function configureDebug() {
	lua(sourceInstance, `remote.call("surface_export", "configure", { debug_mode = true }); return { success = true, debug_mode = storage.surface_export_config and storage.surface_export_config.debug_mode }`);
	lua(destInstance, `remote.call("surface_export", "configure", { debug_mode = true }); return { success = true, debug_mode = storage.surface_export_config and storage.surface_export_config.debug_mode }`);
}

function cleanupInstance(instance, prefix) {
	return lua(instance, `
		local deleted = {}
		for _, surface in pairs(game.surfaces) do
			local p = surface.platform
			if p and p.valid and string.find(p.name, '${luaString(prefix)}', 1, true) then
				local row = { name = p.name }
				local ok, err = pcall(function() game.delete_surface(surface) end)
				row.ok = ok
				if not ok then row.error = tostring(err) end
				deleted[#deleted + 1] = row
			end
		end
		storage.fluid_lab = nil
		__fluid_lab_r10 = nil
		game.tick_paused = false
		return { success = true, deleted = deleted, tick = game.tick, game_paused = game.tick_paused == true }
	`);
}

function zeroCheckInstance(instance, prefix) {
	return lua(instance, `
		local function count_table(t)
			local n = 0
			for _, _ in pairs(t or {}) do n = n + 1 end
			return n
		end
		local leftovers = {}
		for _, surface in pairs(game.surfaces) do
			local p = surface.platform
			if p and p.valid and string.find(p.name, '${luaString(prefix)}', 1, true) then leftovers[#leftovers + 1] = p.name end
		end
		return {
			success = true,
			tick = game.tick,
			game_paused = game.tick_paused == true,
			zero_surfaces = #leftovers == 0,
			leftovers = leftovers,
			zero_storage = storage.fluid_lab == nil,
			destination_holds = count_table(storage.destination_holds),
			locked_platforms = count_table(storage.locked_platforms),
			committed_source_transfer_tombstones = count_table(storage.committed_source_transfer_tombstones),
		}
	`);
}

function cleanupAll() {
	const cleanup = {
		source: cleanupInstance(sourceInstance, fixturePrefix),
		dest: cleanupInstance(destInstance, fixturePrefix),
	};
	stepTick(sourceInstance, 5);
	stepTick(destInstance, 5);
	for (const [instance, container] of [[sourceInstance, sourceContainer], [destInstance, destContainer]]) {
		sh(container, `rm -f ${scriptOutput(instance)}/debug_source_platform_${fixturePrefix}*.json ${scriptOutput(instance)}/debug_destination_platform_${fixturePrefix}*.json ${scriptOutput(instance)}/debug_import_result_${fixturePrefix}*.json 2>/dev/null || true`, { stderr: "ignore" });
	}
	const zero = {
		source: zeroCheckInstance(sourceInstance, fixturePrefix),
		dest: zeroCheckInstance(destInstance, fixturePrefix),
	};
	return {
		cleanup,
		zero,
		ok: zero.source.zero_surfaces && zero.source.zero_storage && !zero.source.game_paused && zero.source.destination_holds === 0 && zero.source.locked_platforms === 0 && zero.source.committed_source_transfer_tombstones === 0
			&& zero.dest.zero_surfaces && zero.dest.zero_storage && !zero.dest.game_paused && zero.dest.destination_holds === 0 && zero.dest.locked_platforms === 0 && zero.dest.committed_source_transfer_tombstones === 0,
	};
}

function readPlatformTank(instance, label, platformName) {
	return lua(instance, `return __fluid_lab_r10.read_platform_tank('${luaString(label)}', '${luaString(platformName)}')`);
}

function createSingleTempFixture(name) {
	return lua(sourceInstance, `
		local p, tank = __fluid_lab_r10.mk('${luaString(name)}')
		local inserted = tank.insert_fluid({ name = "steam", amount = 2000, temperature = 165 })
		local read = __fluid_lab_r10.read_entity("R10a after insert", tank)
		return { success = inserted >= 1999 and read.direct_total >= 1999, platform = { name = p.name, index = p.index }, inserted = inserted, read = read }
	`);
}

function createMixedTempFixture(name) {
	const setup = lua(sourceInstance, `
		local p, tank = __fluid_lab_r10.mk('${luaString(name)}')
		local inserted1 = tank.insert_fluid({ name = "steam", amount = 1000, temperature = 165 })
		local after_first = __fluid_lab_r10.read_entity("R10b after first insert", tank)
		local inserted2 = tank.insert_fluid({ name = "steam", amount = 1000, temperature = 500 })
		local after_second = __fluid_lab_r10.read_entity("R10b after second insert", tank)
		return { success = inserted1 >= 999 and inserted2 >= 999, platform = { name = p.name, index = p.index }, inserted1 = inserted1, inserted2 = inserted2, after_first = after_first, after_second = after_second }
	`);
	stepTick(sourceInstance, 1);
	const afterPlus1 = readPlatformTank(sourceInstance, "R10b +1 tick", name);
	stepTick(sourceInstance, 59);
	const afterPlus60 = readPlatformTank(sourceInstance, "R10b +60 ticks", name);
	const preExport = readPlatformTank(sourceInstance, "R10b pre-export", name);
	return { ...setup, after_plus1: afterPlus1, after_plus60: afterPlus60, pre_export: preExport };
}

function waitForDebugResult(name, timeoutMs = 150000) {
	const safe = safeName(name);
	const deadline = Date.now() + timeoutMs;
	let resultFile = null;
	while (Date.now() < deadline) {
		const files = listDebugFiles(destHost, destInstance, `debug_import_result_${safe}_*.json`);
		if (files.length) {
			resultFile = files.at(-1);
			break;
		}
		sleep(2000);
	}
	if (!resultFile) throw new Error(`No debug_import_result for ${name} after ${timeoutMs / 1000}s`);
	sleep(3000);
	const finalFiles = listDebugFiles(destHost, destInstance, `debug_import_result_${safe}_*.json`);
	resultFile = finalFiles.at(-1) || resultFile;
	const sourceFiles = listDebugFiles(sourceHost, sourceInstance, `debug_source_platform_${safe}_*.json`);
	if (!sourceFiles.length) throw new Error(`No debug_source_platform for ${name}`);
	return compactDebugDump({
		import_result_file: resultFile,
		import_result: readJsonFile(destHost, resultFile),
		source_file: sourceFiles.at(-1),
		source_debug: readJsonFile(sourceHost, sourceFiles.at(-1)),
	});
}

function compactDebugDump(debug) {
	const validation = debug.import_result?.validation_result || {};
	const sourceVerification = debug.source_debug?.verification || {};
	return {
		import_result_file: debug.import_result_file,
		source_file: debug.source_file,
		import_result_keys: Object.keys(debug.import_result || {}).sort(),
		validation_result_keys: Object.keys(validation).sort(),
		source_debug_keys: Object.keys(debug.source_debug || {}).sort(),
		source_verification_keys: Object.keys(sourceVerification).sort(),
		validation: {
			validation_success: debug.import_result?.validation_success,
			itemCountMatch: validation.itemCountMatch,
			fluidCountMatch: validation.fluidCountMatch,
			failedStage: validation.failedStage ?? null,
			expectedFluidCounts: validation.expectedFluidCounts,
			actualFluidCounts: validation.actualFluidCounts,
			totalExpectedFluids: validation.totalExpectedFluids,
			totalActualFluids: validation.totalActualFluids,
			fluidReconciliation: validation.fluidReconciliation,
		},
		source_verification: {
			fluid_counts: sourceVerification.fluid_counts,
			item_counts: sourceVerification.item_counts,
		},
		source_platform: debug.source_debug?.platform ? {
			name: debug.source_debug.platform.name,
			index: debug.source_debug.platform.index,
			paused: debug.source_debug.platform.paused,
			schedule_records: debug.source_debug.platform.schedule?.records?.length ?? null,
		} : null,
	};
}

function transferFixture(name, index) {
	removeDebugFilesForName(name);
	const destId = getInstanceId(destInstance);
	const command = `/transfer-platform ${index} ${destId}`;
	const output = rcon(sourceInstance, command);
	try {
		const debug = waitForDebugResult(name);
		const destRead = readPlatformTank(destInstance, `dest post-transfer ${name}`, name);
		return { dest_instance_id: destId, command, output, debug, dest_read: destRead };
	} catch (error) {
		const safe = safeName(name);
		const sourceFiles = listDebugFiles(sourceHost, sourceInstance, `debug_*${safe}_*.json`);
		const destFiles = listDebugFiles(destHost, destInstance, `debug_*${safe}_*.json`);
		throw new Error(`${error.message}\nTransfer command: ${command}\nTransfer output: ${output}\nSource debug files: ${JSON.stringify(sourceFiles)}\nDest debug files: ${JSON.stringify(destFiles)}`);
	}
}

function keyAmount(counts, key) {
	return Number((counts || {})[key] || 0);
}

function volumeByName(counts) {
	const byName = {};
	for (const [key, amount] of Object.entries(counts || {})) {
		const match = key.match(/^(.+)@([\d.-]+)C$/);
		const name = match ? match[1] : key;
		byName[name] = (byName[name] || 0) + Number(amount || 0);
	}
	return byName;
}

function simulateOldGate(expected, actual) {
	const falseFailKeys = [];
	for (const [key, expectedVolume] of Object.entries(expected || {})) {
		const exp = Number(expectedVolume || 0);
		const act = keyAmount(actual, key);
		if (exp > 1000 && act < 1) {
			falseFailKeys.push({ key, expected: exp, actual: act });
		}
	}
	return { would_false_fail: falseFailKeys.length > 0, false_fail_keys: falseFailKeys };
}

function validationPayload(debug) {
	const validation = debug.validation;
	if (!validation) throw new Error("debug_import_result missing validation_result");
	if (!validation.expectedFluidCounts || !validation.actualFluidCounts) {
		throw new Error("debug_import_result validation_result missing expectedFluidCounts/actualFluidCounts");
	}
	return validation;
}

function sourceFluidCounts(debug) {
	const counts = debug.source_verification?.fluid_counts;
	if (!counts) throw new Error("debug_source_platform missing verification.fluid_counts");
	return counts;
}

function summarizeGate(debug) {
	const validation = validationPayload(debug);
	return {
		validation_success: validation.validation_success,
		fluidCountMatch: validation.fluidCountMatch,
		failedStage: validation.failedStage ?? null,
		expectedFluidCounts: validation.expectedFluidCounts,
		actualFluidCounts: validation.actualFluidCounts,
		totalExpectedFluids: validation.totalExpectedFluids,
		totalActualFluids: validation.totalActualFluids,
		fluidReconciliation: validation.fluidReconciliation,
		sourceVerificationFluidCounts: sourceFluidCounts(debug),
	};
}

async function runR10a() {
	const name = `${fixturePrefix}a-${Date.now()}`;
	removeDebugFilesForName(name);
	const setup = createSingleTempFixture(name);
	if (!setup.success) throw new Error(`R10a fixture setup failed: ${JSON.stringify(setup)}`);
	const transfer = transferFixture(name, setup.platform.index);
	const gate = summarizeGate(transfer.debug);
	const expected = gate.expectedFluidCounts;
	const actual = gate.actualFluidCounts;
	const expectedKey = "steam@165.0C";
	const expectedVolume = keyAmount(expected, expectedKey);
	const actualVolume = keyAmount(actual, expectedKey);
	const pass = gate.validation_success === true && gate.fluidCountMatch === true && expectedVolume >= 1999 && Math.abs(actualVolume - expectedVolume) <= 25;
	return {
		success: pass,
		rung: "R10a",
		platform: name,
		setup,
		transfer,
		gate,
		assertions: {
			expected_key: expectedKey,
			expected_volume: expectedVolume,
			actual_volume: actualVolume,
			key_reproduced: actualVolume > 0,
			volume_delta: actualVolume - expectedVolume,
			gate_passed: gate.validation_success === true && gate.fluidCountMatch === true,
		},
		conclusion: pass
			? "R10a PASS: fixed steam@165.0C key reproduced through real transfer and the composite fluid gate passed."
			: "R10a FAIL: fixed-temperature control did not reproduce; R10b is not interpretable until the instrument is fixed.",
	};
}

async function runR10b() {
	const name = `${fixturePrefix}b-${Date.now()}`;
	removeDebugFilesForName(name);
	const setup = createMixedTempFixture(name);
	if (!setup.success) throw new Error(`R10b fixture setup failed: ${JSON.stringify(setup)}`);
	const transfer = transferFixture(name, setup.platform.index);
	const gate = summarizeGate(transfer.debug);
	const oldGate = simulateOldGate(gate.expectedFluidCounts, gate.actualFluidCounts);
	const sourceCrossCheck = sourceFluidCounts(transfer.debug);
	const expectedByName = volumeByName(gate.expectedFluidCounts);
	const actualByName = volumeByName(gate.actualFluidCounts);
	const gatePassed = gate.validation_success === true && gate.fluidCountMatch === true;
	const oldWouldPass = !oldGate.would_false_fail;
	return {
		success: gatePassed,
		rung: "R10b",
		platform: name,
		setup,
		transfer,
		gate,
		old_gate_simulation: oldGate,
		aggregates: { expectedByName, actualByName },
		source_cross_check: {
			verification_fluid_counts: sourceCrossCheck,
			matches_import_expected: JSON.stringify(sourceCrossCheck) === JSON.stringify(gate.expectedFluidCounts),
		},
		assertions: {
			new_gate_passed_valid_transfer: gatePassed,
			old_gate_would_false_fail: oldGate.would_false_fail,
		},
		conclusion: gatePassed
			? (oldWouldPass
				? "R10b PASS: valid mixed-temp transfer passed; old exact-key gate would NOT have false-failed this measured export/import pair, so #76 is defensive for this case rather than proven necessary."
				: "R10b PASS: valid mixed-temp transfer passed under the new gate; old exact-key gate WOULD have false-failed this measured export/import pair, grounding #76 as necessary.")
			: "R10b FAIL: valid mixed-temp transfer did not pass the new aggregate gate.",
	};
}

async function main() {
	const results = {
		script: "tests/fluid-lab/run-r10.mjs",
		started: new Date().toISOString(),
		sections,
		no_notebook: noNotebook,
		source: { host: sourceHost, instance: sourceInstance },
		dest: { host: destHost, instance: destInstance },
		rungs: {},
		errors: [],
	};
	try {
		results.initial_reset = cleanupAll();
		if (!results.initial_reset.ok) throw new Error(`Initial reset did not reach zero state: ${JSON.stringify(results.initial_reset.zero)}`);
		results.install = installHelpers();
		configureDebug();
		if (sections.includes("r10a")) {
			results.rungs.r10a = await runR10a();
			if (!results.rungs.r10a.success) throw new Error(results.rungs.r10a.conclusion);
		}
		if (sections.includes("r10b")) {
			results.rungs.r10b = await runR10b();
			if (!results.rungs.r10b.success) throw new Error(results.rungs.r10b.conclusion);
		}
	} catch (error) {
		results.errors.push(error.stack || error.message);
	} finally {
		try {
			results.final_reset = cleanupAll();
		} catch (error) {
			results.errors.push(`cleanup failed: ${error.stack || error.message}`);
		}
		results.finished = new Date().toISOString();
		if (!noNotebook && !resetOnly) {
			appendFileSync(notebook, `\n\n## ${new Date().toISOString()} - R10 fluid-lab run (run-r10.mjs; sections=${sections.join(",")})\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n`);
		}
		console.log(JSON.stringify(results, null, 2));
		if (results.errors.length || !results.final_reset?.ok) process.exitCode = 1;
	}
}

if (resetOnly) {
	const result = cleanupAll();
	console.log(JSON.stringify(result, null, 2));
	if (!result.ok) process.exitCode = 1;
} else {
	await main();
}