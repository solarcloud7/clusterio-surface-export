#!/usr/bin/env node
// belt-item-state — item-level scalar state on a stack riding a BELT must survive a real
// host-1 -> host-2 transfer, the same way the inventory path already carries it
//
// requires: the cluster up, lab-transfer-fixture-v1 on host-1, host-2 able to receive
// produces: per-row SOURCE arming with the fresh default measured first, a pre-export re-read,
//           the gate verdict read before any destination read (bound to this clone by name), a
//           DESTINATION physical readback taken off the arrived belt stack itself, a PAIR row of
//           two same-item stacks with different state on ONE line (the only row where the restore's
//           arrival diff has a non-empty baseline to get wrong), and the destination's own
//           applied/unmatched/failed counters read back from its log, bound to this clone by the
//           platform name the restore emits in that line
// does not: read the export payload (payload presence is not restoration); assert item or fluid
//           fidelity (the gate does that); touch the protected fixtures (it transfers a CLONE);
//           cover blueprint CONTENT (export_string has no belt restore path and is excluded from
//           the captured state); cover the over-compression merge path, which discards one of two
//           merged states by construction

import { lua as luaRaw, sleep, docker, HOSTS, REPO_ROOT } from "../../lab-gallery/batch-lifecycle.mjs";
import { execFileSync } from "node:child_process";

const SOURCE_HOST = 1;
const DEST_HOST = 2;
const FIXTURE = "lab-transfer-fixture-v1";
const CLONE = `beltstate-${Date.now().toString(36)}`;
const CLONE_WAIT_MS = 300_000;
const ARRIVAL_WAIT_MS = 300_000;
const SPOIL_HEADROOM_TICKS = 108_000;

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

const ARMED_SPOIL = 0.35;
const SPOIL_BAND = 0.2;
const PAIR_ITEM = "pistol";
const PAIR_HEALTHS = [0.25, 0.75];
const PAIR_EXPECT = PAIR_HEALTHS.map(h => h.toFixed(4)).sort();
const STATE_LOG_MARKER = `[BeltRestoration] ITEM STATE ${CLONE}:`;
const STATE_LOG_ATTEMPTS = 10;

const COLOR_READ = expr => `(function() local c = ${expr} `
	+ `return c and string.format("%.2f/%.2f/%.2f", c.r, c.g, c.b) or "nil" end)()`;

const SECTIONS = [{ index: 1, multiplier: 3 }, { index: 2, multiplier: 7 }];
const SECTIONS_WRITE = `{ sections = { ${SECTIONS.map(s => `{ index = ${s.index}, multiplier = ${s.multiplier} }`)
	.join(", ")} } }`;
const SECTIONS_EXPECT = `n=${SECTIONS.length} ${SECTIONS.map(s => `${s.index}:${s.multiplier}`).join(",")}`;

const READER_HELPERS = `local function num(v)
  if v == nil then return "nil" end
  return string.format("%.6g", v)
end
local function item_sections_key(v)
  if v == nil then return "nil" end
  local parts = {}
  for _, sec in ipairs(v.sections or {}) do
    parts[#parts + 1] = string.format("%s:%s", tostring(sec.index), num(sec.multiplier))
  end
  return string.format("n=%d %s", #parts, table.concat(parts, ","))
end`;

