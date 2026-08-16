#!/usr/bin/env node
// segmented-unit-sleep — a demolisher staged asleep and indestructible must ARRIVE asleep and
// indestructible, measured physically at the destination after activation
//
// requires: the cluster up, host-2 able to receive, debug_mode writable on host-2 (the gate verdict
//           is read from the destination's own debug_import_result)
// produces: a THROWAWAY probe platform built for this run — hub, a foundation pad, and one
//           segmented-unit frozen by the #247 sequence (destructible=false, then
//           minimum_activity_mode, then activity_mode=asleep LAST) — a source read-back taken
//           twice so a broken staging cannot masquerade as a broken transfer, the gate verdict
//           parsed from debug_import_result before any destination read, and a DESTINATION read of
//           LuaEntity.destructible + LuaSegmentedUnit.activity_mode taken twice 120 ticks apart so
//           a unit between steps cannot read as asleep
// does not: touch a protected fixture or the shared config-attrs rig (an awake demolisher eats its
//           platform, so it gets its own throwaway and the throwaway is swept unconditionally);
//           read the export payload (payload presence is not restoration); assert item or fluid
//           fidelity (the gate does that); prove anything about a segmented unit the engine
//           refused to place (a refused staging is reported as a setup failure, never as a
//           transfer verdict)

import {
	lua as luaRaw, rcon, sleep, docker, instanceIds, createBatchLifecycle, HOSTS,
} from "../../lab-gallery/batch-lifecycle.mjs";

const SOURCE_HOST = 1;
const DEST_HOST = 2;
const RUN_TAG = Date.now().toString(36);
const PROBE = `segunit-${RUN_TAG}`;
const HOLD_MS = 3000;
const PAD = 20;
const CANDIDATES = ["big-demolisher", "medium-demolisher", "small-demolisher"];
const PLACE_ANCHORS = [{ x: 0, y: -12 }, { x: 0, y: 12 }, { x: -12, y: 0 }, { x: 12, y: 0 }];

const L = createBatchLifecycle({
	goldenSourceSave: "unused.zip", goldenDestSave: "unused.zip",
	markerPrefix: "segunit-sleep",
});

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

const READ_LUA = `local heads = {}
for _, e in pairs(s.find_entities_filtered{ type = 'segmented-unit' }) do
  if e.valid then
    local rec = { name = e.name, destructible = e.destructible, unit_number = e.unit_number,
      x = e.position.x, y = e.position.y }
    local su = e.segmented_unit
    if su and su.valid then
      rec.activity_mode = su.activity_mode
      rec.minimum_activity_mode = su.minimum_activity_mode
      rec.segments = #su.segments
    end
    heads[#heads + 1] = rec
  end
end
local modes = {}
for k, v in pairs(defines.segmented_unit_activity_mode) do modes[k] = v end
return { success = true, heads = heads, modes = modes,
  segment_entities = s.count_entities_filtered{ type = 'segment' },
  corpses = s.count_entities_filtered{ type = 'corpse' },
  paused = (p.paused == true) }`;

function readState(host, name) {
	return lua(host, `${platformLua(name)}\n${READ_LUA}`);
}

function describe(state) {
	if (!state.heads || state.heads.length === 0) return "no segmented-unit on the surface";
	return state.heads.map(h => `${h.name}#${h.unit_number} destructible=${h.destructible} `
		+ `activity_mode=${h.activity_mode} minimum=${h.minimum_activity_mode} `
		+ `segments=${h.segments} at (${Number(h.x).toFixed(3)},${Number(h.y).toFixed(3)})`).join(" | ");
}

const CANDIDATE_LUA = CANDIDATES.map(n => `'${n}'`).join(", ");
const ANCHOR_LUA = PLACE_ANCHORS.map(a => `{ ${a.x}, ${a.y} }`).join(", ");

function buildProbePlatform() {
	return lua(SOURCE_HOST, `local p = game.forces.player.create_space_platform{ name = '${PROBE}',
  planet = 'nauvis', starter_pack = 'space-platform-starter-pack' }
if not p then return { success = false, error = 'create_space_platform returned nil' } end
p.apply_starter_pack()
local s = p.surface
local tiles = {}
for x = ${-PAD}, ${PAD - 1} do
  for y = ${-PAD}, ${PAD - 1} do
    tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { x, y } }
  end
end
s.set_tiles(tiles)
p.paused = false
return { success = true, index = p.index,
  tiles = s.count_tiles_filtered{ name = 'space-platform-foundation' } }`);
}

