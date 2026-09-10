import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeProfile } from "./oracle.mjs";

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
