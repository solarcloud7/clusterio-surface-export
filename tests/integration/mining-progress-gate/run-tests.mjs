#!/usr/bin/env node
// mining-progress-gate — what opens the deferred mining-progress write, and what the budget does in
// the one state where it stays shut
//
// requires: the cluster up, host-2 reachable, and game.ticks_to_run steering on host-2 (tick_paused
//           is cleared in a finally and asserted false at the end); STEP_TICKS - BUDGET_TICKS = 60
//           ticks of slack, which is load-bearing for the running arm: under a deadline that re-arms
//           on every paused tick, the record's deadline at resume is one full BUDGET_TICKS ahead, so
//           the running step must exceed BUDGET_TICKS or the give-up assertion fails on the margin
//           rather than on the behaviour; BUDGET_TICKS is a hand-copy of the production literal at
//           active_state_restoration.lua:56 and is not read from it
// produces: GATE — one PAUSED platform carrying four drills (fuelled over ore, fuel-starved over
//           ore, fuelled over bare foundation, and DEACTIVATED over ore), tick-stepped past the
//           300-tick budget, each drill's mining_target binding read off the entity, with the
//           platform's own paused and state_paused re-read at the same sample so a platform that
//           quietly un-paused cannot be misread as a pause that does nothing; BUDGET — a
//           production-shaped record injected into storage.pending_mining_progress for the one drill
//           whose gate stays shut, then stepped past the budget while paused and again while
//           running, so the give-up path at active_state_restoration.lua:91 is exercised where it is
//           reachable, and the drill's own mining_progress is read to show what the give-up costs
// does not: transfer anything (the gate and the budget are destination-local; a payload would add
//           confounds to a question about one entity); claim anything about a drill created by the
//           importer on a platform in flight — every drill here is script-created on a never-launched
//           platform; PIN the deactivated drill's binding — that row is measured and reported this
//           round, not graded, because its value is the input to a pending decision rather than a
//           contract; grade WHICH branch keeps a paused record alive (a boundary re-arm and a
//           dormant deadline are both "still pending", so this suite is neutral across the DORMANT
//           family only — it is NOT neutral against a cap-N variant, under which the paused-survival
//           assertion is designed to go red); read the injected record's field names from production
//           (they are hand-built here, so a rename of expires_tick or mining_progress at the queue
//           site leaves this suite green or red for the wrong reason)

import {
	lua as luaRaw, sleep, instanceIds,
} from "../../lab-gallery/batch-lifecycle.mjs";

const HOST = 2;
const RUN_TAG = Date.now().toString(36);
const PROBE = `mpgate-${RUN_TAG}`;
const DRILL = "burner-mining-drill";
const ORE = "iron-ore";
const PAD = { x0: -10, x1: 18, y0: -14, y1: 14 };
const SPECS = [
	{ id: "fuelled-over-ore", x: 14, y: 6, fuel: true, ore: true, disabled: false, expectBound: true,
		why: "a fuelled drill over ore" },
	{ id: "starved-over-ore", x: 14, y: -6, fuel: false, ore: true, disabled: false, expectBound: true,
		why: "a drill over ore with no fuel at all" },
	{ id: "fuelled-over-bare", x: 14, y: 0, fuel: true, ore: false, disabled: false, expectBound: false,
		why: "a fuelled drill over bare foundation" },
	{ id: "disabled-over-ore", x: 14, y: 12, fuel: true, ore: true, disabled: true, expectBound: null,
		why: "a deactivated (disabled_by_script) drill over ore — the state selection-lab.lua:307 sets "
			+ "immediately before it queues a record at :315" },
];
const BARE = SPECS.find(spec => spec.id === "fuelled-over-bare");
const EXPECTED_RESOURCES = SPECS.filter(spec => spec.ore).length * 4;
const BUDGET_TICKS = 300;
const STEP_TICKS = BUDGET_TICKS + 60;
const INJECTED_MINING = 0.55;
const INJECTED_BONUS = 0.62;

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
function note(message) {
	say(`  NOTE ${message}`);
}

function lua(host, body) {
	const r = luaRaw(host, body);
	if (r === null || typeof r !== "object") throw new Error(`lua returned no object: ${JSON.stringify(r)}`);
	if (r.success !== true) throw new Error(`lua failed: ${r.error ?? JSON.stringify(r)}`);
	return r;
}

