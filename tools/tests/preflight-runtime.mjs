import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runCommand } from "../shared/command-evidence.mjs";

export function preflightRuntime(runtime, evidenceFile) {
	const results = [];
	for (const role of ["controller", "host"]) {
		const image = runtime.images[role];
		assert.match(image, /^sha256:[a-f0-9]{64}$/);
		const name = `se-cli-${randomUUID()}`;
		const docker = args => runCommand("docker", args, { label: `cli-preflight-${role}`, evidenceFile,
			timeout: 90000 }).stdout.trim();
		const script = fileURLToPath(new URL("cli-preflight.cjs", import.meta.url));
		let created = false;
		try {
			docker(["create", "--name", name, "--label", `surface-export.preflight=${name}`, "--network", "none",
				"--user", "clusterio", "--mount", `type=bind,src=${script},dst=/preflight.cjs,readonly`,
				"--entrypoint", "node", image, "/preflight.cjs", role]);
			created = true;
			const output = docker(["start", "-a", name]);
			const [info] = JSON.parse(docker(["inspect", name]));
			assert.equal(info.State.ExitCode, 0, output);
			results.push({ image, ...JSON.parse(output) });
		} finally {
			if (created) {
				const [info] = JSON.parse(docker(["inspect", name]));
				assert.equal(info.Config.Labels["surface-export.preflight"], name);
				docker(["rm", "-f", name]);
			}
		}
	}
	return results;
}
