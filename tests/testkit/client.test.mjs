import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClientOptions, verifyVersion, verifyCapture, waitForCapture, cleanupRun } from "../../tools/tests/testkit/client.mjs";

const id = "00000000-0000-4000-8000-000000000000";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=", "base64");

test("client arguments reject arbitrary paths, scenarios and unbounded runs", () => {
	assert.equal(parseClientOptions(["run", "smoke"]).timeoutSeconds, 240);
	for (const args of [["cleanup", "../live"], ["doctor", "extra"], ["run", "arbitrary.lua"],
		["run", "smoke", "--timeout-seconds", "0"], ["run", "smoke", "--scale", "NaN"],
		["run", "smoke", "--resolution", "90000x90000"], ["run", "smoke", "--scale", "1", "--scale", "2"]]) {
		assert.throws(() => parseClientOptions(args));
	}
});

test("client must match the pin and be a full Linux binary", () => {
	assert.equal(verifyVersion("Version: 2.1.17 (build 87315, linux64, full)", "2.1.17"), "2.1.17");
	for (const output of ["Version: 2.0.77 (build 1, linux64, full)", "Version: 2.1.17 (build 1, linux64, headless)", ""]) {
		assert.throws(() => verifyVersion(output, "2.1.17"));
	}
});

test("completion requires matching evidence and complete images", t => {
	const dir = mkdtempSync(join(tmpdir(), "se-client-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const expected = { id, scenario: "smoke", version: "2.1.17", width: 1, height: 1, scale: 1 };
	const marker = { runId: id, scenario: "smoke", status: "captured", engineVersion: "2.1.17",
		resolution: { width: 1, height: 1 }, scale: 1, screenshots: ["smoke.png"] };
	assert.throws(() => verifyCapture(marker, expected, dir), { code: "ENOENT" });
	writeFileSync(join(dir, "smoke.png"), png);
	assert.equal(verifyCapture(marker, expected, dir).length, 1);
	for (const change of [{ runId: "old" }, { engineVersion: "2.0.77" }, { scale: 0.75 },
		{ screenshots: [] }, { screenshots: ["../outside.png"] }, { resolution: { width: 2, height: 1 } }]) {
		assert.throws(() => verifyCapture({ ...marker, ...change }, expected, dir));
	}
	writeFileSync(join(dir, "smoke.png"), png.subarray(0, -1));
	assert.throws(() => verifyCapture(marker, expected, dir), /Incomplete PNG/);
});

test("a clean client exit without captures fails; a living client cannot wait forever", async () => {
	await assert.rejects(waitForCapture({ read: () => null, verify: () => assert.fail(), running: () => false, timeoutMs: 10 }), /stopped/);
	let clock = 0;
	await assert.rejects(waitForCapture({ read: () => null, verify: () => assert.fail(), running: () => true,
		timeoutMs: 10, now: () => clock, pause: async () => { clock += 5; } }), /Timed out/);
});

test("capture polling retries partial writes but rejects incorrect evidence immediately", async () => {
	let reads = 0;
	const result = await waitForCapture({ read: () => { if (++reads === 1) throw new SyntaxError("partial"); return {}; },
		verify: () => "capture", running: () => true, timeoutMs: 10, now: () => 0, pause: async () => {} });
	assert.equal(result, "capture");
	await assert.rejects(waitForCapture({ read: () => ({}), verify: () => { throw new Error("Wrong scale"); },
		running: () => assert.fail("Do not hide invalid evidence behind polling"), timeoutMs: 10 }), /Wrong scale/);
	await assert.rejects(waitForCapture({ read: () => null, running: () => { throw new Error("engine disconnected"); }, timeoutMs: 10 }), /engine disconnected/);
});

test("cleanup rechecks ownership, verifies removal and refuses unrelated containers", () => {
	const name = `se-client-${id}-gui`;
	for (const [listed, owner] of [["surface-export-host-1", id], [name, "other-run"]]) {
		assert.throws(() => cleanupRun(id, args => {
			assert.notEqual(args[0], "rm", "must not delete foreign resources");
			return args[0] === "ps" ? listed : owner;
		}));
	}
	let removed = false;
	const command = args => {
		if (args[0] === "ps") return removed ? "" : name;
		if (args[0] === "container") return id;
		assert.deepEqual(args, ["rm", "-f", name]); removed = true; return name;
	};
	assert.deepEqual(cleanupRun(id, command), { success: true, removed: [name] });
	assert.deepEqual(cleanupRun(id, command), { success: true, removed: [] });
	assert.throws(() => cleanupRun(id, args => args[0] === "container" ? id : name), /remain/);
});
