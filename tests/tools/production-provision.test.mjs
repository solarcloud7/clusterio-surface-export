import assert from "node:assert/strict";
import test from "node:test";
import { provision, settings, pins } from "../../docker/production/provision.mjs";

test("existing instances are refused before configuration or save mutations", () => {
  const calls = [];
  assert.throws(() => provision(args => { calls.push(args); return "id | name | status\n1 | platforms-1 | stopped"; }), /already exists/);
  assert.deepEqual(calls, [["instance", "list"]]);
});
test("provisioning failure stops before save creation or start; it never resets a world", () => {
  const calls = [];
  assert.throws(() => provision(args => {
    calls.push(args);
    if (args[0] === "controller") throw new Error("controller unavailable");
    if (args[0] === "host") return "id | name | connected\n17 | clusterio-host-1 | true\n42 | clusterio-host-2 | true";
    return "";
  }), /controller unavailable/);
  assert.ok(!calls.some(args => args[0] === "instance" && args[1] !== "list"));
});
test("fresh provisioning sets private conservative values before saves and exports assets before start", () => {
  const calls = [];
  const result = provision(args => {
    calls.push(args);
    if (args[0] === "host") return "id | name | connected\n42 | clusterio-host-2 | true\n17 | clusterio-host-1 | true";
    if (args[0] === "mod-pack" && args[1] === "show") return "id: 123\n";
    if (args[0] === "instance" && args[1] === "config" && args[2] === "list") return `instance.id ${args[3].endsWith("1") ? 1 : 2}\n`;
    return "";
  });
  assert.deepEqual(result.instances.map(i => i.host), [17, 42]);
  assert.deepEqual(calls.filter(a => a[1] === "assign").map(a => a[3]), ["17", "42"]);
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


test("substring names do not block; partial creation blocks a retry before mutations", () => {
  const calls = [], existing = [{ id: 9, name: "platforms-10" }];
  const call = args => {
    calls.push(args);
    if (args[1] === "list") return args[0] === "host"
      ? "id | name | connected\n17 | clusterio-host-1 | true\n42 | clusterio-host-2 | true"
      : "id | name\n" + existing.map(i => i.id + " | " + i.name).join("\n");
    if (args[0] === "mod-pack" && args[1] === "show") return "id: 123\n";
    if (args[0] === "instance" && args[1] === "create") {
      if (args[2] === "platforms-2") throw Error("second create rejected");
      existing.push({ id: 10, name: args[2] });
    }
    if (args[2] === "list") return "instance.id 10\n";
    return "";
  };
  assert.throws(() => provision(call), /second create rejected/);
  assert.equal(calls.filter(a => a[1] === "save" && a[2] === "create").length, 1);
  assert.ok(!calls.some(a => ["delete", "start", "export-data"].includes(a[1])));
  calls.length = 0;
  assert.throws(() => provision(call), /already exists/);
  assert.deepEqual(calls, [["instance", "list"]]);
});

test("ambiguous or absent hosts and malformed list output fail before provisioning", () => {
  for (const hosts of ["", "id | name | connected\n17 | clusterio-host-1 | false", "unexpected output",
    "id | name | connected\n17 | clusterio-host-1 | true\n42 | clusterio-host-1 | true"]) {
    const calls = [];
    assert.throws(() => provision(args => { calls.push(args); return args[0] === "host" ? hosts : ""; }));
    assert.ok(calls.every(a => a[1] === "list"));
  }
  assert.equal(settings.instance["factorio.version"], pins.factorio);
});
