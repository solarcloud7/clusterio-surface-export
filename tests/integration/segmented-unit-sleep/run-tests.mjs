#!/usr/bin/env node
// segmented-unit-sleep — a demolisher staged asleep and indestructible must ARRIVE asleep and
// indestructible, measured physically at the destination after activation
//
// requires: the cluster up, lab-transfer-fixture-v1 on host-1, host-2 able to receive
// produces: a THROWAWAY clone carrying one segmented-unit frozen by the #247 sequence
//           (destructible=false, then minimum_activity_mode, then activity_mode=asleep LAST), a
//           source read-back taken twice so a broken staging cannot masquerade as a broken
//           transfer, the gate verdict bound to this clone by name, and a DESTINATION physical
//           read of LuaEntity.destructible + LuaSegmentedUnit.activity_mode taken twice 120 ticks
//           apart so a unit that is merely between steps cannot read as asleep
// does not: touch a protected fixture or the shared config-attrs rig (an awake demolisher eats its
//           platform, so it gets its own clone and the clone is swept unconditionally); read the
//           export payload (payload presence is not restoration); assert item or fluid fidelity
//           (the gate does that); prove anything about a segmented unit the engine refused to place
//           (a refused staging is reported as a setup failure, never as a transfer verdict)

import { lua as luaRaw, sleep, docker, HOSTS, REPO_ROOT } from "../../lab-gallery/batch-lifecycle.mjs";
import { execFileSync } from "node:child_process";

const SOURCE_HOST = 1;
const DEST_HOST = 2;
const FIXTURE = "lab-transfer-fixture-v1";
const CLONE = `segunit-${Date.now().toString(36)}`;
const CLONE_WAIT_MS = 300_000;
const ARRIVAL_WAIT_MS = 300_000;
const HOLD_MS = 3000;
const CANDIDATES = ["big-demolisher", "medium-demolisher", "small-demolisher"];

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
      rec.health = su.health
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

async function cloneFixture(sourceIndex) {
	const queued = lua(SOURCE_HOST, `local r = remote.call('surface_export', 'clone_platform', ${sourceIndex}, '${CLONE}')\n`
		+ `if not (r and r.success) then\n`
		+ `  return { success = false, error = 'clone refused: ' .. tostring(r and r.message) }\n`
		+ `end\n`
		+ `return { success = true, job_id = r.job_id, entity_count = r.entity_count }`);
	say(`  clone of '${FIXTURE}' [${sourceIndex}] -> ${CLONE}: job=${queued.job_id} entities=${queued.entity_count}`);
	const deadline = Date.now() + CLONE_WAIT_MS;
	while (Date.now() < deadline) {
		await sleep(4000);
		const index = findPlatformIndex(SOURCE_HOST, CLONE);
		if (index !== null) return index;
	}
	throw new Error(`clone '${CLONE}' did not materialize within ${CLONE_WAIT_MS} ms`);
}

const CANDIDATE_LUA = CANDIDATES.map(n => `'${n}'`).join(", ");

