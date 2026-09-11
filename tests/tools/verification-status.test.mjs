import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceIdentity, evidenceMatch, candidateIdentity } from "../../tools/shared/verification-evidence.mjs";
import { collectStatus, summarizeChecks, summarizeHeadRuns, formatStatus, latestReport, reviewFindings, parseStatusOptions } from "../../tools/verification-status.mjs";
import { buildFiles, buildIdentity } from "../../tools/release/build-runtime.mjs";
import { stageTimer } from "../../tools/shared/stage-timing.mjs";
import { parseOptions } from "../../tools/verify-workflow.mjs";
import { prepareStartupCase, scenarios, startupRounds } from "../manual/production-profile/startup.mjs";

const head = "a".repeat(40);
const git = (_file, args) => ({ stdout: args[0] === "rev-parse" ? head : args[0] === "ls-files" ? "source.txt\0" : "" });
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "se-verify-status-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("timing records real waits, preserves failures and does not invent unstarted intervals", async () => {
  const records = [], snapshots = []; let clock = 10, utc = 100;
  const timed = stageTimer(records, () => snapshots.push(structuredClone(records)), { clock: () => clock, utc: () => String(utc) });
  await timed("boot", async () => { clock += 7; utc -= 10000; });
  assert.equal(records[0].elapsedMs, 7); assert.equal(records[0].endMs - records[0].startMs, 7);
  await assert.rejects(timed("reconnect", async () => { clock += 3; throw Error("host still connected"); }), /host still connected/);
  assert.equal(records[1].status, "failed"); assert.equal(records[1].elapsedMs, 3);
  assert.equal(records.some(s => s.name === "transfer"), false);
  assert.equal(snapshots[0][0].status, "running"); assert.equal(snapshots[0][0].endMs, undefined);
  await timed("cleanup", async () => { clock += 2; });
  assert.equal(records[2].status, "passed");
  await assert.rejects(timed("boot", async () => {}), /Duplicate/);
});

test("reports with missing, changed or historical identities never match current inputs", t => {
  const root = directory(t); writeFileSync(join(root, "source.txt"), "before");
  const before = sourceIdentity(root, git), report = { finishedAt: "finished", provenance: { source: before, finishedSource: before } };
  assert.equal(evidenceMatch(report, before), "matches recorded inputs");
  writeFileSync(join(root, "source.txt"), "after");
  const after = sourceIdentity(root, git);
  assert.equal(before.head, after.head); assert.notEqual(before.sourceSha256, after.sourceSha256);
  assert.match(evidenceMatch(report, after), /stale/);
  assert.match(evidenceMatch({}, before), /historical/);
  assert.match(evidenceMatch({ provenance: { source: before } }, before), /incomplete/);
  assert.match(evidenceMatch({ ...report, provenance: { source: before, finishedSource: after } }, after), /changed during/);
  const candidate = { manifestSha256: "one", recipeDifferences: [] };
  const bound = { ...report, provenance: { ...report.provenance, candidate } };
  assert.equal(evidenceMatch(bound, before, candidate), "matches recorded inputs");
  assert.match(evidenceMatch(bound, before), /candidate not checked/);
  assert.match(evidenceMatch(bound, before, { ...candidate, manifestSha256: "two" }), /candidate changed/);
  assert.match(evidenceMatch(bound, before, { ...candidate, recipeDifferences: ["start.sh"] }), /recipe changed/);
  rmSync(join(root, "source.txt"));
  assert.notEqual(sourceIdentity(root, git).sourceSha256, after.sourceSha256);
});

