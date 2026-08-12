#!/usr/bin/env node
// loader-freeze — does disabled_by_script = true stop the standard fill harness's loader at this pin?
//
// requires: a running surface-export cluster with lab-omnibus-state-v1 on host-1 (the rung BUILDS the
//           doc-prescribed harness — infinity chest -> filtered turbo-loader -> belt — on a throwaway
//           clone, because the live golden save carries zero infinity-containers and the doc's
//           exemplar platform lab-omnibus-platform-v1 does not exist; measured 2026-08-12)
// produces: per-loader refill counts for three arms (control, disabled_by_script=true, re-enabled) on
//           the built rigs, readback of the written flag, per-arm status names, and a verdict on
//           docs/testing.md's "freeze the feed with disabled_by_script = true" instruction
// does not: measure transport-belt behavior (tests/instruments/belt-freeze on PR #211 covers that),
//           measure paused-platform behavior, assert item conservation, measure the save's four
//           feed-less native loaders, or touch a protected fixture (it clones and sweeps)

import { lua as luaRaw, sleep } from "../../lab-gallery/batch-lifecycle.mjs";

const HOST = 1;
const SOURCE_NAME = "lab-omnibus-state-v1";
const CLONE = `loaderfreeze-${Date.now().toString(36)}`;
const CLONE_WAIT_MS = 180_000;
const WINDOW_MS = 3000;
const MIN_WINDOW_TICKS = 60;

const say = (...a) => console.log(...a);
const problems = [];

function fail(message) {
	problems.push(message);
	process.exitCode = 1;
	say(`  !! ${message}`);
}

function lua(body) {
	const r = luaRaw(HOST, body);
	if (r === null || typeof r !== "object") throw new Error(`lua returned no object: ${JSON.stringify(r)}`);
	if (r.success !== true) throw new Error(`lua failed: ${r.error ?? JSON.stringify(r)}`);
	return r;
}

const PRE = `
local st = storage.__loader_freeze_rung
if not st then return { success = false, error = 'rung storage missing' } end
local p
for _, pl in pairs(game.forces.player.platforms) do if pl.index == st.platform then p = pl end end
if not (p and p.valid) then return { success = false, error = 'platform index '..tostring(st.platform)..' not found' } end
local s = p.surface
if not (s and s.valid) then return { success = false, error = 'platform has no valid surface' } end
local function loaders()
  local m = {}
  local rig = st.rig_units or {}
  for _, e in pairs(s.find_entities_filtered{ type = 'loader' }) do
    if rig[tostring(e.unit_number)] then m[e.unit_number] = e end
  end
  return m
end
local function status_name(e)
  for k, v in pairs(defines.entity_status) do if v == e.status then return k end end
  return 'unknown'
end
local function line_total(e)
  local n = 0
  for li = 1, e.get_max_transport_line_index() do n = n + e.get_transport_line(li).get_item_count() end
  return n
end
local function clear_lines(e)
  for li = 1, e.get_max_transport_line_index() do e.get_transport_line(li).clear() end
end
`;

function armStart(flagWrite) {
	return PRE + `
local wrote = {}
for u, e in pairs(loaders()) do
  ${flagWrite}
  clear_lines(e)
  wrote[#wrote + 1] = { unit = u, readback = e.disabled_by_script, status = status_name(e) }
end
st.arm_tick = game.tick
return { success = true, loaders = wrote, tick = game.tick, paused = p.paused }
`;
}

const ARM_MEASURE = PRE + `
local rows = {}
for u, e in pairs(loaders()) do
  rows[#rows + 1] = { unit = u, refill = line_total(e), readback = e.disabled_by_script, status = status_name(e) }
end
return { success = true, rows = rows, window_ticks = game.tick - (st.arm_tick or 0), tick = game.tick, paused = p.paused }
`;

async function runArm(label, flagWrite) {
	const start = lua(armStart(flagWrite));
	say(`  ${label}: armed on ${start.loaders.length} loaders at tick ${start.tick}` +
		` readback=[${start.loaders.map(l => l.readback).join(",")}]` +
		` status=[${start.loaders.map(l => l.status).join(",")}]`);
	await sleep(WINDOW_MS);
	const m = lua(ARM_MEASURE);
	if (m.window_ticks < MIN_WINDOW_TICKS) {
		throw new Error(`${label}: window only ${m.window_ticks} ticks (< ${MIN_WINDOW_TICKS}) — game not advancing, no fact measured`);
	}
	for (const row of m.rows) {
		say(`    unit ${row.unit}: refill=${row.refill} readback=${row.readback} status=${row.status}`);
	}
	say(`    window=${m.window_ticks} ticks, paused=${m.paused}`);
	return m;
}

