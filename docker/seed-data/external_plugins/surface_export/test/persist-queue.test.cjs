"use strict";


const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const { enqueueWrite, resetWriteQueuesForTest } = require(path.join(distNode, "lib", "persist-queue.js"));

async function racySafeOutputFile(file, data, openedBarrier) {
	const { dir, name, ext } = path.parse(file);
	const temporary = path.join(dir, `${name}.tmp${ext}`);
	const handle = await fsp.open(temporary, "w");
	if (openedBarrier) {
		await openedBarrier();
	}
	try {
		const chunkSize = Math.ceil(data.length / 8);
		for (let offset = 0; offset < data.length; offset += chunkSize) {
			await handle.write(data.slice(offset, offset + chunkSize));
			await new Promise(resolve => setImmediate(resolve));
		}
	} finally {
		await handle.close();
	}
	await fsp.rename(temporary, file);
}

function tempTarget(label) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `surface-export-${label}-`));
	return path.join(dir, "surface_export_storage.json");
}

function payloads() {
	return [JSON.stringify({ who: "A".repeat(4000) }), JSON.stringify({ who: "B".repeat(4000) })];
}

test("the stub reproduces the real race — UNGUARDED concurrent writes corrupt the target", async () => {
	const file = tempTarget("race-proof");
	const [a, b] = payloads();

	let releaseBOpened;
	const bOpened = new Promise(resolve => { releaseBOpened = resolve; });
	let releaseADone;
	const aDone = new Promise(resolve => { releaseADone = resolve; });

	const writerB = racySafeOutputFile(file, b, () => { releaseBOpened(); return aDone; });
	const writerA = racySafeOutputFile(file, a, () => bOpened);
	const resultA = await writerA.then(() => ({ status: "fulfilled" }), e => ({ status: "rejected", reason: e }));
	releaseADone();
	const resultB = await writerB.then(() => ({ status: "fulfilled" }), e => ({ status: "rejected", reason: e }));
	const results = [resultA, resultB];
	const rejected = results.filter(r => r.status === "rejected");
	const onDisk = fs.readFileSync(file, "utf8");
	const intact = onDisk === a || onDisk === b;

	assert.ok(
		rejected.length > 0 || !intact,
		"unguarded concurrent writes produced neither a rejection nor a corrupt file — the stub is "
		+ "not reproducing safeOutputFile's shared temp path, so the queue tests below prove nothing",
	);
	if (rejected.length > 0) {
		assert.match(String(rejected[0].reason && rejected[0].reason.code), /ENOENT/);
	}
});

test("queued concurrent writes leave exactly one intact payload and no rejection", async () => {
	resetWriteQueuesForTest();
	const file = tempTarget("queued");
	const [a, b] = payloads();

	const results = await Promise.allSettled([
		enqueueWrite(file, () => racySafeOutputFile(file, a)),
		enqueueWrite(file, () => racySafeOutputFile(file, b)),
	]);

	assert.deepEqual(results.map(r => r.status), ["fulfilled", "fulfilled"], "no write may fail");
	const onDisk = fs.readFileSync(file, "utf8");
	assert.ok(onDisk === a || onDisk === b, "target must hold one whole payload, never a mix");
	assert.equal(onDisk, b, "the later-enqueued snapshot must win");
});

test("writes to DIFFERENT paths are not serialised against each other", async () => {
	resetWriteQueuesForTest();
	const first = tempTarget("independent-a");
	const second = tempTarget("independent-b");
	const order = [];

	await Promise.all([
		enqueueWrite(first, async () => {
			order.push("first:start");
			await new Promise(resolve => setImmediate(resolve));
			order.push("first:end");
			await fsp.writeFile(first, "1");
		}),
		enqueueWrite(second, async () => {
			order.push("second:start");
			await new Promise(resolve => setImmediate(resolve));
			order.push("second:end");
			await fsp.writeFile(second, "2");
		}),
	]);

	assert.equal(order[0], "first:start");
	assert.equal(order[1], "second:start", "a different path must not wait for the first to finish");
});

test("a failed write does not poison the writes queued behind it", async () => {
	resetWriteQueuesForTest();
	const file = tempTarget("poison");
	const failure = new Error("disk on fire");

	const first = enqueueWrite(file, async () => { throw failure; });
	const second = enqueueWrite(file, () => fsp.writeFile(file, "written anyway"));

	await assert.rejects(() => first, /disk on fire/, "the failing caller must see its own error");
	await second;
	assert.equal(fs.readFileSync(file, "utf8"), "written anyway");
});

test("every queued write runs — appends are never collapsed", async () => {
	resetWriteQueuesForTest();
	const file = tempTarget("all-run");
	let runs = 0;

	await Promise.all([1, 2, 3, 4, 5].map(n => enqueueWrite(file, async () => {
		runs += 1;
		await fsp.writeFile(file, String(n));
	})));

	assert.equal(runs, 5);
	assert.equal(fs.readFileSync(file, "utf8"), "5");
});
