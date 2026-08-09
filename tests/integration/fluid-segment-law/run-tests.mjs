#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const instrument = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..", "..", "instruments", "fluid-segment-law", "run-tests.mjs",
);
const result = spawnSync(process.execPath, [instrument], { stdio: "inherit" });
if (result.error) {
	console.error(`fluid-segment-law shim: failed to spawn the instrument at ${instrument}: ${result.error.message}`);
}
process.exit(result.status ?? 1);
