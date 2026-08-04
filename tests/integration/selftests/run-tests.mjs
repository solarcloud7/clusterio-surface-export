#!/usr/bin/env node
// Shim: wires the in-module SELFTESTS instrument into the integration suite's auto-discovery.
//
// WHY (2026-08-04): the selftests instrument runs every pure-logic self-test registered on the
// remote interface in ONE RCON call, and nothing invoked it. Its own header records how that ends —
// hold_aware_unlock's 26 assertions were dead coverage until the instrument picked them up — and
// the same rot then happened one level up: the instrument itself had no standing caller, so a newly
// registered self-test would report to nobody. The engine-invariants sibling sat unrunnable for
// weeks for exactly this reason.
//
// It is safe as a standing gate: no world, no platform, no transfer, no leftovers — every self-test
// snapshots and restores whatever storage or config it touches inside one synchronous execution.
// The instrument stays in tests/instruments/ because it is also the hand-run tool during an engine
// bump; this file only guarantees it runs.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const instrument = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..", "..", "instruments", "selftests", "run-tests.mjs",
);
const result = spawnSync(process.execPath, [instrument], { stdio: "inherit" });
if (result.error) {
	// A spawn failure (ENOENT etc.) has no child output — surface it, or the runner reports a bare
	// exit 1 with nothing to diagnose.
	console.error(`selftests shim: failed to spawn the instrument at ${instrument}: ${result.error.message}`);
}
process.exit(result.status ?? 1);
