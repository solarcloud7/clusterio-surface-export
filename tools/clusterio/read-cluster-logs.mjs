// Implementation of check-cluster-logs.ps1. User filters never enter a shell command.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { diagnosticLine } from "../shared/diagnostics.mjs";

export function lineCollector(onLine, maxChars = 64 * 1024) {
	let partial = "", oversized = false, dropped = 0;
	return {
		push(chunk) {
			let start = 0;
			while (start < chunk.length) {
				const newline = chunk.indexOf("\n", start);
				const end = newline === -1 ? chunk.length : newline;
				if (!oversized) {
					if (partial.length + end - start > maxChars) { partial = ""; oversized = true; }
					else partial += chunk.slice(start, end);
				}
				if (newline === -1) break;
				if (oversized) dropped++;
				else onLine(partial.replace(/\r$/, ""));
				partial = ""; oversized = false; start = newline + 1;
			}
		},
		finish() {
			if (oversized) dropped++;
			else if (partial) onLine(partial.replace(/\r$/, ""));
			partial = ""; oversized = false;
			return dropped;
		},
	};
}

export async function readCommandLines(command, args, { pattern = /./, lines = 30, timeout = 15000 } = {}) {
	const matches = [];
	const accept = line => {
		const diagnostic = diagnosticLine(line, 64 * 1024);
		pattern.lastIndex = 0;
		if (diagnostic && pattern.test(diagnostic)) {
			matches.push(diagnostic.slice(0, 800));
			if (matches.length > lines) matches.shift();
		}
	};
	const stdout = lineCollector(accept), stderr = lineCollector(accept);
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
	timer.unref();
	child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
	child.stdout.on("data", chunk => stdout.push(chunk));
	child.stderr.on("data", chunk => stderr.push(chunk));
	let error;
	child.on("error", cause => { error = cause.message; });
	const result = await new Promise(resolve => child.on("close", (status, signal) => {
		clearTimeout(timer);
		resolve({ status, signal });
	}));
	return { ...result, error: timedOut ? `timed out after ${timeout} ms` : error, matches, dropped: stdout.finish() + stderr.finish() };
}

export async function main(args = process.argv.slice(2)) {
	const filter = new RegExp(args[0] || "error|transfer|import|export|validation", "i");
	const lines = Number(args[1] || 30), scanLines = Number(args[2] || 20000);
	if (!Number.isInteger(scanLines) || scanLines < 200 || scanLines > 100000) throw new Error("ScanLines must be an integer from 200 to 100000");
	if (!Number.isInteger(lines) || lines < 1 || lines > 200) throw new Error("Lines must be an integer from 1 to 200");
	async function read(label, commandArgs, pattern = filter) {
		console.log(`\n${label}`);
		const result = await readCommandLines("docker", commandArgs, { pattern, lines });
		for (const line of result.matches) console.log(line);
		if (result.dropped) console.log(`Skipped ${result.dropped} oversized log records (over 65,536 characters per record).`);
		if (result.error || result.status !== 0) {
			console.log(diagnosticLine(`Read failed: ${result.error || (result.signal ? `terminated (${result.signal})` : `docker exited ${result.status}`)}. Search is incomplete.`));
			process.exitCode = 1;
		} else if (!result.matches.length) console.log("No matching records in the scanned window; older records were not searched.");
	}
	console.log(`Bounded search: last ${scanLines} raw lines per log file; showing up to ${lines} matches per source. Use -ScanLines to widen the window.`);
	await read("Controller plugin log", ["exec", "surface-export-controller", "sh", "-c", `tail -n ${scanLines} /clusterio/logs/cluster/cluster-*.log`]);
	await read("Controller stdout", ["logs", "surface-export-controller", "--tail", String(scanLines)]);
	for (const host of [1, 2]) {
		await read(`Host ${host} plugin log`, ["exec", `surface-export-host-${host}`, "sh", "-c", `tail -n ${scanLines} /clusterio/logs/host/host-*.log`]);
		await read(`Host ${host} Factorio log`, ["exec", `surface-export-host-${host}`, "tail", "-n", String(lines),
			`/clusterio/data/instances/clusterio-host-${host}-instance-1/factorio-current.log`], /./);
	}
	await read("Instance status", ["exec", "surface-export-controller", "npx", "clusterioctl", "--config",
		"/clusterio/tokens/config-control.json", "--log-level", "error", "instance", "list"], /./);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
