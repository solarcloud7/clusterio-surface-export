import assert from "node:assert/strict";
import { analyze } from "../transfer-reliability/oracle.mjs";
import { verifyGatewayMap } from "../../../tools/surface-export/check-gateway-map.mjs";

const HUB_PLANETS_BEFORE_0_7 = ["nauvis", "vulcanus", "gleba", "fulgora", "aquilo"];
const PORTALS = [1, 2, 3, 4].map(i => `surfexp_gateway_${i}`);

export const beforePortals = version => /^0\.[0-6]\./.test(version);

export function expectedGatewayPrototypes(version) {
  if (beforePortals(version)) return { visibleGateways: ["surfexp_gateway_hub"], gatewayRoutes: [...HUB_PLANETS_BEFORE_0_7].sort() };
  return { visibleGateways: [...PORTALS, "surfexp_gateway_hub"].sort(), gatewayRoutes: ["nauvis"] };
}

export function analyzeConsumer(report) {
  assert.equal(report.schemaVersion, 1);
  assert.ok(!report.error, "harness failure recorded");
  assert.equal(report.cleanup?.success, true, "cleanup unproven");
  const install = report.installation;
  assert.equal(install?.success, true);
  const clusterioVersion=install.runtime?.clusterioVersion ?? "2.0.0-alpha.27";
  assert.equal(install.installer, clusterioVersion);
  assert.equal(install.unprivileged, true);
  assert.equal(install.runScripts, true);
  assert.equal(install.engine.match(/^Version: (\d+\.\d+\.\d+) /)?.[1], install.runtime?.factorioVersion ?? "2.1.17");
  assert.match(install.engine, /linux64, full/);
  if(install.runtime) assert.equal(install.packageVersion,install.runtime.pluginVersion);
  for (const name of ["controller", "host", "ctl", "lib"]) assert.equal(install.peers[name], clusterioVersion);
  assert.ok(install.registration.some(([name, path]) => name === "surface_export" && path === "@solarcloud7/plugin-surface-export"));
  for (const name of ["package", "gateway", "runner", "lab", "bootstrap"]) assert.match(report.hashes[name], /^[a-f0-9]{64}$/);
  assert.deepEqual(report.freshSaves.map(s => s.host).sort(), [1, 2]);
  for (const save of report.freshSaves) assert.equal(save.method, "instance save create");
  assert.equal(report.gatewayMaps.length, 2);
  assert.equal(new Set(report.gatewayMaps.map(s => s.instanceId)).size, 2);
  assert.deepEqual(report.gatewayMaps.map(s => s.instanceId).sort(), report.freshSaves.map(s => s.instanceId).sort());
  const gatewayVersion = install.runtime?.gatewayVersion ?? "0.6.5";
  const legacy = beforePortals(gatewayVersion);
  for (const state of report.gatewayMaps)
    verifyGatewayMap(state, { version: gatewayVersion, hubPlanets: legacy ? HUB_PLANETS_BEFORE_0_7 : undefined, hiddenPortals: legacy });
  const b = report.browser;
  assert.equal(b?.success, true, "browser acceptance incomplete");
  assert.equal(b.nodes.length, 2);
  assert.equal(new Set(b.nodes.map(n => n.id)).size, 2);
  assert.deepEqual(b.nodes.map(n => n.id).sort(), report.freshSaves.map(s => `instance:${s.instanceId}`).sort());
  assert.deepEqual(b.pageErrors, []); assert.deepEqual(b.failedResponses, []);
  const prototypes = expectedGatewayPrototypes(gatewayVersion);
  assert.deepEqual(b.visibleGateways, prototypes.visibleGateways);
  assert.deepEqual(b.gatewayRoutes, prototypes.gatewayRoutes);
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
