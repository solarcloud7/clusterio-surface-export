import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DockerLab, ROOT } from "../transfer-reliability/docker-lab.mjs";
import { redactDiagnostic } from "../../../tools/shared/diagnostics.mjs";
import { gatewayMapObserver, verifyGatewayMap } from "../../../tools/surface-export/check-gateway-map.mjs";

export class ConsumerLab extends DockerLab {
  mutateContainer(verb, name, extra = []) {
    if (name === this.controller && verb === "kill") {
      this.assertOwned("container", name);
      assert.deepEqual(extra, ["--signal", "KILL"]);
      // Keep the PID namespace alive: restarting a PID-1 controller makes upstream's
      // PID-only lock mistake its own stale PID for a currently running process.
      const raw = this.docker(["exec", name, "node", "-e", `
        const fs=require('fs'),assert=require('assert/strict');
        const pid=Number(fs.readFileSync('/consumer/config-controller.json.lock','utf8'));
        assert.ok(Number.isSafeInteger(pid)&&pid>1);
        assert.ok(fs.readFileSync('/proc/'+pid+'/cmdline','utf8').includes('clusteriocontroller'));
        process.kill(pid,'SIGKILL');console.log(JSON.stringify({signal:'SIGKILL',pid}));`]);
      this.controllerCrash = JSON.parse(raw); return raw;
    }
    if (name === this.controller && verb === "start" && this.controllerCrash) {
      this.assertOwned("container", name);
      return "upstream run-controller.sh restarts the killed child";
    }
    return super.mutateContainer(verb, name, extra);
  }
  command(args, timeout = 30_000) {
    try {
      return this.docker(["exec", "--user", "clusterio", "-w", "/consumer", this.controller,
        "sh", "-c", '"$@" > /consumer/last-control-output.txt 2>&1; status=$?; cat /consumer/last-control-output.txt; exit "$status"', "consumer-ctl",
        "/consumer/node_modules/.bin/clusterioctl", "--log-level", timeout > 30_000 ? "verbose" : "error", "--config", "/consumer/config-control.json", ...args], { timeout });
    } catch (error) {
      const output = redactDiagnostic(this.docker(["exec", this.controller, "tail", "-c", "16384", "/consumer/last-control-output.txt"]));
      writeFileSync(join(this.directory, "failed-command.log"), output);
      throw new Error(`${error.message}\n${output}`, { cause: error });
    }
  }
  ctl(...args) { return this.command(args); }
  async install(inputs, clientVolume) {
    assert.match(clientVolume, /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/, "expected an explicit source client volume");
    this.docker(["volume", "inspect", clientVolume]); // Refuse typos; docker -v would create an empty volume.
    const tag = readFileSync(join(ROOT, ".env.example"), "utf8").match(/^CLUSTERIO_IMAGE_TAG=(.+)$/m)[1].trim();
    this.image = `ghcr.io/solarcloud7/clusterio-docker-host:${tag}`;
    this.docker(["network", "create", "--label", `surface-export.manual-run=${this.run}`, this.run]);
    const volume = suffix => {
      const name = `${this.run}-${suffix}`;
      this.docker(["volume", "create", "--label", `surface-export.manual-run=${this.run}`, name]);
      return name;
    };
    this.installVolume = volume("install"); this.clientVolume = volume("client");
    this.dataVolumes = { 1: volume("host-1-data"), 2: volume("host-2-data") };
    const helper = `${this.run}-install`;
    this.docker(["run", "-d", "--name", helper, "--label", `surface-export.manual-run=${this.run}`,
      "--mount", `type=volume,src=${clientVolume},dst=/source-client,readonly`,
      "-v", `${this.clientVolume}:/opt/test-client`, "-v", `${this.installVolume}:/consumer`,
      "-v", `${inputs}:/inputs:ro`, "--entrypoint", "sleep", this.image, "infinity"]);
    this.docker(["exec", helper, "sh", "-c", "cp -a /source-client/. /opt/test-client/ && chown clusterio:clusterio /consumer"], { timeout: 120_000 });
    const engine = this.docker(["exec", helper, "/opt/test-client/bin/x64/factorio", "--version"]);
    assert.match(engine, /Version: 2\.1\.17/);
    this.docker(["exec", helper, "test", "-d", "/opt/test-client/data/core/graphics"]);
    this.docker(["cp", join(ROOT, "tests/manual/consumer-install/bootstrap.mjs"), `${helper}:/bootstrap.mjs`]);
    console.log("Running the pinned upstream installer in an empty consumer directory");
    const installation = JSON.parse(this.docker(["exec", "--user", "clusterio", "-w", "/consumer", helper,
      "node", "/bootstrap.mjs"], { timeout: 360_000 }));
    this.docker(["cp", join(inputs, "gateway.zip"), `${helper}:/consumer/gateway.zip`]);
    this.docker(["exec", helper, "chmod", "a+r", "/consumer/gateway.zip"]);
    this.installation = { ...installation, engine: engine.trim(), image: this.image };
    return this.installation;
  }
  async start() {
    const common = name => ["run", "-d", "--name", name, "--label", `surface-export.manual-run=${this.run}`,
      "--network", this.run, "-w", "/consumer", "-v", `${this.installVolume}:/consumer`];
    this.docker([...common(this.controller), "--network-alias", "consumer-controller", "-p", "127.0.0.1::8080",
      "--user", "clusterio", "--entrypoint", "bash", this.image, "/consumer/run-controller.sh"]);
    const port = this.docker(["port", this.controller, "8080/tcp"]).trim();
    assert.match(port, /^127\.0\.0\.1:\d+$/); this.url = `http://${port}`;
    await this.until(() => this.docker(["exec", this.controller, "curl", "-sf", "http://localhost:8080/"]).length > 0, "upstream controller HTTP", 90);
    for (const n of [1, 2]) {
      this.docker([...common(this.hosts[n].container), "-v", `${this.dataVolumes[n]}:/clusterio/data`,
        "-v", `${this.clientVolume}:/opt/test-client`,
        "-v", `${join(ROOT, "tests/manual/transfer-reliability")}:/lab:ro`,
        "-e", `SE_MANUAL_RUN=${this.run}`, "-e", "NODE_OPTIONS=--require=/lab/fault-hook.cjs",
        "--entrypoint", "sh", this.image, "-c",
        `chown clusterio:clusterio /clusterio/data && exec gosu clusterio /consumer/node_modules/.bin/clusteriohost --config config-host-${n}.json --log-directory /clusterio/data/logs run`]);
    }
    await this.until(() => { const list = this.ctl("host", "list"); return [1, 2].every(n => list.includes(`clusterio-host-${n}`)); }, "both upstream hosts", 90);
    this.ctl("mod", "upload", "/consumer/gateway.zip");
    this.ctl("mod-pack", "create", "consumer-acceptance", "2.1.17", "--mods", "base:2.1.17", "space-age:2.1.17",
      "quality:2.1.17", "elevated-rails:2.1.17", "recycler:2.1.17", "surfexp_gateways:0.6.5");
    this.modPackId = Number(this.ctl("mod-pack", "show", "consumer-acceptance").match(/^id: (\d+)$/m)?.[1]);
    assert.ok(Number.isSafeInteger(this.modPackId), "mod-pack ID unavailable");
    this.ctl("controller", "config", "set", "controller.default_mod_pack_id", String(this.modPackId));
    this.ids = {};
    this.freshSaves = [];
    for (const n of [1, 2]) {
      const name = this.hosts[n].instance;
      this.ctl("instance", "create", name);
      for (const [key, value] of Object.entries({ "factorio.version": "2.1.17", "factorio.mod_pack_id": this.modPackId,
        "factorio.settings": JSON.stringify({ visibility: { public: false, lan: false }, auto_pause: false, autosave_interval: 0 }),
        "surface_export.debug_mode": true })) {
        this.ctl("instance", "config", "set", name, key, String(value));
      }
      this.ids[n] = Number(this.ctl("instance", "config", "list", name).match(/^instance\.id (\d+)$/m)?.[1]);
      assert.ok(Number.isSafeInteger(this.ids[n]) && this.ids[n] > 0);
      this.ctl("instance", "assign", name, String(n));
      console.log(`Creating fresh save on consumer host ${n}`);
      this.command(["instance", "save", "create", name, "consumer.zip", "--seed", "69420"], 120_000);
      this.freshSaves.push({ host: n, instanceId: this.ids[n], name: "consumer.zip", method: "instance save create", seed: 69420 });
    }
    console.log("Exporting real game locale, prototypes, and icons through Clusterio");
    this.command(["instance", "export-data", this.hosts[1].instance], 180_000);
    this.exportDetails = this.ctl("mod-pack", "show", "consumer-acceptance");
    this.assets = Object.fromEntries([...this.exportDetails.matchAll(/^    ([\w-]+): ([\w.-]+)$/gm)].map(m => [m[1], m[2]]));
    assert.ok(this.assets.prototypes, "export-data did not publish a prototype manifest");
    for (const n of [1, 2]) this.command(["instance", "start", this.hosts[n].instance], 120_000);
    await this.ready();
    this.gatewayMaps = [];
    for (const n of [1, 2]) {
      const state = this.lua(n, `local result=(function() ${gatewayMapObserver} end)();result.success=true;return result`).result;
      state.instance = this.hosts[n].instance; state.instanceId = this.ids[n]; state.platforms = Object.values(state.platforms);
      verifyGatewayMap(state, { version: "0.6.5" }); this.gatewayMaps.push(state);
    }
  }
}
