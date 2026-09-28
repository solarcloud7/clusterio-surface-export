import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { start, terminal } from "./cases.mjs";
import { recoveryReady } from "./save-policy.mjs";
import { expectedCargo } from "../../integration/transfer-cleanup/oracle.mjs";

export const contract = {
  requires: ["owned disposable Docker lab", "resolved runtime profile", "verified pre-transfer checkpoint"],
  produces: ["return-trip refusal while the destination holds a quarantined copy", "keep_other, stale_copy and keep_this resolutions on real Factorio",
    "snapshot and deletion observations", "independent physical cargo after every resolution"],
  "does not": ["mutate the development cluster", "connect a real client", "prove every resolution action or verdict"],
};

const find = name => `local p;for _,v in pairs(game.forces.player.platforms) do if v.name==${JSON.stringify(name)} then assert(not p);p=v end end;assert(p,'fixture missing');`;
const read = (lab, host, name) => lab.probe(host, "read", name).state;
const both = (lab, name) => ({ a: read(lab, 1, name), b: read(lab, 2, name) });
const lastJson = raw => JSON.parse(raw.trim().split(/\r?\n/).at(-1));
const attempt = run => { try { return { output: run() }; } catch (error) { return { error: String(error.evidence ?? error.message ?? error) }; } };

function setHistoryMode(lab) {
  lab.ctl("controller", "config", "set", "surface_export.platform_source_of_truth", "plugin_history");
  assert.ok(lab.ctl("controller", "config", "list").split(/\r?\n/).some(line => line.includes("surface_export.platform_source_of_truth") && line.includes("plugin_history")));
}

function conflicts(lab, host) {
  const raw = lab.ctl("surface-export", "conflicts", String(lab.ids[host]));
  return JSON.parse(raw.slice(raw.indexOf("{")));
}

function resolve(lab, entry, action) {
  const requestId = randomUUID();
  const raw = lab.ctl("surface-export", "resolve-platform", String(entry.instanceId), String(entry.platformIndex), entry.platformUid, action, requestId);
  return { requestId, ...lastJson(raw) };
}

async function transferFrom(lab, host, name, target) {
  const index = read(lab, host, name).index;
  const started = lab.ctl("surface-export", "start-transfer", String(lab.ids[host]), String(index), String(lab.ids[target]));
  const id = started.trim().split(/\r?\n/).at(-1).replace(/^Transfer queued: /, "");
  return id;
}

async function outcomeOf(lab, id, statuses) {
  return lab.until(() => {
    const rows = lastJson(lab.ctl("surface-export", "list-transfers", "200")).filter(row => row.transferId === id || row.queuedRequestId === id);
    const settled = rows.filter(row => statuses.includes(row.status));
    return settled.find(row => row.status === "completed") || settled[0];
  }, `transfer ${id} ${statuses.join("/")}`, 180);
}

async function rolledBack(lab, report, save, name, { rollDestination = false } = {}) {
  await recoveryReady(lab, 1); await recoveryReady(lab, 2);
  setHistoryMode(lab);
  report.before = lab.probe(1, "build", name).state;
  assert.deepEqual(report.before.cargo, expectedCargo, "physical fixture does not match the independent contract");
  await lab.checkpoint("manual-lineage-created", [1]); await lab.load(1, "manual-lineage-created"); await recoveryReady(lab, 1);
  report.lineageBefore = lab.lua(1, find(name) + "local r=(storage.surface_export_lineages or {})[p.index];return {success=true,lineage=r and r.lineage,generation=r and r.generation}").result;
  report.checkpoint = await lab.checkpoint("manual-lineage-before", rollDestination ? [1, 2] : [1]); save();
  report.transferId = start(lab, name); report.outcome = await terminal(lab, report.transferId);
  assert.equal(report.outcome.status, "completed", "setup transfer A->B did not complete");
  report.transferred = both(lab, name); save();
  assert.equal(report.transferred.a.present, false); assert.equal(report.transferred.b.usable, true);
  if (rollDestination) { await lab.load(2, "manual-lineage-before"); await recoveryReady(lab, 2); }
  await lab.load(1, "manual-lineage-before"); await recoveryReady(lab, 1);
  report.rolledBack = both(lab, name); save();
  assert.equal(report.rolledBack.a.present, true, "the older source save did not restore the source copy");
  assert.equal(report.rolledBack.a.usable, false, "the restored source copy is usable next to the transferred copy");
  assert.deepEqual(report.rolledBack.a.cargo, expectedCargo);
  report.listing = conflicts(lab, 1); save();
  const entry = report.listing.conflicts.find(item => item.platformIndex === report.rolledBack.a.index);
  assert.ok(entry, "the restored source copy is not listed as a conflict");
  return entry;
}

