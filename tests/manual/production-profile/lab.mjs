import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DockerLab, ROOT } from "../transfer-reliability/docker-lab.mjs";
import { provision, settings, pins } from "../../../docker/production/provision.mjs";
import { gatewayMapObserver, verifyGatewayMap } from "../../../tools/surface-export/check-gateway-map.mjs";

import configuration from "../../../docker/production/configure.cjs";
import { preservesInstalledCode } from "./mounts.mjs";

export class ProductionLab extends DockerLab {
  factorioVersion = pins.factorio;
  controlConfig = "/clusterio/tokens/config-control.json";
  command(args, timeout = 30_000) {
    return this.docker(["exec", "--user", "clusterio", this.controller, "npx", "--no-install", "clusterioctl",
      "--log-level", timeout > 30_000 ? "verbose" : "error", "--config", this.controlConfig, ...args], { timeout });
  }
  ctl(...args) { return this.command(args); }
  async boot(runtime, sourceClient) {
    assert.match(sourceClient, /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
    this.docker(["volume", "inspect", sourceClient]);
    for (const image of Object.values(runtime.images)) assert.match(image, /^sha256:[a-f0-9]{64}$/);
    const label = { "surface-export.manual-run": this.run };
    const client = `${this.run}-client`;
    this.docker(["volume", "create", "--label", `surface-export.manual-run=${this.run}`, client]);
    const helper = `${this.run}-copy-client`;
    this.docker(["run", "--name", helper, "--label", `surface-export.manual-run=${this.run}`,
      "--mount", `type=volume,src=${sourceClient},dst=/source,readonly`, "-v", `${client}:/destination`,
      "--entrypoint", "sh", runtime.images.host, "-c", "cp -a /source/. /destination/"], { timeout: 120_000 });
    const env = { ...process.env, SE_PROJECT: this.run, SE_CONTROLLER_IMAGE: runtime.images.controller,
      SE_HOST_IMAGE: runtime.images.host, SE_ADMIN: "profile-test", SE_CLIENT_VOLUME: client,
      SE_HTTP_PORT: "0", SE_HOST1_PORT: "0", SE_HOST2_PORT: "0", SE_GAME_BIND: "127.0.0.1" };
    const config = JSON.parse(this.docker(["compose", "-f", join(ROOT, "docker/production/compose.yml"), "config", "--format", "json"], { env }));
    for (const [name, service] of Object.entries(config.services)) {
      service.container_name = `${this.run}-${name}`;
      service.labels = { ...service.labels, ...label };
      assert.ok(!service.environment.NODE_OPTIONS && !service.environment.SE_MANUAL_RUN);
    }
    for (const [name, volume] of Object.entries(config.volumes)) if (!volume.external) { volume.name = `${this.run}-${name}`; volume.labels = label; }
    config.networks.default.name = this.run; config.networks.default.labels = label;
    const file = this.composeFile = join(this.directory, "compose.json"); writeFileSync(file, JSON.stringify(config, null, 2));
    this.config = config;
    this.docker(["compose", "-f", file, "up", "-d", "--wait", "--wait-timeout", "180"], { timeout: 210_000 });
    const port = this.docker(["port", this.controller, "8080/tcp"]).trim();
    assert.match(port, /^127\.0\.0\.1:\d+$/); this.url = `http://${port}`;
    assert.equal(config.services.controller.environment.DEFAULT_FACTORIO_VERSION, pins.factorio);
    this.runtime = [];
    for (const [name, service] of Object.entries(config.services)) {
      const [info] = JSON.parse(this.docker(["inspect", service.container_name]));
      const [image] = JSON.parse(this.docker(["image", "inspect", info.Image]));
      const options = env => env.filter(e => /^(NODE_OPTIONS|SE_MANUAL_RUN)=/.test(e));
      assert.equal(info.Image, name === "controller" ? runtime.images.controller : runtime.images.host);
      assert.ok(info.Mounts.every(m => preservesInstalledCode({ destination: m.Destination, type: m.Type })));
      assert.deepEqual(options(info.Config.Env), options(image.Config.Env), "startup options differ from the shipped image");
      assert.ok(!options(info.Config.Env).some(e => e.startsWith("SE_MANUAL_RUN=") || e.includes("/lab/")), "unexpected fault hook");
      assert.ok(!info.Mounts.some(m => m.Destination === "/lab"));
      const hashes = this.docker(["exec", service.container_name, "sha256sum", "/release/package.tgz", "/release/gateway.zip"]);
      assert.equal(hashes.split(/\s+/)[0], runtime.accepted.sha256);
      assert.ok(hashes.includes(runtime.gatewaySha256));
      const registration = JSON.parse(this.docker(["exec", service.container_name, "cat", "/clusterio/plugin-list.json"]));
      assert.deepEqual(registration, [["surface_export", "@solarcloud7/plugin-surface-export"]]);
      this.runtime.push({ name, image: info.Image, registration,
        instrumented: false, mounts: info.Mounts.map(m => ({ type: m.Type, destination: m.Destination, writable: m.RW })), hashes });
    }
  }
  async createWorlds() {
    const created = provision((args, timeout) => this.command(args, timeout), {
      placements: [1, 2].map(n => ({ name: this.hosts[n].instance, host: this.hosts[n].host })),
    });
    Object.assign(this, created);
    this.ids = Object.fromEntries([1, 2].map(n => [n, created.instances.find(i => i.hostName === this.hosts[n].host).id]));
    this.assets = Object.fromEntries([...created.exportDetails.matchAll(/^    ([\w-]+): ([\w.-]+)$/gm)].map(m => [m[1], m[2]]));
    await this.ready();
    this.observedSettings = {};
    this.hostSettings = Object.fromEntries([1, 2].map(n => [n, this.localSettings("host", this.hosts[n].container)]));
    this.controllerSettings = {};
    this.controllerLocalSettings = this.localSettings("controller", this.controller);
    const controllerLines = this.ctl("controller", "config", "list").split(/\r?\n/);
    for (const [key, value] of Object.entries(settings.controller)) {
      const raw = controllerLines.find(line => line.startsWith(`${key} `));
      assert.ok(raw, `missing controller field ${key}`);
      const observed = JSON.parse(raw.slice(key.length + 1));
      assert.equal(observed, value); this.controllerSettings[key] = observed;
    }
    for (const instance of created.instances) {
      const observed = {};
      const lines = this.ctl("instance", "config", "list", instance.name).split(/\r?\n/);
      const get = key => { const line = lines.find(v => v.startsWith(`${key} `)); assert.ok(line, `missing instance field ${key}`); return JSON.parse(line.slice(key.length + 1)); };
      for (const key of Object.keys(settings.instance).filter(k => k.startsWith("surface_export."))) {
        observed[key] = get(key);
        assert.equal(observed[key], settings.instance[key]);
      }
      this.observedSettings[instance.name] = observed;
      const game = get("factorio.settings");
      assert.deepEqual(game.visibility, { public: false, lan: false });
      assert.equal(game.require_user_verification, true);
      assert.equal(game.autosave_interval, 5);
      assert.equal(game.auto_pause, false);
      observed["factorio.settings"] = game;
    }
    this.gatewayMaps = [1, 2].map(n => {
      const state = this.lua(n, `local result=(function() ${gatewayMapObserver} end)();result.success=true;return result`).result;
      state.instance = this.hosts[n].instance; state.instanceId = this.ids[n]; state.platforms = Object.values(state.platforms);
      verifyGatewayMap(state, { version: pins.gateway.version }); return state;
    });
  }
  localSettings(role, container) {
    const expected = configuration.settingsForRole(role);
    const output = this.docker(["exec", "--user", "clusterio", container,
      "/clusterio/node_modules/.bin/clusterio" + role, "--log-level", "error", "--config",
      "/clusterio/data/config-" + role + ".json", "config", "list"]);
    const observed = configuration.readSettings(output, Object.keys(expected));
    assert.deepEqual(observed, expected);
    return observed;
  }
  async enableFaults() {
    const checkpoint = "manual-before-faults";
    await this.checkpoint(checkpoint);
    for (const n of [1, 2]) {
      this.ctl("instance", "config", "set", this.hosts[n].instance, "instance.auto_start", "false");
      this.command(["instance", "stop", this.hosts[n].instance], 120_000);
      const service = this.config.services["host-" + n];
      service.environment.SE_MANUAL_RUN = this.run;
      service.environment.NODE_OPTIONS = "--require=/lab/fault-hook.cjs";
      service.volumes.push({ type: "bind", source: join(ROOT, "tests/manual/transfer-reliability"), target: "/lab", read_only: true });
      this.assertOwned("container", this.hosts[n].container);
    }
    writeFileSync(this.composeFile, JSON.stringify(this.config, null, 2));
    this.docker(["compose", "-f", this.composeFile, "up", "-d", "--no-deps", "--force-recreate", "--wait",
      "--wait-timeout", "120", "host-1", "host-2"], { timeout: 150_000 });
    for (const n of [1, 2]) {
      this.localSettings("host", this.hosts[n].container);
      await this.until(() => { this.command(["instance", "start", this.hosts[n].instance, "--save", checkpoint + ".zip"], 120_000); return true; }, "host ready after instrumentation", 120);
      this.ctl("instance", "config", "set", this.hosts[n].instance, "instance.auto_start", "true");
    }
    await this.ready();
  }
  async recreateController() {
    this.assertOwned("container", this.controller);
    const before = this.docker(["inspect", this.controller, "--format", "{{.Id}} {{.Image}}"]);
    this.docker(["compose", "-f", this.composeFile, "up", "-d", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "90", "controller"], { timeout: 120_000 });
    const after = this.docker(["inspect", this.controller, "--format", "{{.Id}} {{.Image}}"]);
    assert.notEqual(before.split(" ")[0], after.split(" ")[0]);
    assert.equal(before.split(" ")[1], after.split(" ")[1]);
    this.url = `http://${this.docker(["port", this.controller, "8080/tcp"]).trim()}`;
    await this.ready();
    return { before: before.trim(), after: after.trim() };
  }
}
