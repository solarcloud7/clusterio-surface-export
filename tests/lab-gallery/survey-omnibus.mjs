// Read-only recon: launch the isolated Factorio on a seed save and dump the golden omnibus
// platform's rendering texts + entities (survey_omnibus op) as JSON on stdout. Used to map the
// legacy fixture zones for the pad migration; never touches the cluster.
//
// Usage:
//   node tests/lab-gallery/survey-omnibus.mjs --seed docker/seed-data/lab-saves/lab-gallery-source-surface-export-2.0.77.zip

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	launchIsolatedFactorio, runtimeCall, tailFactorioLog,
	teardownIsolatedFactorio, waitForRuntime,
} from "./isolated-factorio.mjs";

const REMOTE_ROOT = "/tmp/surface-export-lab-gallery-survey";
const PORTS = { gamePort: "34977", rconPort: "27977", rconPassword: "survey-only" };

async function main() {
	let seed = null;
	let container = "surface-export-host-2";
	for (let index = 2; index < process.argv.length; index += 1) {
		const argument = process.argv[index];
		if (argument === "--seed") seed = process.argv[++index];
		else if (argument === "--container") container = process.argv[++index];
		else throw new Error(`unknown argument ${argument}`);
	}
	if (!seed || !existsSync(seed)) throw new Error(`--seed <save.zip> required and must exist (got ${seed})`);

	const opsLua = fileURLToPath(new URL("./seed-prep-ops.lua", import.meta.url));
	const driver = fileURLToPath(new URL("./runtime-driver.cjs", import.meta.url));
	const config = fileURLToPath(new URL("./seed-prep-config.ini", import.meta.url));

	const handle = launchIsolatedFactorio({
		container, remoteRoot: REMOTE_ROOT,
		seed, config,
		files: [[driver, "runtime-driver.cjs"], [opsLua, "ops.lua"]],
		timeoutSeconds: 600,
		...PORTS,
	});
	const boundaryErrors = [];
	try {
		await waitForRuntime(handle, PORTS, { operation: "preflight" });
		const survey = runtimeCall(handle, PORTS, { operation: "survey_omnibus" });
		console.log(JSON.stringify(survey, null, 1));
	} catch (error) {
		try { console.error(`isolated Factorio tail:\n${tailFactorioLog(handle)}`); } catch { /* early death */ }
		throw error;
	} finally {
		await teardownIsolatedFactorio(handle, boundaryErrors);
	}
	if (boundaryErrors.length) throw new AggregateError(boundaryErrors, "survey passed but the teardown boundary was not clean");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(error); process.exitCode = 1; });
}
