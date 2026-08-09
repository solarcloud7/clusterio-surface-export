"use strict";


const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const { selectRetainedDetail, RESERVED_SUCCESS_SLOTS } = require(path.join(distNode, "lib", "detail-retention.js"));

const neverPinned = () => false;

function entry(id, { status = "completed", savedAt = id, exportId = null } = {}) {
	return {
		transferId: `t${id}`,
		savedAt,
		events: [],
		transferInfo: { status, exportId, platformName: `pad-${id}`, startedAt: savedAt },
	};
}

function entries(n, opts = {}) {
	return Array.from({ length: n }, (_unused, i) => entry(i + 1, { ...opts, savedAt: i + 1 }));
}

test("under the cap nothing is dropped", () => {
	const all = entries(10);
	assert.deepEqual(selectRetainedDetail(all, { cap: 100, isPinned: neverPinned }), all);
});

test("over the cap it keeps exactly the cap, newest first", () => {
	const all = entries(10);
	const kept = selectRetainedDetail(all, { cap: 4, isPinned: neverPinned, reservedSuccessSlots: 0 });
	assert.equal(kept.length, 4);
	assert.deepEqual(kept.map(e => e.transferId), ["t7", "t8", "t9", "t10"], "the newest survive");
});

test("retained entries keep their ORIGINAL order, not selection order", () => {
	const all = entries(6);
	const kept = selectRetainedDetail(all, { cap: 3, isPinned: neverPinned, reservedSuccessSlots: 0 });
	const positions = kept.map(e => all.indexOf(e));
	assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("a downloadable export never loses its detail, however old", () => {
	const all = entries(20);
	const oldestId = all[0].transferId;
	const kept = selectRetainedDetail(all, {
		cap: 5,
		isPinned: e => e.transferId === oldestId,
		reservedSuccessSlots: 0,
	});
	assert.ok(kept.some(e => e.transferId === oldestId), "the pinned entry must survive eviction");
	assert.equal(kept.length, 5);
});

test("failures outrank successes for the remaining slots", () => {
	const all = [
		...entries(8),
		entry(90, { status: "failed", savedAt: 0.5 }),
		entry(91, { status: "cleanup_failed", savedAt: 0.6 }),
	];
	const kept = selectRetainedDetail(all, { cap: 4, isPinned: neverPinned, reservedSuccessSlots: 1 });
	const ids = kept.map(e => e.transferId);
	assert.ok(ids.includes("t90"), "an old failure beats a newer success");
	assert.ok(ids.includes("t91"), "cleanup_failed counts as a failure too");
});

test("a burst of failures cannot erase every healthy example", () => {
	const successes = entries(50);
	const failures = Array.from({ length: 200 }, (_u, i) => entry(1000 + i, { status: "failed", savedAt: 1000 + i }));
	const kept = selectRetainedDetail([...successes, ...failures], { cap: 100, isPinned: neverPinned });

	const keptSuccesses = kept.filter(e => e.transferInfo.status === "completed");
	assert.equal(kept.length, 100);
	assert.equal(keptSuccesses.length, RESERVED_SUCCESS_SLOTS,
		`successes must keep their reserved ${RESERVED_SUCCESS_SLOTS} slots against a failure flood`);
});

test("the reserved floor never exceeds what is actually available", () => {
	const all = [
		...entries(2),
		...Array.from({ length: 60 }, (_u, i) => entry(1000 + i, { status: "failed", savedAt: 1000 + i })),
	];
	const kept = selectRetainedDetail(all, { cap: 30, isPinned: neverPinned });
	assert.equal(kept.length, 30, "the window must be filled, not left short by an over-eager reservation");
	assert.equal(kept.filter(e => e.transferInfo.status === "completed").length, 2);
});

test("a missing or nonsense cap keeps EVERYTHING", () => {
	const all = entries(500);
	for (const cap of [0, -1, NaN, undefined]) {
		assert.equal(selectRetainedDetail(all, { cap, isPinned: neverPinned }).length, 500,
			`cap=${String(cap)} must not delete anything`);
	}
});

test("pinned entries alone cannot overflow the cap", () => {
	const all = entries(50);
	const kept = selectRetainedDetail(all, { cap: 10, isPinned: () => true });
	assert.equal(kept.length, 10);
});


test("a small cap does NOT let successes evict every failure", () => {
	const successes = Array.from({ length: 40 }, (_u, i) => entry(i + 1, { savedAt: i + 1 }));
	const failures = Array.from({ length: 5 }, (_u, i) => entry(900 + i, { status: "failed", savedAt: 0.1 * i }));

	const kept = selectRetainedDetail([...successes, ...failures], { cap: 20, isPinned: neverPinned });

	assert.equal(kept.length, 20);
	assert.equal(kept.filter(e => e.transferInfo.status === "failed").length, 5,
		"every failure must survive a cap of 20 — they are older than every success and still outrank them");
});

test("the guarantee holds at the smallest allowed cap", () => {
	const successes = Array.from({ length: 30 }, (_u, i) => entry(i + 1, { savedAt: i + 1 }));
	const failures = Array.from({ length: 8 }, (_u, i) => entry(900 + i, { status: "failed", savedAt: 0.1 * i }));

	const kept = selectRetainedDetail([...successes, ...failures], { cap: 10, isPinned: neverPinned });

	assert.equal(kept.length, 10);
	const keptFailures = kept.filter(e => e.transferInfo.status === "failed").length;
	const keptSuccesses = kept.length - keptFailures;
	assert.ok(keptFailures > 0, "failures must not be wiped out");
	assert.ok(keptSuccesses > 0, "nor may successes be — both classes survive a tiny window");
});

test("downloadable entries cannot starve the other classes", () => {
	const successes = Array.from({ length: 200 }, (_u, i) => entry(i + 1, { savedAt: i + 1 }));
	const failures = Array.from({ length: 10 }, (_u, i) => entry(900 + i, { status: "failed", savedAt: 0.1 * i }));

	const kept = selectRetainedDetail([...successes, ...failures], {
		cap: 100,
		isPinned: e => e.transferInfo.status === "completed",
	});

	assert.equal(kept.length, 100);
	assert.equal(kept.filter(e => e.transferInfo.status === "failed").length, 10,
		"failures keep their share regardless of how many downloadable successes exist");
});

test("within a class, a downloadable entry is preferred over a newer one", () => {
	const older = entry(1, { savedAt: 1 });
	const newer = Array.from({ length: 10 }, (_u, i) => entry(i + 2, { savedAt: i + 2 }));

	const kept = selectRetainedDetail([older, ...newer], {
		cap: 5,
		isPinned: e => e.transferId === older.transferId,
		reservedSuccessSlots: 0,
	});

	assert.ok(kept.includes(older), "the downloadable entry wins its class despite being oldest");
});
