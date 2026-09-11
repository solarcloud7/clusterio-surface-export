const assert = require("node:assert/strict");
const fs = require("node:fs");
function wireStartup(role, source) {
  assert.ok(["controller", "host"].includes(role));
  const marker = role === "controller" ? "# Start controller in background" : "boot_race_guard &";
  const boundaries = role === "controller" ? 1 : 2;
  assert.equal(source.split(marker).length - 1, boundaries, "pinned entrypoint startup boundary changed");
  assert.ok(!source.includes(`/release/configure-${role}.cjs`), "entrypoint already configured");
  return source.replaceAll(marker, `gosu clusterio node /release/configure-${role}.cjs\n${marker}`);
}
module.exports = { wireStartup };
if (require.main === module) {
  const role = process.argv[2];
  assert.ok(["controller", "host"].includes(role));
  const path = `/${role}-entrypoint.sh`;
  fs.writeFileSync(path, wireStartup(role, fs.readFileSync(path, "utf8")));
}
