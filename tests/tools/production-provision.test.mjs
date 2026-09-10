import assert from "node:assert/strict";
import test from "node:test";
import { provision, settings } from "../../docker/production/provision.mjs";

test("existing instances are refused before configuration or save mutations", () => {
  const calls = [];
  assert.throws(() => provision(args => { calls.push(args); return "platforms-1"; }), /already exists/);
  assert.deepEqual(calls, [["instance", "list"]]);
});
test("provisioning failure stops before save creation or start; it never resets a world", () => {
  const calls = [];
  assert.throws(() => provision(args => {
    calls.push(args);
    if (args[0] === "controller") throw new Error("controller unavailable");
    return "";
  }), /controller unavailable/);
  assert.ok(!calls.some(args => args[0] === "instance" && args[1] !== "list"));
});
test("fresh provisioning sets private conservative values before saves and exports assets before start", () => {
  const calls = [];
  const result = provision(args => {
    calls.push(args);
    if (args[0] === "mod-pack" && args[1] === "show") return "id: 123\n";
    if (args[0] === "instance" && args[1] === "config" && args[2] === "list") return `instance.id ${args[3].endsWith("1") ? 1 : 2}\n`;
    return "";
  });
  assert.equal(result.instances.length, 2);
  assert.ok(calls.find(args => args[0] === "mod-pack" && args[1] === "create").includes("recycler:2.1.17"));
  for (const name of ["platforms-1", "platforms-2"]) {
    const saveIndex = calls.findIndex(a => a[0] === "instance" && a[1] === "save" && a[3] === name);
    for (const [key, value] of Object.entries(settings.instance)) {
      const index = calls.findIndex(a => a[0] === "instance" && a[1] === "config" && a[2] === "set" && a[3] === name && a[4] === key);
      assert.ok(index >= 0 && index < saveIndex);
      assert.equal(calls[index][5], typeof value === "object" ? JSON.stringify(value) : String(value));
    }
  }
  const exported = calls.findIndex(a => a[1] === "export-data");
  assert.ok(calls.every((a, i) => a[1] !== "start" || i > exported));
  assert.equal(settings.instance["surface_export.debug_mode"], false);
  assert.equal(settings.instance["factorio.settings"].require_user_verification, true);
  assert.deepEqual(settings.instance["factorio.settings"].visibility, { public: false, lan: false });
});
