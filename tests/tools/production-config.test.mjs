import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import configuration from "../../docker/production/configure.cjs";
import startup from "../../docker/production/wire-startup.cjs";

const settings = JSON.parse(readFileSync(new URL("../../docker/production/settings.json", import.meta.url)));
function configure(role, rejected) {
  const file = fileURLToPath(new URL(`../../docker/production/configure-${role}.cjs`, import.meta.url));
  const fields = settings[role === "host" ? "host" : "controllerLocal"];
  const script = `
    const cp = require('node:child_process');
    const fields = ${JSON.stringify(Object.fromEntries(Object.keys(fields).map(key => [key, true])))};
    const calls = [];
    cp.execFileSync = (file, args) => {
      calls.push(args);
      const at = args.indexOf('config');
      if (args[at + 1] === 'set' && args[at + 2] !== ${JSON.stringify(rejected)}) fields[args[at + 2]] = JSON.parse(args[at + 3]);
      return args[at + 1] === 'list' ? Object.entries(fields).map(([key, value]) => key + ' ' + JSON.stringify(value)).join('\\n') : '';
    };
    require(${JSON.stringify(file)});
    console.log(JSON.stringify(calls));
  `;
  return spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10000 });
}

test("hardening rejects missing, duplicate, malformed and incorrectly typed readbacks", () => {
  for (const raw of ["", "host.allow_remote_updates false\nhost.allow_remote_updates false", "host.allow_remote_updates nope", 'host.allow_remote_updates "false"']) {
    assert.throws(() => configuration.applySettings(args => args[1] === "list" ? raw : "", { "host.allow_remote_updates": false }));
  }
});

test("startup patch covers both host branches and refuses changed or repeated boundaries", () => {
  const source = 'if configured; then\n  boot_race_guard &\n  exec start_host\nfi\nrebuild_config\nboot_race_guard &\nexec start_host\n';
  const actual = startup.wireStartup("host", source);
  assert.equal(actual.split("gosu clusterio node /release/configure-host.cjs\nboot_race_guard &").length - 1, 2);
  assert.ok(actual.lastIndexOf("configure-host.cjs") > actual.indexOf("rebuild_config"));
  assert.throws(() => startup.wireStartup("host", source.replace("boot_race_guard &", "changed")), /boundary changed/);
  assert.throws(() => startup.wireStartup("host", actual), /already configured/);
  assert.equal(startup.wireStartup("controller", "bootstrap\n# Start controller in background\nstart_controller"),
    "bootstrap\ngosu clusterio node /release/configure-controller.cjs\n# Start controller in background\nstart_controller");
});

for (const role of ["controller", "host"]) {
  const fields = settings[role === "host" ? "host" : "controllerLocal"];
  test(`${role} verifies all hardening writes in one final read`, () => {
    const result = configure(role, null);
    assert.equal(result.status, 0, result.stderr);
    const calls = JSON.parse(result.stdout);
    const commands = calls.map(args => args.slice(args.indexOf("config") + 1));
    assert.deepEqual(commands, [...Object.entries(fields).map(([key, value]) => ["set", key, String(value)]), ["list"]]);
  });
  for (const field of Object.keys(fields)) {
    test(`${role} refuses startup when ${field} is rejected with exit zero`, () => {
      const result = configure(role, field);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(field));
    });
  }
}
