const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const root = createRequire("/clusterio/package.json");
const plugin = root("@solarcloud7/plugin-surface-export/package.json");
for (const name of ["controller", "host", "ctl", "lib"]) {
  assert.equal(root(`@clusterio/${name}/package.json`).version, "2.0.0-alpha.27");
}
const local = createRequire(root.resolve("@solarcloud7/plugin-surface-export"));
assert.equal(local.resolve("@clusterio/lib"), root.resolve("@clusterio/lib"));
assert.equal(root("@solarcloud7/plugin-surface-export/module/module.json").version, plugin.version);
root("@solarcloud7/plugin-surface-export");
const path = "/clusterio/plugin-list.json";
fs.writeFileSync(path, JSON.stringify([["surface_export", "@solarcloud7/plugin-surface-export"]]));
execFileSync("gosu", ["clusterio", "/clusterio/node_modules/.bin/clusteriocontroller",
  "--log-directory", "/tmp/surface-export-verify-logs", "--log-level", "error", "plugin", "list"], { timeout: 30_000 });
assert.deepEqual(JSON.parse(fs.readFileSync(path)), [["surface_export", "@solarcloud7/plugin-surface-export"]]);
