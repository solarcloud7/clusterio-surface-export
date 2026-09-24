const assert = require("node:assert/strict");

async function inspectArtifacts(pkg, zip) {
  assert.equal(pkg.name, "@solarcloud7/plugin-surface-export", "unexpected plugin package");
  assert.match(pkg.version || "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "exact plugin version required");
  const entries = Object.keys(zip.files).filter(name => /(^|\/)info\.json$/.test(name));
  assert.equal(entries.length, 1, "one companion metadata file required");
  const info = JSON.parse(await zip.file(entries[0]).async("string"));
  assert.equal(info.name, "surfexp_gateways", "unexpected companion mod");
  assert.match(info.version || "", /^\d+\.\d+\.\d+$/, "exact companion version required");
  assert.equal(entries[0], `${info.name}_${info.version}/info.json`, "companion folder and version disagree");
  assert.match(info.factorio_version || "", /^\d+\.\d+$/, "companion engine compatibility required");
  return {pluginVersion: pkg.version, gatewayVersion: info.version, gatewayFactorioVersion: info.factorio_version};
}

if (require.main === module) {
  const fs = require("node:fs");
  const {execFileSync} = require("node:child_process");
  const {createRequire} = require("node:module");
  const zip = createRequire("/clusterio/package.json")("jszip");
  Promise.resolve().then(async () => inspectArtifacts(
    JSON.parse(execFileSync("tar", ["-xOf", "/inputs/package.tgz", "package/package.json"], {encoding: "utf8", maxBuffer: 1048576})),
    await zip.loadAsync(fs.readFileSync("/inputs/gateway.zip"), {checkCRC32: true}),
  )).then(result => console.log(JSON.stringify(result))).catch(error => {console.error(error.message); process.exitCode = 1;});
}

module.exports = {inspectArtifacts};
