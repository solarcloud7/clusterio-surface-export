#!/usr/bin/env node
// config-attrs — ten mechanical config attributes must survive a real host-1 -> host-2 transfer
//
// requires: the cluster up, lab-transfer-fixture-v1 on host-1, host-2 able to receive
// produces: per-attribute SOURCE arming and DESTINATION physical readback, a gate verdict read
//           before any destination read, and a DECLARED-INERT line (with the live prototype
//           predicate that decided it) for attributes no prototype supports at this pin
// does not: read the export payload — payload presence is not restoration; assert item/fluid
//           fidelity (the gate does that); touch the protected fixtures (it transfers a CLONE)

import { lua as luaRaw, sleep, REPO_ROOT } from "../../lab-gallery/batch-lifecycle.mjs";
import { execFileSync } from "node:child_process";

const SOURCE_HOST = 1;
const DEST_HOST = 2;
const FIXTURE = "lab-transfer-fixture-v1";
const CLONE = `cfgattr-${Date.now().toString(36)}`;
const CLONE_WAIT_MS = 300_000;
const ARRIVAL_WAIT_MS = 300_000;

const say = (...a) => console.log(...a);
const problems = [];
function fail(message) {
	problems.push(message);
	process.exitCode = 1;
	say(`  FAIL ${message}`);
}
function pass(message) {
	say(`  PASS ${message}`);
}

function lua(host, body) {
	const r = luaRaw(host, body);
	if (r === null || typeof r !== "object") throw new Error(`lua returned no object: ${JSON.stringify(r)}`);
	if (r.success !== true) throw new Error(`lua failed: ${r.error ?? JSON.stringify(r)}`);
	return r;
}

const asArray = v => (Array.isArray(v) ? v : Object.values(v || {}));

const RIG_ENTITIES = [
	{ id: "loader", name: "turbo-loader", dx: 1.5, dy: 2, direction: "defines.direction.south" },
	{ id: "loader1x1", name: "loader-1x1", dx: 4.5, dy: 1.5 },
	{ id: "chest", name: "storage-chest", dx: 7.5, dy: 1.5 },
	{ id: "valve", name: "overflow-valve", dx: 10.5, dy: 1.5 },
	{ id: "inserter", name: "bulk-inserter", dx: 13.5, dy: 1.5 },
	{ id: "wall", name: "stone-wall", dx: 16.5, dy: 1.5 },
	{ id: "silo", name: "rocket-silo", dx: 18.5, dy: 8.5 },
];

const NUMERIC_READ = attr => `local v = e.${attr}; if v == nil then return "nil" end return string.format("%.6f", v)`;
const BOOL_READ = attr => `return tostring(e.${attr})`;
const STRING_READ = attr => `return tostring(e.${attr})`;

