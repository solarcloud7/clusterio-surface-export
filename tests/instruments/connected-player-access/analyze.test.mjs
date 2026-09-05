import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

test("player evacuation observations reject missed bodies, retained platforms and failed restoration", t => {
	const dir = mkdtempSync(join(tmpdir(), "player-analysis-"));
	assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "report.json");
	const base = { success: true, action: "measure", engine: "2.1.17", cleanup: { ok: true },
		residue: { names: [], view_record: false, inventory_backup: false }, before: { controller: 2 }, after: { controller: 2 },
		arms: [false, true].map(remote_view => ({ remote_view, teleport_into_hidden: true, physical_aboard: true,
			script_remote_view_into_hidden: true, passenger_detected: true, characters_aboard: 1,
			delete_result: "SUCCESS", character_valid: true, character_surface: "nauvis", physical_after: "nauvis",
			platform_remaining: false, lock_remains: false })) };
	const runner = fileURLToPath(new URL("./run-tests.mjs", import.meta.url));
	function run(report) {
		writeFileSync(file, JSON.stringify(report));
		return spawnSync(process.execPath, [runner, "--analyze", file], { encoding: "utf8", timeout: 5000 });
	}
	assert.equal(run(base).status, 0);
	for (const mutate of [
		r => { r.arms[1].passenger_detected = false; },
		r => { r.arms[0].character_valid = false; },
		r => { r.arms[1].physical_after = "platform-1"; },
		r => { r.arms[0].platform_remaining = true; },
		r => { r.arms[1].lock_remains = true; },
		r => { r.after.controller = 7; },
		r => { r.cleanup.ok = false; },
		r => { r.residue.names = ["owned-platform"]; },
		r => { r.residue.inventory_backup = true; },
		r => { r.action = "view"; },
		r => { r.arms = []; },
	]) {
		const report = structuredClone(base);
		mutate(report);
		assert.notEqual(run(report).status, 0);
	}
});