const ROWS = [
	{
		key: "spoil_percent",
		item: "bioflux",
		write: `st.spoil_percent = ${ARMED_SPOIL}`,
		read: 'string.format("%.4f", st.spoil_percent)',
		expect: String(ARMED_SPOIL.toFixed(4)),
		compare: (actual, expected) => {
			const got = Number(actual);
			const want = Number(expected);
			return Number.isFinite(got) && got >= want - 0.005 && got <= want + SPOIL_BAND;
		},
		describe: `a band comparator: spoilage advances in real time, so the destination must read `
			+ `[${ARMED_SPOIL}, ${ARMED_SPOIL + SPOIL_BAND}] — a fresh stack reads 0.0000`,
	},
	{
		key: "health",
		item: "submachine-gun",
		write: "st.health = 0.375",
		read: 'string.format("%.4f", st.health)',
		expect: "0.3750",
	},
	{
		key: "ammo",
		item: "firearm-magazine",
		write: "st.ammo = 3",
		read: 'string.format("%.4f", st.ammo)',
		expect: "3.0000",
	},
	{
		key: "durability",
		item: "repair-pack",
		write: "st.durability = 77",
		read: 'string.format("%.4f", st.durability)',
		expect: "77.0000",
	},
	{
		key: "label",
		item: "blueprint",
		write: 'st.label = LABEL_TEXT st.label_color = { r = 0.25, g = 0.5, b = 0.75, a = 1 }',
		read: `tostring(st.label) .. "|" .. ${COLOR_READ("st.label_color")}`,
		expect: `${CLONE}-bp|0.25/0.50/0.75`,
	},
	{
		key: "entity_data",
		item: "spidertron",
		write: "st.entity_color = { r = 0.9, g = 0.1, b = 0.2, a = 1 } st.entity_logistics_enabled = false "
			+ `st.entity_logistic_sections = ${SECTIONS_WRITE}`,
		read: `${COLOR_READ("st.entity_color")} .. "|" .. tostring(st.entity_logistics_enabled) `
			+ '.. "|" .. item_sections_key(st.entity_logistic_sections)',
		expect: `0.90/0.10/0.20|false|${SECTIONS_EXPECT}`,
		describe: "the sections value must survive capture, the payload's JSON encode, the restore write and "
			+ "a destination read — the belt path's own measurement of the read the inventory path already "
			+ "carries (config-attrs item_entity_logistic_sections). It is armed away from the fresh default, "
			+ "whose sections carry no multiplier, so a destination match cannot come from an item that was "
			+ "never armed. The section key formatter is nil-tolerant for exactly that reason",
	},
];

function matches(spec, actual, expected) {
	if (actual === undefined || expected === undefined) return false;
	return spec.compare ? spec.compare(actual, expected) : actual === expected;
}

