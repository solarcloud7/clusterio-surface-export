import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Fault injection only: controller must be stopped and the volume owner checked by DockerLab.
export function ageIntent(root, transferId, run, now = Date.now()) {
  assert.ok(/^se-manual-[a-z0-9-]{8,60}$/.test(run) && transferId.includes(run), "foreign transfer");
  root = fs.realpathSync(root);
  const matches = [];
  let visited = 0;
  function visit(directory, depth) {
    assert.ok(++visited <= 1000, "bounded data directory search exceeded");
    for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 3) visit(filename, depth + 1);
      if (entry.isFile() && entry.name === "surface_export_pending_transfers.json") matches.push(filename);
    }
  }
  visit(root, 0);
  assert.equal(matches.length, 1, "one pending intent store required");
  const filename = fs.realpathSync(matches[0]);
  assert.ok(filename.startsWith(root + path.sep), "intent file outside owned data volume");
  const entries = JSON.parse(fs.readFileSync(filename, "utf8"));
  assert.ok(Array.isArray(entries));
  const matching = entries.filter(entry => entry.transferId === transferId);
  assert.equal(matching.length, 1, "one exact pending transfer required");
  const entry = matching[0], before = entry.startedAt;
  assert.ok(Number.isFinite(before));
  entry.startedAt = now - 24 * 60 * 60 * 1000;
  fs.writeFileSync(filename, JSON.stringify(entries));
  return {transferId, before, after:entry.startedAt, observedAt:now, changedField:"startedAt"};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(ageIntent("/data", process.argv[2], process.argv[3])));
}
