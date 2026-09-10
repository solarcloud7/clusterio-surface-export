import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyPackage } from "../../tools/release/verify-package.mjs";

const observed = JSON.parse(readFileSync(new URL("../manual/package-install/evidence/installed-0.10.281.json", import.meta.url)));
const commit = "a".repeat(40);
const expected = { commit, version: observed.package.version };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "se-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("test tarball bytes; native installation is proved separately");
  const report = structuredClone(observed);
  report.release = { schemaVersion: 1, commit };
  report.package.sha256 = createHash("sha256").update(bytes).digest("hex");
  report.package.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  writeFileSync(join(directory, "package.tgz"), bytes);
  const save = () => writeFileSync(join(directory, "acceptance.json"), JSON.stringify(report));
  save();
  return { directory, report, save };
}

test("release verification binds native evidence to exact bytes, commit and version", t => {
  const { directory, report } = fixture(t);
  assert.equal(verifyPackage(directory, expected).sha256, report.package.sha256);
  assert.throws(() => verifyPackage(directory, { ...expected, commit: "b".repeat(40) }), /another commit/);
  assert.throws(() => verifyPackage(directory, { ...expected, version: "0.0.0" }), /version/);
  writeFileSync(join(directory, "package.tgz"), "substituted bytes");
  assert.throws(() => verifyPackage(directory, expected), /SHA256/);
});

test("release verification fails closed on missing, failed or inconsistent evidence", t => {
  const { directory, report, save } = fixture(t);
  const original = structuredClone(report);
  for (const mutate of [
    r => delete r.release,
    r => r.verdict = "STOP",
    r => r.cleanup.success = false,
    r => r.package.integrity = "sha512-wrong",
    r => r.samples.at(-1).destination.cargo.entities.pop(),
    r => r.events[2].push(r.events[2].find(e => e.action === "import" && e.kind === "call")),
  ]) {
    Object.assign(report, structuredClone(original));
    mutate(report); save();
    assert.throws(() => verifyPackage(directory, expected));
  }
  rmSync(join(directory, "acceptance.json"));
  assert.throws(() => verifyPackage(directory, expected), /ENOENT/);
  Object.assign(report, original); save();
  rmSync(join(directory, "package.tgz"));
  assert.throws(() => verifyPackage(directory, expected), /ENOENT/);
});

test("release CLI checks the tag independently of matching tarball evidence", t => {
  const { directory, report, save } = fixture(t);
  const root = new URL("../../", import.meta.url);
  const { version } = JSON.parse(readFileSync(new URL("docker/seed-data/external_plugins/surface_export/package.json", root)));
  report.package.version = version;
  report.packageInstall.version = version;
  report.release.commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  save();
  const command = fileURLToPath(new URL("../../tools/release/verify-package.mjs", import.meta.url));
  for (const ref of [`refs/tags/v${version}`, "refs/heads/rehearsal"]) {
    const result = spawnSync(process.execPath, [command, directory], { encoding: "utf8", env: { ...process.env, GITHUB_REF: ref } });
    assert.equal(result.status, 0, result.stderr);
  }
  const result = spawnSync(process.execPath, [command, directory], {
    encoding: "utf8", env: { ...process.env, GITHUB_REF: "refs/tags/v0.0.0" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tag\/package version mismatch/);
});
