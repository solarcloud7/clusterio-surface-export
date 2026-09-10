const { execFileSync } = require("node:child_process");
const settings = require("./settings.json");
for (const [key, value] of Object.entries(settings.controllerLocal)) {
  execFileSync("/clusterio/node_modules/.bin/clusteriocontroller", ["--config", "/clusterio/data/config-controller.json",
    "config", "set", key, String(value)], { stdio: "inherit", timeout: 30_000 });
}
