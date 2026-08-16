#!/usr/bin/env node
// dispatch-pins — the engine facts GameUtils.TYPE_TO_CATEGORY and the artillery-turret handler rest on
//
// requires: a running surface-export cluster (host 1 answering RCON)
// produces: the live entity-type roster diffed against the list vendored in
//           test/entity-dispatch-reachability.test.cjs, and the member roster of a placed
//           artillery-turret — control behavior, priority_targets, ignore_unprioritised_targets,
//           artillery_auto_targeting — each REPRODUCED or DIVERGED against the recorded pin
// does not: transfer anything, exercise the export or import path, prove that any field SURVIVES a
//           transfer (only tests/integration/config-attrs measures survival), or leave the probe
//           entity behind — it destroys it and reports a leak as a failure

import { lua } from "../../lab-gallery/batch-lifecycle.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HOST = 1;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const VENDORED_LIST = join(SCRIPT_DIR, "..", "..", "..", "docker", "seed-data", "external_plugins",
	"surface_export", "test", "entity-dispatch-reachability.test.cjs");
const EXPECTED_FACTS = 5;

const say = (...a) => console.log(...a);
const problems = [];
function fail(message) {
	problems.push(message);
	process.exitCode = 1;
	say(`  DIVERGED ${message}`);
}
function reproduced(message) {
	say(`  REPRODUCED ${message}`);
}

function vendoredTypes() {
	const source = readFileSync(VENDORED_LIST, "utf8");
	const marker = "const ENTITY_TYPES_AT_PIN_2_1_11 = [";
	const start = source.indexOf(marker);
	if (start === -1) throw new Error(`${VENDORED_LIST} no longer declares ENTITY_TYPES_AT_PIN_2_1_11`);
	const end = source.indexOf("];", start);
	if (end === -1) throw new Error("ENTITY_TYPES_AT_PIN_2_1_11 is not a closed array");
	return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map(m => m[1]);
}

say("=== dispatch-pins: what the explicit type->category table rests on ===");

const roster = lua(HOST, `local seen, list = {}, {}
for _, proto in pairs(prototypes.entity) do
  if not seen[proto.type] then seen[proto.type] = true; list[#list + 1] = proto.type end
end
table.sort(list)
return { success = true, types = list, count = #list }`);
if (roster.success !== true) throw new Error(`entity-type sweep failed: ${roster.error}`);

const live = new Set(roster.types);
const vendored = new Set(vendoredTypes());
const added = [...live].filter(t => !vendored.has(t)).sort();
const removed = [...vendored].filter(t => !live.has(t)).sort();

say(`\n-- entity-type roster: ${roster.count} live, ${vendored.size} vendored --`);
if (added.length === 0 && removed.length === 0) {
	reproduced(`the vendored type list still matches the engine (${roster.count} types)`);
} else {
	fail(`the entity-type roster MOVED — re-derive GameUtils.TYPE_TO_CATEGORY by replaying the mapping `
		+ `over the new roster, then update ENTITY_TYPES_AT_PIN_2_1_11 and its length assertion.`
		+ (added.length ? `\n    engine has, list lacks:  ${added.join(", ")}` : "")
		+ (removed.length ? `\n    list has, engine lacks:  ${removed.join(", ")}` : ""));
}

const probe = lua(HOST, `local s = game.surfaces['nauvis']
local pos = s.find_non_colliding_position('artillery-turret', {0, 0}, 80, 1)
if pos == nil then return { success = false, error = 'no free position on nauvis' } end
local t = s.create_entity{ name = 'artillery-turret', position = pos, force = 'player' }
if t == nil then return { success = false, error = 'create_entity returned nil' } end
local function read(fn)
  local ok, value = pcall(fn)
  if ok then return { threw = false, value = tostring(value) } end
  return { threw = true, value = tostring(value) }
end
local out = {
  success = true,
  etype = t.type,
  has_control_behavior = t.get_control_behavior() ~= nil,
  artillery_auto_targeting = read(function() return t.artillery_auto_targeting end),
  priority_targets = read(function() return t.priority_targets end),
  ignore_unprioritised_targets = read(function() return t.ignore_unprioritised_targets end),
}
local area = { { pos.x - 6, pos.y - 6 }, { pos.x + 6, pos.y + 6 } }
t.destroy()
out.leaked = #s.find_entities_filtered{ area = area, name = 'artillery-turret' }
return out`);
if (probe.success !== true) throw new Error(`artillery-turret probe failed: ${probe.error}`);

say("\n-- artillery-turret members (the turret handler's captures, on an artillery turret) --");
say(`  type=${probe.etype} has_control_behavior=${probe.has_control_behavior}`);
say(`  artillery_auto_targeting     threw=${probe.artillery_auto_targeting.threw} `
	+ `value=${probe.artillery_auto_targeting.value}`);
say(`  priority_targets             threw=${probe.priority_targets.threw} `
	+ `value=${probe.priority_targets.value}`);
say(`  ignore_unprioritised_targets threw=${probe.ignore_unprioritised_targets.threw} `
	+ `value=${probe.ignore_unprioritised_targets.value}`);

if (probe.has_control_behavior === false) {
	reproduced("an artillery-turret has NO control behavior — the turret handler's four "
		+ "get_control_behavior() reads cannot capture anything on one");
} else {
	fail("an artillery-turret NOW HAS a control behavior — the turret handler's read_ammo / "
		+ "set_priority_list / set_ignore_unlisted_targets / ignore_unlisted_targets_condition captures "
		+ "are now reachable on it, so EntityHandlers['artillery-turret'] must delegate to "
		+ "EntityHandlers['turret'] instead of standing alone");
}

if (probe.priority_targets.threw === true) {
	reproduced("priority_targets throws on an artillery-turret");
} else {
	fail("priority_targets NO LONGER throws on an artillery-turret — it is now capturable, and "
		+ "deserializer.lua restores it (entity.set_priority_target), so the artillery handler must "
		+ "delegate to the turret handler");
}

if (probe.ignore_unprioritised_targets.threw === true) {
	reproduced("ignore_unprioritised_targets throws on an artillery-turret");
} else {
	fail("ignore_unprioritised_targets NO LONGER throws on an artillery-turret — it is now capturable, "
		+ "and SIMPLE_RESTORE_RULES restores it, so the artillery handler must delegate to the turret "
		+ "handler");
}

if (probe.artillery_auto_targeting.threw === false) {
	reproduced(`artillery_auto_targeting reads on an artillery-turret (fresh default `
		+ `"${probe.artillery_auto_targeting.value}") — the field the artillery handler exists to carry`);
} else {
	fail("artillery_auto_targeting THREW on an artillery-turret — the artillery handler's only "
		+ "capture is gone");
}

if (probe.leaked !== 0) {
	fail(`the probe artillery-turret did not clean up: ${probe.leaked} left on nauvis`);
}

say(`\n=== dispatch-pins: ${problems.length === 0 ? `all ${EXPECTED_FACTS} facts REPRODUCED`
	: `${problems.length} DIVERGENCE(S)`} ===`);
