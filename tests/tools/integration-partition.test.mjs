import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("CI gallery isolation runs every discovered suite exactly once", () => {
	const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
	const commands = [...workflow.matchAll(/node tools\/tests\/run-integration-tests\.mjs --(only|skip) '([^']+)'/g)];
	assert.equal(commands.length, 2);
	function list(args) {
		return [...execFileSync(process.execPath, ["tools/tests/run-integration-tests.mjs", "--list", ...args],
			{ cwd: new URL("../../", import.meta.url), encoding: "utf8" }).matchAll(/• ([\w-]+) \(/g)].map(m => m[1]);
	}
	const all = list([]);
	const partitions = commands.map(([, flag, pattern]) => list([`--${flag}`, pattern]));
	assert.deepEqual(partitions[0], ["gallery-suite"]);
	assert.ok(partitions[1].length > 0);
	assert.deepEqual(partitions.flat().sort(), all.sort());
	assert.equal(new Set(partitions.flat()).size, all.length);
});
