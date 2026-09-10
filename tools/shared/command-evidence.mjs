import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { redactDiagnostic } from "./diagnostics.mjs";

// Keep each stream, even on success. Never record argv or environment values.
export function runCommand(file, args, { label = file, evidenceFile, tailChars = 65536, ...options } = {}) {
	const started = performance.now();
	const result = spawnSync(file, args, { encoding: "utf8", timeout: 30000, maxBuffer: 1048576,
		stdio: ["pipe", "pipe", "pipe"], ...options });
	const sanitize = value => redactDiagnostic(value || "")
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED JWT]");
	const stdout = sanitize(result.stdout), stderr = sanitize(result.stderr);
	const record = { label, elapsedMs: performance.now() - started, status: result.status,
		signal: result.signal, errorCode: result.error?.code,
		stdout: stdout.slice(-tailChars), stderr: stderr.slice(-tailChars),
		stdoutTruncated: stdout.length > tailChars, stderrTruncated: stderr.length > tailChars,
		captureIncomplete: Boolean(result.error) };
	if (evidenceFile) appendFileSync(evidenceFile, JSON.stringify(record) + "\n");
	if (result.error || result.status !== 0) {
		const error = new Error(`${label} failed (${result.error?.code || result.signal || result.status}): ${record.stderr.slice(-1600) || record.stdout.slice(-1600)}`);
		error.evidence = record;
		throw error;
	}
	return { stdout: result.stdout || "", stderr: result.stderr || "", record };
}
