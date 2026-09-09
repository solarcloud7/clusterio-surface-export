import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

// Literal construction contract, independent of export/validation summaries.
export const expectedCargo = {
  inventories: {
    "space-platform-hub@0,0:1": { "space-platform-foundation/normal": 10 },
    "space-platform-hub@0,0:2": {},
    "assembling-machine-1@8.5,0.5:2": {},
    "assembling-machine-1@8.5,0.5:3": {},
    "assembling-machine-1@8.5,0.5:4": {},
    "assembling-machine-1@8.5,0.5:8": {},
    "steel-chest@8.5,4.5:1": { "iron-plate/rare": 17, "copper-plate/normal": 23 },
  },
  lanes: {
    "transport-belt@-7.5,5.5:1": { "iron-plate/normal": 1 },
    "transport-belt@-7.5,5.5:2": { "copper-plate/rare": 1 },
    "transport-belt@-5.5,5.5:1": { "iron-plate/rare": 1 },
    "transport-belt@-5.5,5.5:2": { "copper-plate/normal": 1 },
  },
  fluids: { "storage-tank@-7.5,0.5": { name: "water", amount: 123, temperature: 15 } },
  entities: ["assembling-machine-1@8.5,0.5", "space-platform-hub@0,0", "steel-chest@8.5,4.5",
    "storage-tank@-7.5,0.5", "transport-belt@-5.5,5.5", "transport-belt@-7.5,5.5"],
};

function usable(state) {
  assert.equal(typeof state?.present, "boolean", "missing observation is not absence");
  assert.ok(Number.isSafeInteger(state.tick) && state.tick >= 0, "missing local tick");
  if (!state.present) return false;
  for (const value of [state.platformHidden, state.surfaceHidden, state.locked, state.held,
    state.canary?.active, state.canary?.disabled]) {
    assert.equal(typeof value, "boolean", "missing usability evidence");
  }
  for (const key of ["inventories", "lanes", "fluids", "entities"]) {
    assert.ok(state.cargo?.[key] && typeof state.cargo[key] === "object", "missing physical " + key);
  }
  const result = !state.platformHidden && !state.surfaceHidden && !state.locked && !state.held
    && state.canary.active && !state.canary.disabled;
  assert.equal(state.usable, result, "derived usability disagrees with raw evidence");
  return result;
}

// Pure analysis: never imports a cluster helper or accepts its verdict as physical evidence.
export function analyze(report) {
  assert.equal(report.schemaVersion, 1);
  assert.ok(report.fixture === undefined || ["starter-hub", "empty-hub", "large"].includes(report.fixture), "unknown fixture contract");
  const cargo = structuredClone(expectedCargo);
  if (report.fixture === "empty-hub") cargo.inventories["space-platform-hub@0,0:1"] = {};
  if (report.fixture === "large") {
    for (let x = 16; x <= 35; x++) for (let y = 16; y <= 35; y++) {
      const key = `steel-chest@${x + 0.5},${y + 0.5}`;
      cargo.entities.push(key);
      cargo.inventories[`${key}:1`] = { "iron-plate/rare": 1176 };
    }
    for (let x = -60; x <= -41; x++) for (let y = 16; y <= 35; y++) {
      const key = `transport-belt@${x + 0.5},${2 * y - 32 + 0.5}`;
      cargo.entities.push(key);
      cargo.lanes[`${key}:1`] = { "iron-plate/normal": 1 };
      cargo.lanes[`${key}:2`] = { "copper-plate/rare": 1 };
    }
    cargo.entities.sort();
    const tiles = [];
    for (let x = -64; x < 64; x++) for (let y = -64; y < 64; y++) tiles.push(`space-platform-foundation@${x},${y}`);
    tiles.sort();
    for (const leg of [report.baseline, report.fault]) {
      assert.deepEqual(leg.tilesBefore, tiles, "large fixture tile construction differs from contract");
      assert.deepEqual(leg.tilesAfter, tiles, "large fixture tiles changed during transfer");
    }
  }
  const { baseline, fault } = report;
  assert.ok(usable(baseline.before), "baseline source must be usable");
  assert.deepEqual(baseline.before.cargo, cargo, "fixture differs from literal construction contract");
  usable(baseline.after.source);
  assert.equal(baseline.after.source.present, false, "baseline source was not deleted");
  assert.ok(usable(baseline.after.destination), "baseline destination is not usable");
  assert.deepEqual(baseline.after.destination.cargo, cargo, "baseline physical cargo differs");
  assert.equal(baseline.outcome.status, "completed", "baseline did not settle successfully");
  assert.ok(usable(fault.before), "fault source must start usable");
  assert.deepEqual(fault.before.cargo, cargo, "fault fixture differs from construction contract");
  assert.ok(Array.isArray(fault.injection.calls) && fault.injection.calls.length > 0, "deletion fault never fired");
  for (const call of fault.injection.calls) {
    usable(call);
    assert.equal(call.index, fault.before.index, "fault hit a different platform");
    assert.equal(call.surface, fault.before.surface, "fault hit a different surface");
  }
  assert.ok(fault.samples.length >= 2, "need repeated physical observations");
  const violations = new Set();
  for (const [index, sample] of fault.samples.entries()) {
    const sourceUsable = usable(sample.source), destinationUsable = usable(sample.destination);
    for (const side of ["source", "destination"]) {
      const state = sample[side];
      if (index) assert.ok(state.tick > fault.samples[index - 1][side].tick, side + " did not advance");
      if (state.present && !isDeepStrictEqual(state.cargo, cargo)) violations.add("physical cargo changed");
    }
    if (!sample.source.present && !sample.destination.present) violations.add("no recoverable copy remains");
    if (sourceUsable && destinationUsable) violations.add("two usable copies remain");
  }
  return { verdict: violations.size ? "STOP" : "PASS", invariant: "at-most-one-usable-copy-with-cargo-parity",
    violations: [...violations],
    reason: violations.size ? [...violations].join("; ")
      : "No invariant violation observed at the tested deletion failure boundary.",
    notTested: ["process crashes", "lost acknowledgements", "TTL expiry", "message replay", "older-save restoration"] };
}