function stageFrozenUnit() {
	return lua(SOURCE_HOST, `${platformLua(CLONE)}
local tried, placed = {}, nil
for _, name in ipairs({ ${CANDIDATE_LUA} }) do
  if not placed then
    local pos = s.find_non_colliding_position(name, { 0, 0 }, 64, 1)
    if not pos then
      tried[#tried + 1] = name .. ': no non-colliding position within 64 tiles'
    else
      local ok, res = pcall(function() return s.create_entity{ name = name, position = pos, force = 'player' } end)
      if not ok then tried[#tried + 1] = name .. ': ' .. string.sub(tostring(res), 1, 160)
      elseif not (res and res.valid) then tried[#tried + 1] = name .. ': create_entity returned nil'
      else placed = res end
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
	say(`  gate verdict for '${CLONE}': ${result ? result[1] : "UNPARSEABLE"}`);
	if (result === null || result[1] !== "SUCCESS") {
		fail("the transfer did not pass the gate — destination reads below would describe a rolled-back "
			+ `or partial import, not a restoration (summary: ${summary.slice(0, 400)})`);
		return false;
	}
	return true;
}

function destinationLogLines(pattern) {
	const path = `/clusterio/data/instances/${HOSTS[DEST_HOST].instance}/factorio-current.log`;
	const out = docker(["exec", HOSTS[DEST_HOST].container, "sh", "-c",
		`grep -aE '${pattern}' ${path} | tail -12 || true`]);
	return out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

async function reportWhyRed() {
	say("\n=== DIAGNOSTIC (the main arm went red) ===");
	for (const line of destinationLogLines("demolisher|segmented|destructible restore failed")) {
		say(`  dest log: ${line.slice(-200)}`);
	}
	try {
		const armed = lua(DEST_HOST, `${platformLua(CLONE)}
local head = s.find_entities_filtered{ type = 'segmented-unit' }[1]
if not (head and head.valid) then return { success = false, error = 'no segmented-unit to arm' } end
head.destructible = false
local su = head.segmented_unit
local asleep = defines.segmented_unit_activity_mode.asleep
local minimum_write_ok = pcall(function() su.minimum_activity_mode = asleep end)
local mode_write_ok = pcall(function() su.activity_mode = asleep end)
return { success = true, minimum_write_ok = minimum_write_ok, mode_write_ok = mode_write_ok,
  destructible = head.destructible, activity_mode = su.activity_mode }`);
		say(`  control arm: a post-activation write at the destination reads back `
			+ `destructible=${armed.destructible} activity_mode=${armed.activity_mode} `
			+ `(writes ok: minimum=${armed.minimum_write_ok} mode=${armed.mode_write_ok})`);
		await sleep(HOLD_MS);
		const held = readState(DEST_HOST, CLONE);
		say(`  control arm after ${HOLD_MS} ms: ${describe(held)}`);
	} catch (error) {
		console.error(error && error.stack ? error.stack : error);
		say(`  control arm could not run: ${error.message}`);
	}
}

async function main() {
	say(`=== segmented-unit-sleep: a frozen demolisher across a real transfer (clone '${CLONE}') ===`);

	const fixtureIndex = findPlatformIndex(SOURCE_HOST, FIXTURE);
	if (fixtureIndex === null) throw new Error(`fixture '${FIXTURE}' not found on host ${SOURCE_HOST}`);

	let mainArmRed = true;
	try {
		const cloneIndex = await cloneFixture(fixtureIndex);
		say(`  clone ready at index ${cloneIndex}`);

		say("\n=== SOURCE: stage one segmented-unit frozen by the #247 sequence ===");
		const staged = stageFrozenUnit();
		say(`  placed ${staged.name} (candidates refused: ${staged.tried.length ? staged.tried.join(" / ") : "none"})`);
		say(`  disabled_by_script write=${staged.disabled_write_ok} reads back ${staged.disabled_read}; `
			+ `minimum_activity_mode write=${staged.minimum_write_ok}; activity_mode write=${staged.mode_write_ok}`);

		const armed = readState(SOURCE_HOST, CLONE);
		const asleep = armed.modes.asleep;
		say(`  defines.segmented_unit_activity_mode: ${JSON.stringify(armed.modes)}`);
		say(`  source after staging: ${describe(armed)}`);
		if (armed.heads.length !== 1) {
			fail(`staging left ${armed.heads.length} segmented-unit(s) on the clone — the transfer below `
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
		const settled = readState(SOURCE_HOST, CLONE);
		say(`  source after ${HOLD_MS} ms: ${describe(settled)}`);
		if (settled.heads.length !== 1 || settled.heads[0].activity_mode !== asleep
			|| settled.heads[0].destructible !== false) {
			fail("the source unit did not HOLD the frozen state before the transfer even started — "
				+ "the staging sequence is what needs fixing, not the restore");
			return;
		}
		pass(`source held the freeze across ${HOLD_MS} ms (segments flat at ${settled.heads[0].segments})`);

		say(`\n=== TRANSFER: host ${SOURCE_HOST} -> host ${DEST_HOST} through the production path ===`);
		const transferOut = execFileSync("pwsh", ["-NoProfile", "-File", "tools/surface-export/transfer-platform.ps1",
			"-PlatformIndex", String(cloneIndex), "-Direction", "1to2"],
		{ encoding: "utf8", timeout: 600_000, cwd: REPO_ROOT });
		if (!/Export queued/.test(transferOut)) {
			throw new Error(`transfer-platform.ps1 did not queue: ${transferOut.slice(-300)}`);
		}

		const deadline = Date.now() + ARRIVAL_WAIT_MS;
		let arrived = null;
		while (Date.now() < deadline) {
			await sleep(5000);
			arrived = findPlatformIndex(DEST_HOST, CLONE);
			if (arrived !== null) break;
		}
		if (arrived === null) {
			fail(`'${CLONE}' never arrived on host ${DEST_HOST} within ${ARRIVAL_WAIT_MS} ms`);
			return;
		}
		say(`  arrived on host ${DEST_HOST} at index ${arrived}`);

		if (!adjudicateGate()) return;

		say("\n=== DESTINATION: physical read of the arrived unit, after activation ===");
		let first;
		try {
			first = readState(DEST_HOST, CLONE);
		} catch (error) {
			console.error(error && error.stack ? error.stack : error);
			fail(`the arrived platform could not be read: ${error.message} — an awake demolisher that `
				+ "destroys its own hub takes the platform with it, which is this defect at its worst");
			return;
		}
		say(`  destination read 1: ${describe(first)} `
			+ `(segment entities ${first.segment_entities}, corpses ${first.corpses})`);
		if (first.heads.length !== 1) {
			fail(`the destination carries ${first.heads.length} segmented-unit(s), the source carried 1`);
			return;
		}
		await sleep(HOLD_MS);
		const second = readState(DEST_HOST, CLONE);
		say(`  destination read 2 (+${HOLD_MS} ms): ${describe(second)} `
			+ `(segment entities ${second.segment_entities}, corpses ${second.corpses})`);

		const destAsleep = first.modes.asleep;
		const head = second.heads[0];
		let red = false;
		if (first.heads[0].destructible !== false || head.destructible !== false) {
			fail(`the arrived unit reads destructible=${head.destructible} — the source was `
				+ "destructible=false, and an entity that arrives destructible is one the destination world "
				+ "can kill for reasons the source never allowed");
			red = true;
		} else {
			pass("destructible=false survived the transfer");
		}
		if (first.heads[0].activity_mode !== destAsleep || head.activity_mode !== destAsleep) {
			fail(`the arrived unit reads activity_mode=${head.activity_mode} (asleep=${destAsleep}) — `
				+ "the source was asleep, and an awake demolisher destroys the platform it arrived on");
			red = true;
		} else {
			pass(`activity_mode=asleep survived the transfer and held across ${HOLD_MS} ms`);
		}
		if (head.minimum_activity_mode !== destAsleep) {
			fail(`the arrived unit reads minimum_activity_mode=${head.minimum_activity_mode} `
				+ `(asleep=${destAsleep}) — the floor the source set is what keeps the unit's own AI from `
				+ "raising it back out of sleep");
			red = true;
		} else {
			pass("minimum_activity_mode=asleep survived the transfer");
		}
		const moved = Math.abs(head.x - first.heads[0].x) + Math.abs(head.y - first.heads[0].y);
		if (moved > 0.001) {
			fail(`the arrived unit MOVED ${moved.toFixed(3)} tiles between the two destination reads — `
				+ "a unit that reports asleep while moving is reporting a state it is not in");
			red = true;
		} else {
			pass("the arrived unit did not move between the two destination reads");
		}
		mainArmRed = red;
	} finally {
		if (mainArmRed && problems.length > 0) await reportWhyRed();
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
					+ "tools/tests/cleanup-test-surfaces.ps1 (prefix segunit- is in its sweep list)");
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
