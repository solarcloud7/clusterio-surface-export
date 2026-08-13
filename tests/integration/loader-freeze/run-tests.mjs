#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const instrument = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..", "..", "instruments", "loader-freeze", "run-rung.mjs",
);
const result = spawnSync(process.execPath, [instrument], { stdio: "inherit" });
if (result.error) {
	console.error(`loader-freeze shim: failed to spawn the instrument at ${instrument}: ${result.error.message}`);
}
process.exit(result.status ?? 1);
