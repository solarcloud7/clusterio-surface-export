import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export const settings = JSON.parse(readFileSync(new URL("./settings.json", import.meta.url)));
const text = value => typeof value === "object" ? JSON.stringify(value) : String(value);

// Public Clusterio CLI only. Existing worlds are refused, never overwritten.
export function provision(call, { names = ["platforms-1", "platforms-2"] } = {}) {
  const existing = call(["instance", "list"]);
  for (const name of names) {
    assert.match(name, /^[a-zA-Z0-9-]+$/);
    assert.ok(!existing.includes(name), `instance already exists: ${name}; inspect partial setup before retrying`);
  }
  for (const [key, value] of Object.entries(settings.controller)) call(["controller", "config", "set", key, text(value)]);
  call(["mod", "upload", "/release/gateway.zip"]);
  call(["mod-pack", "create", "surface-export-production", "2.1.17", "--mods", "base:2.1.17", "space-age:2.1.17",
    "quality:2.1.17", "elevated-rails:2.1.17", "recycler:2.1.17", "surfexp_gateways:0.6.5"]);
  const modPackId = Number(call(["mod-pack", "show", "surface-export-production"]).match(/^id: (\d+)$/m)?.[1]);
  assert.ok(Number.isSafeInteger(modPackId));
  call(["controller", "config", "set", "controller.default_mod_pack_id", String(modPackId)]);
  const instances = [];
  for (const [i, name] of names.entries()) {
    call(["instance", "create", name]);
    for (const [key, value] of Object.entries({ ...settings.instance, "factorio.mod_pack_id": modPackId }))
      call(["instance", "config", "set", name, key, text(value)]);
    const id = Number(call(["instance", "config", "list", name]).match(/^instance\.id (\d+)$/m)?.[1]);
    assert.ok(Number.isSafeInteger(id));
    call(["instance", "assign", name, String(i + 1)]);
    call(["instance", "save", "create", name, "world.zip"], 120_000);
    instances.push({ name, id, host: i + 1 });
  }
  call(["instance", "export-data", names[0]], 180_000);
  const exportDetails = call(["mod-pack", "show", "surface-export-production"]);
  for (const name of names) call(["instance", "start", name], 120_000);
  return { modPackId, instances, exportDetails };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [env, ...extra] = process.argv.slice(2);
  assert.ok(env && extra.length === 0, "usage: node docker/production/provision.mjs <production.env>");
  const call = (args, timeout = 30_000) => execFileSync("docker", ["compose", "--env-file", resolve(env),
    "-f", fileURLToPath(new URL("./compose.yml", import.meta.url)), "exec", "-T", "--user", "clusterio",
    "controller", "npx", "--no-install", "clusterioctl", "--config", "/clusterio/tokens/config-control.json", ...args],
  { encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024 });
  console.log(JSON.stringify(provision(call), null, 2));
}
