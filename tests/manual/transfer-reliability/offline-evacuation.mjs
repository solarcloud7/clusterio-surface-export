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
  assert.equal(report.engine, report.environment?.runtime?.factorioVersion ?? "2.1.17");
  assert.equal(report.arms.length, 2);
  assert.deepEqual(report.arms.map(arm => arm.remote_view), [false, true]);
  assert.deepEqual(report.arms.map(arm => arm.in_hub), [false, false]);
  for (const arm of report.arms) {
    assert.equal(arm.result, "SUCCESS");
    assert.equal(arm.connected, false);
    assert.equal(arm.detected, 1);
    assert.equal(arm.characters, 0);
    assert.equal(arm.character_logged_off, true);
    assert.equal(arm.physical_after, "nauvis");
    assert.equal(arm.deletion.platform_remaining, false);
    assert.equal(arm.deletion.surface_remaining, false);
    assert.equal(arm.deletion.lock_remaining, false);
    assert.ok(arm.deletion.tick > arm.tick);
    assert.equal(arm.inventory.inventory_available, true);
    assert.equal(arm.inventory.connected, false);
    assert.equal(arm.inventory.physical, "nauvis");
    assert.deepEqual(arm.inventory.after, arm.before);
    assert.equal(arm.afterReload.connected, false);
    assert.equal(arm.afterReload.physical, "nauvis");
    assert.deepEqual(arm.afterReload.after, arm.before);
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
      limitations:["Uses a saved offline LuaPlayer; no live network disconnect or reconnect is exercised.",
        "Hub-seat occupancy is not exercised; enter_space_platform refused the offline fixture player."]};
    const save = () => writeFileSync(join(directory, "result.json"), JSON.stringify(report, null, 2));
    const probe = (action, name, remoteView) => lab.lua(1,
      `return (function() ${code} end)()('${action}','${name}',${remoteView})`).result;
    process.exitCode = await runLab({lab, report, save, analyze, work:async () => {
      report.environment = await lab.setup(); save();
      lab.deadline = Date.now() + 300_000;
      report.engine = lab.lua(1, "return {success=true,engine=script.active_mods.base}").result.engine;
      for (const mode of ["character", "remote"]) {
        const remoteView = mode !== "character";
        const name = `${run}-${mode}`;
        report.prepared = probe("prepare", name, remoteView); save();
        assert.equal(report.prepared.connected, false);
        report.beforeSave = probe("inspect", name, remoteView); save();
        const checkpoint = `manual-offline-${mode}`;
        report.checkpoint = await lab.checkpoint(checkpoint, [1]); save();
        await lab.load(1, checkpoint);
        report.afterLoad = probe("inspect", name, remoteView); save();
        const arm = probe("delete", name, remoteView);
        report.arms.push(arm); save();
        assert.equal(arm.result, "SUCCESS");
        assert.equal(arm.physical_after, "nauvis");
        await lab.until(() => {
          arm.deletion = probe("observe-deletion", name, remoteView); save();
          return arm.deletion.tick > arm.tick && !arm.deletion.platform_remaining && !arm.deletion.surface_remaining;
        }, "source platform removed after evacuation", 20);
        arm.inventory = probe("inventory-after", name, remoteView); save();
        assert.equal(arm.inventory.inventory_available, true);
        assert.deepEqual(arm.inventory.after, arm.before);
        arm.returnCheckpoint = await lab.checkpoint(`manual-return-${mode}`, [1]); save();
        await lab.load(1, `manual-return-${mode}`);
        arm.afterReload = probe("inventory-after", name, remoteView); save();
        probe("finish", name, remoteView);
      }
    }});
    console.log(JSON.stringify({verdict:report.verdict,error:report.error,cleanup:report.cleanup.success,
      artifact:join(directory,"result.json")}, null, 2));
  });
}