const ATTRS = [
	{
		key: "pickup_from_left_lane", attribute: "pickup_from_left_lane", on: "inserter",
		write: "e.pickup_from_left_lane = false", read: BOOL_READ("pickup_from_left_lane"), expect: "false",
	},
	{
		key: "pickup_from_right_lane", attribute: "pickup_from_right_lane", on: "inserter",
		write: "e.pickup_from_right_lane = false", read: BOOL_READ("pickup_from_right_lane"), expect: "false",
	},
	{
		key: "loader_filter_mode", attribute: "loader_filter_mode", on: "loader",
		write: 'e.loader_filter_mode = "blacklist"', read: STRING_READ("loader_filter_mode"), expect: "blacklist",
	},
	{
		key: "loader_filter_mode_1x1", attribute: "loader_filter_mode", on: "loader1x1",
		write: 'e.loader_filter_mode = "blacklist"', read: STRING_READ("loader_filter_mode"), expect: "blacklist",
	},
	{
		key: "storage_filter", attribute: "storage_filter", on: "chest",
		write: 'e.storage_filter = { name = "iron-plate", quality = "rare" }',
		read: 'local f = e.storage_filter\n'
			+ 'if f == nil then return "nil" end\n'
			+ 'local n = type(f.name) == "string" and f.name or (f.name and f.name.name)\n'
			+ 'local q = type(f.quality) == "string" and f.quality or (f.quality and f.quality.name)\n'
			+ 'return tostring(n) .. "@" .. tostring(q)',
		expect: "iron-plate@rare",
	},
	{
		key: "valve_threshold_override", attribute: "valve_threshold_override", on: "valve",
		write: "e.valve_threshold_override = 0.25", read: NUMERIC_READ("valve_threshold_override"),
		expect: "0.250000",
	},
	{
		key: "send_to_orbit_automatically", attribute: "send_to_orbit_automatically", on: "silo",
		write: "e.send_to_orbit_automatically = true", read: BOOL_READ("send_to_orbit_automatically"),
		expect: "true",
	},
	{
		key: "use_transitional_requests", attribute: "use_transitional_requests", on: "silo",
		write: "e.use_transitional_requests = true", read: BOOL_READ("use_transitional_requests"),
		expect: "true",
	},
	{
		key: "name_tag_wall", attribute: "name_tag", on: "wall",
		write: `e.name_tag = "${CLONE}-wall"`, read: STRING_READ("name_tag"), expect: `${CLONE}-wall`,
	},
	{
		key: "name_tag_loader", attribute: "name_tag", on: "loader",
		write: `e.name_tag = "${CLONE}-loader"`, read: STRING_READ("name_tag"), expect: `${CLONE}-loader`,
	},
];

const INERT_CANDIDATES = [
	{
		attribute: "loader_belt_stack_size_override",
		predicate: "a loader prototype with loader_adjustable_belt_stack_size = true",
		count: 'local n = 0\n'
			+ 'for _, proto in pairs(prototypes.entity) do\n'
			+ '  if (proto.type == "loader" or proto.type == "loader-1x1") and proto.loader_adjustable_belt_stack_size then\n'
			+ '    n = n + 1\n'
			+ '  end\n'
			+ 'end\n'
			+ 'return n',
	},
	{
		attribute: "mining_drill_filter_mode",
		predicate: "a mining-drill prototype with filter_count > 0",
		count: 'local n = 0\n'
			+ 'for _, proto in pairs(prototypes.entity) do\n'
			+ '  if proto.type == "mining-drill" and proto.filter_count > 0 then n = n + 1 end\n'
			+ 'end\n'
			+ 'return n',
	},
];

function readersLua() {
	return ATTRS.map(a => `readers["${a.key}"] = function(e)\n${a.read}\nend`).join("\n");
}

function platformLua(name) {
	return `local p\n`
		+ `for _, pl in pairs(game.forces.player.platforms) do if pl.name == '${name}' then p = pl end end\n`
		+ `if not (p and p.valid and p.surface and p.surface.valid) then\n`
		+ `  return { success = false, error = "platform '${name}' has no valid surface" }\n`
		+ `end\n`
		+ `local s = p.surface`;
}

function findPlatformIndex(host, name) {
	const r = lua(host, `local idx\n`
		+ `for _, pl in pairs(game.forces.player.platforms) do\n`
		+ `  if pl.name == '${name}' and pl.surface and pl.surface.valid then idx = pl.index end\n`
		+ `end\n`
		+ `return { success = true, index = idx }`);
	return typeof r.index === "number" ? r.index : null;
}

async function cloneFixture(sourceIndex) {
	const queued = lua(SOURCE_HOST, `local r = remote.call('surface_export', 'clone_platform', ${sourceIndex}, '${CLONE}')\n`
		+ `if not (r and r.success) then\n`
		+ `  return { success = false, error = 'clone refused: ' .. tostring(r and r.message) }\n`
		+ `end\n`
		+ `return { success = true, job_id = r.job_id, entity_count = r.entity_count }`);
	say(`clone of '${FIXTURE}' [${sourceIndex}] -> ${CLONE}: job=${queued.job_id} entities=${queued.entity_count}`);
	const deadline = Date.now() + CLONE_WAIT_MS;
	while (Date.now() < deadline) {
		await sleep(4000);
		const index = findPlatformIndex(SOURCE_HOST, CLONE);
		if (index !== null) return index;
	}
	throw new Error(`clone '${CLONE}' did not materialize within ${CLONE_WAIT_MS} ms`);
}