function platformLua(name) {
	return `local p\n`
		+ `for _, pl in pairs(game.forces.player.platforms) do\n`
		+ `  if pl.valid and pl.name == '${name}' then p = pl end\n`
		+ `end\n`
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

const readersLua = `${READER_HELPERS}\n`
	+ ROWS.map(row => `readers["${row.key}"] = function(st) return ${row.read} end`).join("\n");
const rowSpecsLua = ROWS.map(row => `  { key = '${row.key}', item = '${row.item}' },`).join("\n");

const SCAN_LUA = `local readers = {}
${readersLua}
local row_specs = {
${rowSpecsLua}
}
local BELT = { ["transport-belt"] = true, ["underground-belt"] = true, ["splitter"] = true,
  ["lane-splitter"] = true, ["linked-belt"] = true, ["loader"] = true, ["loader-1x1"] = true }
local by_item = {}
for _, e in pairs(s.find_entities_filtered{}) do
  if e.valid and BELT[e.type] then
    for li = 1, e.get_max_transport_line_index() do
      local line = e.get_transport_line(li)
      if line and line.valid then
        for _, it in ipairs(line.get_detailed_contents()) do
          if it.stack and it.stack.valid_for_read then
            local bucket = by_item[it.stack.name]
            if not bucket then bucket = {} by_item[it.stack.name] = bucket end
            bucket[#bucket + 1] = { stack = it.stack, entity = e, li = li }
          end
        end
      end
    end
  end
end
local rows = {}
for _, spec in ipairs(row_specs) do
  local bucket = by_item[spec.item] or {}
  local row = { key = spec.key, item = spec.item, stacks = #bucket }
  if #bucket == 1 then
    local hit = bucket[1]
    row.found = true
    row.count = hit.stack.count
    row.quality = hit.stack.quality and hit.stack.quality.name or "normal"
    local ok, value = pcall(readers[spec.key], hit.stack)
    row.value = ok and tostring(value) or nil
    if not ok then row.read_error = tostring(value) end
    row.at = string.format("%s (%.1f, %.1f) line %d", hit.entity.name,
      hit.entity.position.x, hit.entity.position.y, hit.li)
  else
    row.found = false
  end
  rows[#rows + 1] = row
end
return { success = true, rows = rows }`;

function readRows(host, platformName) {
	return lua(host, `${platformLua(platformName)}\n${SCAN_LUA}`);
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
	const writers = ROWS.map(row => `writers["${row.key}"] = function(st) ${row.write} end`).join("\n");
	const specs = ROWS.map((row, i) => `  { key = '${row.key}', item = '${row.item}', dy = ${i * 3} },`).join("\n");

	return lua(SOURCE_HOST, `${platformLua(CLONE)}
local LABEL_TEXT = '${CLONE}-bp'
local readers = {}
${readersLua}
local writers = {}
${writers}
local row_specs = {
${specs}
}
local maxx = -math.huge
for _, e in pairs(s.find_entities_filtered{}) do if e.position.x > maxx then maxx = e.position.x end end
if maxx == -math.huge then return { success = false, error = 'clone carries no entities' } end
local bx = math.floor(maxx) + 6
local tiles = {}
for x = bx, bx + 4 do
  for y = 0, #row_specs * 3 + 2 do tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { x, y } } end
end
s.set_tiles(tiles)

local rows = {}
for _, spec in ipairs(row_specs) do
  local row = { key = spec.key, item = spec.item }
  if not prototypes.item[spec.item] then
    row.error = 'no such item prototype at this pin'
  else
    local belt = s.create_entity{ name = 'transport-belt', position = { bx + 1.5, spec.dy + 0.5 },
      force = 'player', direction = defines.direction.east, raise_built = false }
    if not (belt and belt.valid) then
      row.error = 'belt did not place'
    else
      row.at = string.format("%.1f, %.1f", belt.position.x, belt.position.y)
      local line = belt.get_transport_line(1)
      row.inserted = line.insert_at(0.2, { name = spec.item, count = 1 })
      local st
      for _, it in ipairs(line.get_detailed_contents()) do
        if it.stack.valid_for_read and it.stack.name == spec.item then st = it.stack end
      end
      if not st then
        row.error = 'item did not land on the belt'
      else
        local dok, dval = pcall(readers[spec.key], st)
        row.default = dok and tostring(dval) or nil
        if not dok then row.default_error = tostring(dval) end
        local wok, werr = pcall(writers[spec.key], st)
        row.armed = wok
        if not wok then row.write_error = tostring(werr) end
        local vok, vval = pcall(readers[spec.key], st)
        row.value = vok and tostring(vval) or nil
        if not vok then row.read_error = tostring(vval) end
      end
    end
  end
  rows[#rows + 1] = row
end

local pair = { item = '${PAIR_ITEM}' }
if not prototypes.item[pair.item] then
  pair.error = 'no such item prototype at this pin'
else
  local py = #row_specs * 3
  local belt = s.create_entity{ name = 'transport-belt', position = { bx + 1.5, py + 0.5 },
    force = 'player', direction = defines.direction.east, raise_built = false }
  if not (belt and belt.valid) then
    pair.error = 'pair belt did not place'
  else
    local line = belt.get_transport_line(1)
    pair.at = string.format("%.1f, %.1f", belt.position.x, belt.position.y)
    local wanted = { ${PAIR_HEALTHS.join(", ")} }
    for i, _ in ipairs(wanted) do line.insert_at(0.9 - (i - 1) * 0.45, { name = pair.item, count = 1 }) end
    local stacks = {}
    local uids = {}
    for _, it in ipairs(line.get_detailed_contents()) do
      if it.stack.valid_for_read and it.stack.name == pair.item then
        stacks[#stacks + 1] = it.stack
        uids[#uids + 1] = it.unique_id
      end
    end
    pair.placed = #stacks
    pair.one_line = #stacks == #wanted and uids[1] ~= uids[2]
    pair.default = #stacks > 0 and string.format("%.4f", stacks[1].health) or nil
    local armed = {}
    for i, st in ipairs(stacks) do
      if wanted[i] then
        st.health = wanted[i]
        armed[#armed + 1] = string.format("%.4f", st.health)
      end
    end
    table.sort(armed)
    pair.armed = armed
  end
end

local proto = prototypes.item['bioflux']
local spoil_ticks = proto and proto.get_spoil_ticks and proto.get_spoil_ticks() or 0
return { success = true, rows = rows, pair = pair, bx = bx, spoil_ticks = spoil_ticks }`);
}

function readPair(host) {
	return lua(host, `${platformLua(CLONE)}
local BELT = { ["transport-belt"] = true, ["underground-belt"] = true, ["splitter"] = true,
  ["lane-splitter"] = true, ["linked-belt"] = true, ["loader"] = true, ["loader-1x1"] = true }
local healths = {}
local seen = {}
local lines = {}
for _, e in pairs(s.find_entities_filtered{}) do
  if e.valid and BELT[e.type] then
    for li = 1, e.get_max_transport_line_index() do
      local line = e.get_transport_line(li)
      if line and line.valid then
        for _, it in ipairs(line.get_detailed_contents()) do
          local uid = tostring(it.unique_id)
          if it.stack.valid_for_read and it.stack.name == '${PAIR_ITEM}' and not seen[uid] then
            seen[uid] = true
            healths[#healths + 1] = string.format("%.4f", it.stack.health)
            local shared = false
            for _, known in ipairs(lines) do if line.line_equals(known) then shared = true end end
            if not shared then lines[#lines + 1] = line end
          end
        end
      end
    end
  end
end
table.sort(healths)
return { success = true, healths = healths, lines_seen = #lines }`);
}

function adjudicateGate() {
	const summary = execFileSync("node", ["tools/tests/testkit/cli.mjs", "log", "latest", "--field", "summary"],
		{ encoding: "utf8", timeout: 120_000, cwd: REPO_ROOT }).trim();
	const named = summary.match(/"name": "([^"]+)"/);
	if (named === null || named[1] !== CLONE) {
		fail(`the newest transaction log record names ${JSON.stringify(named ? named[1] : null)}, not `
			+ `'${CLONE}' — on a shared cluster that verdict belongs to someone else's transfer and cannot `
			+ "adjudicate this one");
		return false;
	}
	const result = summary.match(/"result": "(\w+)"/);
	const validation_success = result !== null && result[1] === "SUCCESS";
	say(`  gate verdict for '${CLONE}': ${result ? result[1] : "UNPARSEABLE"}`);
	if (!validation_success) {
		fail("the transfer did not pass the gate — destination reads below would describe a rolled-back "
			+ `or partial import, not a restoration (summary: ${summary.slice(0, 400)})`);
	}
	return validation_success;
}

