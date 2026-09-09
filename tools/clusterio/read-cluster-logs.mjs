// Implementation of check-cluster-logs.ps1. User filters never enter a shell command.
import { spawnSync } from "node:child_process";
import { diagnosticLine } from "../shared/diagnostics.mjs";

const filter = new RegExp(process.argv[2] || "error|transfer|import|export|validation", "i");
const lines = Number(process.argv[3] || 30);
const scanLines = Number(process.argv[4] || 20000);
if (!Number.isInteger(scanLines) || scanLines < 200 || scanLines > 100000) throw new Error("ScanLines must be an integer from 200 to 100000");
if (!Number.isInteger(lines) || lines < 1 || lines > 200) throw new Error("Lines must be an integer from 1 to 200");
function read(label, args, pattern = filter) {
	console.log(`\n${label}`);
	try {
		const result = spawnSync("docker", args, { encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"] });
		if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `docker exited ${result.status}`);
		const output = `${result.stdout}\n${result.stderr}`;
		const matches = output.split(/\r?\n/).filter(line => line && pattern.test(line)).slice(-lines);
		if (!matches.length) console.log("No matching records in the scanned window; older records were not searched.");
		for (const line of matches) {
			console.log(diagnosticLine(line));
		}
	} catch (error) {
		console.log(diagnosticLine(`Read failed (${error.status ?? error.code}): ${error.stderr || error.message}`));
		process.exitCode = 1;
	}
}
console.log(`Bounded search: last ${scanLines} raw lines per log file; showing up to ${lines} matches per source. Use -ScanLines to widen the window.`);
read("Controller plugin log", ["exec", "surface-export-controller", "sh", "-c", `tail -n ${scanLines} /clusterio/logs/cluster/cluster-*.log`]);
read("Controller stdout", ["logs", "surface-export-controller", "--tail", String(scanLines)]);
for (const host of [1, 2]) {
	read(`Host ${host} plugin log`, ["exec", `surface-export-host-${host}`, "sh", "-c", `tail -n ${scanLines} /clusterio/logs/host/host-*.log`]);
	read(`Host ${host} Factorio log`, ["exec", `surface-export-host-${host}`, "tail", "-n", String(lines),
		`/clusterio/data/instances/clusterio-host-${host}-instance-1/factorio-current.log`], /./);
}
read("Instance status", ["exec", "surface-export-controller", "npx", "clusterioctl", "--config",
	"/clusterio/tokens/config-control.json", "--log-level", "error", "instance", "list"], /./);
