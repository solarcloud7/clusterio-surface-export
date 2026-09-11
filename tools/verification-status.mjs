import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sourceIdentity, candidateIdentity, evidenceMatch } from "./shared/verification-evidence.mjs";
import { runCommand } from "./shared/command-evidence.mjs";
import { redactDiagnostic } from "./shared/diagnostics.mjs";

export const contract = { requires: ["local verification reports", "gh authentication for PR checks"],
  produces: ["current PR checks", "recorded local results and input comparison", "declared review dispositions"],
  "does not": ["rerun tests", "approve reviews", "merge PRs", "inspect the live deployment"] };
const root = fileURLToPath(new URL("../", import.meta.url));
const read = path => JSON.parse(readFileSync(path, "utf8"));
const message = error => redactDiagnostic(error.message).slice(-1200);

export function parseStatusOptions(args) {
  const options = { prs: [] };
  while (args.length) {
    const key = args.shift();
    assert.ok(["--pr", "--report", "--runtime", "--findings", "--offline", "--json"].includes(key), `Unknown option ${key}`);
    if (key !== "--pr") assert.ok(!(key in options), `Repeated option ${key}`);
    const value = ["--offline", "--json"].includes(key) ? true : args.shift();
    assert.ok(value && !String(value).startsWith("--"), `Missing value for ${key}`);
    if (key === "--pr") { assert.match(value, /^[1-9][0-9]*$/); assert.ok(!options.prs.includes(value)); options.prs.push(value); }
    else options[key] = value;
  }
  assert.ok(!options["--offline"] || !options.prs.length, "--offline cannot check PRs");
  return options;
}

export function latestReport(directory) {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const names = entries.filter(e => e.isDirectory() && /^verify-\d+-[a-f0-9]+$/.test(e.name)).map(e => e.name);
  names.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  return names.length ? join(directory, names[0], "result.json") : null;
}

export function summarizeChecks(checks) {
  if (!Array.isArray(checks) || !checks.length) return { state: "unavailable", passed: 0, skipped: 0, failed: 0, pending: 0 };
  const result = { state: "passing", passed: 0, skipped: 0, failed: 0, pending: 0 };
  for (const check of checks) {
    const state = check.conclusion || check.state;
    if (state === "SUCCESS") result.passed++;
    else if (["SKIPPED", "NEUTRAL"].includes(state)) result.skipped++;
    else if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(state)) result.failed++;
    else result.pending++;
  }
  result.state = result.failed ? "failing" : result.pending ? "pending" : result.passed ? "passing" : "skipped only";
  return result;
}

