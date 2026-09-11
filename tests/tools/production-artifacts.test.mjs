import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import gateway from "../../docker/production/verify-gateway.cjs";
import { buildFiles, buildIdentity } from "../../tools/release/build-runtime.mjs";
import { pins } from "../../docker/production/provision.mjs";
import { preservesInstalledCode } from "../manual/production-profile/mounts.mjs";

test("gateway metadata and directory must agree with the production pin", async () => {
  const path = `${pins.gateway.name}_${pins.gateway.version}/info.json`;
  const info = { ...pins.gateway, factorio_version: "2.1" };
  const zip = (files, value) => ({ files, file: () => ({ async: async () => JSON.stringify(value) }) });
  assert.equal(await gateway.verifyGateway(zip({ [path]: {} }, info)), "surfexp_gateways_0.6.5.zip");
  for (const value of [{ ...info, version: "0.6.6" }, { ...info, name: "another_mod" }, { ...info, factorio_version: "1.1" }])
    await assert.rejects(gateway.verifyGateway(zip({ [path]: {} }, value)));
  for (const files of [{}, { "surfexp_gateways_0.6.6/info.json": {} }, { [path]: {}, "extra/info.json": {} }])
    await assert.rejects(gateway.verifyGateway(zip(files, info)));
});

test("build identity changes with either base or any staged input", () => {
  const dir = mkdtempSync(join(tmpdir(), "se-build-inputs-"));
  try {
    const files = [...buildFiles, "package.tgz", "gateway.zip"];
    for (const file of files) writeFileSync(join(dir, file), file);
    const original = buildIdentity(dir, "host", pins.bases.host);
    assert.equal(buildIdentity(dir, "host", pins.bases.host), original);
    assert.notEqual(buildIdentity(dir, "host", "another-base"), original);
    assert.notEqual(buildIdentity(dir, "controller", pins.bases.host), original);
    for (const file of files) {
      writeFileSync(join(dir, file), file + "changed");
      assert.notEqual(buildIdentity(dir, "host", pins.bases.host), original, file);
      writeFileSync(join(dir, file), file);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("production mounts cannot overlay installed code at any depth", () => {
  for (const destination of ["/", "/clusterio", "/clusterio/", "/clusterio/node_modules/x", "/clusterio/external_plugins/x",
    "/clusterio/ctl.js", "/clusterio/data/../node_modules/x", "/clusterio/data/nested"])
    for (const type of ["bind", "volume"]) assert.equal(preservesInstalledCode({ destination, type }), false);
  for (const destination of ["data", "mods", "logs", "tokens", "static"].map(p => `/clusterio/${p}`)) {
    assert.equal(preservesInstalledCode({ destination, type: "volume" }), true);
    assert.equal(preservesInstalledCode({ destination, type: "bind" }), false);
  }
});

test("Compose and the shared lab cannot silently diverge from the production version pins", () => {
  const compose = readFileSync(new URL("../../docker/production/compose.yml", import.meta.url), "utf8");
  assert.equal(compose.match(/DEFAULT_FACTORIO_VERSION: "([^"]+)"/)[1], pins.factorio);
  assert.equal(compose.match(/DEFAULT_MOD_PACK: Space Age ([^\r\n]+)/)[1], pins.factorio);
  const env = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  assert.equal(env.match(/^CLUSTERIO_IMAGE_TAG=(.+)\.r\d+\s*$/m)[1], pins.clusterio);
});
