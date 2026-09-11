const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const settings = require("./settings.json");

const text = value => typeof value === "object" ? JSON.stringify(value) : String(value);
function settingsForRole(role) {
  assert.ok(["host", "controller"].includes(role));
  return settings[role === "host" ? "host" : "controllerLocal"];
}
function readSettings(output, keys) {
  const lines = output.split(/\r?\n/), observed = {};
  for (const key of keys) {
    const matches = lines.filter(line => line.startsWith(`${key} `));
    assert.equal(matches.length, 1, `Expected one stored value for ${key}`);
    let actual;
    try { actual = JSON.parse(matches[0].slice(key.length + 1)); }
    catch { throw new Error(`Invalid stored value for ${key}`); }
    observed[key] = actual;
  }
  return observed;
}
function applySettings(call, values) {
  for (const [key, value] of Object.entries(values)) call(["config", "set", key, text(value)]);
  const observed = readSettings(call(["config", "list"]), Object.keys(values));
  for (const [key, value] of Object.entries(values))
    assert.ok(isDeepStrictEqual(observed[key], value), `Configuration rejected ${key}`);
  return observed;
}
function configure(role, configPath = `/clusterio/data/config-${role}.json`) {
  const values = settingsForRole(role);
  applySettings(args => execFileSync(`/clusterio/node_modules/.bin/clusterio${role}`,
    ["--log-level", "error", "--config", configPath, ...args],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 1048576 }), values);
}
module.exports = { applySettings, configure, settingsForRole, readSettings, text };
