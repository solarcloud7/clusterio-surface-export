import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeConsumer } from "./oracle.mjs";
import { ConsumerLab } from "./lab.mjs";

const observed = JSON.parse(readFileSync(new URL("./evidence/accepted-0.10.281.json", import.meta.url)));

test("retained upstream consumer install passes independent offline acceptance", () => {
  assert.equal(analyzeConsumer(observed).verdict, "PASS");
});

test("consumer acceptance refuses missing installation, game, asset, browser and crash evidence", () => {
  for (const mutate of [r => r.installation.success = false, r => r.installation.unprivileged = false,
    r => r.installation.peers.host = "wrong", r => r.installation.registration = [],
    r => r.freshSaves.pop(), r => r.gatewayMaps.pop(), r => r.gatewayMaps[0].instanceId = 999,
    r => r.installation.engine = "headless", r => r.recovery.case = "lost-destination-reply",
    r => delete r.gatewayMaps[0].routes.surfexp_gateway_link_hub_aquilo,
    r => r.browser.nodes = [], r => r.browser.nodes[0].id = "instance:999", r => r.browser.success = false, r => r.browser.pageErrors.push("module failed"),
    r => r.browser.failedResponses.push({ status: 404 }), r => r.browser.assets = [],
    r => r.browser.assets[0].bytes = 0, r => r.browser.assets.find(a => a.name === "locale").entries = 0,
    r => r.browser.assets.find(a => a.png).png = false, r => r.browser.transferVisible = false,
    r => r.controllerCrash.restartedPid = r.controllerCrash.pid]) {
    const r = structuredClone(observed); mutate(r); assert.throws(() => analyzeConsumer(r));
  }
});

test("consumer acceptance retains cargo, no-replay, real-retry and cleanup requirements", () => {
  let r = structuredClone(observed); r.recovery.samples.at(-1).destination.cargo.entities.pop();
  assert.equal(analyzeConsumer(r).verdict, "STOP");
  r = structuredClone(observed); r.recovery.events[2].push(r.recovery.events[2].find(e => e.action === "import" && e.kind === "call"));
  assert.throws(() => analyzeConsumer(r), /exactly one/);
  r = structuredClone(observed); r.recovery.events[1] = r.recovery.events[1].filter(e => e.kind !== "call");
  assert.throws(() => analyzeConsumer(r), /retry/);
  r = structuredClone(observed); r.cleanup.success = false; assert.throws(() => analyzeConsumer(r), /cleanup/);
  r = structuredClone(observed); r.recovery.cleanup.success = false; assert.throws(() => analyzeConsumer(r), /cleanup/);
});

test("consumer process interruption checks ownership before executing SIGKILL", () => {
  const lab = new ConsumerLab("se-manual-test-12345678", "unused");
  const calls = [];
  lab.docker = (...args) => { calls.push(args); return '{"pid":7,"signal":"SIGKILL"}'; };
  lab.assertOwned = () => { throw new Error("foreign owner"); };
  assert.throws(() => lab.mutateContainer("kill", lab.controller, ["--signal", "KILL"]), /foreign owner/);
  assert.equal(calls.length, 0);
  lab.assertOwned = (kind, name) => { assert.equal(kind, "container"); assert.equal(name, lab.controller); };
  lab.mutateContainer("kill", lab.controller, ["--signal", "KILL"]);
  assert.equal(lab.controllerCrash.pid, 7);
  assert.match(calls[0][0].at(-1), /process\.kill\(pid,'SIGKILL'\)/);
  assert.equal(lab.mutateContainer("start", lab.controller), "upstream run-controller.sh restarts the killed child");
  assert.equal(calls.length, 1, "restart must use upstream supervisor, not delete its lock");
});

test("retained setup failures and intentional abort have verified cleanup, never PASS", () => {
  const failures = JSON.parse(readFileSync(new URL("./evidence/setup-failures.json", import.meta.url)));
  const abort = JSON.parse(readFileSync(new URL("./evidence/cleanup-proof.json", import.meta.url)));
  assert.match(failures[0].rawLog, /Missing required dependency recycler >= 2\.1\.0/);
  assert.match(failures[1].interactiveStderrExcerpt, /LockFileExistsError/);
  for (const r of [...failures, abort]) {
    assert.equal(r.cleanup.success, true); assert.equal(r.verdict, "HARNESS_ERROR");
    assert.throws(() => analyzeConsumer(r));
  }
  assert.equal(abort.installation.success, true);
  assert.match(abort.error, /Intentional post-installer failure/);
});
