// Offline verification of the inverse-reconstruction experiment; never connects to Factorio.
import assert from "node:assert/strict";
import fs from "node:fs";
import { inflateSync } from "node:zlib";

const values = value => Object.values(value || {});
const lanes = process.argv.includes("--lanes");
// Read from defines.transport_line on 2.1.17; retained in belt-lane-api-values.json.
// Underground and secondary splitter names alias indices 3/4. Do not infer enum
// values from their order in the documentation schema.
const side = row => {
 assert.ok(Number.isInteger(row.line) && row.line >= 1 && row.line <= 8, "unknown fixture transport line");
 return [1, 3, 5, 7].includes(row.line) ? "left" : "right";
};
const canonical = value => value && typeof value === "object"
 ? JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])))
 : JSON.stringify(value);
const identity = row => canonical([row.name, row.quality, row.properties, ...(lanes ? [side(row)] : [])]);
const count = (rows, keyOf = identity) => {
 const result = {};
 for (const row of rows) {
  assert.ok(Number.isInteger(row.count) && row.count > 0, "invalid item count");
  const key = keyOf(row); result[key] = (result[key] || 0) + row.count;
 }
 return result;
};
const unique = rows => {
 const result = new Map();
 for (const row of values(rows)) {
  assert.ok(row.uid, "missing physical item ID");
  if (result.has(row.uid)) assert.equal(identity(row), identity(result.get(row.uid)), "alias properties disagree");
  if (result.has(row.uid)) assert.equal(row.count, result.get(row.uid).count, "alias counts disagree");
  result.set(row.uid, row);
 }
 return [...result.values()];
};
const fixture = JSON.parse(fs.readFileSync(new URL("remove-fixture.json", import.meta.url), "utf8"));
const blueprints = [
 { entity_number: 1, name: "transport-belt", position: { x: 0.5, y: 0.5 } },
 { entity_number: 2, name: "wooden-chest", position: { x: 1.5, y: 0.5 } },
];
function expectedRows(name, dense = false) {
 return fixture.cases[name].flatMap((_, i) => {
  const spec = fixture.statefulItems[i], properties = { health: spec.health ?? 1 };
  for (const key of ["ammo", "durability"]) if (spec[key] !== undefined) properties[key] = spec[key];
  if (spec.blueprint) Object.assign(properties, { blueprint: blueprints, label: "capture-remove-parity" });
  return [
   { name: spec.name, quality: spec.quality || "normal", count: spec.count, properties, line: 1 },
   { name: "iron-plate", quality: "rare", count: 4, properties: { health: 1 }, line: 2 },
   ...(dense ? [
    { name: "copper-plate", quality: "legendary", count: 8, properties: { health: 1 }, line: 1 },
    { name: "steel-plate", quality: "uncommon", count: 8, properties: { health: 1 }, line: 2 },
   ] : []),
  ];
 });
}
function verify(result) {
 assert.equal(result.engine, "2.1.17");
 for (const flag of ["boundary", "paired", "fidelity", "bundleAbsent"]) assert.equal(result[flag], true, flag);
 assert.ok(result.reverseRebuild || result.sameLane, "unsupported reconstruction candidate");
 const arms = result.runs.filter(run => typeof run.reverse === "boolean");
 assert.deepEqual(arms.map(run => `${run.case}:${run.reverse}`).sort(),
  (result.junctions ? ["side-loading", "splitter-branches"] : ["straight", "loop", "splitter", "paired-chain"])
   .flatMap(name => [`${name}:false`, `${name}:true`]).sort());
 const verified = [];
 for (const arm of arms) {
  const flow = Boolean(fixture.routingCases?.[arm.case]);
  const keyOf = row => canonical([row.name, row.quality, row.properties, ...(lanes && !flow ? [side(row)] : [])]);
  const laneKey = row => canonical([row.name, row.quality, row.properties, side(row)]);
  const raw = arm.raw, seed = expectedRows(arm.case, result.dense), expected = count(seed, keyOf), ledger = new Map(), removed = [];
  let snapshots = 0, payloadIndex = 0, previousTick, restoredItems = 0, wire, batchIndex = 0;
  const check = physical => {
   assert.ok(physical, "missing physical observation");
   assert.equal(values(physical.ground).length, 0, "ground spill");
   for (const line of values(physical.nativeCounts)) {
    const rows = values(physical.rows).filter(row => row.belt === line.belt && row.line === line.line);
    assert.equal(rows.reduce((n, row) => n + row.count, 0), line.count, "native line count disagrees");
   }
   assert.deepEqual(count([...unique(physical.rows), ...[...ledger.values()].flat()], keyOf), expected,
    `${arm.case}/${arm.reverse} item-property parity at tick ${physical.tick}`);
   snapshots++;
  };
  check(raw.initial);
  for (const step of values(raw.steps)) {
   if (previousTick !== undefined) assert.equal(step.tick - previousTick, 1, "non-consecutive callbacks");
   previousTick = step.tick;
   assert.equal(step.before.tick, step.tick); check(step.before);
   if (step.phase === "capture-intact") {
    assert.equal(result.importGroups, true);
    wire = JSON.parse(inflateSync(Buffer.from(raw.payloads[payloadIndex++].encoded, "base64")).toString("utf8"));
    const seen = new Set();
    for (const [index, group] of values(wire).entries()) {
     const members = new Set(values(group.members).map(m => `${fixture.cases[arm.case][m.id - 1].id}:${m.li}`));
     const rows = unique(step.before.rows).filter(row => members.has(`${row.belt}:${row.line}`) && !seen.has(row.uid));
     rows.forEach(row => seen.add(row.uid)); ledger.set(index + 1, rows);
     const quantity = rows => rows.reduce((out, row) => {
      const key = `${row.name}/${row.quality}`; out[key] = (out[key] || 0) + row.count; return out;
     }, {});
     assert.deepEqual(quantity(rows), quantity(values(group.slots).map(s => ({ name: s.n, quality: s.q || "normal", count: s.ct }))), "encoded group quantity mismatch");
    }
    assert.equal(values(step.after.rows).length, 0, "destination not empty");
    assert.deepEqual(values(raw.plan.batches).flatMap(b => values(b.indices)).sort((a,b) => a-b), values(wire).map((_,i) => i+1));
   } else if (step.phase === "restore-groups") {
    assert.equal(result.importGroups, true);
    assert.deepEqual(values(step.indices), values(raw.plan.batches[batchIndex++].indices));
    const sourceRows = values(step.indices).flatMap(i => ledger.get(i));
    const members = new Set(values(step.indices).flatMap(i => values(wire[i - 1].members)
     .map(m => `${fixture.cases[arm.case][m.id - 1].id}:${m.li}`)));
    const beforeIds = new Set(values(step.before.rows).map(row => row.uid));
    const arrivals = unique(step.after.rows).filter(row => !beforeIds.has(row.uid));
    for (const row of arrivals) assert.ok(members.has(`${row.belt}:${row.line}`), "arrival on wrong route/lane");
    assert.deepEqual(count(arrivals, laneKey), count(sourceRows, laneKey), "arrival lane/property mismatch");
    for (const restore of values(step.restores)) {
     assert.equal(restore.success, true); assert.equal(restore.unplaced, 0); assert.equal(restore.anomalies, 0);
     for (const key of ["unmatched", "failed", "merge_discarded", "declined"]) assert.equal(restore.stats[key], 0);
     restoredItems += restore.placed;
    }
    for (const i of values(step.indices)) assert.ok(ledger.delete(i), "duplicate group restore");
   } else if (step.phase === "remove") {
    const ids = values(step.selectedIds), candidate = unique(step.candidate.rows);
    assert.deepEqual(count(candidate), count(unique(values(step.before.rows).filter(row => ids.includes(row.belt)))));
    const wire = JSON.parse(inflateSync(Buffer.from(raw.payloads[payloadIndex++].encoded, "base64")).toString("utf8"));
    const quantity = rows => rows.reduce((out, row) => {
     const key = `${row.name}/${row.quality}`; out[key] = (out[key] || 0) + row.count; return out;
    }, {});
    assert.deepEqual(quantity(values(wire).flatMap(group => values(group.slots).map(slot => ({
     name: slot.n, quality: slot.q || "normal", count: slot.ct,
    })))), quantity(candidate), "encoded capture quantity mismatch");
    for (const id of ids) {
     assert.ok(!ledger.has(id), "duplicate removal");
     ledger.set(id, candidate.filter(row => row.belt === id));
    }
    removed.push(ids);
    for (const deletion of values(step.deletions)) {
     assert.equal(deletion.destroyed, true); assert.equal(deletion.invalid, true);
    }
   } else if (step.phase === "rebuild-inverse") {
    assert.deepEqual(values(step.ids), removed.at(-1));
   } else if (step.phase === "rebuild" && result.sameLane) {
    assert.equal(removed.length, values(raw.groups).length);
   } else if (step.phase === "restore-inverse" || (step.phase === "restore-lane" && result.sameLane)) {
    assert.deepEqual(values(step.ids), result.sameLane ? removed.shift() : removed.pop());
    for (const restore of values(step.restores)) {
     assert.equal(restore.success, true);
     assert.equal(restore.unplaced, 0); assert.equal(restore.anomalies, 0);
     for (const key of ["unmatched", "failed", "merge_discarded", "declined"]) assert.equal(restore.stats[key], 0, key);
     restoredItems += restore.placed;
    }
    for (const id of values(step.ids)) assert.ok(ledger.delete(id), "restoration without capture");
   } else {
    assert.equal(step.phase, "verify"); assert.equal(step.topology, true);
   }
   assert.equal(step.after.tick, step.tick); check(step.after);
  }
  assert.equal(ledger.size, 0); assert.equal(removed.length, 0);
  assert.equal(payloadIndex, values(raw.payloads).length);
  if (result.importGroups) assert.equal(batchIndex, values(raw.plan.batches).length);
  check(raw.final);
  const topology = shape => values(shape).map(({ id, name, direction, position, neighbors, underground }) =>
   ({ id, name, direction, position, neighbors, underground }));
  assert.deepEqual(topology(raw.finalShape), topology(raw.initialShape));
  assert.equal(raw.handlerRestored, true);
  const items = seed.reduce((n, row) => n + row.count, 0);
  assert.equal(restoredItems, items);
  verified.push({ case: arm.case, reverse: arm.reverse, items, snapshots, callbacks: values(raw.steps).length,
   ...(result.importGroups ? { groupBatches: batchIndex, networks: raw.plan.networks, routeChecks: batchIndex } : {}),
   ...(lanes && !flow ? { left: seed.filter(row => side(row) === "left").reduce((n, row) => n + row.count, 0),
    right: seed.filter(row => side(row) === "right").reduce((n, row) => n + row.count, 0) } : {}) });
 }
 for (const host of [1, 2]) {
  const clean = result.cleanup[host];
  for (const key of ["players", "jobs", "locks", "holds", "tombstones"]) assert.equal(clean[key], 0, key);
  assert.equal(clean.paused, false); assert.equal(values(clean.names).length, 0);
  assert.equal(clean.storageAbsent, true); assert.equal(clean.hookAbsent, true);
 }
 return { status: "PASS", hash: result.hash, scope: result.importGroups ? "quantity and properties across callbacks; per-batch arrival route/lane checks on declared fixtures"
  : lanes ? "quantity, item properties and fixture-wide left/right parity; arbitrary route membership not certified"
  : "quantity and item properties; lane parity not certified", verified, totalItems: verified.reduce((n, arm) => n + arm.items, 0) };
}

