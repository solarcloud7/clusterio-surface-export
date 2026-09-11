import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionLab } from "../manual/production-profile/lab.mjs";

test("fault instrumentation cannot reconnect hosts before the controller observes both disconnected", async t => {
  const directory = mkdtempSync(join(tmpdir(), "se-recreate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let stopped = false, disconnected = false, reads = 0, recreated = false;
  const lab = {
    run: "se-manual-transition", composeFile: join(directory, "compose.json"),
    hosts: { 1: { host: "clusterio-host-1", instance: "one", container: "host-1" },
      2: { host: "clusterio-host-2", instance: "two", container: "host-2" } },
    config: { services: { "host-1": { environment: {}, volumes: [] }, "host-2": { environment: {}, volumes: [] } } },
    checkpoint: async () => {}, command: () => {}, assertOwned: () => {}, localSettings: () => {}, ready: async () => {},
    ctl: (...args) => {
      if (args[0] !== "host") return;
      assert.equal(stopped, true);
      return "id | name | connected\n1 | clusterio-host-1 | false\n2 | clusterio-host-2 | "
        + (reads++ ? "false" : "true") + "\n3 | unrelated | false";
    },
    docker: args => {
      if (args.includes("stop")) { assert.ok(args.includes("host-1") && args.includes("host-2")); stopped = true; }
      if (args.includes("up")) { assert.equal(disconnected, true); recreated = true; }
    },
    until: async (read, label) => {
      if (label === "controller observed both hosts disconnected") {
        assert.equal(read(), false); assert.equal(read(), true); disconnected = true;
      } else assert.equal(read(), true);
    },
  };
  lab.stopHosts = () => ProductionLab.prototype.stopHosts.call(lab);
  await ProductionLab.prototype.enableFaults.call(lab);
  assert.equal(recreated, true); assert.equal(reads, 2);
});
