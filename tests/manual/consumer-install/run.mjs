import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { withWorkflowLock } from "../../../tools/shared/workflow-lock.mjs";
import { ROOT, hash } from "../transfer-reliability/docker-lab.mjs";
import { ConsumerLab } from "./lab.mjs";
import { recoveryCase } from "../transfer-reliability/cases.mjs";
import { browserAcceptance } from "./browser.mjs";
import { analyzeConsumer } from "./oracle.mjs";

const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
if (args[0] === "--analyze" && args.length === 2) {
  try {
    const result = analyzeConsumer(JSON.parse(readFileSync(args[1])));
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.verdict === "PASS" ? 0 : 2;
  } catch (error) { console.error(`HARNESS_ERROR: ${error.message}`); process.exitCode = 1; }
} else if (!args.includes("--run") && !args.includes("--cleanup-proof")) {
  console.log("node tests/manual/consumer-install/run.mjs --run|--cleanup-proof --package <tarball> --gateway-zip <zip> --client-volume <existing-client-volume>");
  if (args.length && !["--help", "-h"].includes(args[0])) process.exitCode = 1;
} else await withWorkflowLock(async () => {
  assert.ok(args.length === 7 && ["--run", "--cleanup-proof"].includes(args[0]), "expected exactly one mode and three input options");
  for (const key of ["--package", "--gateway-zip", "--client-volume"])
    assert.ok(args.filter(a => a === key).length === 1 && option(key) && !option(key).startsWith("--"), `${key} required exactly once`);
  const run = `se-manual-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const directory = join(ROOT, "ci-artifacts", run), inputs = join(directory, "inputs"); mkdirSync(inputs, { recursive: true });
  copyFileSync(resolve(option("--package")), join(inputs, "package.tgz"));
  copyFileSync(resolve(option("--gateway-zip")), join(inputs, "gateway.zip"));
  const lab = new ConsumerLab(run, directory);
  const report = { schemaVersion: 1, run, startedAt: new Date().toISOString(), verdict: "HARNESS_ERROR", cleanup: { success: false },
    hashes: { package: hash(join(inputs, "package.tgz")), gateway: hash(join(inputs, "gateway.zip")),
      runner: hash(new URL(import.meta.url)), lab: hash(new URL("./lab.mjs", import.meta.url)), bootstrap: hash(new URL("./bootstrap.mjs", import.meta.url)) } };
  for (const file of ["browser.mjs", "oracle.mjs", "../transfer-reliability/docker-lab.mjs", "../transfer-reliability/cases.mjs",
    "../transfer-reliability/fault-hook.cjs", "../transfer-reliability/oracle.mjs", "../../integration/transfer-cleanup/probe.lua"])
    report.hashes[file] = hash(new URL(file, import.meta.url));
  const save = () => writeFileSync(join(directory, "result.json"), JSON.stringify(report, null, 2) + "\n");
  const interrupt = () => { lab.cancelled = true; }; process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    console.log(`Consumer install acceptance: ${run}`); save();
    report.installation = await lab.install(inputs, option("--client-volume")); save();
    if (args.includes("--cleanup-proof")) throw new Error("Intentional post-installer failure; verify cleanup");
    lab.deadline = Date.now() + 600_000;
    await lab.start();
    report.freshSaves = lab.freshSaves; report.modPackId = lab.modPackId; report.exportDetails = lab.exportDetails; report.gatewayMaps = lab.gatewayMaps; save();
    report.recovery = { schemaVersion: 1, case: "lost-source-reply", run,
      contract: JSON.parse(readFileSync(new URL("../transfer-reliability/contract.json", import.meta.url))) };
    console.log("Fresh instances ready; testing physical cargo and recovery after a lost reply");
    await recoveryCase(lab, report.recovery, save);
    report.controllerCrash = { ...lab.controllerCrash,
      restartedPid: Number(lab.docker(["exec", lab.controller, "cat", "/consumer/config-controller.json.lock"]).trim()),
      restartMethod: "upstream run-controller.sh" };
    assert.notEqual(report.controllerCrash.restartedPid, report.controllerCrash.pid, "controller process did not restart");
    console.log("Checking authenticated browser and real exported assets");
    await browserAcceptance(lab, report); save();
  } catch (error) { report.error = error.stack; }
  finally {
    report.freshSaves = lab.freshSaves || []; report.modPackId = lab.modPackId; report.exportDetails = lab.exportDetails; report.gatewayMaps = lab.gatewayMaps;
    report.cleanup = await lab.cleanup(); report.finishedAt = new Date().toISOString();
    if (report.recovery) report.recovery.cleanup = report.cleanup;
    if (!report.error) try { Object.assign(report, analyzeConsumer(report)); } catch (error) { report.error = error.stack; report.verdict = "HARNESS_ERROR"; }
    save();
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    console.log(JSON.stringify({ verdict: report.verdict, error: report.error, cleanup: report.cleanup.success, artifact: join(directory, "result.json") }, null, 2));
    process.exitCode = report.verdict === "PASS" ? 0 : report.verdict === "STOP" ? 2 : 1;
  }
});