function buildAndArm() {
	const entitySpecs = RIG_ENTITIES.map(entity => `  { id = '${entity.id}', name = '${entity.name}', `
		+ `dx = ${entity.dx}, dy = ${entity.dy}`
		+ (entity.direction ? `, direction = ${entity.direction}` : "") + " },").join("\n");
	const writers = ATTRS.map(a => `writers["${a.key}"] = function(e)\n${a.write}\nend`).join("\n");
	const attrSpecs = ATTRS.map(a => `  { key = '${a.key}', on = '${a.on}' },`).join("\n");

	return lua(SOURCE_HOST, `${platformLua(CLONE)}
local maxx = -math.huge
for _, e in pairs(s.find_entities_filtered{}) do if e.position.x > maxx then maxx = e.position.x end end
if maxx == -math.huge then return { success = false, error = 'clone carries no entities' } end
local bx = math.floor(maxx) + 6
local by = 0
local tiles = {}
for x = bx, bx + 24 do
  for y = by, by + 15 do tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { x, y } } end
end
s.set_tiles(tiles)

local entity_specs = {
${entitySpecs}
}
local ents = {}
local placements = {}
for _, sp in ipairs(entity_specs) do
  local params = { name = sp.name, position = { bx + sp.dx, by + sp.dy }, force = 'player', raise_built = false }
  if sp.direction then params.direction = sp.direction end
  local ok, e = pcall(function() return s.create_entity(params) end)
  if ok and e and e.valid then
    ents[sp.id] = e
    placements[#placements + 1] = { id = sp.id, name = sp.name, placed = true,
      x = e.position.x, y = e.position.y, etype = e.type }
  else
    placements[#placements + 1] = { id = sp.id, name = sp.name, placed = false,
      error = ok and 'create_entity returned nil' or tostring(e) }
  end
end

local writers = {}
${writers}
local readers = {}
${readersLua()}

local attr_specs = {
${attrSpecs}
}
local armed = {}
for _, a in ipairs(attr_specs) do
  local e = ents[a.on]
  local row = { key = a.key, on = a.on }
  if not e then
    row.armed = false
    row.error = 'rig entity ' .. a.on .. ' was not placed'
  else
    local w_ok, w_err = pcall(function() writers[a.key](e) end)
    local r_ok, r_val = pcall(function() return readers[a.key](e) end)
    row.armed = w_ok and r_ok
    row.value = r_ok and r_val or ('THREW: ' .. tostring(r_val))
    if not w_ok then row.error = 'write threw: ' .. tostring(w_err) end
    row.entity_name = e.name
    row.x = e.position.x
    row.y = e.position.y
  end
  armed[#armed + 1] = row
end
return { success = true, base = { x = bx, y = by }, placements = placements, armed = armed }`);
}

function readDestination(targets) {
	const targetLua = targets.map(t => `  { key = '${t.key}', name = '${t.entity_name}', x = ${t.x}, y = ${t.y} },`).join("\n");
	return lua(DEST_HOST, `${platformLua(CLONE)}
local readers = {}
${readersLua()}
local targets = {
${targetLua}
}
local rows = {}
for _, t in ipairs(targets) do
  local found = s.find_entities_filtered{ name = t.name, position = { t.x, t.y }, radius = 0.3 }
  local e = found and found[1]
  local row = { key = t.key }
  if not (e and e.valid) then
    row.found = false
  else
    row.found = true
    local ok, v = pcall(function() return readers[t.key](e) end)
    row.value = ok and v or ('THREW: ' .. tostring(v))
  end
  rows[#rows + 1] = row
end
return { success = true, rows = rows }`);
}

