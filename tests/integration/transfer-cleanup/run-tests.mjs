import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Both construction contracts must survive transfer and refused source deletion.
for (const args of [[], ["--empty-hub-control", "--restart-controller"]]) {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./delete-failure.mjs", import.meta.url)), ...args], {
    stdio: "inherit", timeout: 300_000,
  });
  if (child.error || child.status !== 0) {
    if (child.error) console.error(child.error);
    process.exitCode = 1;
    break;
  }
}
