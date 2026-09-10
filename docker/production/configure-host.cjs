const { execFileSync } = require("node:child_process");
const settings = require("./settings.json");
for (const [key, value] of Object.entries(settings.host)) {
  execFileSync("/clusterio/node_modules/.bin/clusteriohost", ["--config", "/clusterio/data/config-host.json",
    "config", "set", key, String(value)], { stdio: "inherit", timeout: 30_000 });
}
