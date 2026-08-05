"use strict";

/**
 * The concurrent-write race on the controller's database files, and the queue that closes it.
 *
 * THE INSTRUMENT IS THE HARD PART. `@clusterio/lib`'s real `safeOutputFile` writes to a temp path
 * DERIVED FROM THE TARGET (`${name}.tmp${ext}`) and then renames it. Two overlapping writes to one
 * target therefore share one temp file, interleave, and end with one rename publishing mixed bytes
 * while the other throws ENOENT.
 *
 * The stub in `persistence-read-failure.test.cjs` is `(file, data) => fs.writeFileSync(file, data)` —
 * atomic, single-syscall, no temp file. Against that stub this entire bug is invisible and every
 * assertion below would pass on unfixed code. So the stub here reproduces the real formula and
 * writes in chunks with a yield between them, and the FIRST test proves the stub can still see the
 * defect. Without that proof the rest of this file is decoration.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const { enqueueWrite, resetWriteQueuesForTest } = require(path.join(distNode, "lib", "persist-queue.js"));

/**
 * Faithful stand-in for `@clusterio/lib`'s safeOutputFile, pinned against the implementation read at
 * /clusterio/node_modules/@clusterio/lib/dist/node/src/file_ops.js:155-172 (alpha.27):
 *   const { dir, name, ext } = path.parse(file);
 *   const temporary = path.join(dir, `${name}.tmp${ext}`);
 *   await fs.writeFile(temporary, data, { flush: true });
 *   await fs.rename(temporary, file);
 *
 * The chunking + yield is the only deliberate divergence. The real `writeFile` is also not atomic
 * for a payload of this size, but it does not hand control back at a point this test can rely on;
 * chunking makes the same interleaving deterministic instead of timing-dependent.
 */
async function racySafeOutputFile(file, data) {
	const { dir, name, ext } = path.parse(file);
	const temporary = path.join(dir, `${name}.tmp${ext}`);
	const handle = await fsp.open(temporary, "w");
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

/** Two payloads that are the same length and trivially distinguishable, so a mix is detectable. */
function payloads() {
	return [JSON.stringify({ who: "A".repeat(4000) }), JSON.stringify({ who: "B".repeat(4000) })];
}

test("the stub reproduces the real race — UNGUARDED concurrent writes corrupt the target", async () => {
	// This is the test that licenses every other test in this file. If concurrent unguarded writes
	// come out clean here, the stub is not modelling safeOutputFile and the queue tests below would
	// pass whether or not the queue works.
	const file = tempTarget("race-proof");
	const [a, b] = payloads();

	const results = await Promise.allSettled([racySafeOutputFile(file, a), racySafeOutputFile(file, b)]);
	const rejected = results.filter(r => r.status === "rejected");
	const onDisk = fs.readFileSync(file, "utf8");
	const intact = onDisk === a || onDisk === b;

	assert.ok(
		rejected.length > 0 || !intact,
		"unguarded concurrent writes produced neither a rejection nor a corrupt file — the stub is "
		+ "not reproducing safeOutputFile's shared temp path, so the queue tests below prove nothing",
	);
	// Name which symptom fired, because both are real and they have very different severity:
	// a rejection is the loud ENOENT we saw in the logs; a corrupt file is the silent one.
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
	// Enqueue order is write order, so the second write is the survivor. This is the property the
	// callers depend on: each serialises a full snapshot immediately before enqueueing, so
	// last-enqueued must equal most-recent-state.
	assert.equal(onDisk, b, "the later-enqueued snapshot must win");
});

test("writes to DIFFERENT paths are not serialised against each other", async () => {
	// Guards against the lazy fix of one global chain: correctness would survive it, throughput
	// would not, and a single global lock would make every database file wait on every other.
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
	// The chain advances on SETTLEMENT, not on success. A transient failure (full disk, EBUSY) must
	// not silently stop every later persist for the life of the process.
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
	// Snapshot writes could in principle be coalesced (each carries the whole state), but nothing
	// here does that, and an append-style writer would be silently corrupted by it. Pin the
	// no-coalescing behaviour now so a later optimisation has to confront this test.
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
