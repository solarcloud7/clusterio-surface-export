#!/usr/bin/env node
// requires: idle localhost instances, production transfer pipeline, Factorio 2.1.17 API
// produces: source/payload/inactive-destination/reactivated-destination readings and cleanup proof
// does not: inject destination progress or queue records, reset saves, or touch pre-existing platforms
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
	lua as rawLua, sleep, instanceIds, preflightState, assertLeaseClean,
	fetchTransferSummaries,
} from "../../lab-gallery/batch-lifecycle.mjs";

const NAME = `mptransfer-${Date.now().toString(36)}`;
const MODULE = "__level__/modules/surface_export/import_phases/active_state_restoration.lua";
const report = { name: NAME, fixtureSha256: createHash("sha256")
	.update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"), readings: {} };
const pauses = new Set();
let constructed = false;
let jobId;
let measuring = false;
function lua(host, body) {
	const r = rawLua(host, body);
	assert.equal(r?.success, true, r?.error || JSON.stringify(r));
	return r;
}
function platform(allowImporting = false) {
	return `local p
for _, candidate in pairs(game.forces.player.platforms) do
  if candidate.valid and candidate.name == '${NAME}' then p = candidate end
end
if not p then return {success=true,present=false,tick=game.tick} end
local s = p.surface
local drill = s.find_entities_filtered{type='mining-drill'}[1]
${allowImporting ? "if not (drill and drill.valid) then return {success=true,present=true,ready=false,tick=game.tick} end" : "assert(drill and drill.valid, 'fixture drill missing')"}`;
}
function read(host) {
	return lua(host, `${platform(true)}
local pending = {}
for _, rec in pairs(storage.pending_mining_progress or {}) do
  if rec.entity and rec.entity.valid and rec.entity.unit_number == drill.unit_number then
    pending[#pending+1] = {mining=rec.mining_progress,bonus=rec.bonus_mining_progress}
  end
end
return {success=true,present=true,ready=true,tick=game.tick,active=drill.active,bound=drill.mining_target~=nil,
  mining=drill.mining_progress,bonus=drill.bonus_mining_progress,pending_count=#pending,pending=pending,
  resources=s.count_entities_filtered{type='resource'},paused=game.tick_paused,index=p.index}`);
}
async function pause(host) {
	assert.equal(lua(host, "return {success=true,paused=game.tick_paused}").paused, false, "foreign pause");
	pauses.add(host);
	lua(host, "game.tick_paused=true; return {success=true}");
}
async function step(host, count) {
	const before = lua(host, `assert(game.tick_paused,'step requires owned pause')
game.ticks_to_run=${count}; return {success=true,tick=game.tick}`);
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		await sleep(200);
		const now = lua(host, "return {success=true,tick=game.tick,paused=game.tick_paused}");
		assert.equal(now.paused, true);
		if (now.tick === before.tick + count) return;
		assert.ok(now.tick < before.tick + count, "tick stepping exceeded requested count");
	}
	throw new Error(`step did not complete ${count} ticks`);
}

