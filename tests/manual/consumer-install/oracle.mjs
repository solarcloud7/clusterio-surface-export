import assert from "node:assert/strict";
import { analyze } from "../transfer-reliability/oracle.mjs";
import { verifyGatewayMap } from "../../../tools/surface-export/check-gateway-map.mjs";

export function analyzeConsumer(report) {
  assert.equal(report.schemaVersion, 1);
  assert.ok(!report.error, "harness failure recorded");
  assert.equal(report.cleanup?.success, true, "cleanup unproven");
  const install = report.installation;
  assert.equal(install?.success, true);
  assert.equal(install.installer, "2.0.0-alpha.27");
  assert.equal(install.unprivileged, true);
  assert.equal(install.runScripts, true);
  assert.match(install.engine, /^Version: 2\.1\.17 .*linux64, full/);
  for (const name of ["controller", "host", "ctl", "lib"]) assert.equal(install.peers[name], "2.0.0-alpha.27");
  assert.ok(install.registration.some(([name, path]) => name === "surface_export" && path === "@solarcloud7/plugin-surface-export"));
  for (const name of ["package", "gateway", "runner", "lab", "bootstrap"]) assert.match(report.hashes[name], /^[a-f0-9]{64}$/);
  assert.deepEqual(report.freshSaves.map(s => s.host).sort(), [1, 2]);
  for (const save of report.freshSaves) assert.equal(save.method, "instance save create");
  assert.equal(report.gatewayMaps.length, 2);
  assert.equal(new Set(report.gatewayMaps.map(s => s.instanceId)).size, 2);
  assert.deepEqual(report.gatewayMaps.map(s => s.instanceId).sort(), report.freshSaves.map(s => s.instanceId).sort());
  for (const state of report.gatewayMaps) {
    assert.equal(state.layout, "one_gate"); verifyGatewayMap(state, { version: "0.6.5" });
  }
  const b = report.browser;
  assert.equal(b?.success, true, "browser acceptance incomplete");
  assert.equal(b.nodes.length, 2);
  assert.equal(new Set(b.nodes.map(n => n.id)).size, 2);
  assert.deepEqual(b.nodes.map(n => n.id).sort(), report.freshSaves.map(s => `instance:${s.instanceId}`).sort());
  assert.deepEqual(b.pageErrors, []); assert.deepEqual(b.failedResponses, []);
  assert.deepEqual(b.visibleGateways, ["surfexp_gateway_hub"]);
  assert.deepEqual(b.gatewayRoutes, ["aquilo", "fulgora", "gleba", "nauvis", "vulcanus"]);
  for (const asset of b.assets) { assert.equal(asset.status, 200); assert.ok(asset.bytes > 0); assert.match(asset.sha256, /^[a-f0-9]{64}$/); }
  assert.ok(b.assets.some(a => /locale/.test(a.name) && a.entries > 0));
  assert.ok(b.assets.some(a => /metadata/.test(a.name) && a.entries > 0));
  assert.ok(b.assets.some(a => a.png));
  assert.ok(b.assets.some(a => a.name === "prototypes" && a.entries > 0));
  assert.equal(b.transferVisible, true);
  assert.equal(report.controllerCrash.signal, "SIGKILL");
  assert.equal(report.controllerCrash.restartMethod, "upstream run-controller.sh");
  assert.ok(report.controllerCrash.pid > 1 && report.controllerCrash.restartedPid > report.controllerCrash.pid);
  assert.equal(report.recovery.case, "lost-source-reply");
  return analyze(report.recovery);
}
