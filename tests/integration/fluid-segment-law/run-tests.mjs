#!/usr/bin/env node
// Shim: wires the fluid-segment-law INSTRUMENT into the integration suite's auto-discovery.
//
// WHY (2026-08-04 audit): instruments need a standing invocation — the engine-invariants sibling
// sat unrunnable for weeks after a path rot, silently cited as coverage. This one was built to run
// in CI (self-contained scratch platform, zero-leftover check, measured 2.8 s end-to-end), so the
// suite runs it for real rather than merely checking it parses. The instrument stays in
// tests/instruments/ — it is also the hand-run re-measurement tool the api-notes cite.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const instrument = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..", "..", "instruments", "fluid-segment-law", "run-tests.mjs",
);
const result = spawnSync(process.execPath, [instrument], { stdio: "inherit" });
process.exit(result.status ?? 1);