function luaList(value) {
	if (Array.isArray(value)) return value;
	if (value === null || value === undefined) return [];
	return Object.values(value);
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

const READ_LUA = `local statuses = {}
for k, v in pairs(defines.entity_status) do statuses[v] = k end
local drills = {}
for _, e in pairs(s.find_entities_filtered{ type = 'mining-drill' }) do
  if e.valid then
    local bound_ok, target = pcall(function() return e.mining_target end)
    local fuel = 0
    local inv = e.get_fuel_inventory()
    if inv and inv.valid then fuel = inv.get_item_count() end
    drills[#drills + 1] = { name = e.name, active = e.active, unit_number = e.unit_number,
      x = e.position.x, y = e.position.y, fuel = fuel,
      status = statuses[e.status] or tostring(e.status),
      bound = (bound_ok and target ~= nil) or false,
      target = (bound_ok and target and target.valid and target.name) or nil,
      mining_progress = e.mining_progress, bonus_mining_progress = e.bonus_mining_progress }
  end
end
local pending = {}
for _, rec in pairs(storage.pending_mining_progress or {}) do
  if rec.entity and rec.entity.valid and rec.entity.surface.index == s.index then
    pending[#pending + 1] = { expires_tick = rec.expires_tick, mining_progress = rec.mining_progress,
      unit_number = rec.entity.unit_number }
  end
end
return { success = true, tick = game.tick, tick_paused = game.tick_paused == true,
  paused = (p.paused == true), state_paused = (p.state == defines.space_platform_state.paused),
  drills = drills, pending = pending,
  resources = s.count_entities_filtered{ type = 'resource' } }`;

function readState() {
	const state = lua(HOST, `${platformLua(PROBE)}\n${READ_LUA}`);
	state.drills = luaList(state.drills);
	state.pending = luaList(state.pending);
	return state;
}

function drillFor(state, spec) {
	return state.drills.find(d => Math.abs(d.x - spec.x) < 1.5 && Math.abs(d.y - spec.y) < 1.5) || null;
}

function describeDrill(drill) {
	if (!drill) return "no drill at that position";
	return `${drill.name}#${drill.unit_number} active=${drill.active} fuel=${drill.fuel} `
		+ `status=${drill.status} bound=${drill.bound}${drill.target ? ` (${drill.target})` : ""} `
		+ `mining_progress=${Number(drill.mining_progress).toFixed(4)}`;
}

function describePlatform(state) {
	return `platform paused=${state.paused} state_paused=${state.state_paused} tick=${state.tick}`;
}

function readTick() {
	return lua(HOST, "return { success = true, tick = game.tick, tick_paused = game.tick_paused == true }");
}

function buildLua() {
	const specLua = SPECS.map(sp =>
		`{ x = ${sp.x}, y = ${sp.y}, fuel = ${sp.fuel}, ore = ${sp.ore}, disabled = ${sp.disabled} }`)
		.join(", ");
	return `local p = game.forces.player.create_space_platform{ name = '${PROBE}',
  planet = 'nauvis', starter_pack = 'space-platform-starter-pack' }
if not p then return { success = false, error = 'create_space_platform returned nil' } end
p.apply_starter_pack()
local s = p.surface
local tiles = {}
for x = ${PAD.x0}, ${PAD.x1} do
  for y = ${PAD.y0}, ${PAD.y1} do
    tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { x, y } }
  end
end
s.set_tiles(tiles)
local report, placed_ore = {}, 0
for _, spec in ipairs({ ${specLua} }) do
  if spec.ore then
    for _, d in ipairs({ { -0.5, -0.5 }, { 0.5, -0.5 }, { -0.5, 0.5 }, { 0.5, 0.5 } }) do
      local ok, res = pcall(function()
        return s.create_entity{ name = '${ORE}', position = { spec.x + d[1], spec.y + d[2] }, amount = 20000 }
      end)
      if ok and res and res.valid then placed_ore = placed_ore + 1
      else report[#report + 1] = 'ore: ' .. string.sub(tostring(res), 1, 100) end
    end
  end
  local ok, drill = pcall(function()
    return s.create_entity{ name = '${DRILL}', position = { spec.x, spec.y }, force = 'player',
      direction = defines.direction.north }
  end)
  if not (ok and drill and drill.valid) then
    return { success = false, error = string.format('could not place ${DRILL} at (%d,%d): %s',
      spec.x, spec.y, string.sub(tostring(drill), 1, 200)) }
  end
  if spec.fuel then drill.insert{ name = 'coal', count = 50 } end
  if spec.disabled then drill.disabled_by_script = true end
  report[#report + 1] = string.format('drill at (%d,%d) fuel=%s ore=%s disabled=%s active=%s',
    spec.x, spec.y, tostring(spec.fuel), tostring(spec.ore), tostring(spec.disabled),
    tostring(drill.active))
end
p.paused = true
return { success = true, index = p.index, placed_ore = placed_ore,
  report = table.concat(report, ' | '),
  resources = s.count_entities_filtered{ type = 'resource' },
  paused = (p.paused == true),
  state_paused = (p.state == defines.space_platform_state.paused) }`;
}

async function stepTicks(ticks) {
	if (ticks <= 0) return readTick();
	const before = readTick();
	lua(HOST, `game.ticks_to_run = ${ticks}\nreturn { success = true }`);
	const target = before.tick + ticks;
	await sleep(Math.ceil(ticks * 1000 / 60) + 200);
	const deadline = Date.now() + Math.max(20_000, ticks * 40);
	while (Date.now() < deadline) {
		const now = readTick();
		if (now.tick >= target) return now;
		await sleep(300);
	}
	throw new Error(`stepping ${ticks} tick(s) never reached tick ${target} — game.ticks_to_run does not `
		+ "do what this suite assumes");
}

function gateArm(after) {
	say(`\n=== GATE: what opens the deferred write's mining_target check ===`);
	say(`  after ${STEP_TICKS} stepped ticks — ${describePlatform(after)}`);
	if (after.paused !== true) {
		fail(`the platform reads paused=${after.paused} after ${STEP_TICKS} ticks — the pause this suite set `
			+ "did not hold, so no reading below can be attributed to a pause (CONTROL failed)");
		return false;
	}
	if (after.state_paused !== true) {
		fail(`the platform reads paused=true but state_paused=false — it is not paused in the sense the `
			+ "engine means, so the readings below are not readings about a paused platform (CONTROL failed)");
		return false;
	}
	pass(`the platform held paused=true AND state=paused across ${STEP_TICKS} stepped ticks — every reading `
		+ "below is a reading about a genuinely paused platform");

	let ok = true;
	let unpinnedDrill = null;
	for (const spec of SPECS) {
		const drill = drillFor(after, spec);
		say(`  ${spec.id}: ${describeDrill(drill)}`);
		if (!drill) {
			fail(`${spec.id}: no drill at (${spec.x},${spec.y}) — the fixture did not build`);
			ok = false;
			continue;
		}
		if (spec.fuel === false && !(drill.fuel === 0 || drill.status === "no_fuel")) {
			fail(`${spec.id}: reads fuel=${drill.fuel} status=${drill.status} — the starvation this suite set `
				+ "did not take, so its binding is not a reading about a drill that cannot mine");
			ok = false;
			continue;
		}
		if (spec.disabled && drill.active !== false) {
			fail(`${spec.id}: reads active=${drill.active} — the disabled_by_script write did not take, so `
				+ "its binding is not a reading about a deactivated drill");
			ok = false;
			continue;
		}
		if (spec.expectBound === null) {
			unpinnedDrill = drill;
			note(`${spec.id}: ${spec.why} reads bound=${drill.bound} — UNPINNED: measured and reported, not `
				+ "graded, because this value is the input to a pending decision rather than a contract");
			continue;
		}
		if (drill.bound !== spec.expectBound) {
			fail(`${spec.id}: ${spec.why} reads bound=${drill.bound} after ${STEP_TICKS} paused ticks, `
				+ `expected ${spec.expectBound} — the deferred write's gate `
				+ `(active_state_restoration.lua:70) does not behave as this suite and the code around it `
				+ "assume, so the budget's reachability has to be re-derived");
			ok = false;
		} else {
			pass(`${spec.id}: ${spec.why} reads bound=${drill.bound}`);
		}
	}
	if (ok && unpinnedDrill) {
		note("neither a platform pause nor an empty fuel inventory closes the gate: a drill binds "
			+ "mining_target for the resource it stands on");
		if (unpinnedDrill.bound) {
			note(`IMPLICATION: a DEACTIVATED drill over ore also reads bound=true `
				+ `(status=${unpinnedDrill.status}), so the record selection-lab.lua:315 queues for a pasted `
				+ "lab_active=false drill has an open gate too. The only gate-shut state measured remains a "
				+ "drill with no resource under it, which no amount of waiting can change, so no budget "
				+ "policy can preserve a value that was restorable");
		} else {
			note(`IMPLICATION: a DEACTIVATED drill over ore reads bound=false `
				+ `(status=${unpinnedDrill.status}) while its resource is still there — a state that ENDS `
				+ "when the drill is reactivated. selection-lab.lua:307 sets exactly this state and :315 "
				+ "queues a record against it, so the give-up path is reachable while the value is still "
				+ "restorable, and how long the budget should wait is a live question rather than a moot one");
		}
	}
	return ok;
}

async function budgetArm() {
	say(`\n=== BUDGET: what the ${BUDGET_TICKS}-tick budget does where the gate stays shut ===`);
	const injected = lua(HOST, `${platformLua(PROBE)}
local target
for _, e in pairs(s.find_entities_filtered{ type = 'mining-drill' }) do
  if e.valid and math.abs(e.position.x - (${BARE.x})) < 1.5 and math.abs(e.position.y - (${BARE.y})) < 1.5 then
    target = e
  end
end
if not (target and target.valid) then return { success = false, error = 'no drill over bare foundation' } end
storage.pending_mining_progress = storage.pending_mining_progress or {}
storage.pending_mining_progress[#storage.pending_mining_progress + 1] = {
  entity = target,
  mining_progress = ${INJECTED_MINING},
  bonus_mining_progress = ${INJECTED_BONUS},
  expires_tick = game.tick + ${BUDGET_TICKS},
}
return { success = true, tick = game.tick, unit_number = target.unit_number,
  expires_tick = game.tick + ${BUDGET_TICKS} }`);
	say(`  injected a record for drill #${injected.unit_number} at tick ${injected.tick}, expiring at `
		+ `${injected.expires_tick} — the same shape queue_mining_progress writes `
		+ "(active_state_restoration.lua:50-58), serviced by the production on_tick");

	const before = readState();
	if (before.pending.length !== 1) {
		fail(`the injected record is not visible to a read of storage.pending_mining_progress `
			+ `(pending=${before.pending.length}) — nothing below would be measuring the production record`);
		return;
	}

	await stepTicks(STEP_TICKS);
	const held = readState();
	say(`  after ${STEP_TICKS} PAUSED ticks: ${describePlatform(held)} pending=${JSON.stringify(held.pending)}`);
	if (held.pending.length !== 1) {
		fail(`the record was dropped after ${STEP_TICKS} ticks on a PAUSED platform — a record for a drill `
			+ "that cannot bind is supposed to outlive the budget while the platform is paused");
		return;
	}
	pass(`the record outlived ${STEP_TICKS} ticks (${(STEP_TICKS / BUDGET_TICKS).toFixed(1)}x the budget) `
		+ "while the platform was paused");

	lua(HOST, `${platformLua(PROBE)}\np.paused = false\nreturn { success = true }`);
	await stepTicks(STEP_TICKS);
	const ran = readState();
	const bare = drillFor(ran, BARE);
	say(`  after ${STEP_TICKS} RUNNING ticks: ${describePlatform(ran)} `
		+ `pending=${JSON.stringify(ran.pending)}`);
	say(`  ${BARE.id}: ${describeDrill(bare)}`);
	if (!bare) {
		fail(`the drill the record names is no longer readable at (${BARE.x},${BARE.y}) — the give-up below `
			+ "cannot be attributed to the budget rather than to a vanished entity");
		return;
	}
	if (ran.pending.length !== 0) {
		fail(`the record is still pending ${STEP_TICKS} ticks after the platform was resumed — the give-up `
			+ `path at active_state_restoration.lua:91 did not fire within ${STEP_TICKS} live ticks, so the `
			+ "budget no longer bounds anything");
		return;
	}
	pass(`the record was given up within ${STEP_TICKS} live ticks of the platform running — the budget is `
		+ "bounded exactly where the gate cannot open");
	if (bare && bare.mining_progress > 0) {
		fail(`the drill over bare foundation reads mining_progress=${bare.mining_progress} — it has no mining `
			+ "target, so a non-zero progress means this suite is measuring the wrong entity");
		return;
	}
	note(`the given-up record carried mining_progress=${INJECTED_MINING}, and the drill it named reads `
		+ `${Number(bare.mining_progress).toFixed(4)}: a record whose gate can never open carries a value `
		+ "that was never restorable, which is what the give-up path is bounded for");
}

async function main() {
	say(`=== mining-progress-gate: what opens the deferred write, and what the budget bounds `
		+ `(run ${RUN_TAG}) ===`);
	instanceIds();
	try {
		const built = lua(HOST, buildLua());
		say(`  probe platform '${PROBE}' index=${built.index}: ${built.resources} resource entity(ies) from `
			+ `${built.placed_ore} placement(s), paused=${built.paused} state_paused=${built.state_paused}`);
		say(`  rig: ${built.report}`);
		if (built.resources !== EXPECTED_RESOURCES) {
			fail(`the platform carries ${built.resources} resource entities, expected ${EXPECTED_RESOURCES} `
				+ `(4 under each of the ${SPECS.filter(s => s.ore).length} ore drills, none under the bare `
				+ "one) — the fixture does not express the contrast this suite measures");
			return;
		}

		lua(HOST, "game.tick_paused = true\nreturn { success = true }");
		await stepTicks(STEP_TICKS);
		if (gateArm(readState())) await budgetArm();
		else say("\n  the budget arm did not run: the gate did not behave as measured, so which state leaves "
			+ "a record pending has to be re-derived before the budget can be probed");
	} catch (error) {
		console.error(error && error.stack ? error.stack : error);
		fail(`the suite threw: ${error.message}`);
	} finally {
		say("\n=== CLEANUP ===");
		try {
			lua(HOST, "game.tick_paused = false\nreturn { success = true }");
		} catch (error) {
			console.error(error && error.stack ? error.stack : error);
			fail(`could not clear tick_paused on host ${HOST}: ${error.message}`);
		}
		try {
			const swept = lua(HOST, `local deleted, records = 0, 0\n`
				+ `for _, pl in pairs(game.forces.player.platforms) do\n`
				+ `  if pl.valid and pl.name == '${PROBE}' then\n`
				+ `    if pl.surface and pl.surface.valid then\n`
				+ `      local keep = {}\n`
				+ `      for _, rec in pairs(storage.pending_mining_progress or {}) do\n`
				+ `        if rec.entity and rec.entity.valid and rec.entity.surface.index ~= pl.surface.index then\n`
				+ `          keep[#keep + 1] = rec\n`
				+ `        else records = records + 1 end\n`
				+ `      end\n`
				+ `      storage.pending_mining_progress = (#keep > 0) and keep or nil\n`
				+ `      game.delete_surface(pl.surface)\n`
				+ `    end\n`
				+ `    deleted = deleted + 1\n`
				+ `  end\n`
				+ `end\n`
				+ `return { success = true, deleted = deleted, records = records }`);
			say(`  delete_surface issued for ${swept.deleted} platform(s); ${swept.records} injected record(s) `
				+ "cleared from storage.pending_mining_progress");
		} catch (error) {
			console.error(error && error.stack ? error.stack : error);
			fail(`sweep threw: ${error.message} — hand-clean with tools/tests/cleanup-test-surfaces.ps1 `
				+ "(prefix mpgate- is in its sweep list) and check storage.pending_mining_progress");
		}
		await sleep(4000);
		try {
			const left = lua(HOST, `local idx\n`
				+ `for _, pl in pairs(game.forces.player.platforms) do\n`
				+ `  if pl.name == '${PROBE}' and pl.surface and pl.surface.valid then idx = pl.index end\n`
				+ `end\n`
				+ `return { success = true, index = idx, `
				+ `pending = table_size(storage.pending_mining_progress or {}) }`);
			if (typeof left.index === "number") fail(`sweep left '${PROBE}' behind (index ${left.index})`);
			else say(`  zero leftovers; storage.pending_mining_progress holds ${left.pending} record(s)`);
		} catch (error) {
			console.error(error && error.stack ? error.stack : error);
			fail(`leftover check threw: ${error.message} — treating as a leftover`);
		}
		try {
			if (readTick().tick_paused === true) fail(`host ${HOST} was left tick_paused`);
		} catch (error) {
			console.error(error && error.stack ? error.stack : error);
			fail(`tick_paused check threw: ${error.message}`);
		}
	}

	say("\n=== SUMMARY ===");
	if (problems.length === 0) say("  mining-progress-gate: ALL PASS");
	else say(`  mining-progress-gate: ${problems.length} FAILURE(S)`);
}

await main();
