"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { SourceRetirementJournal } = require("../dist/node/lib/source-retirement-journal.js");

const record = { platformUid: "boot-a:3", exportId: "012_platform", platformIndex: 3,
	surfaceIndex: 8, forceName: "player" };

async function fixture(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "se-retirement-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	return path.join(root, "retirements.json");
}

test("source retirement survives process reconstruction and duplicate replay", async t => {
	const file = await fixture(t), journal = new SourceRetirementJournal(file);
	await journal.load();
	const id = journal.snapshot().id;
	await Promise.all([journal.retire(record), journal.retire(record)]);
	const restarted = new SourceRetirementJournal(file);
	await restarted.load();
	assert.deepEqual(restarted.snapshot(), { v: 1, id, retirements: [record] });
	await assert.rejects(restarted.retire({ ...record, exportId: "another-job" }), /another transfer/);
	assert.deepEqual(restarted.snapshot().retirements, [record]);
});

test("failed persistence does not publish an authorization in memory", async t => {
	const file = await fixture(t), journal = new SourceRetirementJournal(file);
	await journal.load();
	// Opening a directory for writing fails on both Windows and Linux.
	await fs.mkdir(`${file}.tmp`);
	await assert.rejects(journal.retire(record));
	assert.deepEqual(journal.snapshot().retirements, []);
	const restarted = new SourceRetirementJournal(file);
	await restarted.load();
	assert.deepEqual(restarted.snapshot().retirements, []);
});

test("corrupt existing journal is unavailable, never replaced with empty authority", async t => {
	const file = await fixture(t);
	await fs.writeFile(file, "not json");
	const journal = new SourceRetirementJournal(file);
	await assert.rejects(journal.load());
	assert.throws(() => journal.snapshot(), /unavailable/);
	assert.equal(await fs.readFile(file, "utf8"), "not json");
});

test("retirement records keep an optional lineage and hub, and hub matching uses the recorded surface", async t => {
	const { journalHubMatch, retirementHubUnitNumber } = require("../dist/node/lib/source-retirement-journal.js");
	const file = await fixture(t), journal = new SourceRetirementJournal(file);
	await journal.load();
	const lineaged = { ...record, platformUid: "boot-b:9", exportId: "013_platform", lineage: "lineage:boot-a:9", generation: 2, hubUnitNumber: 9 };
	await journal.retire(lineaged);
	for (const invalid of [{ lineage: "boot-a:9", generation: 2 }, { lineage: "lineage:boot-a:9" }, { generation: 2 },
		{ lineage: "lineage:boot-a:9", generation: -1 }, { hubUnitNumber: 0 }]) {
		await assert.rejects(journal.retire({ ...record, platformUid: "boot-c:1", ...invalid }), /Invalid source retirement/, JSON.stringify(invalid));
	}
	const restarted = new SourceRetirementJournal(file);
	await restarted.load();
	assert.deepEqual(restarted.snapshot().retirements, [lineaged]);
	assert.equal(retirementHubUnitNumber(record), 3, "the hub part of a legacy uid after its last colon");
	assert.equal(retirementHubUnitNumber({ ...record, platformUid: "a:b:c" }), null);
	assert.equal(retirementHubUnitNumber(lineaged), 9);
	assert.equal(journalHubMatch([record], 8, 3), true);
	assert.equal(journalHubMatch([record], 9, 3), false, "a hub number on another surface matched");
	assert.equal(journalHubMatch([record], 8, 4), false);
	assert.equal(journalHubMatch([record], null, 3), false);
});
