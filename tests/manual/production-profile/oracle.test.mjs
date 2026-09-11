import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeProfile, profileVerdict } from "./oracle.mjs";

const fixture = () => JSON.parse(readFileSync(new URL("./evidence/accepted-0.10.281.json", import.meta.url)));
test("retained production profile passes the independent recovery and deployment oracle", () => {
  assert.equal(analyzeProfile(fixture()).verdict, "PASS");
});
test("missing settings, wrong images, extra plugins and missing persistent stores cannot pass", () => {
  for (const mutate of [
    r => delete r.hostSettings,
    r => r.controllerLocalSettings["controller.allow_remote_updates"] = true,
    r => r.containers[0].image = "sha256:" + "0".repeat(64),
    r => r.containers[0].registration.push(["subspace_storage", "@clusterio/subspace_storage"]),
    r => r.containers[0].mounts = r.containers[0].mounts.filter(m => m.destination !== "/clusterio/mods"),
    r => delete r.settings[r.instances[0].name]["surface_export.debug_mode"],
    r => r.settings[r.instances[0].name]["factorio.settings"].auto_pause = true,
  ]) { const report = fixture(); mutate(report); assert.throws(() => analyzeProfile(report)); }
});
test("cargo differences remain STOP even when the UI and cleanup say success", () => {
  const report = fixture(); report.recovery.samples.at(-1).destination.cargo.entities.pop();
  assert.equal(analyzeProfile(report).verdict, "STOP");
});
test("repeated imports, missing recreation history, missing assets and failed cleanup cannot pass", () => {
  for (const mutate of [
    r => r.recovery.events[2].push(r.recovery.events[2].find(e => e.kind === "call" && e.action === "import")),
    r => delete r.recreatedController,
    r => delete r.retainedOutcome,
    r => r.browser.assets = r.browser.assets.filter(a => !a.png),
    r => r.browser.assets = r.browser.assets.filter(a => !/locale/.test(a.name)),
    r => r.cleanup.success = false,
  ]) { const report = fixture(); mutate(report); assert.throws(() => analyzeProfile(report)); }
});

test("each independent route, node, history and asset assertion rejects contrary evidence", () => {
  for (const mutate of [
    r => r.browser.gatewayRoutes.pop(),
    r => r.browser.visibleGateways.push("old_gateway"),
    r => r.browser.nodes.pop(),
    r => r.browser.nodes[0].id = "wrong-instance",
    r => r.recreatedController.after = r.recreatedController.after.split(" ")[0] + " wrong-image",
    r => r.retainedOutcome.transferId = "unrelated-transfer",
    r => r.browser.pageErrors.push("module failed"),
    r => r.browser.failedResponses.push({ status: 404 }),
    r => r.browser.assets = r.browser.assets.filter(a => !/metadata/.test(a.name)),
    r => r.browser.assets = r.browser.assets.filter(a => a.name !== "prototypes"),
    r => r.containers[0].mounts.push({ type: "bind", destination: "/clusterio/node_modules/plugin" }),
  ]) { const report = fixture(); mutate(report); assert.throws(() => analyzeProfile(report)); }
});

test("current acceptance requires a normal transfer without startup instrumentation", () => {
  const report = fixture(); report.schemaVersion = 2;
  assert.equal(profileVerdict(report).verdict, "FAIL");
  report.normal = { before: report.recovery.before, samples: report.recovery.samples.slice(-2),
    outcome: report.recovery.outcome, transferId: report.recovery.transferId };
  for (const c of report.containers) { c.instrumented = false; c.mounts = c.mounts.filter(m => m.destination !== "/lab"); }
  assert.equal(profileVerdict(report).verdict, "PASS");
  report.stages = [{ name: "normal transfer", status: "passed", startMs: 7, endMs: 23, elapsedMs: 16 }];
  assert.equal(profileVerdict(report).verdict, "PASS");
  report.containers[1].instrumented = true;
  assert.equal(profileVerdict(report).verdict, "FAIL");
});

test("ordinary acceptance failures stay FAIL and observed cargo violations take precedence", () => {
  const report = fixture(); report.error = "host startup timed out";
  assert.equal(profileVerdict(report).verdict, "FAIL");
  report.cleanup.success = false;
  report.recovery.samples.at(-1).destination.cargo.entities.pop();
  assert.equal(profileVerdict(report).verdict, "STOP");
});