function checkInert() {
	say("\n=== DECLARED-INERT screen (live prototype predicates) ===");
	for (const candidate of INERT_CANDIDATES) {
		const r = lua(SOURCE_HOST, `local function count()\n${candidate.count}\nend\n`
			+ `return { success = true, n = count() }`);
		if (typeof r.n !== "number") {
			fail(`${candidate.attribute}: predicate returned ${JSON.stringify(r.n)} rather than a number — `
				+ "inertness is undecided, so no verdict is safe");
		} else if (r.n === 0) {
			say(`  DECLARED-INERT ${candidate.attribute} — zero prototypes match "${candidate.predicate}" at this `
				+ "pin, so no rig can exercise it; capture and restore ship but never fire");
		} else {
			fail(`${candidate.attribute}: ${r.n} prototype(s) now match "${candidate.predicate}" — the engine `
				+ "supports this attribute now and this test does NOT exercise it; extend the rig");
		}
	}
}

function adjudicateGate() {
	const summary = execFileSync("node", ["tools/tests/testkit/cli.mjs", "log", "latest", "--field", "summary"],
		{ encoding: "utf8", timeout: 120_000, cwd: REPO_ROOT }).trim();
	const result = summary.match(/"result": "(\w+)"/);
	const validation_success = result !== null && result[1] === "SUCCESS";
	say(`  gate verdict: ${result ? result[1] : "UNPARSEABLE"}`);
	if (!validation_success) {
		fail("the transfer did not pass the gate — destination reads below would describe a rolled-back "
			+ `or partial import, not a restoration (summary: ${summary.slice(0, 400)})`);
	}
	return validation_success;
}

