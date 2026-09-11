import assert from "node:assert/strict";
import { expectedCargo } from "../../integration/transfer-cleanup/oracle.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withWorkflowLock } from "../../../tools/shared/workflow-lock.mjs";
import { ROOT, hash } from "../transfer-reliability/docker-lab.mjs";
import { recoveryCase, summary, sample, start, terminal } from "../transfer-reliability/cases.mjs";
import { evaluateCopies } from "../transfer-reliability/oracle.mjs";
import { browserAcceptance } from "../consumer-install/browser.mjs";
import { ProductionLab } from "./lab.mjs";
import { profileVerdict } from "./oracle.mjs";
import { stageTimer } from "../../../tools/shared/stage-timing.mjs";
import { restoreProduction } from "./restore.mjs";

const [mode, input, client, ...extra] = process.argv.slice(2);
if (mode === "--analyze") {
  const result = profileVerdict(JSON.parse(readFileSync(input)));
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.verdict === "PASS" ? 0 : 2;
} else if (!["--run", "--cleanup-proof"].includes(mode) || !client
  || (extra.length && (extra.length !== 2 || extra[0] !== "--report-pointer" || !extra[1]))) {
  console.log("run.mjs --run|--cleanup-proof <runtime.json> <existing-client-volume> | --analyze <result.json>");
  process.exitCode = 1;
} else await withWorkflowLock(async () => {
  const runtime = JSON.parse(readFileSync(input));
  const run = `se-manual-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const directory = join(ROOT, "ci-artifacts", run); mkdirSync(directory, { recursive: true });
  const lab = new ProductionLab(run, directory);
  const report = { schemaVersion: 3, run, startedAt: new Date().toISOString(), runtime, cleanup: { success: false }, hashes: {},
    expectedStages: ["startup", "world creation and assets", "normal transfer", "complete deployment restore", "enable recovery faults", "lost-reply recovery",
      "controller recreation", "retained history", "browser and assets", "cleanup"], stages: [] };
  for (const file of ["docker/production/compose.yml", "docker/production/settings.json", "docker/production/provision.mjs",
    "tests/manual/production-profile/lab.mjs", "tests/manual/production-profile/run.mjs", "tests/manual/production-profile/oracle.mjs", "tests/manual/production-profile/restore.mjs",
    "tests/manual/transfer-reliability/backup-storage.mjs",
    "tests/manual/transfer-reliability/cases.mjs", "tests/manual/transfer-reliability/fault-hook.cjs", "tests/integration/transfer-cleanup/probe.lua"])
    report.hashes[file] = hash(join(ROOT, file));
  const save = () => writeFileSync(join(directory, "result.json"), JSON.stringify(report, null, 2) + "\n");
  const stage = stageTimer(report.stages, save);
  if (extra[1]) writeFileSync(extra[1], JSON.stringify({ path: join(directory, "result.json") }) + "\n");
  const interrupt = () => { lab.cancelled = true; }; process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    console.log(`Production profile acceptance: ${run}`); save();
    await stage("startup", async () => { await lab.boot(runtime, client); report.containers = lab.runtime; });
    if (mode === "--cleanup-proof") throw new Error("Intentional post-start failure; verify cleanup.success");
    console.log("Profile startup verified; creating fresh worlds and exporting game assets");
    await stage("world creation and assets", async () => {
      await lab.createWorlds(); report.instances = lab.instances; report.settings = lab.observedSettings; report.gatewayMaps = lab.gatewayMaps;
      report.hostSettings = lab.hostSettings; report.controllerSettings = lab.controllerSettings;
      report.controllerLocalSettings = lab.controllerLocalSettings;
    });
    lab.deadline = Date.now() + 600_000;
    console.log("Testing normal startup and transfer without fault hooks");
    await stage("normal transfer", async () => {
      const name = "transfer-cleanup-" + run + "-normal";
      report.normal = { name, before: lab.probe(1, "build", name).state };
      assert.deepEqual(report.normal.before.cargo, expectedCargo);
      report.normal.transferId = start(lab, name); save();
      report.normal.outcome = await terminal(lab, report.normal.transferId);
      report.normal.samples = [sample(lab, name), sample(lab, name)]; save();
      assert.equal(evaluateCopies(report.normal.before, report.normal.samples).verdict, "PASS");
      assert.equal(report.normal.samples.at(-1).source.present, false);
      assert.equal(report.normal.samples.at(-1).destination.usable, true);
      if (report.normal.outcome.status !== "completed") throw new Error("Normal transfer did not complete");
    });
    await stage("complete deployment restore", () => restoreProduction(lab,report,save));
    console.log("Complete deployment restored; restarting owned hosts with recovery fault hooks");
    await stage("enable recovery faults", () => lab.enableFaults());
    report.recovery = { schemaVersion: 1, case: "lost-source-reply", run,
      contract: JSON.parse(readFileSync(new URL("../transfer-reliability/contract.json", import.meta.url))) };
    console.log("Settings verified; testing physical cargo and lost-reply recovery");
    await stage("lost-reply recovery", () => recoveryCase(lab, report.recovery, save));
    console.log("Recovery completed; recreating the controller from the same image");
    await stage("controller recreation", async () => { report.recreatedController = await lab.recreateController(); });
    await stage("retained history", async () => {
      report.recovery.samples.push({ source: lab.probe(1, "read", report.recovery.name).state,
        destination: lab.probe(2, "read", report.recovery.name).state });
      report.recovery.events = { 1: lab.events(1), 2: lab.events(2) };
      report.retainedOutcome = summary(lab, report.recovery.transferId);
    });
    console.log("Checking retained history, authenticated browser and exported assets");
    await stage("browser and assets", () => browserAcceptance(lab, report));
  } catch (error) { report.error = error.stack; }
  finally {
    try {
      await stage("cleanup", async () => {
        report.cleanup = await lab.cleanup();
        assert.equal(report.cleanup.success, true, JSON.stringify(report.cleanup.errors));
      }, { alwaysRun: true });
    } catch (error) { report.cleanupError = error.message; report.error ??= error.stack; }
    report.finishedAt = new Date().toISOString();
    if (report.recovery) report.recovery.cleanup = report.cleanup;
    Object.assign(report, profileVerdict(report));
    save(); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    console.log(JSON.stringify({ verdict: report.verdict, reason: report.reason, error: report.error,
      cleanup: report.cleanup.success, artifact: join(directory, "result.json") }, null, 2));
    process.exitCode = report.verdict === "PASS" ? 0 : report.verdict === "STOP" ? 2 : 1;
  }
});
