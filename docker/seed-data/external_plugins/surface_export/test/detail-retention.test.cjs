"use strict";

/**
 * Which fat detail entries survive the retention window.
 *
 * This is the first DESTRUCTIVE step in the transaction-log work — it deletes detail — so the tests
 * are written around what must never be lost rather than around what is kept:
 *
 *  - a transfer never disappears from the UI, because the audit ledger keeps a row for it
 *    regardless (pinned by transfer-summary-provenance.test.cjs, not here);
 *  - a downloadable export never loses its detail while the payload is still there;
 *  - a burst of failures cannot erase every example of a healthy transfer;
 *  - a missing or nonsense cap keeps EVERYTHING rather than emptying the store.
 */

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

/** n entries, oldest first, ids ascending with savedAt ascending. */
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
	// The file is an array other readers index into; reordering it would be a gratuitous diff for
	// every consumer of the store.
	const all = entries(6);
	const kept = selectRetainedDetail(all, { cap: 3, isPinned: neverPinned, reservedSuccessSlots: 0 });
	const positions = kept.map(e => all.indexOf(e));
	assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("a downloadable export never loses its detail, however old", () => {
	// The Transaction Logs tab offers a Download for exactly these rows. Dropping the detail while
	// the payload is still on disk would revoke a button that was working a moment ago.
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
	// The debug-and-report workflow: a failure is worth far more than an equally old success.
	const all = [
		...entries(8),
		entry(90, { status: "failed", savedAt: 0.5 }),      // OLDER than every success
		entry(91, { status: "cleanup_failed", savedAt: 0.6 }),
	];
	const kept = selectRetainedDetail(all, { cap: 4, isPinned: neverPinned, reservedSuccessSlots: 1 });
	const ids = kept.map(e => e.transferId);
	assert.ok(ids.includes("t90"), "an old failure beats a newer success");
	assert.ok(ids.includes("t91"), "cleanup_failed counts as a failure too");
});

test("a burst of failures cannot erase every healthy example", () => {
	// Without a reserved floor, 100 failures would evict every success — and comparing a reported
	// failure against a known-good run of the same platform is the first thing anyone does.
	const successes = entries(50);
	const failures = Array.from({ length: 200 }, (_u, i) => entry(1000 + i, { status: "failed", savedAt: 1000 + i }));
	const kept = selectRetainedDetail([...successes, ...failures], { cap: 100, isPinned: neverPinned });

	const keptSuccesses = kept.filter(e => e.transferInfo.status === "completed");
	assert.equal(kept.length, 100);
	assert.equal(keptSuccesses.length, RESERVED_SUCCESS_SLOTS,
		`successes must keep their reserved ${RESERVED_SUCCESS_SLOTS} slots against a failure flood`);
});

test("the reserved floor never exceeds what is actually available", () => {
	// Two successes and a flood of failures: reserving 25 must not waste 23 slots on nothing.
	const all = [
		...entries(2),
		...Array.from({ length: 60 }, (_u, i) => entry(1000 + i, { status: "failed", savedAt: 1000 + i })),
	];
	const kept = selectRetainedDetail(all, { cap: 30, isPinned: neverPinned });
	assert.equal(kept.length, 30, "the window must be filled, not left short by an over-eager reservation");
	assert.equal(kept.filter(e => e.transferInfo.status === "completed").length, 2);
});

test("a missing or nonsense cap keeps EVERYTHING", () => {
	// The fail-safe direction for a destructive step. An un-migrated controller has no such config,
	// and `Number(undefined)` is NaN — deleting the whole store because a lookup returned nothing
	// would be the worst possible reading of it.
	const all = entries(500);
	for (const cap of [0, -1, NaN, undefined]) {
		assert.equal(selectRetainedDetail(all, { cap, isPinned: neverPinned }).length, 500,
			`cap=${String(cap)} must not delete anything`);
	}
});

test("pinned entries alone cannot overflow the cap", () => {
	// platformStorage is capped at 20 by max_storage_size, so this is not reachable today — but the
	// selection must stay bounded by its own cap regardless of what the pin predicate claims.
	const all = entries(50);
	const kept = selectRetainedDetail(all, { cap: 10, isPinned: () => true });
	assert.equal(kept.length, 10);
});

// ── Regressions for defects found in review ──────────────────────────────────

test("a small cap does NOT let successes evict every failure", () => {
	// The headline defect. `reserved` was claimed off the top, so at any cap <= 25 successes took the
	// whole window and every failure's detail was deleted — the inverse of the documented priority,
	// reachable by an operator simply lowering the cap as the config text invites.
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
	// isPinned was its own class claiming the window first, justified by max_storage_size's DEFAULT —
	// a bound resting on a different, operator-tunable field. Raise that field and no failure detail
	// survived at all.
	const successes = Array.from({ length: 200 }, (_u, i) => entry(i + 1, { savedAt: i + 1 }));
	const failures = Array.from({ length: 10 }, (_u, i) => entry(900 + i, { status: "failed", savedAt: 0.1 * i }));

	// Every success is downloadable — i.e. max_storage_size raised well above the detail cap.
	const kept = selectRetainedDetail([...successes, ...failures], {
		cap: 100,
		isPinned: e => e.transferInfo.status === "completed",
	});

	assert.equal(kept.length, 100);
	assert.equal(kept.filter(e => e.transferInfo.status === "failed").length, 10,
		"failures keep their share regardless of how many downloadable successes exist");
});

test("within a class, a downloadable entry is preferred over a newer one", () => {
	// Pinning still MEANS something — it is a tiebreak inside the class, not a separate claim.
	const older = entry(1, { savedAt: 1 });
	const newer = Array.from({ length: 10 }, (_u, i) => entry(i + 2, { savedAt: i + 2 }));

	const kept = selectRetainedDetail([older, ...newer], {
		cap: 5,
		isPinned: e => e.transferId === older.transferId,
		reservedSuccessSlots: 0,
	});

	assert.ok(kept.includes(older), "the downloadable entry wins its class despite being oldest");
});
