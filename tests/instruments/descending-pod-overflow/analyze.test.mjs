import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

test("saved pod observations reject cargo loss, changed hub contents, wrong states and incomplete cleanup", t => {
	const dir = mkdtempSync(join(tmpdir(), "pod-analysis-"));
	assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "report.json");
	const base = { success: true, engine: "2.1.17", cleanup: { ok: true, remainingSurfaces: [], remainingPlatforms: [] }, arms: [false, true].map(full => ({
		full, state: "descending", before: { copper: 100, hubIron: full ? 5900 : 0 },
		after: { pods: 0, hubIron: full ? 5900 : 0, hubCopper: full ? 0 : 100, groundCopper: full ? 100 : 0 },
	})) };
	const runner = fileURLToPath(new URL("./run-tests.mjs", import.meta.url));
	function run(report) {
		writeFileSync(file, JSON.stringify(report));
		return spawnSync(process.execPath, [runner, "--analyze", file], { encoding: "utf8", timeout: 5000 });
	}
	assert.equal(run(base).status, 0);
	for (const mutate of [
		r => { r.arms[1].after.groundCopper = 99; },
		r => { r.arms[1].after.hubIron = 5800; },
		r => { r.arms[0].after.pods = 1; },
		r => { r.arms[0].state = "awaiting_launch"; },
		r => { r.cleanup.ok = false; },
		r => { r.cleanup.remainingSurfaces = ["owned-surface"]; },
		r => { r.cleanup.remainingPlatforms = [{ name: "owned-platform", index: 1 }]; },
		r => { r.arms = []; },
	]) {
		const report = structuredClone(base);
		mutate(report);
		assert.notEqual(run(report).status, 0);
	}
});
