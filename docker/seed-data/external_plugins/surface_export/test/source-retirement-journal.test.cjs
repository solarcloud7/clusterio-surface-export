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
