#!/usr/bin/env node
// Record whole-command elapsed time, including startup, setup and cleanup.
// Usage: node tools/tests/measure-command.mjs result.json -- executable args...
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [output, separator, command, ...args] = process.argv.slice(2);
if (!output || separator !== "--" || !command) {
	throw new Error("Usage: measure-command.mjs result.json -- executable args...");
}
const startedAt = new Date().toISOString();
const start = performance.now();
const child = spawn(command, args, { stdio: "inherit", shell: false });
let spawnError;
child.on("error", error => { spawnError = error.message; });
child.on("close", (code, signal) => {
	const result = {
		startedAt, completedAt: new Date().toISOString(),
		elapsedMs: performance.now() - start, exitCode: code, signal, spawnError,
		measurement: "whole-command monotonic elapsed time",
	};
	writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
	console.log(`Measured command: ${(result.elapsedMs / 1000).toFixed(2)}s; exit ${code}`);
	process.exitCode = code === 0 && !spawnError && !signal ? 0 : 1;
});