async function cloneFixture(sourceIndex) {
	const queued = lua(`local r = remote.call('surface_export', 'clone_platform', ${sourceIndex}, '${CLONE}')
return { success = true, job_id = r and r.job_id, entity_count = r and r.entity_count }`);
	say(`clone of '${SOURCE_NAME}' [${sourceIndex}] -> ${CLONE}: job=${queued.job_id} entities=${queued.entity_count}`);
	const deadline = Date.now() + CLONE_WAIT_MS;
	while (Date.now() < deadline) {
		const found = lua(`local idx
for _, pl in pairs(game.forces.player.platforms) do if pl.name == '${CLONE}' and pl.surface and pl.surface.valid then idx = pl.index end end
return { success = true, index = idx }`);
		if (typeof found.index === "number") return found.index;
		await sleep(3000);
	}
	throw new Error(`clone '${CLONE}' did not materialize within ${CLONE_WAIT_MS} ms`);
}

async function main() {
	say(`=== loader-freeze rung: does disabled_by_script stop a '${SOURCE_NAME}' harness loader? ===`);

	const source = lua(`local idx
for _, pl in pairs(game.forces.player.platforms) do if pl.name == '${SOURCE_NAME}' then idx = pl.index end end
return { success = true, index = idx }`);
	if (typeof source.index !== "number") throw new Error(`'${SOURCE_NAME}' not found on host ${HOST} — wrong save loaded?`);

	try {
		const cloneIndex = await cloneFixture(source.index);
		lua(`storage.__loader_freeze_rung = { platform = ${cloneIndex} }
return { success = true }`);
		const state = lua(PRE + `
p.paused = false
local maxx = -math.huge
for _, e in pairs(s.find_entities_filtered{}) do if e.position.x > maxx then maxx = e.position.x end end
if maxx == -math.huge then return { success = false, error = 'clone has no entities' } end
local rigs = {}
local rig_units = {}
local items = { 'iron-plate', 'copper-plate' }
for i = 1, 2 do
  local tx = math.floor(maxx) + 4 + i * 3
  local ty = 40
  local tiles = {}
  for dy = 0, 4 do tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { tx, ty + dy } } end
  s.set_tiles(tiles)
  local chest = s.create_entity{ name = 'infinity-chest', position = { tx + 0.5, ty + 0.5 }, force = 'player' }
  if not chest then return { success = false, error = 'chest did not place at column '..tx } end
  chest.set_infinity_container_filter(1, { name = items[i], count = 100, mode = 'at-least' })
  chest.remove_unfiltered_items = true
  local loader = s.create_entity{ name = 'turbo-loader', position = { tx + 0.5, ty + 2 },
    direction = defines.direction.south, force = 'player' }
  if not loader then return { success = false, error = 'loader did not place at column '..tx } end
  loader.loader_type = 'output'
  loader.set_filter(1, { name = items[i] })
  local belt = s.create_entity{ name = 'transport-belt', position = { tx + 0.5, ty + 3.5 },
    direction = defines.direction.south, force = 'player' }
  if not belt then return { success = false, error = 'belt did not place at column '..tx } end
  rig_units[tostring(loader.unit_number)] = true
  rigs[#rigs + 1] = { unit = loader.unit_number, item = items[i],
    chest_items = chest.get_inventory(defines.inventory.chest).get_item_count() }
end
st.rig_units = rig_units
local list = {}
for u, e in pairs(loaders()) do
  list[#list + 1] = { unit = u, name = e.name, kind = e.loader_type,
    filtered = e.get_filter(1) ~= nil, status = status_name(e), carried = line_total(e) }
end
return { success = true, paused = p.paused, rigs = rigs, loaders = list }`);
		if (state.paused !== false) throw new Error("clone did not unpause; every arm would be confounded");
		if (!Array.isArray(state.loaders) || state.loaders.length !== 2) {
			throw new Error(`rig build did not yield 2 measurable loaders: ${JSON.stringify(state.loaders)}`);
		}
		say(`clone [${cloneIndex}] unpaused; built ${state.loaders.length} harness rigs: ` +
			state.rigs.map(r => `unit ${r.unit} feeding ${r.item} (chest holds ${r.chest_items})`).join(", "));
		say(`  rig loaders: ` +
			state.loaders.map(l => `${l.name}(${l.kind}, filtered=${l.filtered}, status=${l.status})`).join(", "));

		say("\n=== ARM A (control): loaders enabled — the feed must measurably refill cleared lines ===");
		const a = await runArm("A", "");
		const aDead = a.rows.filter(r => r.refill === 0);
		if (aDead.length > 0) {
			fail(`control arm: ${aDead.length}/${a.rows.length} loaders did not refill — the instrument cannot see ` +
				"insertion, so no later arm can claim anything. No fact measured.");
			return;
		}

		say("\n=== ARM B: disabled_by_script = true written on every loader ===");
		const b = await runArm("B", "e.disabled_by_script = true");
		const bFed = b.rows.filter(r => r.refill > 0);
		const bReadback = b.rows.filter(r => r.readback === true);

		say("\n=== ARM C: disabled_by_script = false — the instrument must still be alive ===");
		const c = await runArm("C", "e.disabled_by_script = false");
		const cDead = c.rows.filter(r => r.refill === 0);
		if (cDead.length > 0) {
			fail(`re-enable arm: ${cDead.length}/${c.rows.length} loaders did not resume — ARM B's numbers cannot be ` +
				"distinguished from a dead rig. No fact measured.");
			return;
		}

		say("\n=== VERDICT (pinned 2026-08-12: loaders FREEZE under disabled_by_script, unlike belts) ===");
		say(`  readback true on ${bReadback.length}/${b.rows.length} loaders after the write`);
		if (bReadback.length !== b.rows.length) {
			fail(`readback DIVERGED: only ${bReadback.length}/${b.rows.length} loaders read back true — at the ` +
				"measured pin the write sticks on every loader (belts are the type that silently drops it)");
		}
		if (bFed.length === 0) {
			say(`  FREEZES: 0/${b.rows.length} loaders refilled under disabled_by_script=true (control and re-enable ` +
				"arms both refilled). docs/testing.md's instruction holds for loaders at this pin.");
		} else {
			fail(`freeze DIVERGED: ${bFed.length}/${b.rows.length} loaders kept feeding under disabled_by_script=true — ` +
				"docs/testing.md's freeze instruction no longer holds for loaders at this pin; re-measure before " +
				"trusting any fill-harness freeze window");
		}
	} finally {
		try {
			const deleted = lua(`local names = {}
for _, pl in pairs(game.forces.player.platforms) do
  if pl.valid and pl.name:sub(1, 12) == 'loaderfreeze' and pl.surface and pl.surface.valid then
    names[#names + 1] = pl.name
    game.delete_surface(pl.surface)
  end
end
storage.__loader_freeze_rung = nil
return { success = true, deleted = names }`);
			say(`\ncleanup: delete_surface issued for ${JSON.stringify(deleted.deleted)}; rung storage cleared`);
			await sleep(5000);
			const left = lua(`local n = 0
for _, pl in pairs(game.forces.player.platforms) do if pl.valid and pl.name:sub(1, 12) == 'loaderfreeze' then n = n + 1 end end
return { success = true, leftovers = n }`);
			if (left.leftovers !== 0) fail(`sweep left ${left.leftovers} loaderfreeze platform(s) behind`);
			else say("cleanup: zero leftovers");
		} catch (error) {
			fail(`cleanup failed: ${error.message} — sweep by hand with tools/tests/cleanup-test-surfaces.ps1`);
		}
	}
}

main().then(() => {
	if (problems.length) {
		say(`\n=== loader-freeze rung: ${problems.length} problem(s) ===`);
		process.exitCode = 1;
	} else {
		say("\n=== loader-freeze rung: complete ===");
	}
}).catch(error => {
	console.error(`loader-freeze rung: fatal — ${error && error.stack ? error.stack : error}`);
	process.exitCode = 1;
});