try {
	for (const host of [1, 2]) {
		assertLeaseClean(host, preflightState(host), "inactive-drill-transfer");
		assert.equal(lua(host, "return {success=true,pending=table_size(storage.pending_mining_progress or {})}").pending,
			0, "foreign pending mining records");
	}
	const ids = instanceIds();
	report.runtime = lua(2, `local M=package.loaded['${MODULE}']
return {success=true,engine=script.active_mods.base,mods=script.active_mods,
  module=remote.call('surface_export','get_module_version'),checkoutHash=M._checkout_hash,
  budget=M.MINING_PROGRESS_BUDGET_TICKS}`);
	assert.equal(report.runtime.engine, "2.1.17", "re-certify the fixture for the new engine pin");
	assert.ok(report.runtime.budget > 0 && report.runtime.budget <= 600);
	constructed = true;
	lua(1, `local p=game.forces.player.create_space_platform{name='${NAME}',planet='nauvis',
  starter_pack='space-platform-starter-pack'}
assert(p,'platform creation failed'); p.apply_starter_pack()
local s=p.surface; local tiles={}
for x=-10,18 do for y=-8,8 do
  tiles[#tiles+1]={name='space-platform-foundation',position={x,y}}
end end
s.set_tiles(tiles)
for _, d in ipairs({{-0.5,-0.5},{0.5,-0.5},{-0.5,0.5},{0.5,0.5}}) do
  assert(s.create_entity{name='iron-ore',position={14+d[1],6+d[2]},amount=20000})
end
assert(s.create_entity{name='burner-mining-drill',position={14,6},force='player',direction=defines.direction.north})
p.paused=true
return {success=true}`);
	if (process.argv.includes("--fail-after-build")) throw new Error("injected failure after construction");
	await sleep(100);
	await pause(1);
	report.readings.source = lua(1, `${platform()}
assert(drill.mining_target, 'source drill must bind before setting progress')
assert(drill.insert{name='coal',count=50}==50)
drill.mining_progress=0.55; drill.bonus_mining_progress=0.62
drill.disabled_by_script=true
return {success=true,mining=drill.mining_progress,bonus=drill.bonus_mining_progress,
  active=drill.active,resources=s.count_entities_filtered{type='resource'}}`);
	assert.equal(report.readings.source.active, false);
	assert.ok(Math.abs(report.readings.source.mining - 0.55) < 1e-6);
	assert.ok(Math.abs(report.readings.source.bonus - 0.62) < 1e-6);
	assert.equal(report.readings.source.resources, 4);
	const start = lua(1, `${platform()}
local trigger=package.loaded['__level__/modules/surface_export/core/transfer-trigger.lua']
assert(type(trigger)=='table','production transfer trigger not loaded')
local job,err=trigger.start(game.forces.player,p.index,${ids[2]})
assert(job,err); game.tick_paused=false
return {success=true,job_id=job}`);
	pauses.delete(1);
	jobId = start.job_id;
	report.jobId = jobId;
	const deadline = Date.now() + 120_000;
	let arrived;
	let transfer;
	while (Date.now() < deadline) {
		await sleep(1000);
		const dest = read(2);
		if (dest.ready && !read(1).present) {
			transfer = fetchTransferSummaries({ limit: 20 })?.find(row => row.transferId === `${ids[1]}:${jobId}`);
			if (transfer?.status === "completed") { arrived = dest; break; }
		}
	}
	assert.ok(arrived, "transfer did not settle with source deleted within 120s");
	assert.equal(transfer?.status, "completed", "exact transfer did not report completed");
	report.transfer = { id: transfer.transferId, status: transfer.status };
	report.readings.arrival = arrived;
	report.readings.payload = lua(1, `local data=remote.call('surface_export','get_export','${jobId}')
assert(data,'exact transfer export missing')
if data.compressed then data=helpers.json_to_table(helpers.decode_string(data.payload)) end
assert(data.platform_name=='${NAME}','wrong export')
local found
for _, entity in pairs(data.entities) do if entity.name=='burner-mining-drill' then
  assert(not found,'multiple drills in payload'); found=entity
end end
assert(found,'drill missing from payload')
local active=data.frozen_states[tostring(found.entity_id)]
if active==nil then active=data.frozen_states[found.entity_id] end
return {success=true,mining=found.specific_data.mining_progress,
  bonus=found.specific_data.bonus_mining_progress,active=active}`);
	assert.equal(report.readings.payload.active, false, "payload lost the source inactive state");
	for (const field of ["mining", "bonus"]) {
		assert.ok(Math.abs(report.readings.payload[field] - report.readings.source[field]) < 1e-6,
			`payload lost source ${field} progress`);
	}
	await pause(2);
	await step(2, report.runtime.budget + 60);
	const dormant = report.readings.dormant = read(2);
	assert.equal(dormant.active, false, "import reactivated an inactive-source drill");
	assert.equal(dormant.resources, 4);
	assert.equal(dormant.bound, false, "dormant drill already bound: fixture does not exercise deferred restoration");
	measuring = true;
	assert.equal(dormant.pending_count, 1, "inactive-source progress was not retained through the transfer");
	for (const field of ["mining", "bonus"]) {
		assert.ok(Math.abs(dormant.pending[0][field] - report.readings.source[field]) < 1e-6);
	}
	lua(2, `${platform()}; drill.disabled_by_script=false; return {success=true}`);
	await step(2, 5);
	const landed = report.readings.reactivated = read(2);
	assert.equal(landed.active, true);
	assert.equal(landed.bound, true);
	assert.equal(landed.pending_count, 0);
	for (const field of ["mining", "bonus"]) {
		const captured = report.readings.source[field];
		assert.ok(landed[field] >= captured - 1e-6 && landed[field] < captured + 0.1,
			`${field} did not land on the destination drill: ${landed[field]} vs ${captured}`);
	}
	report.verdict = "PASS";
} catch (error) {
	report.verdict = measuring ? "STOP" : "HARNESS_ERROR";
	report.error = error.stack;
	process.exitCode = 1;
} finally {
	report.cleanup = [];
	for (const host of [1, 2]) {
		try {
			for (const peer of pauses) {
				lua(peer, "game.tick_paused=false; return {success=true}");
				pauses.delete(peer);
			}
			if (constructed) {
				// Never delete a fixture surface while transfer jobs still own either host.
				for (const peer of [1, 2]) {
					assertLeaseClean(peer, preflightState(peer), "inactive-drill-transfer before cleanup");
				}
				lua(host, `for _, p in pairs(game.forces.player.platforms) do
  if p.valid and p.name=='${NAME}' then
    local s=p.surface; local keep={}
    for _, rec in pairs(storage.pending_mining_progress or {}) do
      if not (rec.entity and rec.entity.valid and rec.entity.surface.index==s.index) then keep[#keep+1]=rec end
    end
    storage.pending_mining_progress=(#keep>0) and keep or nil
    game.delete_surface(s)
  end
end
return {success=true}`);
				await sleep(100);
				assert.equal(read(host).present, false, "fixture surface remains");
			}
			const state = preflightState(host);
			assertLeaseClean(host, state, "inactive-drill-transfer cleanup");
			state.pendingMining = lua(host, "return {success=true,n=table_size(storage.pending_mining_progress or {})}").n;
			assert.equal(state.pendingMining, 0, "pending mining records remain");
			report.cleanup.push({ host, state, zeroFixtureSurfaces: true });
		} catch (error) {
			report.cleanup.push({ host, error: error.message });
			report.verdict = "HARNESS_ERROR";
			process.exitCode = 1;
		}
	}
	mkdirSync("ci-artifacts", { recursive: true });
	writeFileSync(`ci-artifacts/${NAME}.json`, JSON.stringify(report, null, 2) + "\n");
	console.log(JSON.stringify(report, null, 2));
}
