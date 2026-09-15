// requires: running configured test cluster and fixture case factories
// produces: fixture verdicts and a nonzero exit status on any failure
// does not: create a disposable cluster or authorize cleanup of original fixtures
import { execFileSync } from "node:child_process";
import { lua, ctl, instanceIds, sleep, docker, HOSTS, REPO_ROOT } from "../../lab-gallery/batch-lifecycle.mjs";
import { runFixtureTransfer } from "./fixture-transfer.mjs";

export async function runFixture(name, cases) {
	try {
		const result = await runFixtureTransfer({ cloneName: `${name}-${Date.now().toString(36)}`, cases },
			{ lua, ctl, instanceIds, sleep, docker, HOSTS, REPO_ROOT,
				storedField: (id, field) => JSON.parse(execFileSync(process.execPath,
					["tools/tests/testkit/cli.mjs", "log", id, "--field", field, "--json"],
					{ encoding: "utf8", timeout: 120_000, cwd: REPO_ROOT })).value });
		if (result.problems.length) throw new Error(result.problems.join("\n"));
		console.log(`${name}: ALL PASS (${result.transferId})`);
	} catch (error) {
		console.error(`${name}: ${error.stack || error}`);
		process.exitCode = 1;
	}
}
