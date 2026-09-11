import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, readlinkSync } from "node:fs";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { runCommand } from "./command-evidence.mjs";
import { buildFiles, buildIdentity } from "../release/build-runtime.mjs";

export const contract = { requires: ["canonical checkout", "candidate manifest when supplied"],
  produces: ["source and candidate identities"], "does not": ["certify test results", "inspect the live deployment"] };
const digest = value => createHash("sha256").update(value).digest("hex");

export function sourceIdentity(root, command = runCommand) {
  const git = args => command("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 }).stdout;
  const head = git(["rev-parse", "HEAD"]).trim();
  assert.match(head, /^[a-f0-9]{40}$/);
  const files = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0").filter(Boolean))].sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const path = resolve(root, file), local = relative(root, path);
    assert.ok(local && !isAbsolute(local) && local !== ".." && !local.startsWith("..\\") && !local.startsWith("../"));
    let value;
    try {
      const stat = lstatSync(path);
      assert.ok(stat.isFile() || stat.isSymbolicLink(), `Unsupported source entry ${file}`);
      value = stat.isSymbolicLink() ? "link:" + readlinkSync(path) : digest(readFileSync(path));
    } catch (error) { if (error.code !== "ENOENT") throw error; value = "missing"; }
    hash.update(file + "\0" + value + "\0");
  }
  return { head, sourceSha256: hash.digest("hex"), fileCount: files.length,
    dirty: Boolean(git(["status", "--porcelain", "--untracked-files=normal"]).trim()) };
}

export function candidateIdentity(file, root) {
  const bytes = readFileSync(file), runtime = JSON.parse(bytes);
  for (const role of ["controller", "host"]) {
    assert.match(runtime.images?.[role] || "", /^sha256:[a-f0-9]{64}$/);
    assert.equal(buildIdentity(dirname(file), role, runtime.bases?.[role]), runtime.buildIdentities?.[role],
      `candidate staged inputs differ from the recorded ${role} build`);
  }
  const recipeDifferences = buildFiles.filter(name => {
    try { return !readFileSync(join(root, "docker/production", name)).equals(readFileSync(join(dirname(file), name))); }
    catch (error) { if (error.code !== "ENOENT") throw error; return true; }
  });
  return { path: resolve(file), manifestSha256: digest(bytes), images: runtime.images,
    packageCommit: runtime.accepted?.commit, packageSha256: runtime.accepted?.sha256,
    buildIdentities: runtime.buildIdentities, recipeDifferences };
}

export function evidenceMatch(report, source, candidate) {
  if (!report.provenance?.source) return "unavailable (historical report)";
  if (!report.provenance?.finishedSource || !report.finishedAt) return "unavailable (verification incomplete)";
  const initial = report.provenance.source, final = report.provenance.finishedSource;
  if (initial.head !== final.head || initial.sourceSha256 !== final.sourceSha256) return "changed during verification";
  if (final.head !== source.head || final.sourceSha256 !== source.sourceSha256) return "stale (checkout changed)";
  if (candidate) {
    if (!report.provenance.candidate) return "unavailable (candidate not recorded)";
    if (report.provenance.candidate.manifestSha256 !== candidate.manifestSha256) return "stale (candidate changed)";
    if (candidate.recipeDifferences.length) return "stale (image recipe changed)";
  } else if (report.provenance.candidate) return "unavailable (candidate not checked)";
  return "matches recorded inputs";
}
