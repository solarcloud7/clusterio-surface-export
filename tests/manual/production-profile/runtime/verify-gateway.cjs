const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { gateway, factorio } = require("./pins.json");

async function verifyGateway(zip) {
  const path = `${gateway.name}_${gateway.version}/info.json`;
  const metadata = Object.keys(zip.files).filter(name => /(^|\/)info\.json$/.test(name));
  assert.deepEqual(metadata, [path], "gateway ZIP directory/version does not match the production pin");
  const info = JSON.parse(await zip.file(path).async("string"));
  assert.equal(info.name, gateway.name, "gateway name mismatch");
  assert.equal(info.version, gateway.version, "gateway version mismatch");
  assert.equal(info.factorio_version, factorio.split(".").slice(0, 2).join("."), "gateway Factorio version mismatch");
  return `${gateway.name}_${gateway.version}.zip`;
}
if (require.main === module) {
  const zip = createRequire("/clusterio/package.json")("jszip");
  zip.loadAsync(fs.readFileSync("/release/gateway.zip"), { checkCRC32: true }).then(verifyGateway)
    .then(name => { fs.mkdirSync("/clusterio/seed-data/mods", { recursive: true });
      fs.copyFileSync("/release/gateway.zip", `/clusterio/seed-data/mods/${name}`); })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { verifyGateway };
