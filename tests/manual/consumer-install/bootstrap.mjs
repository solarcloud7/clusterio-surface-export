// Runs as the unprivileged Clusterio user in a new /consumer installation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/consumer/package.json");
const version = "2.0.0-alpha.27";
const call = (cmd, args) => execFileSync(cmd, args, { cwd: "/consumer", encoding: "utf8", timeout: 240_000, maxBuffer: 1048576 });
const controller = (...args) => call("/consumer/node_modules/.bin/clusteriocontroller", args);
const host = (n, ...args) => call("/consumer/node_modules/.bin/clusteriohost", ["--config", `config-host-${n}.json`, ...args]);
try {
  assert.notEqual(process.getuid(), 0, "installer must run unprivileged");
  assert.ok(!existsSync("/consumer/package.json"), "consumer directory must start empty");
  const installed = call("npm", ["init", "--yes", `@clusterio@${version}`, "--", "--mode", "standalone",
    "--admin", "consumer-test", "--http-port", "8080", "--public-address", "localhost",
    "--factorio-dir", "/opt/test-client", "--no-remote-npm", "--plugins"]);
  assert.match(installed, /Successfully installed standalone/);
  // Do not persist the installer's stdout: it includes a disposable admin token.
  call("npm", ["install", "--no-audit", "--no-fund", "/inputs/package.tgz", `@clusterio/ctl@${version}`]);
  controller("plugin", "list"); // alpha.27 discovers installed npm plugins when no list exists.
  let registration = JSON.parse(readFileSync("/consumer/plugin-list.json"));
  const automaticRegistration = registration.some(([name]) => name === "surface_export");
  if (!automaticRegistration) controller("plugin", "add", "@solarcloud7/plugin-surface-export");
  const token = controller("bootstrap", "generate-user-token", "consumer-test").trim().split("\n").at(-1);
  call("npm", ["init", "--yes", `@clusterio@${version}`, "--", "--mode", "ctl",
    "--controller-url", "http://consumer-controller:8080/", "--controller-token", token, "--plugins"]);
  for (const n of [1, 2]) {
    const hostToken = controller("bootstrap", "generate-host-token", String(n)).trim().split("\n").at(-1);
    for (const [key, value] of Object.entries({ "host.id": n, "host.name": `clusterio-host-${n}`,
      "host.controller_url": "http://consumer-controller:8080/", "host.controller_token": hostToken,
      "host.factorio_directory": "/opt/test-client", "host.instances_directory": "/clusterio/data/instances",
      "host.public_address": "localhost", "host.allow_remote_updates": false, "host.allow_plugin_updates": false }))
      host(n, "config", "set", key, String(value));
  }
  const plugin = require("@solarcloud7/plugin-surface-export/package.json");
  const peers = {};
  for (const name of ["controller", "host", "ctl", "lib"]) {
    peers[name] = require(`@clusterio/${name}/package.json`).version;
    assert.equal(peers[name], version, "upstream installer resolved an unsupported core version");
    assert.ok(require.resolve(`@clusterio/${name}/package.json`).startsWith("/consumer/node_modules/"));
  }
  registration = JSON.parse(readFileSync("/consumer/plugin-list.json"));
  assert.ok(registration.some(([name, path]) => name === "surface_export" && path === "@solarcloud7/plugin-surface-export"));
  const pluginRequire = createRequire(require.resolve("@solarcloud7/plugin-surface-export"));
  assert.equal(pluginRequire.resolve("@clusterio/lib"), require.resolve("@clusterio/lib"));
  console.log(JSON.stringify({ success: true, installer: version, unprivileged: true,
    packageVersion: plugin.version, peers, registration, automaticRegistration,
    npmVersion: call("npm", ["--version"]).trim(), runScripts: ["run-controller.sh", "run-host.sh"].every(existsSync) }));
} catch (error) {
  // Child-process errors can contain argv. Never retain generated bearer tokens.
  console.error(String(error.stack).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]"));
  process.exitCode = 1;
}
