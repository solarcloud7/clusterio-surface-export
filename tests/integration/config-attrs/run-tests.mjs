#!/usr/bin/env node
// config-attrs — every mechanical config attribute drained from the coverage ledger must survive a
// real host-1 -> host-2 transfer
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

function matches(spec, actual, expected) {
	if (actual === undefined || expected === undefined) return false;
	return spec.compare ? spec.compare(actual, expected) : actual === expected;
}

const RIG_ENTITIES = [
	{ id: "loader", name: "turbo-loader", dx: 1.5, dy: 2, direction: "defines.direction.south" },
	{ id: "loader1x1", name: "loader-1x1", dx: 4.5, dy: 1.5 },
	{ id: "chest", name: "storage-chest", dx: 7.5, dy: 1.5 },
	{ id: "valve", name: "overflow-valve", dx: 10.5, dy: 1.5 },
	{ id: "inserter", name: "bulk-inserter", dx: 13.5, dy: 1.5 },
	{ id: "wall", name: "stone-wall", dx: 16.5, dy: 1.5 },
	{ id: "silo", name: "rocket-silo", dx: 18.5, dy: 8.5 },
	{ id: "plant", name: "jellystem", dx: 1.5, dy: 16.5 },
	{ id: "linkedbelt", name: "linked-belt", dx: 4.5, dy: 16.5 },
	{ id: "linkedchest", name: "linked-chest", dx: 7.5, dy: 16.5 },
	{ id: "infchest", name: "infinity-chest", dx: 10.5, dy: 16.5 },
	{ id: "display", name: "display-panel", dx: 13.5, dy: 16.5 },
	{ id: "speaker", name: "programmable-speaker", dx: 16.5, dy: 16.5 },
	{ id: "asm", name: "assembling-machine-3", dx: 21.5, dy: 17.5 },
];

const TICK_DRIFT_TOLERANCE = 60_000;

const NUMERIC_READ = attr => `local v = e.${attr}; if v == nil then return "nil" end return string.format("%.6f", v)`;
const BOOL_READ = attr => `return tostring(e.${attr})`;
const STRING_READ = attr => `return tostring(e.${attr})`;

