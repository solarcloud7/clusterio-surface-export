import test from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";

import { driftStatus, shArgv, INSTANCE_BANNER_SCRIPT } from "../../tools/clusterio/check-cluster-drift.mjs";

test("an instance directory name is passed to sh as an argument, never spliced into the script", () => {
	const name = "Dev One; touch /tmp/pwned $(id)";
	const argv = shArgv("surface-export-host-1", INSTANCE_BANNER_SCRIPT, name);
	assert.deepEqual(argv, ["exec", "surface-export-host-1", "sh", "-c", INSTANCE_BANNER_SCRIPT, "sh", name]);
	assert.equal(INSTANCE_BANNER_SCRIPT.includes(name), false);
	assert.deepEqual(shArgv("c", "ls"), ["exec", "c", "sh", "-c", "ls"]);
});

test("the banner script reads the log of the named instance, including names with spaces", { skip: spawnSync("sh", ["-c", "exit 0"]).status !== 0 }, () => {
	const script = INSTANCE_BANNER_SCRIPT.replace("/clusterio/data/instances/$1", "$1");
	const echo = spawnSync("sh", ["-c", script.replace("head -1", "echo"), "sh", "Dev One; exit 7"], { encoding: "utf8" });
	assert.deepEqual([echo.status, echo.stdout.trim()], [0, "Dev One; exit 7/factorio-current.log"]);
});


test("disk newer than the load moment is STALE", () => {
	assert.equal(driftStatus(1_000, 2_000), "STALE");
	assert.equal(driftStatus(Date.parse("2026-08-08T22:41:16Z"), Date.parse("2026-08-09T22:27:16Z")), "STALE",
		"the 23.8h Lua drift measured on this cluster 2026-08-09");
});

test("loading after the newest source is FRESH, including a same-instant load", () => {
	assert.equal(driftStatus(2_000, 1_000), "FRESH");
	assert.equal(driftStatus(Date.parse("2026-08-09T23:46:08Z"), Date.parse("2026-08-09T23:46:05Z")), "FRESH");
	assert.equal(driftStatus(1_000, 1_000), "FRESH", "loaded exactly at the source's mtime still has it");
});

test("an unreadable timestamp is UNKNOWN, never FRESH", () => {
	for (const [loaded, disk] of [[null, 1_000], [1_000, null], [null, null], [NaN, 1_000], [1_000, NaN], [undefined, 1_000]]) {
		assert.equal(driftStatus(loaded, disk), "UNKNOWN",
			`driftStatus(${String(loaded)}, ${String(disk)}) must not claim freshness it did not measure`);
	}
});

test("importing the tool does not shell out", () => {
	assert.equal(typeof driftStatus, "function");
});
