import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withWorkflowLock } from "../../tools/shared/workflow-lock.mjs";
import { assertControllerBundle } from "../../tools/surface-export/canvas-bundle.mjs";
import { waitForRuntime, compareWorlds, INSTANCE_ROLES } from "../../tools/tests/cluster-readiness.mjs";

test("process exit releases an owned workflow lock without a browser disconnect", t => {
	const dir = mkdtempSync(join(tmpdir(), "workflow-exit-"));
	t.after(() => rmSync(dir, {recursive: true, force: true}));
	const file = join(dir, "lock");
	const module = new URL("../../tools/shared/workflow-lock.mjs", import.meta.url).href;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e",
		`import {acquireWorkflowLock} from ${JSON.stringify(module)}; acquireWorkflowLock(process.argv[1]); process.exit(1);`, file],
		{encoding: "utf8", env: {...process.env, SE_WORKFLOW_TOKEN: ""}});
	assert.equal(child.status, 1, child.stderr);
	assert.equal(existsSync(file), false);
});

test("another process cannot replace artifacts while a workflow owns them; failed work releases ownership", async t => {
	const dir = mkdtempSync(join(tmpdir(), "workflow-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "lock");
	await assert.rejects(withWorkflowLock(async () => {
		await withWorkflowLock(async () => {}, file); // a child stage inherits its parent's ownership
		const module = new URL("../../tools/shared/workflow-lock.mjs", import.meta.url).href;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e",
			`import { acquireWorkflowLock } from ${JSON.stringify(module)}; acquireWorkflowLock(${JSON.stringify(file)});`],
		{ encoding: "utf8", env: { ...process.env, SE_WORKFLOW_TOKEN: "" } });
		assert.notEqual(result.status, 0); assert.match(result.stderr, /already owns/);
		throw new Error("fixture failure");
	}, file), /fixture failure/);
	assert.equal(existsSync(file), false);
});

test("PowerShell shares the browser lock and allows only an inherited deployment stage", {
	skip: spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status !== 0,
}, async t => {
	const dir = mkdtempSync(join(tmpdir(), "workflow-interop-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "lock");
	await withWorkflowLock(async () => {
		const command = '. $env:LOCK_HELPER; Invoke-WorkflowLock -Path $env:LOCK_FIXTURE -Action { "inherited" }';
		const env = { ...process.env, LOCK_FIXTURE: path,
			LOCK_HELPER: fileURLToPath(new URL("../../tools/shared/workflow-lock.ps1", import.meta.url)) };
		const blocked = spawnSync("pwsh", ["-NoProfile", "-Command", command], { encoding: "utf8", env: { ...env, SE_WORKFLOW_TOKEN: "" } });
		assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /already owns/);
		const inherited = spawnSync("pwsh", ["-NoProfile", "-Command", command], { encoding: "utf8", env });
		assert.equal(inherited.status, 0, inherited.stderr); assert.match(inherited.stdout, /inherited/);
		assert.ok(existsSync(path), "nested stage must not release its parent's lock");
	}, path);
});

test("a stale or absent controller bundle fails before browser element waits", async () => {
	const fetcher = async () => ({ ok: true, json: async () => [{ name: "surface_export", web: { main: "static/old.js" } }] });
	await assert.rejects(assertControllerBundle("http://localhost", { expected: "new.js", fetcher }), /advertised static\/old.js/);
	await assertControllerBundle("http://localhost", { expected: "old.js", fetcher });
	await assert.rejects(assertControllerBundle("http://localhost", { expected: "old.js",
		fetcher: async () => ({ ok: true, json: async () => [] }) }), /plugin unavailable/);
});

function probes(version = "fixture") {
	return Object.fromEntries(INSTANCE_ROLES.map(({ instance }) => [instance, {
		iface: true, version, tick: 5, surfaces: ["nauvis"], surfaceCount: 1,
		platforms: ["owned"], platformCount: 1, players: ["engineer"], playerCount: 1,
		playerStates: ["engineer:nauvis:1:2:1"],
	}]));
}
test("runtime readiness waits for a delayed host and identifies the failing instance on timeout", async () => {
	let now = 0, calls = 0;
	const result = await waitForRuntime({ expectedVersion: "fixture", timeoutMs: 3000, now: () => now,
		sleep: async ms => { now += ms; }, probe: () => ++calls < 3 ? {} : probes() });
	assert.equal(calls, 3); assert.ok(result.results.every(r => r.ok));
	await assert.rejects(waitForRuntime({ expectedVersion: "new", timeoutMs: 0, probe: () => probes() }),
		/clusterio-host-1-instance-1: Lua version fixture; expected new/);
});
test("preservation check catches lost platforms and relocated players, but ignores advancing ticks", () => {
	const before = probes(), after = probes();
	after[INSTANCE_ROLES[0].instance].tick++;
	assert.deepEqual(compareWorlds(before, after), []);
	after[INSTANCE_ROLES[0].instance].platforms = [];
	after[INSTANCE_ROLES[1].instance].playerStates = ["engineer:nauvis:99:2:1"];
	assert.equal(compareWorlds(before, after).length, 2);
});