const READER_HELPERS = `local function q_name(v)
  if v == nil then return "nil" end
  if type(v) == "string" then return v end
  return tostring(v.name)
end
local function num(v)
  if v == nil then return "nil" end
  return string.format("%.6g", v)
end
local function define_name(table_of_defines, value)
  if value == nil then return "nil" end
  for k, v in pairs(table_of_defines) do
    if v == value then return k end
  end
  return "unknown:" .. tostring(value)
end
local function signal_key(sig)
  if sig == nil then return "none" end
  local quality = "normal"
  if sig.quality ~= nil then quality = q_name(sig.quality) end
  return string.format("%s:%s:%s", tostring(sig.type or "item"), q_name(sig.name), quality)
end
local function sections_key(v)
  if v == nil then return "nil" end
  local parts = {}
  for _, sec in ipairs(v.sections or {}) do
    local fparts = {}
    for _, f in ipairs(sec.filters or {}) do
      local val = f.value or {}
      fparts[#fparts + 1] = string.format("%s@%s>=%s", q_name(val.name), q_name(val.quality), num(f.min))
    end
    parts[#parts + 1] = string.format("[m=%s a=%s {%s}]", num(sec.multiplier), tostring(sec.active),
      table.concat(fparts, ","))
  end
  return string.format("trash=%s %s", tostring(v.trash_not_requested), table.concat(parts, ";"))
end`;

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
		write: "e.send_to_orbit_automatically = not e.send_to_orbit_automatically",
		read: BOOL_READ("send_to_orbit_automatically"),
		dynamicExpect: true,
	},
	{
		key: "use_transitional_requests", attribute: "use_transitional_requests", on: "silo",
		write: "e.use_transitional_requests = not e.use_transitional_requests",
		read: BOOL_READ("use_transitional_requests"),
		dynamicExpect: true,
	},
	{
		key: "name_tag_wall", attribute: "name_tag", on: "wall",
		write: `e.name_tag = "${CLONE}-wall"`, read: STRING_READ("name_tag"), expect: `${CLONE}-wall`,
	},
	{
		key: "name_tag_loader", attribute: "name_tag", on: "loader",
		write: `e.name_tag = "${CLONE}-loader"`, read: STRING_READ("name_tag"), expect: `${CLONE}-loader`,
	},
	{
		key: "tick_grown", attribute: "tick_grown", on: "plant",
		write: "e.tick_grown = game.tick + 400000",
		read: 'return string.format("%d", e.tick_grown - game.tick)',
		expect: "400000",
		compare: (actual, expected) => {
			const a = Number(actual);
			const b = Number(expected);
			return Number.isFinite(a) && Number.isFinite(b) && a <= b && b - a <= TICK_DRIFT_TOLERANCE;
		},
		describe: `the remaining grow ticks must land within ${TICK_DRIFT_TOLERANCE} ticks below the armed `
			+ "value — an absolute tick carried raw would arrive as the SOURCE clock, and a fresh plant "
			+ "would read its own prototype grow time",
	},
	{
		key: "result_quality", attribute: "result_quality", on: "asm",
		write: 'e.set_recipe("iron-gear-wheel")\n'
			+ 'e.get_inventory(defines.inventory.crafter_output).insert{ name = "iron-gear-wheel", count = 100000 }\n'
			+ "e.crafting_progress = 1.0\n"
			+ 'e.result_quality = "rare"',
		read: "return q_name(e.result_quality)", expect: "rare",
		describe: "result_quality is nil unless a craft is IN PROGRESS, so the rig holds one open by filling "
			+ "the output — a machine that can eject its product finishes the craft within ~90 ticks of "
			+ "getting power and the attribute is gone before any transfer can carry it",
	},
	{
		key: "display_panel_icon", attribute: "display_panel_icon", on: "display",
		write: 'e.display_panel_icon = { type = "item", name = "iron-plate" }',
		read: "return signal_key(e.display_panel_icon)", expect: "item:iron-plate:normal",
	},
	{
		key: "alert_parameters", attribute: "alert_parameters", on: "speaker",
		write: 'e.alert_parameters = { show_alert = true, show_on_map = false, '
			+ `icon_signal_id = { type = "item", name = "iron-plate" }, alert_message = "${CLONE}-alert" }`,
		read: 'local a = e.alert_parameters\n'
			+ 'if a == nil then return "nil" end\n'
			+ 'return string.format("%s|%s|%s|%s", tostring(a.show_alert), tostring(a.show_on_map),\n'
			+ '  tostring(a.alert_message), signal_key(a.icon_signal_id))',
		expect: `true|false|${CLONE}-alert|item:iron-plate:normal`,
	},
	{
		key: "custom_status", attribute: "custom_status", on: "wall",
		write: 'e.custom_status = { diode = defines.entity_status_diode.yellow, '
			+ `label = { "", "${CLONE}-status" } }`,
		read: 'local c = e.custom_status\n'
			+ 'if c == nil then return "nil" end\n'
			+ 'local label = c.label\n'
			+ 'if type(label) == "table" then label = table.concat(label, "/") end\n'
			+ 'return define_name(defines.entity_status_diode, c.diode) .. "|" .. tostring(label)',
		expect: `yellow|/${CLONE}-status`,
	},
	{
		key: "override_logistic_mode", attribute: "override_logistic_mode", on: "infchest",
		write: "e.override_logistic_mode = defines.logistic_mode.buffer",
		read: "return define_name(defines.logistic_mode, e.override_logistic_mode)", expect: "buffer",
	},
	{
		key: "saved_request_filters", attribute: "saved_request_filters", on: "infchest",
		write: "e.saved_request_filters = { sections = { { index = 1, filters = { { index = 1, "
			+ 'value = { type = "item", name = "iron-plate", quality = "normal", comparator = "=" }, '
			+ "min = 42 } }, multiplier = 2 } }, trash_not_requested = true }",
		read: "return sections_key(e.saved_request_filters)",
		expect: "trash=true [m=2 a=true {iron-plate@normal>=42}]",
	},
	{
		key: "saved_storage_filters", attribute: "saved_storage_filters", on: "infchest",
		write: "e.saved_storage_filters = { sections = { { index = 1, filters = { { index = 1, "
			+ 'value = { type = "item", name = "copper-plate", quality = "normal", comparator = "=" }, '
			+ "min = 7 } }, multiplier = 3 } }, trash_not_requested = false }",
		read: "return sections_key(e.saved_storage_filters)",
		expect: "trash=false [m=3 a=true {copper-plate@normal>=7}]",
	},
	{
		key: "saved_request_from_buffers", attribute: "saved_request_from_buffers", on: "infchest",
		write: "e.saved_request_from_buffers = not e.saved_request_from_buffers",
		read: BOOL_READ("saved_request_from_buffers"), dynamicExpect: true,
	},
	{
		key: "saved_set_requests", attribute: "saved_set_requests", on: "infchest",
		write: "e.saved_set_requests = not e.saved_set_requests",
		read: BOOL_READ("saved_set_requests"), dynamicExpect: true,
	},
	{
		key: "linked_belt_type", attribute: "linked_belt_type", on: "linkedbelt",
		write: 'e.linked_belt_type = "output"', read: STRING_READ("linked_belt_type"), expect: "output",
	},
	{
		key: "link_id", attribute: "link_id", on: "linkedchest",
		write: "e.link_id = 4242", read: 'return string.format("%d", e.link_id)', expect: "4242",
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
	return `${READER_HELPERS}\n`
		+ ATTRS.map(a => `readers["${a.key}"] = function(e)\n${a.read}\nend`).join("\n");
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
for x = bx, bx + 28 do
  for y = by, by + 22 do tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { x, y } } end
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
    local d_ok, d_val = pcall(function() return readers[a.key](e) end)
    if d_ok then row.default = d_val end
    local w_ok, w_err = pcall(function() writers[a.key](e) end)
    local r_ok, r_val = pcall(function() return readers[a.key](e) end)
    row.armed = w_ok and r_ok
    if r_ok then row.value = r_val else row.value = 'THREW: ' .. tostring(r_val) end
    if not w_ok then row.error = 'write threw: ' .. tostring(w_err) end
    row.entity_name = e.name
    row.x = e.position.x
    row.y = e.position.y
  end
  armed[#armed + 1] = row
end
return { success = true, base = { x = bx, y = by }, placements = placements, armed = armed }`);
}

function readRig(host, targets) {
	const targetLua = targets.map(t => `  { key = '${t.key}', name = '${t.entity_name}', x = ${t.x}, y = ${t.y} },`).join("\n");
	return lua(host, `${platformLua(CLONE)}
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
    if ok then row.value = v else row.value = 'THREW: ' .. tostring(v) end
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
			if (row.default === undefined) {
				fail(`${spec.key}: the fresh entity's default could not be read, so the armed value cannot be `
					+ "shown non-default — a matching destination read would prove nothing");
				continue;
			}
			const effectiveExpect = spec.dynamicExpect ? row.value : spec.expect;
			if (!spec.dynamicExpect && !matches(spec, row.value, spec.expect)) {
				fail(`${spec.key}: source read back ${JSON.stringify(row.value)} after writing the non-default, `
					+ `expected ${JSON.stringify(spec.expect)} — the write did not stick, so a matching `
					+ `destination value would prove nothing${spec.describe ? ` (${spec.describe})` : ""}`);
				continue;
			}
			if (matches(spec, row.default, effectiveExpect)) {
				fail(`${spec.key}: the armed value equals the fresh entity's default `
					+ `(${JSON.stringify(row.default)}) — a matching destination read would prove nothing; `
					+ "arm the negation of the default instead");
				continue;
			}
			say(`  armed ${spec.key} on ${row.entity_name}@${row.x},${row.y} = ${JSON.stringify(row.value)}`
				+ ` (fresh default was ${JSON.stringify(row.default)})`);
			exercisable.push({ ...spec, expect: effectiveExpect, entity_name: row.entity_name, x: row.x, y: row.y });
		}
		if (exercisable.length === 0) {
			fail("no attribute was armed on the source — the transfer below cannot measure anything");
			return;
		}

		say("\n=== SOURCE: re-read at the moment the export scan will see ===");
		const preRows = asArray(readRig(SOURCE_HOST, exercisable).rows);
		const preByKey = new Map(preRows.map(row => [row.key, row]));
		const surviving = [];
		for (const spec of exercisable) {
			const row = preByKey.get(spec.key);
			if (!row || !row.found) {
				fail(`${spec.key}: '${spec.entity_name}' vanished from the source rig before the export`);
			} else if (!matches(spec, row.value, spec.expect)) {
				fail(`${spec.key}: the source now reads ${JSON.stringify(row.value)}, not the armed `
					+ `${JSON.stringify(spec.expect)} — the value decayed BEFORE the export scan, so the export `
					+ "cannot carry it and a destination miss would not be a restore defect");
			} else {
				surviving.push(spec);
			}
		}
		if (surviving.length === 0) {
			fail("no armed value survived to the export scan — the transfer below cannot measure anything");
			return;
		}
		say(`  ${surviving.length}/${exercisable.length} armed values still present on the source`);

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
		const destRows = asArray(readRig(DEST_HOST, surviving).rows);
		const destByKey = new Map(destRows.map(row => [row.key, row]));
		for (const spec of surviving) {
			const row = destByKey.get(spec.key);
			if (!row) {
				fail(`${spec.key}: no destination row came back`);
			} else if (!row.found) {
				fail(`${spec.key}: '${spec.entity_name}' not found on the destination at ${spec.x},${spec.y}`);
			} else if (!matches(spec, row.value, spec.expect)) {
				fail(`${spec.key}: destination reads ${JSON.stringify(row.value)}, expected `
					+ `${JSON.stringify(spec.expect)} — the attribute did NOT survive the transfer`
					+ `${spec.describe ? ` (${spec.describe})` : ""}`);
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
