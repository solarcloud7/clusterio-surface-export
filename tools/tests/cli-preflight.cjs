const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const root = require("node:module").createRequire("/clusterio/package.json");
const configuration = require("/release/configure.cjs");
const pins = require("/release/pins.json");
const role = process.argv[2];
const expected = JSON.parse(process.argv[3]);
module.exports.contract = { requires: ["exact candidate image", "current expected settings"],
  produces: ["native CLI preflight result"], "does not": ["create worlds", "access the network"] };
assert.ok(["controller", "host"].includes(role));
assert.notEqual(process.getuid(), 0);
assert.deepEqual(configuration.settingsForRole(role), expected.settings);
assert.equal(pins.clusterio, expected.version);
const directory = fs.mkdtempSync("/tmp/se-cli-");
try {
  const binary = "/clusterio/node_modules/.bin/clusterio" + role;
  const args = ["--log-level", "error", "--log-directory", directory + "/logs",
    "--config", directory + "/config.json", "--plugin-list", directory + "/plugins.json"];
  const cli = command => execFileSync(binary, [...args, ...command],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000 });
  const stringKey = role === "host" ? "host.factorio_directory" : "controller.database_directory";
  const settings = configuration.applySettings(cli, { ...expected.settings, [stringKey]: "/tmp/path with spaces" });
  assert.equal(cli(["config", "show", stringKey]).trim(), "/tmp/path with spaces");
  delete settings[stringKey];
  fs.writeFileSync(directory + "/plugins.json", "[]");
  cli(["plugin", "list"]);
  const plugins = JSON.parse(fs.readFileSync(directory + "/plugins.json"));
  assert.deepEqual(plugins, expected.plugins);
  for (const name of [role, "ctl", "lib"]) assert.equal(root("@clusterio/" + name + "/package.json").version, expected.version);
  console.log(JSON.stringify({ schemaVersion: 1, role, version: expected.version, plugins, settings, localConfig: "verified" }));
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