export async function lineageReturnTripCase(lab, report, save) {
  report.lineageLabVersion = 1;
  const name = report.name = `transfer-cleanup-${lab.run}-return`;
  const entry = report.entry = await rolledBack(lab, report, save, name);
  assert.equal(entry.liveVerdict, "duplicate"); assert.ok(entry.actions.includes("keep_other"));
  report.returnRefusedId = await transferFrom(lab, 2, name, 1);
  report.returnRefused = await outcomeOf(lab, report.returnRefusedId, ["failed", "cleanup_failed", "error"]);
  report.afterRefusal = both(lab, name); save();
  assert.equal(report.returnRefused.status, "failed", "a refused return trip was not a clean failure");
  assert.match(report.returnRefused.error || "", /resolve the quarantined copy first/);
  assert.equal(report.afterRefusal.b.usable, true, "the refused return trip left the transferred copy unusable");
  assert.deepEqual(report.afterRefusal.b.cargo, expectedCargo);
  assert.equal(report.afterRefusal.a.usable, false); assert.deepEqual(report.afterRefusal.a.cargo, expectedCargo);
  report.keepOther = resolve(lab, entry, "keep_other");
  report.afterKeepOther = both(lab, name); save();
  assert.equal(report.keepOther.status, "completed", JSON.stringify(report.keepOther));
  assert.equal(report.afterKeepOther.a.present, false, "keep_other left the stale copy");
  assert.equal(report.afterKeepOther.b.usable, true); assert.deepEqual(report.afterKeepOther.b.cargo, expectedCargo);
  report.snapshotTransfer = attempt(() => lab.ctl("surface-export", "transfer", report.keepOther.snapshotExportId, String(lab.ids[2]))); save();
  assert.match(report.snapshotTransfer.error || "", /resolution snapshot/, "a resolution snapshot was accepted as a transfer");
  report.returnId = await transferFrom(lab, 2, name, 1);
  report.returnOutcome = await outcomeOf(lab, report.returnId, ["completed", "failed", "cleanup_failed", "error"]);
  report.returned = both(lab, name); save();
  assert.equal(report.returnOutcome.status, "completed", report.returnOutcome.error);
  assert.equal(report.returned.b.present, false); assert.equal(report.returned.a.usable, true);
  assert.deepEqual(report.returned.a.cargo, expectedCargo);
  await lab.checkpoint("manual-lineage-returned", [1]); await lab.load(1, "manual-lineage-returned"); await recoveryReady(lab, 1);
  report.final = both(lab, name); save();
  assert.equal(report.final.a.usable, true); assert.deepEqual(report.final.a.cargo, expectedCargo); assert.equal(report.final.b.present, false);
}

export async function lineageStaleCopyCase(lab, report, save) {
  report.lineageLabVersion = 1;
  const name = report.name = `transfer-cleanup-${lab.run}-stale`;
  const entry = report.entry = await rolledBack(lab, report, save, name, { rollDestination: true });
  assert.equal(report.rolledBack.b.present, false, "the destination rollback kept the transferred copy");
  assert.equal(entry.liveVerdict, "rollback_other"); assert.ok(entry.actions.includes("stale_copy"));
  report.staleCopy = resolve(lab, entry, "stale_copy");
  report.afterStaleCopy = both(lab, name); save();
  assert.equal(report.staleCopy.status, "completed", JSON.stringify(report.staleCopy));
  assert.equal(report.afterStaleCopy.a.present, false, "stale_copy left the copy");
  assert.match(report.staleCopy.snapshotExportId || "", /^\d+:/, "stale_copy stored no snapshot");
  const requestId = report.restoreRequestId = randomUUID();
  report.restore = lastJson(lab.ctl("surface-export", "restore-snapshot", report.staleCopy.snapshotExportId, String(lab.ids[1]), requestId));
  assert.equal(report.restore.success, true, JSON.stringify(report.restore));
  report.restoreOutcome = await terminal(lab, report.restore.operationId);
  report.restored = both(lab, name); save();
  assert.equal(report.restoreOutcome.status, "completed");
  assert.equal(report.restored.a.usable, true, "the deliberately restored snapshot is not usable");
  assert.deepEqual(report.restored.a.cargo, expectedCargo, "the resolution snapshot did not keep the physical cargo");
}

