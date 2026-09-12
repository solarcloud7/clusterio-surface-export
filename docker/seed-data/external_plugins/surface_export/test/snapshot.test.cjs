"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { importableSnapshot, snapshotAvailability } = require("../dist/node/shared/snapshot.js");

test("snapshot extraction accepts replay data without treating diagnostic counts as a platform", () => {
	const payload = {platform: {force: "player"}, entities: [], verification: {item_counts: {}}, _transferId: "1:old"};
	assert.equal(importableSnapshot(payload).payload, payload);
	assert.deepEqual(importableSnapshot({replay_payload: payload}), {payload, fromBlackBox: true});
	for (const diagnostic of [{expected: {items: {iron: 10}}}, {replay_payload: null}, {replay_payload: []}, {}]) {
		assert.throws(() => importableSnapshot(diagnostic), /diagnostic|replay/);
	}
	for (const envelope of [{compressed: true, payload: "encoded"}, {section_codec: "v1", sections: ["encoded"]}]) {
		assert.equal(importableSnapshot(envelope).payload, envelope);
	}
});

test("missing and diagnostic-only downloads cannot advertise snapshot restoration", () => {
	for (const value of [null, undefined, {}, {diagnostics: {items: 10}}, {replay_payload: null}]) {
		const status = snapshotAvailability(value);
		assert.equal(status.restorable, false);
		assert.ok(status.restoreUnavailableReason);
	}
	assert.equal(snapshotAvailability({replay_payload: {platform: {}, entities: []}}).restorable, true);
});
