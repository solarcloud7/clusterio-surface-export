// requires: pinned Docker images, isolated built package, seed with a saved player
// produces: offline passenger evacuation, inventory and save/reload observations
// does not: simulate a client disconnect or modify the development cluster
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { DockerLab, ROOT, hash } from "./docker-lab.mjs";
import { runLab } from "./lifecycle.mjs";
import { withWorkflowLock } from "../../../tools/shared/workflow-lock.mjs";

const { values } = parseArgs({ options: { "package-dir": { type: "string" }, analyze: { type: "string" } } });
function analyze(report) {
  assert.equal(report.engine, "2.1.17");
  assert.equal(report.arms.length, 2);
  assert.deepEqual(report.arms.map(arm => arm.remote_view), [false, true]);
  for (const arm of report.arms) {
    assert.equal(arm.result, "SUCCESS");
    assert.equal(arm.connected, false);
    assert.equal(arm.detected, 1);
    assert.equal(arm.characters, 0);
    assert.equal(arm.character_logged_off, true);
    assert.equal(arm.physical_after, "nauvis");
    assert.equal(arm.platform_remaining, false);
    assert.equal(arm.surface_remaining, false);
    assert.equal(arm.lock_remaining, false);
    assert.deepEqual(arm.after, arm.before);
  }
  assert.equal(report.cleanup.success, true);
  return { verdict: "PASS" };
}
if (values.analyze) {
  console.log(JSON.stringify(analyze(JSON.parse(readFileSync(values.analyze, "utf8")))));
} else {
  assert.ok(values["package-dir"], "--package-dir is required");
  await withWorkflowLock(async () => {
    const run = `se-manual-offline-${randomUUID().slice(0,8)}`;
    const directory = join(ROOT, "ci-artifacts", run);
    mkdirSync(directory, {recursive:true});
    const lab = new DockerLab(run, directory, {packageDirectory:values["package-dir"]});
    const fixture = join(ROOT, "tests/manual/transfer-reliability/offline-evacuation.lua");
    const code = readFileSync(fixture, "utf8");
    const report = {run, fixture:hash(fixture), arms:[],
      invariant:"Offline passengers and exact inventory survive source deletion after save/reload.",
      bounds:{startupSeconds:600,acceptanceSeconds:300,rconBytes:32768},
      limitations:["Uses a saved offline LuaPlayer; no live network disconnect or reconnect is exercised."]};
    const save = () => writeFileSync(join(directory, "result.json"), JSON.stringify(report, null, 2));
    const probe = (action, name, remoteView) => lab.lua(1,
      `return (function() ${code} end)()('${action}','${name}',${remoteView})`).result;
    process.exitCode = await runLab({lab, report, save, analyze, work:async () => {
      report.environment = await lab.setup(); save();
      lab.deadline = Date.now() + 300_000;
      report.engine = lab.lua(1, "return {success=true,engine=script.active_mods.base}").result.engine;
      for (const remoteView of [false, true]) {
        const name = `${run}-${remoteView ? "remote" : "character"}`;
        report.prepared = probe("prepare", name, remoteView); save();
        assert.equal(report.prepared.connected, false);
        report.beforeSave = probe("inspect", name, remoteView); save();
        const checkpoint = `manual-offline-${remoteView ? "remote" : "character"}`;
        report.checkpoint = await lab.checkpoint(checkpoint, [1]); save();
        await lab.load(1, checkpoint);
        report.afterLoad = probe("inspect", name, remoteView); save();
        report.arms.push(probe("delete", name, remoteView)); save();
      }
    }});
    console.log(JSON.stringify({verdict:report.verdict,error:report.error,cleanup:report.cleanup.success,
      artifact:join(directory,"result.json")}, null, 2));
  });
}