const PLACE_PASSENGER = name => find(name) + `
  local player;for _,c in pairs(game.players) do if not c.connected then player=c;break end end
  if not player then return {success=true,available=false} end
  player.set_controller{type=defines.controllers.god}
  local origin=game.surfaces.nauvis
  local position=origin.find_non_colliding_position("character",player.force.get_spawn_position(origin),32,0.5)
  assert(position and player.teleport(position,origin),"offline teleport to Nauvis failed")
  local character=assert(origin.create_entity{name="character",position=position,force=player.force})
  player.set_controller{type=defines.controllers.character,character=character}
  assert(player.teleport({2,3},p.surface),"offline teleport to the platform failed")
  return {success=true,available=true,player=player.index,physical=player.physical_surface_index,surface=p.surface.index}`;

export async function lineageKeepThisCase(lab, report, save) {
  report.lineageLabVersion = 1;
  const name = report.name = `transfer-cleanup-${lab.run}-keep`;
  let entry = report.entry = await rolledBack(lab, report, save, name);
  assert.equal(entry.liveVerdict, "duplicate"); assert.ok(entry.actions.includes("keep_this"));
  report.passenger = lab.lua(2, PLACE_PASSENGER(name)).result; save();
  if (report.passenger.available) {
    assert.equal(report.passenger.physical, report.passenger.surface, "the offline player is not aboard the other copy");
    entry = report.entryWithPassenger = conflicts(lab, 1).conflicts.find(item => item.platformIndex === report.rolledBack.a.index);
    assert.equal(entry.holderPassengers, 1, "the listing does not show the player aboard the other copy");
  }
  report.keepThis = resolve(lab, entry, "keep_this");
  report.afterKeepThis = both(lab, name); save();
  assert.equal(report.keepThis.status, "completed", JSON.stringify(report.keepThis));
  assert.equal(report.afterKeepThis.b.present, false, "keep_this left the other copy");
  assert.equal(report.afterKeepThis.a.usable, true, "keep_this did not release this copy");
  assert.deepEqual(report.afterKeepThis.a.cargo, expectedCargo);
  if (report.passenger.available) {
    assert.equal(report.keepThis.passengers, 1, "the resolution did not report the player aboard the deleted copy");
    report.passengerAfter = lab.lua(2, `local player=game.get_player(${report.passenger.player});return {success=true,physical=player.physical_surface.name}`).result; save();
    assert.equal(report.passengerAfter.physical, "nauvis", "the player aboard the deleted copy was not moved to the default planet");
  }
  await lab.checkpoint("manual-lineage-kept", [1]); await lab.load(1, "manual-lineage-kept"); await recoveryReady(lab, 1);
  report.final = both(lab, name); save();
  assert.equal(report.final.a.usable, true); assert.deepEqual(report.final.a.cargo, expectedCargo);
}

export function analyzeLineage(report) {
  assert.equal(report.cleanup?.success, true, "Docker cleanup unproven");
  assert.deepEqual(report.before?.cargo, expectedCargo, "invalid physical fixture");
  assert.equal(report.outcome?.status, "completed");
  assert.equal(report.rolledBack?.a.usable, false);
  if (report.case === "lineage-return-trip") {
    assert.equal(report.returnRefused?.status, "failed"); assert.equal(report.afterRefusal?.b.usable, true);
    assert.equal(report.keepOther?.status, "completed"); assert.equal(report.afterKeepOther?.a.present, false);
    assert.match(report.snapshotTransfer?.error || "", /resolution snapshot/);
    assert.equal(report.returnOutcome?.status, "completed"); assert.deepEqual(report.final?.a.cargo, expectedCargo);
    assert.equal(report.final.a.usable, true); assert.equal(report.final.b.present, false);
    return { verdict: "PASS", reason: "A return trip to a server holding a quarantined copy was refused without loss; keep_other then allowed it with exact cargo" };
  }
  if (report.case === "lineage-stale-copy") {
    assert.equal(report.staleCopy?.status, "completed"); assert.equal(report.afterStaleCopy?.a.present, false);
    assert.equal(report.restoreOutcome?.status, "completed"); assert.deepEqual(report.restored?.a.cargo, expectedCargo);
    return { verdict: "PASS", reason: "stale_copy deleted a rolled-back copy under its retirement; its snapshot restored exact cargo" };
  }
  assert.equal(report.case, "lineage-keep-this", "unknown lineage case");
  assert.equal(report.keepThis?.status, "completed"); assert.equal(report.afterKeepThis?.b.present, false);
  assert.deepEqual(report.final?.a.cargo, expectedCargo); assert.equal(report.final.a.usable, true);
  if (report.passenger?.available) { assert.equal(report.keepThis.passengers, 1); assert.equal(report.passengerAfter?.physical, "nauvis"); }
  return { verdict: "PASS", reason: `keep_this deleted the other copy and released this one with exact cargo${report.passenger?.available ? "; the player aboard was counted and moved to Nauvis" : "; no offline player fixture was available"}` };
}