async function readStateCounters(host) {
	const path = `/clusterio/data/instances/${HOSTS[host].instance}/factorio-current.log`;
	for (let attempt = 1; attempt <= STATE_LOG_ATTEMPTS; attempt++) {
		const out = docker(["exec", HOSTS[host].container, "sh", "-c",
			`grep -aF '${STATE_LOG_MARKER}' ${path} | tail -1 || true`]);
		const hit = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop();
		if (hit) {
			const nums = hit.match(/applied (\d+) \| unmatched (\d+) \| failed (\d+) \| merge-discarded (\d+)/);
			if (nums) {
				return { line: hit, applied: Number(nums[1]), unmatched: Number(nums[2]),
					failed: Number(nums[3]), mergeDiscarded: Number(nums[4]) };
			}
		}
		if (attempt < STATE_LOG_ATTEMPTS) await sleep(1000);
	}
	return null;
}

async function main() {
	say(`=== belt-item-state: ${ROWS.length} item-state rows across a real transfer (clone '${CLONE}') ===`);

	const fixtureIndex = findPlatformIndex(SOURCE_HOST, FIXTURE);
	if (fixtureIndex === null) throw new Error(`fixture '${FIXTURE}' not found on host ${SOURCE_HOST}`);

	let cloneIndex = null;
	try {
		cloneIndex = await cloneFixture(fixtureIndex);
		say(`  clone ready at index ${cloneIndex}`);

		say("\n=== SOURCE: build the belt rig, measure each fresh default, then arm ===");
		const built = buildAndArm();
		const builtRows = asArray(built.rows);
		const byKey = new Map(builtRows.map(row => [row.key, row]));
		say(`  rig built at x=${built.bx}; bioflux spoil_ticks=${built.spoil_ticks}`);

		const spoilRemaining = built.spoil_ticks * (1 - ARMED_SPOIL);
		if (!(spoilRemaining >= SPOIL_HEADROOM_TICKS)) {
			fail(`bioflux armed at ${ARMED_SPOIL} leaves ${Math.round(spoilRemaining)} ticks before it turns into `
				+ `spoilage, under the ${SPOIL_HEADROOM_TICKS}-tick headroom this run needs. A stack that spoils `
				+ "mid-transfer changes its own item name, which fails the census gate for a reason that has "
				+ "nothing to do with state restoration — refusing rather than asserting thinly");
		}

		const pair = built.pair || {};
		const pairArmed = asArray(pair.armed);
		let pairExercisable = false;
		if (pair.error) {
			fail(`pair: ${pair.error}`);
		} else if (pair.one_line !== true || pair.placed !== PAIR_HEALTHS.length) {
			fail(`pair: needed ${PAIR_HEALTHS.length} distinct '${PAIR_ITEM}' stacks on ONE line, got `
				+ `${pair.placed} (distinct=${pair.one_line}). This is the only row whose restore has a non-empty `
				+ "baseline of pre-existing items to identify the landed stack against — without it the arrival "
				+ "diff is never asked a question it could get wrong");
		} else if (pairArmed.join(",") !== PAIR_EXPECT.join(",")) {
			fail(`pair: armed ${JSON.stringify(pairArmed)}, expected ${JSON.stringify(PAIR_EXPECT)}`);
		} else if (PAIR_EXPECT.includes(pair.default)) {
			fail(`pair: an armed health equals the fresh stack's default (${JSON.stringify(pair.default)}) — `
				+ "a matching destination read would prove nothing");
		} else {
			say(`  armed pair on 2 '${PAIR_ITEM}' stacks sharing one line @${pair.at} = `
				+ `${JSON.stringify(pairArmed)} (fresh default was ${JSON.stringify(pair.default)})`);
			pairExercisable = true;
		}

		const exercisable = [];
		for (const spec of ROWS) {
			const row = byKey.get(spec.key);
			if (!row) {
				fail(`${spec.key}: the rig builder returned no row`);
				continue;
			}
			if (row.error) {
				fail(`${spec.key}: ${row.error}`);
				continue;
			}
			if (!row.armed) {
				fail(`${spec.key}: the source write failed: ${row.write_error ?? "(no error text)"}`);
				continue;
			}
			if (row.default === undefined || row.default === null) {
				fail(`${spec.key}: could not read the fresh default (${row.default_error ?? "no value"}) — `
					+ "without it a destination match cannot be told apart from an item that was never armed");
				continue;
			}
			if (matches(spec, row.default, spec.expect)) {
				fail(`${spec.key}: the armed value equals the fresh stack's default (${JSON.stringify(row.default)}) `
					+ "— a matching destination read would prove nothing; arm away from the default instead");
				continue;
			}
			if (!matches(spec, row.value, spec.expect)) {
				fail(`${spec.key}: the source reads ${JSON.stringify(row.value)} right after arming, not `
					+ `${JSON.stringify(spec.expect)} — the arm itself did not take`);
				continue;
			}
			say(`  armed ${spec.key} on ${spec.item}@${row.at} = ${JSON.stringify(row.value)} `
				+ `(fresh default was ${JSON.stringify(row.default)})`);
			exercisable.push(spec);
		}
		if (exercisable.length === 0) {
			fail("no item state was armed on the source — the transfer below cannot measure anything");
			return;
		}

		say("\n=== SOURCE: re-read at the moment the export scan will see ===");
		const preByKey = new Map(asArray(readRows(SOURCE_HOST, CLONE).rows).map(row => [row.key, row]));
		const surviving = [];
		for (const spec of exercisable) {
			const row = preByKey.get(spec.key);
			if (!row || !row.found) {
				fail(`${spec.key}: expected exactly one '${spec.item}' stack on the source platform's belts, `
					+ `found ${row ? row.stacks : "no row"} — the rig is not measurable`);
			} else if (!matches(spec, row.value, spec.expect)) {
				fail(`${spec.key}: the source now reads ${JSON.stringify(row.value)}, not the armed `
					+ `${JSON.stringify(spec.expect)} — the value decayed BEFORE the export scan, so a `
					+ "destination miss would not be a restore defect");
			} else {
				surviving.push({ ...spec, sourceValue: row.value, sourceCount: row.count });
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

		say("\n=== DESTINATION: physical readback off the arrived belt stack ===");
		const destByKey = new Map(asArray(readRows(DEST_HOST, CLONE).rows).map(row => [row.key, row]));
		for (const spec of surviving) {
			const row = destByKey.get(spec.key);
			if (!row) {
				fail(`${spec.key}: no destination row came back`);
			} else if (!row.found) {
				fail(`${spec.key}: expected exactly one '${spec.item}' stack on the destination belts, found `
					+ `${row.stacks} — the item did not arrive on a belt`);
			} else if (row.count !== spec.sourceCount) {
				fail(`${spec.key}: destination stack count ${row.count} != source ${spec.sourceCount} — the `
					+ "state comparison below would be measuring a different stack");
			} else if (!matches(spec, row.value, spec.expect)) {
				fail(`${spec.key}: destination belt reads ${JSON.stringify(row.value)}, expected `
					+ `${JSON.stringify(spec.expect)} — the item state did NOT survive the transfer`
					+ `${spec.describe ? ` (${spec.describe})` : ""}`);
			} else {
				pass(`${spec.key} survived on a belt: ${spec.item}@${row.at} reads ${JSON.stringify(row.value)}`);
			}
		}

		if (pairExercisable) {
			const destPair = readPair(DEST_HOST);
			const got = asArray(destPair.healths);
			if (destPair.lines_seen !== 1 || got.length !== PAIR_HEALTHS.length) {
				fail(`pair: the destination carries ${got.length} '${PAIR_ITEM}' stack(s) across `
					+ `${destPair.lines_seen} line(s), expected ${PAIR_HEALTHS.length} on 1`);
			} else if (got.join(",") !== PAIR_EXPECT.join(",")) {
				fail(`pair: destination healths ${JSON.stringify(got)}, expected ${JSON.stringify(PAIR_EXPECT)} — `
					+ "two same-item stacks restored onto one line each kept their OWN state only if the restore "
					+ "identified the stack its write actually landed; a duplicated value here is one state written "
					+ "twice onto the wrong stacks");
			} else {
				pass(`pair survived on one shared line: two '${PAIR_ITEM}' stacks read ${JSON.stringify(got)}, `
					+ "each keeping its own health");
			}
		}

		say("\n=== DESTINATION: the restore's own item-state counters ===");
		const counters = await readStateCounters(DEST_HOST);
		if (counters === null) {
			fail(`the destination emitted no "${STATE_LOG_MARKER}" line for THIS clone — the belt restore either `
				+ "never applied any item state or never reported it, and the rows above cannot distinguish "
				+ "those. The marker carries the platform name because the log file is persistent and shared: "
				+ "an unbound read would find a PREVIOUS run's line and pass in exactly the total-regression "
				+ "case this assertion exists for (the line is emitted only when some counter is non-zero)");
		} else if (counters.unmatched !== 0 || counters.failed !== 0) {
			fail(`the destination declined or failed item-state writes (unmatched=${counters.unmatched}, `
				+ `failed=${counters.failed}). Those losses never reach the verdict by design, so this assertion `
				+ `is the only thing that reports them: ${counters.line.slice(-140)}`);
		} else {
			pass(`item state applied ${counters.applied}x with 0 unmatched, 0 failed, `
				+ `${counters.mergeDiscarded} merge-discarded`);
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
					+ "tools/tests/cleanup-test-surfaces.ps1 (prefix beltstate- is in its sweep list)");
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
		say(`\n=== belt-item-state: ${problems.length} FAILURE(S) ===`);
		for (const problem of problems) say(`  - ${problem}`);
		process.exitCode = 1;
	} else {
		say(`\n=== belt-item-state: ALL PASS (${HOSTS[SOURCE_HOST].instance} -> ${HOSTS[DEST_HOST].instance}) ===`);
	}
}).catch(error => {
	console.error(`belt-item-state: fatal — ${error && error.stack ? error.stack : error}`);
	process.exitCode = 1;
});
