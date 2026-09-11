import assert from "node:assert/strict";
import { analyze, evaluateCopies } from "../transfer-reliability/oracle.mjs";
import { settings } from "../../../docker/production/provision.mjs";

import { preservesInstalledCode } from "./mounts.mjs";
import { expectedCargo } from "../../integration/transfer-cleanup/oracle.mjs";
import { PRODUCTION_VOLUME_SUFFIXES, archiveLimit } from "../transfer-reliability/backup-storage.mjs";

export function analyzeProfile(report) {
  assert.ok([1, 2, 3].includes(report.schemaVersion));
  for (const r of [report.normal, report.recovery, report.restoration && {
    before: report.normal?.before, samples: [report.restoration.physical, report.restoration.after].filter(Boolean),
  }]) if (r?.before && r.samples?.length) {
    const copies = evaluateCopies(r.before, r.samples, 1);
    if (copies.verdict === "STOP") return copies;
  }
  assert.ok(!report.error, report.error);
  assert.equal(report.cleanup?.success, true);
  const result = analyze(report.recovery);
  if (result.verdict === "STOP") return result;
  if (report.schemaVersion >= 2) {
    assert.deepEqual(report.normal?.before?.cargo, expectedCargo);
    assert.equal(report.normal.outcome?.status, "completed");
    assert.equal(report.normal.outcome.transferId, report.normal.transferId);
    assert.ok(report.normal.samples.length >= 2);
    for (const sample of report.normal.samples) {
      assert.equal(sample.source.present, false);
      assert.equal(sample.destination.usable, true);
    }
    assert.ok(report.containers.every(c => c.instrumented === false && !c.mounts.some(m => m.destination === "/lab")));
  }
  assert.equal(report.containers?.length, 3);
  for (const c of report.containers) {
    assert.equal(c.image, report.runtime.images[c.name === "controller" ? "controller" : "host"]);
    assert.deepEqual(c.registration, [["surface_export", "@solarcloud7/plugin-surface-export"]]);
    assert.ok(c.hashes.includes(report.runtime.accepted.sha256));
    assert.ok(c.hashes.includes(report.runtime.gatewaySha256));
    assert.ok(c.mounts.every(preservesInstalledCode));
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
  if(report.schemaVersion >= 3) {
    const restore=report.restoration;
    for(const entries of [restore?.archives,restore?.restored]) {
      assert.deepEqual(entries?.map(e=>e.suffix).sort(),[...PRODUCTION_VOLUME_SUFFIXES].sort(),"incomplete deployment backup");
      for(const entry of entries) {assert.equal(entry.compared,true);assert.match(entry.sha256,/^[a-f0-9]{64}$/);}
    }
    for(const key of PRODUCTION_VOLUME_SUFFIXES) {
      const archive=restore.archives.find(e=>e.suffix===key);
      assert.ok(Number.isSafeInteger(archive.bytes) && archive.bytes>0 && archive.bytes<=archiveLimit("production",key));
      assert.notEqual(restore.sourceVolumes[key],restore.targetVolumes[key]);
      assert.equal(restore.archives.find(e=>e.suffix===key).sha256,restore.restored.find(e=>e.suffix===key).sha256);
    }
    assert.equal(restore.authenticationAfter,restore.authenticationBefore);assert.match(restore.authenticationAfter,/^[a-f0-9]{64}$/);
    assert.deepEqual(restore.physical?.destination.cargo,expectedCargo);assert.equal(restore.physical?.destination.usable,true);
    assert.equal(restore.physical.source.present,false);
    assert.equal(restore.history?.status,"completed");assert.equal(restore.outcome?.status,"completed");
    assert.equal(restore.history.transferId,report.normal.transferId);
    assert.equal(restore.outcome.transferId,restore.transferId);
    assert.equal(restore.after?.source.present,false);assert.equal(restore.after?.destination.usable,true);
    assert.deepEqual(restore.after.destination.cargo,expectedCargo);assert.equal(restore.browser?.success,true);
    assert.deepEqual(restore.browser.pageErrors,[]);assert.deepEqual(restore.browser.failedResponses,[]);
    for(const key of ["assets","visibleGateways","gatewayRoutes"]) assert.deepEqual(restore.browser[key],report.browser[key]);
    assert.deepEqual(restore.browser.nodes.map(node=>node.id).sort(),report.browser.nodes.map(node=>node.id).sort());
    assert.deepEqual(restore.localSettings,{controller:report.controllerLocalSettings,host1:report.hostSettings[1],host2:report.hostSettings[2]});
    assert.equal(restore.settingsBrowser?.success,true);
  }
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

export function profileVerdict(report) {
  try { return analyzeProfile(report); }
  catch (error) { return { verdict: error instanceof assert.AssertionError || report.error ? "FAIL" : "HARNESS_ERROR",
    reason: error.message }; }
}