export function summarizeHeadRuns(runs, head) {
  assert.ok(Array.isArray(runs), "invalid workflow run response");
  const latest = new Map();
  for (const run of [...runs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
    if (run.headSha === head && !latest.has(run.workflowName)) latest.set(run.workflowName, run);
  }
  const values = [...latest.values()];
  return { ...summarizeChecks(values.map(run => ({ status: run.status?.toUpperCase(), conclusion: run.conclusion?.toUpperCase() }))),
    runs: values.map(({ databaseId, url, workflowName }) => ({ databaseId, url, workflowName })) };
}

export function reviewFindings(path) {
  const value = read(path);
  assert.equal(value.schemaVersion, 1); assert.ok(Array.isArray(value.findings));
  const ids = new Set();
  return value.findings.map(finding => {
    assert.equal(typeof finding.id, "string"); assert.ok(finding.id && !ids.has(finding.id)); ids.add(finding.id);
    assert.equal(typeof finding.summary, "string");
    assert.ok(["open", "reproduced", "fixed", "verified", "not reproduced"].includes(finding.status));
    assert.ok(Array.isArray(finding.evidence));
    if (["verified", "not reproduced"].includes(finding.status)) assert.ok(finding.evidence.length, `${finding.id} needs evidence`);
    return { id: finding.id, summary: finding.summary, declaredStatus: finding.status,
      evidence: finding.evidence.map(file => {
        assert.equal(typeof file, "string");
        const absolute = resolve(dirname(path), file);
        try { assert.ok(statSync(absolute).isFile(), "Evidence is not a file"); return { path: absolute, available: true }; }
        catch (error) { return { path: absolute, available: false, error: message(error) }; }
      }) };
  });
}

export function collectStatus(options, { directory = root, command = runCommand } = {}) {
  const result = { checkedAt: new Date().toISOString(), errors: [], prs: [] };
  try { result.source = sourceIdentity(directory, command); } catch (error) { result.errors.push(message(error)); }
  let path;
  try { path = options["--report"] ? resolve(options["--report"]) : latestReport(join(directory, "ci-artifacts")); }
  catch (error) { result.errors.push(message(error)); }
  let report;
  if (path) {
    try {
      report = read(path);
      assert.ok(report && Array.isArray(report.stages), "invalid verification report stages");
      result.local = { path, verdict: report.finishedAt ? report.verdict || "incomplete" : "incomplete", finishedAt: report.finishedAt,
        stages: report.stages?.map(({ name, status, elapsedMs, error }) => ({ name, status, elapsedMs, error })),
        error: report.error || report.identityError };
      for (const key of ["startup", "acceptance"]) {
        let childPath = report[key + "Report"];
        if (!childPath && report[key + "Pointer"]) {
          try { childPath = read(report[key + "Pointer"]).path; }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        if (childPath) {
          const lab = read(childPath);
          result[key] = { path: childPath, verdict: lab.finishedAt ? lab.verdict || "incomplete" : "incomplete",
            expectedStages: lab.expectedStages, stages: lab.stages, cleanup: lab.cleanup?.success,
            error: lab.error || lab.cleanupError || lab.identityError, reason: lab.reason };
        }
      }
    } catch (error) { result.errors.push(`${path}: ${message(error)}`); }
  } else result.local = { verdict: "unavailable", match: "no local report" };
  const runtime = options["--runtime"] || report?.provenance?.candidate?.path;
  if (runtime) {
    try { result.candidate = candidateIdentity(resolve(runtime), directory); }
    catch (error) { result.errors.push(message(error)); }
  }
  if (report && result.local && result.source) result.local.match = evidenceMatch(report, result.source, result.candidate);
  if (!options["--offline"]) for (const pr of options.prs.length ? options.prs : [null]) {
    try {
      const fields = "number,url,title,state,headRefOid,baseRefName,mergeable,reviewDecision,statusCheckRollup";
      const value = JSON.parse(command("gh", ["pr", "view", ...(pr ? [pr] : []), "--json", fields], { cwd: directory }).stdout);
      const current = { number: value.number, url: value.url, title: value.title, state: value.state,
        head: value.headRefOid, base: value.baseRefName, mergeable: value.mergeable, reviewDecision: value.reviewDecision || "none",
        checkoutHead: value.headRefOid === result.source?.head, checks: summarizeChecks(value.statusCheckRollup) };
      result.prs.push(current);
      try {
        const runs = JSON.parse(command("gh", ["run", "list", "--commit", value.headRefOid, "--limit", "30", "--json",
          "databaseId,headSha,status,conclusion,url,workflowName,createdAt"], { cwd: directory }).stdout);
        current.headRuns = summarizeHeadRuns(runs, value.headRefOid);
        if (current.checks.state !== "failing" && current.headRuns.state !== "passing") current.checks.state = current.headRuns.state;
      } catch (error) { current.checks.state = "unavailable"; current.runError = message(error); result.errors.push(message(error)); }
    } catch (error) { result.prs.push({ number: pr, checks: { state: "unavailable" }, error: message(error) }); result.errors.push(message(error)); }
  }
  if (options["--findings"]) {
    try { result.findings = reviewFindings(resolve(options["--findings"])); }
    catch (error) { result.errors.push(message(error)); }
  }
  return result;
}

export function formatStatus(result) {
  const seconds = ms => Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(2)}s` : "unmeasured";
  const lines = [`Checked: ${result.checkedAt}`, `Checkout: ${result.source?.head || "unavailable"}${result.source?.dirty ? " (dirty)" : ""}`];
  for (const pr of result.prs) lines.push(`PR #${pr.number ?? "current"}: ${pr.state || "unavailable"}, ${pr.head || "unknown head"}, base ${pr.base || "unknown"}`,
    `  CI: ${pr.checks.state}; passed ${pr.checks.passed ?? 0}, skipped ${pr.checks.skipped ?? 0}, failed ${pr.checks.failed ?? 0}, pending ${pr.checks.pending ?? 0}`,
    `  Workflows for head: ${pr.headRuns?.state || "unavailable"}; mergeability ${pr.mergeable || "unknown"}; GitHub review ${pr.reviewDecision || "none"}`);
  if (result.candidate) lines.push(`Candidate: ${result.candidate.path}`, `  Package commit: ${result.candidate.packageCommit || "unavailable"}`,
    ...Object.entries(result.candidate.images).map(([role, image]) => `  ${role}: ${image}`));
  if (result.local) {
    lines.push(`Local: ${result.local.verdict}; ${result.local.match || "input match unavailable"}`, `  Evidence: ${result.local.path || "none"}`);
    for (const stage of result.local.stages || []) lines.push(`  ${stage.name}: ${stage.status}, ${seconds(stage.elapsedMs)}`);
    if (result.local.error) lines.push(`  Error: ${result.local.error}`);
  }
  for (const key of ["startup", "acceptance"]) if (result[key]) {
    const lab = result[key];
    lines.push(`${key}: ${lab.verdict}; cleanup ${lab.cleanup === true ? "passed" : "not confirmed"}`, `  Evidence: ${lab.path}`);
    if (lab.error || (lab.verdict !== "PASS" && lab.reason)) lines.push(`  Reason: ${lab.error || lab.reason}`);
    for (const name of lab.expectedStages || lab.stages?.map(s => s.name) || []) {
      const stage = lab.stages?.find(s => s.name === name);
      lines.push(`  ${name}: ${stage?.status || "not reached"}, ${seconds(stage?.elapsedMs)}${stage?.error ? `; ${stage.error}` : ""}`);
    }
    if (!lab.stages) lines.push("  Substage timings unavailable (historical report)");
  }
  for (const finding of result.findings || []) lines.push(`Review ${finding.id}: ${finding.declaredStatus} (declared); ${finding.summary}`,
    ...finding.evidence.map(e => `  ${e.available ? "Evidence" : "Missing evidence"}: ${e.path}`));
  lines.push(...result.errors.map(error => `Unavailable: ${error}`));
  return redactDiagnostic(lines.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes("--help")) console.log("node tools/verification-status.mjs [--pr N ... | --offline] [--report result.json] [--runtime runtime.json] [--findings findings.json] [--json]");
  else {
    const options = parseStatusOptions(process.argv.slice(2)), result = collectStatus(options);
    console.log(options["--json"] ? redactDiagnostic(JSON.stringify(result, null, 2)) : formatStatus(result));
    process.exitCode = result.errors.length ? 2 : 0;
  }
}
