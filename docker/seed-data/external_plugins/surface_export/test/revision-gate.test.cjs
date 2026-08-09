"use strict";

/**
 * Live-update ordering across a controller restart.
 *
 * The web page gates every tree/transfer/log update on a revision watermark, and the controller's
 * revision counters start from zero each time it boots. A page that keeps its watermark across a
 * reconnect therefore measures a new session's revisions against an old session's high-water mark
 * and drops them — the observed symptom (2026-08-08) was an instance rendered offline in the
 * Gateways canvas while the cluster reported it connected and running, healing only on a manual
 * page reload.
 *
 * The rule lives in shared/ rather than web/ because `npm test` runs against dist/node, which the
 * web tree is excluded from. What the pure rule cannot reach — that the page actually clears the
 * watermarks on reconnect, and that the snapshot fetch advances them — is pinned against the
 * source below.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const { freshRevisionWatermarks, isFreshRevision } = require(path.join(distNode, "shared", "revision-gate.js"));

const webIndex = fs.readFileSync(path.join(__dirname, "..", "web", "index.tsx"), "utf8");

/** The page's apply-loop, reduced to the decision under test. */
function applySequence(revisions, watermark = 0) {
	const applied = [];
	for (const revision of revisions) {
		if (isFreshRevision(revision, watermark)) {
			applied.push(revision);
			watermark = revision;
		}
	}
	return { applied, watermark };
}

test("only a strictly newer revision is applied", () => {
	assert.equal(isFreshRevision(2, 1), true, "newer must apply");
	assert.equal(isFreshRevision(1, 1), false, "a repeat of the applied revision must not re-apply");
	assert.equal(isFreshRevision(1, 2), false, "an older revision must not overwrite a newer one");
});

test("a revision that carries no order is refused, not applied", () => {
	// `Number(undefined) > watermark` is false for NaN, but so is `NaN <= watermark` — a bare
	// comparison lets an unorderable revision through in one direction and not the other.
	for (const value of [undefined, null, "", "abc", NaN, Infinity, -Infinity, {}]) {
		assert.equal(isFreshRevision(value, 0), false, `${String(value)} carries no order`);
	}
});

test("a reconnected session starts with every channel cleared", () => {
	assert.deepEqual(freshRevisionWatermarks(), {
		lastTreeRevision: 0,
		lastTransferRevision: 0,
		lastLogRevision: 0,
	}, "all three live channels share the session boundary — clearing one is not enough");
});

test("within one session, exactly the increasing revisions are applied", () => {
	// Duplicates and reordered arrivals are dropped; the watermark only ever climbs.
	const { applied, watermark } = applySequence([1, 2, 2, 5, 3, 6]);
	assert.deepEqual(applied, [1, 2, 5, 6]);
	assert.equal(watermark, 6);
});

test("across a session boundary, the new session's revisions are applied", () => {
	// This is the defect. The controller's counter restarts at 1 while the page still holds 47.
	const beforeRestart = applySequence([45, 46, 47]);
	assert.equal(beforeRestart.watermark, 47);

	const carriedOver = applySequence([1, 2, 3], beforeRestart.watermark);
	assert.deepEqual(carriedOver.applied, [], "carrying the watermark across a restart drops the new session entirely");

	const cleared = applySequence([1, 2, 3], freshRevisionWatermarks().lastTreeRevision);
	assert.deepEqual(cleared.applied, [1, 2, 3], "clearing on reconnect restores delivery");
});

test("only a fresh connect clears the watermarks, and it clears them before resubscribing", () => {
	// Not reachable from dist/node: pinned against the source, like the transfer-id archival
	// call-ordering pin in transaction-persist-path.test.cjs.
	//
	// Scoped to connect on purpose. A resume continues a session the controller still holds, so its
	// counters never restarted; the connector also replays only unacknowledged messages, and
	// handleLogUpdate dedupes against the last timeline entry alone — clearing on resume would let
	// an already-applied replay append a duplicate audit row.
	assert.match(
		webIndex,
		/if\s*\(event === "connect"\)\s*\{[^}]*freshRevisionWatermarks\(\)/,
		"the reset must sit in the connect-only branch, not the shared connect/resume one",
	);
	assert.match(
		webIndex,
		/freshRevisionWatermarks\(\)\);[\s\S]{0,200}?this\.syncLiveState\(\)/,
		"the watermarks must be cleared before the resubscribe",
	);
	assert.equal(
		(webIndex.match(/freshRevisionWatermarks\(/g) || []).length,
		1,
		"one reset site — a second would be a second answer to where the session boundary is",
	);
});

test("every live channel gates through the shared rule", () => {
	assert.doesNotMatch(
		webIndex,
		/revision\s*<=\s*this\.state\.last/,
		"a bare revision comparison bypasses the session-boundary rule",
	);
	const gateUses = (webIndex.match(/isFreshRevision\(/g) || []).length;
	assert.equal(gateUses, 4, "three live channels plus the snapshot fetch must each gate on the rule");
});

test("the snapshot fetch advances the tree watermark it consumed", () => {
	// Without this the snapshot's revision is displayed but never recorded, so the next push is
	// measured against a watermark the page has already moved past on screen.
	assert.match(
		webIndex,
		/lastTreeRevision:\s*snapshotRevision/,
		"refreshSnapshots must record the revision it applied",
	);
});
