import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, globSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { withWorkflowLock } from "./shared/workflow-lock.mjs";
import { runCommand } from "./shared/command-evidence.mjs";
import { preflightRuntime } from "./tests/preflight-runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export function parseOptions(args) {
	const options = {};
	while (args.length) {
		const arg = args.shift();
		assert.ok(["--runtime", "--build-config", "--client-volume", "--acceptance"].includes(arg), `Unknown option ${arg}`);
		assert.ok(!(arg in options), `Repeated option ${arg}`);
		options[arg] = arg === "--acceptance" ? true : args.shift();
		assert.ok(options[arg] && !String(options[arg]).startsWith("--"), `Missing value for ${arg}`);
	}
	assert.ok(!(options["--runtime"] && options["--build-config"]), "Choose an existing runtime or a build config");
	assert.ok(!options["--acceptance"] || ((options["--runtime"] || options["--build-config"]) && options["--client-volume"]),
		"Acceptance needs a runtime/build config and an existing licensed client volume");
	assert.ok(!options["--client-volume"] || options["--acceptance"], "Client volume is only used by acceptance");
	return options;
}
export async function runStages(stages, report, save) {
	for (const [name, work] of stages) {
		const record = { name, status: "running" }; report.stages.push(record); save();
		const started = performance.now();
		try { record.result = await work(); record.status = "passed"; }
		catch (error) { record.status = "failed"; record.error = error.message; throw error; }
		finally { record.elapsedMs = performance.now() - started; save(); }
	}
}
async function main(options) {
	await withWorkflowLock(async () => {
		const directory = join(root, "ci-artifacts", `verify-${Date.now()}-${randomUUID().slice(0, 8)}`);
		mkdirSync(directory, { recursive: true });
		const report = { schemaVersion: 1, startedAt: new Date().toISOString(), stages: [] };
		const save = () => writeFileSync(join(directory, "result.json"), JSON.stringify(report, null, 2) + "\n");
		const command = (label, args, timeout = 120000) => {
			console.log(`Verifying ${label}`);
			return runCommand(process.execPath, args, { label, cwd: root, timeout,
				evidenceFile: join(directory, "commands.jsonl") }).record;
		};
		let runtimePath = options["--runtime"] && resolve(options["--runtime"]);
		const stages = [["offline tests", () => command("offline tests", ["--test", ...globSync("tests/**/*.test.mjs", { cwd: root })])]];
		if (options["--build-config"]) stages.push(["runtime build", () => {
			const config = JSON.parse(readFileSync(resolve(options["--build-config"])));
			const keys = ["artifact", "commit", "version", "gateway", "gatewaySha256", "output"];
			for (const key of keys) assert.equal(typeof config[key], "string", `build config needs ${key}`);
			runtimePath = resolve(root, config.output, "runtime.json");
			return command("runtime build", ["tools/release/build-runtime.mjs", ...keys.map(key => config[key])], 1500000);
		}]);
		if (options["--runtime"] || options["--build-config"]) stages.push(["native CLI preflight", () =>
			preflightRuntime(JSON.parse(readFileSync(runtimePath)), join(directory, "commands.jsonl"))]);
		if (options["--acceptance"]) stages.push(["production acceptance", () => command("production acceptance",
			["tests/manual/production-profile/run.mjs", "--run", runtimePath, options["--client-volume"]], 1500000)]);
		try { await runStages(stages, report, save); report.verdict = "PASS"; }
		catch (error) { report.verdict = "FAIL"; report.error = error.message; process.exitCode = 1; }
		finally { report.finishedAt = new Date().toISOString(); save(); console.log(`${report.verdict}: ${join(directory, "result.json")}`); }
	});
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv.includes("--help")) console.log("npm run verify -- [--runtime runtime.json | --build-config build.json] [--acceptance --client-volume existing-volume]");
	else await main(parseOptions(process.argv.slice(2)));
}
