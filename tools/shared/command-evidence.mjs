import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { redactDiagnostic } from "./diagnostics.mjs";

export const contract = { requires: ["synchronous executable"], produces: ["bounded redacted command evidence"],
	"does not": ["record argv, stdin or environment options", "guarantee arbitrary output contains no secrets"] };
export const STAGE_BUFFER_BYTES = 16 * 1024 * 1024;

export function projectInspection(file, args, stdout, stderr) {
	if (!/^docker(?:\.exe)?$/i.test(basename(file)) || !(args[0] === "inspect"
		|| (["container", "image", "volume", "network"].includes(args[0]) && args[1] === "inspect"))) return { stdout, stderr };
	let projected = "[formatted Docker inspection omitted]";
	try {
		const values = JSON.parse(stdout);
		if (Array.isArray(values)) projected = JSON.stringify(values.map(value => ({
			id: /^(?:sha256:)?[a-f0-9]{64}$/.test(value?.Id) ? value.Id : undefined,
			image: /^sha256:[a-f0-9]{64}$/.test(value?.Image) ? value.Image : undefined,
			running: typeof value?.State?.Running === "boolean" ? value.State.Running : undefined,
			exitCode: Number.isInteger(value?.State?.ExitCode) ? value.State.ExitCode : undefined,
			mountCount: Array.isArray(value?.Mounts) ? value.Mounts.length : undefined,
		})));
	} catch (error) { if (!(error instanceof SyntaxError)) throw error; }
	return { stdout: projected, stderr: stderr ? "[Docker inspection stderr omitted]" : "" };
}

function retain(file, record, limit) {
	const line = JSON.stringify(record) + "\n";
	assert.ok(Buffer.byteLength(line) < limit / 2, "evidence record exceeds retention budget");
	if (!existsSync(file) || statSync(file).size + Buffer.byteLength(line) <= limit) {
		appendFileSync(file, line); return;
	}
	const lines = readFileSync(file, "utf8").trimEnd().split("\n");
	const first = JSON.parse(lines[0]);
	let droppedRecords = first.type === "retention" ? (lines.shift(), first.droppedRecords) : 0;
	let bytes = lines.reduce((sum, entry) => sum + Buffer.byteLength(entry) + 1, 0);
	while (bytes > Math.min(limit / 2, limit - Buffer.byteLength(line) - 128)) {
		bytes -= Buffer.byteLength(lines.shift()) + 1; droppedRecords++;
	}
	writeFileSync(file, JSON.stringify({ type: "retention", droppedRecords }) + "\n" + lines.join("\n") + "\n" + line);
}

export function runCommand(file, args, { label = file, evidenceFile, tailChars = 8192,
	maxEvidenceBytes = 4 * 1024 * 1024, ...options } = {}) {
	assert.ok(Number.isSafeInteger(tailChars) && tailChars >= 0 && Number.isSafeInteger(maxEvidenceBytes) && maxEvidenceBytes >= 16384);
	const started = performance.now();
	const result = spawnSync(file, args, { encoding: "utf8", timeout: 30000, maxBuffer: 1048576,
		stdio: ["pipe", "pipe", "pipe"], ...options });
	const sanitize = value => redactDiagnostic(value || "")
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED JWT]");
	const projected = projectInspection(file, args, result.stdout || "", result.stderr || "");
	const stdout = sanitize(projected.stdout), stderr = sanitize(projected.stderr);
	const tail = Math.min(tailChars, Math.floor(maxEvidenceBytes / 32));
	const record = { label, elapsedMs: performance.now() - started, status: result.status,
		signal: result.signal, errorCode: result.error?.code,
		stdout: tail ? stdout.slice(-tail) : "", stderr: tail ? stderr.slice(-tail) : "",
		stdoutTruncated: stdout.length > tail, stderrTruncated: stderr.length > tail,
		captureIncomplete: Boolean(result.error) };
	if (evidenceFile) retain(resolve(evidenceFile), record, maxEvidenceBytes);
	if (result.error || result.status !== 0) {
		const error = new Error(`${label} failed (${result.error?.code || result.signal || result.status}): ${record.stderr.slice(-1600) || record.stdout.slice(-1600)}`);
		error.evidence = record;
		throw error;
	}
	return { stdout: result.stdout || "", stderr: result.stderr || "", record };
}