async function main() {
	say(`=== config-attrs: ten config attributes across a real transfer (clone '${CLONE}') ===`);

	const fixtureIndex = findPlatformIndex(SOURCE_HOST, FIXTURE);
	if (fixtureIndex === null) {
		throw new Error(`'${FIXTURE}' not found on host ${SOURCE_HOST} — wrong save loaded?`);
	}
	say(`fixture '${FIXTURE}' resolved to index ${fixtureIndex} on host ${SOURCE_HOST}`);

	checkInert();

	try {
		const cloneIndex = await cloneFixture(fixtureIndex);
		say(`clone ready at index ${cloneIndex}`);

		say("\n=== SOURCE: build rig, write non-default values, read back ===");
		const built = buildAndArm();
		say(`  rig base at (${built.base.x}, ${built.base.y})`);
		for (const placement of asArray(built.placements)) {
			if (placement.placed) {
				say(`  built ${placement.name} (${placement.etype}) at ${placement.x},${placement.y}`);
			} else {
				fail(`rig entity '${placement.name}' did NOT place (${placement.error}) — every attribute on it `
					+ "is UNEXERCISED, which is a hole in this test, not a pass");
			}
		}

		const armedRows = asArray(built.armed);
		const armedByKey = new Map(armedRows.map(row => [row.key, row]));
		const exercisable = [];
		for (const spec of ATTRS) {
			const row = armedByKey.get(spec.key);
			if (!row) {
				fail(`${spec.key}: no arming row came back — not exercised`);
				continue;
			}
			if (!row.armed) {
				fail(`${spec.key}: source arming failed (${row.error ?? "unknown"}) — not exercised`);
				continue;
			}
			if (row.value !== spec.expect) {
				fail(`${spec.key}: source read back ${JSON.stringify(row.value)} after writing the non-default, `
					+ `expected ${JSON.stringify(spec.expect)} — the write did not stick, so a matching `
					+ "destination value would prove nothing");
				continue;
			}
			say(`  armed ${spec.key} on ${row.entity_name}@${row.x},${row.y} = ${JSON.stringify(row.value)}`);
			exercisable.push({ ...spec, entity_name: row.entity_name, x: row.x, y: row.y });
		}
		if (exercisable.length === 0) {
			fail("no attribute was armed on the source — the transfer below cannot measure anything");
			return;
		}

		say(`\n=== TRANSFER: host ${SOURCE_HOST} -> host ${DEST_HOST} through the production path ===`);
		const transferOut = execFileSync("pwsh", ["-NoProfile", "-File", "tools/surface-export/transfer-platform.ps1",
			"-PlatformIndex", String(cloneIndex), "-Direction", `${SOURCE_HOST}to${DEST_HOST}`],
		{ encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"], cwd: REPO_ROOT });
		if (!/Export queued/.test(transferOut)) {
			throw new Error(`transfer-platform.ps1 did not queue: ${transferOut.slice(-300)}`);
		}

		let arrived = null;
		const deadline = Date.now() + ARRIVAL_WAIT_MS;
		while (Date.now() < deadline) {
			await sleep(3000);
			arrived = findPlatformIndex(DEST_HOST, CLONE);
			if (arrived !== null && findPlatformIndex(SOURCE_HOST, CLONE) === null) break;
		}
		if (arrived === null) {
			fail(`'${CLONE}' never arrived on host ${DEST_HOST} — nothing to read`);
			return;
		}
		say(`  arrived on host ${DEST_HOST} at index ${arrived}, source copy gone`);

		if (!adjudicateGate()) return;

		say("\n=== DESTINATION: physical readback on the arrived entities ===");
		const destRows = asArray(readDestination(exercisable).rows);
		const destByKey = new Map(destRows.map(row => [row.key, row]));
		for (const spec of exercisable) {
			const row = destByKey.get(spec.key);
			if (!row) {
				fail(`${spec.key}: no destination row came back`);
			} else if (!row.found) {
				fail(`${spec.key}: '${spec.entity_name}' not found on the destination at ${spec.x},${spec.y}`);
			} else if (row.value !== spec.expect) {
				fail(`${spec.key}: destination reads ${JSON.stringify(row.value)}, expected `
					+ `${JSON.stringify(spec.expect)} — the attribute did NOT survive the transfer`);
			} else {
				pass(`${spec.key} survived: ${spec.entity_name}@${spec.x},${spec.y} reads `
					+ `${JSON.stringify(row.value)}`);
			}
		}
	} finally {
		say("\n=== SWEEP ===");
		for (const host of [SOURCE_HOST, DEST_HOST]) {
			try {
				const swept = lua(host, `local deleted = 0\n`
					+ `for _, pl in pairs(game.forces.player.platforms) do\n`
					+ `  if pl.valid and pl.name == '${CLONE}' then\n`
					+ `    if pl.surface and pl.surface.valid then game.delete_surface(pl.surface) end\n`
					+ `    deleted = deleted + 1\n`
					+ `  end\n`
					+ `end\n`
					+ `return { success = true, deleted = deleted }`);
				say(`  host ${host}: delete_surface issued for ${swept.deleted} platform(s)`);
			} catch (error) {
				console.error(error && error.stack ? error.stack : error);
				fail(`sweep on host ${host} threw: ${error.message} — hand-clean with `
					+ "tools/tests/cleanup-test-surfaces.ps1 (prefix cfgattr- is in its sweep list)");
			}
		}
		await sleep(4000);
		for (const host of [SOURCE_HOST, DEST_HOST]) {
			try {
				const left = findPlatformIndex(host, CLONE);
				if (left !== null) fail(`sweep left '${CLONE}' on host ${host} (index ${left})`);
				else say(`  host ${host}: zero leftovers`);
			} catch (error) {
				console.error(error && error.stack ? error.stack : error);
				fail(`leftover check on host ${host} threw: ${error.message} — treating as a leftover`);
			}
		}
		try {
			const paused = lua(SOURCE_HOST, "return { success = true, paused = game.tick_paused }");
			if (paused.paused === true) fail("the game was left tick_paused");
			else say("  game unpaused");
		} catch (error) {
			console.error(error && error.stack ? error.stack : error);
			fail(`pause check threw: ${error.message}`);
		}
	}
}

main().then(() => {
	if (problems.length) {
		say(`\n=== config-attrs: ${problems.length} FAILURE(S) ===`);
		for (const problem of problems) say(`  - ${problem}`);
		process.exitCode = 1;
	} else {
		say("\n=== config-attrs: ALL PASS ===");
	}
}).catch(error => {
	console.error(`config-attrs: fatal — ${error && error.stack ? error.stack : error}`);
	process.exitCode = 1;
});
