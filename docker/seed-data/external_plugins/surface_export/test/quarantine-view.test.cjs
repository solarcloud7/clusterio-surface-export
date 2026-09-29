const { test } = require("node:test");
const assert = require("node:assert/strict");
const { quarantineRow, quarantinedKeys } = require("../dist/node/shared/quarantine-view");
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

test("a duplicate keeps this copy on the left and the holder's copy on the right; the newer one is marked", () => {
	const row = quarantineRow(conflict());
	assert.equal(row.leftAction, "keep_this");
	assert.equal(row.rightAction, "keep_other");
	assert.equal(row.rightKeeps, true);
	assert.equal(row.centerAction, null, "Take both is not offered until the controller allows it for duplicates");
	assert.deepEqual([row.left.newer, row.right.newer], [false, true]);
	assert.deepEqual([row.left.generation, row.right.generation], [2, 3]);
	assert.equal(row.left.transferId, "22:051_iron", "the left trip links to the transfer that produced this copy's trip");
	assert.equal(row.right.transferId, "11:124_iron", "the right trip links to the holder's last transfer");
	assert.equal(row.right.state, "present");
});

test("Take both appears in the centre only when a duplicate offers new_platform", () => {
	const row = quarantineRow(conflict({ actions: ["keep_this", "keep_other", "new_platform"] }));
	assert.equal(row.centerAction, "new_platform");
	assert.equal(row.leftAction, "keep_this", "new_platform never takes the left Keep for a duplicate");
});

test("a copy whose holder lost it offers Keep (adopt) on the left and Discard on the right", () => {
	const row = quarantineRow(conflict({ liveVerdict: "rollback_other", state: "quarantine", holderPresence: "absent",
		...resolutionActions("rollback_other", "quarantine"), lastTransferId: null }));
	assert.equal(row.leftAction, "adopt");
	assert.equal(row.rightAction, "stale_copy");
	assert.equal(row.rightKeeps, false, "there is no right copy to keep, so the right button discards");
	assert.equal(row.right.state, "missing");
	assert.equal(row.left.transferId, null);
});

test("an unconfirmed holder is unknown, not missing", () => {
	assert.equal(quarantineRow(conflict({ holderPresence: "unknown" })).right.state, "unknown");
	assert.equal(quarantineRow(conflict({ holderPresence: null })).right.state, "unknown");
});

test("a platform with no recorded holder shows an empty right side", () => {
	const row = quarantineRow(conflict({ liveVerdict: "unregistered", state: "quarantine", holderInstanceId: null,
		holderGeneration: null, holderPresence: null, ...resolutionActions("unregistered", "quarantine") }));
	assert.equal(row.right.state, "none");
	assert.equal(row.right.newer, false);
	assert.equal(row.left.newer, false);
});

test("a stale copy on the holder's own server keeps the newer local copy on the right", () => {
	const row = quarantineRow(conflict({ liveVerdict: "stale_self", state: "quarantine", holderInstanceId: 11, holderPresence: null,
		...resolutionActions("stale_self", "quarantine") }));
	assert.equal(row.right.state, "present");
	assert.equal(row.rightAction, "stale_copy");
	assert.equal(row.rightKeeps, true);
});

test("a legacy platform can be kept as a new platform from the left", () => {
	const row = quarantineRow(conflict({ liveVerdict: "legacy_unclassified", state: "quarantine", holderInstanceId: null,
		generation: null, ...resolutionActions("legacy_unclassified", "quarantine") }));
	assert.equal(row.leftAction, "new_platform");
	assert.equal(row.centerAction, null);
	assert.equal(row.rightAction, "stale_copy");
});

test("blocked verdicts offer no buttons", () => {
	const row = quarantineRow(conflict({ liveVerdict: "unverified", ...resolutionActions("unverified", "tombstone") }));
	assert.deepEqual([row.leftAction, row.centerAction, row.rightAction], [null, null, null]);
	assert.match(row.blocked, /cannot confirm/);
});

test("registry resolution markers are not linked as transfers", () => {
	const row = quarantineRow(conflict({ holderLastTransferId: null }));
	assert.equal(row.right.transferId, null);
});

test("quarantined keys identify copies by server and platform index", () => {
	assert.deepEqual([...quarantinedKeys([conflict(), conflict({ instanceId: 33, platformIndex: 4 })])], ["11:157", "33:4"]);
});