test("candidate matching binds all staged build inputs and notices a changed recipe", t => {
  const root = directory(t), staged = join(root, "staged"), production = join(root, "docker/production");
  mkdirSync(staged); mkdirSync(production, { recursive: true });
  for (const file of buildFiles) { writeFileSync(join(staged, file), file); writeFileSync(join(production, file), file); }
  for (const file of ["package.tgz", "gateway.zip"]) writeFileSync(join(staged, file), file);
  const runtime = { images: { controller: "sha256:" + "a".repeat(64), host: "sha256:" + "b".repeat(64) },
    bases: { host: "base-host", controller: "base-controller" }, buildIdentities: {} };
  for (const role of ["controller", "host"]) runtime.buildIdentities[role] = buildIdentity(staged, role, runtime.bases[role]);
  const path = join(staged, "runtime.json"); writeFileSync(path, JSON.stringify(runtime));
  assert.deepEqual(candidateIdentity(path, root).recipeDifferences, []);
  writeFileSync(join(production, "start.sh"), "changed");
  assert.deepEqual(candidateIdentity(path, root).recipeDifferences, ["start.sh"]);
  writeFileSync(join(staged, "gateway.zip"), "changed");
  assert.throws(() => candidateIdentity(path, root), /staged inputs differ/);
});

test("empty, skipped, cancelled, pending and failed CI cannot be summarized as passing", () => {
  assert.equal(summarizeChecks([]).state, "unavailable");
  for (const state of ["SKIPPED", "NEUTRAL", "CANCELLED", "FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]) {
    assert.notEqual(summarizeChecks([{ conclusion: state }]).state, "passing");
  }
  assert.equal(summarizeChecks([{ status: "IN_PROGRESS" }, { conclusion: "SUCCESS" }]).state, "pending");
  assert.equal(summarizeChecks([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }]).state, "passing");
});

test("status surfaces the newest incomplete report and failed substage without rerunning anything", t => {
  const root = directory(t), artifacts = join(root, "ci-artifacts"); writeFileSync(join(root, "source.txt"), "source");
  for (const name of ["verify-1-abc", "verify-2-def"]) mkdirSync(join(artifacts, name), { recursive: true });
  const path = join(artifacts, "verify-2-def/result.json"), child = join(root, "child.json");
  writeFileSync(child, JSON.stringify({ verdict: "FAIL", cleanup: { success: true }, expectedStages: ["startup", "transfer", "cleanup"],
    stages: [{ name: "startup", status: "failed", elapsedMs: 12, error: "connection rejected" }, { name: "cleanup", status: "passed", elapsedMs: 2 }] }));
  writeFileSync(path, JSON.stringify({ stages: [{ name: "acceptance", status: "running" }], acceptanceReport: child }));
  assert.equal(latestReport(artifacts), path);
  const status = collectStatus({ prs: [], "--offline": true }, { directory: root, command: git });
  const text = formatStatus(status);
  assert.equal(status.local.verdict, "incomplete"); assert.match(text, /startup: failed.*connection rejected/);
  assert.match(text, /transfer: not reached, unmeasured/); assert.match(text, /cleanup: passed/);
  writeFileSync(path, "malformed");
  const unavailable = collectStatus({ prs: [], "--offline": true }, { directory: root, command: git });
  assert.ok(unavailable.errors.length); assert.equal(unavailable.local, undefined);
  assert.ok(!formatStatus(unavailable).includes("PASS"));
});

test("PR outages and review declarations cannot become implied approval", t => {
  const root = directory(t); writeFileSync(join(root, "source.txt"), "source");
  const status = collectStatus({ prs: ["312"] }, { directory: root, command: (file, args) => {
    if (file === "gh") throw Error("API unavailable"); return git(file, args);
  } });
  assert.equal(status.prs[0].checks.state, "unavailable"); assert.ok(status.errors.length);
  const path = join(root, "findings.json");
  const finding = { id: "312-1", summary: "Configuration rejected", status: "verified", evidence: ["missing.json"] };
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, findings: [finding] }));
  const declared = reviewFindings(path);
  assert.equal(declared[0].declaredStatus, "verified"); assert.equal(declared[0].evidence[0].available, false);
  assert.match(formatStatus({ ...status, findings: declared }), /verified \(declared\)/);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, findings: [{ ...finding, evidence: [] }] }));
  assert.throws(() => reviewFindings(path), /needs evidence/);
});

