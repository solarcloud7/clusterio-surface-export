import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { ProductionLab } from "./lab.mjs";
import { ROOT } from "../transfer-reliability/docker-lab.mjs";
import { readTable } from "../../../docker/production/cli-table.mjs";
import { stageTimer } from "../../../tools/shared/stage-timing.mjs";
import { withWorkflowLock } from "../../../tools/shared/workflow-lock.mjs";
import { sourceIdentity, candidateIdentity } from "../../../tools/shared/verification-evidence.mjs";

export const contract = { requires: ["candidate runtime", "Docker"],
  produces: ["native startup and config regeneration observations", "owned cleanup evidence"],
  "does not": ["create Factorio worlds", "load a licensed client", "claim which token-reset branch executed"] };
export const scenarios = ["restart", "missing config", "malformed token", "mismatched token"];
export const startupRounds = [["restart", "missing config"], ["malformed token", "mismatched token"]];

export function prepareStartupCase(lab, runtime, scenario, n) {
  assert.ok(scenarios.includes(scenario));
  assert.ok([1, 2].includes(n));
  const mount = lab.config.services[`host-${n}`].volumes.find(v => v.target === "/clusterio/data");
  assert.ok(mount && mount.type === "volume");
  const volume = lab.config.volumes[mount.source].name;
  lab.assertOwned("volume", volume);
  const name = `${lab.run}-prepare-${scenarios.indexOf(scenario)}-${n}`;
  const script = `const fs=require('node:fs');const {execFileSync}=require('node:child_process');
    const path='/clusterio/data/config-host.json';const scenario=process.argv[1];
    const assert=require('node:assert/strict'),configuration=require('/release/configure.cjs');
    const cli=args=>execFileSync('/clusterio/node_modules/.bin/clusteriohost',
      ['--log-level','error','--config',path,'config',...args],{encoding:'utf8',stdio:'pipe',timeout:30000});
    if(scenario==='missing config'){fs.unlinkSync(path);assert.equal(fs.existsSync(path),false);}
    else {
      const fields=Object.keys(configuration.settingsForRole('host'));
      for(const field of fields)cli(['set',field,'true']);
      if(scenario==='malformed token')cli(['set','host.controller_token','invalid']);
      if(scenario==='mismatched token')cli(['set','host.controller_token','header.payload.signature']);
      const wanted={...Object.fromEntries(fields.map(field=>[field,true])),
        ...(scenario==='malformed token'?{'host.controller_token':'invalid'}:{}),
        ...(scenario==='mismatched token'?{'host.controller_token':'header.payload.signature'}:{})};
      assert.deepEqual(configuration.readSettings(cli(['list']),Object.keys(wanted)),wanted);
    }`;
  lab.docker(["run", "--name", name, "--label", `surface-export.manual-run=${lab.run}`, "--network", "none",
    "--user", "clusterio", "--mount", `type=volume,src=${volume},dst=/clusterio/data`, "--entrypoint", "node",
    runtime.images.host, "-e", script, scenario], { timeout: 90000 });
}

export async function runStartup(runtimePath, pointer) {
  return withWorkflowLock(async () => {
    const runtime = JSON.parse(readFileSync(runtimePath));
    const run = `se-manual-startup-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const directory = join(ROOT, "ci-artifacts", run); mkdirSync(directory, { recursive: true });
    const lab = new ProductionLab(run, directory);
    const path = join(directory, "result.json");
    const report = { schemaVersion: 1, run, startedAt: new Date().toISOString(), runtime,
      provenance: { source: sourceIdentity(ROOT), candidate: candidateIdentity(runtimePath, ROOT) },
      expectedStages: ["first boot", ...startupRounds.map(round => round.join(" / ")), "cleanup"],
      stages: [], observations: [], cleanup: { success: false } };
    const save = () => writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
    const stage = stageTimer(report.stages, save);
    if (pointer) writeFileSync(pointer, JSON.stringify({ path }) + "\n");
    const interrupt = () => { lab.cancelled = true; };
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    const inspect = async cases => {
      await lab.until(() => [1, 2].every(n => readTable(lab.ctl("host", "list"))
        .some(h => h.name === lab.hosts[n].host && h.connected === "true")), "both hosts connected", 90);
      assert.deepEqual(readTable(lab.ctl("instance", "list")), [], "startup smoke test must have no instances");
      const settings = { controller: lab.localSettings("controller", lab.controller),
        hosts: [1, 2].map(n => lab.localSettings("host", lab.hosts[n].container)) };
      report.observations.push({ cases, connectedHosts: 2, instances: 0, settings });
    };
    try {
      assert.deepEqual(report.provenance.candidate.recipeDifferences, [], "candidate image recipe differs from checkout");
      await stage("first boot", async () => { await lab.boot(runtime); await inspect(["first boot", "first boot"]); });
      for (const cases of startupRounds) await stage(cases.join(" / "), async () => {
        await lab.stopHosts();
        for (const n of [1, 2]) prepareStartupCase(lab, runtime, cases[n - 1], n);
        lab.docker(["compose", "-f", lab.composeFile, "start", "--wait", "--wait-timeout", "120", "host-1", "host-2"], { timeout: 150000 });
        await inspect(cases);
      });
    } catch (error) { report.error = error.message; }
    finally {
      try { await stage("cleanup", async () => { report.cleanup = await lab.cleanup(); assert.equal(report.cleanup.success, true); }, { alwaysRun: true }); }
      catch (error) { report.cleanupError = error.message; }
      try {
        report.provenance.finishedSource = sourceIdentity(ROOT);
        assert.deepEqual(report.provenance.finishedSource, report.provenance.source, "checkout changed during startup test");
      } catch (error) { report.identityError = error.message; }
      report.verdict = report.error || report.cleanupError || report.identityError ? "FAIL" : "PASS";
      process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
      report.finishedAt = new Date().toISOString(); save();
    }
    return { path, verdict: report.verdict, error: report.error, cleanup: report.cleanup.success };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [runtime, flag, pointer, ...rest] = process.argv.slice(2);
  assert.ok(runtime && (!flag || (flag === "--report-pointer" && pointer && !rest.length)), "startup.mjs <runtime.json> [--report-pointer path]");
  const result = await runStartup(resolve(runtime), pointer);
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.verdict === "PASS" ? 0 : 1;
}
