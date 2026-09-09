import test from "node:test";
import assert from "node:assert/strict";
import { analyze, expectedCargo } from "./oracle.mjs";

function state(tick = 1) {
  return { present: true, index: 12, surface: 4, tick, platformHidden: false, surfaceHidden: false,
    travelPaused: true, locked: false, held: false, canary: { active: true, disabled: false },
    usable: true, cargo: structuredClone(expectedCargo) };
}
function report() {
  return { schemaVersion: 1,
    baseline: { before: state(), after: { source: { present: false, tick: 4 }, destination: state(2) },
      outcome: { status: "completed" } },
    fault: { before: state(), injection: { calls: [state(2)] }, outcome: { status: "cleanup_failed" },
      samples: [
        { source: state(100), destination: state(3) },
        { source: state(105), destination: state(4) },
      ] },
  };
}

test("two physical copies fail regardless of controller status or travel pause", () => {
  for (const status of ["completed", "cleanup_failed", "failed"]) {
    const r = report(); r.fault.outcome.status = status;
    assert.equal(analyze(r).verdict, "STOP");
    assert.deepEqual(analyze(r).violations, ["two usable copies remain"]);
  }
});

test("a held destination with intact cargo passes the bounded safety invariant", () => {
  const r = report();
  for (const sample of r.fault.samples) {
    sample.destination.held = true; sample.destination.usable = false;
  }
  assert.equal(analyze(r).verdict, "PASS");
});

test("missing reads, missing activation fields, and forged usable flags are not passes", () => {
  for (const mutate of [
    s => { delete s.present; }, s => { delete s.canary.active; },
    s => { s.usable = false; }, s => { delete s.cargo.lanes; },
  ]) {
    const r = report(); mutate(r.fault.samples[0].destination);
    assert.throws(() => analyze(r));
  }
});

test("item quality, belt side, and fluid changes are product failures", () => {
  for (const mutate of [
    c => { c.inventories["steel-chest@8.5,4.5:1"]["iron-plate/rare"]--; },
    c => { c.lanes["transport-belt@-7.5,5.5:1"] = { "iron-plate/normal": 0 }; },
    c => { c.fluids["storage-tank@-7.5,0.5"].amount++; },
  ]) {
    const r = report(); mutate(r.fault.samples[0].destination.cargo);
    assert.ok(analyze(r).violations.includes("physical cargo changed"));
  }
});

test("losing both copies is a failure even without duplicate activation", () => {
  const r = report();
  r.fault.samples = [1, 2].map(tick => ({ source: { present: false, tick }, destination: { present: false, tick } }));
  assert.deepEqual(analyze(r).violations, ["no recoverable copy remains"]);
});

test("a vacuous or symmetrically corrupted fixture cannot establish a valid control", () => {
  const r = report();
  r.baseline.before.cargo = r.baseline.after.destination.cargo = {};
  assert.throws(() => analyze(r), /physical|construction contract/);
});

test("an untriggered or misdirected deletion fault cannot establish reproduction", () => {
  const missing = report(); missing.fault.injection.calls = [];
  assert.throws(() => analyze(missing), /never fired/);
  const wrong = report(); wrong.fault.injection.calls[0].surface++;
  assert.throws(() => analyze(wrong), /different surface/);
});

test("each clock must advance, but clocks on different hosts need not align", () => {
  assert.equal(analyze(report()).verdict, "STOP");
  const r = report(); r.fault.samples[1].destination.tick = r.fault.samples[0].destination.tick;
  assert.throws(() => analyze(r), /destination did not advance/);
});

test("empty hub contract rejects starter cargo on either physical copy", () => {
  const r = report(); r.fixture = "empty-hub";
  const states = [r.baseline.before, r.baseline.after.destination, r.fault.before,
    ...r.fault.samples.flatMap(s => [s.source, s.destination])];
  for (const s of states) s.cargo.inventories["space-platform-hub@0,0:1"] = {};
  for (const sample of r.fault.samples) {
    sample.destination.held = true; sample.destination.usable = false;
  }
  assert.equal(analyze(r).verdict, "PASS");
  r.baseline.after.destination.cargo.inventories["space-platform-hub@0,0:1"] = { "space-platform-foundation/normal": 10 };
  assert.throws(() => analyze(r), /baseline physical cargo differs/);
});
