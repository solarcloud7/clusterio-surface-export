import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { analyzePackage } from "../../tests/manual/package-install/oracle.mjs";

// The report and tarball come from one immutable artifact in this workflow run.
// Recheck native acceptance, not just the saved verdict, before npm sees the file.
export function verifyPackage(directory, { commit, version }) {
  assert.match(commit, /^[a-f0-9]{40}$/, "expected full commit SHA required");
  assert.ok(version, "expected package version required");
  const report = JSON.parse(readFileSync(join(directory, "acceptance.json"), "utf8"));
  assert.equal(report.release?.schemaVersion, 1, "release evidence unavailable");
  assert.equal(report.release.commit, commit, "acceptance belongs to another commit");
  assert.equal(report.case, "lost-source-reply", "required recovery fixture missing");
  assert.equal(report.verdict, "PASS", "acceptance did not pass");
  assert.equal(report.package?.version, version, "package version does not match release");
  assert.equal(analyzePackage(report).verdict, "PASS", "native acceptance evidence failed");
  const bytes = readFileSync(join(directory, "package.tgz"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(sha256, report.package.sha256, "tarball SHA256 changed after acceptance");
  assert.equal(integrity, report.package.integrity, "tarball npm integrity changed after acceptance");
  return { name: report.package.name, version, commit, sha256, integrity, acceptanceRun: report.run };
}

export function verifyPublishPreview(preview, accepted) {
  assert.ok(preview && typeof preview === "object" && !Array.isArray(preview), "invalid npm preview");
  // npm 11.6 emits a flat package; npm 11.19 keys output by package name.
  let published = preview;
  if (typeof preview.name !== "string") {
    assert.deepEqual(Object.keys(preview), [accepted.name], "expected one package in npm preview");
    published = preview[accepted.name];
  }
  for (const key of ["name", "version", "integrity"])
    assert.equal(published?.[key], accepted[key], `npm preview ${key} differs from accepted package`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = new URL("../../", import.meta.url);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const manifest = JSON.parse(readFileSync(new URL("docker/seed-data/external_plugins/surface_export/package.json", root)));
  const ref = process.env.GITHUB_REF ?? "";
  // Manual branch runs rehearse the package version; release tags must match it exactly.
  if (ref.startsWith("refs/tags/")) assert.equal(ref, `refs/tags/v${manifest.version}`, "tag/package version mismatch");
  assert.ok(process.argv[2], "usage: node tools/release/verify-package.mjs <artifact-directory> [npm-preview.json]");
  const accepted = verifyPackage(process.argv[2], { commit, version: manifest.version });
  if (process.argv[3]) verifyPublishPreview(JSON.parse(readFileSync(process.argv[3], "utf8")), accepted);
  console.log(JSON.stringify(accepted, null, 2));
}