const path = process.argv.slice(2).find(arg => !arg.startsWith("--")) || "ci-artifacts/belt-remove-inverse-result.json";
assert.ok(fs.statSync(path).size < 8 * 1024 * 1024, "artifact bound");
const result = JSON.parse(fs.readFileSync(path, "utf8"));
console.log(JSON.stringify(verify(result)));
if (process.argv.includes("--self-test")) {
 for (const fault of ["loss", "duplication", "health change"]) {
  const bad = structuredClone(result), raw = bad.runs.find(run => typeof run.reverse === "boolean").raw;
  const pistol = values(raw.final.rows).find(row => row.name === "pistol");
  if (fault === "health change") pistol.properties.health = 0.5;
  else pistol.count += fault === "loss" ? -1 : 1;
  assert.throws(() => verify(bad), undefined, `verifier missed ${fault}`);
 }
 console.log(JSON.stringify({ offlineOracleControls: "PASS", rejected: ["loss", "duplication", "health change"] }));
 if (lanes && !result.importGroups) {
  const bad = structuredClone(result), final = bad.runs.find(run => run.case === "straight").raw.final;
  const id = values(final.rows).find(row => row.name === "pistol").uid;
  for (const row of values(final.rows)) if (row.uid === id) row.line = 2;
  // Update the native counts too: a consistent physical read must still fail for
  // landing on the wrong side, even though total quantities/properties agree.
  for (const native of values(final.nativeCounts)) native.count = values(final.rows)
   .filter(row => row.belt === native.belt && row.line === native.line).reduce((n, row) => n + row.count, 0);
  assert.throws(() => verify(bad), /item-property parity/, "verifier missed wrong-side placement");
  const moved = structuredClone(result);
  for (const arm of moved.runs.filter(run => typeof run.reverse === "boolean")) {
   for (const row of values(arm.raw.final.rows)) row.position = 1 / 64;
  }
  assert.doesNotThrow(() => verify(moved), "same-lane position changes must be allowed");
  console.log(JSON.stringify({ laneOracleControls: "PASS", rejected: "wrong-side placement", accepted: "same-lane position changes" }));
 }
 if (result.importGroups) {
  const bad = structuredClone(result), raw = bad.runs.find(run => typeof run.reverse === "boolean").raw;
  const step = values(raw.steps).find(step => step.phase === "restore-groups" && step.restores[0].placed > 0);
  const before = new Set(values(step.before.rows).map(row => row.uid));
  const arrival = values(step.after.rows).find(row => !before.has(row.uid));
  const uid = arrival.uid;
  for (const row of values(step.after.rows)) if (row.uid === uid) row.line = row.line % 2 ? row.line + 1 : row.line - 1;
  for (const native of values(step.after.nativeCounts)) native.count = values(step.after.rows)
   .filter(row => row.belt === native.belt && row.line === native.line).reduce((n,row) => n + row.count,0);
  assert.throws(() => verify(bad), /route\/lane|lane\/property/, "missed wrong-lane arrival");
  console.log(JSON.stringify({ arrivalOracleControl: "PASS", rejected: "wrong-lane arrival with unchanged total cargo and consistent native counts" }));
 }
}
