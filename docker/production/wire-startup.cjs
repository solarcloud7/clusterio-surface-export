const assert = require("node:assert/strict");
const fs = require("node:fs");
const role = process.argv[2];
assert.ok(["controller", "host"].includes(role));
if (role === "controller") {
  const path = "/controller-entrypoint.sh";
  const source = fs.readFileSync(path, "utf8");
  const marker = "# Start controller in background";
  assert.equal(source.split(marker).length, 2, "pinned entrypoint startup boundary changed");
  fs.writeFileSync(path, source.replace(marker,
    `gosu clusterio node /release/configure-controller.cjs\n\n${marker}`));
}
