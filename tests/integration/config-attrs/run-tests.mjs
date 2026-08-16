#!/usr/bin/env node
// config-attrs — every mechanical config attribute drained from the coverage ledger must survive a
// real host-1 -> host-2 transfer
//
// requires: the cluster up, lab-transfer-fixture-v1 on host-1, host-2 able to receive
// produces: per-attribute SOURCE arming and DESTINATION physical readback, a gate verdict read
//           before any destination read, a DECLARED-INERT line (with the live prototype predicate
//           that decided it) for attributes no prototype supports at this pin, the measured
//           destination roster and clock, a per-side copper readback on the wired power switch,
//           copper readbacks on one out-of-reach WIRED pole pair and one in-reach UNWIRED pole pair,
//           an out-of-reach pole pair wired at the SCRIPT origin whose destination row is read with
//           the holding origin attached (source ':script' -> destination ':player'), which states
//           the capture-side boundary as an expectation: the wire survives, its origin does not,
//           the same two-arm dichotomy on GHOST poles (ghost-to-ghost and ghost-to-real, each read
//           as all-wires vs real-wires-only), a GHOST WIRE FACTS section reporting each new pole's
//           unit_number and the copper set create_entity alone produced, a REAL-PAIR GHOST WIRE
//           PROBES section that arms a ghost wire and then revives BOTH ends (out of reach, in
//           reach, and an unwired control), reading connector is_ghost plus connections vs
//           real_connections at every step (peer identity, not wire counts — each end is graded on
//           whether it links to THAT peer) and grading each arm against what run 31946363788
//           measured: both revive arms end with the wire INSIDE real_connections at both ends the
//           moment the second ghost turns real, every pairwise pole distance
//           graded against the live wire reach, the destination's own pole-copper prune log lines,
//           and a control section: the last_user conditional's present/absent arms, a nil-target
//           proxy-container read, the persisted summary.import.proxies_linked graded against the
//           destination's own physical count of proxy-containers holding a live target, and the far
//           end of every copper pair
// does not: read the export payload (payload presence is not restoration); assert item/fluid
//           fidelity (the gate does that); touch the protected fixtures (it transfers a CLONE);
//           tolerate a destination roster missing the armed last_user name (that row goes
//           UNEXERCISED red, never expects nil); read an IN-reach WIRED pair (create_entity
//           auto-connects one, so it could not go red on loss); assert the pruned count itself
//           (summary.import.copper_pruned reports it; these rows measure the resulting topology);
//           exercise the prune against a FOREIGN script-origin wire — no producer of one exists on
//           the destination with this mod-set, so that arm is measured by the pole-copper-prune
//           instrument calling prune_pole_copper directly, not here;
//           grade the prune log lines it prints (they are a discriminator for reading a red ghost
//           row, not a verdict — the instance log spans earlier imports too); transfer the
//           real-pair probe arms as assertions — those arms are a SOURCE-side engine measurement of
//           whether a ghost wire can hold between two NON-ghost poles at all, taken before any
//           export, and they grade no destination state; probe the two producers foreclosed by API
//           surface (connect_to has no ghost origin; LuaUndoRedoStack applies nothing), which are
//           reported as foreclosed rather than measured; probe build_blueprint, build_from_cursor,
//           clone_area/clone_entities/clone_brush or drag_wire, which are named NOT PROBED so the
//           producer enumeration is not read as closed — build_blueprint WAS attempted and removed
//           (runs 31945694561/31946363788/31947136193): in both build modes it created zero ghosts
//           over the pair AND zero onto empty foundation with the chunk charted, so that script
//           path is inert on a platform surface at this pin and could establish nothing either way

import { lua as luaRaw, sleep, docker, HOSTS, REPO_ROOT } from "../../lab-gallery/batch-lifecycle.mjs";
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
	{ id: "corpse", name: "character-corpse", dx: 25.5, dy: 1.5, inventorySize: 25 },
	{ id: "boxchest", name: "steel-chest", dx: 25.5, dy: 4.5, stock: { name: "spidertron", count: 1 } },
	{ id: "proxy", name: "proxy-container", dx: 25.5, dy: 7.5 },
	{ id: "proxynil", name: "proxy-container", dx: 25.5, dy: 10.5 },
	{ id: "artillery", name: "artillery-turret", dx: 25.5, dy: 14.5 },
	{ id: "pswitch", name: "power-switch", dx: 4.5, dy: 20.5 },
	{ id: "poleleft", name: "small-electric-pole", dx: 2.5, dy: 22.5 },
	{ id: "poleright", name: "small-electric-pole", dx: 10.5, dy: 22.5 },
	{ id: "polewire1", name: "small-electric-pole", dx: 4.5, dy: 13.5 },
	{ id: "polewire2", name: "small-electric-pole", dx: 14.5, dy: 13.5 },
	{ id: "polenear1", name: "small-electric-pole", dx: 24.5, dy: 18.5 },
	{ id: "polenear2", name: "small-electric-pole", dx: 28.5, dy: 18.5 },
	{ id: "spider", name: "spidertron", dx: 10.5, dy: 20.5 },
	{ id: "gwire1", name: "entity-ghost", innerName: "small-electric-pole", dx: 1.5, dy: 31.5 },
	{ id: "gwire2", name: "entity-ghost", innerName: "small-electric-pole", dx: 11.5, dy: 31.5 },
	{ id: "gnear1", name: "entity-ghost", innerName: "small-electric-pole", dx: 20.5, dy: 31.5 },
	{ id: "gnear2", name: "entity-ghost", innerName: "small-electric-pole", dx: 24.5, dy: 31.5 },
	{ id: "gmixwire", name: "entity-ghost", innerName: "small-electric-pole", dx: 1.5, dy: 40.5 },
	{ id: "rmixwire", name: "small-electric-pole", dx: 11.5, dy: 40.5 },
	{ id: "gmixnear", name: "entity-ghost", innerName: "small-electric-pole", dx: 20.5, dy: 40.5 },
	{ id: "rmixnear", name: "small-electric-pole", dx: 24.5, dy: 40.5 },
	{ id: "rvwire1", name: "entity-ghost", innerName: "small-electric-pole", dx: 1.5, dy: 49.5 },
	{ id: "rvwire2", name: "entity-ghost", innerName: "small-electric-pole", dx: 11.5, dy: 49.5 },
	{ id: "rvctl1", name: "entity-ghost", innerName: "small-electric-pole", dx: 1.5, dy: 58.5 },
	{ id: "rvctl2", name: "entity-ghost", innerName: "small-electric-pole", dx: 11.5, dy: 58.5 },
	{ id: "rvnear1", name: "entity-ghost", innerName: "small-electric-pole", dx: 1.5, dy: 67.5 },
	{ id: "rvnear2", name: "entity-ghost", innerName: "small-electric-pole", dx: 5.5, dy: 67.5 },
	{ id: "polescript1", name: "small-electric-pole", dx: 1.5, dy: 76.5 },
	{ id: "polescript2", name: "small-electric-pole", dx: 11.5, dy: 76.5 },
];

const POLE = "small-electric-pole";

const COPPER_WIRED_PAIR = ["polewire1", "polewire2"];
const COPPER_NEAR_PAIR = ["polenear1", "polenear2"];
const GHOST_WIRED_PAIR = ["gwire1", "gwire2"];
const GHOST_NEAR_PAIR = ["gnear1", "gnear2"];
const GHOST_REAL_WIRED_PAIR = ["gmixwire", "rmixwire"];
const GHOST_REAL_NEAR_PAIR = ["gmixnear", "rmixnear"];
const REVIVE_WIRED_PAIR = ["rvwire1", "rvwire2"];
const REVIVE_CONTROL_PAIR = ["rvctl1", "rvctl2"];
const REVIVE_NEAR_PAIR = ["rvnear1", "rvnear2"];
const REACHABLE_PAIRS = [COPPER_NEAR_PAIR, GHOST_NEAR_PAIR, GHOST_REAL_NEAR_PAIR, REVIVE_NEAR_PAIR];
const GHOST_WIRE_POLES = [...GHOST_WIRED_PAIR, ...GHOST_NEAR_PAIR, ...GHOST_REAL_WIRED_PAIR,
	...GHOST_REAL_NEAR_PAIR];

const MEASURED_AT = "run 31946363788 at 2.1.11";

const REAL_PAIR_ARMS = [
	{ id: "revive_far_wired", pair: REVIVE_WIRED_PAIR, wired: true, load: true,
		expect: ["real"],
		label: "revive both ends of an OUT-of-reach ghost-wired pole pair" },
	{ id: "revive_far_unwired", pair: REVIVE_CONTROL_PAIR, wired: false, control: true,
		expect: ["none"],
		label: "revive both ends of an OUT-of-reach UNWIRED ghost pole pair (control)" },
	{ id: "revive_near_wired", pair: REVIVE_NEAR_PAIR, wired: true,
		expect: ["real"],
		label: "revive both ends of an IN-reach ghost-wired pole pair" },
];

const OUTCOME_TEXT = {
	ghost: "GHOST WIRE BETWEEN TWO REAL POLES",
	real: "a REAL wire",
	none: "no wire",
};

const TICK_DRIFT_TOLERANCE = 60_000;
const CORPSE_INVENTORY_SIZE = 25;
const CORPSE_LOOT_COUNT = 123;
const CORPSE_DEATH_TICKS_AGO_MAX = 300_000;
const CORPSE_DEATH_TICKS_AGO_MIN = 4_000;

const RUNTIME = { deathTicksAgo: null, sourcePlayer: null, lastUserDestExpect: null, copperExpect: null,
	poleCopperExpect: null, ghostCopperExpect: null, ghostRealCopperExpect: null,
	scriptCopperExpect: null, scriptCopperDestExpect: null };

const NO_COPPER = "";
const asNoCopper = value => (value === "nil" ? NO_COPPER : value);

const NO_GHOST_COPPER = "all=[] real=[]";
const asNoGhostCopper = value => (value === "nil" ? NO_GHOST_COPPER : value);

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
    parts[#parts + 1] = string.format("[i=%s g=%s m=%s a=%s {%s}]", tostring(sec.index), tostring(sec.group),
      num(sec.multiplier), tostring(sec.active), table.concat(fparts, ","))
  end
  return string.format("trash=%s %s", tostring(v.trash_not_requested), table.concat(parts, ";"))
