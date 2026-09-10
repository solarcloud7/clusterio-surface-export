import assert from "node:assert/strict";
import { analyze } from "../transfer-reliability/oracle.mjs";
import { settings } from "../../../docker/production/provision.mjs";

export function analyzeProfile(report) {
  assert.equal(report.schemaVersion, 1);
  assert.ok(!report.error, report.error);
  assert.equal(report.cleanup?.success, true);
  const result = analyze(report.recovery);
  if (result.verdict === "STOP") return result;
  assert.equal(report.containers?.length, 3);
  for (const c of report.containers) {
    assert.equal(c.image, report.runtime.images[c.name === "controller" ? "controller" : "host"]);
    assert.deepEqual(c.registration, [["surface_export", "@solarcloud7/plugin-surface-export"]]);
    assert.ok(c.hashes.includes(report.runtime.accepted.sha256));
    assert.ok(c.hashes.includes(report.runtime.gatewaySha256));
    assert.ok(c.mounts.every(m => !["/clusterio", "/clusterio/node_modules", "/clusterio/external_plugins"].includes(m.destination)));
    for (const path of ["/clusterio/data", "/clusterio/mods", "/clusterio/logs", "/clusterio/tokens"])
      assert.ok(c.mounts.some(m => m.type === "volume" && m.destination === path), `missing persistent ${path}`);
    if (c.name === "controller") assert.ok(c.mounts.some(m => m.type === "volume" && m.destination === "/clusterio/static"));
    else assert.ok(c.mounts.some(m => m.destination === "/opt/factorio-client" && m.type === "volume" && !m.writable));
  }
  assert.equal(report.instances?.length, 2);
  assert.equal(new Set(report.instances.map(i => i.id)).size, 2);
  assert.deepEqual(report.controllerSettings, settings.controller);
  assert.deepEqual(report.controllerLocalSettings, settings.controllerLocal);
  for (const n of [1, 2]) assert.deepEqual(report.hostSettings[n], settings.host);
  for (const instance of report.instances) for (const [key, value] of Object.entries(settings.instance).filter(([k]) => k.startsWith("surface_export.")))
    assert.equal(report.settings[instance.name][key], value);
  for (const instance of report.instances) {
    const game = report.settings[instance.name]["factorio.settings"];
    assert.deepEqual(game.visibility, { public: false, lan: false });
    assert.equal(game.require_user_verification, true);
    assert.equal(game.autosave_interval, 5);
    assert.equal(game.auto_pause, false);
  }
  assert.equal(report.browser?.success, true);
  const recreated = report.recreatedController;
  assert.notEqual(recreated.before.split(" ")[0], recreated.after.split(" ")[0]);
  assert.equal(recreated.after.split(" ")[1], report.runtime.images.controller);
  assert.equal(report.retainedOutcome?.status, "completed");
  assert.equal(report.retainedOutcome.transferId, report.recovery.transferId);
  assert.equal(report.browser.transferVisible, true);
  assert.deepEqual(report.browser.pageErrors, []);
  assert.deepEqual(report.browser.failedResponses, []);
  assert.equal(report.browser.nodes.length, 2);
  assert.deepEqual(report.browser.nodes.map(n => n.id).sort(), report.instances.map(i => `instance:${i.id}`).sort());
  assert.deepEqual(report.browser.visibleGateways, ["surfexp_gateway_hub"]);
  assert.deepEqual(report.browser.gatewayRoutes, ["aquilo", "fulgora", "gleba", "nauvis", "vulcanus"]);
  for (const asset of report.browser.assets) { assert.equal(asset.status, 200); assert.ok(asset.bytes > 0); }
  assert.ok(report.browser.assets.some(a => a.png && a.status === 200));
  assert.ok(report.browser.assets.some(a => /locale/.test(a.name) && a.entries > 0 && a.status === 200));
  assert.ok(report.browser.assets.some(a => /metadata/.test(a.name) && a.entries > 0 && a.status === 200));
  assert.ok(report.browser.assets.some(a => a.name === "prototypes" && a.entries > 0 && a.status === 200));
  return result;
}
