// Runs only in an owned, network-isolated helper with /data and /backup volume mounts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const VOLUME_SUFFIXES = ["seed", "plugins", "tokens", "controller-data", "static", "host-1-data", "host-2-data"];
export const PRODUCTION_VOLUME_SUFFIXES = ["controller-data", "controller-static", "controller-logs", "controller-mods", "host-1-data", "host-1-logs", "host-1-mods", "host-2-data", "host-2-logs", "host-2-mods", "tokens", "client"];
export function validateStorageRequest(action, suffix, run, expected, profile = "lab") {
  assert.match(run || "", /^se-manual-[a-z0-9-]{8,60}$/);
  assert.ok(["lab", "production"].includes(profile), "unknown storage profile");
  assert.ok((profile === "production" ? PRODUCTION_VOLUME_SUFFIXES : VOLUME_SUFFIXES).includes(suffix), "unknown backup volume");
  assert.ok(["backup", "erase", "restore"].includes(action), "unknown storage action");
  if (action !== "backup") assert.match(expected || "", /^[a-f0-9]{64}$/, "archive hash required");
}
async function digest(file) {
  assert.ok(fs.statSync(file).size <= 2 * 1024 ** 3, "archive exceeds 2 GiB bound");
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function storageAction(action, suffix, run, expected, profile = "lab") {
  validateStorageRequest(action, suffix, run, expected, profile);
  assert.equal(fs.realpathSync("/data"), "/data");
  assert.equal(fs.realpathSync("/backup"), "/backup");
  const archive = `/backup/${suffix}.tar`;
  const tar = args => execFileSync("tar", args, {timeout: 55_000, stdio: "ignore"});
  if (action === "backup") {
    assert.ok(!fs.existsSync(archive), "refuse to replace a backup");
    tar(["--numeric-owner", "-cpf", archive, "-C", "/data", "."]);
    tar(["--compare", "-f", archive, "-C", "/data"]);
    return {suffix, sha256: await digest(archive), bytes: fs.statSync(archive).size, compared: true};
  }
  assert.equal(await digest(archive), expected, "archive changed before destructive action");
  if (action === "erase") {
    // Only /data is writable target storage. No computed shell deletion or host paths.
    const entries = fs.readdirSync("/data");
    for (const entry of entries) {
      const target = path.resolve("/data", entry);
      assert.equal(path.dirname(target), "/data", "erase escaped owned mount");
      fs.rmSync(target, {recursive: true, force: false});
    }
    assert.equal(fs.readdirSync("/data").length, 0, "erasure incomplete");
    return {suffix, erasedEntries: entries.length, empty: true};
  }
  assert.equal(fs.readdirSync("/data").length, 0, "restore target is not empty");
  tar(["--numeric-owner", "-xpf", archive, "-C", "/data"]);
  tar(["--compare", "-f", archive, "-C", "/data"]);
  return {suffix, sha256: await digest(archive), compared: true};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await storageAction(process.argv[2], process.argv[3], process.env.SE_MANUAL_RUN, process.argv[4], process.argv[5])));
}