function stageFrozenUnit() {
	return lua(SOURCE_HOST, `${platformLua(PROBE)}
local tried, placed = {}, nil
for _, name in ipairs({ ${CANDIDATE_LUA} }) do
  if not placed then
    local proto = prototypes.entity[name]
    if not proto then
      tried[#tried + 1] = name .. ': no such prototype at this pin'
    else
      local box = proto.collision_box
      for _, anchor in ipairs({ ${ANCHOR_LUA} }) do
        if not placed then
          local pos = s.find_non_colliding_position(name, anchor, ${PAD}, 1) or anchor
          local ok, res = pcall(function()
            return s.create_entity{ name = name, position = pos, force = 'player' }
          end)
          if not ok then
            tried[#tried + 1] = string.format('%s at (%.1f,%.1f): %s', name, pos[1] or pos.x,
              pos[2] or pos.y, string.sub(tostring(res), 1, 120))
          elseif not (res and res.valid) then
            tried[#tried + 1] = string.format('%s at (%.1f,%.1f): create_entity returned nil', name,
              pos[1] or pos.x, pos[2] or pos.y)
          else
            placed = res
            tried[#tried + 1] = string.format('%s PLACED (collision box %.1f x %.1f)', name,
              box.right_bottom.x - box.left_top.x, box.right_bottom.y - box.left_top.y)
          end
        end
      end
    end
  end
end
if not placed then
  return { success = false, error = 'no segmented-unit could be placed: ' .. table.concat(tried, ' / ') }
end

placed.destructible = false
local disabled_write_ok = pcall(function() placed.disabled_by_script = true end)
local disabled_read_ok, disabled_read = pcall(function() return placed.disabled_by_script end)
local su = placed.segmented_unit
if not (su and su.valid) then
  return { success = false, error = 'the placed ' .. placed.name .. ' exposes no segmented_unit' }
end
local asleep = defines.segmented_unit_activity_mode.asleep
local minimum_write_ok = pcall(function() su.minimum_activity_mode = asleep end)
local mode_write_ok = pcall(function() su.activity_mode = asleep end)
return { success = true, name = placed.name, tried = tried,
  disabled_write_ok = disabled_write_ok,
  disabled_read = (disabled_read_ok and disabled_read or 'read threw'),
  minimum_write_ok = minimum_write_ok, mode_write_ok = mode_write_ok }`);
}