end
local function localised_key(v)
  if v == nil then return "nil" end
  if type(v) == "table" then return table.concat(v, "|") end
  return tostring(v)
end
local function corpse_loot_key(e)
  local iv = e.get_inventory(defines.inventory.character_corpse)
  if iv == nil then return "nil" end
  local total = 0
  for i = 1, #iv do
    local st = iv[i]
    if st.valid_for_read then total = total + st.count end
  end
  return string.format("%d:%d", #iv, total)
end
local function proxy_key(e)
  local t = e.proxy_target_entity
  if t == nil then return "nil" end
  return string.format("%s@%.2f,%.2f#%s", t.name, t.position.x, t.position.y, tostring(e.proxy_target_inventory))
end
local function spider_stack(e)
  local iv = e.get_inventory(defines.inventory.chest)
  if not (iv and iv.valid) then return nil end
  return iv.find_item_stack("spidertron")
end
local function color_key(c)
  if c == nil then return "nil" end
  return string.format("%.2f/%.2f/%.2f/%.2f", c.r or 0, c.g or 0, c.b or 0, c.a or 0)
end
local function auto_target_key(e)
  local p = e.vehicle_automatic_targeting_parameters
  if p == nil then return "nil" end
  return string.format("%s|%s", tostring(p.auto_target_without_gunner), tostring(p.auto_target_with_gunner))
end
local function copper_side_key(e, connector_id)
  local c = e.get_wire_connector(connector_id, false)
  if c == nil then return "nil" end
  local parts = {}
  for _, conn in ipairs(c.real_connections) do
    local owner = conn.target and conn.target.owner
    if owner and owner.valid then
      parts[#parts + 1] = string.format("%s@%.2f,%.2f", owner.name,
        owner.position.x - e.position.x, owner.position.y - e.position.y)
    end
  end
  table.sort(parts)
  return table.concat(parts, "+")
end
local function wire_peer_label(owner)
  if owner.type == 'entity-ghost' then return 'ghost:' .. tostring(owner.ghost_name) end
  return owner.name
end
local function wire_set_key(e, list)
  local parts = {}
  for _, conn in ipairs(list) do
    local owner = conn.target and conn.target.owner
    if owner and owner.valid then
      parts[#parts + 1] = string.format("%s@%.2f,%.2f", wire_peer_label(owner),
        owner.position.x - e.position.x, owner.position.y - e.position.y)
    end
  end
  table.sort(parts)
  return table.concat(parts, "+")
end
local function copper_wire_key(e, connector_id)
  local c = e.get_wire_connector(connector_id, false)
  if c == nil then return "nil" end
  return string.format("all=[%s] real=[%s]", wire_set_key(e, c.connections), wire_set_key(e, c.real_connections))
end
local copper_origin_names = { "player", "script" }
local function copper_origin_key(e, connector_id)
  local c = e.get_wire_connector(connector_id, false)
  if c == nil then return "nil" end
  local parts = {}
  for _, conn in ipairs(c.real_connections) do
    local owner = conn.target and conn.target.owner
    if owner and owner.valid then
      local held = {}
      for _, name in ipairs(copper_origin_names) do
        if c.is_connected_to(conn.target, defines.wire_origin[name]) then held[#held + 1] = name end
      end
      parts[#parts + 1] = string.format("%s@%.2f,%.2f:%s", owner.name,
        owner.position.x - e.position.x, owner.position.y - e.position.y,
        #held > 0 and table.concat(held, "+") or "none")
    end
  end
  table.sort(parts)
  return table.concat(parts, "+")
end
local function switch_copper_key(e)
  return string.format("L=[%s] R=[%s]",
    copper_side_key(e, defines.wire_connector_id.power_switch_left_copper),
    copper_side_key(e, defines.wire_connector_id.power_switch_right_copper))
end
local function item_sections_key(v)
  if v == nil then return "nil" end
  local parts = {}
  for _, sec in ipairs(v.sections or {}) do
    parts[#parts + 1] = string.format("%s:%s", tostring(sec.index), num(sec.multiplier))
  end
  return string.format("n=%d %s", #parts, table.concat(parts, ","))
end`;

const REAL_PAIR_PROBE_LUA = `local copper_id = defines.wire_connector_id.pole_copper

local function links_to(list, peer)
  for _, conn in ipairs(list) do
    local owner = conn.target and conn.target.owner
    if owner and owner.valid and owner.unit_number == peer.unit_number then return true end
  end
  return false
end

local function probe_side(e, peer)
  if not (e and e.valid) then return { present = false } end
  local row = { present = true, etype = e.type, unit_number = e.unit_number }
  local c = e.get_wire_connector(copper_id, false)
  if c == nil then
    row.connector = false
    return row
  end
  row.connector = true
  row.is_ghost = c.is_ghost
  row.n_all = c.connection_count
  row.n_real = c.real_connection_count
  row.linked_all = peer ~= nil and peer.valid and links_to(c.connections, peer) or false
  row.linked_real = peer ~= nil and peer.valid and links_to(c.real_connections, peer) or false
  local ok, key = pcall(function() return copper_wire_key(e, copper_id) end)
  row.key = ok and key or ('THREW: ' .. tostring(key))
  return row
end

local function probe_pair(a, b)
  return { a = probe_side(a, b), b = probe_side(b, a) }
end

local function revive_pole(e, pos)
  if not (e and e.valid) then return nil, 'entity gone before revive' end
  if e.type ~= 'entity-ghost' then return e, 'entity was not a ghost at revive time' end
  local ok, first, revived = pcall(function() return e.silent_revive{ raise_revive = false } end)
  if not ok then return nil, 'silent_revive threw: ' .. tostring(first) end
  if revived and revived.valid then return revived, nil end
  local found = s.find_entities_filtered{ name = '${POLE}', position = pos, radius = 0.3 }
  local hit = found and found[1]
  if hit and hit.valid then return hit, nil end
  return nil, 'silent_revive returned no entity and none stands at the position'
end

local function arm_pair(a, b, wired)
  local ca = a.get_wire_connector(copper_id, true)
  local cb = b.get_wire_connector(copper_id, true)
  ca.disconnect_all()
  cb.disconnect_all()
  if not wired then return true, ca, cb end
  return ca.connect_to(cb, false), ca, cb
end

local function run_revive_arm(arm)
  local out = { id = arm.id }
  local a, b = ents[arm.a], ents[arm.b]
  if not (a and a.valid and b and b.valid) then
    out.error = 'the arm poles were not both placed'
    return out
  end
  local apos = { x = a.position.x, y = a.position.y }
  local bpos = { x = b.position.x, y = b.position.y }
  out.distance = string.format('%.2f', math.sqrt((apos.x - bpos.x) ^ 2 + (apos.y - bpos.y) ^ 2))
  out.armed = arm_pair(a, b, arm.wired)
  out.before = probe_pair(a, b)
  local ra, aerr = revive_pole(a, apos)
  out.revive_a_error = aerr
  out.after_a = probe_pair(ra, b)
  local rb, berr = revive_pole(b, bpos)
  out.revive_b_error = berr
  out.after_both = probe_pair(ra, rb)
  return out
end

local real_pair_probes = {}
for _, arm in ipairs(real_pair_arms) do
  local ok, result = pcall(function() return run_revive_arm(arm) end)
  if ok then
    real_pair_probes[#real_pair_probes + 1] = result
  else
    real_pair_probes[#real_pair_probes + 1] = { id = arm.id,
      error = 'arm threw: ' .. tostring(result) }
  end
end`;

const ITEM_READ = expression => 'local st = spider_stack(e)\n'
	+ 'if st == nil then return "no-stack" end\n'
	+ `return ${expression}`;

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
		key: "artillery_auto_targeting", attribute: "artillery_auto_targeting", on: "artillery",
		write: "e.artillery_auto_targeting = not e.artillery_auto_targeting",
		read: BOOL_READ("artillery_auto_targeting"),
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
			+ "the output — a machine that can eject its product finishes the craft and the attribute is "
			+ "gone before any transfer can carry it (measured 2026-08-14 at 2.1.11 on a clone of "
			+ "lab-transfer-fixture-v1: crafting_progress 0.5 -> 0 and result_quality rare -> nil within "
			+ "90 ticks of the machine reaching a powered network)",
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
		expect: "trash=true [i=nil g= m=2 a=true {iron-plate@normal>=42}]",
	},
	{
		key: "saved_storage_filters", attribute: "saved_storage_filters", on: "infchest",
		write: "e.saved_storage_filters = { sections = { { index = 1, filters = { { index = 1, "
			+ 'value = { type = "item", name = "copper-plate", quality = "normal", comparator = "=" }, '
			+ "min = 7 } }, multiplier = 3 } }, trash_not_requested = false }",
		read: "return sections_key(e.saved_storage_filters)",
		expect: "trash=false [i=nil g= m=3 a=true {copper-plate@normal>=7}]",
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
		key: "linked_belt_direction", attribute: "direction", on: "linkedbelt",
		write: "e.direction = defines.direction.east",
		read: "return define_name(defines.direction, e.direction)",
		dynamicExpect: true,
		describe: "assigning linked_belt_type a DIFFERENT value rotates the belt 180 degrees (measured "
			+ "2026-08-14 at 2.1.11: assigning the value it already holds does not rotate, assigning the "
			+ "other value does), and the destination reaches the type through exactly that change — so a "
			+ "restore that does not re-assert the captured direction leaves the belt facing backwards "
			+ "while linked_belt_type itself reads correct",
	},
	{
		key: "link_id", attribute: "link_id", on: "linkedchest",
		write: "e.link_id = 4242", read: 'return string.format("%d", e.link_id)', expect: "4242",
	},
	{
		key: "last_user", attribute: "last_user", on: "chest",
		write: "e.last_user = game.players[1]",
		read: "return q_name(e.last_user)", dynamicExpect: true,
		get destExpect() { return RUNTIME.lastUserDestExpect; },
		describe: "last_user is captured as the player NAME and restored only when that name resolves to a "
			+ "player on the DESTINATION, so this row can only be exercised where the destination roster "
			+ "holds the armed name; where it does not, the row reports UNEXERCISED rather than expecting "
			+ "nil, which would pass with the capture deleted. This row is the only assertion that covers "
			+ "the CAPTURE side at all — both control arms build their payloads by hand and never reach "
			+ "EntityScanner. Neither this row nor the controls can tell a name-keyed restore from an "
			+ "index-keyed one on a shared roster",
	},
	{
		key: "corpse_death_cause", attribute: "character_corpse_death_cause", on: "corpse",
		write: `e.character_corpse_death_cause = { "", "${CLONE}-death" }`,
		read: "return localised_key(e.character_corpse_death_cause)",
		expect: `|${CLONE}-death`,
	},
	{
		key: "corpse_tick_of_death", attribute: "character_corpse_tick_of_death", on: "corpse",
		get write() { return `e.character_corpse_tick_of_death = game.tick - ${RUNTIME.deathTicksAgo}`; },
		read: 'return string.format("%d", game.tick - e.character_corpse_tick_of_death)',
		get expect() { return String(RUNTIME.deathTicksAgo); },
		compare: (actual, expected) => {
			const a = Number(actual);
			const b = Number(expected);
			return Number.isFinite(a) && Number.isFinite(b) && a >= b && a - b <= TICK_DRIFT_TOLERANCE;
		},
		describe: "the elapsed ticks SINCE death must land at or above the armed duration — a corpse "
			+ "recreated without it reads its own creation tick (the ticks the import itself took, ~1000), "
			+ "and an absolute tick carried raw arrives as the SOURCE clock, which on an independent "
			+ "destination clock reads as a large NEGATIVE elapsed time. The armed duration is measured "
			+ "against the destination clock at run start rather than pinned, because a duration older than "
			+ "the destination world clamps to tick 0 and stops being distinguishable from either failure",
	},
	{
		key: "corpse_loot", attribute: "defines.inventory.character_corpse", on: "corpse",
		write: `e.get_inventory(defines.inventory.character_corpse).insert{ name = "iron-plate", count = ${CORPSE_LOOT_COUNT} }`,
		read: "return corpse_loot_key(e)",
		expect: `${CORPSE_INVENTORY_SIZE}:${CORPSE_LOOT_COUNT}`,
		describe: "a corpse created without the create_entity inventory_size parameter gets a SIZE-ZERO loot "
			+ "inventory (measured 2026-08-15 at 2.1.11). The two ways that loot can go missing land on "
			+ "opposite sides of the gate. A corpse that fails to PLACE is charged to failed_entity_losses, "
			+ "and those items are subtracted from the expected totals before the exact comparison "
			+ "(import-completion.lua:413-423), so the gate stays green and the loss is silent — that path is "
			+ "what this row exists to report. A corpse that places with a size-zero inventory instead takes "
			+ "the inventory.insert branch of restore_inventories, which credits nothing to "
			+ "inventory_overflow_losses (only the set_stack slot branch does), so the destination census "
			+ "comes up short and the exact gate FAILS and reverts before any read here runs",
	},
	{
		key: "proxy_target", attribute: "proxy_target_entity + proxy_target_inventory", on: "proxy",
		write: "e.proxy_target_entity = ents.boxchest\ne.proxy_target_inventory = defines.inventory.chest",
		read: "return proxy_key(e)", dynamicExpect: true,
		describe: "the link is compared by the target's NAME and POSITION, never by unit_number — the "
			+ "destination entity is a different engine object, and the restore resolves the reference "
			+ "through the source-unit_number entity_map the circuit pass already uses",
	},
	{
		key: "item_entity_color", attribute: "entity_color", on: "boxchest",
		write: "spider_stack(e).entity_color = { r = 1, g = 0, b = 0.5, a = 1 }",
		read: ITEM_READ("color_key(st.entity_color)"), expect: "1.00/0.00/0.50/1.00",
	},
	{
		key: "item_entity_enable_logistics_while_moving", attribute: "entity_enable_logistics_while_moving",
		on: "boxchest",
		write: "spider_stack(e).entity_enable_logistics_while_moving = false",
		read: ITEM_READ("tostring(st.entity_enable_logistics_while_moving)"), expect: "false",
	},
	{
		key: "item_entity_logistics_enabled", attribute: "entity_logistics_enabled", on: "boxchest",
		write: "spider_stack(e).entity_logistics_enabled = false",
		read: ITEM_READ("tostring(st.entity_logistics_enabled)"), expect: "false",
	},
	{
		key: "item_entity_request_from_buffers", attribute: "entity_request_from_buffers", on: "boxchest",
		write: "spider_stack(e).entity_request_from_buffers = false",
		read: ITEM_READ("tostring(st.entity_request_from_buffers)"), expect: "false",
		describe: "the fresh default is TRUE, so this row arms the negation — writing true would produce a "
			+ "destination match that proves nothing",
	},
	{
		key: "power_switch_state", attribute: "power_switch_state", on: "pswitch",
		write: "e.power_switch_state = not e.power_switch_state",
		read: BOOL_READ("power_switch_state"), dynamicExpect: true,
		describe: "the switch carries a pole on each copper side, so this row reads the state AFTER the "
			+ "connection pass: restore_entity_state writes power_switch_state while the entity is created "
			+ "(entity_creation.lua:106) and the copper wires are re-established in a later phase "
			+ "(entity_state_restoration.lua:49-65). This row is armed before the wiring row below, so a "
			+ "state the wiring itself destroys is caught by the pre-export re-read as source decay rather "
			+ "than reported here as a restore defect. Measured 2026-08-15 at 2.1.11 on a clone of "
			+ "lab-transfer-fixture-v1 wired exactly as above: the state DOES survive the copper pass, so a "
			+ "red here is a regression rather than an open question",
	},
	{
		key: "power_switch_copper", attribute: "power_switch_left_copper + power_switch_right_copper",
		on: "pswitch",
		write: "local left = e.get_wire_connector(defines.wire_connector_id.power_switch_left_copper, true)\n"
			+ "local right = e.get_wire_connector(defines.wire_connector_id.power_switch_right_copper, true)\n"
			+ "left.disconnect_all()\n"
			+ "right.disconnect_all()\n"
			+ "left.connect_to(ents.poleleft.get_wire_connector(defines.wire_connector_id.pole_copper, true), false)\n"
			+ "right.connect_to(ents.poleright.get_wire_connector(defines.wire_connector_id.pole_copper, true), false)",
		read: "return switch_copper_key(e)",
		get expect() { return RUNTIME.copperExpect; },
		describe: "each side is compared as the set of target NAMES and OFFSETS from the switch — the "
			+ "destination entities are different engine objects, so unit_number cannot key the comparison. "
			+ "The expectation is built from the MEASURED rig placements rather than the requested dx/dy "
			+ "(a 2x2 power-switch snaps off the half-tile it is asked for) and it is fixed before the "
			+ "source is read, so a half-made rig — one connect_to landing, the other not — fails at arming "
			+ "instead of quietly becoming the value the destination has to reproduce. Only real_connections "
			+ "is read, so a ghost wire cannot stand in for copper. The sides are read "
			+ "separately because defines.wire_connector_id.pole_copper and power_switch_left_copper are both "
			+ "5 at this pin, with power_switch_right_copper 6 (measured 2026-08-15 at 2.1.11 by enumerating "
			+ "the defines table): a connector id alone does not say which side of a switch a wire landed on, "
			+ "so a union-keyed comparison would read a wire moved between sides as intact. The two poles "
			+ "stand 8.0 apart, past a small-electric-pole's 7.5 wire reach (get_max_wire_distance, same "
			+ "pin), so the engine auto-connects neither them nor the copper-row poles below to this "
			+ "switch's poles; checkPoleGeometry grades every pairwise distance among the rig's poles "
			+ "against the live reach, on its own, whether or not those rows arm. An extra pole on the LEFT "
			+ "set was the shared-id defect #232 fixed with a target type guard; the pass that carried it is "
			+ "deleted, so this row now guards restore_circuit_connections replaying each side's own "
			+ "connector id",
	},
	{
		key: "pole_copper", attribute: "pole_copper (wire present)", on: "polewire1",
		write: "local copper = defines.wire_connector_id.pole_copper\n"
			+ "local near = e.get_wire_connector(copper, true)\n"
			+ "local far = ents.polewire2.get_wire_connector(copper, true)\n"
			+ "near.disconnect_all()\n"
			+ "far.disconnect_all()\n"
			+ "near.connect_to(far, false)",
		read: "return copper_side_key(e, defines.wire_connector_id.pole_copper)",
		get expect() { return RUNTIME.poleCopperExpect; },
		describe: "polewire1 and polewire2 stand 10.0 apart, PAST a small-electric-pole's 7.5 wire reach "
			+ "(measured 2026-08-15 at 2.1.11 with LuaEntityPrototype.get_max_wire_distance), so the engine "
			+ "will not auto-connect them at create_entity and the payload is the only thing that can put "
			+ "this wire on the destination. connect_to's reach_check argument is false at the restore site "
			+ "(deserializer.lua:1374), which is what lets an out-of-reach wire arm and restore. That "
			+ "distance is the whole point: measured 2026-08-15 in CI run 31918880538, an IN-reach pair "
			+ "arrives wired even when the restore is stopped from making pole-to-pole copper, so a row on "
			+ "a reachable pair cannot go red on loss. restore_circuit_connections is what restores this "
			+ "wire — it replays the same pole_copper connector id on both ends, extract_circuit_connections "
			+ "iterating get_wire_connectors unfiltered (measured on a live pole pair at the same pin, "
			+ "connector id 5 with target connector id 5); run 31919809131 disabled the since-deleted "
			+ "restore_power_connections and changed no row",
	},
	{
		key: "pole_copper_absent", attribute: "pole_copper (no wire)", on: "polenear1",
		write: "local copper = defines.wire_connector_id.pole_copper\n"
			+ "e.get_wire_connector(copper, true).disconnect_all()\n"
			+ "ents.polenear2.get_wire_connector(copper, true).disconnect_all()",
		read: "return copper_side_key(e, defines.wire_connector_id.pole_copper)",
		expect: NO_COPPER,
		compare: (actual, expected) => asNoCopper(actual) === expected,
		describe: "polenear1 and polenear2 stand 4.0 apart, INSIDE the 7.5 reach, and the source deletes the "
			+ "copper the engine gave them. The destination must show none. A destination pole reads its "
			+ "empty copper set as either '' or 'nil' depending on whether the connector object exists at "
			+ "all, and both mean no wire, so the comparison normalises 'nil' — an actual wire is neither. "
			+ "The 'fresh default was' line reports what create_entity alone produced, which is this row's "
			+ "auto-connect measurement: if the engine ever stops auto-connecting, the armed value equals "
			+ "the default and the harness fails this row as unexercised rather than passing it vacuously",
	},
	{
		key: "pole_copper_script_origin", attribute: "pole_copper (wire present, SCRIPT origin)", on: "polescript1",
		write: "local copper = defines.wire_connector_id.pole_copper\n"
			+ "local near = e.get_wire_connector(copper, true)\n"
			+ "local far = ents.polescript2.get_wire_connector(copper, true)\n"
			+ "near.disconnect_all()\n"
			+ "far.disconnect_all()\n"
			+ "near.connect_to(far, false, defines.wire_origin.script)",
		read: "return copper_origin_key(e, defines.wire_connector_id.pole_copper)",
		get expect() { return RUNTIME.scriptCopperExpect; },
		get destExpect() { return RUNTIME.scriptCopperDestExpect; },
		describe: "this row is the CAPTURE-side boundary of the copper prune, stated as an expectation rather "
			+ "than left implicit: the wire survives the transfer and its ORIGIN does not. polescript1 and "
			+ "polescript2 stand 10.0 apart, past the 7.5 wire reach, so no auto-connect can supply this wire "
			+ "and the payload is the only thing that can put it on the destination. The source arms it at "
			+ "defines.wire_origin.script; the destination is expected to read the same wire at the PLAYER "
			+ "origin, because extract_circuit_connections records source_circuit_id / target_entity_id / "
			+ "target_circuit_id and no origin field (measured in CI run 31959478373 at 2.1.11 by calling the "
			+ "scanner on a script-wired pole: 1 row naming the peer, no origin key), and "
			+ "restore_circuit_connections replays it through connect_to, whose origin argument defaults to "
			+ "player. A destination reading ':script' here would mean origin-faithful restoration landed and "
			+ "this expectation is stale; an empty set would mean a script-origin wire does not survive at all",
	},
	{
		key: "ghost_pole_copper", attribute: "pole_copper on a GHOST pair (wire present)", on: "gwire1",
		write: "local copper = defines.wire_connector_id.pole_copper\n"
			+ "local near = e.get_wire_connector(copper, true)\n"
			+ "local far = ents.gwire2.get_wire_connector(copper, true)\n"
			+ "near.disconnect_all()\n"
			+ "far.disconnect_all()\n"
			+ "near.connect_to(far, false)",
		read: "return copper_wire_key(e, defines.wire_connector_id.pole_copper)",
		get expect() { return RUNTIME.ghostCopperExpect; },
		describe: "two entity-ghosts of a small-electric-pole, 10.0 apart and so past the pole's 7.5 wire "
			+ "reach, wired to each other. A wire with a ghost at either end is a GHOST wire and is excluded "
			+ "from real_connections by definition — upstream 2.1.11: real_connections is \"All wire "
			+ "connectors this connector is connected to with real wires. It only includes wires that are "
			+ "between two non-ghost entities\" "
			+ "(https://lua-api.factorio.com/2.1.11/classes/LuaWireConnector.html) — so this row reads BOTH "
			+ "sets and expects the wire in all=[] and nothing in real=[]. The export captures it because "
			+ "extract_circuit_connections iterates wire_connector.connections, which upstream defines as "
			+ "\"All wire connectors this connector is connected to. It includes all wires (ghost wires and "
			+ "real wires)\" (connection-scanner.lua:21). Whether the payload's ghost-to-ghost wire can be "
			+ "keyed at all depends on ghosts carrying a unit_number, which the GHOST WIRE FACTS section of "
			+ "this run measures rather than assumes",
	},
	{
		key: "ghost_pole_copper_absent", attribute: "pole_copper on a GHOST pair (no wire)", on: "gnear1",
		write: "local copper = defines.wire_connector_id.pole_copper\n"
			+ "e.get_wire_connector(copper, true).disconnect_all()\n"
			+ "ents.gnear2.get_wire_connector(copper, true).disconnect_all()",
		read: "return copper_wire_key(e, defines.wire_connector_id.pole_copper)",
		expect: NO_GHOST_COPPER,
		compare: (actual, expected) => asNoGhostCopper(actual) === expected,
		describe: "two pole ghosts 4.0 apart, INSIDE the 7.5 reach, left unwired by the source — and "
			+ "create_entity hands them a wire on the destination, which the GHOST WIRE FACTS section of this "
			+ "run measures as the copper set create_entity alone produced. What removes it is the ghost pass "
			+ "of Deserializer.prune_pole_copper (deserializer.lua:1509-1536): it visits pole-like entities — "
			+ "an electric-pole, or an entity-ghost whose ghost_type is electric-pole — and takes from "
			+ "connector.connections the wires with a ghost connector at either end, which is the set "
			+ "real_connections cannot contain. A red here is that pass not running or not reaching this "
			+ "pair. If the engine ever stops auto-connecting pole ghosts, the armed value equals the default "
			+ "and this row is failed as unexercised rather than passing vacuously",
	},
	{
		key: "ghost_real_pole_copper", attribute: "pole_copper GHOST-to-REAL (wire present)", on: "gmixwire",
		write: "local copper = defines.wire_connector_id.pole_copper\n"
			+ "local near = e.get_wire_connector(copper, true)\n"
			+ "local far = ents.rmixwire.get_wire_connector(copper, true)\n"
			+ "near.disconnect_all()\n"
			+ "far.disconnect_all()\n"
			+ "near.connect_to(far, false)",
		read: "return copper_wire_key(e, defines.wire_connector_id.pole_copper)",
		get expect() { return RUNTIME.ghostRealCopperExpect; },
		describe: "a pole ghost wired to a REAL pole 10.0 apart, past the 7.5 reach. One ghost end makes the "
			+ "whole wire a ghost wire — upstream 2.1.11 on LuaWireConnector.is_ghost: \"If any of 2 ends of "
			+ "a wire attaches to a ghost connector, then a wire is considered to be a ghost\" — so the real "
			+ "pole's real_connections is empty here too, and the far-end control below reads that at the "
			+ "real end. This is the ghost pass's OVER-prune arm: the payload carries this wire and both ends "
			+ "capture it, so a pass that stopped consulting each pole's own circuit_connections "
			+ "(payload_copper_peers, deserializer.lua:1420-1431) would take it and this row would read an "
			+ "empty all= set",
	},
	{
		key: "ghost_real_pole_copper_absent", attribute: "pole_copper GHOST-to-REAL (no wire)", on: "gmixnear",
		write: "local copper = defines.wire_connector_id.pole_copper\n"
			+ "e.get_wire_connector(copper, true).disconnect_all()\n"
			+ "ents.rmixnear.get_wire_connector(copper, true).disconnect_all()",
		read: "return copper_wire_key(e, defines.wire_connector_id.pole_copper)",
		expect: NO_GHOST_COPPER,
		compare: (actual, expected) => asNoGhostCopper(actual) === expected,
		describe: "a pole ghost 4.0 from a REAL pole, INSIDE the 7.5 reach, left unwired by the source, and "
			+ "wired by create_entity on the destination. The real end is visited by the prune's real pass as "
			+ "an electric-pole, but a wire to a ghost never appears in the real_connections that pass "
			+ "iterates; the ghost pass (deserializer.lua:1509-1536) is what removes it, from whichever end "
			+ "reaches it first. The far-end control below reads that real end",
	},
	{
		key: "vehicle_automatic_targeting_parameters", attribute: "vehicle_automatic_targeting_parameters",
		on: "spider",
		write: "local p = e.vehicle_automatic_targeting_parameters\n"
			+ "e.vehicle_automatic_targeting_parameters = { "
			+ "auto_target_without_gunner = not p.auto_target_without_gunner, "
			+ "auto_target_with_gunner = not p.auto_target_with_gunner }",
		read: "return auto_target_key(e)", dynamicExpect: true,
		describe: "both flags are armed as the NEGATION of the measured fresh defaults, so a destination that "
			+ "reads the prototype defaults fails this row. The concept's fields are auto_target_without_gunner "
			+ "and auto_target_with_gunner (measured 2026-08-15 at 2.1.11 by enumerating the keys of the table "
			+ "the attribute returns); this is a concept table, not a LuaObject, so reading or writing a "
			+ "sub-key under any other name is a plain table index that yields nil without throwing",
	},
	{
		key: "item_entity_logistic_sections", attribute: "entity_logistic_sections", on: "boxchest",
		write: "spider_stack(e).entity_logistic_sections = "
			+ "{ sections = { { index = 1, multiplier = 3 }, { index = 2, multiplier = 7 } } }",
		read: ITEM_READ("item_sections_key(st.entity_logistic_sections)"), expect: "n=2 1:3,2:7",
		describe: "section COUNT and multiplier are what the item-side read exposes; filters written into an "
			+ "item's sections are accepted and then dropped (measured 2026-08-15 at 2.1.11: writing a "
			+ "filter and placing the entity from that item yields a section with the multiplier intact and "
			+ "zero filters), so a filter-keyed comparison here would assert an engine behaviour that does "
			+ "not exist",
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
	{
		attribute: "pickup_position / drop_position (inserter vector restore)",
		predicate: "an inserter prototype with allow_custom_vectors = true",
		count: 'local n = 0\n'
			+ 'for _, proto in pairs(prototypes.entity) do\n'
			+ '  if proto.type == "inserter" and proto.allow_custom_vectors then n = n + 1 end\n'
			+ 'end\n'
			+ 'return n',
	},
];

function readerAssignments() {
	return ATTRS.map(a => `readers["${a.key}"] = function(e)\n${a.read}\nend`).join("\n");
}

function readersLua() {
	return `${READER_HELPERS}\n${readerAssignments()}`;
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
		+ (entity.direction ? `, direction = ${entity.direction}` : "")
		+ (entity.inventorySize ? `, inventory_size = ${entity.inventorySize}` : "")
		+ (entity.innerName ? `, inner_name = '${entity.innerName}'` : "")
		+ (entity.stock ? `, stock = { name = '${entity.stock.name}', count = ${entity.stock.count} }` : "")
		+ " },").join("\n");
	const ghostWirePoles = GHOST_WIRE_POLES.map(id => `  '${id}',`).join("\n");
	const realPairArms = REAL_PAIR_ARMS.map(arm => `  { id = '${arm.id}', `
		+ `a = '${arm.pair[0]}', b = '${arm.pair[1]}', wired = ${arm.wired} },`).join("\n");
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
  for y = by, by + 80 do tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { x, y } } end
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
  if sp.inventory_size then params.inventory_size = sp.inventory_size end
  if sp.inner_name then params.inner_name = sp.inner_name end
  local ok, e = pcall(function() return s.create_entity(params) end)
  if ok and e and e.valid then
    ents[sp.id] = e
    local stocked
    if sp.stock then
      local inv = e.get_inventory(defines.inventory.chest)
      stocked = inv and inv.insert{ name = sp.stock.name, count = sp.stock.count } or 0
    end
    placements[#placements + 1] = { id = sp.id, name = sp.name, placed = true,
      x = e.position.x, y = e.position.y, etype = e.type, stocked = stocked,
      ghost_name = e.type == 'entity-ghost' and e.ghost_name or nil }
  else
    placements[#placements + 1] = { id = sp.id, name = sp.name, placed = false,
      error = ok and 'create_entity returned nil' or tostring(e) }
  end
end

${READER_HELPERS}
local writers = {}
${writers}
local readers = {}
${readerAssignments()}

local ghost_wire_poles = {
${ghostWirePoles}
}
local wire_facts = {}
for _, id in ipairs(ghost_wire_poles) do
  local e = ents[id]
  local fact = { id = id }
  if e and e.valid then
    fact.unit_number = e.unit_number
    fact.etype = e.type
    local c = e.get_wire_connector(defines.wire_connector_id.pole_copper, false)
    fact.connector = c ~= nil
    if c then fact.is_ghost_connector = c.is_ghost end
    local ok, key = pcall(function() return copper_wire_key(e, defines.wire_connector_id.pole_copper) end)
    fact.fresh_copper = ok and key or ('THREW: ' .. tostring(key))
  end
  wire_facts[#wire_facts + 1] = fact
end

local real_pair_arms = {
${realPairArms}
}
${REAL_PAIR_PROBE_LUA}

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
return { success = true, base = { x = bx, y = by }, placements = placements, armed = armed,
  wire_facts = wire_facts, real_pair_probes = real_pair_probes,
  pole_wire_reach = prototypes.entity['small-electric-pole'].get_max_wire_distance() }`);
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

function measureEnvironment() {
	say("\n=== ENVIRONMENT: the two destination properties no row may assume ===");
	const survey = host => lua(host, "local names = {}\n"
		+ "for _, p in pairs(game.players) do names[#names + 1] = p.name end\n"
		+ "return { success = true, names = names, tick = game.tick }");
	const sourceNames = asArray(survey(SOURCE_HOST).names ?? []);
	const destAnswer = survey(DEST_HOST);
	const destNames = asArray(destAnswer.names ?? []);
	const destTick = Number(destAnswer.tick);

	RUNTIME.sourcePlayer = sourceNames[0] ?? null;
	if (RUNTIME.sourcePlayer === null) {
		fail("host " + SOURCE_HOST + " has an EMPTY player roster, so last_user cannot be armed at all — "
			+ "the row would report 'not exercised' rather than anything about the restore");
	}
	const destResolvesSource = destNames.includes(RUNTIME.sourcePlayer);
	RUNTIME.lastUserDestExpect = destResolvesSource ? RUNTIME.sourcePlayer : null;
	say(`  source roster: [${sourceNames.join(", ")}] — arming last_user as ${JSON.stringify(RUNTIME.sourcePlayer)}`);
	say(`  destination roster: [${destNames.join(", ")}]`);
	if (!destResolvesSource) {
		fail(`the destination roster does not contain ${JSON.stringify(RUNTIME.sourcePlayer)}, so the last_user `
			+ "row is UNEXERCISED: the restore correctly declines, and an expectation of nil would pass whether "
			+ "or not the capture in EntityScanner.serialize_entity still exists — deleting it outright would "
			+ "read identically. Both control arms build their payloads by hand, so neither covers the capture. "
			+ "This is reported red rather than skipped for the same reason the destination-clock check below "
			+ "is: a green run must not mean 'a shipped attribute went entirely untested'. On this cluster the "
			+ "usual cause is a destination instance that failed to start and came up on a blank save");
	}

	if (!Number.isFinite(destTick) || destTick < CORPSE_DEATH_TICKS_AGO_MIN * 2) {
		fail(`destination clock is ${destTick} ticks old, under the ${CORPSE_DEATH_TICKS_AGO_MIN * 2} this row `
			+ "needs: a death older than the destination world clamps to tick 0, and a duration under the "
			+ "~1000 ticks an import itself takes cannot be told apart from a corpse that was never restored");
		RUNTIME.deathTicksAgo = CORPSE_DEATH_TICKS_AGO_MIN;
		return;
	}
	RUNTIME.deathTicksAgo = Math.max(CORPSE_DEATH_TICKS_AGO_MIN,
		Math.min(CORPSE_DEATH_TICKS_AGO_MAX, Math.floor(destTick / 2)));
	say(`  destination clock: ${destTick} ticks — arming the corpse death at ${RUNTIME.deathTicksAgo} ticks ago `
		+ "(half the destination's age, capped), which the destination can represent without clamping");
}

function armCopperExpect(placementById) {
	const anchor = placementById.get("pswitch");
	const left = placementById.get("poleleft");
	const right = placementById.get("poleright");
	if (!(anchor && anchor.placed && left && left.placed && right && right.placed)) {
		fail("the power switch or one of its two poles did not place, so the copper row has no measured "
			+ "expectation and cannot report on the connection pass");
		return;
	}
	const side = pole => `${pole.name}@${(pole.x - anchor.x).toFixed(2)},${(pole.y - anchor.y).toFixed(2)}`;
	RUNTIME.copperExpect = `L=[${side(left)}] R=[${side(right)}]`;
	say(`  copper expectation from the measured rig: ${RUNTIME.copperExpect}`);
}

const offsetKey = (target, origin) =>
	`${target.name}@${(target.x - origin.x).toFixed(2)},${(target.y - origin.y).toFixed(2)}`;

const peerLabel = placement => (placement.ghost_name ? `ghost:${placement.ghost_name}` : placement.name);

const wireKey = (target, origin) =>
	`all=[${peerLabel(target)}@${(target.x - origin.x).toFixed(2)},${(target.y - origin.y).toFixed(2)}] real=[]`;

const isPair = (pair, a, b) => pair.includes(a.id) && pair.includes(b.id);

const isPoleLike = placement => placement.placed
	&& (placement.etype === "electric-pole" || placement.ghost_name === POLE);

function checkPoleGeometry(placementById, reach) {
	say("\n=== RIG GEOMETRY: which pole pairs the engine can auto-connect ===");
	if (!Number.isFinite(reach)) {
		fail(`small-electric-pole reported wire reach ${JSON.stringify(reach)} rather than a number, so no `
			+ "pole pair on the rig can be shown in or out of auto-connect range and both copper rows "
			+ "grade nothing");
		return;
	}
	const poles = [...placementById.values()].filter(isPoleLike);
	for (let i = 0; i < poles.length; i++) {
		for (let j = i + 1; j < poles.length; j++) {
			const [a, b] = [poles[i], poles[j]];
			const distance = Math.hypot(a.x - b.x, a.y - b.y);
			const wantsReachable = REACHABLE_PAIRS.some(pair => isPair(pair, a, b));
			if (wantsReachable && distance > reach) {
				fail(`${a.id} and ${b.id} stand ${distance.toFixed(2)} tiles apart, past the ${reach} wire `
					+ "reach — the engine would not have auto-connected them, so a destination that shows "
					+ "them unwired proves nothing about fabrication");
			} else if (!wantsReachable && distance <= reach) {
				fail(`${a.id} and ${b.id} stand ${distance.toFixed(2)} tiles apart, within the ${reach} wire `
					+ "reach — the engine can auto-connect this pair at create_entity and feed copper into a "
					+ "set a copper row reads as the payload's");
			} else {
				say(`  ${a.id}<->${b.id}: ${distance.toFixed(2)} tiles, ${wantsReachable ? "in" : "out of"} `
					+ `auto-connect range (${reach}) as intended`);
			}
		}
	}
}

function armPoleCopperExpect(placementById) {
	const wire1 = placementById.get("polewire1");
	const wire2 = placementById.get("polewire2");
	if (!(wire1?.placed && wire2?.placed)) {
		fail("the out-of-reach wired pole pair did not place in full, so the pole_copper row has no measured "
			+ "expectation");
		return;
	}
	RUNTIME.poleCopperExpect = offsetKey(wire2, wire1);
	say(`  pole copper expectation from the measured rig: ${RUNTIME.poleCopperExpect}`);
}

function armScriptCopperExpect(placementById) {
	const near = placementById.get("polescript1");
	const far = placementById.get("polescript2");
	if (!(near?.placed && far?.placed)) {
		fail("the script-origin pole pair did not place in full, so the capture-origin row has no measured "
			+ "expectation and cannot report on what a wire's origin does across a transfer");
		return;
	}
	RUNTIME.scriptCopperExpect = `${offsetKey(far, near)}:script`;
	RUNTIME.scriptCopperDestExpect = `${offsetKey(far, near)}:player`;
	say(`  script-origin copper expectation from the measured rig: source ${RUNTIME.scriptCopperExpect} `
		+ `-> destination ${RUNTIME.scriptCopperDestExpect}`);
}

const GHOST_WIRED_EXPECTS = [
	{ slot: "ghostCopperExpect", pair: GHOST_WIRED_PAIR, label: "ghost-to-ghost" },
	{ slot: "ghostRealCopperExpect", pair: GHOST_REAL_WIRED_PAIR, label: "ghost-to-real" },
];

function armGhostCopperExpect(placementById) {
	for (const { slot, pair, label } of GHOST_WIRED_EXPECTS) {
		const [near, far] = pair.map(id => placementById.get(id));
		if (!(near?.placed && far?.placed)) {
			fail(`the ${label} wired pole pair did not place in full, so its copper row has no measured `
				+ "expectation");
			continue;
		}
		RUNTIME[slot] = wireKey(far, near);
		say(`  ${label} copper expectation from the measured rig: ${RUNTIME[slot]}`);
	}
}

function reportGhostWireFacts(facts) {
	say("\n=== GHOST WIRE FACTS: what create_entity alone produced, measured this run ===");
	if (facts.length === 0) {
		fail("the source rig returned no ghost-pole wire facts, so this run establishes neither ghost "
			+ "unit_number nor ghost auto-connect and every ghost copper row reads against an unmeasured "
			+ "engine");
		return;
	}
	for (const fact of facts) {
		say(`  ${fact.id}: type=${fact.etype ?? "NOT PLACED"} unit_number=${fact.unit_number ?? "nil"} `
			+ `connector=${fact.connector === true} is_ghost_connector=${fact.is_ghost_connector ?? "n/a"} `
			+ `fresh copper ${JSON.stringify(fact.fresh_copper ?? "unread")}`);
	}
	const ghosts = facts.filter(fact => fact.etype === "entity-ghost");
	const numbered = ghosts.filter(fact => typeof fact.unit_number === "number");
	say(`  pole ghosts carrying a unit_number: ${numbered.length}/${ghosts.length} — the export keys a wire `
		+ "target by unit_number and falls back to pos_<x>_<y> (connection-scanner.lua:24-28) while the "
		+ "entity's own id falls back to name@x,y#dir (game-utils.lua:121-129), so a ghost with no "
		+ "unit_number can be matched only by the restore's position fallback (deserializer.lua:1352-1366)");
}

const POLE_TYPE = "electric-pole";

const describeSide = side => {
	if (!side || side.present !== true) return "ABSENT";
	if (side.connector !== true) return `${side.etype} #${side.unit_number ?? "nil"} (no copper connector)`;
	return `${side.etype} #${side.unit_number ?? "nil"} is_ghost=${side.is_ghost} all=${side.n_all} `
		+ `real=${side.n_real} linked-to-peer all=${side.linked_all} real=${side.linked_real} `
		+ JSON.stringify(side.key ?? "unread");
};

const sayPair = (stage, state) => {
	if (!state) return;
	say(`     ${stage}: A ${describeSide(state.a)}`);
	say(`     ${stage}: B ${describeSide(state.b)}`);
};

function pairShape(state) {
	const { a, b } = state ?? {};
	if (!(a?.present === true && b?.present === true)) return { readable: false, why: "one end is absent" };
	if (a.connector !== true || b.connector !== true) {
		return { readable: true, wired: false, realWired: false, ghostWire: false,
			bothReal: a.etype === POLE_TYPE && b.etype === POLE_TYPE };
	}
	const wired = a.linked_all === true && b.linked_all === true;
	const realWired = a.linked_real === true && b.linked_real === true;
	return {
		readable: true, wired, realWired,
		ghostWire: wired && !realWired,
		bothReal: a.etype === POLE_TYPE && b.etype === POLE_TYPE,
		ghostConnector: a.is_ghost === true || b.is_ghost === true,
	};
}

function checkReviveArm(arm, probe) {
	const before = pairShape(probe.before);
	sayPair("before revive", probe.before);
	if (!before.readable) {
		fail(`${arm.id}: ${before.why} before the revive, so the arm carried nothing into it`);
		return null;
	}
	if (arm.wired && !before.wired) {
		fail(`${arm.id}: the source armed no wire between the two ghosts (connect_to returned `
			+ `${probe.armed}), so reviving them measures nothing about what happens to a ghost wire`);
		return null;
	}
	if (!arm.wired && before.wired) {
		fail(`${arm.id}: the control pair came out of arming already wired, so a wire seen after the `
			+ "revive would not prove the revive fabricated it");
		return null;
	}
	if (arm.wired && !before.ghostWire) {
		fail(`${arm.id}: the armed wire between two ghosts is already in real_connections before any `
			+ "revive, so this pin does not partition wires the way the prune's two passes assume");
		return null;
	}
	sayPair("after reviving A", probe.after_a);
	if (probe.revive_a_error) fail(`${arm.id}: end A did not revive — ${probe.revive_a_error}`);
	if (arm.wired) {
		const mid = pairShape(probe.after_a);
		if (!mid.readable) {
			fail(`${arm.id}: ${mid.why} with one end revived, so the half-revived state was not measured`);
		} else if (!mid.wired) {
			fail(`${arm.id}: the wire vanished the moment ONE end was revived — at ${MEASURED_AT} it `
				+ "survived that step, so a wire the payload captured on a half-built pair no longer "
				+ "means at this pin what the capture assumes");
		} else if (mid.realWired) {
			fail(`${arm.id}: with one end still a GHOST the wire already reads inside real_connections — `
				+ "that is the exact partition both prune passes rest on (the real pass takes "
				+ "real_connections, the ghost pass takes the is_ghost remainder), and it does not hold "
				+ `at this pin as it did at ${MEASURED_AT}`);
		} else {
			pass(`${arm.id}: one real end and one ghost end still read the wire as a GHOST wire — outside `
				+ "real_connections at both ends, which is the partition the two prune passes divide");
		}
	}
	if (probe.revive_b_error) fail(`${arm.id}: end B did not revive — ${probe.revive_b_error}`);
	sayPair("after reviving BOTH", probe.after_both);
	const after = pairShape(probe.after_both);
	if (!after.readable) {
		fail(`${arm.id}: ${after.why} after the revive, so the arm has no post-revive state to grade`);
		return null;
	}
	if (!after.bothReal) {
		fail(`${arm.id}: after reviving both ends the pair does not read as two ${POLE_TYPE} entities, so `
			+ "whatever its wire set shows is not a statement about two REAL poles");
		return null;
	}
	return after;
}

function reportRealPairProbes(probes) {
	say("\n=== REAL-PAIR GHOST WIRE PROBES: can a ghost wire hold between two NON-ghost poles at this pin? ===");
	const list = asArray(probes);
	if (list.length === 0) {
		fail("the source rig returned no real-pair probes, so this run measures nothing about whether a ghost "
			+ "wire can exist between two REAL poles and the class stays UNMEASURED");
		return;
	}
	const byId = new Map(list.map(probe => [probe.id, probe]));
	const graded = [];
	for (const arm of REAL_PAIR_ARMS) {
		const probe = byId.get(arm.id);
		say(`\n  -- ${arm.id}: ${arm.label}`);
		if (!probe) {
			fail(`the source rig ran no ${arm.id} arm, so "${arm.label}" measured nothing`);
			continue;
		}
		if (probe.error) {
			fail(`${arm.id} could not run: ${probe.error}`);
			continue;
		}
		say(`     the pair stands ${probe.distance ?? "an unmeasured distance"} tiles apart; `
			+ `arming returned ${probe.armed}`);
		const after = checkReviveArm(arm, probe);
		if (!after) continue;
		if (after.ghostConnector) {
			fail(`${arm.id}: both ends read as ${POLE_TYPE} yet a copper connector still reports `
				+ "is_ghost=true — the prune's ghost pass selects wires on exactly that flag "
				+ "(deserializer.lua:1522), so this pin does not mean by is_ghost what both passes assume");
		}
		const outcome = after.ghostWire ? "ghost" : after.realWired ? "real" : "none";
		say(`     MEASURED: ${OUTCOME_TEXT[outcome]}`);
		if (!arm.expect.includes(outcome)) {
			fail(`${arm.id}: ${MEASURED_AT} measured ${arm.expect.map(e => OUTCOME_TEXT[e]).join(" or ")} `
				+ `between the two REAL poles at the end of this arm; this run reads ${OUTCOME_TEXT[outcome]}`);
		}
		graded.push({ arm, after, outcome });
	}

	const control = graded.find(g => g.arm.control);
	if (control && control.after.wired) {
		fail("the control pair came out of the revive WIRED although the source never wired it — revive "
			+ "fabricates a wire at this pin, so no other arm's wire can be attributed to what it carried in");
	} else if (control) {
		pass("the control holds: reviving two ghosts the source never wired leaves them unwired, so a wire "
			+ "seen on a wired arm came from what that arm armed");
	}

	const load = graded.find(g => g.arm.load);
	if (!load) {
		fail("the load-bearing arm (out-of-reach ghost pair, wired, both ends revived) did not grade, so this "
			+ "run does not settle whether wire ghostness is derived from connector ghostness or stored per "
			+ "wire, and the real-to-real class stays UNMEASURED");
		return;
	}
	const reachable = graded.filter(g => g.outcome === "ghost");
	say(`\n  VERDICT — a ghost wire between two REAL poles is ${reachable.length ? "REACHABLE"
		: "NOT REACHABLE"} by any producer probed here (this grades the arms above; it contains no novel `
		+ "producer, so what it defends is the revive transition, not the whole space of producers)");
	if (reachable.length) {
		fail(`${reachable.map(g => g.arm.id).join(", ")} produced a wire between two REAL poles that is `
			+ "absent from real_connections while neither connector is a ghost. At " + MEASURED_AT + " no "
			+ "producer could, which is why prune_pole_copper's two passes may partition every wire "
			+ "between real_connections and the is_ghost remainder. A producer for that class means the "
			+ "payload's circuit_connections record (which carries no ghostness) now conflates a PLANNED "
			+ "wire with a real one: restore_circuit_connections replays it through connect_to "
			+ "(deserializer.lua:1374), which between two real entities can only make a REAL wire, and "
			+ "payload_copper_peers (deserializer.lua:1420) then whitelists that pair against the prune");
	}
	say(`  the load-bearing arm ended ${load.after.ghostWire ? "with a wire outside real_connections"
		: load.after.realWired ? "with the wire in real_connections at both ends"
			: "with no wire at all"}, both ends reading as ${POLE_TYPE}`);
	if (!load.after.wired) {
		const near = graded.find(g => g.arm.id === "revive_near_wired");
		say("  that arm's pair is out of wire reach, so 'no wire' there cannot separate 'the engine dropped "
			+ "an unreachable wire on revive' from 'the wire was never carried'; the IN-reach arm is what "
			+ `carries the conclusion in that case, and it ended ${near ? near.after.ghostWire
				? "OUTSIDE real_connections" : near.after.realWired ? "inside real_connections at both ends"
					: "with no wire either" : "ungraded"}`);
	} else {
		say("  no auto-connect can reach across that pair, so the wire it ended with is the one the arm armed "
			+ "while both ends were ghosts, not a fresh one the engine supplied");
	}
	say("  what actually forecloses the class is not this enumeration but the API the prune reads: upstream "
		+ "2.1.11 defines is_ghost as \"If this connector is owned by an entity inside of a ghost\", and "
		+ "real_connections as the wires \"between two non-ghost entities\", so two REAL poles have no ghost "
		+ "connector and any wire between them is in real_connections by definition");
	say("  producers FORECLOSED by API surface, not probed: connect_to's origin enum has exactly three "
		+ "members (player, radars, script) and none is a ghost origin; LuaUndoRedoStack exposes get/remove/"
		+ "tag methods only and none applies an undo item");
	say("  producers NOT PROBED, named so the enumeration is not read as closed: LuaPlayer.build_from_cursor "
		+ "(the player's own blueprint paste path), LuaSurface.clone_area/clone_entities/clone_brush (this "
		+ "repo's own clone_platform path, and how this very test makes its clone), and LuaPlayer.drag_wire. "
		+ "LuaItemCommon.build_blueprint was attempted and could not be exercised at all: in both build "
		+ "modes it created zero ghosts over the pair and zero onto empty charted foundation, so it is "
		+ "inert on a platform surface by that path and establishes nothing either way");
}

function checkProxyNilControl(host, placementById) {
	const nilProxy = placementById.get("proxynil");
	if (!nilProxy || !nilProxy.placed) {
		fail("the nil-target proxy-container never placed on the source, so the control that proves the "
			+ "relink pass does not FABRICATE a reference did not run");
		return;
	}
	const answer = lua(host, `${platformLua(CLONE)}
local out = { success = true }
local found = s.find_entities_filtered{ name = 'proxy-container', position = { ${nilProxy.x}, ${nilProxy.y} }, radius = 0.3 }
local e = found and found[1]
out.nil_proxy_found = e ~= nil and e.valid
if e and e.valid then
  out.nil_proxy_target = e.proxy_target_entity and e.proxy_target_entity.name or 'nil'
end
return out`);

	if (answer.nil_proxy_found !== true) {
		fail("the nil-target proxy-container did not arrive on the destination — the fabrication control "
			+ "cannot be read");
	} else if (answer.nil_proxy_target !== "nil") {
		fail(`nil-target control: the arrived proxy-container reads proxy_target_entity = `
			+ `${JSON.stringify(answer.nil_proxy_target)} — the relink pass INVENTED a reference the source `
			+ "never had");
	} else {
		pass("nil-target control: a proxy-container exported with no target arrives with no target");
	}
}

function storedImportField(field) {
	const out = execFileSync("node", ["tools/tests/testkit/cli.mjs", "log", "latest", "--field", field, "--json"],
		{ encoding: "utf8", timeout: 120_000, cwd: REPO_ROOT });
	return JSON.parse(out).value;
}

function checkProxiesLinkedWire(host) {
	say("\n=== CONTROL: the relink count the destination reported is the count the store persisted ===");
	const answer = lua(host, `${platformLua(CLONE)}
local linked = 0
for _, e in pairs(s.find_entities_filtered{ type = 'proxy-container' }) do
  if e.valid and e.proxy_target_entity and e.proxy_target_entity.valid then linked = linked + 1 end
end
return { success = true, linked = linked }`);
	const physical = Number(answer.linked);

	let stored;
	let dotted;
	try {
		stored = storedImportField("summary.import");
		dotted = storedImportField("summary.import.proxies_linked");
	} catch (error) {
		console.error(error && error.stack ? error.stack : error);
		fail(`reading the persisted import metrics failed: ${error.message} `
			+ `${String(error.stderr || "").trim().slice(-300)} — proxies_linked reaches the controller's raw `
			+ "event, but only enters summary.import if the Lua emission and buildImportMetrics both carry "
			+ "it, and summary.import is what an operator and testkit log actually read");
		return;
	}

	if (!Object.hasOwn(stored, "proxies_linked")) {
		fail(`summary.import carries no proxies_linked key at all (keys: ${Object.keys(stored).join(", ")}) `
			+ "— the count dies between the Lua event and the store, where no reader can ever see it");
		return;
	}
	if (physical < 1) {
		fail("the destination holds no proxy-container with a target, so this transfer relinked nothing and "
			+ "a stored 0 would agree with the physical read vacuously — the rig's targeted proxy-container "
			+ "did not arrive, which is a hole in this control, not a pass");
		return;
	}
	if (stored.proxies_linked !== physical) {
		fail(`summary.import.proxies_linked reads ${JSON.stringify(stored.proxies_linked)}, but the `
			+ `destination physically holds ${physical} proxy-container(s) with a live target — the stored `
			+ "number is the only copy that outlives the instance log, so a disagreement here is the number "
			+ "every later reader gets. Both sides key on TYPE: restore_proxy_targets returns 0 unless "
			+ "entity.type == 'proxy-container', so a probe filtered by NAME would be a different set and "
			+ "this equality would be measuring two questions");
		return;
	}
	if (dotted !== physical) {
		fail(`the dotted query path summary.import.proxies_linked answers ${JSON.stringify(dotted)}, not the `
			+ `${physical} the destination physically holds`);
		return;
	}
	pass(`summary.import.proxies_linked reads ${physical}, agreeing with the destination's own physical `
		+ "count of proxy-containers holding a live target");
}

function checkPoleCopperFarEnds(host, placementById) {
	say("\n=== CONTROL: the far end of each copper pair ===");
	const wire1 = placementById.get("polewire1");
	const wire2 = placementById.get("polewire2");
	const near2 = placementById.get("polenear2");
	if (!(wire1?.placed && wire2?.placed && near2?.placed)) {
		fail("a copper-pair pole is missing from the source rig, so neither far end can be read — a wire "
			+ "present at one end only, and a fabricated wire seen from the other side, both go unmeasured");
		return;
	}
	const answer = lua(host, `${platformLua(CLONE)}
${READER_HELPERS}
local out = { success = true }
local function copper(x, y)
  local found = s.find_entities_filtered{ name = 'small-electric-pole', position = { x, y }, radius = 0.3 }
  local e = found and found[1]
  if not (e and e.valid) then return 'MISSING' end
  return copper_side_key(e, defines.wire_connector_id.pole_copper)
end
out.wire2 = copper(${wire2.x}, ${wire2.y})
out.near2 = copper(${near2.x}, ${near2.y})
return out`);

	const wire2Expect = offsetKey(wire1, wire2);
	if (answer.wire2 === "MISSING") {
		fail("polewire2 did not arrive on the destination, so the far end of the armed copper wire cannot "
			+ "be read");
	} else if (answer.wire2 !== wire2Expect) {
		fail(`polewire2 reads copper ${JSON.stringify(answer.wire2)}, expected `
			+ `${JSON.stringify(wire2Expect)} — the armed wire is present at one end only, or a second wire `
			+ "arrived at the far end");
	} else {
		pass(`the armed copper wire arrives at BOTH ends: polewire2 reads ${JSON.stringify(answer.wire2)}`);
	}

	if (answer.near2 === "MISSING") {
		fail("polenear2 did not arrive on the destination, so the far end of the unwired pair cannot be read");
	} else if (asNoCopper(answer.near2) !== NO_COPPER) {
		fail(`polenear2 reads copper ${JSON.stringify(answer.near2)} — it stands within wire reach of `
			+ "polenear1 and the source left the pair unwired, so the import FABRICATED a connection the "
			+ "payload never carried");
	} else {
		pass(`the unwired pair is unwired at BOTH ends: polenear2 reads ${JSON.stringify(answer.near2)}`);
	}
}

const GHOST_FAR_ENDS = [
	{ id: "gwire2", peer: "gwire1", wired: true, label: "the ghost-to-ghost wired pair" },
	{ id: "gnear2", peer: "gnear1", wired: false, label: "the ghost-to-ghost unwired pair" },
	{ id: "rmixwire", peer: "gmixwire", wired: true, label: "the ghost-to-real wired pair" },
	{ id: "rmixnear", peer: "gmixnear", wired: false, label: "the ghost-to-real unwired pair" },
];

function checkGhostCopperFarEnds(host, placementById) {
	say("\n=== CONTROL: the far end of every ghost copper pair ===");
	const targets = [];
	for (const far of GHOST_FAR_ENDS) {
		const end = placementById.get(far.id);
		const peer = placementById.get(far.peer);
		if (!(end?.placed && peer?.placed)) {
			fail(`${far.label} is missing a pole on the source rig, so its far end cannot be read — a wire `
				+ "present at one end only, and a fabricated wire seen from the other side, both go unmeasured");
			continue;
		}
		targets.push({ ...far, end, peer });
	}
	if (targets.length === 0) return;

	const targetLua = targets.map(t => `  { id = '${t.id}', name = '${t.end.name}', x = ${t.end.x}, `
		+ `y = ${t.end.y} },`).join("\n");
	const answer = lua(host, `${platformLua(CLONE)}
${READER_HELPERS}
local targets = {
${targetLua}
}
local rows = {}
for _, t in ipairs(targets) do
  local found = s.find_entities_filtered{ name = t.name, position = { t.x, t.y }, radius = 0.3 }
  local e = found and found[1]
  if e and e.valid then
    rows[#rows + 1] = { id = t.id, value = copper_wire_key(e, defines.wire_connector_id.pole_copper) }
  else
    rows[#rows + 1] = { id = t.id, value = 'MISSING' }
  end
end
return { success = true, rows = rows }`);

	const byId = new Map(asArray(answer.rows).map(row => [row.id, row]));
	for (const target of targets) {
		const row = byId.get(target.id);
		const expected = target.wired ? wireKey(target.peer, target.end) : NO_GHOST_COPPER;
		if (!row || row.value === "MISSING") {
			fail(`${target.id} did not arrive on the destination, so the far end of ${target.label} cannot `
				+ "be read");
		} else if (asNoGhostCopper(row.value) !== expected) {
			fail(`${target.id} reads copper ${JSON.stringify(row.value)}, expected ${JSON.stringify(expected)}`
				+ (target.wired
					? ` — ${target.label} arrived at one end only, or a second wire arrived at this end`
					: ` — ${target.label} stands within wire reach and the source left it unwired, so this end `
						+ "carries a connection the payload never had"));
		} else {
			pass(`${target.label}: ${target.id} reads ${JSON.stringify(row.value)}`);
		}
	}
}

function reportPruneLog(host) {
	say("\n=== MEASUREMENT: the destination's own pole-copper prune lines ===");
	const path = `/clusterio/data/instances/${HOSTS[host].instance}/factorio-current.log`;
	const out = docker(["exec", HOSTS[host].container, "sh", "-c",
		`grep -F -e 'Pole copper pruned' -e 'pole copper prune' ${path} | tail -20 || true`]);
	const lines = out.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	if (lines.length === 0) {
		say("  none in this instance's log; the destination reads above are the only account of the prune");
		return;
	}
	for (const line of lines) say(`  ${line}`);
}

const DECLINE_LOG_MARKER = "is not a player on this instance";
const DECLINE_LOG_ATTEMPTS = 6;

async function findDeclineLogLine(host, uniqueName) {
	const path = `/clusterio/data/instances/${HOSTS[host].instance}/factorio-current.log`;
	for (let attempt = 1; attempt <= DECLINE_LOG_ATTEMPTS; attempt++) {
		const out = docker(["exec", HOSTS[host].container, "sh", "-c",
			`grep -F '${uniqueName}' ${path} || true`]);
		const line = out.split(/\r?\n/).find(l => l.includes(DECLINE_LOG_MARKER));
		if (line) return line.trim();
		if (attempt < DECLINE_LOG_ATTEMPTS) await sleep(1000);
	}
	return null;
}

async function checkLastUserConditional(host, base) {
	say("\n=== CONTROLS: the last_user conditional, both arms ===");
	if (RUNTIME.sourcePlayer === null) return;
	const absentName = `cfgattr-absent-${CLONE}`;
	const answer = lua(host, `${platformLua(CLONE)}
local out = { success = true }
local probes = {}
local function probe(label, user, x, y)
  local payload = { name = 'stone-wall', type = 'wall', position = { x = x, y = y },
    direction = 0, force = 'player', last_user = user }
  local ok, res = pcall(function()
    return remote.call('surface_export', 'test_import_entity', payload, s.index)
  end)
  local row = { label = label, call_ok = ok, armed_name = user }
  if ok then
    row.errors = #(res.errors or {})
    row.first_error = (res.errors or {})[1]
    local placed = res.entity
    row.created = placed ~= nil and placed.valid
    if placed and placed.valid then
      row.last_user = placed.last_user and placed.last_user.name or 'nil'
      row.removed = placed.destroy()
    end
  else
    row.call_error = tostring(res)
  end
  probes[#probes + 1] = row
end
probe('roster_name', '${RUNTIME.sourcePlayer}', ${base.x} + 27.5, ${base.y} + 1.5)
probe('absent_name', '${absentName}', ${base.x} + 27.5, ${base.y} + 4.5)
out.probes = probes
out.walls_left = #s.find_entities_filtered{ name = 'stone-wall', area = { { ${base.x} + 27, ${base.y} + 1 }, { ${base.x} + 28, ${base.y} + 5 } } }
return out`);

	if (answer.walls_left !== 0) {
		fail(`${answer.walls_left} control probe entit(ies) survived their own cleanup and will ride the `
			+ "export — the payload under test is no longer the rig the rest of this run describes");
	}
	const probes = new Map(asArray(answer.probes).map(row => [row.label, row]));
	const roster = probes.get("roster_name");
	const absent = probes.get("absent_name");
	if (!roster || !absent) {
		fail("the last_user conditional probes did not both report — the negative arm is unproven");
		return;
	}
	for (const [label, row] of [["roster_name", roster], ["absent_name", absent]]) {
		if (row.call_ok !== true) {
			fail(`last_user ${label}: the restore path THREW (${row.call_error}) — a captured name must never `
				+ "kill the import");
		} else if (row.created !== true) {
			fail(`last_user ${label}: the probe entity did not place (${row.first_error ?? "no error"}), so `
				+ "the conditional was never exercised");
		}
	}
	if (roster.call_ok && roster.created && roster.last_user !== roster.armed_name) {
		fail(`last_user roster_name: restored ${JSON.stringify(roster.last_user)} for a name that DOES exist `
			+ `on this instance (${JSON.stringify(roster.armed_name)}) — with the positive arm dead, the `
			+ "absent-name arm below proves nothing");
	} else if (roster.call_ok && roster.created) {
		pass(`last_user positive arm: a captured name present in this instance's roster restores `
			+ `(${JSON.stringify(roster.last_user)})`);
	}
	if (absent.call_ok && absent.created) {
		if (absent.last_user !== "nil") {
			fail(`last_user absent_name: the restore attributed ${JSON.stringify(absent.last_user)} to an `
				+ `entity whose captured name (${JSON.stringify(absentName)}) is NOT a player here — a wrong `
				+ "person is worse than nobody");
		} else {
			pass("last_user negative arm: a captured name absent from the roster leaves the entity "
				+ "unattributed, with no error");
		}
		const declineLine = await findDeclineLogLine(host, absentName);
		if (declineLine === null) {
			fail(`last_user absent_name: the restore left the entity unattributed but emitted NO decline line `
				+ `naming ${JSON.stringify(absentName)} in ${HOSTS[host].instance}'s factorio-current.log. A nil `
				+ "read alone cannot tell the conditional apart from its own deletion: writing the raw name "
				+ "unconditionally makes the engine throw Invalid PlayerIdentification, the existing pcall "
				+ "swallows it, and last_user stays nil either way. The log line is what distinguishes them");
		} else {
			pass(`last_user decline is explicit, not incidental: ${JSON.stringify(declineLine.slice(-120))}`);
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
	say(`=== config-attrs: ${ATTRS.length} attribute rows across a real transfer (clone '${CLONE}') ===`);

	const fixtureIndex = findPlatformIndex(SOURCE_HOST, FIXTURE);
	if (fixtureIndex === null) {
		throw new Error(`'${FIXTURE}' not found on host ${SOURCE_HOST} — wrong save loaded?`);
	}
	say(`fixture '${FIXTURE}' resolved to index ${fixtureIndex} on host ${SOURCE_HOST}`);

	measureEnvironment();
	checkInert();

	try {
		const cloneIndex = await cloneFixture(fixtureIndex);
		say(`clone ready at index ${cloneIndex}`);

		say("\n=== SOURCE: build rig, write non-default values, read back ===");
		const built = buildAndArm();
		say(`  rig base at (${built.base.x}, ${built.base.y})`);
		const placementById = new Map();
		const stockById = new Map(RIG_ENTITIES.filter(entity => entity.stock).map(entity => [entity.id, entity.stock]));
		for (const placement of asArray(built.placements)) {
			placementById.set(placement.id, placement);
			if (!placement.placed) {
				fail(`rig entity '${placement.id}' (${placement.name}) did NOT place (${placement.error}) — every `
					+ "attribute on it is UNEXERCISED, which is a hole in this test, not a pass");
				continue;
			}
			say(`  built ${placement.id}: ${placement.name}`
				+ `${placement.ghost_name ? ` of ${placement.ghost_name}` : ""} (${placement.etype}) at `
				+ `${placement.x},${placement.y}`);
			const stock = stockById.get(placement.id);
			if (stock && placement.stocked !== stock.count) {
				fail(`rig entity '${placement.name}' took ${placement.stocked} of ${stock.count} ${stock.name} — `
					+ "every item-side attribute row reads that stack, so a short insert leaves them unexercised");
			}
		}

		armCopperExpect(placementById);
		armPoleCopperExpect(placementById);
		armScriptCopperExpect(placementById);
		armGhostCopperExpect(placementById);
		checkPoleGeometry(placementById, Number(built.pole_wire_reach));
		reportGhostWireFacts(asArray(built.wire_facts));
		reportRealPairProbes(built.real_pair_probes);

		await checkLastUserConditional(SOURCE_HOST, built.base);

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
			const declared = Object.hasOwn(spec, "destExpect");
			if (declared && spec.destExpect === null) {
				fail(`${spec.key}: UNEXERCISED on this destination — see the ENVIRONMENT section above; no `
					+ "destination read can distinguish a working capture and restore from a deleted one here");
				continue;
			}
			const expected = declared ? spec.destExpect : spec.expect;
			if (!row) {
				fail(`${spec.key}: no destination row came back`);
			} else if (!row.found) {
				fail(`${spec.key}: '${spec.entity_name}' not found on the destination at ${spec.x},${spec.y}`);
			} else if (!matches(spec, row.value, expected)) {
				fail(`${spec.key}: destination reads ${JSON.stringify(row.value)}, expected `
					+ `${JSON.stringify(expected)} — the attribute did NOT survive the transfer`
					+ `${spec.describe ? ` (${spec.describe})` : ""}`);
			} else {
				pass(`${spec.key} survived: ${spec.entity_name}@${spec.x},${spec.y} reads `
					+ `${JSON.stringify(row.value)}`);
			}
		}

		checkProxyNilControl(DEST_HOST, placementById);
		checkProxiesLinkedWire(DEST_HOST);
		checkPoleCopperFarEnds(DEST_HOST, placementById);
		checkGhostCopperFarEnds(DEST_HOST, placementById);
		reportPruneLog(DEST_HOST);
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
