#!/usr/bin/env node
// requires: the cluster up, host-2 reachable and not tick_paused; run from the repo root
// produces: for a drill created DEACTIVATED over ore and then reactivated, mining_target bound or not,
//           read at +0 and +360 stepped ticks — once on a PAUSED platform (the import path's
//           park / captured-paused case) and once on a RUNNING platform (control)
// does not: grade anything; sweep is unconditional

import { lua as luaRaw, sleep } from "../../lab-gallery/batch-lifecycle.mjs";

const HOST = 2;
const TAG = Date.now().toString(36);

function lua(body) {
	const r = luaRaw(HOST, body);
	if (!r || r.success !== true) throw new Error(`lua failed: ${r && r.error}`);
	return r;
}

function build(name, paused) {
	return lua(`local p = game.forces.player.create_space_platform{ name = '${name}', planet = 'nauvis',
  starter_pack = 'space-platform-starter-pack' }
p.apply_starter_pack()
local s = p.surface
local tiles = {}
for x = -6, 6 do
  for y = -6, 6 do tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { x, y } } end
end
s.set_tiles(tiles)
for _, d in ipairs({ { -0.5, -0.5 }, { 0.5, -0.5 }, { -0.5, 0.5 }, { 0.5, 0.5 } }) do
  s.create_entity{ name = 'iron-ore', position = { 2 + d[1], 2 + d[2] }, amount = 20000 }
end
local drill = s.create_entity{ name = 'burner-mining-drill', position = { 2, 2 }, force = 'player',
  direction = defines.direction.north }
drill.disabled_by_script = true
drill.insert{ name = 'coal', count = 50 }
p.paused = ${paused}
return { success = true, active_while_disabled = drill.active, paused = p.paused,
  bound_while_disabled = (drill.mining_target ~= nil) }`);
}

function reactivateAndRead(name) {
	return lua(`local p
for _, pl in pairs(game.forces.player.platforms) do if pl.valid and pl.name == '${name}' then p = pl end end
local drill = p.surface.find_entities_filtered{ type = 'mining-drill' }[1]
drill.disabled_by_script = false
return { success = true, tick = game.tick, paused = p.paused, active = drill.active,
  bound = (drill.mining_target ~= nil), status = drill.status }`);
}

function read(name) {
	return lua(`local p
for _, pl in pairs(game.forces.player.platforms) do if pl.valid and pl.name == '${name}' then p = pl end end
local drill = p.surface.find_entities_filtered{ type = 'mining-drill' }[1]
local statuses = {}
for k, v in pairs(defines.entity_status) do statuses[v] = k end
return { success = true, tick = game.tick, paused = p.paused,
  state_paused = (p.state == defines.space_platform_state.paused), active = drill.active,
  bound = (drill.mining_target ~= nil), status = statuses[drill.status] or tostring(drill.status),
  mining_progress = drill.mining_progress }`);
}

async function step(ticks) {
	const before = lua("return { success = true, tick = game.tick }").tick;
	lua(`game.ticks_to_run = ${ticks}\nreturn { success = true }`);
	await sleep(Math.ceil(ticks * 1000 / 60) + 300);
	for (let i = 0; i < 60; i++) {
		const now = lua("return { success = true, tick = game.tick }").tick;
		if (now >= before + ticks) return;
		await sleep(300);
	}
	throw new Error("ticks_to_run did not advance");
}

function sweep(name) {
	return lua(`local n = 0
for _, pl in pairs(game.forces.player.platforms) do
  if pl.valid and pl.name == '${name}' and pl.surface and pl.surface.valid then
    game.delete_surface(pl.surface)
    n = n + 1
  end
end
return { success = true, deleted = n }`);
}

const pre = lua("return { success = true, tick_paused = game.tick_paused == true }");
if (pre.tick_paused) throw new Error("host-2 already tick_paused — refusing");
lua("game.tick_paused = true\nreturn { success = true }");
try {
	const arms = [
		{ label: "PAUSED platform", paused: true },
		{ label: "RUNNING platform (control)", paused: false },
	];
	const describe = (r) => `paused=${r.paused} state_paused=${r.state_paused} active=${r.active} `
		+ `bound=${r.bound} status=${r.status} progress=${r.mining_progress}`;
	for (const arm of arms) {
		const name = `mpbind-${TAG}-${arm.paused ? "p" : "r"}`;
		console.log(`\n=== ${arm.label}: ${name} ===`);
		const b = build(name, arm.paused);
		console.log(`  built: paused=${b.paused} drill active_while_disabled=${b.active_while_disabled} `
			+ `bound_while_disabled=${b.bound_while_disabled}`);
		await step(60);
		const r0 = reactivateAndRead(name);
		console.log(`  reactivated at tick ${r0.tick}: paused=${r0.paused} active=${r0.active} bound=${r0.bound}`);
		await step(1);
		console.log(`  +1 tick:    ${describe(read(name))}`);
		await step(359);
		console.log(`  +360 ticks: ${describe(read(name))}`);
		console.log(`  swept: ${JSON.stringify(sweep(name))}`);
	}
} finally {
	lua("game.tick_paused = false\nreturn { success = true }");
	for (const suffix of ["p", "r"]) sweep(`mpbind-${TAG}-${suffix}`);
	console.log(`\ncleanup: tick_paused cleared, probe platforms swept`);
}
