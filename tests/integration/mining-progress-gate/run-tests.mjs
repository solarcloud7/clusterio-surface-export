#!/usr/bin/env node
// mining-progress-gate — what opens the deferred mining-progress write, and what its budget waits for
//
// requires: the cluster up, host-2 reachable and NOT already tick_paused (an instance-wide pause someone
//           else holds is refused, never cleared); game.ticks_to_run steering on host-2; the production
//           module reachable through package.loaded so the budget constant and the queue function are
//           the shipped ones, never hand-copies; STEP_TICKS = budget + 60 so a give-up is graded a full
//           margin past the deadline
// produces: GATE — one PAUSED platform carrying four drills (fuelled over ore, fuel-starved over ore,
//           fuelled over bare foundation, DEACTIVATED over ore), tick-stepped past the budget, each
//           drill's mining_target binding read off the entity and graded, with the platform's paused
//           and state_paused re-read at the same sample; BUDGET — on the same platform RUNNING, two
//           records queued through the production queue_mining_progress: one for the deactivated drill
//           (must OUTLIVE the budget while the drill stays deactivated, then be consumed and land on the
//           entity once the drill is reactivated) and one for the bare-foundation drill (must be given
//           up past the budget — the permanent case still expires); platform paused=false and the
//           drill's active flag are asserted at every sample the grade depends on
// does not: transfer anything; claim anything about a drill created by the importer on a platform in
//           flight (every drill here is script-created on a never-launched platform); grade WHICH
//           branch keeps a dormant record alive — only that it is still pending, then consumed

import {
	lua as luaRaw, sleep, instanceIds,
} from "../../lab-gallery/batch-lifecycle.mjs";

const HOST = 2;
const RUN_TAG = Date.now().toString(36);
const PROBE = `mpgate-${RUN_TAG}`;
const MODULE_KEY = "__level__/modules/surface_export/import_phases/active_state_restoration.lua";
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
	{ id: "disabled-over-ore", x: 14, y: 12, fuel: true, ore: true, disabled: true, expectBound: false,
		why: "a deactivated (disabled_by_script) drill over ore — the state apply_paste_activation sets "
			+ "immediately before it queues a record" },
];
const BARE = SPECS.find(spec => spec.id === "fuelled-over-bare");
const DISABLED = SPECS.find(spec => spec.id === "disabled-over-ore");
const EXPECTED_RESOURCES = SPECS.filter(spec => spec.ore).length * 4;
const SLACK_TICKS = 60;
const REACTIVATE_TICKS = 5;
const INJECTED_MINING = 0.55;
const INJECTED_BONUS = 0.62;
const LANDED_TOLERANCE = 0.1;

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

function drillAtLua(spec) {
	return `local target\n`
		+ `for _, e in pairs(s.find_entities_filtered{ type = 'mining-drill' }) do\n`
		+ `  if e.valid and math.abs(e.position.x - (${spec.x})) < 1.5 and math.abs(e.position.y - (${spec.y})) < 1.5 then\n`
		+ `    target = e\n`
		+ `  end\n`
		+ `end\n`
		+ `if not (target and target.valid) then return { success = false, error = 'no drill for ${spec.id}' } end`;
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

function pendingFor(state, drill) {
	return drill ? state.pending.filter(rec => rec.unit_number === drill.unit_number) : [];
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

function readBudget() {
	const r = lua(HOST, `local M = package.loaded['${MODULE_KEY}']\n`
		+ `if type(M) ~= 'table' then return { success = false, error = 'module not in package.loaded: ${MODULE_KEY}' } end\n`
		+ `return { success = true, budget = M.MINING_PROGRESS_BUDGET_TICKS, `
		+ `has_queue = (type(M.queue_mining_progress) == 'function') }`);
	if (typeof r.budget !== "number" || r.has_queue !== true) {
		throw new Error(`production module exposes budget=${r.budget} queue=${r.has_queue} — this suite reads both `
			+ "from the shipped module and refuses to hand-copy them");
	}
	return r.budget;
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

function gateArm(after, stepTicksUsed) {
	say(`\n=== GATE: what opens the deferred write's mining_target check ===`);
	say(`  after ${stepTicksUsed} stepped ticks — ${describePlatform(after)}`);
	if (after.paused !== true) {
		fail(`the platform reads paused=${after.paused} after ${stepTicksUsed} ticks — the pause this suite set `
			+ "did not hold, so no reading below can be attributed to a pause (CONTROL failed)");
		return false;
	}
	if (after.state_paused !== true) {
		fail(`the platform reads paused=true but state_paused=false — it is not paused in the sense the `
			+ "engine means, so the readings below are not readings about a paused platform (CONTROL failed)");
		return false;
	}
	pass(`the platform held paused=true AND state=paused across ${stepTicksUsed} stepped ticks — every reading `
		+ "below is a reading about a genuinely paused platform");

	let ok = true;
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
				+ "did not take, so its binding is not a reading about a drill that cannot mine (CONTROL failed)");
			ok = false;
			continue;
		}
		if (spec.disabled && drill.active !== false) {
			fail(`${spec.id}: reads active=${drill.active} — the disabled_by_script write did not take, so `
				+ "its binding is not a reading about a deactivated drill (CONTROL failed)");
			ok = false;
			continue;
		}
		if (drill.bound !== spec.expectBound) {
			fail(`${spec.id}: ${spec.why} reads bound=${drill.bound} after ${stepTicksUsed} paused ticks, `
				+ `expected ${spec.expectBound} — the mining_target gate in service_pending_mining_progress does `
				+ "not behave as this suite and the dormancy key assume");
			ok = false;
		} else {
			pass(`${spec.id}: ${spec.why} reads bound=${drill.bound}`);
		}
	}
	if (ok) {
		note("neither a platform pause nor an empty fuel inventory closes the gate; a drill with no resource "
			+ "under it and a DEACTIVATED drill over ore both read unbound — the deactivated state is the one "
			+ "that ends when the drill is reactivated");
	}
	return ok;
}

