import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLeaseClean, assertLegacySaveJournal } from "./batch-lifecycle.mjs";

const clean = { success: true, players: 0, paused: false, plugin: true, jobs: 0, locks: 0, holds: 0, tombstones: 0 };
const receipt = { validIdentity: true, deletedTick: 0, surfacePresent: false, platformPresent: false };
const observed = evidence => ({ ...clean, tombstones: evidence.length, tombstoneEvidence: evidence });

test("legacy save loading refuses existing recovery history without changing it", () => {
	assert.doesNotThrow(() => assertLegacySaveJournal(1, { v: 1, id: "fresh", retirements: [] }));
	for (const journal of [undefined, {}, { v: 1, id: "", retirements: [] },
		{ v: 1, id: "existing", retirements: [{ platformUid: "retired" }] }]) {
		const before = structuredClone(journal);
		assert.throws(() => assertLegacySaveJournal(1, journal), /fresh disposable instance/);
		assert.deepEqual(journal, before);
	}
});

test("completed source receipts do not prevent the next fixture, and remain untouched", () => {
	const state = observed([{ ...receipt }, { ...receipt, deletedTick: 100 }]);
	const before = structuredClone(state);
	assert.doesNotThrow(() => assertLeaseClean(1, state, "next fixture"));
	assert.deepEqual(state, before);
});

test("pending, malformed and resurrected source records still refuse a fixture", () => {
	for (const patch of [
		{ deletedTick: false }, { deletedTick: -1 }, { deletedTick: NaN },
		{ validIdentity: false }, { surfacePresent: true }, { platformPresent: true },
		{ surfacePresent: undefined },
	]) {
		assert.throws(() => assertLeaseClean(1, observed([{ ...receipt, ...patch }]), "probe"), /tombstones/);
	}
});

test("missing or incomplete receipt evidence cannot make a dirty lease clean", () => {
	for (const state of [{ ...clean, tombstones: 1 }, { ...observed([receipt]), tombstones: 2 }]) {
		assert.throws(() => assertLeaseClean(1, state, "probe"), /tombstones/);
	}
});

test("completed receipts do not excuse active jobs, locks, holds or connected players", () => {
	for (const key of ["jobs", "locks", "holds", "players"]) {
		assert.throws(() => assertLeaseClean(1, { ...observed([receipt]), [key]: 1 }, "probe"), /REFUSED/);
	}
	assert.doesNotThrow(() => assertLeaseClean(1, clean, "empty instance"));
});
