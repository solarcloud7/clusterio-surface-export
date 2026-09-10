// Run in the exact candidate image, offline, before creating worlds.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const root = require("node:module").createRequire("/clusterio/package.json");
const role = process.argv[2];
assert.ok(["controller", "host"].includes(role));
assert.notEqual(process.getuid(), 0);
const directory = fs.mkdtempSync("/tmp/se-cli-");
try {
  const binary = "/clusterio/node_modules/.bin/clusterio" + role;
  const args = ["--log-level", "error", "--log-directory", directory + "/logs",
    "--config", directory + "/config.json", "--plugin-list", directory + "/plugins.json"];
  const cli = (...command) => execFileSync(binary, [...args, ...command], { encoding: "utf8", timeout: 30000 });
  const key = role + ".allow_remote_updates";
  cli("config", "set", key, "false");
  assert.equal(cli("config", "show", key).trim(), "false");
  const stringKey = role === "host" ? "host.factorio_directory" : "controller.database_directory";
  cli("config", "set", stringKey, "/tmp/path with spaces");
  assert.equal(cli("config", "show", stringKey).trim(), "/tmp/path with spaces");
  fs.writeFileSync(directory + "/plugins.json", "[]");
  cli("plugin", "list");
  const plugins = JSON.parse(fs.readFileSync(directory + "/plugins.json"));
  assert.deepEqual(plugins, [["surface_export", "@solarcloud7/plugin-surface-export"]]);
  const version = root("@clusterio/" + role + "/package.json").version;
  assert.equal(version, "2.0.0-alpha.27");
  assert.equal(root("@clusterio/ctl/package.json").version, version);
  console.log(JSON.stringify({ role, version, plugins, localConfig: "verified" }));
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