function queueLua(spec) {
	return `${platformLua(PROBE)}
${drillAtLua(spec)}
local M = package.loaded['${MODULE_KEY}']
M.queue_mining_progress(target, { mining_progress = ${INJECTED_MINING}, bonus_mining_progress = ${INJECTED_BONUS} })
local rec = storage.pending_mining_progress[#storage.pending_mining_progress]
return { success = true, tick = game.tick, unit_number = target.unit_number, active = target.active,
  expires_tick = rec.expires_tick, same_entity = (rec.entity == target) }`;
}

function assertRunningControl(state, label) {
	if (state.paused !== false || state.state_paused !== false) {
		fail(`${label}: ${describePlatform(state)} — the platform is paused, so a pending record here says nothing `
			+ "about the dormancy key (CONTROL failed)");
		return false;
	}
	return true;
}

async function budgetArm(budgetTicks, stepTicksUsed) {
	say(`\n=== BUDGET: what the ${budgetTicks}-tick budget waits for, on a RUNNING platform ===`);
	lua(HOST, `${platformLua(PROBE)}\np.paused = false\nreturn { success = true }`);

	const queuedDisabled = lua(HOST, queueLua(DISABLED));
	const queuedBare = lua(HOST, queueLua(BARE));
	for (const [spec, q] of [[DISABLED, queuedDisabled], [BARE, queuedBare]]) {
		say(`  queued via production queue_mining_progress for ${spec.id}: drill #${q.unit_number} active=${q.active} `
			+ `at tick ${q.tick}, expires_tick=${q.expires_tick}`);
		if (q.same_entity !== true || q.expires_tick !== q.tick + budgetTicks) {
			fail(`${spec.id}: the queued record does not name the drill or its deadline is not tick+${budgetTicks} `
				+ `(expires_tick=${q.expires_tick}) — the production queue site changed shape under this suite`);
			return;
		}
	}
	if (queuedDisabled.active !== false) {
		fail(`${DISABLED.id}: reads active=${queuedDisabled.active} at queue time — not a record against a `
			+ "deactivated drill (CONTROL failed)");
		return;
	}

	const before = readState();
	if (before.pending.length !== 2) {
		fail(`expected 2 pending records on the probe surface, read ${before.pending.length} — nothing below would `
			+ "be measuring the production records");
		return;
	}

	await stepTicks(stepTicksUsed);
	const held = readState();
	const disabledDrill = drillFor(held, DISABLED);
	const bareDrill = drillFor(held, BARE);
	say(`  after ${stepTicksUsed} RUNNING ticks: ${describePlatform(held)} pending=${JSON.stringify(held.pending)}`);
	say(`  ${DISABLED.id}: ${describeDrill(disabledDrill)}`);
	say(`  ${BARE.id}: ${describeDrill(bareDrill)}`);
	if (!assertRunningControl(held, "post-budget sample")) return;
	if (!disabledDrill || !bareDrill) {
		fail("a drill the records name is no longer readable — nothing below can be attributed to the budget");
		return;
	}
	if (disabledDrill.active !== false) {
		fail(`${DISABLED.id}: reads active=${disabledDrill.active} after the budget — the drill did not stay `
			+ "deactivated, so its record's fate says nothing about dormancy (CONTROL failed)");
		return;
	}

	const dormant = pendingFor(held, disabledDrill);
	if (dormant.length !== 1) {
		fail(`${DISABLED.id}: the record for the DEACTIVATED drill was ${dormant.length === 0 ? "given up" : "duplicated"} `
			+ `${stepTicksUsed} ticks after queueing — a record whose drill is deactivated must stay dormant, because `
			+ "reactivating the drill opens the gate and the captured value is still restorable");
	} else {
		pass(`${DISABLED.id}: the record outlived ${stepTicksUsed} ticks (${(stepTicksUsed / budgetTicks).toFixed(1)}x `
			+ "the budget) while its drill stayed deactivated");
	}

	const permanent = pendingFor(held, bareDrill);
	if (permanent.length !== 0) {
		fail(`${BARE.id}: the record for the ACTIVE drill over bare foundation is still pending ${stepTicksUsed} ticks `
			+ "after queueing — the budget no longer bounds the permanent case");
	} else if (bareDrill.mining_progress > 0) {
		fail(`${BARE.id}: reads mining_progress=${bareDrill.mining_progress} with no mining target — this suite is `
			+ "measuring the wrong entity");
	} else {
		pass(`${BARE.id}: the record was given up within ${stepTicksUsed} ticks and the drill still reads `
			+ `mining_progress=0 — a value with no resource under it is not restorable, and the budget is bounded there`);
	}
	if (problems.length) return;

	lua(HOST, `${platformLua(PROBE)}\n${drillAtLua(DISABLED)}\ntarget.disabled_by_script = false\n`
		+ "return { success = true, active = target.active }");
	await stepTicks(REACTIVATE_TICKS);
	const landed = readState();
	const reactivated = drillFor(landed, DISABLED);
	say(`  after reactivation + ${REACTIVATE_TICKS} ticks: ${describePlatform(landed)} `
		+ `pending=${JSON.stringify(landed.pending)}`);
	say(`  ${DISABLED.id}: ${describeDrill(reactivated)}`);
	if (!assertRunningControl(landed, "post-reactivation sample")) return;
	if (!reactivated || reactivated.active !== true) {
		fail(`${DISABLED.id}: reads active=${reactivated && reactivated.active} after disabled_by_script=false — the `
			+ "reactivation did not take (CONTROL failed)");
		return;
	}
	if (pendingFor(landed, reactivated).length !== 0) {
		fail(`${DISABLED.id}: the record is still pending ${REACTIVATE_TICKS} ticks after reactivation — the gate `
			+ "opened and the write did not happen");
		return;
	}
	const progress = Number(reactivated.mining_progress);
	if (!(progress >= INJECTED_MINING - 1e-6 && progress < INJECTED_MINING + LANDED_TOLERANCE)) {
		fail(`${DISABLED.id}: reads mining_progress=${progress.toFixed(4)} after the record was consumed — expected `
			+ `the captured ${INJECTED_MINING} (plus at most ${REACTIVATE_TICKS} ticks of mining) to have LANDED`);
		return;
	}
	pass(`${DISABLED.id}: the dormant record was consumed once the drill ran and the drill reads `
		+ `mining_progress=${progress.toFixed(4)} — the captured ${INJECTED_MINING} landed on the entity`);
}

