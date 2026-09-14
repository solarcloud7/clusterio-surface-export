import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import vm from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlatformTransfer } from "../../tools/surface-export/platform-transfer.mjs";

function rig({ lostReply = false, failed = false, replaced = false } = {}) {
	const source = { platform_index: 21, platform_uid: "source-uid", surface_index: 121, force_name: "player" };
	const destination = { platform_index: 31, platform_uid: "destination-uid", surface_index: 131, force_name: "player" };
	const calls = [];
	let started = false, elapsed = 0;
	const io = { instanceIds: () => ({ 1: 123, 2: 456 }), now: () => elapsed,
		sleep: async ms => { elapsed += ms; },
		lua: (host, body) => {
			calls.push(body);
			if (body.includes("platforms=remote.call")) return { success: true, platforms: !started ? [source]
				: host === 1 ? [] : [{ ...destination, ...(replaced ? { platform_uid: "replacement" } : {}) }] };
			if (body.includes("'export_platform'")) {
				assert.match(body, /source-uid/);
				started = true;
				if (lostReply) throw new Error("lost acknowledgement");
				return { success: true, jobId: "owned-job" };
			}
			if (body.includes("destination_live")) return { success: true, receipt: { ...destination, transfer_id: "123:owned-job" } };
			throw new Error(`unexpected mutation: ${body}`);
		},
		ctl: () => JSON.stringify([{ transferId: "unrelated", status: "completed" }, { transferId: "123:owned-job",
			operationType: "transfer", sourceInstanceId: 123, targetInstanceId: 456,
			status: elapsed < 6000 ? "in_progress" : failed ? "failed" : "completed", completedAt: 100,
			...(failed ? { error: "validation refused" } : {}) }]),
	};
	return { io, calls, destination, elapsed: () => elapsed };
}

test("manual transfer waits past five seconds and retains the selected platform at destination", async () => {
	const r = rig();
	const result = await runPlatformTransfer({ platformIndex: 21, direction: "1to2", timeoutMs: 9000 }, r.io);
	assert.equal(result.transferId, "123:owned-job");
	assert.deepEqual(result.destination, r.destination);
	assert.equal(r.elapsed(), 6000);
	assert.equal(r.calls.filter(body => body.includes("'export_platform'")).length, 1);
});

for (const [settings, error] of [[{ lostReply: true }, /lost acknowledgement/], [{ failed: true }, /validation refused/],
	[{ replaced: true }, /Destination platform_uid changed/]]) {
	test(`manual transfer preserves uncertainty: ${Object.keys(settings)[0]}`, async () => {
		const r = rig(settings);
		await assert.rejects(runPlatformTransfer({ platformIndex: 21, direction: "1to2", timeoutMs: 9000 }, r.io), error);
		assert.equal(r.calls.filter(body => body.includes("'export_platform'")).length, 1);
	});
}

test("integration caller cannot sweep either platform after its transfer reply is lost", async () => {
	for (const suite of ["inventory-item-state", "belt-item-state", "config-attrs"]) {
		const syntax = spawnSync(process.execPath, ["--check", `tests/integration/${suite}/run-tests.mjs`], { encoding: "utf8" });
		assert.equal(syntax.status, 0, syntax.stderr);
	}
	const source = readFileSync(new URL("../integration/inventory-item-state/run-tests.mjs", import.meta.url), "utf8");
	const main = source.slice(source.indexOf("async function main() {"), source.indexOf("main().then(() =>"));
	const deletions = [];
	const sandbox = {
		CLONE: "invstate-test", SOURCE_HOST: 1, DEST_HOST: 2, FIXTURE: "fixture", REPO_ROOT: ".", BP_EXPECT: "expected", READBACK_LUA: "readback",
		say() {}, fail() {}, pass() {}, console, sleep: async () => {}, platformLua: () => "", findPlatformIndex: () => 21,
		cloneFixture: async () => ({ platform_index: 22, platform_uid: "fixture-uid", surface_index: 122, force_name: "player" }),
		buildAndArm: () => ({ chest: "chest", book_slots: 2 }),
		cleanupProbe: (...args) => { deletions.push(args); },
		lua: (host, body) => {
			if (body.includes("game.delete_surface")) deletions.push([host, body]);
			return { bp: { key: "expected" }, book: { filled: 2 }, deleted: 1, paused: false };
		},
		instanceIds: () => ({ 1: 123, 2: 456 }), ctl() {},
		transferPlatform: ({ platform }) => {
			assert.equal(platform.platform_uid, "fixture-uid", "transfer must retain clone identity instead of selecting by index again");
			throw new Error("lost status reply after admission");
		},
	};
	await assert.rejects(vm.runInNewContext(main + "main()", sandbox), /lost status reply/);
	assert.equal(deletions.length, 0);
});

test("manual PowerShell transfer propagates observation failure instead of a five-second success", {
	skip: spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status !== 0,
}, t => {
	const dir = mkdtempSync(join(tmpdir(), "manual-transfer-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "surface-export")); mkdirSync(join(dir, "shared"));
	copyFileSync(new URL("../../tools/surface-export/transfer-platform.ps1", import.meta.url), join(dir, "surface-export/transfer-platform.ps1"));
	writeFileSync(join(dir, "shared/cluster-utils.ps1"), `
function Get-InstanceByHostNumber { param($n) @{Name="instance-$n";Id=[int]$n} }
function Send-RCON { 'Export queued: simulated-job' }
function Start-Sleep {}
`);
	writeFileSync(join(dir, "surface-export/list-platforms.ps1"), "'No arrival observed'");
	const result = spawnSync("pwsh", ["-NoProfile", "-Command", `
function node { $global:LASTEXITCODE=17; 'Transfer status unavailable' }
& $env:TRANSFER_SCRIPT -PlatformIndex 21 -Direction 1to2
exit $LASTEXITCODE
`], { encoding: "utf8", env: { ...process.env, TRANSFER_SCRIPT: join(dir, "surface-export/transfer-platform.ps1") } });
	assert.equal(result.status, 17, result.stdout + result.stderr);
});