function destinationLogLines(pattern) {
	const path = `/clusterio/data/instances/${HOSTS[DEST_HOST].instance}/factorio-current.log`;
	const out = docker(["exec", HOSTS[DEST_HOST].container, "sh", "-c",
		`grep -aE '${pattern}' ${path} | tail -12 || true`]);
	return out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

async function reportWhyRed() {
	say("\n=== DIAGNOSTIC (the destination arm went red) ===");
	for (const line of destinationLogLines("demolisher|segmented|destructible restore failed")) {
		say(`  dest log: ${line.slice(-220)}`);
	}
	try {
		const armed = lua(DEST_HOST, `${platformLua(PROBE)}
local head = s.find_entities_filtered{ type = 'segmented-unit' }[1]
if not (head and head.valid) then return { success = false, error = 'no segmented-unit to arm' } end
head.destructible = false
local su = head.segmented_unit
local asleep = defines.segmented_unit_activity_mode.asleep
local minimum_write_ok = pcall(function() su.minimum_activity_mode = asleep end)
local mode_write_ok = pcall(function() su.activity_mode = asleep end)
return { success = true, minimum_write_ok = minimum_write_ok, mode_write_ok = mode_write_ok,
  destructible = head.destructible, activity_mode = su.activity_mode }`);
		say("  control arm: writing the frozen state at the destination AFTER activation reads back "
			+ `destructible=${armed.destructible} activity_mode=${armed.activity_mode} `
			+ `(writes ok: minimum=${armed.minimum_write_ok} mode=${armed.mode_write_ok})`);
		await sleep(HOLD_MS);
		const held = readState(DEST_HOST, PROBE);
		say(`  control arm after ${HOLD_MS} ms: ${describe(held)}`);
	} catch (error) {
		console.error(error && error.stack ? error.stack : error);
		say(`  control arm could not run: ${error.message}`);
	}
}

async function main() {
	say(`=== segmented-unit-sleep: a frozen demolisher across a real transfer (probe '${PROBE}') ===`);
	const ids = instanceIds();
	const previousDebug = lua(DEST_HOST, "return { success = true, debug = (storage.surface_export_config "
		+ "and storage.surface_export_config.debug_mode) == true }");
	lua(DEST_HOST, "remote.call('surface_export', 'configure', { debug_mode = true }) return { success = true }");

	let destinationRed = false;
	try {
		say("\n=== SOURCE: build a throwaway platform and stage one frozen segmented-unit ===");
		const built = buildProbePlatform();
		say(`  platform '${PROBE}' at index ${built.index} with ${built.tiles} foundation tiles`);

		const staged = stageFrozenUnit();
		for (const attempt of staged.tried) say(`  placement: ${attempt}`);
		say(`  disabled_by_script write=${staged.disabled_write_ok} reads back ${staged.disabled_read}; `
			+ `minimum_activity_mode write=${staged.minimum_write_ok}; activity_mode write=${staged.mode_write_ok}`);

		const armed = readState(SOURCE_HOST, PROBE);
		const asleep = armed.modes.asleep;
		say(`  defines.segmented_unit_activity_mode: ${JSON.stringify(armed.modes)}`);
		say(`  source after staging: ${describe(armed)}`);
		if (armed.heads.length !== 1) {
			fail(`staging left ${armed.heads.length} segmented-unit(s) on the probe — the transfer below `
				+ "cannot measure what was never armed as exactly one");
			return;
		}
		if (armed.heads[0].destructible !== false || armed.heads[0].activity_mode !== asleep) {
			fail(`staging did not take: ${describe(armed)} (asleep=${asleep}) — a destination red would be `
				+ "a broken probe, not a broken transfer");
			return;
		}
		pass("source staged: destructible=false and activity_mode=asleep");

		await sleep(HOLD_MS);
		const settled = readState(SOURCE_HOST, PROBE);
		say(`  source after ${HOLD_MS} ms: ${describe(settled)}`);
		if (settled.heads.length !== 1 || settled.heads[0].activity_mode !== asleep
			|| settled.heads[0].destructible !== false) {
			fail("the source unit did not HOLD the frozen state before the transfer even started — "
				+ "the staging sequence is what needs fixing, not the restore");
			return;
		}
		pass(`source held the freeze across ${HOLD_MS} ms (segments flat at ${settled.heads[0].segments})`);

		say(`\n=== TRANSFER: host ${SOURCE_HOST} -> host ${DEST_HOST} through the production path ===`);
		const marker = L.dropMarker(DEST_HOST, "transfer");
		rcon(SOURCE_HOST, `/transfer-platform ${built.index} ${ids[DEST_HOST]}`);
		const { result } = await L.waitForImportResult(DEST_HOST, marker);
		if (result.validation_success !== true) {
			fail("the transfer did not pass the exact gate — destination reads below would describe a "
				+ `rolled-back or partial import, not a restoration (${JSON.stringify(result).slice(0, 400)})`);
			return;
		}
		pass("the exact gate passed (destination debug_import_result: validation_success=true)");

		say("\n=== DESTINATION: physical read of the arrived unit, after activation ===");
		let first;
		try {
			first = readState(DEST_HOST, PROBE);
		} catch (error) {
			console.error(error && error.stack ? error.stack : error);
			fail(`the arrived platform could not be read: ${error.message} — an awake demolisher that `
				+ "destroys its own hub takes the platform with it, which is this defect at its worst");
			destinationRed = true;
			return;
		}
		say(`  destination read 1: ${describe(first)} `
			+ `(segment entities ${first.segment_entities}, corpses ${first.corpses}, `
			+ `platform paused=${first.paused})`);
		if (first.heads.length !== 1) {
			fail(`the destination carries ${first.heads.length} segmented-unit(s), the source carried 1`);
			destinationRed = true;
			return;
		}
		await sleep(HOLD_MS);
		const second = readState(DEST_HOST, PROBE);
		say(`  destination read 2 (+${HOLD_MS} ms): ${describe(second)} `
			+ `(segment entities ${second.segment_entities}, corpses ${second.corpses}, `
			+ `platform paused=${second.paused})`);

		const destAsleep = first.modes.asleep;
		const head = second.heads[0];
		if (first.heads[0].destructible !== false || head.destructible !== false) {
			fail(`the arrived unit reads destructible=${head.destructible} — the source was `
				+ "destructible=false, and an entity that arrives destructible is one the destination world "
				+ "can kill for reasons the source never allowed");
			destinationRed = true;
		} else {
			pass("destructible=false survived the transfer");
		}
		if (first.heads[0].activity_mode !== destAsleep || head.activity_mode !== destAsleep) {
			fail(`the arrived unit reads activity_mode=${head.activity_mode} (asleep=${destAsleep}) — `
				+ "the source was asleep, and an awake demolisher destroys the platform it arrived on");
			destinationRed = true;
		} else {
			pass(`activity_mode=asleep survived the transfer and held across ${HOLD_MS} ms`);
		}
		if (head.minimum_activity_mode !== destAsleep) {
			fail(`the arrived unit reads minimum_activity_mode=${head.minimum_activity_mode} `
				+ `(asleep=${destAsleep}) — the floor the source set is what allows the unit to stay asleep `
				+ "at all");
			destinationRed = true;
		} else {
			pass("minimum_activity_mode=asleep survived the transfer");
		}
		const moved = Math.abs(head.x - first.heads[0].x) + Math.abs(head.y - first.heads[0].y);
		if (moved > 0.001) {
			fail(`the arrived unit MOVED ${moved.toFixed(3)} tiles between the two destination reads — `
				+ "a unit that reports asleep while moving is reporting a state it is not in");
			destinationRed = true;
		} else {
			pass("the arrived unit did not move between the two destination reads");
		}
	} finally {
		if (destinationRed) await reportWhyRed();
		say("\n=== SWEEP ===");
		for (const host of [SOURCE_HOST, DEST_HOST]) {
			try {
				const swept = lua(host, `local deleted = 0\n`
					+ `for _, pl in pairs(game.forces.player.platforms) do\n`
					+ `  if pl.valid and pl.name == '${PROBE}' then\n`
					+ `    if pl.surface and pl.surface.valid then game.delete_surface(pl.surface) end\n`
					+ `    deleted = deleted + 1\n`
					+ `  end\n`
					+ `end\n`
					+ `return { success = true, deleted = deleted }`);
				say(`  host ${host}: delete_surface issued for ${swept.deleted} platform(s)`);
			} catch (error) {
				console.error(error && error.stack ? error.stack : error);
				fail(`sweep on host ${host} threw: ${error.message} — hand-clean with `
					+ "tools/tests/cleanup-test-surfaces.ps1 (prefix segunit- is in its sweep list)");
			}
		}
		await sleep(4000);
		for (const host of [SOURCE_HOST, DEST_HOST]) {
			try {
				const left = findPlatformIndex(host, PROBE);
				if (left !== null) fail(`sweep left '${PROBE}' on host ${host} (index ${left})`);
				else say(`  host ${host}: zero leftovers`);
			} catch (error) {
				console.error(error && error.stack ? error.stack : error);
				fail(`leftover check on host ${host} threw: ${error.message} — treating as a leftover`);
			}
		}
		try {
			lua(DEST_HOST, `remote.call('surface_export', 'configure', { debug_mode = ${previousDebug.debug === true} }) `
				+ "return { success = true }");
			say(`  host ${DEST_HOST}: debug_mode restored to ${previousDebug.debug === true}`);
		} catch (error) {
			console.error(error && error.stack ? error.stack : error);
			fail(`debug_mode restore threw: ${error.message} — the cluster is left with a changed config`);
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
		say(`\n=== segmented-unit-sleep: ${problems.length} FAILURE(S) ===`);
		for (const problem of problems) say(`  - ${problem}`);
		process.exitCode = 1;
	} else {
		say(`\n=== segmented-unit-sleep: ALL PASS (${HOSTS[SOURCE_HOST].instance} -> ${HOSTS[DEST_HOST].instance}) ===`);
	}
}).catch(error => {
	console.error(`segmented-unit-sleep: fatal — ${error && error.stack ? error.stack : error}`);
	process.exitCode = 1;
});
