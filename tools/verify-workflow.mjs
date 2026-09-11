import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { withWorkflowLock } from "./shared/workflow-lock.mjs";
import { runCommand, STAGE_BUFFER_BYTES } from "./shared/command-evidence.mjs";
import { preflightRuntime } from "./tests/preflight-runtime.mjs";
import { sourceIdentity, candidateIdentity } from "./shared/verification-evidence.mjs";

export const contract = { requires: ["canonical checkout", "root dependencies", "Docker"],
  produces: ["serial verification report"], "does not": ["publish artifacts", "deploy to the live cluster"] };
const root = fileURLToPath(new URL("../", import.meta.url));
export function parseOptions(args) {
	const options = {};
	while (args.length) {
		const arg = args.shift();
		assert.ok(["--runtime", "--build-config", "--client-volume", "--acceptance", "--startup"].includes(arg), `Unknown option ${arg}`);
		assert.ok(!(arg in options), `Repeated option ${arg}`);
		options[arg] = ["--acceptance", "--startup"].includes(arg) ? true : args.shift();
		assert.ok(options[arg] && !String(options[arg]).startsWith("--"), `Missing value for ${arg}`);
	}
	assert.ok(!(options["--runtime"] && options["--build-config"]), "Choose an existing runtime or a build config");
	assert.ok(!options["--acceptance"] || ((options["--runtime"] || options["--build-config"]) && options["--client-volume"]),
		"Acceptance needs a runtime/build config and an existing licensed client volume");
	assert.ok(!options["--client-volume"] || options["--acceptance"], "Client volume is only used by acceptance");
	assert.ok(!options["--startup"] || options["--runtime"] || options["--build-config"], "Startup needs a runtime/build config");
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
		const report = { schemaVersion: 2, startedAt: new Date().toISOString(), stages: [],
			provenance: { source: sourceIdentity(root) } };
		const save = () => writeFileSync(join(directory, "result.json"), JSON.stringify(report, null, 2) + "\n");
		const command = (label, args, timeout = 120000) => {
			console.log(`Verifying ${label}`);
			return runCommand(process.execPath, args, { label, cwd: root, timeout, maxBuffer: STAGE_BUFFER_BYTES,
				evidenceFile: join(directory, "commands.jsonl") }).record;
		};
		let runtimePath = options["--runtime"] && resolve(options["--runtime"]);
		const stages = [["offline tests", () => command("offline tests", ["--test", "tests/**/*.test.mjs"])]];
		stages.push(["repository lint", () => {
			console.log("Verifying repository lint");
			return runCommand("pwsh", ["-NoProfile", "-File", join(root, "tools/clusterio/build-plugin.ps1"), "lint"],
				{ label: "repository lint", cwd: root, timeout: 600000, maxBuffer: STAGE_BUFFER_BYTES,
					evidenceFile: join(directory, "commands.jsonl") }).record;
		}]);
		if (options["--build-config"]) stages.push(["runtime build", () => {
			const config = JSON.parse(readFileSync(resolve(options["--build-config"])));
			const keys = ["artifact", "commit", "version", "gateway", "gatewaySha256", "output"];
			for (const key of keys) assert.equal(typeof config[key], "string", `build config needs ${key}`);
			runtimePath = resolve(root, config.output, "runtime.json");
			return command("runtime build", ["tools/release/build-runtime.mjs", ...keys.map(key => config[key])], 1500000);
		}]);
		if (options["--runtime"] || options["--build-config"]) stages.push(["native CLI preflight", () => {
			report.provenance.candidate = candidateIdentity(runtimePath, root); save();
			assert.deepEqual(report.provenance.candidate.recipeDifferences, [], "candidate image recipe differs from checkout");
			return preflightRuntime(JSON.parse(readFileSync(runtimePath)), join(directory, "commands.jsonl"));
		}]);
		const labStage = (label, key, args) => {
			const pointer = join(directory, key + ".json");
			report[key + "Pointer"] = pointer; save();
			try { return command(label, [...args, "--report-pointer", pointer], 1500000); }
			finally {
				try { report[key + "Report"] = JSON.parse(readFileSync(pointer)).path; }
				catch (error) { report[key + "ReportError"] = error.message; }
			}
		};
		if (options["--startup"]) stages.push(["native startup", () => labStage("native startup", "startup",
			["tests/manual/production-profile/startup.mjs", runtimePath])]);
		if (options["--acceptance"]) stages.push(["production acceptance", () => labStage("production acceptance", "acceptance",
			["tests/manual/production-profile/run.mjs", "--run", runtimePath, options["--client-volume"]])]);
		try { await runStages(stages, report, save); report.verdict = "PASS"; }
		catch (error) { report.verdict = "FAIL"; report.error = error.message; process.exitCode = 1; }
		finally {
			try {
				report.provenance.finishedSource = sourceIdentity(root);
				assert.deepEqual(report.provenance.finishedSource, report.provenance.source, "checkout changed during verification");
				if (report.provenance.candidate) assert.deepEqual(candidateIdentity(runtimePath, root), report.provenance.candidate,
					"candidate changed during verification");
			} catch (error) { report.verdict = "FAIL"; report.identityError = error.message; process.exitCode = 1; }
			report.finishedAt = new Date().toISOString(); save(); console.log(`${report.verdict}: ${join(directory, "result.json")}`);
		}
	});
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv.includes("--help")) console.log("node tools/verify-workflow.mjs [--runtime runtime.json | --build-config build.json] [--startup] [--acceptance --client-volume existing-volume]");
	else await main(parseOptions(process.argv.slice(2)));
}
