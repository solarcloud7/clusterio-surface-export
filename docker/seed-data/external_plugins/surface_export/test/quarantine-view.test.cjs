const { test } = require("node:test");
const assert = require("node:assert/strict");
const { quarantineRow, quarantinedKeys, tripsLabel } = require("../dist/node/shared/quarantine-view");
const { resolutionActions } = require("../dist/node/shared/lineage-resolution");

function conflict(overrides = {}) {
	const verdict = overrides.liveVerdict ?? "duplicate";
	const state = overrides.state ?? "tombstone";
	return {
		instanceId: 11, platformIndex: 157, platformUid: "uid:157", platformName: "Iron hauler", forceName: "player",
		state, storedReason: verdict, liveVerdict: verdict, lineage: "lineage:e:1", generation: 2,
		holderInstanceId: 22, holderGeneration: 3, holderPassengers: 0, holderPresence: "present",
		holderPlatformName: "Iron hauler", holderLastTransferId: "11:124_iron", lastTransferId: "22:051_iron",
		ownerJobId: null, retiredExportId: "124_iron", passengers: 0,
		...resolutionActions(verdict, state), hints: { journalUidMatch: true, journalHubMatch: true, historyMatch: true, presence: null },
		resolution: null, ...overrides,
	};
}

test("a duplicate offers Delete on both sides and each side deletes its own copy", () => {
	const row = quarantineRow(conflict());
	assert.equal(row.deleteLeft, "keep_other", "deleting the quarantined copy keeps the other server's copy");
	assert.equal(row.deleteRight, "keep_this", "deleting the other server's copy keeps this one");
	assert.equal(row.keep, null, "Keep both is not offered until the controller allows it for duplicates");
	assert.equal(row.keepBoth, true);
	assert.deepEqual([row.left.newer, row.right.newer], [false, true]);
	assert.deepEqual([row.left.generation, row.right.generation], [2, 3]);
	assert.equal(row.left.transferId, "22:051_iron", "the left trips link to the transfer that produced this copy's trip");
	assert.equal(row.right.transferId, "11:124_iron", "the right trips link to the holder's last transfer");
	assert.equal(row.right.state, "present");
});

test("Keep both becomes live when a duplicate offers new_platform", () => {
	const row = quarantineRow(conflict({ actions: ["keep_this", "keep_other", "new_platform"] }));
	assert.equal(row.keep, "new_platform");
	assert.equal(row.keepBoth, true);
	assert.deepEqual([row.deleteLeft, row.deleteRight], ["keep_other", "keep_this"]);
});

test("a copy whose holder lost it offers Delete on the left and Keep in the centre", () => {
	const row = quarantineRow(conflict({ liveVerdict: "rollback_other", state: "quarantine", holderPresence: "absent",
		...resolutionActions("rollback_other", "quarantine"), lastTransferId: null }));
	assert.equal(row.deleteLeft, "stale_copy");
	assert.equal(row.deleteRight, null, "there is no right copy to delete");
	assert.equal(row.keep, "adopt");
	assert.equal(row.keepBoth, false, "with one copy the centre button keeps, not keeps both");
	assert.equal(row.right.state, "missing");
	assert.equal(row.left.transferId, null);
});

test("an unconfirmed holder is unknown, not missing, and cannot be deleted", () => {
	for (const holderPresence of ["unknown", null]) {
		const row = quarantineRow(conflict({ holderPresence }));
		assert.equal(row.right.state, "unknown");
		assert.equal(row.deleteRight, null);
	}
});

test("a platform with no recorded holder shows an empty right side", () => {
	const row = quarantineRow(conflict({ liveVerdict: "unregistered", state: "quarantine", holderInstanceId: null,
		holderGeneration: null, holderPresence: null, ...resolutionActions("unregistered", "quarantine") }));
	assert.equal(row.right.state, "none");
	assert.deepEqual([row.right.newer, row.left.newer, row.keepBoth], [false, false, false]);
	assert.deepEqual([row.deleteLeft, row.keep], ["stale_copy", "adopt"]);
});

test("a stale copy on the holder's own server deletes the older copy or keeps both", () => {
	const row = quarantineRow(conflict({ liveVerdict: "stale_self", state: "quarantine", holderInstanceId: 11, holderPresence: null,
		...resolutionActions("stale_self", "quarantine") }));
	assert.equal(row.right.state, "present");
	assert.deepEqual([row.deleteLeft, row.deleteRight, row.keep, row.keepBoth], ["stale_copy", null, "adopt", true]);
});

test("a legacy platform can be kept as a new platform from the centre", () => {
	const row = quarantineRow(conflict({ liveVerdict: "legacy_unclassified", state: "quarantine", holderInstanceId: null,
		generation: null, ...resolutionActions("legacy_unclassified", "quarantine") }));
	assert.deepEqual([row.deleteLeft, row.deleteRight, row.keep, row.keepBoth], ["stale_copy", null, "new_platform", false]);
});

test("blocked verdicts offer no buttons", () => {
	const row = quarantineRow(conflict({ liveVerdict: "unverified", ...resolutionActions("unverified", "tombstone") }));
	assert.deepEqual([row.deleteLeft, row.deleteRight, row.keep], [null, null, null]);
	assert.match(row.blocked, /cannot confirm/);
});

test("registry resolution markers are not linked as transfers", () => {
	assert.equal(quarantineRow(conflict({ holderLastTransferId: null })).right.transferId, null);
});

test("trips are labelled as a count", () => {
	assert.deepEqual([tripsLabel(null), tripsLabel(0), tripsLabel(1), tripsLabel(3)], ["untracked", "0 trips", "1 trip", "3 trips"]);
});

test("quarantined keys identify copies by server and platform index", () => {
	assert.deepEqual([...quarantinedKeys([conflict(), conflict({ instanceId: 33, platformIndex: 4 })])], ["11:157", "33:4"]);
});
