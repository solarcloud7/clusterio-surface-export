import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { analyze } from "./oracle.mjs";

const args = process.argv.slice(2);
if (args[0] === "--analyze") {
  let result;
  try {
    const report = JSON.parse(readFileSync(args[1], "utf8"));
    assert.equal(report.cleanup?.success, true, "cleanup not proven");
    result = analyze(report);
  } catch (error) {
    result = { verdict: "HARNESS_ERROR", error: error.message };
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.verdict === "PASS" ? 0 : 1;
} else {
  assert.ok(args.every(arg => ["--fail-after-build", "--empty-hub-control", "--restart-controller", "--profile-callbacks"].includes(arg)), "unknown option");
  assert.ok(!(args.includes("--profile-callbacks") && args.includes("--restart-controller")), "profile and restart are separate fixtures");
  const { withWorkflowLock } = await import("../../../tools/shared/workflow-lock.mjs");
  const { docker, HOSTS, instanceIds, preflightState, assertLeaseClean, fetchTransferSummaries, sleep } =
    await import("../../lab-gallery/batch-lifecycle.mjs");
  const code = readFileSync(new URL("./probe.lua", import.meta.url), "utf8");
  const prefix = `transfer-cleanup-${Date.now().toString(36)}`;
  const artifact = `ci-artifacts/${prefix}.json`;
  const report = { schemaVersion: 1, name: prefix, versions: {}, sourceHashes: {}, cleanup: {} };
  const profiling = args.includes("--profile-callbacks");
  const profileCode = profiling ? readFileSync(new URL("../../instruments/callback-profile/probe.lua", import.meta.url), "utf8") : "";
  if (profiling) {
    report.callbackProfile = { readings: [], cleanup: {}, limitations: [
      "Temporary six-entity fixture; not a production workload benchmark.",
      "Whole scheduler callback elapsed time; includes nested stage instrumentation, not exclusive CPU time.",
      "Import/export setup in RCON handlers is outside the scheduler callback.",
      "At most 64 callbacks per instance; truncation prevents a complete-run maximum claim.",
    ] };
    report.sourceHashes["callback-profile/probe.lua"] = createHash("sha256").update(profileCode).digest("hex");
  }
  report.fixture = args.includes("--empty-hub-control") ? "empty-hub" : "starter-hub";
  for (const path of ["probe.lua", "oracle.mjs", "delete-failure.mjs", "README.md"]) {
    report.sourceHashes[path] = createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex");
  }
  report.implementationHashes = {};
  for (const path of ["controller.ts", "lib/transfer-orchestrator.ts", "lib/lua-interface.ts", "instance.ts", "messages.ts",
    "module/core/import-completion.lua", "module/core/import-pipeline.lua", "module/core/destination-hold.lua", "module/import_phases/latch_rearm.lua",
    "module/interfaces/remote/delete-platform-for-transfer.lua", "module/interfaces/remote/destination-hold.lua",
    "module/utils/game-utils.lua", "module/utils/version-compat.lua", "module/utils/transfer-receipts.lua"]) {
    report.implementationHashes[path] = createHash("sha256").update(readFileSync(
      new URL("../../../docker/seed-data/external_plugins/surface_export/" + path, import.meta.url))).digest("hex");
  }
  const names = [], worlds = {};
  let armed;
  function lua(host, body) {
    const cmd = `/sc local ok,result=pcall(function() ${body} end); rcon.print(helpers.table_to_json(ok and result or {success=false,error=tostring(result)}))`;
    assert.ok(Buffer.byteLength(cmd) <= 32768, "RCON command exceeds contract");
    const raw = docker(["exec", "surface-export-controller", "npx", "clusterioctl", "--log-level", "error",
      "--config", "/clusterio/tokens/config-control.json", "instance", "send-rcon", HOSTS[host].instance, cmd],
    { timeout: 20_000, maxBuffer: profiling ? 262144 : 65536 });
    if (profiling) for (const line of raw.split(/\r?\n/)) {
      const marker = line.indexOf("[SE_CALLBACK_V1]");
      if (marker < 0) continue;
      const [json, profiler] = line.slice(marker + "[SE_CALLBACK_V1]".length).split("\t");
      const { parseProfiler } = createRequire(import.meta.url)("../../../docker/seed-data/external_plugins/surface_export/dist/node/lib/timing.js");
      const executionMs = parseProfiler(profiler || "");
      assert.ok(executionMs !== null, "callback profiler reading unavailable");
      report.callbackProfile.readings.push({ instance: host, ...JSON.parse(json), executionMs, raw: line });
    }
    const result = JSON.parse(raw.trim().split(/\r?\n/).at(-1));
    assert.equal(result.success, true, result.error || "Lua command failed");
    return result;
  }
  const probe = (host, action, name) => lua(host, `local probe=(function() ${code} end)(); return probe('${action}','${name}')`);
  function save() { mkdirSync("ci-artifacts", { recursive: true }); writeFileSync(artifact, JSON.stringify(report, null, 2) + "\n"); }
  async function until(read, label, seconds = 90) {
    const deadline = Date.now() + seconds * 1000;
    for (let poll = 0; poll < 60 && Date.now() < deadline; poll++) {
      const result = read(); if (result) return result;
      await sleep(500);
    }
    throw new Error(`Deadline exceeded: ${label}`);
  }
  await withWorkflowLock(async () => {
    try {
      for (const host of [1, 2]) {
        assertLeaseClean(host, preflightState(host), "transfer-cleanup preflight");
        const world = probe(host, "world", prefix);
        assert.equal(world.engine, "2.1.17", "re-certify for the new engine pin");
        report.versions[host] = world;
        worlds[host] = world.world;
        if (profiling) lua(host, `local profile=(function() ${profileCode} end)();return profile('arm','${prefix}')`);
      }
      const ids = instanceIds();
      for (const kind of ["baseline", "fault"]) {
        const name = `${prefix}-${kind}`;
        names.push(name); // Own cleanup even if construction fails halfway.
        const leg = report[kind] = { name };
        leg.before = probe(1, args.includes("--empty-hub-control") ? "build-empty" : "build", name).state;
        assert.equal(leg.before.usable, true, "fixture is not initially usable");
        if (args.includes("--fail-after-build")) throw new Error("Injected harness failure after construction");
        if (kind === "fault") { armed = name; probe(1, "arm", name); }
        const start = lua(1, `local p; for _,candidate in pairs(game.forces.player.platforms) do
          if candidate.name=='${name}' then assert(not p);p=candidate end end
          assert(p); local trigger=assert(package.loaded['__level__/modules/surface_export/core/transfer-trigger.lua'])
          local job,err=trigger.start(game.forces.player,p.index,${ids[2]});assert(job,err)
          return {success=true,job=job}`);
        leg.transferId = `${ids[1]}:${start.job}`;
        leg.outcome = await until(() => {
          const rows = fetchTransferSummaries({ limit: 200 });
          assert.ok(rows, "transfer registry unavailable");
          return rows.find(row => row.transferId === leg.transferId && ["completed", "failed", "error", "cleanup_failed"].includes(row.status));
        }, "exact operation terminal outcome");
        const sample = () => ({ source: probe(1, "read", name).state, destination: probe(2, "read", name).state });
        if (kind === "baseline") {
          leg.after = sample();
          assert.equal(leg.outcome.status, "completed", `control transfer failed: ${leg.outcome.error || "see recorded outcome"}`);
          assert.equal(leg.after.source.present, false);
          assert.equal(leg.after.destination.usable, true);
          assert.deepEqual(leg.after.destination.cargo, leg.before.cargo, "control cargo changed");
          leg.replay = {
            source: lua(1, `local remove=assert(package.loaded['__level__/modules/surface_export/interfaces/remote/delete-platform-for-transfer.lua'])
              local result=remove(${leg.before.index},'${name}','player','${start.job}')
              return {success=result=='SUCCESS',result=result}`),
            destination: lua(2, `local holds=assert(package.loaded['__level__/modules/surface_export/core/destination-hold.lua'])
              local ok,result=holds.go_live('${leg.transferId}');return {success=ok==true,result=result}`),
          };
          leg.afterReplay = sample();
          assert.equal(leg.afterReplay.source.present, false, "replay recreated the source");
          assert.equal(leg.afterReplay.destination.usable, true, "replay changed destination usability");
          assert.deepEqual(leg.afterReplay.destination.cargo, leg.before.cargo, "replay changed destination cargo");
        } else {
          leg.injection = probe(1, "fault", name);
          leg.samples = [sample()];
          await sleep(500);
          leg.samples.push(sample());
          assert.ok(leg.samples[1].source.tick > leg.samples[0].source.tick, "source did not advance");
          assert.ok(leg.samples[1].destination.tick > leg.samples[0].destination.tick, "destination did not advance");
          {
            assert.equal(leg.samples[1].source.locked, true, "restart requires a retained source lock");
            assert.equal(leg.samples[1].destination.held, true, "restart requires a held destination");
            report.disarm = probe(1, "disarm", armed);
            armed = undefined;
            // Restart the coordinator; Factorio worlds keep running and postflight checks their identities.
            if (args.includes("--restart-controller")) {
              report.restart = { kind: "controller", output: docker(["restart", "surface-export-controller"], { timeout: 60_000 }) };
            }
            save();
            leg.recoveryOutcome = await until(() => fetchTransferSummaries({ limit: 200 })?.find(row =>
              row.transferId === leg.transferId && row.status === "completed"), "automatic recovery after restart");
            leg.afterRestart = sample();
            assert.equal(leg.afterRestart.source.present, false, "recovery did not remove the exact source");
            assert.equal(leg.afterRestart.destination.usable, true, "recovery did not release the destination");
            assert.deepEqual(leg.afterRestart.destination.cargo, leg.before.cargo, "recovery changed destination cargo");
            leg.samples.push(leg.afterRestart);
          }
        }
        save();
        console.log(`${kind}: ${leg.transferId} -> ${leg.outcome.status}${leg.recoveryOutcome ? ` -> recovered ${leg.recoveryOutcome.status}` : ""}`);
      }
      Object.assign(report, analyze(report));
    } catch (error) {
      report.verdict = "HARNESS_ERROR";
      report.error = error.stack;
    } finally {
      const errors = [];
      if (profiling) for (const host of [1, 2]) {
        try { if (worlds[host]) report.callbackProfile.cleanup[host] = lua(host, `local profile=(function() ${profileCode} end)();return profile('disarm','${prefix}')`); }
        catch (error) { errors.push(`callback profiler disarm ${host}: ${error.message}`); }
      }
      if (profiling) report.callbackProfile.maximumByInstance = Object.fromEntries([1, 2].map(host => {
        const readings = report.callbackProfile.readings.filter(record => record.instance === host);
        return [host, { samples: readings.length, truncated: report.callbackProfile.cleanup[host]?.truncated,
          maximumExecutionMs: readings.length ? Math.max(...readings.map(record => record.executionMs)) : null }];
      }));
      try { if (armed) report.disarm = probe(1, "disarm", armed); }
      catch (error) { errors.push(`disarm: ${error.message}`); }
      for (const host of [1, 2]) {
        try {
          if (!worlds[host]) continue; // Never touch a host whose preflight did not pass.
          await until(() => preflightState(host).jobs === 0, "jobs drain before cleanup", 30);
          for (const name of names) {
            probe(host, "cleanup", name);
            await until(() => !probe(host, "exists", name).present, "fixture surface removal", 15);
          }
          const state = preflightState(host);
          assertLeaseClean(host, state, "transfer-cleanup postflight");
          const world = probe(host, "world", prefix);
          assert.deepEqual(world.world, worlds[host], "pre-existing platform identities changed");
          report.cleanup[host] = { success: true, state, world: world.world };
        } catch (error) { errors.push(`host ${host}: ${error.message}`); }
      }
      report.cleanup.success = errors.length === 0 && Object.keys(worlds).length === 2;
      report.cleanup.errors = errors;
      if (!report.cleanup.success) report.verdict = "HARNESS_ERROR";
      save();
      console.log(JSON.stringify({ verdict: report.verdict, reason: report.reason, error: report.error,
        cleanup: report.cleanup.success, artifact }, null, 2));
      process.exitCode = report.verdict === "PASS" ? 0 : 1;
    }
  });
}