test("status and startup options reject contradictory, duplicate or incomplete requests", () => {
  for (const args of [["--pr"], ["--pr", "-1"], ["--offline", "--pr", "312"], ["--json", "--json"], ["--runtime", "--json"]]) {
    assert.throws(() => parseStatusOptions(args));
  }
  assert.deepEqual(parseStatusOptions(["--pr", "312", "--pr", "313"]).prs, ["312", "313"]);
  assert.throws(() => parseOptions(["--startup"]), /Startup needs/);
  assert.equal(parseOptions(["--runtime", "runtime.json", "--startup"])["--startup"], true);
});

test("evidence write failures cannot suppress cleanup or replace the primary operation error", async () => {
  let cleaned = false;
  const stages = [], timed = stageTimer(stages, () => { throw Error("evidence disk full"); });
  await assert.rejects(timed("cleanup", async () => { cleaned = true; }, { alwaysRun: true }), /disk full/);
  assert.equal(cleaned, true); assert.equal(stages[0].status, "passed"); assert.equal(stages[0].evidenceErrors.length, 2);
  const primary = Error("original cleanup failure");
  await assert.rejects(timed("cleanup failed", async () => { throw primary; }, { alwaysRun: true }), error => error === primary);
  let changed = false;
  await assert.rejects(timed("startup", async () => { changed = true; }), /disk full/);
  assert.equal(changed, false);
});

test("live status follows a child pointer before completion and never promotes a premature PASS", t => {
  const root = directory(t); writeFileSync(join(root, "source.txt"), "source");
  const child = join(root, "child.json"), pointer = join(root, "pointer.json"), report = join(root, "result.json");
  writeFileSync(pointer, JSON.stringify({ path: child }));
  writeFileSync(child, JSON.stringify({ verdict: "PASS", stages: [{ name: "cleanup", status: "running" }], expectedStages: ["cleanup"] }));
  writeFileSync(report, JSON.stringify({ stages: [{ name: "startup", status: "running" }], startupPointer: pointer }));
  const status = collectStatus({ prs: [], "--offline": true, "--report": report }, { directory: root, command: git });
  assert.equal(status.startup.verdict, "incomplete"); assert.match(formatStatus(status), /cleanup: running, unmeasured/);
});

test("CI must have a workflow on the exact head and prefer its newest rerun", () => {
  const passed = { workflowName: "CI", headSha: head, status: "completed", conclusion: "success", createdAt: "2026-09-10" };
  assert.equal(summarizeHeadRuns([{ ...passed, headSha: "old" }], head).state, "unavailable");
  assert.equal(summarizeHeadRuns([passed, { ...passed, createdAt: "2026-09-11", conclusion: "", status: "in_progress" }], head).state, "pending");
  assert.equal(summarizeHeadRuns([passed, { ...passed, createdAt: "2026-09-11", conclusion: "failure" }], head).state, "failing");
});

test("paired startup cases cover each scenario once and mutate only a verified owned volume", () => {
  assert.deepEqual(startupRounds.flat(), scenarios);
  const runtime = { images: { host: "sha256:" + "a".repeat(64) } };
  const calls = [], lab = { run: "se-manual-owned-test", config: {
    services: { "host-1": { volumes: [{ target: "/clusterio/data", type: "volume", source: "data1" }] },
      "host-2": { volumes: [{ target: "/clusterio/data", type: "volume", source: "data2" }] } },
    volumes: { data1: { name: "owned-one" }, data2: { name: "owned-two" } },
  }, assertOwned: (kind, name) => calls.push([kind, name]), docker: args => calls.push(args) };
  prepareStartupCase(lab, runtime, "missing config", 2);
  assert.deepEqual(calls[0], ["volume", "owned-two"]);
  assert.ok(calls[1].includes("type=volume,src=owned-two,dst=/clusterio/data"));
  assert.ok(!calls[1].join(" ").includes("owned-one"));
  lab.assertOwned = () => { throw Error("foreign volume"); };
  assert.throws(() => prepareStartupCase(lab, runtime, "restart", 1), /foreign volume/);
  assert.equal(calls.length, 2);
  assert.throws(() => prepareStartupCase(lab, runtime, "restart", 3));
});