async function main() {
	say(`=== mining-progress-gate: what opens the deferred write, and what the budget waits for `
		+ `(run ${RUN_TAG}) ===`);
	instanceIds();
	let pausedByUs = false;
	try {
		const preflight = readTick();
		if (preflight.tick_paused === true) {
			fail(`host ${HOST} is already tick_paused at tick ${preflight.tick} — someone else holds that pause; `
				+ "this suite refuses to step or clear it");
			return;
		}
		const budgetTicks = readBudget();
		const stepTicksUsed = budgetTicks + SLACK_TICKS;
		say(`  production budget read from package.loaded: ${budgetTicks} ticks; stepping ${stepTicksUsed} per arm`);

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
		pausedByUs = true;
		await stepTicks(stepTicksUsed);
		if (gateArm(readState(), stepTicksUsed)) await budgetArm(budgetTicks, stepTicksUsed);
		else say("\n  the budget arm did not run: the gate did not behave as measured, so which state leaves "
			+ "a record pending has to be re-derived before the budget can be probed");
	} catch (error) {
		console.error(error && error.stack ? error.stack : error);
		fail(`the suite threw: ${error.message}`);
	} finally {
		say("\n=== CLEANUP ===");
		if (pausedByUs) {
			try {
				lua(HOST, "game.tick_paused = false\nreturn { success = true }");
			} catch (error) {
				console.error(error && error.stack ? error.stack : error);
				fail(`could not clear tick_paused on host ${HOST}: ${error.message}`);
			}
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
			say(`  delete_surface issued for ${swept.deleted} platform(s); ${swept.records} queued record(s) `
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
		if (pausedByUs) {
			try {
				if (readTick().tick_paused === true) fail(`host ${HOST} was left tick_paused`);
			} catch (error) {
				console.error(error && error.stack ? error.stack : error);
				fail(`tick_paused check threw: ${error.message}`);
			}
		}
	}

	say("\n=== SUMMARY ===");
	if (problems.length === 0) say("  mining-progress-gate: ALL PASS");
	else say(`  mining-progress-gate: ${problems.length} FAILURE(S)`);
}

await main();
